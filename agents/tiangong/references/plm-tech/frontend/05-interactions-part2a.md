# 前端实现规格 · 交互模式（二）§6.9~§6.14.4（认证/治理页/评审工作台/下载/导出）

> 本文件是 `docs/plm-tech/08-前端实现规格.md`（索引）的子文件之一，承载**原 §6.9~6.14.4** 的正文。
> **章节编号保持原样**（保号）：原文档里的 `§5.4`、`§6.14` 等引用在本文件内一一对应，不必换算。
> 索引（含章节号 → 子文件映射表）：[`../08-前端实现规格.md`](../08-前端实现规格.md)。
> **§6.13.1 为批次54 新增**（页面 URL 参数的两个语义：`?open=<id>` / `?new=1`），
> 按索引 §五 规则 3「新增章节按该文件承载的原编号序列续号」，续在 §6.13 之下，**不占用其它号段**。

---
### 6.9 身份适配与认证模式（dev / OIDC 双模式）

前端不感知后端认证模式的实现差异，只保证**两种后端拿到一致身份**（后端侧规格见 09 §1.4.7）：

| 层 | 规格 |
|---|---|
| **axios 拦截器** | **恒发 `X-PLM-User=currentUser()`**；有 OIDC token 时**同时**发 `Authorization: Bearer`——dev 后端消费 header、oidc 后端消费 bearer。**禁止"有 token 就早退不发 header"**：后端若为 dev 模式会回落 seedUser=admin，真实登录身份丢失（L-097/L-098 的 bug 根因） |
| **OIDC 登录同步** | `signinRedirectCallback` / 启动已有 token 时，把 JWT `preferred_username` 写入 `plm_user`（`oidcLogin()` 读 profile）——此后 `currentUser()` 即真实登录身份 |
| **topbar 身份** | `displayUser = oidcUser \|\| currentUser()`；**`oidcUser` 非空（真实 OIDC 登录）→ 隐藏 dev 身份切换下拉**；仅 dev（无 token）显示切换。真实登录后不得保留切换用户能力 |
| **未登录落地（批次39）** | **零点击**：未登录访问任意路径（含首页与深链）→ 自动发起 OIDC 重定向，用户直接看到统一认证的**用户名/密码页**。首屏是过渡屏（`[data-plm-autologin="redirecting"]`，"正在跳转到统一身份认证…无需操作"），**不是**应用自己的登录卡 |
| **判定表（批次39）** | 顺序即语义（`auth/autoLogin.ts` `decideAutoLogin`）：①已有 token→不跳 ②部署期显式开 dev 入口→不跳 ③URL 带 code+state（回调中）→不跳 ④URL 带 error→不跳并显示错误 ④b回调连续失败达阈值（`plm_oidc_cb_fail ≥ 2`）→不跳（熔断） ⑤本次导航是**历史回退**（`back_forward` 或 bfcache `pageshow.persisted`）→不跳 ⑥其它→跳。改动顺序 = 改语义，须同步本表 |
| **一次性握手参数必须清出地址栏（批次39 回炉）** | `code/state/session_state/iss` 是**一次性凭据**（授权码只能换一次 token）：兑换完成（或失败）后立刻 `navigate(stripHandshakeParams(...),{replace:true})`，**与"有没有深链要还原"无关**——否则用户**刷新**就会重放已消费的参数 ⇒ `No matching state found in storage` ⇒ 落到兜底页且每次刷新都复现（用户 2026-09-20 报障）。⚠ **顺序有判据**：必须"**先兑换、后清理**"（`oidc-client-ts` 自己从地址栏读 code/state，先清会抛 `No state in response`）；`error/error_description` **不清**（那是给人看的原因，不是凭据） |
| **回调失败先回落会话（批次39 回炉）** | `signinRedirectCallback` 失败时**先** `getToken()`：有有效会话就按会话进系统（重放/新标签页/bfcache 恢复都属于这一类），**不得用一次一次性错误否定一个有效会话**（批次38 及更早正是靠这条兜底才不炸；批次39 初版把它删掉 ⇒ 用户被挡在门外）。确实无会话才转兜底页 + 可见原因 + 计一次失败 |
| **回调单飞（批次39 回炉）** | 回调兑换走**模块级记忆 promise**（`callbackOutcomeOnce`）：React 18 `StrictMode` 会双跑挂载期 effect，两次各兑一次会让第二次必抛 `No matching state found in storage`，且第一次的结果被 `alive=false` 丢掉 ⇒ 用户看到一张报错页。两次共用同一 promise，结果只取一次、也用得上 |
| **兜底登录页（批次39）** | 仅当自动跳转不成立时出现（按了返回 / 凭据服务报错 / 跳不动 / dev 入口打开）：`div.login-page[data-plm-autologin="fallback"][data-plm-autologin-reason=...]` + 可见原因（`role=alert`）+ 手点「登录（SSO）」+ dev 入口区块。**自动跳转失败必须可见**（旧写法 `catch(()=>{})` 是静默失败） |
| **深链还原（批次39）** | 发起重定向前把 `pathname+search+hash`（剔除 OIDC 协议参数）存 sessionStorage，回调成功后 `navigate(path,{replace:true})`；只接受站内路径（拒绝 `//host`）= 开重定向防线。零点击跳转若不带还原，等于静默丢掉用户的目标 |
| **登录页** | 「登录（SSO）」= **兜底入口**（不再是必经首屏）；dev 身份下拉 + 「进入（dev）」仅作开发兜底（写入所选身份后进入） |
| **登出** | `signoutRedirect` 后回到应用 → 未登录落地再次自动进统一认证（登出≠要手点登录）；登出前清"刚跳过"标记，否则"登录后 30s 内登出"会被误判成用户反悔 |
| **oidc-client** | 配置在 `auth/oidc.ts`（PKCE S256、automaticSilentRenew）；User 存储键 = `oidc.user:<authority>:<client_id>` |

### 6.10 系统设置/角色管理页（治理类页面范式，V45/V46）

`/settings`（`SettingsPage.tsx`）承载角色/功能角色/ACL/用户治理。**其它"配置治理类"页面（审批矩阵、治理规则、元数据管理…）按本节范式**：页签分区 + 双栏主从 + 检查卡，全程无弹窗（§6.1）。

#### 6.10.1 布局与视觉

