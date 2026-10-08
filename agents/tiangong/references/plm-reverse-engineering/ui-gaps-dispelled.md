# 已排除清单（补扫 3 模块时证否的疑似缺陷）

> 对应 [ui-gaps-settled.md](ui-gaps-settled.md) §一（第一次横切面审计的 8 条证否）。
> 本文件是**第二轮**（需求管理 / 文档管理 / 计划任务 深扫）的 10 条证否 + **第三轮**（整改期）的 1 条。
> 任何后续审计若重新提出这些，说明没有先读这一节。
> **首轮与二轮取证时未改任何代码**（D-6 于 2026-10-05 才对 5 条现行缺陷解除，见各文件「处置」小节）。

| # | 曾被怀疑 | 证否依据 |
| --- | --- | --- |
| 9 | **需求页拿错了流程定义**——`RequirementsPage.tsx:90` 在需求页上用 `useFlowStateLabel('req-baseline')` 取基线标签，指向的是另一个域 | **是刻意设计，且写明了理由**。`:88` 才是需求域本体：`useFlow('requirement', effRoles)` 提供 `states`/`visibleTransitions`/`editableStatuses`/`stateLabel`；`:90` 是**第二条独立的一行**。`:77-78` 原话：「基线是**另一个域**（同名不同义——需求域也有 `DRAFT`/`OBSOLETE`，但两域的合法态集合不同），通用件明确要求『**一个域一行、调用点显式声明域**』」。⇒ **不是 bug，是本仓推荐的正确范式。** |
| 10 | **`RequirementFlowStrip.tsx:18` 自称的「数据全部来自服务端单一口径」可能是自我宣传** | **逐行核实，成立**。组件是纯渲染：`:81` 的 `state` 只把服务端给的 `current`/`terminal`/`done` 布尔映射成展示态（`done/current/todo/terminal`），`:63` 是 `filter(s=>s.done).length` 显示计数，**均不重算任何判定**。`:32` 另记产品域复用同一构件、同一份 `FlowTaskService.flowStages` 实现（合 V-186「同一判定不得有第二份实现」）。 |
| 11 | **需求↔项目是多对多**（UI 只有一个 `lookup` 选择器，且有「未纳入」态），界面把它当单值用 | **基数确为 1:1，UI 正确**。全仓仅 `V1__schema.sql:62` 一处 `CREATE TABLE t_requirement`，**无 `t_requirement_project` 连接表**、无 requirement→project 外键表 ⇒ 归属是任务行上的单列。UI 侧对应：`RequirementsPage.tsx:971` `kind:'lookup'` + `allowClear:true` + `clearLabel:'未纳入'`（单选可空 = 1:1 语义）。`:1240-1242` 还刻意区分「有 id 但编号未取到 ⇒ 显示 `#id`」与「真无归属 ⇒ 显示未纳入」。**附带**：`:486-495` 记 G-LST-3「网格内联创建漏传 `projectId`」**已修**（`saveReq` 一直携 `projectId`，唯内联那一路曾漏）。 |
| 12 | **基线「冻结快照」的语义在界面上看不见**（用户会以为冻结=锁死需求） | **语义已用用户可见文字讲清**。`RequirementsBaselinesPage.tsx:399-402`（新建表单内的灰色提示，非代码注释）原话：「基线范围 = 项目（一个项目可有多条基线）；基线**不冻结需求本身**，它是一组需求**版本的集合**，同一条需求可纳入多条基线。」另 `:409-412` 显示批次 56 已把 4 行写死的 `<option value="DRAFT">草稿</option>` 换成服务端词表，并写明理由「写死的选项集是第二份权威……『筛选里选不到某个合法态』就等于那个态的数据**查不到**」。 |
| 13 | **`status: 'ALL'` 会被后端当字面量状态值，导致基线候选全空** | **是显式契约**。`RequirementsPage.tsx:352` 传 `status:'ALL'`；`ReqBaselineController.java:36` 方法注释：「基线清单（支持项目/状态/关键词过滤；**`status=ALL` 取全部状态**）」。⇒ 非缺陷。（附：同处 `:356-361` 的显式自愈——切换项目作用域后若原筛选基线不在新作用域，清掉筛选**并给可见提示**，避免「看起来筛过了、结果是空的」。） |
| 14 | **下载票据流程前端没接 / 票据过期无提示** | **两问都证否**。① 前端确实走票据通道：`src/lib/download.ts:40` `POST /documents/files/{fileId}/download-ticket`。（疑点源于 `DocumentsPage.tsx` 的 API 清单里没有它——因为下载走 `lib/download.ts` 而非页面内联，属**解析路径**误判，非缺陷。）② 不展示 `expiresAt` 是**设计决定**：`download.ts:15-17`「服务端强制，前端只需知道『**不许复用、点一次签一次**』」；`:20-22` 签票是**普通 axios 调用**，故 413 体积上限等拒绝**发生在导航之前**、页内可见。120s TTL 只在**复用 URL** 时才有意义，而 UI 从不复用。 |
| 15 | **甘特图能拖拽但拖完不落库**（用户白拖） | **根本没有拖拽**。`TaskGanttPage.tsx` 全文 4 处 `onChange` **全是筛选器**（`:242` 项目、`:253` 状态、`:259` 关键词、`:262` 显示未排期），无 `api.` 调用、无 `draggable`/`onDrop`。`:2` 头部即声明「**只读**视图……（裁定 D-B4-01/02）」，`:342` **用户可见地**渲染「本批仍为只读视图：不含拖拽改期与依赖的拖拽连线（见批内裁定 D-B4-11）」。⇒ 只读性已披露，非缺陷。 |
| 16 | **任务进度是前端平均算的**（与服务端口径可能分叉） | **进度由服务端给**。`TasksPage.tsx:735-738` 网格列直接读 `p.data.progressPercent`（服务端字段），无任何前端计算。`TaskService.java:1768` `UPDATE t_project_task SET progress_percent=?` 手工端点直写，注释标「进度当前值写任务行（**唯一事实源**）」。**附带证否**：`progress_mode` 列（`V167:102` 邻近列）虽仍在库且 API 仍校验（`TaskService.java:1013-1014`）并写入（`:1077`）、默认落 `BINDING`（`:917`），但**从不参与任何进度计算** ⇒ 是废弃列，UI 那句面向全体用户的「进度由主责人自行拖动」（`TasksPage.tsx:1328`）**对所有任务都成立**。 |
| 17 | **`document-controller`(28) 与 `deliverable-controller`(9) 职责重叠——「一份要交出去的东西」能否两处创建** | **无双重创建入口**。`DocumentsPage.tsx` 全部 21 处 API 调用中唯一的创建是 `:532` `POST /documents`；交付物侧只**引用**文档，不另建。`ProjectsPage.tsx:474,831` 读写的 `/projects/{id}/milestones` 同理。**且项目维度筛选的口径已显式说明**：`DocumentsPage.tsx:852` 「**经交付物清单关联**」，`:942-948` 空态**区分两种"没有文档"**：① 清单为空（真实结论）② 清单有引用但被其它筛选排除。 |
| 18 | **计划任务的 BizPlan / 目标 / 里程碑 / 任务 四者父子关系没讲清（C 类重点）** | **部分证否，且反查出 MSG-01**。① 四者**全是项目级 siblings，无一嵌套**：`t_biz_plan`←`t_project.biz_plan_id`（`V23:188`）、`t_prj_obj_dim`/`t_prj_objective`/`t_prj_objective_rev`/`t_prj_achievement`（`ProjectObjectiveService.java:35-40`，**项目级数值承诺与实绩**，非任务级目标）、`t_milestone`（`V20:17-29`）、`t_project_task`（仅 `parentId` 任务内 WBS 层级，`TasksPage.tsx:253` 元数据组为 `['taskCode','wbsPath','parentTask','parentId','status']`，**无 objective/milestone 列**）。② UI **没有假装它们嵌套**：`ProjectsPage.tsx:41` `TABS` 是 7 个平级页签 `['项目概览','团队与角色','交付物清单','里程碑','计划任务','应有基线','目标与达成']`。③ **但**「里程碑」这个词在任务侧与项目侧指两样零外键的东西 ⇒ 已立为现行缺陷 **MSG-01**（见 [ui-gaps-open-domains.md](ui-gaps-open-domains.md)）。 |

