# 前端实现规格 · 交互模式（一）§6.1~§6.8

> 本文件是 `docs/plm-tech/08-前端实现规格.md`（索引）的子文件之一，承载**原 §6.1~6.8** 的正文。
> **章节编号保持原样**（保号）：原文档里的 `§5.4`、`§6.14` 等引用在本文件内一一对应，不必换算。
> 索引（含章节号 → 子文件映射表）：[`../08-前端实现规格.md`](../08-前端实现规格.md)。

---
## 6. 交互模式

### 6.1 禁止弹窗录入

**所有数据录入必须使用内联形态**：选择框（`<select>`）、输入框（`<input>`/`<textarea>`）、选择面板（展开带搜索的悬浮小面板）。**禁止 `window.prompt` / `window.confirm` / modal dialog**。

> **选择面板是强约定而非可选项**：凡主业务对象实例选择，必须使用 §6.2.1「主业务对象选择面板（SearchPick）」，不得退化为 `<select>` 或自由文本 ID（判据见 §6.2.1）。

### 6.2 搜索框

- 独立 `searchInput` 状态，**回车触发**搜索（`setKeyword` → useEffect → load），非每字触发。
- Esc 清空搜索框 + 触发搜索。
- placeholder 提示"回车触发"。

**顶栏全局搜索的检索域清单（2026-09-28 修订）**：下拉域 = 后端 `SearchService.DOMAINS` 的**镜像**
（`components/GlobalSearch.tsx` 的 `DOMAINS` 常量）——当前 7 域：物料 `ITM` / 产品 `PROD` / 变更 `ECO` /
项目 `PRJ` / 需求 `REQ` / 文档 `DOC`。**前端不得加后端索引里没有的域**（选中即无结果/潜在 500）；
新增域（候选：`REG` 注册证 / `RISK` 风险）是**后端依赖项**——须先在 `SearchIndexer` 加索引分支、
`SearchService.DOMAINS` 加值，前端再镜像。深链映射（`lib/routes.ts`）先行支持某域 ≠ 检索支持该域，
两件事分开判定。

### 6.2.1 主业务对象选择面板（SearchPick）

> 落地：REQ-2026-0788（「当前项目」选择器缺 PRJ-2026-0245/0087：单页 `pageSize:100` 预加载 + 无检索，100+1=101 选项、缺的恰好是最旧 2 条）+ 用户产品裁决「主业务对象选择一律用检索选择面板，不用简单下拉框」。组件：`components/SearchPick.tsx`；数据层：`lib/lookup.ts`。

**适用判据（强约定）**：满足下列**任一**条件即必须使用选择面板，禁止退化为 `<select>` 下拉框或自由文本 ID 输入——

1. 候选集合来自**数据库主业务对象**（项目/需求/文档/用户/物料/产品/BOM/任务书/评审/注册证/变更单/风险/路标/CBB）；
2. 候选条数**可能超过一屏或任何单页上限**（列表域上限 = 后端常量 `Paged.MAX_PAGE_SIZE` = 100，lookup 域 50；**以常量为唯一事实源，本文不复述数值**）；
3. 需要**按名称或编号检索**才能定位对象。

反例（允许 `<select>`）：枚举值（状态/类型/优先级）、布尔、个数有限且由元数据下发的值域（`enumValues`）。

**组件 Props 契约**：

| Prop | 类型 | 说明 |
|---|---|---|
| `objType` | string（必填） | 对象类型（列举：`PRJ REQ DOC ITM PROD USR CHT RVW REG ECO ECR RSK RDM CBB`；**2026-09-28 增补 `ISS` 遗留问题 / `BPL` 业务计划书 / `RA` 复用分析**）。**值域唯一事实源 = 后端 `LookupService.specs()`**，前端允许清单 = `lib/lookup.ts` 的 `VALID_TYPES`（现 **22 类**，必须与后端同批增补：不在清单里的类型会**跳过契约端点**，没有 legacy 适配器时表现为"一个候选都没有"） |
| `value` / `onChange` | `number \| string \| null`（单选）/ 数组（多选） | 受控值。**值域约定：默认数字 id；`USR` 等业务键为 login 的对象用 `code`**（`lib/lookup.ts` 的 `LOOKUP_VALUE_FIELD`） |
| `multiple` | boolean | 多选：已选项以 chip 呈现（`code · name` + ✕），按 id 去重 |
| `projectId` | number | 域内作用域（后端按 `project_id` 收窄的类型：`REQ`/`RSK`/`CHT`/`TASK`、`DOC`（经 product_id 反查）**及 2026-09-28 起的 `ISS`/`BPL`/`RA`**，其它类型忽略；两张派生视图显式选出 `project_id`，否则"选了项目反而候选变多/报错"） |
| `disabled` / `placeholder` | — | 禁用必须给 `title` 原因（§6.10.2）；占位文案必须说明检索维度（「按项目编号/名称检索」） |
| `onPickMeta` | `(o: LookupItem \| null) => void` | 选中/清除时回传完整对象元数据（父级需要 `code/name/extra` 时用，免二次请求） |
| `allowClear` / `clearLabel` | — | 允许清空（= 解除关联）；`clearLabel` 作为弹层首行清空选项（如「🌐 全部项目（不限项目）」「未纳入」） |
| `labelOf` / `valueLabel` | — | 自定义标签；`valueLabel` 直给已选标签（父级已有 code/name 时跳过回显请求） |
| `validatePick` | `(o) => Promise<string \| null>` | 选中前校验（返回错误文案=拒绝）。用于"候选全集可检索、业务约束选中时校验"（如 BOM 子件 BR-07 发布状态校验，与后端硬校验双保险） |
| `emptyHintAction` / `pageSize` / `debounceMs` / `width` | — | 空态下一步动作 / 每页条数（默认 20）/ 防抖毫秒（默认 280）/ 宽度 |

**交互规格**：