```
┌ page-head：系统设置 ───────────────────────────────────────┐
┌ tabs：组织角色 | 项目角色 | 功能角色 | ACL 策略 | 用户管理 ──┐
│ ┌ 左：角色列表（AgGrid，双击/点行选中）─┐ ┌ 右：角色详情卡 ──┐
│ │ 编码 | 名称 | 人员数 | 功能数          │ │ 名称[输入]        │
│ └───────────────────────────────────────┘ │ 功能角色[勾选列表] │
│ ┌ 角色↔流程匹配检查卡（跨页签置底，1/-1 通栏）───────────┐ │ 流程引用[明细]     │
│ │ ✓ 全部 N 个流程角色均已定义  /  ⚠ M 个未定义（红标）  │ │ ACL[只读列表]      │
│ └────────────────────────────────────────────────────────┘ │ [保存角色]         │
└────────────────────────────────────────────────────────────┘
```

| 元素 | 规格 |
|---|---|
| **新增角色表单** | **编码 + 名称 双输入框**（编码 `placeholder="编码（字母开头，字母/数字/下划线）"`，`mono` 字体；名称"名称（显示名）"）+ `＋ 新增` 主按钮；角色类型由页签决定（FUNCTION/PROJECT），不另设选择框；**禁止"名称推导编码"**（中文/随意名直接变 code 的根因） |
| **角色↔流程匹配检查卡** | 数据源 `GET /_admin/roles/flow-usage`（全部流程边级 roles + 任务候选池角色）；判定集必须用**全量角色**（`allRoles`）——用页签过滤后的子集会把另一类已定义角色误报未定义；全定义 → 绿底 `#f0fdf4` `✓ 全部 N 个流程角色均已定义（组织角色 x · 项目角色 y）`；有缺失 → 橙底 `#fff7ed` `⚠ M 个流程引用角色未定义：...`（附创建指引） |
| **角色详情·流程引用** | 选中角色被哪些流程边引用：`<流程名> · <动作>（FROM → TO） — 角色门 / 任务候选池`，数据源同 flow-usage 客户端过滤；未被引用显示"未被任何流程边引用（可用于数据权限/功能角色映射）" |
| **功能角色勾选** | `RoleChecklist`：内联多选（checkbox chip，选中 `#dbeafe` 底）；值必须是**字符串数组**（后端 `GET /_admin/roles/{code}.funcRoles` 契约——返回对象形状曾致保存外键违约 SQL 错误，V45 修复） |
| **用户角色分配** | `GroupedRoleChecklist`：按 组织角色（FUNCTION）/ 项目角色（PROJECT）**分组渲染**，选项 = `code · name`（用户读得懂）；全量角色数据源 `GET /_admin/roles` |
| **状态 pill** | 需求流新增 `ACCEPTED: 'ok'`（已验收）；状态→语义色映射仍是 `statusPill.ts` 单一事实源，YAML `states.*.color` 驱动 |

#### 6.10.2 操作模式与校验分层

- **创建/编辑校验三层**：前端即时格式提示（编码正则 `[a-zA-Z][a-zA-Z0-9_]{1,63}`，不符提示"角色编码格式：字母开头…"）→ 后端业务校验（重复 400"角色已存在: X"、非法格式 400、功能角色不存在 400"…请先在功能角色页签创建"）→ 消息区展示（**绝不弹窗**）；任何校验失败不得以 SQL 异常形态透出（外键/约束错误必须在 Service 层转为业务文案）。
- **保存**：角色详情"保存角色"单按钮提交（名称 + funcRoles 全量）；成功提示 `已保存角色 ...`；用户编辑器独立"保存用户"（角色数组全量替换 PUT）。
- **删除保护**：删除角色按钮常驻详情头；后端删除前校验引用（被 `t_user_role`/`t_role_function`/`t_role_abac` 引用时拒绝）；迁移级清理只处理无引用的走查残留（`ui_*` 前缀，V45 先例）。
- **项目成员角色下拉**（ProjectsPage 团队页签）：选项 = `GET /_admin/roles` 过滤 `roleType==='PROJECT'`（`code · name`），**获取失败回退静态内置表**（无 `_admin.read` 的用户仍可添加成员）；后端校验 roleCode 必须是已定义 PROJECT 角色（未定义 400，与流程边级门/候选池判定闭环）。

#### 6.10.3 权限与后端契约

| 契约 | 规格 |
|---|---|
| 读 | `_admin.read`（admin/pdt_manager/product_manager/quality/system_engineer）；flow-usage 同门禁 |
| 写 | `_admin.manage`（admin/pdt_manager，V40） |
| `GET /_admin/roles` | `[ { code, name, roleType, userCount, funcCount } ]` |
| `GET /_admin/roles/{code}` | `{ code, name, roleType, funcRoles: string[], abacRules }`（**funcRoles 必须是字符串数组**） |
| `GET /_admin/roles/flow-usage` | `[ { flow, flowLabel, from, to, label, rework, roles, taskCandidateRole } ]`（全部流程全部边；对齐检查数据源） |
| `POST/PUT/DELETE /_admin/roles...` | 编码格式/重复/引用校验，业务文案 400；写操作走审计链（`admin.role.create/update/delete`） |

### 6.11 项目流程状态图（统一时间线）与统一评审工作台（2026-09-10 V46）

> 项目详情「阶段门时间线 G1→G7」替换为**单条时间线：阶段 × 决策点统一轴**——DCP 与 TR 用形状/颜色双通道区分，节点点击直达**统一评审工作台**（预审干跑 + 逐项判定 + 签署/否决 + 结论 + COND 条件意见）。组件：`components/ProjectFlowTimeline.tsx` / `components/ReviewWorkbench.tsx`；承载页 `pages/ProjectsPage.tsx`（项目详情）与 `pages/StageGatePage.tsx`（顶部时间线 + 评审签署卡）。后端口径见 `10-§6.2`。评审机制已抽取为**产品级通用规格**（评审容器/责任人管理/强制检查项/结论形成/签署否决定论，G-REV-1~6，见 `12-产品级通用规格-评审机制与列表范式.md` §2）——新业务域评审 UI 按该规格接入，本节是项目域实例。

#### 6.11.1 时间线组件（ProjectFlowTimeline）

