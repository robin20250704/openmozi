# 小天客服 · UAT 部署约束与建议配置

> **给谁看**：改小天（网关 / 知识库后端 / 转发器 / PLM 工具族）的开发同学，以及做发布的人。
> **为什么要有这份文档**：下面每一条约束都是 2026-10-05 首次把小天真正部署到 UAT 时**实测踩出来**的，
> 不是设计推测。**违反其中任何一条，症状都不在本地出现** —— 本地 dev 有全套浏览器、
> 有 `.env`、有现成的反向隧道，很多约束在本地根本不会触发，所以"我本地是好的"不构成证据。
> **配套的打包与部署脚本**在 PLM 仓库：`ipd/deploy/uat/package-tiangong.sh` 与 `ipd/deploy/uat/deploy-tiangong.sh`
> （本文档只讲"必须满足什么"，不讲脚本怎么用）。

---

## 一、目标拓扑（UAT）

```
浏览器
  └─► plm-edge (nginx, TLS :8722)          ← 终结 TLS；**必须转发 WebSocket 升级头**
        └─► plm-web (容器, nginx + njs)     ← 上游 = 172.17.0.1:33030（一字不改）
              └─► tiangong-relay            ← RELAY_HOST=172.17.0.1，UAT 本机
                    └─► openmozi 网关        ← 127.0.0.1:33000
                          └─► tiangong 知识库后端 ← 127.0.0.1:53112
```

**关键点：小天是 UAT 上的自包含组件，dev 不在链路里。**
PLM 侧的 compose / nginx / 票据密钥**零改动** —— 这是刻意选出来的拓扑，请勿为了图方便改回"把 dev 的端口映射上去"。

---

## 二、硬约束（违反会直接坏，且多半不在本地报错）

### C-1 · Node 必须 ≥ 22.19.0

| | |
|---|---|
| **约束** | 运行时 Node 版本 **≥ 22.19.0**（UAT 现装 v24.13.0） |
| **为什么** | ① `@earendil-works/pi-coding-agent` 的 `engines.node` 是 `>=22.19.0`，openmozi 在 `dist/agents/runtime.js` **硬依赖**它；② `references/tools/plm-sso.cjs` 用**全局** `WebSocket`（Node 22 才有默认实现），Node 20 下 PLM 登录器官直接 `ReferenceError` |
| **注意** | 仓库里 `package.json` 写 `>=18`、`Dockerfile` 写 `node:20-alpine` —— **两处都过时，别信**；照 Dockerfile 构建出来的镜像起不来 |
| **排查特征** | 首屏可能看起来正常（polyfill 在位），**只有真正调 PLM 工具时才炸** ⇒ 验收必须真调一次工具，不能只看页面能聊天 |

### C-2 · 转发器必须绑 **docker0 网关**，既不能 `0.0.0.0` 也不能 `127.0.0.1`

| | |
|---|---|
| **约束** | `RELAY_HOST=172.17.0.1`（取 `docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'` 的**实测值**，不要写死） |
| **为什么不能 `127.0.0.1`** | plm-web 是**容器**，它经 docker0 网关访问宿主。目的地址是 `172.17.0.1` 的连接**不会**被绑在 `127.0.0.1` 的 socket 接受 ⇒ 两者永不相遇。**实测：宿主 `curl 127.0.0.1:33030/health` 200，而从容器打 `172.17.0.1/172.18.0.1/172.19.0.1:33030` 全部无响应。** |
| **为什么不能 `0.0.0.0`** | 那会把这个**零鉴权**的网关挂到宿主所有网卡上（同 VPC、办公网都能打），只靠云安全组挡 —— 那是配置巧合，不是设计控制 |
| **附带约束** | sshd 的 `GatewayPorts no` 只允许回环转发 ⇒ **不要再设计"反向隧道"方案**，它在 UAT 上本来就通不了 |
| **怎么验证** | 见 §四 的 **L3**：`docker exec plm-web → http://172.17.0.1:33030/health` 必须 200。这是唯一能证伪"链路通"的判据 |

### C-3 · `AGENT_ROUTES` 必须为空