| 项 | 规格 |
|---|---|
| 触发控件 | 回显按钮（非 `<select>`）：左侧 `code · name`（**必须显示对象号，不得只显示 `#id`**），右侧 `▾`；`allowClear` 且有值时显示 `✕` 清除 |
| 弹层 | `position: fixed` 内联浮层（**不是 modal**，§6.1）；宽度 ≥360、`max-height: 60vh`、z-index 3000（同 AG Grid 浮层档）；Esc / 点击外部关闭，关闭后焦点回触发控件 |
| 输入即检索 | 打开即 autoFocus 并加载首页（q 空 = 最近更新前 N 条）；输入防抖 **250–300ms**（默认 280）；Enter 立即触发不等防抖；**请求序号守卫**丢弃过期响应；加载中保持旧结果可见（stale-while-revalidate） |
| 键盘/ARIA | 输入框 `role="combobox" aria-activedescendant`；列表 `role="listbox"`、项 `role="option" aria-selected`；**↑/↓ 移动、Home/End 首末、Enter 选中、Esc 两级（先清输入再关闭）**；多选已选项 Backspace 删末项 |
| 三态分离 | 空：「无匹配「q」——可改用编号/简称」+ `emptyHintAction` 下一步动作，**严禁空白面板**；加载：「检索中…」；错误：「检索失败（友好文案）· [重试]」——错误经 `humanizeApiError`（§6.5.3 末），**不得**把错误表现为"无结果" |
| **候选完整性显式化（硬要求）** | 底部计数条：有总数时「共 N 条 · 已加载 M 条」；无总数但可能被截断时「仅显示前 N 条，输入编号/名称缩小范围」；`pageSizeCapped=true` 时注明"已被服务端钳制"。**禁止静默截断**（"未取到"不得伪装成"不存在"） |
| 已选回显 | `value` 不在当前候选页时必须按 id 直取回显（`GET /_platform/lookup/resolve`，批量 ≤200 id）；取不到（已删除/无权）显示 `#id（已删除或无权访问）` + 允许清除，**不得静默清空**用户既有值 |
| **多选同样要回显（2026-11-11 增补，批次 63 实测缺陷）** | ⚠ 上述回显**无条件适用于 `multiple=true`**。曾实现为"多选时整段跳过回显、只有单选才取标签"，后果是**编辑既有记录时所有 chip 的名称都取不到**，界面显示 `（编号未取到）`，而**点开面板又能选对**——同一个控件两条路径两种结果。<br>**根因形态（须防复发）**：回显依赖"本次交互中拿到的 meta 缓存"，多选路径当时只在用户主动搜索/选中时写缓存，**没有在挂载时按已有 `value` 反查**。⇒ 规格按结果表述：**给定 `value` 就必须显示对应标签，与交互史无关**；判据必须覆盖"**冷启动直接编辑**"路径（新组件挂载、不做任何检索），只测"先搜再选"必然漏掉本缺陷 |
| 标签取不到时的降级 | 允许显示编号/占位文案，但**必须与"可清除"并存**——否则用户看到的不是失败，是"系统没这条数据" |
| 多选 chip | 按 id 去重；重复选择只提示不追加 |
| 分页/排序 | 服务端分页每页 **20**（上限 50，由后端钳制并置 `pageSizeCapped`，前端不做本地截断）；「加载更多」按钮；**稳定二级排序由服务端保证**（q 空=最近更新倒序；q 非空=编号精确命中优先，G-LST-5 A5 的选择器版）；不做浏览器端全量枚举 |

**数据来源规格**：

- **必须**走 `GET /api/v1/_platform/lookup/search?objType=&q=&page=&pageSize=[&projectId=]`；回显走 `GET /api/v1/_platform/lookup/resolve?objType=&ids=`。
- **禁止"预加载 `pageSize=100` 再本地过滤"反模式**（§9 陷阱 #25）：单页上限 100 + 部分域 `createdAt` 升序 ⇒ 丢掉的恰好是最新数据——全仓曾因此出现 101 vs 112 的选项缺失（REQ-2026-0788 主现场）与 11 处裸 `#id` 回显退化。
- 过渡期降级：端点未部署（404）或该 objType 未接入（400 `VALIDATION_ERROR`）时，`lib/lookup.ts` 自动回退各域既有 keyword 列表端点（`/projects?keyword=`、`/users/lookup?kw=` 等，注意参数名差异），会话级缓存探测结果、刷新重探。
- **`ISS`/`BPL`/`RA` 无 legacy 回退（2026-09-28 用户裁定"补 4 处后端能力缺口"）**：三类此前**只在后端缺登记**，前端各挂过一个 legacy 适配器（用列表端点 + 本地过滤），其中 `ISS` 的 `GET /open-issues` 一次最多 200 条且**无 total**、`BPL` 为裸数组无分页、`RA` 有分页但**不收 keyword**。后端 `LookupService.specs()` 同批登记这三类（含项目作用域与批量回显）后，**三个适配器已删除**，一律走契约端点（服务端 keyword 过滤 + 真实分页/total）。删除理由：留着就是同一能力的第二份实现——两者对"还有没有更多"给出不同答案，而**差别不报错**。
- 由此得一条硬约束：**`VALID_TYPES` 必须与后端 `specs()` 同源**（增补/撤下同批做）。前端多登记一个后端没有的类型，会让请求收到 400 `VALIDATION_ERROR` 并被当成"端点不可用"⇒ **会话级**探测结果被打成 false ⇒ 全站选择器/回显静默退回 legacy（"合法界面 + 错误结论"，§9 陷阱 #25 同族）。
- 三类新增在面板上显示什么，由后端 `specs()` 决定、前端只渲染（**不在前端二次加工**）：`ISS` = `issue_code` / `description` 截断 60 字加 `…` / `status`；`BPL` = `plan_code` / `title` 同截断 / 归属项目编号 `prj_code`；`RA` = `analysis_code` / `conclusion` 同截断 / `t_gate_map` 的**门点中文名** + ` · ` + 项目编号（不显示裸门码）。长文本一律**截断并自述**——`…` 表示"还有更多，去详情看"，不得静默切掉。
- 权限过滤由后端负责（与各域列表页同源）；前端只渲染后端返回，不做权限判断。