| 元素 | 规格 |
|---|---|
| **数据源** | `GET /api/v1/projects/{id}/flow-overview` → `{projectId, prjCode, name, productLine, status, passGateCount, nodes[], stageGuards[], decidedGateCount, totalGateCount}`；节点序 = 后端 `t_gate_map.sort_key`（零填充字典序），前端不重排。`passGateCount` **已废弃**（已作废阶段门的 PASS 数，源表 `t_project_gate` 恒空 ⇒ 恒 0）；判据见下「门计数口径」 |
| **阶段分组** | 按 `node.track`（阶段轨）分组渲染：轨头 = 阶段名，组内横向轨道线；`track` 为空的 DCP0 归入「立项」组 |
| **形状** | `reviewType='DCP'` → **菱形**（30px 方块 `rotate(45deg)`，商业决策/IPMT）；TR → **圆角方形**（PDT/SE 技术评审）；头部图例同步标注「DCP 商业决策（IPMT）/ TR 技术评审（PDT/SE）」 |
| **状态色映射** | **结论优先**：GO/PASS→`--ok`；GO_WITH_RISK/COND/REDIRECT→`--warn`；TERMINATE/FAIL→`--err`；无结论 IN_REVIEW→`--warn`、PLANNED/无评审→`--border` 灰（字 `#64748b`）；色值经 `pages/statusPill.ts` 语义色单一事实源 |
| **节点徽标** | 状态 pill（结论/评审中/未开始）+ `⚠N`（`openIssueCount>0`，未清零遗留问题 IBR-14）+ `否决` pill（存在 ACTIVE 否决票）+ **`⛔`**（`blocked=true`，title=`blockReason`：`<DCP> 尚未 GO/GO_WITH_RISK，阶段不可推进`）+ `📎 reviewCode`（非紧凑模式） |
| **⛔ 阻断判定** | 后端权威：仅 `review_type='DCP'` 且有阶段端点（`stage_from` 非空）且该 DCP 无 GO/GO_WITH_RISK 结论 → `blocked=true`；前端只渲染不判定 |
| **阶段守卫行** | 底部 `stageGuards` 渲染 `{from}→{to} · {dcp} ✓/✗` pill（PASS/PENDING 色，title=detail，✗=须该 DCP 结论 GO/GO_WITH_RISK） |
| **头部** | 标题「项目流程 · 阶段与决策点」+ 图例 + **「评审门 {已决策}/{总数} 已决策」**（2026-09-11 REQ-2026-0700 改：原为「阶段门通过 {passGateCount}/7」，取旧门 G1-G7 的 PASS 数；阶段门作废后该计数恒为 0，会显示"永远 0/7"的假状态） |

##### 门计数口径（2026-09-22 用户裁定，三处必须同值）

| 位置 | 显示 | 取数 |
|---|---|---|
| 项目详情面板「项目统计 · **DCP0-DCP3**」 | `阶段门 x/11 通过` | `flow-overview.decidedGateCount`（flow 未载入时回落 `PrjResp.decidedGateCount`） |
| 项目详情面板 · 时间线头部 | `评审门 x/11 已决策` | 前端按 `nodes[].conclusion` 计（集合来自 `domain/gateConclusions`，与后端同一集合） |
| 项目页 ctx-bar / 需求页项目条 | `阶段门进度 x/11` / `阶段门 x/11` | 同上两个来源 |
| 项目驾驶舱 | `已决策 n/总数` | `GET /projects/flow-summary.decidedCount/totalNodes` |

- **`x`（已决策）的定义** = 结论 ∈ `GO` / `GO_WITH_RISK` / `PASS` / `COND`（后端 `ProjectService.DECIDED_OK_CONCLUSIONS`，前端唯一副本 `src/domain/gateConclusions.ts`；约定 C-34-1：界面禁写第二份常量表）。
- **分母不写死**：等于该项目的**适用门数**（`decidedGateCount/totalGateCount` 由后端下发；`I`/`II`/未填 = 11 = `DCP0/TR1/TR2/DCP1/TR3/DCP2/TR4/DCP_ES/TR5/TR6/DCP3`，`III`/`NA` = 6，见 `docs/plm-tech/09-工作流引擎与元数据扩展设计.md` §1.9.1）。
  **因此本节所有 `x/11` 都要读作 `x/N`**（2026-11-11 用户裁定；N 随管理类别变化，改类别即时生效）。
- **改了门集维度就当场重取 `flow-overview`（2026-11-12 批次65 / D65-1，用户实测报缺）**：
  凡是**改变门集或检查项解析结果**的字段（`medClass`、`productKind`）保存成功后，前端要**重跑 `loadFlow()`**，
  不许把"刷新一下页面"当成生效方式。后端 `flowOverview` 每次请求都按当前 `med_class` 现算
  （`gateMap.orderedFor(normalizeMedClass(...))`，无缓存），此前 `saveProject` 保存成功只 `patchRow` 就地补行、
  **从不重取** ⇒ 时间线、统计卡、ctx-bar 三处一起停在旧门集上。
  验收判据是**不刷新页面**下三处同步变，少一处即判否。
- **「项目统计」卡内不再显示「生命周期」（2026-11-12 批次65 / D65-2，用户裁定删除）**：
  它的分母 `11` 是**项目状态词表**长度（`PRJ_STATUSES`：立项…已终止），与门集不同源；
  但它与上一行「评审门 `x/N`」并排、同为 `x/y` 形态 ⇒ 必然被读成同一轴；且 `I/II` 类门数恰好也是 11，
  数值巧合进一步强化"改类别没生效"的错觉。两个数字撞车即删除，不追根因（用户原话："不用定位原因"）。
  **项目状态没有因此消失**：详情面板头部元数据与 ctx-bar 的「生命周期」保留——它们不带 `x/y` 分母、
  不与门进度并排，是唯一还说明"项目现在处在哪个状态"的地方。删除范围严格限定在「项目统计 · DCP0-DCP3」卡内。
- **分母未知时显示 `—`**（而不是 `x/0`）：宁可少显示，也不给一个错的分数。
- **切换项目时的竞态**：`flow` 是异步加载的，渲染前必须校验 `flow.projectId === selected.id`，否则会短暂显示**上一个项目**的门数（"数对但对象错"）。
- 运行态判据：清单套件 `W36`（`ipd/deploy/wsl/plm-app/proj-gate-stats-walkthrough.mjs`），含"界面上的 x == 接口的 x"交叉核对。
| **点击 → 评审工作台** | 节点 `onSelect(node)` → 打开 `ReviewWorkbench`；`compact` 模式（内嵌场景）隐藏图例/守卫行/reviewCode |
| **键盘/焦点** | 节点 `role="button"` + `tabIndex={0}`（**可 Tab 聚焦**，虚线焦点环 §1.2）；**Enter/空格激活**（`onKeyDown` preventDefault 后 `onSelect`）——与 §7.1 通用规则一致 |

#### 6.11.2 统一评审工作台（ReviewWorkbench）

单卡纵向布局（`.rwb`），**全程禁弹窗**（§6.1）、行内编辑、消息区反馈（不 alert）；判定/签署成功后回调 `onChanged()` 刷新时间线。