| | |
|---|---|
| **约束** | UAT 上 `AGENT_ROUTES=`（空） |
| **为什么** | `junwuyou-launcher.mjs` 在 `AGENT_ROUTES` 指向**未启用**的 agent 时**直接 `process.exit(1)`** |
| **坑在哪** | dev 的 `.env` 里有 `AGENT_ROUTES=qq:1905601942=junwuyou,qq:102872552=yuanyi`。**照抄这两行 ⇒ 网关静默起不来**（systemd 里表现为反复重启） |
| **配套** | `AGENT_IDS=tiangong`（只装配小天，不拉 junwuyou 依赖 ⇒ 不需要 `pg`、不需要 1.17 GB 的 BGE 模型） |

### C-4 · 非 dev 主机必须**关闭全部渠道**（爆炸半径在**对方**主机）

| | |
|---|---|
| **约束** | `QQ_ENABLED=false`、`QQ_ACCOUNT2_ENABLED=false`、`WECOM_ENABLED=false`、`EMAIL_ENABLED=false`、`FEISHU_ENABLED=false`、`DINGTALK_ENABLED=false` |
| **为什么** | `config-adapter.mjs` 在渠道开启且凭据非占位符时会注入 `channels.qq`，网关会**真的去连**。若两套部署共用同一份 QQ/企微凭据，**会互相踢下线** |
| **爆炸半径** | 落在**先上线的那个环境**（很可能是 dev / 线上客服）。也就是说：UAT 配错，dev 掉线 |
| **怎么验证** | 启动后 `journalctl -u tiangong-gateway` 里**不应**出现 "QQ bot enabled" 之类字样 |

### C-5 · `PLM_REQUIRE_HEADER_IDENTITY=1`（安全硬约束，不许改）

| | |
|---|---|
| **约束** | 保持 `=1` |
| **为什么** | 置 0 会允许用查询参数 `?user=别人` **冒充身份**。身份的唯一来源必须是 PLM 前端 nginx 经 `auth_request` 注入的 `X-PLM-User` / `X-PLM-User-Name` |
| **验证** | 走查里断言「提问者 = 当前 PLM 用户」；页面上显示「身份来源：Header」 |

### C-6 · 配置键名是 `PLM_WEB_BASE`，不是 `PLM_BASE`

| | |
|---|---|
| **约束** | 写 `PLM_WEB_BASE` |
| **为什么** | `plm-sso.cjs` 读的是 `PLM_WEB_BASE`。dev 的 `.env` 里写的是 `PLM_BASE`（**没有任何代码读它**），当前之所以能用，是因为 `plm-sso.cjs` 里的硬编码默认值恰好也是 UAT 地址 —— **巧合，不是配置生效** |
| **风险** | 换环境时如果照抄 dev 的键名，会**静默连到错地址**（不报错，只是行为不对） |

### C-7 · 上游地址必须是**字面 IP**，不能是主机名

| | |
|---|---|
| **约束** | `NGINX_TIANGONG_UPSTREAM=172.17.0.1:33030` —— 必须是 IP 字面量 |
| **为什么** | PLM 前端的 nginx 用 njs 变量拼 `proxy_pass`（`tiangong_gateway.upstream()`）。`proxy_pass http://<变量>` 时 nginx 不走启动期解析，改为**每请求解析**，需要 `resolver`；而 Docker 内嵌 DNS `127.0.0.11` **解析不了 `host.docker.internal`** |
| **连带** | compose 里虽然写了 `${NGINX_TIANGONG_UPSTREAM:-172.17.0.1:33030}` 的兜底，但**部署时应当显式下发该变量**：有 `:-` 兜底意味着"非空"这类判据恒真、等于没判 |

### C-8 · TLS 边缘必须转发 WebSocket 升级头（**这条最隐蔽**）