**性能与可达性**：输入→首屏结果 P95 ≤ 400ms（含防抖）；弹层 DOM ≤ 200 节点（20 条/页，无需虚拟滚动）；焦点环走 §1.2 全局 `:focus` 虚线规则（**不用** `:focus-visible`，见 §9 陷阱 #9）；Tab 序 = 触发控件 → 弹层输入 → 计数条按钮。

**与既有约束的关系**：§6.1 禁 modal → 面板是内联浮层（符合）；§6.4 RTM 追溯由"类型下拉 + 自由文本 ID"升级为"类型选择 + 对象面板"（`ITEM_REV→ITM`、`DOC_REV→DOC`、`RISK_CTRL→RSK`，`TEST_CASE` 待后端补对象类型后收口）——自此假编号无法落库（REQ-2026-0782 界面来源消除）；`DetailPanel` 字段 schema 新增 `kind:'lookup'`（配 `lookup:{objType,…}`），所有对象引用字段经此一次覆盖。

**迁移清单**（2026-09-12 首批）：需求页「当前项目」+ 详情面板「所属项目」（REQ-2026-0788）、需求 RTM 追溯目标、BOM 编辑器根物料/子件（含 validatePick 业务校验）、物料库「当前产品」、文档页「关联产品」+ DHF 扫描产品、产品结构页产品选择、注册页「关联产品」+ 申报骨架组装器产品、风险台账产品筛选、项目页「关联产品」+「项目经理」（USR）。**已替换（2026-09-22 本批）**：ChangeDetailPage **ECO↔ECR 关联**——由只读字段升级为检索面板（`SearchPick objType="ECR"`，可清空），保存走 `PUT /ecos/{id} {ecrId}`（挂上即把该 ECR 置 `TO_ECO`；已 `TO_ECO`/`CLOSED`/`CANCELLED` 的再挂被拒 `ECR_NOT_LINKABLE`），见 `docs/plm-tech/23-变更域三单据与工作台设计.md` §3.2。**待替换**：治理台特权操作对象输入（D-1，自由文本喂特权操作，须先上报裁定）、OfferingsPage 产品包行内引用、WorkbenchPage 改派处理人、`TEST_CASE` 追溯目标（待后端对象类型）。

**可选的「优先项置顶」`rankFirst`（2026-09-14，S25）**：`rankFirst?: (o: LookupItem) => boolean` —— **只改变排列，不改变候选集合**（稳定分区：满足谓词的在前后其余在后；计数行显示「优先项已置顶（未过滤任何候选）」）。

- **为什么不做成过滤器**：候选被过滤掉＝把一条业务规则**藏进选择器**；若该规则在后端并不成立，界面就会"看起来有规则、实际没有"。BOM 编辑器根物料正是这个反例——曾按类型拒绝非整机/软件项，而既有多层 BOM 里合法的中间装配件（电子件/结构件）因此**无法从下拉打开**，只能靠深链。
- **当前用途**：BOM 编辑器根物料选择器（`rankFirst = extra ∈ {整机, 软件项}`，配合类型徽标与提示文案）。
- **子件选择器保持 `validatePick`（BR-07「正式结构只允许已发布子件」）**：那是**写路径判据**（后端 `BomService.add` 同样硬校验），界面拒绝是"把错误提前说清"，与上面的"视图入口约定"性质不同，不得混为一谈。

### 6.3 日期范围查询

- 两个 `<input type="date">` + `~` 分隔符，精确到天。
- 后端 `LocalDate` → `OffsetDateTime`（from=当天 00:00 UTC，to=次日 00:00 UTC，`<` 含当天全天）。
- JPQL 用 `CAST(:param AS timestamp) IS NULL` 避免 PostgreSQL NULL 参数类型推断错误。

### 6.3.1 最近更新（所有对象统一）

- **所有业务对象列表**（需求/物料/项目/变更/产品）展示 **最近更新** 列（`updatedAt`，`valueFormatter` 成日期，`cellClass: muted`）。
- **所有对象详情面板**展示 **最近更新** 只读字段。
- **所有对象列表支持按更新起止时间搜索**：`updatedFrom`/`updatedTo`（§6.3 日期范围查询），后端 `GET /{domain}?updatedFrom=&updatedTo=`（item/project/eco 与 requirement 同构：`LocalDate` → `OffsetDateTime` UTC 整天）。
- `updatedAt` 由 DB 自动维护（`updated_at` 列，`insertable=false, updatable=false`），前端只读，不参与编辑。

#### 6.3.1.1 合规时限台账视图（2026-09-17 批次26 · 投诉台账基准实例）

> 编号说明：本小节紧跟 §6.3.1（列表时间查询族），故挂在 6.3.1 之下；它管的是"**列表口径**（默认排序/筛选/列上警示）"，
> 与 §6.3.1 的"最近更新"同属"列表时间维度"的规格，故不另起 §6.3.x 顶层编号（避免与 §6.3.2 之后的内容错序）。

**背景**：投诉台账的排序口径与产品级规格 G-LST"所有列表默认 `createdAt DESC + id DESC`（最新在前）"**冲突**——
投诉/不良事件有**外部法规上报时限**（用户裁定 2026-09-17："这个对象有外部合规强制性，上报时限优先级更高"）。
处理方式不是悄悄改默认，而是**把例外显式登记**（见 doc 12 §3 例外条款），并且**把警示落在台账列上**。

