<#
.SYNOPSIS
  「AI 客服小天」入口：本机侧一键上线 / 自检 / 重建 UAT 隧道（Windows）。

.DESCRIPTION
  解决四件事（对应用户明确提出的运维约束："本机可能会关机；本机服务起来后，能否自动重连 UAT 上线"
  + "本机内外网 IP、出口互联网 IP 均可能发生变化"）：

    1) 起小天本身         —— openmozi 网关（33000）+ 天工知识库后端（53112）；网关保持**只听回环**。
    2) 起本机映射口 33030 —— 纯用户态 TCP 转发（scripts/tiangong-relay.mjs），把回环上的小天
                             交给 WSL 容器与反向隧道使用。**不需要管理员、不改防火墙、不加 portproxy**。
                             33030 是 PLM 前端镜像里写死的上游端口（frontend/nginx.conf）。
    3) 建立/守护 UAT 隧道 —— 开发机 → UAT 的反向 SSH 隧道：UAT 宿主 127.0.0.1:33030 ↔ 本机 33030。
                             隧道由本机**主动外连**建立 ⇒ **本机内网 IP 变化不影响它**
                             （连接方向由内到外，不需要 UAT 知道本机地址）。出口公网 IP 变化会让隧道
                             短暂断开，由计划任务的重试策略自动重连。
    4) 自检并报告         —— 逐段探活（本机网关 / 映射口 / UAT 宿主隧道口），并打印**本机所有 IPv4
                             与出口公网 IP**（IP 变了要能一眼看到，而不是靠猜）。

  ⚠ 诚实说明能力边界（不承诺做不到的事）：
    · "本机一开机就自动连上 UAT" 由 Windows 计划任务实现（见 -InstallAutoStart），
      **前提是 SSH 免密已配好**；脚本会引导一次性配置（用 UAT 口令写一次公钥）。
    · 未配免密时隧道只能在本会话建立，脚本会明确说明它不会在重启后自动恢复。

.PARAMETER SkipTunnel
  只做本机部分（起小天 + 映射口 + 自检），不碰 UAT。

.PARAMETER TunnelOnly
  只重建 UAT 隧道（本机服务已在跑时用，最快）。

.PARAMETER Status
  只读巡检：不启动、不修改任何东西，只打印各段状态与 IP。

.PARAMETER InstallAutoStart
  额外注册计划任务（开机自启 + 每 5 分钟重试 + 失败自动重启）—— "本机起来后自动重连上线" 的落点。

.PARAMETER UninstallAutoStart
  移除上面那个计划任务（回滚用）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File start-tiangong.ps1
  # 一键：起小天 + 映射口 + 建 UAT 隧道 + 全链自检

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File start-tiangong.ps1 -Status
  # 只看现在通不通、IP 是多少（不改动任何东西）

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File start-tiangong.ps1 -TunnelOnly -InstallAutoStart
  # 本机服务已在跑：只把 UAT 隧道重建并装成计划任务（开机自动上线）

.NOTES
  权限：默认**不需要管理员**。只有 -InstallAutoStart（写计划任务）需要管理员。
  编码：本文件必须保存为 **UTF-8 with BOM** —— Windows PowerShell 5.1 无 BOM 时按 ANSI(GBK)
        解码 .ps1，中文变乱码并直接报语法错误（本仓已踩过同类坑）。