| 区块 | 规格 |
|---|---|
| **头部** | `{gateCode} {gateName} — 商业决策评审（IPMT）/ 技术评审（PDT/SE）` + 📎 reviewCode + 状态 pill；无评审或已判定时显示「发起评审/再次发起评审」主按钮，`disabled = !precheck.passed`（title「机器预审未通过，先补齐证据」） |
| **预审干跑条** | `GET /reviews/precheck?projectId&gateCode` 结果卡：通过绿底 `#f0fdf4` / 未通过橙底 `#fff7ed`，检查项逐枚 PASS/FAIL pill（title=detail）（IBR-08：证据包=系统实时投影）。**禁用原因显式化（V50，2026-09-10）**：预审未通过时在消息区下方渲染 `.rwb-block` 橙条「⛔ 暂时无法发起评审：机器预审未通过，以下前置条件需先满足：{检查名}（{detail}）…」，并附「若你无发起权限（须 pdt_manager / product_manager / ipmt / ipmt_chair / tr_chair），按钮同样不可用」——**禁止只给灰按钮不给原因**（用户实测反馈） |
| **决策区：最终结论 + 签署 + 否决（V58，2026-09-10 用户口径）** | 标题「IPMT 决策与签署 / 技术评审决策与签署」+ 提示「签署 = 代表 IPMT 形成合议结论并生效（定论）；否决只在签署前有效」。**① 结论预览条**（浅底卡）：`最终形成的综合评议结论：{结论 pill 或「拟形成：X（尚未签署，未生效）」或「尚未选择结论」}` + `综合意见：{review.opinion 或 textarea 草稿（标注"尚未随签署生效"）}` + 条件意见（含责任人/期限）；已判定追加「已定论 · 时间」pill。**措辞键（2026-11-13 批次66 需求②修正）**：「尚未签署，未生效」只在 `!chairSigned` 时出现——`chairSigned=true` 的响应**绝不**再显示「尚未签署」（后端 `rvw:head|` 请求级记忆已在 decide 写路径失效，签署+定论一步完成的响应即带最终结论与 DECIDED 状态；此前该组合会陈旧成 `conclusion=null + chairSigned=true`，前端把矛盾 DTO 逐字显示）。**② 主席签署行**：`✓ 已签署（定论）/ ○ 未签署（结论未生效）` + 签署人/时间/代签 + 「签名绑定「结论 + 综合意见」」；未签署时提示「签署即定论…如需修改决策，只能再次发起一次新的决策评审」。**③ 否决行（仅未判定时渲染）**：说明「否决 = **阻止项目继续往下推进**（不放行下一阶段），**不是**否定已形成的集体评议结论；理由必填，签署前可撤回」；按钮「以 IPMT 成员/主任身份提交否决」（`myAction ∈ {VETO, DECIDE, SIGN}` 且**未签署**）；存在 ACTIVE 否决时红字「⛔ 存在未撤回的否决 → 无法签署形成结论：{actor（reason）}」+「撤回否决」；**已签署 → 否决入口整块不渲染**，提示"如需修改决策请再次发起决策评审"。**④ 签署记录行**（只读，`已撤回` 标注）。主按钮在结论区，文案 **「签署并形成结论（定论）」**（未签署）/「记录结论（补齐历史签署）」（兼容两步路径），`disabled` 追加「存在未撤回否决」。**移除「仅签署」主入口**（签署必须携带结论，否则与"签署=定论"矛盾；兼容接口 `POST /reviews/{id}/sign` 保留供历史/会签） |
| **签署/否决/结论的后端权威规则（V58）** | 否决：`DECIDED` → 400；已存在 `CHAIR/SIGN(ACTIVE)` → 400 `SIGNED_NO_VETO`（提示再次发起决策评审）；理由必填 → `VETO_REASON_REQUIRED`；签署：存在 ACTIVE 否决 → 400 `VETO_PENDING`；未签 decide 且未走合并路径 → 400 `SIGNER_REQUIRED`；结论 `GO/GO_WITH_RISK` 才解锁阶段流转 |
| **清单逐项判定（V50 升级）** | 表格 `gate-check-table`：#/检查项/**责任角色**/`资格角色`（`allowedRoles` 合并展示，`canJudgeOverride` 时加「代判」琥珀徽标）/**处理人**（`assignee`→`claimedBy`→「待认领」）/结论/判定与指派。强制项 `*` 标记 + 行高亮；**PASS 直接提交，COND/FAIL 展开行内编辑行**（琥珀底 `#fffbeb`）：条件意见 textarea（**必填**）+ 证据引用/责任人（可选）+ 期限 date + 确认/取消。**按钮显隐由项级 `canJudge` 驱动**：无资格显示「无判定资格」（title=须哪些角色），后端 403 权威兜底。**项级指派（V50）**：未指派项显示「指派」→ 行内展开蓝色底 `#f0f9ff` 下拉，选项来自 `GET /reviews/{id}/candidates?itemNo=`（**只列持有资格角色的启用用户**，组织 ∪ 项目角色），选中即 `POST .../assign`；无合格候选人显示「无合格候选人（该资格角色暂无启用用户）」 |
| **结论区（V50 两级意见 + 一次签署）** | 标题「结论级综合意见（IPMT / 技术评审主席）」+ 提示「与项级专业意见可不同——系统按项级结果生成候选，可采纳可改」；结论下拉（DCP：GO/GO_WITH_RISK/REDIRECT/TERMINATE；TR：PASS/COND/FAIL）+ `suggestedConclusion` 非空且未选中时显示「采纳系统建议：{结论}」按钮；**综合意见 textarea**（加载时预填 `suggestedOpinion` = 【项级专业意见汇总】+【综合评估】草稿，可改）；下方统计行「强制项 N 项 · 待判 N 项 · 系统候选结论 X」；选 **GO_WITH_RISK/COND** 展开条件意见行（内容必填 + 责任人 + 期限）；**结论理由输入框按 `GET /reviews/decision-rules` 的 `reasonRequired` 渲染**（REDIRECT/TERMINATE/FAIL 等必填；COND 类由条件意见承担理由）——修复"后端要理由、前端无输入框"的 400 死路；主按钮 **「签署并记录结论」**（未签署时，一次原子完成签署+结论）/「记录结论」（已签署），`disabled = 未选结论 \|\| !canDecide \|\| 强制项未判（TERMINATE/REDIRECT 豁免）\|\| COND 缺条件意见 \|\| 必填理由为空`，旁附原因提示（「仅主席…可签署并判定结论」/「签署即形成合议结论（签名绑定结论与综合意见）」）；已判定显示综合意见 + 条件意见只读条（含责任人/期限 + 遗留问题说明 IBR-14） |