| 元素 | 规格 |
|---|---|
| 默认排序 | `sort=DEADLINE_ASC`：`ORDER BY (status IN ('CLOSED','REJECTED')) ASC, reportable_deadline ASC NULLS LAST, id DESC`——① **未处理在前**（未关闭/未排除）② 上报时限升序（**超期的时限最早 ⇒ 自然排在最前**，无需单独的"超期优先"分支）③ id 决胜 |
| 排序可切换 | 下拉「排序：上报时限升序 / 最新在前」（允许使用者退回通用口径）；**后端默认仍是 `LATEST`**（既有调用方与既有判据零破坏），新口径由前端显式请求 |
| 上报时限区间 | `deadlineFrom`/`deadlineTo`（含端点）；与 §6.3 的日期区间同构 |
| 处理口径 | `deadlineScope`：`UNPROCESSED`（未关闭且未排除，默认）/ `OVERDUE`（时限已过且未了结）/ `DUE_SOON`（剩余 ≤7 天且未了结，阈值与既有「时限提醒」的 `--warn` 同源） |
| 非法取值 | 未知 `sort`/`deadlineScope` → **400 并列出可选值**（fail-closed；禁止静默回落成默认口径） |
| 列上警示 | 「上报时限」列：未了结且超期 → `yyyy/MM/dd · 超期N天`（`--err` 粗体）；未了结且剩余 ≤7 天 → `yyyy/MM/dd · 剩N天`（`--warn`）；已了结 → 灰色日期（不再警示） |
| 口径可见 | 工具栏常显「按上报时限升序命中 N 条 · 仅未处理 · 上报时限 from~to」+「清空条件」出口（V-202/V-177：成功判据必须有内容、空态必须写明口径） |
| 与"去掉时限提醒卡片"的关系 | 独立的「⏰ 不良事件上报时限提醒」表格已按用户裁定**去掉**——其信息（超期/临期/编号/时限）**全部并入台账**：列上标记 + 默认排序 + 处理口径筛选。**警示力不能随时间限表格一起消失**，这是本节的硬要求 |

实现：后端 `PvService.complaints`（`deadlineFrom/deadlineTo/deadlineScope/sort`），前端 `PostMarketPage`（工具栏 + `reportableDeadline` 列渲染器）。
判据：`plm-b26-opt-api.cjs` A1~A5（服务端口径，CI **T3-6**）+ `plm-b26-console.cjs` P3/P3b/P4a~P4d/P5（页面与几何，CI **W23**）。

**列表排序与分页（G-LST，2026-09-10 V59c 起，所有对象统一）**：列表默认排序 **`createdAt DESC + id DESC`（最新在前）**；工具栏必须渲染「共 N 个对象 · 第 x/y 页 ＋ 上一页/下一页」分页 UI（只有分页参数没有 UI ＝ 半成品缺陷）；创建成功后跳回第 1 页（新对象＝第 1 行）；`?open=<id>` 深链在对象不在当前页窗口时按 id 直取详情回退加载。产品级规格与各域迁移清单见 **`12-产品级通用规格-评审机制与列表范式.md` §3（G-LST-1~5）**；项目域为基准实例（`ProjectsPage.tsx`：PAGE_SIZE=100、创建后 `setPageNo(0)+load(0)`、openId 回退）。
**需求域迁移（2026-09-11，迁移清单先行第一域）**：`RequirementService.list` 排序改 DESC+id 决胜；`RequirementsPage.tsx` 补 pageNo/total/PAGE_SIZE ＋ 工具栏「共 N 条需求 · 第 x/y 页（最新在前）」翻页块 ＋ 搜索回车/清空回第 1 页 ＋ 筛选后页码越界自愈（total>0 且本页空 → 回第 1 页）；创建成功＝**乐观插入当前列表头部 ＋ 复位排除性筛选 ＋ effect 重拉校正**——需求域变体缺陷：**「处理人=我」默认筛选会排除未分派的新需求**（新需求 assignee=null，项目域无此筛选故 V59c 未暴露），仅 `setPageNo(0)+load(0)` 不够，必须同时复位会排除新对象的筛选；编辑成功＝行就地刷新（不整表重拉，rtm 按当前页重算）。验证 `plm-req-glst-e2e.cjs`（A1/A2a-c/A3/A4/A5a-b）+ `plm-req-glst-ui-verify.cjs`（S1-S5b）全绿。**AG Grid 断言教训**：虚拟化下 DOM 首个 `.ag-row` ≠ 列表第 1 行，行定位必须用 `[row-index="0"]`。

**文档域 + 物料域迁移（2026-09-14，S25）**：两域此前**只有分页参数、没有分页 UI**（`pageSize: 100` 写死在第 1 页 ⇒ 用户不可能看到第 101 条），且排序与规格相反：

| 域 | 迁移前排序（实测） | 迁移后 |
| --- | --- | --- |
| 物料 `/items` | `Sort.by("createdAt")`（**升序**） | `createdAt DESC, id DESC`（`ItemService.list`） |
| 文档 `/documents` | `Sort.by("id")`（**升序**） | `createdOn DESC, id DESC`（`DocumentService.list`） |

升序口径下「创建成功＝第 1 页第 1 行可见」**结构性不成立**（新对象只会落在最后一页）；今天 `pageSize=100` 的"巧合"把它盖住了（233 个物料里最老的 100 个在前）。两页同时补齐：工具栏「共 N 个… 第 x/y 页（最新在前）」+ 上一页/下一页、搜索回车/清空回第 1 页、筛选/作用域变化回第 1 页、页码越界自愈、创建后 `setPageNo(0)+load(0)`、`?open=` 深链**不在当前页时按 id 直取**（此前文档/物料两页缺此回退，加分页后会变成"跳过来看不到"）。

**物料库「结构内物料」作用域（D-10，同一批）**：原实现是"拉 BOM 树得 id 集合 → 过滤已加载行"，加分页即退化为"**本页**结构内物料"且 `total` 不再真值。改为服务端参数 `GET /items?inBomOf=<rootItemId>[&bomView=]`——语义是**结构成员集合**（载体 `t_bom_line` 的装配关联），**不是物料归属**（物料是共享主数据，可同时出现在多个产品结构中；故参数名不叫 `productId`）。服务端复用 `BomService.structureItemIds` 展开，与结构树同一条关系 ⇒ 「结构内物料」只有一个事实源。**两处硬约束**：① 空集合必须由调用方换哨兵值——"结构为空"的语义是 0 行，绝不能被读成"不过滤"；② 无结构根的产品是**显式空态**（页面提示"该产品暂无结构根"，不是回落全量）。验证 `ItemStructureScopeTest`（7 例，含"叶子作用域恰好 1 行"这条防"过滤被静默丢弃"的关键断言）。