| | |
|---|---|
| **约束** | 终结 TLS 的那层 nginx（UAT 上是 `plm-edge`）**必须**对 `/tiangong/ws` 设置 `proxy_http_version 1.1` + `proxy_set_header Upgrade $http_upgrade` + `proxy_set_header Connection "upgrade"` |
| **为什么** | nginx 的规矩：不显式设 `Connection: upgrade` 就**不会**把 `Upgrade` 递给上游 ⇒ 浏览器握手被**降级成普通 GET** ⇒ 网关按普通路由返回 **404 `{"error":"Not found"}`** |
| **症状** | **页面能打开、顶栏入口在、身份注入正确、票据换 cookie 成功、`/tiangong/health` 返回 200** —— 但页面上显示「**未连接，正在重试…**」，聊天发不出去。**只看"页面能不能打开"会完全漏掉它** |
| **为什么容易漏** | `/tiangong/health` 是**特意不鉴权**的探活口，链路全断时它照样返回 200。**探活通 ≠ 能力可用** |
| **诊断钥匙** | 容器内直连 relay `GET /ws` + Upgrade ⇒ **101 Switching Protocols**（链路本身是好的）；同一个请求经 TLS 边缘 ⇒ **404** ⇒ 降级发生在边缘 |
| **UAT 现状（已修）** | `plm-edge` 的 `location /` 里**没有** Upgrade（修复前容器内 `grep -c Upgrade` = **0**）。已新增**路径限定**的 `location /tiangong/ws`（不动 `location /`，不需要在 http 段加 `map`）。修完 `grep -c Upgrade` = 4，WS 握手经边缘由 404 变为 **401**（未带票据时的正确响应） |
| **判据** | 经边缘的 WS 握手，未带票据时期望 **401 而不是 404**。**404 就说明升级头又被降级了。** |

### C-9 · 健康判据必须从**容器内**取，不能从宿主 curl

| | |
|---|---|
| **约束** | 验证服务是否可达时，用 `docker exec plm-web ... http://172.17.0.1:33030/health`，**不要**在宿主上 `curl 127.0.0.1:33030` |
| **为什么** | UAT 的 `plm-es`、`plm-embedding`、以及小天的网关/知识库**都没有发布宿主端口**。在宿主上 curl 得到的是空串，而空串很容易被 `2>/dev/null` 吞掉、被当成"服务挂了" |
| **同族坑** | 镜像里可能**没有 `wget` 只有 `curl`**（小天 sidecar 镜像就是）。`wget ... 2>/dev/null` 会得到空串 ⇒ 误判。**先确认容器里有什么客户端，或直接用容器自己的健康检查命令** |

### C-10 · 密钥不进包；配置在目标机就地生成

| | |
|---|---|
| **约束** | 打包产物里**不得**含任何 `.env`；密钥在目标机写成 `/etc/tiangong/tiangong.env`（**mode 600, root:root**） |
| **为什么** | ① dev 的 `.env` 里有 7 处明文密钥，带过去等于把 dev 凭据复制到 UAT；② `config-adapter.mjs` 会把 `.env` 里**所有非占位符键**灌进 `process.env`，越少越少泄漏面 |
| **实测教训** | 首次打包时 `runtime/openmozi/.verify-sessions/` 里夹带了 **1 个真实 `sk-` 密钥**（`p4/diag-probe-config.json`）+ **100+ 条客户聊天记录**。这类"dev 工作产物目录"必须排除 |
| **判据要求** | 打包脚本要带**密钥硬门**，且要能区分"键名占位符"（`sk-your-…`，无害）与"真实密钥值"。**把占位符也拦下来的门，会被人开始习惯性绕过** |
| **运行期权限** | `agents/tiangong/.cache/plm-session.json` 内含 bearer token；代码自己设 `mode:0o600`，**不要提交、不要进包** |

### C-11 · 工具族自检要求 `agents/tiangong/.env` **文件存在**

| | |
|---|---|
| **约束** | 该文件必须在（`plm-req.cjs check` 会检查它） |
| **为什么** | 工具的设计是"从工作区 `.env` 读配置"，进程环境变量只是覆盖。只用 systemd `EnvironmentFile` 时**功能全通、但 `check` 恒红 1 项** |
| **处置** | 在**目标机就地生成**（从 `/etc/tiangong/tiangong.env` 拷贝那几项，600、属主 `tiangong`），**不要**把它提交进仓库 |
| **为什么要管这个红** | 一个恒常存在的红会**训练人忽略红**，比没有这条判据更糟 |