**承接与替换**：`pages/ProjectsPage.tsx` 项目详情以时间线替换旧「阶段门时间线 G1→G7」，点击节点开工作台。

> **2026-09-11 变更（REQ-2026-0700：阶段门 G1..G7 作废，只保留评审门）**：
> - **页面替换**：`pages/StageGatePage.tsx` 与组件 `components/GateCheckTable.tsx`、`components/GateStats.tsx` **已删除**，
>   由 `pages/ReviewGatePage.tsx` 承接。路由仍是 `/projects/:id/gates/:gateCode`（历史链接/会议纪要里的 `/gates/G3` 不 404）——
>   该页先按评审门码匹配 `flow.nodes[].code`，**未命中时再按 `oldGateCode` 映射**到对应评审门，并在页头标注「旧阶段门 G3 已作废，自动定位到评审门 TR3」。
> - **评审门工作台不再含"旧门证据包"**：旧门检查项已逐项归并到评审清单（后端对照表 `t_gate_check_migration`，
>   12 项 EQUIVALENT + 2 项 ADDED），在 `ReviewWorkbench` 的清单里逐条判定即可。留着"进度条 + 证据包表 + 开门按钮"
>   会让界面同时出现两套门概念，使用者必须理解映射关系才能判断点哪个。
> - **项目驾驶舱（`pages/ProjectCockpitPage.tsx`）数据源整体切到评审门**：原先三块（管线矩阵的 G1→G7 进度条、
>   门禁阻塞看板 `gate.canOpen===false`、遗留问题总览 `gate.issues`）在阶段门作废后**全部变空**——
>   页面会呈现"无阻塞、无遗留问题"的假象，比报错更危险。现改由 `GET /projects/{id}/flow-overview` 的节点驱动：
>   管线矩阵给每个项目一排评审门按钮（点击直达工作台）、阻塞看板取 `node.blocked`、遗留问题总览取 `node.openIssueCount`；
>   **流程总览拉取失败的项目显式标注「⚠ 流程总览加载失败（不代表无阻塞）」**，不伪造空节点。
> - 数据契约（`FlowOverview`/`ReviewResp`/`ReviewSigner`）在 `api/client.ts`；DCP/TR 结论色映射在 `pages/statusPill.ts`。
>   `FlowNode.legacyGateStatus` 自此后端恒为 `null`（字段保留以兼容历史响应）。

**同批新增页面（2026-09-11，均为内联录入、零弹窗，令牌与本节一致）**：

| 页面 | 路由 | 对应需求 | 要点 |
|---|---|---|---|
| 风险台账 | `/risks` | REQ-2026-0490 | **等级不可人工填**：只给严重度 S 与概率 P（各 1..5 下拉），等级由 S×P 计算；本地预览与服务端值不一致时以 `--warn` 明示"统计以后端为准"；PMS 校准区（生产后信息回流）用琥珀框标注"不改写原判定" |
| 风险规则 | `/risk-rules` | REQ-2026-0484 | 来源列一眼可分（`YAML`=基线随版本 / `DB`=在线覆盖）；**启停是独立动作**：行内展开理由输入后提交（理由进审计流水）；条件 DSL 用 textarea 编 JSON，非法 JSON 就地红字并阻止提交；基线规则禁用删除（title 说明"请用停用"） |
| 上市后监督 | `/postmarket` | REQ-2026-0354 | 三页签（投诉/CAPA/召回）共用一套「合法迁移边 + 必填前置条件」数据表驱动的详情/流转组件（不复制三份状态机）；**三页签统一两栏布局（表格在左、详情在右，§3.3.1 `.dual split even`；2026-09-17 批次26）**；投诉台账走时限合规视图（§6.3.1.1：默认上报时限升序 + 时限区间/处理口径/排序控件 + 列上「超期N天/剩N天」标记）；**独立「不良事件上报时限提醒」表格已按用户裁定去掉——其警示力并入台账列，不得静默丢失**；召回关闭前若未标记"已上报监管"必须填理由，界面红框明示这是法定义务 |
| 评审门工作台 | `/projects/:id/gates/:gateCode` | REQ-2026-0700 | 见上 |

**DHF/DMR 齐套（`pages/DocumentsPage.tsx`，REQ-2026-0353）**：`GET /documents/dhf/completeness` 返回形状由**行数组**改为 `{rows, summary}`——
`summary` 携带齐套率与「适用/不适用/停用」计数；行上 `applicable=false` 表示该章节对本产品不适用（按适用范围判定或人工标 N.A.），
**不计入齐套率分母**。页面新增「适用范围」列与「不适用处理」列（可就地标 N.A./取消；理由与批准人内联必填）。
破坏性形状变更在此刻意接受：旧形状无法表达"不适用"，而"齐/缺/不适用"正是该需求要能在系统里表达的东西。

**文档中心批次46 变更（`pages/DocumentsPage.tsx` + `hooks/useFlow.ts`，PLM 反馈 #31/#35/#37/#39/#41/#42/#43）**
（用户裁定：全部做透；权威源=业务字典表；项目关联保持"经交付物清单"口径；批量下载=服务端流式 ZIP）