### 6.3.2 元数据扩展属性（项目/变更/产品，对齐 物料）

- 项目/变更/产品 与 物料 一致：在 `t_attr_template` 插一行即「配置即加列/字段，零部署」（09 §2.8）。
- 扩展属性存 `attrs` JSONB（列由 V11 项目/变更、V13 产品 添加）；`Create/Update` DTO 增 `attrs`；`save` 时前端将「核心字段 vs 扩展属性(attrs)」分流，扩展属性合并进 `attrs` 整提。
- 网格列/详情字段由 `/metadata/columns?objType=PRJ|ECO|PROD` 非核心属性动态追加；网格扩展列用 `valueGetter/valueSetter` 读写 `row.attrs[code]`。
- **产品结构页（B38）**：产品主档（`/api/v1/products`）走 05 州流程（`product-flow.yaml`，`useFlow('product')` 驱动「推进」）+ 元数据扩展（PROD attrs）+ `root_item_id`（结构根整机）；「＋ 新建产品」创建产品头并自动生成整机结构根；五视图（EBOM/PBOM/MBOM/REGBOM/SBOM）切换渲染，注册视图按 关键件✚/患者接触⚕/注册载明◉ 高亮语义（见 02 §5.2.1）。

### 6.4 RTM 追溯链（对象面板形态，2026-09-12 升级）

- 内联表单：`<select>` 目标类型 + **SearchPick 对象检索面板**（§6.2.1）+ `<select>` 方向 + `＋` 添加按钮。
  - 类型→对象映射：`ITEM_REV→ITM`、`DOC_REV→DOC`、`RISK_CTRL→RSK`；`TEST_CASE` 后端暂无对象类型，暂保留文本输入（多 ID 逗号分隔），待后端补齐后收口。
  - **2026-09-12 起**：追溯目标只能经面板选真实对象——自由文本数字 ID 是 REQ-2026-0782"假 reqCode/假 id 可落库"的界面来源，已废止。
- 每条追溯右侧 `－` 删除按钮。
- 添加前用 `Set` 去重，避免 unique constraint 冲突。
- 按钮用 `＋` / `－` 符号，不用文字。

### 6.5 状态机驱动（useFlow + YAML）

#### 6.5.1 架构

```
resources/flows/{flowId}-flow.yaml（流程定义）
  ↓ @PostConstruct 加载
FlowEngine（后端平台服务）
  ↓ GET /api/v1/_platform/flows/{flowId}
useFlow(flowId)（前端 Hook）
  ↓ 驱动
状态下拉 + 流转按钮 + 可编辑性 + 状态色彩
```

> 详细设计见 `09-工作流引擎与元数据扩展设计.md`。

#### 6.5.2 前端接入

```tsx
// V45：流转按钮显隐 = 组织角色 ∪ 当前上下文项目成员角色（两级角色；后端边级角色门权威兜底）
const [myRoles, setMyRoles] = useState<string[]>([]);
const [projectRoles, setProjectRoles] = useState<string[]>([]);
useEffect(() => { api.get<{roles:string[]}>('/_platform/permission/me').then(r => setMyRoles(r.data.roles||[])); }, []);
useEffect(() => {   // 上下文项目变化（选中对象所属项目优先，回落 ctx 当前项目）→ 拉项目成员角色
  const pid = selected?.projectId ?? projects.find(p => p.prjCode === curProject)?.id ?? null;
  if (pid == null) { setProjectRoles([]); return; }
  api.get<Array<{login:string; roleCode:string}>>(`/projects/${pid}/members`)
    .then(r => setProjectRoles((r.data||[]).filter(m => m.login === currentUser()).map(m => m.roleCode)));
}, [selected?.projectId, curProject, projects]);
const effRoles = useMemo(() => [...new Set([...myRoles, ...projectRoles])], [myRoles, projectRoles]);
const { states: STATUSES, visibleTransitions: nextTransitions,
        editableStatuses: flowEditable } = useFlow('requirement', effRoles);
```

| 驱动目标 | 代码 | 说明 |
|---|---|---|
| 状态下拉 | `STATUSES.map(s => <option>{s}</option>)` | 状态值从 YAML `states` keys 驱动 |
| 流转按钮 | `nextTransitions(selected.status).map(a => <button>{a.label} → {stateLabel(a.to)}</button>)` | 从 YAML `transitions` 过滤 `from === 当前状态`；**目标态必须走 `stateLabel` 翻成显示词**——直接渲染 `a.to` 会把 `APPROVED`/`CLOSED` 这类裸码送上屏（W74 T2 实测，见 §6.5.5 末条） |
| 可编辑性 | `<DetailPanel editableStatuses={flowEditable} />` | 从 YAML `editableStatuses` 驱动，批准后锁定 |
| 回退边 | `a.rework === true` 时按钮无 `.btn.primary`，点击弹出内联原因输入 | 从 YAML `transitions[].rework` 驱动 |

#### 6.5.3 流转/回退交互

- **正向流转**：按钮 `.btn.primary` 样式，点击直接 `POST /{id}/transition { to }`。
- **回退边**（`rework: true`）：按钮无 `.btn.primary`，点击后显示**内联黄色提示框**（`#fef3c7` 底，`1px solid #fbbf24` 边框）：
  ```
  ┌──────────────────────────────────────┐
  │ 回退到 PROPOSED，请填写原因：            │
  │ [输入框________________] [确认回退] [取消] │
  └──────────────────────────────────────┘
  ```
  - 输入框 Enter 触发确认。
  - 后端校验 `reason` 非空（`FlowEngine.isRework()` 判定）。
  - 取消按钮清空 `reworkTo` + `reworkReason` 状态。
