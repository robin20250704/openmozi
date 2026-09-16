<#
.SYNOPSIS
  openmozi 多 agent 一键部署（Windows / PowerShell）

.DESCRIPTION
  一条命令把**两个 agent**（君无忧 junwuyou + 元一电子 yuanyi）及其依赖服务全部部署到本机：

    1) 读配置      —— runtime/openmozi/.env 与仓库根 .env，确定启用哪些 agent、账号路由、端口
    2) 构建        —— tsc 构建（src → dist），可选择跳过
    3) 部署网关    —— 停旧实例 → 起新实例（junwuyou-launcher.mjs，它按描述符装配所有 agent）
    4) 部署元一后端—— 若 AGENT_IDS 含 yuanyi，则拉起 agents/yuanyi/business-server.mjs（:53100）
    5) 健康断言    —— 逐服务探活（网关/元一后端/君无忧后端/调度器），失败即报错退出
    6) 状态摘要    —— 打印各 agent 的工具数、数据域、账号路由，便于一眼核对

  设计与既有入口的关系（**不引入第二套真相源**）：
    · `npm run ci` 仍是**发布门禁**（构建 + 部署 + 全量回归）；本脚本只做**部署**，不跑回归；
    · 启动方式与 ci.mjs 逐字一致（同一个 launcher、同样的 pid 探测/日志重定向/健康等待），
      区别只是"可选参数更多、输出面向运维"。

.PARAMETER SkipBuild
  跳过 tsc 构建（只重启服务时用，省时间）。默认会构建。

.PARAMETER Only
  只部署指定 agent 相关的服务：junwuyou | yuanyi | all（默认 all）。
  junwuyou = 网关；yuanyi = 网关 + 元一后端（网关必须起，因为两个 agent 在同一进程内装配）。

.PARAMETER Status
  只打印当前部署态（进程/端口/健康/路由），不做任何变更。

.PARAMETER GatewayPort
  网关端口，默认取 .env 的 GATEWAY_PORT，否则 33000。

.EXAMPLE
  pwsh -File scripts/deploy-agents.ps1
  # 全量：构建 + 部署两个 agent + 健康断言 + 状态摘要

.EXAMPLE
  pwsh -File scripts/deploy-agents.ps1 -SkipBuild -Only yuanyi
  # 只重启（不构建），并确保元一后端在跑

.EXAMPLE
  pwsh -File scripts/deploy-agents.ps1 -Status
  # 只看现在跑得怎么样（不改动任何东西）

.NOTES
  权限：本脚本只在本机起停自身进程，不修改系统服务/注册表。
  端口：所有服务一律只监听回环（承契约 C-045）。
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [ValidateSet("junwuyou", "yuanyi", "all")]
    [string]$Only = "all",
    [switch]$Status,
    [int]$GatewayPort = 0
)

$ErrorActionPreference = "Stop"
# 本文件必须为 UTF-8 with BOM：Windows PowerShell 5.1 无 BOM 时按 ANSI(GBK) 解码 .ps1，
# 中文会变乱码并直接报语法错误（本项目已踩过同类坑）。见文件头 .NOTES。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ── 路径 ──────────────────────────────────────────────────────────────
$RepoRoot     = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)   # runtime/openmozi
$WorkspaceRoot = Split-Path -Parent (Split-Path -Parent $RepoRoot)                     # 仓库根
$EnvFile      = Join-Path $RepoRoot ".env"
$RootEnvFile  = Join-Path $WorkspaceRoot ".env"
$Launcher     = Join-Path $RepoRoot "junwuyou-launcher.mjs"
$YuanyiEntry  = Join-Path $RepoRoot "agents\yuanyi\business-server.mjs"