| 要素 | 规格 | 依据 |
| --- | --- | --- |
| ① 新建态上传引导 | 详情面板在 `_isNew` 时显示蓝色提示块（`data-testid="doc-upload-hint"`）：「先保存，再上传」+ 说明**为什么**（文件必须挂到具体版本，而版本行在保存时才产生）。上传控件在新建态**不存在**（后端 `POST /documents/{id}/revisions/{revId}/files` 需要 revId） | #31（PM 明写"只加提示、不动后端"）；不假装能做到做不到的事 |
| ② 上传可传状态 | 上传按钮的可用性按流程声明的 **`attachmentStatuses`**（`DRAFT`+`REVIEW`）判定，**不再**复用 `editableStatuses`（仅 DRAFT）。置灰时文案写明"可上传状态见流程声明" | REQ-2026-1201 / V-134：同一概念不得两套判据（原为手册登记的"已知偏差"） |
| ③ 新建版本/升版 | 「版本与文件」区右上角 `＋ 新建版本（升版）`（`data-testid="doc-new-revision-open"`）：仅当前版本 ∈ `{APPROVED,RELEASED,OBSOLETE}` 可用；内联表单填版本号（留空自动下一字母）+ 变更原因（≥4 字）→ `POST /documents/{id}/revisions`。提示语明示"旧版本原样保留" | #37；P2/P3 历史不动、纠正靠新版本 |
| ④ 所属人可见与转移 | 关键信息区显示 `所属人`（空时写明"判定回落建档人 X"）；`⇄ 转移所属人`（`data-testid="doc-owner-transfer-open"`）→ 内联填新登录名 + 依据（≥8 字）→ `POST /documents/{id}/owner-transfer`。按钮可用性按流程声明的 **`ownerTransferStatuses`**（含受控态、不含 `OBSOLETE`） | #41；状态门来自声明而非硬编码 |
| ⑤ 项目筛选 | 工具栏 `SearchPick objType="PRJ"` → 传 `projectId`；命中 0 行时渲染**空集解释**（`data-testid="doc-project-empty"`）：说明关联口径=交付物清单引用，并区分"清单未引用任何文档"与"被其它筛选条件排除" | #42；空集必须能解释（否则用户误判"该项目的文档没建"） |
| ⑥ 作废理由输入框 | 需要理由的边改由流程声明判定（`requiresReason = rework \|\| requireReason`）；`→OBSOLETE` 就地弹红色理由框（`data-testid="doc-obsolete-reason-box"`），前端先拦 <8 字并给出可行动提示，框内文案提示"若只是内容有误，更合适的是＋新建版本" | #43①；原实现只按 `rework` 弹框，而作废边 `reason:true, rework:false` ⇒ 用户看到"要输入理由"却无输入框 |
| ⑦ 批量下载 | 网格加复选框列（`rowSelection:'multiple'`，**单击行仍打开详情**）；工具栏 `⬇ 批量下载(N)`（`data-testid="doc-batch-download"`）+ `受控版` 勾选。勾选行=指定集合，未勾选=当前筛选结果（含筛选参数一并提交） | #43②；判据 = 用户看到的列表与下载内容一致 |
| ⑧ 文档类型下拉 | 选项来自 `GET /documents/doc-types`（**删除前端 `DOC_TYPES` 常量**）；"可省略产品关联"的白名单改由后端下发的 `productOptional` 决定（原前端硬编码 `['SOP']`） | #39 / C-34-1：界面词表副本必须来自权威源 |

**批量下载的前端通道选择（与 §6.12 的关系，必须写清）**：批量下载走 `lib/download.ts` 的 `downloadBatch()`，
即 **`responseType:'blob'` + objectURL**。**这不是对 §6.12 的倒退**，而是被 HTTP 语义逼出来的：
① 该端点是 `POST /documents/batch-download`（筛选式批量无法用 GET 表达），而**裸导航只能是 GET**；
② 既有票据通道是"一票一份文件"，用它做批量 = 浏览器弹 N 个下载（会被拦截器挡掉大半），也不是"一个包"。
**代价必须写在这里**：ZIP 会整包进入**页面**内存（服务端侧仍是流式的）。适用边界 = 服务端批量上限
（`plm.download.batch-max-files`，默认 200 份）以内的常规下载；若将来出现"数百 MB 的批量包"，
正确做法是**给批量也签一张票 + GET 导航**，而不是调大上限。

---

### 6.12 文件下载：一次性票据 + 原生下载（2026-09-14；S26 起为主路径）

**判据**：任何"下载/导出"入口**禁止**用 `<a href="/api/v1/...">` 直链后端，也**禁止**把 `access_token` 放进 URL。
必须走 `lib/download.ts` 的 `downloadViaTicket(fileId, controlled)`：**先签一次性票据，再用原生导航下载**。

**为什么不能裸直链**：裸 `<a href>` 是**浏览器发起的导航请求**，`api/client.ts` 注入 `Authorization` 的 axios 拦截器**根本不参与**；
OIDC 部署态身份唯一来源是 Bearer ⇒ 恒 401（S25 实测：手工补 `X-PLM-User` 也仍 401，该头在 OIDC 模式不参与鉴权）。

**为什么不是 S25 那套 blob（`responseType:'blob'` + objectURL）**：blob 的成立前提是"文件远小于内存预算"——
S25 实测全库 146 个文件共 498 kB、最大 36 kB，所以当时它是对的。**用户随后确认会有大文件**，前提不成立：
整文件进**页面**内存（数百 MB 会拖死标签），且**丢掉原生进度/暂停/取消/续传**。现行方案把字节从页面内存里彻底移出去。

| 要素 | 规格 |
| --- | --- |
| ① 签票 | `POST /documents/files/{fileId}/download-ticket?controlled=`（axios，带 Bearer）→ `{ticket, url, expiresAt, fileName, fileSize}` |
| ② 下载 | 建临时无 `href` 之外的 `<a>`，`a.href = ticket.url` → `click()` → 移除。服务端响应带 `Content-Disposition: attachment`，浏览器**留在当前页**并交给自身下载器 |
| 文件名 | 由服务端 `Content-Disposition` 决定（RFC 5987），**前端不再解析** —— S25 那套 Q/B 双解码随 blob 一起删除 |
| 错误态 | 签票是普通 axios 调用 ⇒ 错误体是普通 JSON，直接 `humanizeApiError` 取文案。**关键收益**：体积上限（413）、受控版非 PDF（400）等拒绝发生在**导航之前**，使用者在页内就能看到原因，而不是白等一场 |
| 交互 | 下载中把该条链接文案改为「下载中…」并防连点；成功后提示「**已发起**下载 〈文件名〉」（原生下载无法在页内观测完成，文案不得谎称"已开始下载 X"以外的确定性） |
| 禁止 | ① 不得把 access_token 放进 URL；② 不得把票据当作可复用的链接缓存/分享（服务端一次性，第二次完整下载 403） |

**服务端契约（背景，前端只需知道语义）**：票据 32 字节 CSPRNG（Base64URL 43 字符），服务端**只存 sha256**；
作用域 = (签发人, 文件, 是否受控)，URL 里**没有 fileId** 可篡改；**单次发起**（第二次完整下载 403）+
**同票 TTL 内可 `Range` 续传**（浏览器「继续下载」/断点续传，206）；发起窗口默认 120s、续传窗口默认 1800s（均有硬上限）；
过期 410、坏票 401（与"文件不存在"同文案，不做存在性探针）。详见 spec-s26 与 `contracts.md` C-112..C-115。

**渲染形态**：保持既有 `.dl` 样式——无 `href` 的 `<a role="button" tabIndex={0}>` + `onClick`/`onKeyDown`（Enter/Space）。

**当前用途**：文档中心详情面板的「下载」与「⬇ 受控版」（`f.fileType === 'RENDERPDF'` 才出现受控版）。
**待排查**：其它域若有导出/下载入口（注册申报资料、产品包、BOM 导出等按钮目前无 handler），实现时必须走本函数，不得新开直链。