- **破坏性流转**（REQ-2026-0787，目标态 ∈ `OBSOLETE/TERMINATE/REJECTED/CANCELLED`）：必须**内联确认 + 必填理由**（红色系提示框，复用回退边范式，禁 `window.confirm`）——不可逆动作不能比"回退"还轻。
- **草稿行守卫**（REQ-2026-0787）：`_isNew` 本地草稿行**不得渲染流转动作**（临时 id `new-…` 直发后端只会 400）；显示"未保存的草稿：请先「创建」后再流转"。
- **后端错误不得直出界面**（REQ-2026-0787）：所有 `catch` 上屏文案必须经 `lib/apiError.ts` 的 `humanizeApiError(e, fallback)` 归一化——Spring/Java 异常原文（类型转换失败/约束/SQL）降级为 `fallback（code）[HTTP status]`，原文只打 console；axios 全局拦截器 toast 同此出口。业务语义化文案（后端已给中文 message）原样透传。

#### 6.5.4 状态→色彩映射

状态色彩从 YAML `states.*.color` 驱动，映射到 §1.1 设计令牌：

| YAML color 值 | 令牌 | 用途 |
|---|---|---|
| `primary` | `--primary` `#2563eb` | 提案/立项 |
| `warn` | `--warn` `#d97706` | 分析/开发 |
| `ok` | `--ok` `#16a34a` | 批准/上市 |
| `med` | `--med` `#0d9488` | 验证/注册 |
| `muted` | `--text-muted` `#64748b` | 关闭/退市 |
| `err` | `--err` `#dc2626` | 失败 |
| `info` | `--info` `#0ea5e9` | 信息 |
| `ai` | `--ai` `#8b5cf6` | AI/智能 |

#### 6.5.5 边级角色门的**本批口径**：不设（用户裁定 Q-b，2026-10-02）

> **裁定原文（用户，2026-10-02）**：其余按报告建议 —— **Q-b 口径化**。
> 背景见 `docs/plm-design/14-UI设计走查-变更CBB上市后注册产品包风险治理台.md`（Q-b 原题与证据）。

| 项 | 口径 |
|---|---|
| **本批 11 个流程不设边级 `roles`** | 变更/注册/产品包/CBB/复用分析/上市后/风险台账/风险规则/业务计划/治理台/评审门/遗留问题/管线生命周期这些域的 YAML **不声明** `transitions[].roles`，**仅域级 RBAC**（权限点 + 后端业务校验）。**这是裁定，不是疏漏**——后人看到"别处有 `roles` 这里没有"不得当成待补项 |
| 唯一例外 | **`offering-flow.yaml`**（产品包）**声明了边级 `roles`**，故其前端必须用 `useFlow(flowId, effRoles).visibleTransitions` 消费该声明——"YAML 有门、前端不管"是错配（评审条目 S1 已按 `ItemLibraryPage.tsx:154-155` 范式修） |
| 判据（门禁化） | ① 源码面：本批页面**不得**出现自造的边级角色判断（硬编码角色码清单）；② 契约面：`plm-edge-role-integrity.sh` 的"YAML ↔ Java 对账"**扩展**为"YAML 声明 ↔ 前端 `visibleTransitions` 消费"——凡 YAML 声明了 `roles` 的流程，其页面必须把 `visibleTransitions` 接到按钮渲染上（否则红） |
| 与 §6.5.2 的关系 | `useFlow(flowId, effRoles)` 的两级角色**照旧**（组织角色 ∪ 项目成员角色），它只对**声明了 `roles` 的边**起过滤作用；未声明 `roles` 的边对所有人可见，真正的拦截在后端 |

**同节连带订正（2026-10-02）**：§6.5.2 表里的流转按钮样例原写作 `{a.label} → {a.to}` ——
**这段文档本身在教一个缺陷**：`a.to` 是流程码（`APPROVED`/`CLOSED`），直接上屏就是裸英文码。
W74 的 T2 正是实测到这一类（ECO/ECR/ECN 三域的流转按钮与只读面板都漏了显示词）。
现样例改为 `stateLabel(a.to)`，并列出**三个必须走显示词的落点**（少一个都会被 T2 判红）：
① 流转/回退按钮文案里的目标态；② `DetailPanel` 只读枚举字段（用 `readonlyLabel`，见 `RiskLedgerPage` 样板）；
③ 按钮 `title` 里的 `from → to`。

### 6.6 元数据驱动列（t_attr_template）

#### 6.6.1 架构

```
t_attr_template（DB 属性模板）
  ↓ MetadataService.columnDefs(objType)
GET /api/v1/_platform/metadata/columns?objType=REQ
  ↓ 前端拉取
AG Grid cols 动态生成 + DetailPanel fields 动态生成
```

> 详细设计见 `09-工作流引擎与元数据扩展设计.md` §2。

#### 6.6.2 列定义下发格式

```json
[
  { "code": "reqCode", "label": "需求编号", "kind": "STRING", "editable": true, "enumValues": null },
  { "code": "reqType", "label": "类型", "kind": "ENUM", "editable": true, "enumValues": ["UR","SR","REG","RC"] }
]
```

#### 6.6.3 kind → 前端映射

| `t_attr_template.kind` | AG Grid 编辑器 | DetailField.kind | DetailPanel 控件 |
|---|---|---|---|
| `STRING` | agTextCellEditor | `text` | `<input type="text">` |
| `NUMBER` | agNumberCellEditor | `number` | `<input type="number">` |
| `ENUM` | agSelectCellEditor | `select` | `<select>`（`enumValues` 填充） |
| `DATE` | agDateCellEditor | `date` | `<input type="date">` |
| `BOOLEAN` | agSelectCellEditor | `select` | `<select>`（true/false） |
| `REF` | agSelectCellEditor | `select` | `<select>`（关联对象列表） |
| `JSONB` | textarea | `longtext` | `<textarea>` |

