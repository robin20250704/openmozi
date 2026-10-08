# 前端实现规格 · 键盘 · 组件约定 · 关键陷阱 · 文件组织

> 本文件是 `docs/plm-tech/08-前端实现规格.md`（索引）的子文件之一，承载**原 §7~10** 的正文。
> **章节编号保持原样**（保号）：原文档里的 `§5.4`、`§6.14` 等引用在本文件内一一对应，不必换算。
> 索引（含章节号 → 子文件映射表）：[`../08-前端实现规格.md`](../08-前端实现规格.md)。

---
## 7. 键盘快捷键

### 7.1 通用

| 键                   | 行为                               |
| ------------------- | -------------------------------- |
| `Tab` / `Shift+Tab` | 可聚焦控件间移动，显示虚线蓝色焦点环               |
| `Enter`             | 激活（按钮/树节点）/ **进入单元格编辑**（可编辑列，§4.7.1）/ 触发搜索（搜索框） |
| `Esc`               | 退出编辑 / 清空搜索 / 取消操作               |
| `Ctrl+S`            | 详情面板保存                           |
| `Ctrl+Enter`        | 详情面板保存                           |
| `↑↓`                | 树节点间移动 / 网格行间移动 → **同步详情面板**（§4.7.2）          |

### 7.2 焦点顺序

```
侧栏导航 → breadcrumb → toolbar 控件 →
三栏: 树(tabindex=0) → 网格(tabindex=0) → 详情面板字段 → 保存/取消/全屏
```

### 7.3 分类树

- Roving tabindex：容器一个 tab stop（`tabindex=0`），`↑↓` 移动 activeIndex。
- 每节点 `role="treeitem"` / `aria-selected`。

---

## 8. 组件约定

| 约定      | 规格                                                                                                        |
| ------- | --------------------------------------------------------------------------------------------------------- |
| **按钮**  | `.btn`：7px 14px, 6px 圆角, 1px `--border` 边框, 13px。`.btn.primary`：`--primary` 底白字。`.btn.icon`：4px 8px, 14px |
| **输入框** | `padding:6px 10px; border:1px solid --border; border-radius:6px; font-size:13px`                          |
| **标签**  | `.dp-label`：12px, `--text-muted`。`.muted`：12px, `--text-faint`                                            |
| **卡片**  | 白底, 1px `--border`, 8px 圆角, 14px padding, 微阴影                                                             |
| **深色条** | `.ctx-bar`：`--sidebar` 底, 白字, 8px 圆角, 12.5px                                                              |
| **等宽**  | `.mono`：`ui-monospace, Consolas, monospace`。编号类加 `.mono`                                                  |
| **链接色** | `.dl`：`--ai`（紫色），用于逻辑 ID 链接                                                                               |
| **SearchPick** | 主业务对象检索选择面板（§6.2.1）：`.sp-trigger` 回显按钮 + `.sp-pop` 内联浮层 + `.sp-chips` 多选 chip；`components/SearchPick.tsx`，数据层 `lib/lookup.ts`。**弹层定位**（2026-09-20 修）：`fixed` 浮层必须**贴字段**显示——按弹层**真实高度**判定在下方还是上方、打开期间随滚动/窗口变化重算、`focus({preventScroll:true})`（陷阱 #38）；走查判据为**双向邻近**（≤12px + 水平对齐 + 完整可见） |
| **ExportPanel** | 表格导出公共面板（§6.14，批次45A）：`components/ExportPanel.tsx`。props：`endpoint` / `query`（**与列表同源的筛选对象**）/ `scope`（筛选可读回显）/ `narrowHint` / `fallbackName` / `testId` / `preflight` / `onMessage`。锚点 `<testId>-panel\|-scope\|-format\|-submit\|-close`。**不得**在页面内联第二份下载逻辑；下载通道统一走 `lib/download.ts` 的 `downloadAttachment` |
| **HistorySection** | 处理记录公共构件（§5.4，批次48）：`components/HistorySection.tsx`。props：`history: HistoryItem[]`（**必须**含 `diff`，类型不得瘦身成 `{ts,actor,action}`）/ `stateLabel?: (code) => string \| undefined`（各域传自己的 `useFlow().stateLabel`，取不到回落原码）。内置键名中文标签表（未登记键回落原键名）、`from`+`to` 合并为「状态」一行、理由类字段**不截断**、**收起态**「最近处理意见」摘要。**各域详情面板不得自建第二套处理记录渲染**（唯一例外：域内事件流水表，须注释说明） |
| **FileUpload** | 文件选择公共控件（2026-09-28）：`components/FileUpload.tsx`。**只管"选择文件 + 回显文件名 + `reset()`"**；上传动作本身（FormData/端点/协议）归各业务页——三处上传协议不同（文档版本附件 / 建档+挂首版 / 导入），强收进构件会把业务参数塞进 props 变成另一种复制。消除的是"选择控件"层的多源实现（此前文档中心/物料规格书/产品开发资料各写一份裸 `<input type=file>`）。已接入：文档中心 / 物料库（规格书）/ 产品结构（开发资料）；props：`accept` / `disabled` + `disabledTitle` / `onFile` / `testId`（展开 `-btn` / `-name` 锚点）；ref 暴露 `reset()` |