function Say($msg, $color = "Gray") { Write-Host $msg -ForegroundColor $color }
function Step($n, $total, $title) { Write-Host ""; Write-Host "━━━ $n/$total $title ━━━" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  OK   $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  警告 $msg" -ForegroundColor Yellow }
function Bad($msg)  { Write-Host "  失败 $msg" -ForegroundColor Red }

if (-not (Test-Path $RepoRoot)) { Bad "找不到 runtime/openmozi：$RepoRoot"; exit 1 }
if (-not (Test-Path $Launcher)) { Bad "找不到启动器：$Launcher"; exit 1 }
if (-not (Test-Path $EnvFile))  { Bad "找不到配置文件：$EnvFile（请先按 README/.env.example 配好）"; exit 1 }

# ── 读 .env（自己解析，不用第三方：仓库既有约定，见 L-019 占位符教训） ──
function Read-EnvFile([string]$path) {
    $map = @{}
    if (-not (Test-Path $path)) { return $map }
    foreach ($line in Get-Content -Path $path -Encoding UTF8) {
        $trimmed = $line.Trim()
        if ($trimmed -eq "" -or $trimmed.StartsWith("#")) { continue }
        $idx = $trimmed.IndexOf("=")
        if ($idx -lt 1) { continue }
        $k = $trimmed.Substring(0, $idx).Trim()
        $v = $trimmed.Substring($idx + 1).Trim().Trim('"').Trim("'")
        if ($v -match '^(your_|MY_|PLACEHOLDER|sk-your|xxx)') { $v = "" }   # 占位符不当作真值（L-019）
        $map[$k] = $v
    }
    return $map
}
$envMap     = Read-EnvFile $EnvFile
$rootEnvMap = Read-EnvFile $RootEnvFile

function Env-Or([string]$key, [string]$fallback) {
    if ($envMap.ContainsKey($key) -and $envMap[$key] -ne "") { return $envMap[$key] }
    return $fallback
}

$AgentIds   = Env-Or "AGENT_IDS" "junwuyou"
$AgentList  = @($AgentIds -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
$Routes     = Env-Or "AGENT_ROUTES" ""
if ($GatewayPort -le 0) { $GatewayPort = [int](Env-Or "GATEWAY_PORT" "33000") }
$YuanyiPort = [int](Env-Or "YUANYI_PORT" "53100")

Say ""
Say "openmozi 多 agent 一键部署" "Cyan"
Say "=========================" "Cyan"
Say ("  仓库        : " + $RepoRoot)
Say ("  启用 agent  : " + ($AgentList -join ", "))
Say ("  账号路由    : " + $(if ($Routes) { $Routes } else { "(未配置)" }))
Say ("  网关端口    : " + $GatewayPort)
Say ("  元一后端    : " + $YuanyiPort + $(if ($AgentList -contains "yuanyi") { "" } else { "（未启用）" }))

# ── 工具函数：pid 探测 / 健康探测 ─────────────────────────────────────
function Get-PidOnPort([int]$port) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conns) { return ($conns | Select-Object -First 1).OwningProcess }
    return $null
}
function Wait-Port([int]$port, [int]$timeoutSec = 60) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Get-PidOnPort $port) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}
function Test-Health([int]$port, [string]$path = "/health", [int]$timeoutSec = 6) {
    try {
        $r = Invoke-WebRequest -Uri ("http://127.0.0.1:$port$path") -TimeoutSec $timeoutSec -UseBasicParsing
        return @{ ok = $true; status = [int]$r.StatusCode; body = $r.Content }
    } catch {
        return @{ ok = $false; status = 0; body = $_.Exception.Message }
    }
}
function Stop-ByPort([int]$port, [string]$label) {
    # 注意：变量**不能**叫 $pid —— PowerShell 的 $PID 是只读内置变量（当前进程 id），
    # 赋值会抛 "Cannot overwrite variable PID because it is read-only"（实测踩过）。
    $existingPid = Get-PidOnPort $port
    if (-not $existingPid) { Ok "$label：无旧实例"; return }
    try { Stop-Process -Id $existingPid -Force -ErrorAction Stop } catch { Warn "$label：停止 pid $existingPid 失败（$($_.Exception.Message)）" }
    for ($i = 0; $i -lt 30 -and (Get-PidOnPort $port); $i++) { Start-Sleep -Milliseconds 500 }
    if (Get-PidOnPort $port) { Warn "$label：pid $existingPid 仍在监听 $port" } else { Ok "$label：已停止旧实例（pid $existingPid）" }
}
function Start-DetachedNode([string]$entry, [string]$outLog, [string]$errLog) {
    return Start-Process -FilePath (Get-Command node).Source `
        -ArgumentList @("--max-old-space-size=4096", $entry) `
        -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog
}