#### 6.6.4 接入策略

- **核心字段**（reqCode/title/status 等有自定义 `valueFormatter` 的）保留硬编码，确保关联列名映射、编号前缀等格式化逻辑。
- **扩展属性**（`is_grid_col=TRUE` 且非核心的）从 `/metadata/columns` 动态追加到 `cols` 末尾 + `detailFields` 末尾。
- **新增属性** = 在 `t_attr_template` 插一行 → 前端自动多出列+字段（零发布）。
- **写入校验**：后端 `MetadataService.validateAttr(objType, attrCode, value)` 校验 ENUM 值合法性。

#### 6.6.5 可编辑性联动

可编辑性由两层共同决定：

```
是否可编辑 = FlowEngine.isEditable(flowId, status)   ← 流程状态锁定（YAML editableStatuses）
          AND t_attr_template.is_editable             ← 属性级锁定（DB 列）
```

- `useFlow(flowId).editableStatuses` → DetailPanel `editableStatuses` prop → 状态不在集合时整面板锁定。
- `t_attr_template.is_editable = FALSE` 的字段（如编号、状态、创建人）在 DetailPanel 中 `readonly: true`，任何状态都不可编辑。

### 6.7 工作台（跨域汇聚）

> ⚠ **本节已由 `docs/plm-tech/24-工作台设计-面向人的个人工作汇聚.md` 升级**（2026-09-25，用户裁定 D-Q1~Q6 / D-C1~C5）。
> **权威口径以 24 号文为准**；以下面板形态保留，供理解沿革与回归对照。
> **已变更的三处（实现时必须按新口径）**：
> 1. **行点击不再是"同页跳转"** —— 改为**行内展开「行详情条」** + 条内 `ObjLink`（新标签页真链接）。这本是 G-UI-7-2（§3.6）早已要求的形态（"点开后当前页 URL、选中对象、未保存草稿一字不变"）；此前工作台用了 `nav()` 同页跳转，属**未兑现既有规格**。
> 2. **面板墙 → 三区 + 页签**：`我的看板 / 我的任务（五视图）/ 我的流程（五视图）/ 我关注的`。按 `object_type` 切九宫格是"密密麻麻"的结构性来源，故域维度改由看板分布图表达、并在列表里降级为筛选项。
> 3. **列表必须分页**：`GET /_platform/tasks/my` 无分页无筛选（后端 SQL 无 LIMIT），实测单面板 76 项；新端点 `/_me/tasks` 返回标准分页对象，按 G-LST-2 必须渲染分页 UI。

**升级前的形态**：`/` 路由 = 工作台（侧栏"工作台"）。**每个业务对象的待处理事项以面板方式汇聚**——新域接入流程引擎后其待办自动出现，无需改工作台代码（`OBJ_LABEL` 注册即点亮）。

```
┌─ 工作台 ───────────────────────────────────────┐
│ page-head：工作台 + 当前用户角色徽章              │
│ ┌─ 需求待办 ────────┐ ┌─ 项目待办 ──────────┐ │
│ │ [批准]📎REQ-...   │ │ 暂无待办            │ │
│ │ [认领] / 处理中    │ ├─ 文档/物料/产品 ────┤ │
│ └───────────────────┘ └────────────────────┘ │
└────────────────────────────────────────────── ┘
```

| 元素 | 规格 |
|---|---|
| 面板 | 按 `object_type` 分组（`groups[t.objectType] ||= []`）；标题 = `OBJ_LABEL[ot] + 待办`；右侧 `{第 N } 项`。**批次26（用户裁定①）：只渲染"真的有任务"的域**——不再预置 `PLANNED_PANELS` 占位；此前「项目/文档/产品待办」三个空卡片常年显示"暂无待办"（库里从来没有 DOC/PROD 任务），既占版面又像"功能坏了"。一个域都没有时给一行空态说明；新域接入后仍会自动点亮（`Object.keys(groups)` 驱动，不需要白名单） |
| 数据源 | `GET /_platform/tasks/my`（`enrich` 已联对象表取 code/title + overdue 标记）。**批次26 起 RVW 额外带 `projectId`/`gateCode`**（见"行点击"行） |
| 行 | 待办动作 pill（目标状态色）/ 📎 code / title / **项 M#/R#**（RVW 项级派发）/ 时限（逾期红标置顶）/ `认领` / `xx 处理中` / `指派:xx` |
| 行点击 | `nav(deepLink(objectType, objectId, ctx))`——**复用全局搜索深链**（`lib/routes.ts` 单一事实源）；**RVW 的落地页不是 `?open=<id>`**：`/projects/{projectId}/gates/{gateCode}`（评审门工作台），无 `projectId` 时该行**显式报"缺项目关联"并保持不可点**（不猜） |
| **待办有效性口径**（2026-09-17 批次26） | 用户反馈"处理了的要从待办消失、超 3 个月的自动归档" ⇒ `FlowTaskService.archiveStale()`：① 对象已越过（REQ/PRJ 的**对象状态 ≠ 待办 `from_state`**；RVW **评审已定论**）→ `CANCELLED` + `done_by='system:stale'`；② `created_on` 早于 **90 天** → `CANCELLED` + `done_by='system:archived'`。**不删行**（"从面板消失"≠"从账上消失"）。触发点：plm-service 启动时 + 每日 03:23 定时 + `POST /_platform/tasks/archive-stale`（仅 `_admin/manage`） |
| **归档交代行**（同上） | 面板底部一行：`已自动归档 N 项（对象已处理或超 90 天未处理，仅统计近 30 天）`，数据源 `GET /_platform/tasks/archived-summary`——**"消失"必须有交代**，不允许无声丢弃 |
| **决策点待办**（同批） | `OBJ_LABEL.RVW = '决策点'`（RVW=Review 缩写，界面语义＝门评审记录 DCP/TR）。修前 `ROUTE` 无 RVW ⇒ `deepLink` 兜底 `/items?open=<t_review.id>`：点决策点待办会**落到物料库并定位到一个毫不相关的物料**（比不跳更坏） |
| 认领按钮 | 仅 CANDIDATE+OPEN 显示；`onClick` 必须 `stopPropagation()`（不干扰行点击跳转）；**可见性由服务端权威判定**（`myTasks` 已按 组织角色∪项目角色∪项目PM 过滤——返回的待办即当前用户可认领，含项目角色候选池 prj_sa/prj_dev/prj_qa；后端 `claim` 权威校验，前端**不再**按 `myRoles 含 candidateRole` 重复判定——此前项目角色用户看不到认领按钮，V45 修订） |
| **指派按钮**（2026-09-09） | 仅 `task.canAssign === true` 显示（后端判定：admin / pdt_manager / 对象所属项目 PM）；点击后在**行内展开 `<select>` 候选人下拉 + 确认/取消**（禁弹窗录入 §6.1），候选人来自 `GET /_platform/tasks/{id}/assignees`（项目成员优先，回退该任务 candidateRole 的组织角色用户）；提交 `POST /_platform/tasks/{id}/assign` → 刷新列表 + 顶部提示 |
| **推进按钮**（2026-09-09） | 显示为待办动作（`task.label`，如"批准"/"确定方案"）；点击直接调业务对象 transition 端点（REQ → `POST /requirements/{id}/transition` `{to,reason}`）**无需跳页、无需改需求内容**；**前置条件预判**：迁移边 `requires` 未满足时按钮 `disabled` + `title="请先填写<label>后再推进"`，后端 `FIELD_REQUIRED` 权威失败时在面板顶部提示区展示 message（不 alert） |