---

## 9. 关键陷阱（Gotchas）

> 共 **47 条**（2026-10-02 由 46 增至 47：新增"无差别全量回归"；同批把 41→46 的五条落在 §9 表尾）。

| #   | 陷阱                                                      | 正解                                                        |
| --- | ------------------------------------------------------- | --------------------------------------------------------- |
| 1   | `AgGridReact` 不自动添加 `ag-theme-alpine` class             | 容器 div 手动加 `className="grid-wrap ag-theme-alpine"`        |
| 2   | `defaultColDef.filterParams` 不被 v33 继承                  | 每列单独设 `filterParams`                                      |
| 3   | `.ag-menu { overflow:visible }` 覆盖面板高度自适应               | 不设 overflow，让 AG Grid 自管理                                 |
| 4   | AG Grid 图标字体 `var(--ag-icon-font-family)` 作用域不匹配        | 全局 `.ag-icon { font-family: agGridAlpine !important }`    |
| 5   | AG Grid 行点击不移动 DOM focus（`activeElement=BODY`）          | 用 `.ag-row-selected` 样式替代 `:focus`；加 `onCellFocused` 同步详情 |
| 6   | `valueFormatter` 列的 filter 对原始值过滤                       | 关联列 `filter: false`                                       |
| 7   | JPQL `:param IS NULL` 对 NULL OffsetDateTime 报 PG 类型推断错误 | `CAST(:param AS timestamp) IS NULL`                       |
| 8   | 后端 Dockerfile 只 COPY 预构建 JAR                            | 需先 `mvn package` 再 `docker compose build`                 |
| 9   | `:focus-visible` 只对键盘触发，鼠标点击不显示                         | 用 `:focus`（鼠标和键盘均显示）                                      |
| 10  | grid.css 的 `.ag-cell:focus { outline:none }` 覆盖焦点环      | 删除该规则或提高焦点环 specificity                                   |
| 11  | 前端 `NEXT`/`STATUSES` 硬编码与后端状态机不同步               | 用 `useFlow(flowId)` Hook 从 YAML 驱动，删除前端常量                 |
| 12  | `editableStatuses` 在 `MetadataService` 硬编码 switch case   | 委托 `FlowEngine.editableStatuses(flowId)`，从 YAML `editableStatuses` 驱动 |
| 13  | 处理记录 `useEffect[selected]` 未防 `_isNew` 行               | `if (selected && !selected._isNew)` 守卫，否则 `setHistory([])`     |
| 13b | **处理记录只渲染 `ts/actor/action`**（把审计下发的 `diff` 丢掉）：用户看到「处理记录 (3)」却看不到"说了什么"，**条数正确恰恰是最容易蒙混过关的假绿**（批次48 反馈：看不到流转处理意见；实测接口一直有 1770 条 `diff.reason`） | 一律用 `HistorySection`（§5.4.4）；页面内**不得**自建渲染；history 类型**不得**写成 `{ts,actor,action}`（类型说谎会让"没有 diff"看起来是设计）。反例纪律：理由必须**逐字比对**，不许只断"元素存在/条数正确" |
| 13c | **理由类文本被通用 80 字截断**：通用 `fmt()` 截断是为了"处理记录要能扫"，但 `reason` 这类**语义主体**截了就等于没这条记录（实测最长 313 字） | 语义字段走白名单（`FULL_TEXT_KEYS`）完整显示 + `whiteSpace:pre-wrap`；非语义字段保留 80 字截断。判据：夹具文本 >80 字并**反向**断言"截到 80 字必须判不一致"（防比对器恒真） |
| 14  | 审计链 hash 不匹配（DB timestamp 微秒截断 vs Java 纳秒精度）  | `canonicalTs()` 统一截断到微秒 + UTC `Z` 尾                          |
| 15  | `querySelectorAll('.ag-row')` 只拿到视口内 ~25 行（AG Grid 行虚拟化） | 用 `?open=<id>` 深链选中，或点击可见状态行；别按 code 找非视口行 |
| 16  | 流转按钮后 `setSelected(null)` 清空详情面板 | 改 `setSelected(r.data)`（返回更新对象）保留显示原对象并刷新版本/状态 |
| 17  | 列表曾默认按当前项目过滤且自动选中首项目（REQ-2026-0785：首项目若无需求，专业角色列表结构性恒空） | **已移除自动选中**（2026-09-12）：默认 = 全部项目 + 全部处理人；CDP/测试造数仍建议带 `projectId` 以覆盖"显式选了项目"的路径 |
| 18  | CDP `element.click()` 对部分 React 18 合成事件不可靠（点击无效果，认领按钮实测） | 用 `Input.dispatchMouseEvent` 真实鼠标事件（mouseMoved+Pressed+Released） |
| 19  | oidc-client User 存储键不是 `oidc.user` | 是 `oidc.user:<authority>:<client_id>`（读取/注入 token 须用完整键） |
| 20  | OIDC 会话 cookie 存在时点 SSO 直接 302 回调（跳过登录表单） | 验证脚本须兼容两条路径：需填表单 / 已带 state 直接回调 |
| 21  | 持久化恢复用 `\|\|` 回落默认值：空串是合法持久值（如 assignee=""=全部处理人）却被回落覆盖 | 合法空串值用 `??`（只兜 null/undefined），fallback 语义要与值的合法域一致 |
| 22  | CDP `Input.dispatchKeyEvent` 的 `modifiers` 是**位掩码**（Alt=1/Ctrl=2/Meta=4/Shift=8），不是数组 | `modifiers:1` 表示 Alt；传 `['alt']` 无效（e.altKey=false） |
| 23 | 部署后浏览器缓存旧 index.html → 引用旧 chunk（页面行为像旧版本） | CDP 脚本先 `Network.setCacheDisabled` + `Page.reload ignoreCache`；或 nginx 给 index.html 加 no-cache 头 |
| 24 | **WSL 9P 文件缓存**：Windows 侧编辑 /mnt/d 源文件后，WSL 内 vite build 仍读到旧内容（产物缺新改动，hash 却变了） | 构建前 `find src -type f -exec touch {} +` 强制刷新属性缓存；验证产物含新改动（grep 特征常量）再部署 |
| 25 | **预加载单页当全量**：对象选择器 `GET /xxx?pageSize=100` + 全量 `<option>`/本地过滤——单页上限 100 + 部分域 `createdAt` 升序 ⇒ 静默丢掉的恰是最新数据（101 vs 112 选项缺失、REQ-2026-0788），且无检索无"还有更多"提示 | 主业务对象选择一律用 SearchPick（§6.2.1）走 `/_platform/lookup/search` 服务端检索 + 分页；候选完整性必须显式（「共 N 条 · 已加载 M 条」） |
| 26 | 本地草稿行（`_isNew`）当普通行处理：参与计数、可点流转（临时 id 直发后端 400）、保存后靠副作用清理（可残留→重复创建） | 标题计数用服务端 `total`；流转动作 `_isNew` 守卫；创建成功显式 `filter(x => !x._isNew)`；`DetailPanel` 草稿态显示「创建」（按标题必填启用）而非禁用的「无改动」 |
| 27 | 后端框架原文直出界面（Java 异常/类型转换/SQL，经拦截器 toast 与页面 `setMsg` 双路） | 统一经 `lib/apiError.ts` `humanizeApiError(e, fallback)`：业务文案透传、框架原文降级为 fallback+code+HTTP，原文打 console |
| 28 | 脱敏值 `"***"` 是 truthy 字符串：被当对象 `JSON.stringify` 展示、可被编辑清空写成 `{}`（数据破坏）、"无权限"提示永不可达 | 脱敏态（契约字段 `finEstimateMasked` 或值为字符串）必须**只读禁用**展示「已脱敏」，不回写（REQ-2026-0790） |
| 29 | ag-grid 32.3.9 自定义空态组件用 `overlayNoRowsComponent` 不生效（静默回落默认 "No Rows To Show"） | 32.x 仍是旧名 `noRowsOverlayComponent`（v33 才改名）；自定义 overlay 属性名以所用版本的 gridOptions.d.ts 为准 |
| 30 | 宿主 `vite build` 出新 dist ≠ 5174 服务新代码：plm-web 是 runtime-only 镜像（COPY dist），不重建镜像则 nginx 永远服务旧 bundle | 改前端后：`self87-web-build.sh` → `docker compose up -d --build --no-deps plm-web` → 比对 5174 的 index bundle hash 与 dist/index.html 一致（加 `--no-deps` 避免顺带重启 plm-service） |
| 31 | 裸 `<a href="/api/v1/...">` 下载恒 401：这是**浏览器导航请求**，axios 拦截器不参与 ⇒ Authorization 发不出去；OIDC 部署态下连补 `X-PLM-User` 也救不了（该头在 OIDC 模式不参与鉴权） | 走 `lib/download.ts` 的签票路径：**已认证调用换一次性票据 → 原生导航**（§6.12）。**不得**把 token 放进 URL；S25 的 blob 方案已随"会有大文件"作废 |
| 32 | 把"某关系的成员集合"当**归属**来建模：物料库「当前产品 → 结构内物料」曾写成前端过滤，一旦分页就退化为"本页口径"；若顺手改成 `?productId=` 更糟——那会在契约里引入并不存在的"物料归属产品"模型（物料是共享主数据、可同时出现在多个产品结构中） | 用**关系语义**命名的参数（`inBomOf`＝"在…的结构中"）；过滤下沉到服务端，与结构树复用同一次关系展开（单一事实源）；**空集合必须换哨兵值**（空集合被读成"不过滤"＝把"没有"显示成"全部"） |
| 33 | 把"某个界面入口的约定"当成**行级数据约束**：BOM 编辑器根物料曾要求「仅整机/软件项」，而该规则只在前端、后端无「BOM 根」概念（根只是视图入口）——若照此在 `POST /boms` 加"父件必须是整机/软件项"会**打断多层 BOM**（实测电子件 `M-2026-0192` 自己带 7 条子件行、是整机 `M-2026-0190` 的合法中间层） | 先查数据反例再决定约束落点；视图入口的约定就留在视图层（候选可置顶、不可过滤掉），不要升级为写路径判据（C-109） |
| 34 | **同一份代码里并存两套词表**，且注释自称"共用、避免两处词表不一致"——注释描述的事实**不存在**：`BOM_VIEWS = {…,DBOM}`（树用）vs `BOM_VIEWS_ALL = {…,REGBOM}`（写用）。`DBOM` 是**幽灵视图**：库 `CHECK`（V7）里没有它、数据里 0 行、文档里没定义，却让 `GET /boms/tree?view=DBOM` 返回 **200 空结果**（"合法但没数据"），而写路径与数据库都拒绝它 | 词表必须有**唯一事实源**，且要与库 `CHECK` 对账：新增 `BomViewVocabularyTest` **直接从 Flyway 迁移脚本解析 `bom_view IN (…)`** 比对代码常量（V-185）。凡"两个常量/两处声明描述同一件事"的地方，先问"哪个是事实源"，不确定就把事实源也变成断言 |
| 35 | **默认值取自"列表首条"**：`BomEditorPage` 用 `/items` 的首条当默认根，而排序是它的隐含契约——按 §6.3.1 把列表改成"最新在前"后，默认根从"旗舰整机（30 结构行）"变成"刚建的件（0 结构行）"，从菜单进入就是一片空结构（空网格分不清"没有结构"与"没加载到"） | 默认值必须有**写出来的依据**，不得只是排序的副产品（V-179/V-180）。BOM 默认根已改为**记住上次选择（localStorage）**，无记忆时显式提示手选、**不猜**；两种空态（未选根 / 结构为空）分开渲染 |
| 36 | **通配返回类型让流式响应静默失效**：`ResponseEntity<?>` 装 `StreamingResponseBody` lambda，Spring 按**声明返回类型**派发返回值处理器 ⇒ 不走 `StreamingResponseBodyReturnValueHandler`，转去找能序列化 lambda 的消息转换器，直接 **400** `No converter for [...$$Lambda] with preset Content-Type 'text/markdown'`。看起来只是"泛型写法"，实际让整条大文件通道不可用 | 流式端点必须声明**具体泛型**（`ResponseEntity<StreamingResponseBody>`），两条分支统一同一响应体类型。**这类缺陷单测永远测不到**（直接调 service 全绿），只有走 HTTP 的运行态断言能发现（V-194） |
| 37 | **"签票成功"不等于"下载成功"**：票据在服务端**认领即生效**（`used_at` 落库），若此后响应构造/传输失败，这张票已经废了，使用者再点一次才会签新票 | 前端**每次点击都签新票**（不要缓存/复用票据 URL）；服务端把"可能在响应阶段失败"的判定尽量前移到**签发**阶段（体积上限、受控版只对 PDF 等），让拒绝发生在导航之前、页内可见（V-195） |
| 38 | **`position: fixed` 浮层的贴边判定用"估计高度"**：`SearchPick` 曾用写死的 `h = min(60vh, 420)` 判断"字段下方放得下吗"，而弹层真实高度常只有 200px 左右 ⇒ 下方明明有 300px 也判为"放不下"，翻到**字段上方**（实测偏 **457px**，用户报障原话："选择关联项目，项目对象选择列表位置离字段很远，而不是贴近显示"）。附带的第二个成因：`fixed` 浮层只在**打开那一刻**定位，且打开时 `input.focus()` 会触发滚动容器自动滚动 ⇒ 字段滚走、浮层留在原地 | ① 用**弹层真实高度**（`offsetHeight`）判定贴边，先按下沿渲染一帧再校正（必要时翻上，都放不下就夹在视口内——**可见优先**）；② 打开期间监听 `scroll`（`capture:true` 以覆盖内层滚动容器）与 `resize` 重新定位；③ `focus({preventScroll:true})`，别让打开动作自己把字段顶走。判据写成**双向邻近**（贴上沿或下沿都合格，`≤12px` + 水平对齐 + 完整可见），**不要**写死"必须在下方"——视口不足时翻上是正确行为（W13 U13 / W33 R9j） |
| 39 | **`:has()` 只查后代**：全屏契约（`.grid-fullscreen-detail` / `.dp-fullscreen-detail`）靠 `:has(.grid-wrap)` 判定"哪列是网格/详情"；把标记类（`.tree-max` / `.list-max` / `.dp`）**直接挂在容器子节点自身**时，`:has()` 匹配不到 ⇒ 全屏态下左右两列**同时被隐藏、整页空白**（2026-09-28 真事故：风险规则页 grid 态空白；同批发现结构页 ⤢ 树全屏也静默坏着）。反向事故也曾发生：复用既有类名 `.tree-panel`（需求页抽屉树的 196px 窄条）当标记类，把结构树压成 196px | 契约选择器**并列两个分支**：`:is(.grid-wrap,.tree-max,.list-max)`（挂自身）与 `:has(...)`（挂后代），见 §3.6 G-UI-7-9。新增标记类时：① 先 grep 全仓确认类名无既有语义（撞 `.tree-panel` 的亏）；② 两种挂法各做一次几何回归（全屏态下左栏宽 = 容器宽） |
| 40 | **`onCancelDraft` 清了选中但布局留在 dp 全屏态**：空态右栏不含 `.dp`、左栏被契约隐藏 ⇒ 整页空白不可操作（用户原话"点击取消后页面变为空详情面板"）。需求页等 8 处同病——它不缺取消按钮，缺的是**取消之后的归宿态** | 取消 = 清草稿 + 取消选中 + **回该页默认布局态**（`panelMax.showGrid()`；默认 split 的页用 `showSplit()`；本地 `dpFull` 页退出全屏）。已固化为 §5.3.4 新建三件套之第 2 件，新页面照抄 |
| 41 | **自绘表单页套用 `DetailPanel` 能力时漏改返回链**：上市后监督用自绘 `EditForm`（PUT 全字段 DTO，与 DetailPanel 乐观写路径不匹配，不套构件是有意裁定），补「保存&新建」时若沿用"保存函数 setMsg 就完"的写法，无法知道保存成败 ⇒ 新建表单会在保存失败时也被打开 | 自绘表单口径：保存函数**返回成功布尔**（接口成功 true / catch false），「保存&新建」= `if (await save()) { 重置新建表单; setShowNew(true); }`。见 §5.3.4 第 3 件 |
| 42 | **"深链认领"写成一个永久置位的 ref**：`ChangeDetailPage` 用 `deepLinkDone` 止住"列表自动选中首行覆盖深链目标"，但它**落地后永不复位**，且只在**路径式**分支（`/changes/<id>`）置位 ⇒ ① 查询式深链（`?obj=&code=`）不认领，列表仍会把目标抢成首行（W74 T1a/T1b 实测：地址栏已是 `code=ECO-2026-0378`，面板停在最新一条 `0488`）；② 改成"查询式也认领"后，又**永久**堵死"切到某对象页签时自动选中首行"的既有回落（W35 C13b 实测：面板只剩占位「变更详情」、无任何输入控件） | 认领要表达成**"URL 里的深链意图尚未了结"**，而不是"某个 ref 被置位"：`deepLinkIntent = 路径参数 或 (?obj=<本对象类型>&code=)`（**与对象类型绑定**，切页签即自然失效）；了结 = 目标已选中 / 明确找不到（单独的 `deepLinkFailed` ref 放行）/ 请求失败——后两者必须**放行**，否则会停在没有选中的空面板上。同族历史修过三次（V59c / L-715 / L-721），每次只堵了"路径式那一半" |
| 43 | **"中文化"之后判据还在比英文码集**：P3-5 批次把状态显示词中文化（`OPEN`→「已发起」），而断言仍写 `['OPEN','TRIAGED'].includes(显示文本)` ⇒ **恒假**，把正确行为判成缺陷（W35 的 C4b/C5a0/C6c/C8b2 四条红全部是这个根因） | 判状态**一律读码**：`data-raw-status`（网格 cellRenderer / ctx-bar）与 `data-raw-value`（`DetailPanel` 只读字段，`DetailPanel.tsx:653`）**两个锚点都要认**（只找前者会静默回落到显示文本，症状是"改了还是红"）。显示词只进证据串，用于人眼核对 |
| 44 | **只报"哪些码"不报"在哪"**：`T2 页面可见裸英文码` 只输出 `["APPROVED","CLOSED"]`，连续几轮靠猜；`C13b 面板控件=0` 不说**是哪条对象的哪个状态**，红了也不知道是"面板不该有控件"还是"选中了终态单" | 失败证据必须点名**位置**（DOM 路径 / 字段 label / 对象编号 + 状态码）。可用最小定位器：遍历文本节点命中关键词后回贴 4 层祖先 `tag[data-testid].class`（本轮据此一次定位到 `ccbResult` 只读字段与 `dp-extra` 的流转按钮，见 14 号报告 §11.5） |
| 45 | **改完前端直接打包部署 = 部署了旧包**：`deploy/wsl/plm-app/redeploy.sh` 自述 "runtime-only: copy prebuilt jar/dist"，**不会**替你 build 前端。症状是"改过的地方行为没变"，最容易被当成"改动无效"再改一遍 | 门禁顺序固定为 **`tsc` → `npm run build` → 打包/部署 → 走查回归**；"前端构建"这一项不是可选项。判据：部署后必须有一个**真实浏览器探针**证明新行为（本轮探针抓到校验文案仍是旧的 `<div class="msg">`，才定位到是旧包） |
| 46 | **"页面到达"用 `body.innerText.length > N` 判**：导航壳自己就有 **368** 字符 ⇒ 路由写错（`/registrations`、`/pv` 并不存在，正确是 `/registration`、`/postmarket`）也判 PASS，整套"五页可达"结论全是 vacuous pass | 到达判据锚在**该页自己的主容器**（`.page` / `[data-testid=…grid]`）上；断言失败时打印**按钮/锚点清单**定因（"按钮找不到"与"页面没渲染"是两回事——后者往往是我自己路由写错） |
| 47 | **无差别全量回归**：一次改动只触及一两个写路径，却把十几套件全部重跑——每套件 1~3 分钟，一轮白烧十几分钟，而且**红项越堆越多时人就不再看细节**（本轮 W23 的六条红与本批毫无关系，仍被打印出来与真回归混在一起） | 取舍顺序固定为：① **先精准增量**——按**读写路径**（不是模块名）选出"会被本次改动影响"的套件；② 每批**收尾做一次全量**作为阶段闸门；③ 已登记的既有红项在增量阶段**不再复跑**（它们不会因为无关改动变绿）；④ 改**契约**（如强制携带 `version`）时，把**旧客户端量具**同批更新——量具跟着红是预期，但要能被解释（见 14 号文 §17.4） |