# ── 状态模式 ─────────────────────────────────────────────────────────
if ($Status) {
    Step 1 1 "部署态巡检（只读）"
    $gw = Get-PidOnPort $GatewayPort
    $yy = Get-PidOnPort $YuanyiPort
    $jw = Get-PidOnPort 53000
    $sc = Get-PidOnPort 35801

    Say ("  配置端口  : 网关 " + $GatewayPort + "｜元一后端 " + $YuanyiPort + "｜君无忧 53000｜调度器 35801")
    if ($gw) { $h = Test-Health $GatewayPort "/health"; Ok "网关 $GatewayPort：pid $gw，/health → $($h.status)" } else { Bad "网关 $GatewayPort：未运行" }
    if ($AgentList -contains "yuanyi") {
        if ($yy) { $h = Test-Health $YuanyiPort "/health"; Ok "元一后端 $YuanyiPort：pid $yy，/health → $($h.status)" } else { Bad "元一后端 $YuanyiPort：未运行（元一工具会报连不上）" }
    }
    if ($jw) { $h = Test-Health 53000 "/api/health"; Ok "君无忧后端 53000：pid $jw → $($h.status)" } else { Warn "君无忧后端 53000：未运行（junwuyou 工具的订单/FAQ 会失败）" }
    if ($sc) { $h = Test-Health 35801 "/health"; Ok "调度器 35801：pid $sc → $($h.status)" } else { Warn "调度器 35801：未运行（报价/排期会失败）" }

    $log = Join-Path $RepoRoot "launcher.log"
    if (Test-Path $log) {
        Say ""
        Say "  最近一次装配记录（launcher.log）：" "Cyan"
        Select-String -Path $log -Pattern "装配完成|QQ 账号|路由表|额外渠道账号" -Encoding UTF8 |
            Select-Object -Last 8 | ForEach-Object { Say ("    " + $_.Line.Trim()) }
        $readyCount = (Select-String -Path $log -Pattern 'botUserId:' -Encoding UTF8 | Measure-Object).Count
        Say ("    长连接 READY 次数（botUserId 计数）：$readyCount")
    }
    exit 0
}

# 步骤总数必须与实际 Step 调用数一致（首版写成 5/4，输出出现过 "5/4" 这种自相矛盾的编号）：
# 构建 + 语法自检 + 网关 + 元一后端 + 健康断言 + 状态摘要 = 6（跳过构建则 5）
$totalSteps = if ($SkipBuild) { 5 } else { 6 }
$step = 0

# ── 1. 构建 ──────────────────────────────────────────────────────────
if (-not $SkipBuild) {
    $step++
    Step $step $totalSteps "构建（src → dist）"
    Push-Location $RepoRoot
    try {
        $out = & node "node_modules/typescript/bin/tsc" "-p" "tsconfig.json" 2>&1 | Out-String
        $code = $LASTEXITCODE
    } finally { Pop-Location }
    if ($code -ne 0) { Bad "tsc 构建失败（exit $code）"; Say $out; exit 1 }
    Ok "tsc 构建成功、0 编译错误"
} 