**交互原则**（2026-09-09 修订）：面板呈现待办清单 + **轻量动作行内完成**（`认领`/`指派`/`推进`——均为"接单/派单/推进"这类不改对象内容的动作）；**涉及内容编辑的操作仍跳转业务页**（详情面板统一保存）。

**面板布局**：`.bench-grid` 一行**固定两个面板**（`repeat(2, minmax(0,1fr))`，面板加宽便于阅读需求标题字段；`@media max-width:1000px` 降级单列）。

### 6.8 当前处理人筛选与字段（跨域通用）

**当前处理人 = `claimed_by ?? assignee`**（来自 `t_flow_task`，无冗余列，状态机事实源实时派生；CANDIDATE 待认领 → 空="待认领"）。

| UI 处 | 规格 |
|---|---|
| **toolbar 筛选** | "当前处理人"下拉（`GET /users/lookup` 用户库选项），**默认 = 全部**（REQ-2026-0785：原默认=当前登录用户对名下无该域对象的专业角色结构性恒空，如风险角色 rc1 看需求列表必为 0 条）；切到本人显示本人 |
| **表格列** | `{ field: 'currentAssignee', headerName: '当前处理人', width: 110, filter: false, valueFormatter: p => p.value ? p.value : '待认领', cellStyle: p => ({ color: p.value ? '#475569' : '#94a3b8' }) }`——`filter:false` 因筛选走 toolbar 下拉而非列过滤器 |
| **详情字段** | `{ code: 'currentAssignee', label: '当前处理人', kind: 'tel', readonly: true }`（只读展示） |
| **流转后保留对象** | `transition()`/`doRework()` 成功后 `setSelected(r.data)`（transition API 返回更新后对象）——**保留显示原对象**并刷新版本/状态/处理人；**禁止 `setSelected(null)`** |
| **过滤条件持久化** | 过滤条件（reqType/status/keyword/selClass/curProjectId/curProjMeta/updatedFrom/updatedTo/assignee）**变化即写** `localStorage['plm_req_filters:<user>']`（按用户隔离）；**重新进入页面默认恢复上一次离开时的条件**；旧键 `curProject`（prjCode）一次性迁移为 id（解析不了即放弃作用域） |
| **当前项目（ctx-bar）** | **SearchPick 检索选择面板**（§6.2.1，REQ-2026-0788：替代 `pageSize:100` 预加载 `<select>`）；**不再自动选中首项目**（REQ-2026-0785：自动选中的首项目若恰为无需求项目，会把专业角色列表结构性清空）；**跳转进入（?open=）时清空**；「全部需求」树节点 = 分类+项目作用域双清 |
| **空态解释（REQ-2026-0785）** | 网格 `noRowsOverlayComponent`（ag-grid 32.3.9 旧名，v33 才改名 `overlayNoRowsComponent`）必须**显示当前生效作用域**（项目/处理人/关键字）并给出**可点的"清空全部筛选"操作**——空列表 = 筛选结果为空（不是无权限），用户必须能一键自救 |
| **跳转优先** | URL 带 `?open=<id>`（工作台/智能搜索深链）进入时**不恢复持久化**，按跳转逻辑填充：对象定位（openId 自动选中），其余条件与当前项目**清空**（处理人必须为"全部"——目标需求的处理人若不是本人会被过滤掉） |

#### 6.8.1 空详情面板动作口径：提示语指引，不放重复按钮（2026-09-28 用户裁定）

**一句话**：未选中对象时的右栏空态，**只放"下一步去哪"的提示语**；**不再放与工具栏重复的「＋ 新建」按钮**。

- **由来**：08 §6.2.1 曾要求"空态也要有下一步动作"，CBB 空详情面板据此放了「＋ 新建 CBB」——走查被指多余
  （工具栏已有同一入口，空态按钮 = 第二个维护点，必然与工具栏漂移）。用户裁定：**空态动作 = 提示语指引**
  （"在左侧选择一条资产：…"），新建入口**只保留工具栏一处**。
- **判据**：空态右栏内**不存在**任何与工具栏同义的动作按钮；提示语含可执行去向。
- **波及登记**：本条是对 §6.2.1"空态也要有下一步动作"的**口径修正**——该句此后解释为
  "必须有可行动的提示（下一步点哪里）"，不是"必须再放一个按钮"。CBB 页已按此整改。 |