### C-12 · 目录层级不能压平

| | |
|---|---|
| **约束** | 部署目录必须保留 `app/runtime/openmozi/…` **两级** |
| **为什么** | `junwuyou-launcher.mjs` 用 `resolve(__dirname,'..','..')` 定位仓库根；`agents/junwuyou/lib/root-env.js` 再上溯 5 级找根 `.env`。**两处都是 try/catch，压平了不报错**，只是行为静默变化 |

---

## 三、建议配置

### 3.1 端口

| 端口 | 用途 | 绑定 |
|---|---|---|
| 33000 | openmozi 网关 | `127.0.0.1`（**仅回环**） |
| 53112 | tiangong 知识库后端 | `127.0.0.1`（**仅回环**） |
| 33030 | tiangong 转发器 | `172.17.0.1`（**仅 docker0**） |

**部署后必须核查监听面**：`ss -ltn` 里**不得**出现 `0.0.0.0:33000` / `0.0.0.0:53112` / `0.0.0.0:33030`。
（33030 **不在**云安全组放行清单内 —— 那是巧合，不是控制手段。）

### 3.2 环境变量（UAT 形态）

```ini
# ===== 网关 =====
OPENMOZI_HOST=127.0.0.1
OPENMOZI_PORT=33000
AGENT_IDS=tiangong
AGENT_ROUTES=                    # 必须为空，见 C-3
LOG_LEVEL=info                   # 不要用 debug（日志量大且可能带敏感内容）
P4_DIAG_ENABLED=false
PLM_REQUIRE_HEADER_IDENTITY=1     # 安全硬约束，见 C-5

# ===== 渠道：非 dev 主机全关，见 C-4 =====
QQ_ENABLED=false
QQ_ACCOUNT2_ENABLED=false
WECOM_ENABLED=false
EMAIL_ENABLED=false
FEISHU_ENABLED=false
DINGTALK_ENABLED=false

# ===== 知识库后端 =====
TIANGONG_HOST=127.0.0.1
TIANGONG_PORT=53112
TIANGONG_API_URL=http://127.0.0.1:53112

# ===== 转发器（见 C-2；172.17.0.1 取实测 docker0 网关） =====
RELAY_HOST=172.17.0.1
RELAY_PORT=33030
RELAY_TARGET_HOST=127.0.0.1
RELAY_TARGET_PORT=33000

# ===== 运行期目录 =====
MOZI_LOG_DIR=/var/lib/tiangong/logs

# ===== PLM 工具族 =====
PLM_WEB_BASE=https://<UAT 对外地址>   # 键名必须是这个，见 C-6
PLM_REALM=plm
PLM_CLIENT_ID=plm-web
PLM_DEFAULT_PROJECT_ID=87
PLM_HEADLESS=true
PLM_CDP_PORT=9334
PLM_SESSION_CACHE=/var/lib/tiangong/plm-session.json
# PLM_USER / PLM_PASSWORD / KIMI_CODING_API_KEY 等密钥：不写进本文档、不进仓库，
# 由部署时以 mode 600 写入 /etc/tiangong/tiangong.env
```

**不要带过去的 dev 配置**（带了就会出问题）：

| dev 的值 | 为什么不能带 |
|---|---|
| `AGENT_ROUTES=qq:…=junwuyou,…` | C-3：launcher 直接 exit 1 |
| `QQ_ENABLED=true` / `WECOM_ENABLED=true` | C-4：与 dev 互踢 |
| `MINIMAX_API_KEY`、`JUNWUYOU_ADMIN_TOKEN` 等 | 小天不用；带过去只是扩大泄漏面 |
| `BGE_EMBED_PATH=C:/Users/…`、`MOZI_SKILLS_USER_DIR=C:/…` | Windows 路径，在 Linux 上永远不存在 |
| `PG_HOST/PORT/...`、`SCHEDULER_API_URL` | 只有 junwuyou 用；`AGENT_IDS=tiangong` 下整组可删 |
| `LOG_LEVEL=debug` | 噪声 |

### 3.3 运行身份与目录