# 非 TS 运行期模块语法自检：语法错必须在**部署前**拦下（曾经因一个漏引号导致网关起不来）
$step++
Step $step $totalSteps "运行期模块语法自检"
$syntaxBad = @()
$filesToCheck = @()
foreach ($p in @("junwuyou-launcher.mjs", "config-adapter.mjs")) {
    $full = Join-Path $RepoRoot $p
    if (Test-Path $full) { $filesToCheck += $full }
}
foreach ($agent in $AgentList) {
    $dir = Join-Path $RepoRoot ("agents\" + $agent)
    if (Test-Path $dir) {
        $filesToCheck += Get-ChildItem -Path $dir -Recurse -File -Include *.js, *.mjs, *.cjs |
            Where-Object { $_.FullName -notmatch "node_modules" } | ForEach-Object { $_.FullName }
    }
}
foreach ($f in $filesToCheck) {
    & node --check $f 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { $syntaxBad += $f }
}
if ($syntaxBad.Count -gt 0) { Bad "语法错误 $($syntaxBad.Count) 个，已中止部署："; $syntaxBad | ForEach-Object { Say ("    " + $_) }; exit 1 }
Ok "语法自检通过（$($filesToCheck.Count) 个文件）"

# ── 2. 部署网关（进程内装配所有 agent）───────────────────────────────
$step++
Step $step $totalSteps "部署网关（$($AgentList.Count) 个 agent 在同一进程内装配）"
Stop-ByPort $GatewayPort "网关"
Push-Location $RepoRoot
try {
    $gwProc = Start-Process -FilePath (Get-Command node).Source `
        -ArgumentList @("--max-old-space-size=4096", $Launcher) `
        -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $RepoRoot "launcher.log") `
        -RedirectStandardError  (Join-Path $RepoRoot "launcher-err.log")
} finally { Pop-Location }
if (-not (Wait-Port $GatewayPort 90)) {
    Bad "网关 90s 内未监听 $GatewayPort"
    $errLog = Join-Path $RepoRoot "launcher-err.log"
    if (Test-Path $errLog) { Say "  launcher-err.log 末尾："; Get-Content $errLog -Tail 12 -Encoding UTF8 | ForEach-Object { Say ("    " + $_) } }
    exit 1
}
Ok "网关已监听 $GatewayPort（pid $($gwProc.Id)）"

# ── 3. 部署元一业务后端（仅在启用 yuanyi 时）──────────────────────────
$step++
Step $step $totalSteps "部署元一电子业务后端"
$wantYuanyi = ($AgentList -contains "yuanyi") -and ($Only -ne "junwuyou")
if (-not $wantYuanyi) {
    if ($Only -eq "junwuyou") { Ok "按 -Only junwuyou 跳过元一后端" }
    else { Ok "AGENT_IDS 未含 yuanyi，跳过（零影响）" }
} elseif (-not (Test-Path $YuanyiEntry)) {
    Warn "未找到 $YuanyiEntry —— 跳过（元一工具将不可用）"
} else {
    Stop-ByPort $YuanyiPort "元一后端"
    $env:YUANYI_PORT = "$YuanyiPort"
    $env:YUANYI_HOST = "127.0.0.1"
    Push-Location $RepoRoot
    try {
        $yyProc = Start-Process -FilePath (Get-Command node).Source `
            -ArgumentList @($YuanyiEntry) `
            -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $RepoRoot "yuanyi-business.log") `
            -RedirectStandardError  (Join-Path $RepoRoot "yuanyi-business-err.log")
    } finally { Pop-Location }
    $up = $false
    for ($i = 0; $i -lt 40 -and -not $up; $i++) {
        Start-Sleep -Milliseconds 500
        $up = (Test-Health $YuanyiPort "/health").ok
    }
    if ($up) {
        $body = (Test-Health $YuanyiPort "/health").body | ConvertFrom-Json
        $sampleTag = ""
        if ($body.sample_data) { $sampleTag = "，样本数据" }
        Ok "元一后端已就绪（pid $($yyProc.Id)，端口 $YuanyiPort，SKU $($body.skus) 个$sampleTag）"
    } else {
        Bad "元一后端未就绪（:$YuanyiPort）"
        $errLog = Join-Path $RepoRoot "yuanyi-business-err.log"
        if (Test-Path $errLog) { Get-Content $errLog -Tail 10 -Encoding UTF8 | ForEach-Object { Say ("    " + $_) } }
        exit 1
    }
}