**为什么是"票据 + 原生导航"，而不是另外几种做法**（2026-09-14 答疑后补记，避免后人重复推导）：

| 做法 | 能否修 401 | 代价 | 结论 |
| --- | --- | --- | --- |
| **一次性票据 + 原生导航（现行）** | ✅ 复用一个已认证调用来换短命凭据 | 多一跳（签票）；新增一类凭据，需短 TTL/单次/作用域三重约束 | 大文件正道：字节不进页面内存、不整份进服务端堆，进度/取消/续传都在浏览器手里 |
| 前端 blob（S25 方案） | ✅ 复用 axios 拦截器注入的 Bearer | 整文件进页面内存；无原生进度/续传 | **仅在文件远小于内存预算时成立**（当时最大 36 kB）；用户确认会有大文件后即失效 |
| access_token 放进 cookie | ✅（`<a href>` 天然携带） | **改动整个应用的鉴权模型**（Bearer + oidc-client → cookie 会话，牵涉 CSRF） | 架构级改动，超出前端规格范围；**须先问用户**，不得自行改 |
| token 放进 URL 查询串 | ✅ | token 进浏览器历史 / Referer / 代理与访问日志；且通常长有效期 | **禁止**：这是把长期凭据换成一次性短命凭据才能解决的问题 |
| Service Worker 拦截导航补 header | ✅（前后端同源，经 nginx 代理） | 引入 SW 安装/更新生命周期 | 能力可用但机械太重，本批不走 |

**复检触发条件（本规格自带的失效线）**：受控水印版（`controlled=true`）仍必须整份 PDF 入内存（PDFBox 无法流式），
故有体积上限（默认 64 MB，超限 413 `CONTROLLED_TOO_LARGE`）。**若受控大文件成为常态需求**，
要把水印改成增量/分块（工量大），而不是简单提高上限——上限存在的理由就是"一个人的大文件不能拖垮所有人"。

---

### 6.13 页面默认值策略：不猜，且记住使用者的选择（2026-09-14，S25）

**判据**：页面里"默认打开/默认选中哪一个对象"**不得**取自"列表首条"。

**为什么**（真实事故，陷阱 #35）：`BomEditorPage` 原用 `/items` 首条当默认根，而排序是它的隐含契约——按 §6.3.1 把列表改成"最新在前"后，默认根从 `M-2026-0190 呼吸机 R3 增强型（整机，30 结构行）` 变成 `M-2026-0744（刚建的件，0 结构行）`，从菜单进入 BOM 管理就是一片空结构；空网格又分不清"没有结构"与"没加载到"。

| 规则 | 规格 |
| --- | --- |
| 依据必须写出来 | 默认值的选择依据要写在代码里（注释说明为何是它）。写不出来的默认值＝没有依据的默认值，会被无关改动悄悄换掉（V-180） |
| 有使用者选择的地方 → 记住 | 用 `localStorage`，键名 `plm_<域>_<语义>`（如 `plm_bom_root_item`）；**选择即落库**（`onChange` 里写），清空选择即删键 |
| 无记忆 → 显式手选，**不猜** | 渲染"还没有选择…"的引导态并说明"选择会被记住"；严禁回落"随便挑一个" |
| 记忆可能在别的环境失效 | 记住的 id 要**按 id 直取校验一次**；取不到就**清掉记忆**并回到手选引导——否则每次进页面先空转一次、且使用者永远不知道那条记忆是坏的 |
| 两种"空"必须分开 | "还没选对象"与"选了但对象没有内容"**成因与下一步完全不同**，必须分别渲染（V-181）。过去两者都是一片空白 |
| 不适用于受控默认值 | 受控写路径的默认值（如对象初态、审批默认结论）**不得**由客户端记忆决定——那会让"受控"变成"看浏览器脸色" |

**当前用途**：BOM 编辑器的结构根（`plm_bom_root_item`）。深链 `/bom/:id` 优先于记忆，且深链进入时也会写入记忆。

**增补（2026-09-28 · 创建值静默记忆，与 §5.3.4「保存&新建」配套）**：连续建档时，新建草稿**沿用上一个对象的
选择项**，规则——

| 项 | 口径 | 实例 |
|---|---|---|
| **记忆** | 创建成功即写 `localStorage`（键 `plm_<域>_last_new`）；下次新建草稿直接作默认值；**无任何勾选框 UI**（静默记忆，"沿用上一个"是行为不是选项） | 物料：`plm_item_last_new`（采购类型/物料类型）；需求：`plm_req_last_new`（类型/优先级） |
| **不记忆** | **必填决策项不记忆**——必须每次显式选择，防止"沿用"变成"替用户做决定" | 物料**类别**（批次57 裁定的页头显式选择）；文档**所属文件夹**（批次62 裁定的建档夹与筛选夹分离） |
| 例外说明 | 记忆值也要能改：草稿里的字段照常可编辑，记忆只决定**初值** | — |

#### 6.13.1 页面 URL 参数的两个语义：`?open=<id>` 到达对象、`?new=1` 新建对象（批次54，2026-09-27）

两个参数**并列**，都是"由 URL 表达用户意图"的既有做法（不是两套机制）；语义不同，判据也不同：

| 参数 | 语义 | 页面要做什么 | 只执行一次？ |
| --- | --- | --- | --- |
| `?open=<id>` | **按 ID 到达某个已存在的对象**（口径见 §5.3「深链定位优先」：清空会排除目标的筛选 + 列表加载后仍未命中时按 id 精确拉取） | 选中该对象（详情最大化与否按 §3.6 G-UI-7-1 判定） | 否（它描述"当前看哪一条"，刷新后仍应成立） |
| `?new=1` | **在目标管理页开一条"新建草稿行"**（如物料库的新建物料） | 进入页面即进草稿态（`_isNew`，见 §5.3.2），落在该页既有的**新建入口**上 | **是**——只执行一次 |

**`?new=1` 的三条硬约束**：

1. **只执行一次**：草稿行是"加一条"，若在 effect 里无守卫地执行，任何一次重渲染（选中行变化、元数据到达、翻页）都会再加一条——
   用户看到的是"我一进来就有一堆空行"。实现口径：**页面实例级 `useRef` 守卫 + 空依赖 effect**。
2. **不带参数（或参数非 `1`）进入时完全不影响既有行为**：不得自动新建。判据是"默认进入 = 与加这个参数之前逐格相同"。
3. **参数读取方式沿用该页既有写法**：本页的 `?open=` 走 `useOpenId`（其内部就是 `useSearchParams`），
   新参数**不得**引入第二套读参方式（`location.hash` 手解析一类）。