| 项 | 建议 |
|---|---|
| 运行账号 | 专用系统账号 `tiangong`（`useradd -r -m -d /var/lib/tiangong -s /usr/sbin/nologin tiangong`） |
| 发布目录 | `/opt/tiangong/releases/<时间戳>/` + `current` 软链 —— **回退就是改软链再重启（<20 s）** |
| 配置 | `/etc/tiangong/tiangong.env`（600, root:root） |
| 可写目录 | `/var/lib/tiangong/{logs,sessions}`、`/var/lib/tiangong/chrome`（Chrome 的 user-data-dir） |
| systemd | 3 个单元：`tiangong-gateway` / `tiangong-business` / `tiangong-relay`，全部 `Restart=always` |

**systemd 要点**：进程环境由 `EnvironmentFile=` 提供（systemd 以 root 读、把变量交给目标账号）。
这样 `/etc/tiangong/tiangong.env` 保持 600 也不会影响工具族读取 —— **这正是"权限最小化"与"工具能读到配置"之间唯一干净的落点**。

> ⚠ 手工排查时**不要**用 `sudo -u tiangong bash -c '. /etc/tiangong/tiangong.env'`：tiangong 读不到 600 文件，
> 而如果你把 stderr 丢掉，就会看到工具**静默退回代码里的内置默认值**，得出"6 项失败"的假结论。
> 识别特征：它报的 `cdpPort` 与你配置里的不一致。**排查请用 `systemd-run --property=EnvironmentFile=…` 复刻生产。**

### 3.4 PLM 工具族需要 Chrome

| 项 | 内容 |
|---|---|
| **为什么需要** | 9 个 PLM 工具（查环境 / 我是谁 / 列需求 / 查需求 / AI 查重 / 提交需求 / 跟踪需求…）经 `plm-cli.js → plm-req.cjs → plm-sso.cjs`，用**真浏览器**走 Keycloak 表单登录拿会话。宿主上没有浏览器时它们**全部失败**（聊天与知识库不受影响） |
| **装在哪** | `/usr/bin/google-chrome` —— 正好命中 `plm-sso.cjs` 的 `CHROME_CANDIDATES`，**无需改代码**（其他候选：`/usr/bin/chromium`、`/usr/bin/chromium-browser`、以及 `PLM_CHROME_PATH` 环境变量） |
| **UAT 实测** | `google-chrome-stable 154.0.8037.97`；以 `tiangong` 账号可起 headless 且 CDP 探活成功 |
| **不要选** | Ubuntu 22.04 的 `chromium` / `chromium-browser` 包是 **snap 过渡包**，服务器上无 snapd，装了也用不了 |
| **安装方式** | Google 官方 `.deb` + `apt install ./xxx.deb`（**不要用 `dpkg -i`**：dpkg 不补依赖，缺 so 时 Chrome 只报 `error while loading shared libraries`，排查成本高） |
| **安全提示** | 这是**新增攻击面**（虽只 headless 跑在 `tiangong` 账号下）。纳入周检：版本与安全更新 |

### 3.5 打包前必须重建 `dist`

`src/**.ts` 改了**必须**先 `npm run build`（tsc）再打包，并记录 `dist/.build-stamp.json` 的 `builtAt`/`distHash`。
打包脚本应当**先校验构建戳存在**，再对产物做自检。

---

## 四、验收清单（分层，逐层判红转绿）

> 纪律：**未跑项 ≠ 通过**。每一层都要有实测输出。