---

## 10. 文件组织

```
frontend/src/
├── styles.css              # 全局样式 + 设计令牌 + App shell + 焦点环
├── pages/grid.css          # AG Grid 主题覆写 + 浮层 + 筛选面板
├── pages/RequirementsPage.tsx  # 业务页面（三栏 + 网格 + 详情）
├── components/DetailPanel.tsx  # 统一详情面板组件（kind:'lookup' = SearchPick 对象引用字段；_isNew 草稿态「创建」）
├── components/HistorySection.tsx # 处理记录公共构件（§5.4：键名中文标签 + 状态码映射 + 理由不截断 + 收起态摘要）
├── components/SearchPick.tsx   # 主业务对象检索选择面板（§6.2.1）
├── lib/lookup.ts               # SearchPick 数据层（lookup/search + resolve 契约端点，过渡期各域端点回退）
├── lib/apiError.ts             # 后端错误语义归一化（humanizeApiError，§6.5.3 末）
├── lib/download.ts             # 带凭据的文件下载（downloadWithAuth + Content-Disposition 文件名解析，§6.12）
├── hooks/useFlow.ts        # 流程引擎 Hook（YAML 驱动状态机 + roles 角色门过滤）
├── hooks/useSiblingNav.ts  # 详情面板「上一条/下一条」+ Alt+↑/↓（需求/文档/物料三页共用，§5.3）
├── lib/routes.ts           # 深链 ROUTE 单一事实源（全局搜索/工作台共用）
├── pages/WorkbenchPage.tsx # 工作台（跨域待办面板汇聚 + 行点击深链）
├── auth/oidc.ts            # OIDC 配置（PKCE + silent renew + User 存储键）
└── api/client.ts           # API 客户端 + 类型定义 + 身份适配（恒发 X-PLM-User + Bearer 双模式）

backend/src/main/
├── java/com/plm/platform/flow/
│   ├── FlowEngine.java         # YAML 加载 + 流程查询
│   ├── FlowDefinition.java     # 流程定义数据模型
│   └── FlowTaskService.java    # 任务分派 + 当前处理人派生（跨域通用）
├── java/com/plm/security/
│   ├── SecurityConfig.java     # PLM_AUTH_MODE 二选一（oidc/dev）
│   ├── JwtContextFilter.java   # JWT → AuthContext（oidc 模式）
│   └── DevAuthFilter.java      # X-PLM-User → AuthContext（dev 模式，oidc 下跳过）
├── java/com/plm/platform/metadata/
│   └── MetadataService.java    # 元数据查询 + 属性校验
├── java/com/plm/audit/
│   └── AuditService.java       # WORM 审计链 + findByObject 查询
└── resources/flows/
    ├── requirement-flow.yaml   # 需求审批流定义
    └── project-flow.yaml       # 项目生命周期定义
```

> 每个业务域页面复用 `DetailPanel` 组件 + `useFlow` Hook + `grid.css` 主题 + `styles.css` 令牌。新增页面只需定义 `cols` + `detailFields` + `load()`，视觉风格、流转按钮、状态下拉、可编辑性、处理记录全部自动统一。