---

# 第三轮：整改期证否（2026-10-05 · D-16 动代码时撞出来的）

> 修 SYS-01 要普查全库 CHECK，**顺带把 `t_offering_line` 的 5 个约束全查了出来**，
> 于是产生一个此前没人提、看上去很像缺陷的怀疑。**证否**。这轮的证否比前两轮更值钱：
> 前两轮是"猜错了"，这轮是"**代码摆在那里几乎就是缺陷的样子**"。

| # | 曾被怀疑 | 证否依据 |
| --- | --- | --- |
| 19 | **`t_offering_line.ref_type` 上有两个约束**（`t_offering_line_ref_type_check` 与 `t_offering_line_ref_type_ck`）——看着就是"改名忘了删旧的"，且 CHECK 约束不能重名，这很像一次重构留的垃圾 | **是"基线 + 收紧"的正常两层加固，不是残留**。实测两条并存且**不矛盾**：`…_check` = `ref_type = ANY (ARRAY['PROD','ITM'])`（无条件基线，只管取值范围）；`…_ck` = `((line_type='PRODUCT' AND ref_type IN ('PROD','ITM')) OR (line_type IN ('CONSUMABLE','SERVICE') AND ref_type='ITM'))`（**有条件、更强**）。关键三点：① 值集对 UI 而言**完全相同**（最宽的那支 = 两条约束的并集）；② 后者**蕴含**前者，不是冲突而是子集收紧——加它只会多拒、不会多放；③ 后者带 **`NOT VALID`**，即"只对新增/更新行生效、不追溯校验存量"，这是 PG 里的**标准加固手法**（线上大表加约束必配 `VALIDATE CONSTRAINT` 分步走），恰恰说明**作者是刻意这么加的**。同表的 `t_offering_line_type_ck`（`line_type IN ('PRODUCT','CONSUMABLE','SERVICE')`，同样 `NOT VALID`）、`billing_cycle_ck`、`currency_ck`、`price_ck`（均对 NULL 宽容）呈现同一模式。 ⇒ **命名后缀 `_check` / `_ck` 不统一是风格瑕疵，不是缺陷。** |