| 层 | 判据 | 命令（在 UAT 上） |
|---|---|---|
| **L1 进程内** | 网关 + 知识库各自健康 | `curl -s http://127.0.0.1:33000/health`、`curl -s http://127.0.0.1:53112/health` → 均 `{"status":"ok"}` |
| **L2 宿主→docker0** | 转发器经 docker0 可达 | `curl -s http://172.17.0.1:33030/health` → 200 |
| **L3 容器视角** | **PLM 容器能直达小天**（唯一能否证"链路通"的判据） | `docker exec plm-web sh -c 'wget -q -T6 -O- http://172.17.0.1:33030/health'` → 200 |
| **L4 公网边缘** | 用户真实路径 | `curl -sk -o /dev/null -w '%{http_code}' https://<UAT>/tiangong/health` → 200 |
| **L5 真浏览器** | 入口可用 **且** 聊天真的连上 | 走查脚本；关键看页面是否显示「已连接」而不是「未连接，正在重试…」 |
| **L6 工具族** | 真浏览器登录链路通 | `plm-req.cjs check` → `✔ 自检全部通过` |
| **监听面** | 无公网/VPC 暴露 | `ss -ltn` 不得有 `0.0.0.0:(33000\|53112\|33030)` |
| **回退就绪** | 改软链能回去 | `ln -sfn /opt/tiangong/releases/<上一个> /opt/tiangong/app && systemctl restart tiangong-*` |

**L5 的正确判据**（这条最容易写错）：

```
✗ 错：只要页面能打开就算通过        → 会漏掉 C-8（页面能开但聊天连不上）
✗ 错：只有 /tiangong/health 200 就算通过 → 探活口链路全断时也是 200
✓ 对：真浏览器点顶栏入口 → 读渲染出的页面 → 断言出现「已连接」且不出现「未连接」
```

**入口的 DOM 标记**：`<button data-testid="topbar-ai-tiangong" class="ai-badge">✦ AI客服·小天</button>`
—— 是 **`data-testid`**，不是 id 也不是 class。自动化里用 `[data-testid="topbar-ai-tiangong"]`。

---

## 五、明确不要做的事

| 做法 | 为什么不行 |
|---|---|
| 把 relay 绑 `0.0.0.0` | 零鉴权网关暴露到所有网卡，只靠云安全组挡 |
| 把 relay 绑 `127.0.0.1` | 容器经 docker0 访问 `172.17.0.1`，**两者永不相遇** |
| 用 SSH 反向隧道把 dev 的端口映射到 UAT | UAT 的 sshd `GatewayPorts no` ⇒ 只能绑回环 ⇒ 容器够不到；**已实测此路不通** |
| 把 `.env` 打进发布包 | dev 凭据会被复制到 UAT；且 `config-adapter` 会把里面所有非占位符键灌进 `process.env` |
| 用仓库里的 `Dockerfile` 起小天 | 它是 `node:20-alpine` ⇒ 低于 C-1 的下限，起不来 |
| 把上游写成主机名（如 `host.docker.internal`） | 变量式 `proxy_pass` 需要 `resolver`，而 Docker 内嵌 DNS 解析不了它 |
| 为了"让指纹门变绿"而重传内容未变的镜像 | 无收益地替换 AI 查重/语义检索的底座，违背"首要不伤害" |
| 为了排查而临时开 `LOG_LEVEL=debug` 后忘记关 | 日志量与敏感内容风险 |
| 在聊天页面能打开时就宣布"部署成功" | 见 C-8：那是假绿 |

---

## 六、出问题时的第一手判据（按这个顺序看）

1. **`systemctl is-active tiangong-{gateway,business,relay}`** —— 谁不 active 先看谁。
2. **`journalctl -u tiangong-gateway -n 50`** —— 找 `exit 1` 类（多半是 C-3 `AGENT_ROUTES`）。
3. **四层健康 L1→L2→L3→L4** —— 断在哪层就定位到哪一段。**L3 是关键分水岭**。
4. **容器视角 vs 宿主视角的对比** —— 宿主通、容器不通 ⇒ 绑定地址错了（C-2）；容器直连 relay 通、经边缘不通 ⇒ 边缘吞了升级头（C-8）。
5. **`grep -c Upgrade /etc/nginx/conf.d/default.conf`（在边缘容器内）** —— 若为 0，就是 C-8。
6. **工具族报"未配置口令"但环境变量明明在** —— 十有八九是排查姿势不对（见 §3.3 的警告），先用 `systemd-run` 复刻生产再下结论。

---

*本文档基于 2026-10-05 首次在 UAT 真实部署（变更 `plm-uat-upgrade-20261005`）的实测记录整理。
配套证据：PLM 仓库 `.creature/tasks/plm-uat-upgrade-20261005/{execution-record,verification-report,retrospective}.md`。*