#>
[CmdletBinding()]
param(
    [switch]$SkipTunnel,
    [switch]$TunnelOnly,
    [switch]$Status,
    [switch]$InstallAutoStart,
    [switch]$UninstallAutoStart,
    [int]$GatewayPort = 33000,
    [int]$RelayPort = 33030,
    [int]$KbPort = 53112,
    # UAT 访问信息（IP / root 口令）所在文件。
    # ⚠ 默认路径必须**显式给**：本脚本在 ai-sales 仓，而 UAT 凭据在 jcode 仓的
    #   `ipd/deploy/wsl/.env`。首版按"脚本目录往上两级"猜 ⇒ 永远猜不到（那是 `D:\project\ai-sales`），
    #   于是每次都静默跳过隧道、还打印"完成"——"默认值指向不存在的地方"是验收里最容易被
    #   误读成"功能没做"的形态。故这里给真实路径，并在读不到时**列出试过哪些路径**。
    [string]$EnvFile = "D:\project\jcode\ipd\deploy\wsl\.env"
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ── 路径 ────────────────────────────────────────────────────────────────
$SelfPath = $PSCommandPath; if (-not $SelfPath) { $SelfPath = $MyInvocation.MyCommand.Path }
if (-not $SelfPath) { Write-Host "无法确定脚本自身路径（请用 -File 方式调用）" -ForegroundColor Red; exit 1 }
$ScriptDir = Split-Path -Parent $SelfPath
$OmoziDir  = Split-Path -Parent $ScriptDir                     # runtime/openmozi
$RepoRoot  = Split-Path -Parent (Split-Path -Parent $OmoziDir) # 仓库根（含 ipd/）
$Launcher  = Join-Path $OmoziDir "junwuyou-launcher.mjs"
$KbEntry   = Join-Path $OmoziDir "agents\tiangong\business-server.mjs"
$RelayJs   = Join-Path $ScriptDir "tiangong-relay.mjs"
$DeployPs1 = Join-Path $ScriptDir "deploy-agents.ps1"
$BridgeSh  = Join-Path $ScriptDir "uat-bridge.sh"
$StateDir  = Join-Path $ScriptDir ".tiangong"
$LogFile   = Join-Path $StateDir "start-tiangong.log"
$TaskName  = "TiangongUATTunnel"
$KeyFile   = Join-Path $env:USERPROFILE ".ssh\id_ed25519_tiangong"
# WSL 侧密钥路径（工作副本，0600）。**必须在这里定义**，不能只在建隧道那一段里定义：
#   `-Status`/`-TunnelOnly` 等分支会先调用巡检（key-auth-check/tunnel-check），
#   而那些调用需要这个路径 —— 定义晚了就会传空值，表现为「缺少 KEY_FILE」，
#   看起来像"参数没传"，实际是"变量还没定义"（顺序问题伪装成参数问题）。
$wslKeyDir  = "/root/.ssh"
$wslKeyPath = "$wslKeyDir/id_ed25519_tiangong"
$wslKeyPub  = "$wslKeyPath.pub"

function Say($m, $c = "Gray") { Write-Host $m -ForegroundColor $c }
function Title($m) { Write-Host ""; Write-Host "━━━ $m ━━━" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  注意 $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "  失败 $m" -ForegroundColor Red }
function Info($m) { Write-Host "  说明 $m" -ForegroundColor DarkGray }
function Log([string]$line) {
    if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force -Path $StateDir | Out-Null }
    Add-Content -Path $LogFile -Value ("{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $line) -Encoding UTF8
}

# ── .env 解析（与 deploy-agents.ps1 同口径：自己解析，不引第三方）────────
function Read-EnvFile([string]$path) {
    $map = @{}
    if (-not (Test-Path $path)) { return $map }
    foreach ($line in Get-Content -Path $path -Encoding UTF8) {
        $t = $line.Trim()
        if ($t -eq "" -or $t.StartsWith("#")) { continue }
        $i = $t.IndexOf("=")
        if ($i -lt 1) { continue }
        $map[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim().Trim('"').Trim("'")
    }
    return $map
}

# ── 端口/HTTP 工具 ──────────────────────────────────────────────────────
function Get-PidOnPort([int]$port) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($c) { return ($c | Select-Object -First 1).OwningProcess }
    return $null
}
function Get-Listeners([int]$port) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty LocalAddress -Unique
}
function Test-Http([string]$url, [int]$timeoutSec = 6) {
    try {
        $r = Invoke-WebRequest -Uri $url -TimeoutSec $timeoutSec -UseBasicParsing
        return @{ ok = $true; status = [int]$r.StatusCode; body = $r.Content; err = "" }
    } catch {
        # 把"连不上"与"返回 4xx/5xx"分开：两者处置完全不同（前者查端口/防火墙，后者查应用）
        $st = 0
        try { if ($_.Exception.Response) { $st = [int]$_.Exception.Response.StatusCode } } catch { }
        return @{ ok = $false; status = $st; body = ""; err = $_.Exception.Message }
    }
}
function Wait-Port([int]$port, [int]$timeoutSec = 60) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Get-PidOnPort $port) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# Windows 路径 -> WSL 路径（D:\a\b -> /mnt/d/a/b）。
# ⚠ 定义必须在使用它的函数**之前**：PowerShell 是"先解析整文件、后按顺序执行"，
#   把函数定义写在调用点之后，运行到调用那行时它会还没被定义（报 CommandNotFound）。
function WslPath([string]$p) {
    if (-not $p) { return "" }
    $d = $p.Substring(0, 1).ToLower()
    return "/mnt/$d" + $p.Substring(2).Replace("\", "/")
}

# ── WSL 侧桥接（所有需要口令/远端网络的动作用它；避免在 PowerShell 里拼 bash 串，见 uat-bridge.sh 头注释）
# 把专用密钥同步到 WSL 家目录（0600）。
# 为什么独立成一个函数、且在**任何**需要它的判据之前调用：
#   Windows 侧生成的私钥经 /mnt/c 访问时权限恒为 0777（NTFS 挂载点无法表达 POSIX 权限），
#   ssh 会直接拒绝（UNPROTECTED PRIVATE KEY FILE）。所以 WSL 侧必须有一份 0600 工作副本。
#   实测踩过：同步动作原先只放在"建立隧道"那一段里 ⇒ `-Status` 巡检时副本还不存在，
#   免密判据报「私钥不存在」，看起来像密钥没生成，实际只是"还没同步"。
#   判据用的东西必须先就位 —— 这是顺序问题伪装成缺件问题。
function Sync-WslKey {
    if (-not (Test-Path $KeyFile)) { return $false }
    $cpScript = Join-Path $StateDir ("key-sync-{0}.sh" -f $PID)
    if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force -Path $StateDir | Out-Null }
    $wslSrc = "/mnt/" + $KeyFile.Substring(0, 1).ToLower() + $KeyFile.Substring(2).Replace("\", "/")
    $wslPub = "$wslSrc.pub"
    $cpBody = @"
set -e
mkdir -p $wslKeyDir
chmod 700 $wslKeyDir
cp '$wslSrc' '$wslKeyPath'
cp '$wslPub' '$wslKeyPub'
chmod 600 '$wslKeyPath'
chmod 644 '$wslKeyPub'
"@
    [System.IO.File]::WriteAllText($cpScript, $cpBody.Replace("`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
    $cpWsl = "/mnt/" + $cpScript.Substring(0, 1).ToLower() + $cpScript.Substring(2).Replace("\", "/")
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { cmd /c "wsl.exe bash $cpWsl 2>nul" | Out-Null } finally { $ErrorActionPreference = $saved }
    Remove-Item -LiteralPath $cpScript -Force -ErrorAction SilentlyContinue
    return $true
}

function Invoke-Bridge([string]$action, [hashtable]$extra) {
    if (-not (Test-Path $BridgeSh)) { return @{ ok = $false; out = "缺少 $BridgeSh" } }
    $wslPath = "/mnt/" + $BridgeSh.Substring(0, 1).ToLower() + $BridgeSh.Substring(2).Replace("\", "/")
    $prev = @{}
    $vars = @{ UAT_IP = $script:UatIp; RELAY_PORT = "$RelayPort" }
    if ($extra) { foreach ($k in $extra.Keys) { $vars[$k] = $extra[$k] } }
    if ($script:UatPwd -and $action -eq "install-key" -and -not $vars.ContainsKey("UAT_PWD")) { $vars["UAT_PWD"] = $script:UatPwd }
    foreach ($k in $vars.Keys) { $prev[$k] = [Environment]::GetEnvironmentVariable($k); Set-Item -Path "env:$k" -Value ([string]$vars[$k]) }
    # ⚠ 上一版这里写成 `if ($extra.ContainsKey("UAT_PWD")) { $prev["UAT_PWD"] = ... }` ——
    #   只把它记进了"待还原"表，**从未真的设进环境变量**（`$vars` 里没有它，上面的 foreach 自然不会设）。
    #   症状：install-key 永远拿不到口令 ⇒ 报认证失败，而报错里只有 wsl 的噪音，看起来像密钥/网络问题。
    #   教训形态："以为设置过了" —— 设置与记账是两件事，记账不能替代设置。
    #   现在把 UAT_PWD 并进 $vars：foreach 会一并设置与还原。
    try {
        # 关键：**不要把 wsl 的 stderr 与 stdout 在管道里合并**。
        # PowerShell 会把 `2>&1` 过来的每一行包装成 ErrorRecord，再用 Out-String 渲染成
        # "wsl.exe : <正文> At line:N char:M + CategoryInfo ..." 的一整块，正文被噪声包裹；
        # 实测症状：真正的失败原因（认证被拒）完全看不到，屏幕上只剩 wsl 的启动告警。
        # 故：stdout 走管道，stderr 落临时文件，两边分开读、分开滤。
        $env:WSL_UTF8 = "1"
        $errFile = Join-Path $env:TEMP ("tiangong-bridge-{0}.err" -f $PID)
        # 值走**命令行参数**（经 uat-bridge-argv.sh 转成环境变量），不走 PowerShell 的环境变量继承：
        # 实测后者在这条链路上不可靠——PowerShell 侧 `$env:UAT_IP` 有值，WSL 侧却读到空值，
        # 于是脚本报"缺少 UAT_IP"，而那句错误又被 wsl 的启动告警盖住，看起来像网络/密钥问题。
        # 命令行参数则必然到达（同一调用方式实测可用）。
        # 生成一个**临时调用脚本**再执行它（三条路的实测结论，见本函数头注释）：
        #   (a) 环境变量传不到：PowerShell 侧有值、WSL 侧读到空 ⇒ 报"缺少 UAT_IP"；
        #   (b) **命令行参数也不安全**：wsl.exe 会把参数拼成一条 shell 命令，
        #       而真实口令含 `(` ⇒ `bash: -c: line 1: syntax error near unexpected token ('`；
        #   (c) 只有"把带引号的值写进文件再执行文件"两头都安全（本仓既有教训的同一形态）。
        # 口令只落在状态目录下的临时文件里（.gitignore 覆盖），执行完立即删除，且不进日志。
        $tplPath = Join-Path $ScriptDir "uat-bridge-call.sh.tpl"
        if (-not (Test-Path $tplPath)) { return @{ ok = $false; out = "缺少模板 $tplPath" } }
        if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force -Path $StateDir | Out-Null }
        # shell 单引号转义：' → '\''（口令里可能有括号/引号/空格，实测确实有括号）
        $sq = { param($v) "'" + ([string]$v).Replace("'", "'\''") + "'" }
        # ⚠ 用 -replace（正则）而不是 .Replace（字面）：模板里的 ${...} 会被 PowerShell 当成变量，

        $vIp    = [string]$script:UatIp
        $vPwd   = [string]$script:UatPwd
        # ⚠ 未提供的键用**哨兵 `__UNSET__`** 表示，不要留空串、也不要留占位符：
        #   留空串 ⇒ bash 侧与"给了空值"不可区分；留形如 ${KEY_FILE_Q} 的占位符 ⇒
        #   本模板开 `set -u`，那不是变量而是**未定义变量**，bash 直接 `unbound variable` 退出
        #   （实测症状：报 `KEY_FILE_Q: unbound variable`，看起来像"参数没传"）。
        #   哨兵的好处：它是**普通字符串**，bash 侧一眼可辨，不会触发 shell 语义。
        $vKey    = @{ KEY_FILE_Q     = if ($extra.ContainsKey("KEY_FILE"))     { (& $sq ([string]$extra["KEY_FILE"])) }     else { '__UNSET__' } }
        $vKeyPub = @{ KEY_FILE_PUB_Q = if ($extra.ContainsKey("KEY_FILE_PUB")) { (& $sq ([string]$extra["KEY_FILE_PUB"])) } else { '__UNSET__' } }
        $gen = Join-Path $StateDir ("bridge-call-{0}.sh" -f $PID)
        # 模板带 BOM（为了 Windows PowerShell 5.1 正确解码中文注释），但 bash 不认行首 BOM ⇒ 生成时去掉。
        $body = [System.IO.File]::ReadAllText($tplPath)
        if ($body.Length -gt 0 -and [int][char]$body[0] -eq 0xFEFF) { $body = $body.Substring(1) }
        # ⚠ 正则必须容忍 `:-` 变体（模板里写的是 `${X_Q:-}` 以便在 `set -u` 下不炸）：
        #   只匹配 `${X_Q}` 时，`${KEY_FILE_Q:-}` 会被**当成 bash 变量引用整体保留**，
        #   而生成文件里并不存在这些变量 ⇒ 运行时报 `KEY_FILE_Q: unbound variable`，
        #   看起来像"参数没传"，实际是替换没生效。故统一加 `(?::-)?`。
        $body = $body -replace '\$\{UAT_IP_Q(?::-)?\}',       (& $sq $vIp)
        $body = $body -replace '\$\{UAT_PWD_Q(?::-)?\}',      (& $sq $vPwd)
        $body = $body -replace '\$\{KEY_FILE_Q(?::-)?\}',     $vKey.KEY_FILE_Q
        $body = $body -replace '\$\{KEY_FILE_PUB_Q(?::-)?\}', $vKeyPub.KEY_FILE_PUB_Q
        $body = $body -replace '\$\{RELAY_PORT_Q(?::-)?\}',   (& $sq "$RelayPort")
        $body = $body -replace '\$\{BRIDGE_Q(?::-)?\}',       (& $sq $wslPath)
        $body = $body -replace '\$\{ACTION_Q(?::-)?\}',       (& $sq $action)
        [System.IO.File]::WriteAllText($gen, $body, (New-Object System.Text.UTF8Encoding($false)))
        $genWsl = "/mnt/" + $gen.Substring(0, 1).ToLower() + $gen.Substring(2).Replace("\", "/")
        # ⚠ 关键：本脚本全局是 `$ErrorActionPreference="Stop"`，而 PowerShell 会把**原生命令的 stderr**
        #   当成错误记录 ⇒ wsl.exe 的启动告警（"检测到 localhost 代理配置…"）会**中止整个调用**：
        #   实测表现为"无输出、退出码 -1"，看起来像 WSL 崩了，而那条告警本身完全无害。
        #   故只在这一次原生命令调用期间把偏好降到 Continue（并把 stderr 收进文件）。
        $savedEap = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        # 原生命令必须带**超时**：实测有一次在隧道自检阶段无限挂起（WSL 侧 ssh 卡住），
        # 整脚本陪跑 10 分钟无输出。超时后明确报"超时"，而不是让人以为脚本死了。
        # ⚠ stderr 在**作业内的 cmd.exe 层**重定向，不在 PowerShell 层。
        #   原因：PowerShell 会把原生命令的 stderr 包成 ErrorRecord 并渲染成
        #   "wsl.exe : <正文> At line:N … CategoryInfo …" 一大块，即使 `2>$file` 也仍会
        #   往宿主 stderr 吐一份 ⇒ 实测症状：屏幕上只剩 wsl 的启动告警乱码，
        #   而真正的结论（"缺少 KEY_FILE"之类）被淹没，看着像网络/密钥问题。
        #   经 cmd.exe 重定向后，PowerShell 看不到任何 stderr，噪声彻底消失。
        $job = Start-Job -ScriptBlock {
            param($p, $e)
            cmd /c "wsl.exe bash $p 2>`"$e`""
        } -ArgumentList $genWsl, $errFile
        if (Wait-Job $job -Timeout 60) {
            $outLines = @(Receive-Job $job)
        } else {
            Stop-Job $job -ErrorAction SilentlyContinue
            $outLines = @("TIMEOUT 桥接调用超过 60 秒（WSL 侧可能卡在 ssh/网络）：$action")
        }
        Remove-Job $job -Force -ErrorAction SilentlyContinue
        # （异常已被 Start-Job 隔离：作业里失败会体现为空输出 + 退出码，正文仍从 stderr 文件读）
        $ErrorActionPreference = $savedEap
        # 临时脚本里含口令 ⇒ 无论成败立即删除（失败时保留会把口令留在盘上）
        $keepGen = $env:TIANGONG_KEEP_BRIDGE_SCRIPT -eq "1"
        if (-not $keepGen) { Remove-Item -LiteralPath $gen -Force -ErrorAction SilentlyContinue }
        $code = $LASTEXITCODE
        $code = $LASTEXITCODE
        $errLines = @()
        if (Test-Path $errFile) {
            $errLines = @(Get-Content -LiteralPath $errFile -Encoding UTF8 -ErrorAction SilentlyContinue)
            Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
        }
        Remove-Item Env:\WSL_UTF8 -ErrorAction SilentlyContinue
        # wsl 自身的启动告警对本脚本无意义，滤掉（否则它会淹没真正的结论）
        # 过滤两类噪声：wsl 启动告警；以及 PowerShell 对原生命令 stderr 的包装（NativeCommandError/At line/指向行）
        $noise = 'localhost.*代理|检测到 localhost|NAT 模式|NativeCommandError|At line:|^\s*\+|CategoryInfo|FullyQualifiedErrorId'
        $clean = @($outLines + $errLines) | Where-Object { $_ -and $_ -notmatch $noise }
        $out = ($clean -join "`n").Trim()
        $code = $LASTEXITCODE
        if (-not $out) { $out = "(无输出，退出码 $code)" }
        return @{ ok = ($code -eq 0); out = $out }
    } catch {
        return @{ ok = $false; out = $_.Exception.Message }
    } finally {
        foreach ($k in $prev.Keys) { Set-Item -Path "env:$k" -Value $prev[$k] }
    }
}

# ── IP 信息（用户明确关注：内网 IP、出口互联网 IP 都可能变）──────────────
function Show-IPs {
    Title "本机 IP / 出口 IP（IP 变了要能一眼看到）"
    $locals = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -ne "127.0.0.1" -and $_.IPAddress -notlike "169.254.*" } |
        Sort-Object InterfaceAlias
    foreach ($a in $locals) {
        $tag = ""
        if ($a.InterfaceAlias -like "*WSL*") { $tag = "  <- 容器走这条（host.docker.internal 指向它）" }
        Say ("    {0,-16} {1}{2}" -f $a.IPAddress, $a.InterfaceAlias, $tag)
    }
    try {
        $pub = (Invoke-WebRequest -Uri "https://api.ipify.org" -TimeoutSec 6 -UseBasicParsing).Content.Trim()
        Say ("    出口公网 IP      " + $pub + "  <- 变化后隧道会自动重连；若 UAT 侧按源 IP 做过白名单需同步更新")
    } catch {
        Warn "出口公网 IP 读取失败（无外网或 api.ipify.org 不可达）——不影响本机侧自检"
    }
    if ($script:UatIp) { Say ("    UAT 服务器       " + $script:UatIp + ":" + $script:UatPort) }
}

# ── 读 UAT 访问信息（只从既有 .env 取，不新增一份凭据来源）───────────────
# 候选顺序：显式 -EnvFile → 环境变量 UAT_ENV_FILE → 本脚本所在仓上溯找 ipd\deploy\wsl\.env
#          → 已知的 jcode 仓默认路径。找不到就把"试过的路径"全列出来（见 L-xxx 教训：只报"没读到"会让人无从下手）。
$candidates = @()
if ($EnvFile) { $candidates += $EnvFile }
if ($env:UAT_ENV_FILE) { $candidates += $env:UAT_ENV_FILE }
$probe = $ScriptDir
for ($i = 0; $i -lt 5 -and $probe; $i++) {
    $candidates += (Join-Path $probe "ipd\deploy\wsl\.env")
    $parent = Split-Path -Parent $probe
    if ($parent -eq $probe) { break }
    $probe = $parent
}
$devEnv = @{}
$envUsed = ""
foreach ($c in ($candidates | Select-Object -Unique)) {
    if ($c -and (Test-Path $c)) { $devEnv = Read-EnvFile $c; $envUsed = $c; break }
}
$script:UatIp   = $devEnv["UAT_SERVER_IP"]
$script:UatPort = $devEnv["UAT_SERVER_APP_PORT"]
$script:UatPwd  = $devEnv["UAT_SERVER_ROOT_PWD"]
$script:EnvUsed = $envUsed
$script:EnvTried = ($candidates | Select-Object -Unique) -join " ; "

Say ""
Say "AI 客服「小天」入口 · 本机侧一键上线" "Cyan"
Say "===================================" "Cyan"
Say ("  脚本目录    : " + $ScriptDir)
Say ("  网关端口    : " + $GatewayPort + "（只监听回环；身份门在 PLM 侧）")
Say ("  映射口      : " + $RelayPort + "（供 WSL 容器 / UAT 反向隧道）")
Say ("  知识库后端  : " + $KbPort)
Say ("  UAT         : " + $(if ($script:UatIp) { "$($script:UatIp):$($script:UatPort)（凭据取自 $($script:EnvUsed)）" } else { "未读到 UAT_SERVER_IP；试过：$($script:EnvTried)" }))

if (-not (Test-Path $Launcher)) { Bad "找不到 openmozi 启动器：$Launcher"; exit 1 }
if (-not (Test-Path $RelayJs))  { Bad "找不到转发脚本：$RelayJs"; exit 1 }

# =========================================================================
# 计划任务：卸载
# =========================================================================
if ($UninstallAutoStart) {
    Title "移除开机自启/重连计划任务"
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Ok "已移除计划任务 $TaskName" }
    else { Info "计划任务 $TaskName 不存在（无需移除）" }
    exit 0
}

# =========================================================================
# 只读巡检
# =========================================================================
function Invoke-Status {
    Title "只读巡检（不启动、不修改）"
    $gw = Get-PidOnPort $GatewayPort
    if ($gw) {
        $h = Test-Http "http://127.0.0.1:$GatewayPort/health"
        $listen = (Get-Listeners $GatewayPort) -join ","
        Ok "小天网关 $GatewayPort 在跑（pid $gw，监听 $listen，/health -> $($h.status)）"
    } else { Bad "小天网关 $GatewayPort 未运行（跑本脚本不带 -Status 即可启动）" }

    if (Get-PidOnPort $KbPort) { Ok "天工知识库后端 $KbPort 在跑" }
    else { Warn "天工知识库后端 $KbPort 未运行（问答检索会失败，模型仍可回答闲聊）" }

    $rl = Get-PidOnPort $RelayPort
    if ($rl) {
        $probe = Test-Http "http://127.0.0.1:$RelayPort/health"
        Ok "映射口 $RelayPort 在跑（pid $rl，监听 $((Get-Listeners $RelayPort) -join ','), /health -> $($probe.status)）"
        $p = Test-Http "http://127.0.0.1:$RelayPort/tiangong"
        if ($p.ok -and $p.body -match "天工 PLM 客服") { Ok "小天页面经映射口可达（标题逐字命中「天工 PLM 客服」）" }
        else { Warn "小天页面经映射口异常（status=$($p.status)）" }
    } else { Bad "映射口 $RelayPort 未运行（PLM 容器将连不上 -> 页面显示「客服暂时不在线」）" }

    if (-not $SkipTunnel) {
        if ($script:UatIp) {
            $tk = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            if ($tk) {
                $ti = Get-ScheduledTaskInfo -TaskName $TaskName
                Ok "UAT 隧道计划任务存在（上次运行 $($ti.LastRunTime)，结果码 $($ti.LastTaskResult)）"
            } else { Warn "UAT 隧道计划任务未注册（未装计划任务时，隧道只在当前会话有效）" }
            if (Test-Path $KeyFile) {
                # 先保证 WSL 侧有 0600 工作副本，否则下面的免密判据必然误报"私钥不存在"
                Sync-WslKey | Out-Null
                $ka = Invoke-Bridge "key-auth-check" @{ KEY_FILE = $wslKeyPath }
                if ($ka.ok) { Ok "SSH 免密就绪（可注册计划任务实现自动重连）" } else { Warn "SSH 免密未就绪：$($ka.out)" }
            } else { Warn "尚未生成专用密钥（$KeyFile）——首次跑本脚本会生成并引导装公钥" }
            $tc = Invoke-Bridge "tunnel-check" @{}
            if ($tc.ok) { Ok "UAT 宿主已能看到小天（隧道口 /health -> 200）：UAT 网页入口应可用" }
            else { Bad "UAT 宿主看不到隧道口：$($tc.out)" }
        } else {
            Warn "未读到 UAT_SERVER_IP -> 跳过隧道巡检"
        }
    }
    Show-IPs
}

if ($Status) { Invoke-Status; exit 0 }

# =========================================================================
# 1. 起小天（网关 + 知识库后端）
# =========================================================================
if (-not $TunnelOnly) {
    Title "1. 小天服务（openmozi 网关 + 天工知识库后端）"
    if (-not (Get-PidOnPort $GatewayPort)) {
        # 保持回环：身份门在 PLM 侧的 nginx（须先认证），这里不额外放开监听面
        $env:OPENMOZI_HOST = "127.0.0.1"
        Info "网关未运行 -> 拉起（OPENMOZI_HOST=127.0.0.1）"
        if (Test-Path $DeployPs1) {
            Push-Location $OmoziDir
            try { & $DeployPs1 -SkipBuild -Only tiangong } finally { Pop-Location }
        } else {
            Start-Process -FilePath (Get-Command node).Source `
                -ArgumentList @("--max-old-space-size=4096", $Launcher) `
                -WorkingDirectory $OmoziDir -WindowStyle Hidden `
                -RedirectStandardOutput (Join-Path $OmoziDir "launcher.log") `
                -RedirectStandardError  (Join-Path $OmoziDir "launcher-err.log") | Out-Null
        }
        if (Wait-Port $GatewayPort 90) { Ok "网关已监听 $GatewayPort" }
        else { Bad "网关 90s 内未监听 $GatewayPort（看 launcher-err.log）"; exit 1 }
    } else {
        Info "网关已在运行 -> 不重启（重启会打断正在进行的对话）"
    }
    $h = Test-Http "http://127.0.0.1:$GatewayPort/tiangong"
    if ($h.ok) { Ok "小天页面 200（$($h.body.Length) 字节）" } else { Bad "小天页面不可达：status=$($h.status) $($h.err)" }

    if (-not (Get-PidOnPort $KbPort)) {
        Info "知识库后端未运行 -> 拉起"
        Start-Process -FilePath (Get-Command node).Source -ArgumentList @($KbEntry) `
            -WorkingDirectory $OmoziDir -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $OmoziDir "tiangong-business.log") `
            -RedirectStandardError  (Join-Path $OmoziDir "tiangong-business-err.log") | Out-Null
        if (Wait-Port $KbPort 40) { Ok "知识库后端已监听 $KbPort" } else { Warn "知识库后端未监听 $KbPort（检索将失败）" }
    } else { Ok "知识库后端 $KbPort 已在跑" }
}

# =========================================================================
# 2. 映射口（WSL 容器 / 反向隧道的落点）
# =========================================================================
if (-not $TunnelOnly) {
    Title "2. 本机映射口 $RelayPort -> 127.0.0.1:$GatewayPort"
    $rlPid = Get-PidOnPort $RelayPort
    if ($rlPid) {
        $probe = Test-Http "http://127.0.0.1:$RelayPort/health"
        if ($probe.ok) { Ok "映射口已在跑且通（pid $rlPid）" }
        else {
            # 有人在监听但探不通：多半是上一份 relay 的上游变了或已僵死
            Warn "映射口有进程（pid $rlPid）但不通 -> 重启它"
            Stop-Process -Id $rlPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 800
            $rlPid = $null
        }
    }
    if (-not $rlPid) {
        $env:RELAY_PORT = "$RelayPort"
        $env:RELAY_TARGET_PORT = "$GatewayPort"
        Start-Process -FilePath (Get-Command node).Source -ArgumentList @($RelayJs) `
            -WorkingDirectory $ScriptDir -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $StateDir "relay.log") `
            -RedirectStandardError  (Join-Path $StateDir "relay-err.log") | Out-Null
        if (Wait-Port $RelayPort 30) { Ok "映射口已监听 $RelayPort" } else { Bad "映射口未监听 $RelayPort（看 .tiangong\relay-err.log）"; exit 1 }
    }
    $probe = Test-Http "http://127.0.0.1:$RelayPort/health"
    if ($probe.ok) { Ok "映射口 /health -> $($probe.status)" } else { Bad "映射口探活失败：$($probe.err)" }
    Info "监听地址 $((Get-Listeners $RelayPort) -join ',')：0.0.0.0 是刻意的（WSL 容器要从虚拟网卡访问）；真正的门在 PLM 侧认证"
}

# =========================================================================
# 3. UAT 反向隧道
# =========================================================================
if (-not $SkipTunnel) {
    Title "3. UAT 反向隧道（UAT 宿主 127.0.0.1:$RelayPort <-> 本机 $RelayPort）"
    if (-not $script:UatIp -or -not $script:UatPwd) {
        Warn "未读到 UAT_SERVER_IP / UAT_SERVER_ROOT_PWD -> 跳过隧道。试过：$($script:EnvTried)`n        修法：用 -EnvFile <路径> 指定含 UAT_SERVER_IP 的 .env（通常是 jcode 仓的 ipd/deploy/wsl/.env）"
    } else {
        # 3.1 专用密钥（不覆盖用户已有默认密钥：专用密钥便于单独吊销，也不影响用户其它 ssh 用法）
        # ⚠ 密钥必须放在 **WSL 自己的文件系统**里再用：
        #   Windows 侧生成的私钥经 /mnt/c 访问时权限恒为 0777（NTFS 挂载点无法表达 POSIX 权限），
        #   ssh 会直接拒绝：`WARNING: UNPROTECTED PRIVATE KEY FILE! ... bad permissions`
        #   （实测踩过；错误出现在 ssh 的 stderr 里，很容易被当成"公钥没装上"）。
        #   故：Windows 侧保留一份权威副本（给人看、给 Windows 侧 ssh 用），WSL 侧放一份 0600 的工作副本。
        $wslKeyDir  = "/root/.ssh"
        $wslKeyPath = "$wslKeyDir/id_ed25519_tiangong"
        $wslKeyPub  = "$wslKeyPath.pub"
        if (-not (Test-Path "$KeyFile.pub")) {
            Info "生成专用密钥 $KeyFile (ed25519)"
            & ssh-keygen -t ed25519 -f $KeyFile -N '""' -C "tiangong-uat-tunnel@$(hostname)" | Out-Null
        }
        # 把密钥同步到 WSL 侧（0600）：与巡检用的是**同一个函数**，避免两处实现漂移
        Sync-WslKey | Out-Null
        Info "已把专用密钥同步到 WSL 侧（$wslKeyPath，0600）—— /mnt/c 上的 NTFS 权限无法满足 ssh 校验"
        $keyAuthOk = $false
        if (Test-Path "$KeyFile.pub") {
            $ka = Invoke-Bridge "key-auth-check" @{ KEY_FILE = $wslKeyPath }
            if ($ka.ok) { Ok "SSH 免密已就绪（$KeyFile）"; $keyAuthOk = $true }
            else {
                Warn "SSH 免密未就绪 -> 用 UAT 口令装一次公钥（仅这一次需要口令）"
                $inst = Invoke-Bridge "install-key" @{
                    UAT_PWD      = $script:UatPwd
                    KEY_FILE_PUB = $wslKeyPub
                }
        if ($inst.out -match "INSTALLED|ALREADY") {
                    $ka2 = Invoke-Bridge "key-auth-check" @{ KEY_FILE = $wslKeyPath }
                    if ($ka2.ok) { Ok "公钥已装好，免密可用"; $keyAuthOk = $true }
                    else { Bad "装完仍不能免密：$($ka2.out)" }
                } else { Bad "装公钥失败：$($inst.out)" }
            }
        } else { Bad "公钥未生成（ssh-keygen 失败？）" }

        # 3.2 建立隧道
        $tunnelArgs = @("-i", $KeyFile, "-N",
                        "-o", "BatchMode=yes",
                        "-o", "StrictHostKeyChecking=accept-new",
                        "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
                        "-o", "ExitOnForwardFailure=yes",
                        "-R", "127.0.0.1:${RelayPort}:127.0.0.1:${RelayPort}",
                        "root@$($script:UatIp)")
        if ($keyAuthOk) {
            if ($InstallAutoStart) {
                Title "3.2 注册计划任务（开机自启 + 每 5 分钟重试 + 失败自动重启）"
                # ⚠ 先把"本会话手工建立的那条隧道"收掉：反向隧道在 UAT 侧是 **bind 同一个端口**，
                #   两条并存会互抢端口 ⇒ 计划任务启动即失败（实测退出码 255），
                #   而本会话那条又会在终端关闭时消失 ⇒ 最坏情况是"以为配好了，其实没人守着"。
                $stale = Get-CimInstance Win32_Process -Filter "Name = 'ssh.exe'" -ErrorAction SilentlyContinue |
                    Where-Object { $_.CommandLine -and $_.CommandLine -like "*${RelayPort}:127.0.0.1:${RelayPort}*" }
                foreach ($p in $stale) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
                if ($stale) { Info ("已收掉本会话手工隧道 {0} 条（避免与计划任务互抢 UAT 端口）" -f @($stale).Count) }
                Start-Sleep -Seconds 2
                $argLine = ($tunnelArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join " "
                $action = New-ScheduledTaskAction -Execute (Get-Command ssh).Source -Argument $argLine
                $trig1 = New-ScheduledTaskTrigger -AtLogOn
                $trig2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
                            -RepetitionInterval (New-TimeSpan -Minutes 5)
                # StartWhenAvailable：错过触发（例如本机当时关机）**开机后补跑** —— 这正是"本机起来自动上线"
                $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 `
                            -RestartInterval (New-TimeSpan -Minutes 1) `
                            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                            -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
                Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($trig1, $trig2) -Settings $settings `
                    -Description "AI 客服小天：开发机 <-> UAT 反向隧道（本地 $RelayPort）。本机开机/网络恢复后自动重连。" -Force | Out-Null
                Start-ScheduledTask -TaskName $TaskName
                Ok "计划任务 $TaskName 已注册并启动"
            } else {
                $existing = Get-CimInstance Win32_Process -Filter "Name = 'ssh.exe'" -ErrorAction SilentlyContinue |
                    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$RelayPort`:127.0.0.1:$RelayPort*" }
                if ($existing) { Info "隧道进程已存在（pid $(($existing | Select-Object -First 1).ProcessId)）-> 不重复建立" }
                else {
                    Start-Process -FilePath (Get-Command ssh).Source -ArgumentList $tunnelArgs -WindowStyle Hidden | Out-Null
                    Ok "隧道已在本会话建立"
                    Warn "未装计划任务 -> 本机关机/重启后隧道不会自动恢复；需要自动重连请加 -InstallAutoStart"
                }
            }
            Start-Sleep -Seconds 2
            # 3.3 判据：**从 UAT 侧**看本机服务（本机"起了个 ssh 进程"不算证据）
            $tc = Invoke-Bridge "tunnel-check" @{}
            if ($tc.ok) { Ok "UAT 宿主已能看到小天（隧道口 /health -> 200）：UAT 网页入口应可用" }
            else { Bad "UAT 宿主看不到隧道口：$($tc.out)" }
        } else {
            Warn "跳过隧道建立：SSH 免密不可用（先解决上面的提示，再重跑本脚本）"
        }
    }
}

# =========================================================================
# 4. 收尾
# =========================================================================
Invoke-Status
Say ""
Say "完成。UAT 入口：https://<UAT_IP>:$($script:UatPort)/  ->  顶栏「✦ AI客服·小天」" "Green"
Say "离线表现：本机关机时 UAT 页面显示「AI 客服小天暂时不在线」（不是 502/白屏）；" "DarkGray"
Say "          本机服务起来 + 隧道重连后，**不需要在 UAT 上改任何配置**即自动恢复。" "DarkGray"
Log "run complete (relay=$RelayPort gateway=$GatewayPort uat=$($script:UatIp))"