**用途与代价（实例：BOM 编辑器的「新建料号」）**：BOM 编辑器页头的「新建料号」是**真链接**（`<a href="/items?new=1" target="_blank">`）
跳到物料库的新标签页，在那边进新建草稿态——**建料只有一处实现**（发号/查重/类别词表/属性模板都在物料库）。
代价已明示并接受：**BOM 页不会自动回填这个新料号**，建好后要回 BOM 页用「添加子件」检索选中一次（裁定 D54-6）。

- 与 **G-UI-7-2**（"打开另一个对象必须新标签页"）的关系：那条规则管"在 A 的上下文里展示 B 的引用"，
  本条管"从 A 页去做一件**要在别的页面完成的事**"——两者都要求**真链接 + 新标签页**，
  共同理由是"不要冲掉当前正在处理的对象"（BOM 编辑器里那份没保存完的结构草稿，比什么都贵）。
- 反例（本仓已发生过一次）：在原页面内联一个"新建料号"小表单——它必然与物料库的建料入口**分叉**
  （类别词表、属性模板、查重触发条件各写一份），且新建的料号**不在物料库里被查重过**。

---

### 6.14 表格导出通道（批次45A，2026-09-22；用户要求"提取公共组件让物料/需求复用"）

**一句话**：导出 = **取数与筛选留在各域**、**表格→字节与面板 UI 走公共件**。两域共用一套实现，
不允许任何页面内联第二份下载逻辑。

#### 6.14.1 公共构件（唯一实现点）

| 层 | 构件 | 职责 |
| --- | --- | --- |
| 后端 | `com/plm/common/TabularExport.java` | `ExportSpec`（文件名前缀/sheet 名/列定义）+ `ExportRow` + CSV 生成（UTF-8 BOM、RFC4180 引号）+ xlsx 生成（POI）+ 文件名（含日期）+ `EXPORT_MAX_ROWS` + `tooLarge()` 错误。**不取数、不判权限、不知道业务语义** |
| 后端 | 各域 `*ExportService` | 用**该域列表服务**逐页取数（保证"导出的行集合 == 页面看到的行集合"）、把业务对象映射成 `ExportRow` |
| 前端 | `src/components/ExportPanel.tsx` | 导出面板 UI + 下载动作 + 结果/错误文案；props 收 `endpoint`/`query`/`scope`/`narrowHint`/`preflight` |
| 前端 | `src/lib/download.ts` | `downloadAttachment`（axios blob + 原生 objectURL 下载）、`fileNameFromContentDisposition`、`blobErrorText`（blob 错误体读回） |

#### 6.14.2 五条硬约束（每条对应一次实测代价）

| # | 约束 | 为什么 |
| --- | --- | --- |
| 1 | **网格取数与导出必须同一份筛选对象** | 各写一份就会出现"网格筛出 12 条、导出却是 464 条"，且两边都"看起来是对的"。实现上：前端一个 `currentQuery()` 同时供给 `load()` 与 `ExportPanel`；后端导出走同一个 `list()` |
| 2 | CSV **必须**带 UTF-8 BOM | 无 BOM 的中文 CSV 在 Excel 里是乱码，用户视角是"文件坏了"而不是"编码问题" |
| 3 | 超限**报错并点名行数**，不静默截断 | 导出物会被当成对账依据；"看起来完整、实际缺行"比"明确失败"危险得多。上限 `TabularExport.EXPORT_MAX_ROWS = 50000`（**单一权威常量**，各域常量必须引用它） |
| 4 | 表头标签与顺序**只在 `ExportSpec` 声明一次** | 两处声明同一件事必然漂移（陷阱 #34）。CSV 表头、xlsx 表头、面板回显全部从它推导；列数与取值函数个数不一致时**显式抛错**（否则表格整体串列，而文件完全合法） |
| 5 | 附件文件名走 **RFC 5987**（`ContentDisposition.attachment().filename(name, UTF_8)`） | **手拼 `"attachment; filename=\"" + 中文名 + "\""` 会让整个 `Content-Disposition` 头在 Tomcat 10 上静默消失**（不是报错、不是替换）。实测：三个导出/模板端点全部没有该头，前端的 `fileNameFromContentDisposition` 只能回落成猜的名字；而用 RFC 5987 的 `GET /documents/files/{id}/download` 头一直可见。**这条最容易回退**（手拼一行就没了，且无任何报错），故有 CI 断言锁住 |
| 6 | **列的口径 = "面板看得见的字段，导出必须有列"**（批次49 补，见 §6.17） | 需求导出原只追加**网格列**（`is_grid_col=TRUE`），而面板读的是 `detail-fields` ⇒ 只登记为详情字段的扩展属性**永远进不了导出**（实测需求域 30 个键有真实值、界面与导出两处都看不见）。修法：导出的动态列直接取 `metadata.detailFields`（与面板同一份清单），再补网格列去重；固定列的表头与面板标签**逐字对齐**（面板叫「方案内容」而导出叫「方案/实现记录」时，用户无法确认是不是同一个字段） |

#### 6.14.3 面板的信息要求（不做就会变成"最坏的失败形态"）

| 要求 | 规格 |
| --- | --- |
| **筛选逐条回显** | 面板显示"当前筛选：状态「待分析」· 关键词「电池」"；无筛选时显示"无（= 全量）"——**不能**让用户猜这份文件代表什么 |
| 上限与超限行为写在面板里 | "单次上限 50000 行，超限后端会拒绝并报出命中行数（不静默截断）" |
| 超限给出**可执行**的收窄建议 | `narrowHint` 传该域具体维度名（如"状态/类别/关键词/所属结构"），不写"请收窄筛选" |
| 0 行必须说出来 | 命中 0 行时后端返回"只有表头"的合法文件；面板必须提示"文件是空的"，否则用户会以为系统坏了 |
| §6.1 禁弹窗 | 面板是**内联卡片**，不用 modal |

#### 6.14.4 端点与锚点（现状）

| 域 | 端点 | 面板锚点前缀 | 按钮锚点 |
| --- | --- | --- | --- |
| 物料 | `GET /api/v1/items/export?format=csv\|xlsx`（+ `import-template`） | `item-export` | `item-export-open` |
| 需求 | `GET /api/v1/requirements/export?format=csv\|xlsx` | `req-export` | `req-export-open` |

`format` 值域：`csv` / `xlsx`（`xls` 按 xlsx 写出；读取才兼容 xls）。**非 xlsx 一律按 csv 输出**（两域同行为，不报 500）。