# ── 4. 健康断言（部署判据：服务起来 + 依赖在）────────────────────────
$step++
Step $step $totalSteps "健康断言"
$failed = @()

$h = Test-Health $GatewayPort "/health"
if ($h.ok) { Ok "网关 $GatewayPort → $($h.status)" } else { Bad "网关 $GatewayPort → $($h.body)"; $failed += "网关" }

if ($wantYuanyi) {
    $h = Test-Health $YuanyiPort "/health"
    if ($h.ok) { Ok "元一后端 $YuanyiPort → $($h.status)" } else { Bad "元一后端 $YuanyiPort → $($h.body)"; $failed += "元一后端" }
}
# 依赖服务：不在线只告警（它们不由本脚本托管），但在线必须健康
foreach ($dep in @(@{ p = 53000; path = "/api/health"; name = "君无忧后端" }, @{ p = 35801; path = "/health"; name = "调度器" })) {
    $h = Test-Health $dep.p $dep.path
    if ($h.ok) { Ok "$($dep.name) $($dep.p) → $($h.status)" }
    else { Warn "$($dep.name) $($dep.p) 不可用 —— 相关工具会失败（请另行启动；本脚本不托管它）" }
}
if ($failed.Count -gt 0) { Bad "健康断言失败：$($failed -join ", ")"; exit 1 }

# ── 5. 状态摘要（两个 agent 的工具/数据域/路由）───────────────────────
$step++
Step $step $totalSteps "状态摘要"
$log = Join-Path $RepoRoot "launcher.log"
if (Test-Path $log) {
    Select-String -Path $log -Pattern "装配完成|QQ 账号|路由表|额外渠道账号" -Encoding UTF8 |
        Select-Object -Last 8 | ForEach-Object { Say ("  " + $_.Line.Trim()) }
    $ready = Select-String -Path $log -Pattern 'botUserId:' -Encoding UTF8 |
        ForEach-Object { ($_.Line -replace '.*botUserId:\s*"([^"]+)".*', '$1') }
    $ready = $ready | Where-Object { $_ -match '^\d+$' } | Select-Object -Unique
    if ($ready.Count -gt 0) { Ok "QQ 长连接已就绪的机器人：$($ready.Count) 个（$($ready -join ", ")）" }
    else { Warn "未见 READY 记录：QQ 消息将无法进入（检查凭据与 IP 白名单）" }
}
Say ""
Say "  各 agent 概览：" "Cyan"
foreach ($agent in $AgentList) {
    $descPath = Join-Path $RepoRoot ("agents\" + $agent + "\agent.plugin.json")
    if (-not (Test-Path $descPath)) { Warn "  $agent：无描述符（未接入）"; continue }
    $desc = Get-Content $descPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $agentRoutes = @($Routes -split "," | Where-Object { $_ -match ("=" + [regex]::Escape($agent) + "$") } | ForEach-Object { ($_ -split "=")[0].Trim() })
    Say ("    " + $agent.PadRight(10) + " 工具 " + $desc.toolset.Count + " 个：" + ($desc.toolset -join ","))
    Say ("    " + "".PadRight(10) + " 数据域 " + $desc.dataDomain + "｜账号路由 " + $(if ($agentRoutes.Count -gt 0) { $agentRoutes -join "," } else { "(无，走默认 agent)" }))
}

Say ""
Say "部署完成。" "Green"
Say ("  网关        : http://127.0.0.1:" + $GatewayPort + "/")
Say ("  元一业务后端: " + $(if ($wantYuanyi) { "http://127.0.0.1:$YuanyiPort/" } else { "(未启用)" }))
Say "  日志        : launcher.log / launcher-err.log / yuanyi-business.log"
Say "  再看状态    : pwsh -File scripts/deploy-agents.ps1 -Status"
Say "  跑发布门禁  : npm run ci（构建 + 部署 + 全量回归）"
exit 0
