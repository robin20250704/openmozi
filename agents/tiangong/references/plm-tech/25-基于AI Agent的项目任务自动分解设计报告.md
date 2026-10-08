# 25 · 基于 AI Agent 的项目任务自动分解设计报告

> **定位**：**设计报告**（本文档**不含任何实现**；不改产品代码、不建表、不写迁移）。
> 回答一个问题：**在计划任务域已原生落地之后，如何用 AI Agent 把"需求/交付物/模板"自动变成一份可评审的 WBS 草稿**——并且与既有实现逐一对齐、可落地。
>
> **输入依据**（全部为仓内实读，行号即取证位置）：
> `docs/plm-tech/04-AI-Agent融入方案.md`（AI 总架构与六铁律）、`docs/plm-tech/10-语义查重与AI查重服务设计.md`（AI 服务范式）、`docs/plm-tech/11-检索索引与全文检索引擎重构方案.md`（索引与嵌入）、`docs/plm-tech/08-前端实现规格.md`（界面口径）、`docs/plm-tech/12/13/14/16/17/18/19` 号文（产品级通用规格）、
> `ipd/plm-app/backend/src/main/resources/db/migration/V167/V168/V170/V174`、`ipd/plm-app/backend/src/main/java/com/plm/domain/task/**`、`ipd/plm-app/backend/src/main/java/com/plm/platform/{agent,dedup,search,resolver,permission,flow,pms}/**`、`ipd/plm-app/backend/src/main/resources/flows/task-flow.yaml`。
>
> **标记约定（读本文档前必读）**：
> - `【依据 …】` = **已在仓内读到**的事实，后附 `文件:行号`；
> - `【提案】` = **尚未实现**，本文档建议的做法（含 JSON Schema、接口、伪代码）；
> - `【待裁定】` = 需要用户/业务裁定的口径，**不得由实现者自行决定**；
> - `【未找到依据】` = 我在仓内**没有**找到支撑，需你确认——**不猜**。
>
> **一句话结论**：自动分解应当被设计成**一条"建议对象"流水线**（分解 → 自检 → 查重 → 人工确认 → 经服务落库），
> 它的**审计、降级、无引用拒答、单通道采纳**全部复用仓内**已经存在**的 AI 范式（`t_ai_trace` + `IpdAgentService` + `DedupService` + `EmbeddingClient` 降级口径），
> 它的**输出契约**逐字对齐既有的 `POST /tasks`（`TaskDtos.CreateReq`），它**不允许**绕过 `TaskService` 直写库。

---

## 1. 业务场景与不变量

### 1.1 现状：任务域已原生落地，"骨架生成"这一步还空着

计划任务域在 B1–B6 已完成**原生落地**（表结构 V167/V170、权限点 V168/V171/V174、ABAC V169/V172/V173、接口与界面 B2–B6）：

| 能力 | 落点 | 证据 |
|---|---|---|
| 任务树（WBS） | `t_project_task`（`task_code` 唯一且形状受 CHECK 约束、`parent_id` 自引用、计划窗整窗约束） | 【依据 V167:66-116】 |
| 主责/参与人 | `t_task_assign`，**主责唯一事实源 = `is_primary`** | 【依据 V167:138-161、V170:139】 |
| 前序依赖 | `t_task_dep`（`FS/SS/FF/SF` + `lag_days` + 唯一约束 + 自环 CHECK），环检测在服务层 | 【依据 V167:172-184、TaskService.java:1801/1819/1842】 |
| 状态机 | `flows/task-flow.yaml`（5 态：DRAFT/IN_PROGRESS/BLOCKED/DONE/CANCELLED；**12 条流转**，其中 2 条为系统路径边） | 【依据 task-flow.yaml:25-110（逐条数得 12 条）、V170:44】 |
| 权限 | 8 枚任务权限点 + 2 枚工时权限点；读侧 ABAC 15 条、写侧 25 条（其中 3 条为 `owner self`） | 【依据 V168:23-40、V171:46、V174:59、DB `t_permission_rule`/`t_role_abac` 实读】 |
| 工作日历 / 产能 / 工时 | **表已建、行数为 0、无任何读取或写入代码** | 【依据 V167:195-303；DB 实读 `t_task_hours`=0、`t_capacity`=0、`t_work_calendar`=0；全仓 grep `t_work_calendar` **0 命中**】 |

**而"项目骨架（WBS）从哪来"这一步仍在外系统**：项目批准事件走 PMS 集成，由 OpenProject 侧实例化项目骨架：

- `PROJECT_APPROVED` → `lifecycle.instantiateProject(prjCode, name, template="PDP", Map.of())`，端口 javadoc 明确写"**项目骨架：项目 + 阶段窗口 Version + 决策点 WP + 阶段标记**"【依据 PmsIntegrationHandler.java:41-48、ProjectLifecyclePort.java:9-15】；
- 现网分工文档也写着"PLM 管项目主数据（唯一真相源）与评审门（DCP/TR）；**任务执行层（工时/甘特/敏捷）由 OpenProject 承载**"【依据 docs/plm-user-guide/03-项目管理与评审门.md:4】；
- OP 集成的历史形态是"**字段直同步**：项目创建 → OP 项目 + Version + G1–G7 决策 WP"【依据 docs/plm-tech/ipd-extension/01-现状盘点.md:65】；
- 另有 `OPEN_ISSUE_CREATED` → `kcp.createReviewTask(...)`（遗留问题复查任务的出站闭环）【依据 PmsIntegrationHandler.java:49-57】。

**结论（本报告要补的那一环）**：OP 拆除后，上面两件事都必须由 PLM 原生承接——
① **WBS/任务骨架的生成**（本报告主题）；② 复查任务的生成（本文档不展开，属另一课题，见 §10 明确不做）。
而承接①的**原生能力目前不存在**：仓内**没有**任何任务模板表（`t_template*` 在库与迁移中均**不存在**，DB 实读 0 张表），
也**没有任何排期算法**（工作日历表 0 行且**无代码读取**）。

> **关于"阶段门"**：阶段门 G1..G7 已退役——`V126` 文件头写明"**阶段门 G1..G7 已于 V92 退役**，交付物基线是**阶段**维度"【依据 V126:40-41】；
> 但**残留物仍在**：`t_gate_map` 表仍有 11 行、`GET /_platform/gates` 端点仍在【依据 DB 实读、PlatformController.java:303】。
> 本报告一律用**阶段**（`t_deliverable_template.phase`）而不是阶段门作为输入维度。

### 1.2 不变量（设计必须守住的东西）

| # | 不变量 | 依据 / 状态 |
|---|---|---|
| I1 | **AI 产出永远是"建议对象"**，采纳必须走人的单通道；AI 不得成为签署人 | 【依据 04-AI-Agent融入方案.md:5、6 章；IpdAgentService.java:14-15, 64-69】 |
| I2 | **无引用不回答**：证据为空即**明确拒答**，不允许"凭感觉生成" | 【依据 IpdAgentService.java:42-44；04 号文 §4.4/§6 铁律 3】 |
| I3 | **权限先于智能**：模型能"看见"的数据必须是**该触发者本人有权看见**的 | 【依据 19 号文 G-SEC（授权）/ 04 号文 §3.2；PermissionService.java:725-732】 |
| I4 | **任务数据只能经服务落库**：建任务必须走 `TaskService` 以进审计链；迁移期已把它写成自证⑦ | 【依据 V167:440-444（"任务必须走 TaskService 以进审计链 P6"）】 |
| I5 | **草稿不得绕过状态机与校验**：落库后的任务一律从 `DRAFT` 起步，父窗口/跨项目/依赖环等既有守卫全部生效 | 【依据 TaskService.java:737-763、1849-1960；TaskController.java:251-252】 |
| I6 | **可解释**：每条草稿任务都必须能回答"你凭什么拆出它"（引用 + 理由 + 置信度） | 【提案（本报告 §6）】——既有 AI 范式只做到"答案级"引用，**条目级理由尚无实现** |
| I7 | **AI 能力缺失必须可见**：降级不阻断业务，但"降级状态"必须能查、跃迁必须打日志 | 【依据 EmbeddingClient.java:22-38（含 9 天静默降级的历史事故）】 |
| I8 | **权限点/错误码/字段名一律复用既有命名**，不新造同义词 | 【依据 18 号文（E 错误契约）；本报告 §8 的错误码全部取自既有 `TASK_*`/`LOOKUP_*`/`AI_*`/`RESOLVE_*` 实读清单】 |

### 1.3 端到端位置（ASCII）

```
需求(REQ) / 交付物基线(DELIVERABLE_TEMPLATE) / 任务模板(【提案】尚不存在) / 历史同类项目 / 工作日历(表在·0 行)
        │                                   │
        ▼                                   ▼
   ┌──────────────────────────────────────────────────────────┐
   │ 分解 Agent（DSH subagent 或一期规则聚合引擎，见 §3.4）      │
   │   ①分解 → ②自检 → ③查重 → ④人工确认 → ⑤落库              │
   └───────┬──────────────────────────────────────────────────┘
           │ 只读工具（携带触发者身份 ⇒ 权限穿透）
           ▼
   /_platform/search、/_platform/dedup、/_platform/resolve、
   /projects/{id}/members、/projects/{id}/deliverables、/_platform/deliverable-templates、
   GET /requirements、（【提案】task-template）
           │
           ▼
   WBS 草稿（建议对象，JSON，§2.2）── 审计 t_ai_trace（不变量 I1/I6）
           │  人在草稿评审网格里逐条接受/修改/拒绝（§6）
           ▼
   POST /api/v1/tasks（TaskService.create：权限 + ABAC + 父窗口 + 计划窗 + 审计）
           │
           ▼
   t_project_task（DRAFT）+ t_task_assign + t_task_dep ← 走既有状态机 task-flow.yaml
```

---

## 2. 输入契约与输出契约

### 2.1 输入契约（6 类，逐条给"已有 / 不存在"）

| # | 输入 | 权威来源（实读） | 可用接口 | 现状判定 |
|---|---|---|---|---|
| 1 | **需求** | `t_requirement`：`req_code`(唯一, `REQ-YYYY-NNNN`)、`req_type ∈ {UR,SR,REG,RC}`、`title`、`content`（可验证描述）、`parent_id`（需求树分解）、`req_class_id`、`dfx_dimension`、`priority ∈ {HIGH,MEDIUM,LOW}`、`source_type`、`std_clause`、`verify_method ∈ {TEST,ANALYSIS,INSPECTION,DEMO}`、`project_id`（**逻辑引用**，应用层校验）、`status` | `GET /api/v1/requirements`（RequirementController.java:17） | ✅ 可用（DB 2258 行） |
| 2 | **交付物（应有清单 + 实交付）** | `t_deliverable_template`：`name`、`phase`（值域 = `ProjectStages.ALL`：立项/概念/计划/开发/验证/注册申报/设计转换/上市/维护/退市）、`critical_path`、`med_class`/`market`/`product_kind`、`provenance ∈ {PLM_MIGRATION, IPD_KNOWLEDGE}`、`active`（软删）；`t_deliverable`：`project_id`、`name`、`required_flag`、`obj_type`/`obj_id`、`status ∈ {PENDING,SUBMITTED,APPROVED}` | `GET /_platform/deliverable-templates`（+`/coverage`）、`GET /projects/{id}/deliverables` | ✅ 可用（模板 155 行 / 实交付 51 行） |
| 3 | **流程模板** | 状态机 = `flows/task-flow.yaml`（可编辑态 `editableStatuses: [DRAFT,IN_PROGRESS,BLOCKED]`、`ownerTransferStatuses`） | `GET /_platform/flows/task`（PlatformController.java:191） | ⚠️ **状态机有，"WBS 模板"没有**：`t_template*` 在库/迁移中**不存在**（DB 实读 0 张）⇒ 【提案 §4 工具 `task.template.get` + §9 一期先做"内置模板 + 配置落库"】 |
| 4 | **历史同类项目** | `t_project_task`（**DB 仅 5 行**，且是人工测试数据）、`t_project`（26 行）、全文索引 `t_search_index`（4077 行）、嵌入 sidecar（`plm-embedding:8084`） | `GET /_platform/search`、`/capabilities`、`/_platform/dedup/candidates` | ⚠️ **通道可用、样本不足**：以"照历史项目学"为**主**依据会在 DEV 上退化成"编"。设计上把它降为**辅助信号**（见 §5 判据与 §10 风险 R2） |
| 5 | **工作日历 / 产能** | `t_work_calendar(calendar_id,date,is_workday,note)`：**0 行、无代码读取**；`t_capacity(person_login,capacity_hours_per_week,part_time_factor)`：**0 行**；`t_project_member` 51 行，且已加 `capacity_hours_per_week`/`part_time_factor` 两列 | 无（**尚无任何端点**） | ❌ **必须先有数据**：节假日/产能是**组织事实**，V167 写明"**本迁移不填种子**——公司级节假日是组织事实，须由用户给，不猜"【依据 V167:303】⇒ 【待裁定 Q5】 |
| 6 | **团队技能** | **不存在**：`t_skill`/`t_user_skill` 均 0 张表 | 无 | ❌ **未实现**（与 B1 期间的登记一致：技能维度未落）⇒ 主责建议只能基于**项目名册 + 角色 + 历史承担**，**不得**声称"按技能匹配" |

**权限边界（对所有输入工具生效）**：任务的读可见性 = 对象级 ABAC `canAccessObject("task","read", AbacAttrs.of(projectId, null))`，**fail-closed**（没有任何命中规则即拒），且 `404` = "不存在**或**不可见"（两者刻意同形）【依据 PermissionService.java:725-732、TaskService.java:306-308/330】；
`AbacAttrs` 为 `(project, org, product, owner)`【依据 AbacAttrs.java:8-10】；`TASK/read` 规则 15 条、全部是 `project member_of {user.projects}`【依据 DB 实读 `t_role_abac`】。
⇒ **模型输入只允许由"触发者身份"驱动的工具取数**，不允许旁路查询（不变量 I3）。

### 2.2 输出契约：WBS 草稿（JSON Schema，**全部字段逐字对齐既有入参**）

草稿的字段名**必须**与 `TaskDtos.CreateReq` 一致（否则落库要写一层映射，就会长出第二份口径）【依据 TaskDtos.java:28-43】：

```jsonc
{
  "draftId": "【提案】DRAFT-2026-0001",          // 草稿标识（是否落库见 §7.2【待裁定】）
  "traceId": "21",                                // t_ai_trace.id（既有表，V35:2-14）
  "agent": "task_decompose",                      // 【提案】新增 agent 码（既有 5 个见 IpdAgentService.java:27-28）
  "modelVersion": "plm-agent-r1",                 // 【依据 IpdAgentService.java:23】一期取值；接真模型后由 provider 回报
  "projectId": 87,                                // CreateReq.projectId（必填）
  "refused": false,                               // 【依据 IpdAgentService.java:58】true 时 tasks 必为空数组
  "tasks": [
    {
      "tempId": "t1",                             // 草稿内临时键（仅用于本文件内表达父子/依赖）
      "parentTempId": null,                       // → CreateReq.parentId（落库时由 tempId 解析，见 §3.5）
      "taskType": "WORK",                         // CreateReq.taskType；值域见下注①
      "name": "呼吸机 R3 软件需求规格说明书编写",     // CreateReq.name（非空白；DB CHECK btrim(name)<>''）
      "description": "……",                        // CreateReq.description
      "plannedStart": "2026-10-08",               // CreateReq.plannedStart（与 plannedDue 成对；见注②）
      "plannedDue": "2026-10-15",
      "plannedHours": 16,                         // CreateReq.plannedHours（≥0）
      "sortNo": 10,                               // CreateReq.sortNo
      "milestone": false,                         // CreateReq.milestone
      "primaryLogin": "dev1",                     // 【提案】映射到 CreateReq.ownerLogin（主责必须 ∈ 项目名册；见注③）
      "dependsOn": [                              // 【提案】落库后走 POST /tasks/{id}/deps
        { "tempId": "t0", "depType": "FS", "lagDays": 0 }
      ],
      "citations": [                              // 不变量 I2/I6：无引用不出条
        { "logicalId": "PLM:REQ:REQ-2026-0001", "role": "SOURCE" },
        { "logicalId": "PLM:DELIVERABLE_TEMPLATE:#128", "role": "BASELINE" }
      ],
      "rationale": "由 SR 需求 R3-07 分解而来；交付物基线在该阶段要求该文档",
      "confidence": 0.82,                          // 0..1，仅供人排序审阅（不得作为自动采纳依据）
      "qualityFlags": []                           // §5 判据的机检结果（WARN/BLOCK）
    }
  ],
  "checks": {                                      // §5 的自检汇总（每条判据一行的机检结论）
    "integrity": "PASS",
    "duration": "WARN",
    "dependency": "PASS",
    "assignability": "PASS",
    "explainability": "PASS"
  },
  "refusalReason": null                            // refused=true 时的可读原因（口径同 IpdAgentService 的拒答文案）
}
```

> **注① 任务类型（`taskType`）**：DB CHECK 允许 `PHASE_GATE/WORK/DELIVERABLE/REVIEW`【依据 V167:98】，
> 而 `PHASE_GATE` 对应的阶段门已退役（§1.1）⇒ **【提案】Agent 只产出 `WORK`/`DELIVERABLE`/`REVIEW` 三种**；
> `PHASE_GATE` 保留在 CHECK 里不动（改 CHECK 是迁移动作，不在本设计范围）。
>
> **注② 计划窗必须成对**：DB 有 CHECK"要么整窗为空、要么给全且不倒置"【依据 V167:106-108】，服务层对应 `TASK_PLAN_HALF_WINDOW`/`TASK_PLAN_RANGE_INVALID`【依据 TaskService.java:866/1986-1989】。
> ⇒ 草稿**允许**给不出日期（全部为 `null`，落库为"未排期"），但**不允许**只给一半。
>
> **注③ 主责建议 ≠ 分派**：`CreateReq.ownerLogin` 的语义是"建任务时顺带指定主责"【依据 TaskDtos.java:24-26】；
> 建议值必须**同时**满足：① 属于该项目名册（`t_project_member`，否则服务层 `TASK_ASSIGNEE_NOT_IN_PROJECT`）【依据 TaskService.java:1264/1417】；
> ② 该任务建成后由**创建者**或**主责**推进（行级身份在 `TaskService`/`task-flow.yaml` 定）【依据 task-flow.yaml:21-24】。
> ⇒ **AI 只"建议"，不自动分派**（§10 明确不做）。

---

## 3. Agent 编排（分解 → 自检 → 查重 → 人工确认 → 落库）

### 3.1 五步流水线与失败/回退

| 步 | 名称 | 输入 | 产出 | 失败语义（错误码取自既有命名法） | 回退动作 | 副作用 |
|---|---|---|---|---|---|---|
| ① | **分解**（decompose） | 输入包（§2.1 的 1/2/3/4/5 项，受权限过滤） | 草稿树 JSON | `AI_AGENT_UNKNOWN`（agent 码非法）、`【提案】TASK_DECOMPOSE_NO_INPUT`（无可用输入）、**证据为空 ⇒ 拒答**（`refused=true`，文案同既有拒答口径） | 直接结束（**不产出空草稿**，避免"看起来生成了其实什么都没"） | 写 `t_ai_trace`（1 行，`adopted=false`） |
| ② | **自检**（self-check） | 草稿树 | 每条的 `qualityFlags` + `checks` 汇总 | 任一条 `BLOCK` ⇒ 草稿**不进入③**，原样返回给人看（**不静默修**） | 回①（带上失败清单重试；**重试次数上限 2**，超限即返回可读失败） | 无（纯函数） |
| ③ | **查重**（dedupe-check） | 草稿各条 name/description | 疑似重复候选（**只提示**） | 查重服务不可用 ⇒ **降级为"未查重"并在草稿上标注**（不得当成"无重复"） | 继续（查重是**软提示**，与非 AI 查重同口径） | 无 |
| ④ | **人工确认**（review） | 草稿 + 引用 + 置信度 + 判据结果 | 逐条决定：接受 / 改后再接受 / 拒绝 | 无（人不动 = 不落库） | 任意步可回到①重生成 | 写采纳动作（§7.3） |
| ⑤ | **落库**（apply） | 被接受的那部分草稿 | `t_project_task` 行（`DRAFT`） | 复用**既有**错误码：`TASK_PROJECT_REQUIRED`/`TASK_PROJECT_NOT_FOUND`/`TASK_NAME_INVALID`/`TASK_TYPE_INVALID`/`TASK_PLAN_HALF_WINDOW`/`TASK_PARENT_NOT_FOUND`/`TASK_WBS_CROSS_PROJECT`/`TASK_WBS_CYCLE`/`TASK_WBS_WINDOW_VIOLATION`/`TASK_ASSIGNEE_NOT_IN_PROJECT`/`TASK_VERSION_CONFLICT`/`TASK_DEP_*` | **部分失败必须可比对**：逐条回执（成功/失败+错误码+可读原因），**不允许**整批静默回滚或"成功一半却说成功" | 建任务 + 建分配 + 建依赖，各走既有服务（进审计链） |

> **为什么⑤必须复用接口而不是直写库**：迁移期已把纪律写成自证⑦——"本迁移**没有产生任何任务数据**
> （任务必须走 `TaskService` 以进审计链 P6）"【依据 V167:440-444】。AI 落库若直写 INSERT，会同时破坏
> **审计链、乐观并发、父窗口守卫、权限判定**四件事。

### 3.2 编排形态：与既有 AI 范式**同形**（不另立一套）

| 维度 | 既有范式（实读） | 本设计沿用 |
|---|---|---|
| 入口 | `POST /api/v1/ai/agents/{agent}`，`agent ∈ {charter_precheck, dcp_assembly, bottleneck_forecast, progress_attribution, cbb_recommend}` | 【提案】`POST /api/v1/ai/agents/task_decompose`（**同一入口**，新增 agent 码） |
| 产出 | `{agent, answer, citations, refused, traceId, modelVersion}` | 草稿 = 同一响应的**结构化扩展**（加 `tasks[]`），`refused/citations/traceId/modelVersion` **逐字沿用** |
| 拒答 | `citations` 为空 ⇒ 固定拒答文案 | **同一条**（分解也一样：证据为空就拒答） |
| 采纳 | `POST /api/v1/ai/traces/{id}/adopt` → `UPDATE t_ai_trace SET adopted = TRUE` | 复用；【提案】细化为"逐条采纳"（见 §6.3【待裁定 Q1】） |
| 审计 | `t_ai_trace(id, agent, question, question_hash, answer, citations, model_version, prompt_hash, adopted, actor, created_at)` | **同一张表**，`citations` 存条目级引用；【提案】新增草稿→任务的链路（§7.3） |
| 模型 | 一期 = **规则聚合引擎** `plm-agent-r1`（`MODEL_VERSION` 常量注明"接口预留 DSH subagent 挂接"） | 一期同路径；接真模型时只换 provider（§3.4【待裁定 Q2】） |
| 降级 | `EmbeddingClient`：依赖不可用**不阻断**（回落词法层）+ 状态跃迁打日志 + `status()` 可查 + `probe()` 主动探测 | **逐条照抄**：LLM/provider 不可用时**回落"模板 + 规则"分解**，并暴露降级状态 |
| 查重 | `/_platform/dedup/{compare,candidates,clusters,sources}`；四级混合评分；向量层缺席时**公式与阈值不变** | 直接调用（**不重写**评分；阈值口径见 10 号文 §2.5/§2.6） |

> ⚠️ **既有缺口（如实登记）**：`IpdAgentController` 的三个端点**没有任何 `@PreAuthorize`**
> 【依据 IpdAgentController.java:10-26】——即"AI 入口本身未经权限点约束"。
> 本设计**不沿用**这一缺口：【提案】`task_decompose` 入口必须挂权限点（§8.1）。

### 3.3 提示词（prompt）与确定性封装

- **"LLM 只做理解、裁决交给确定性规则"** 是既有 AI 方案的原则（例：注册路径判定由规则引擎裁决）【依据 04-AI-Agent融入方案.md §6.1】。
  在分解场景里，可裁决的部分是**可机检的判据**（§5 的完整性/依赖一致性/可分配性）⇒ **由代码判定，不由模型自述**；
  模型只负责"从需求与交付物基线里提出候选任务与排序"。**模型自述的"我检查过了"一律不采信**（判据必须可复算）。
- 【提案】prompt 骨架（与既有 04 号文 §2.2 的模板同形，占位符用 `{}`）：

```
你是医疗器械 PLM 计划任务域的分解助手。上下文：{context}
输入证据：{evidence}      # 每条都带 logicalId，来自工具读数
硬约束（违反即整条作废）：
  1) 每条任务必须引用至少一条证据（logicalId），无证据不得输出；
  2) 任务类型只能是 WORK/DELIVERABLE/REVIEW；
  3) 计划窗必须成对给出或成对留空；
  4) 主责建议必须来自给定的项目名册清单，不得虚构人名；
  5) 只能使用给定工具，不得推测库中未见的数据。
输出：严格符合 §2.2 JSON Schema 的对象（不要自然语言包裹）。
```

### 3.4 provider 抽象【待裁定 Q2】

| 选项 | 现状依据 | 代价/收益 |
|---|---|---|
| A. 一期沿用 `plm-agent-r1`（**规则聚合引擎**，无 LLM 调用） | 【依据 IpdAgentService.java:22-23】当前 5 个 agent 就是这么跑的，`t_ai_trace` 21 行实证可用 | 零新增依赖、可离线、**可测**；分解质量受限于"模板 + 规则"的覆盖度；需先有模板（§2.1 第 3 项） |
| B. 接 DSH subagent（`agent()`/`workflow` 编排） | 【依据 04 号文 §1.1/§2.2（每个领域 Agent = 一个 DSH subagent）】 | 编排与并行能力强；**新增运行组件**（网关、身份注入、超时/重试），须与 16 号文 SLO 对齐 |
| C. 私有 vLLM（企业内网模型） | 【依据 04 号文 §7.3（provider: custom + base_url）】 | 数据不出内网；需要 GPU 与模型版本管理（`t_model_version` **当前不存在**，DB 实读 0 张） |

> 三个选项**不互斥**：建议 A 打底（保证"始终可用"）＋ B/C 作为增强层（可用时提升质量），
> 这正是 `EmbeddingClient` 已经验证过的形态（**能力缺失不阻断，但必须可见**）【依据 EmbeddingClient.java:22-38】。

---

## 4. 工具（tools）清单

**共同规则**：① 每个工具调用都携带**触发者身份**，取数走既有权限面（不变量 I3）；② 工具**只读**，除 `task.create`/`task.dep.add`（仅在被确认后由后端执行，不由模型直接调）；③ 一切空值/拒绝必须**可解释**（不得把"无权/不存在"渲染成"没有数据"）。

| # | 工具 | 入参 | 返回 | 副作用 | 权限 | 失败语义 |
|---|---|---|---|---|---|---|
| T1 | **查模板**（【提案】，尚无实现） | `projectId`, `phase?`, `medClass?`, `market?` | 任务模板条目（名称/类型/默认工期/默认依赖/默认角色） | 无 | `task.read` + 项目可见 | 【提案】无匹配 ⇒ 返回**空列表 + 原因**（不是 404），并让草稿标注"无模板依据" |
| T2 | **查需求树**（复用） | `projectId`, `keyword?`, `status?` | 需求列表（含 `parent_id` 树）`GET /api/v1/requirements` | 无 | 需求域读权限（按既有实现） | 既有错误契约 |
| T3 | **查交付物基线**（复用） | `phase`, `medClass/market/productKind?` | 应产出清单 + 覆盖率 `GET /_platform/deliverable-templates`、`/coverage` | 无 | 平台读 | 既有错误契约 |
| T4 | **查项目交付物实况**（复用） | `projectId` | `t_deliverable` 列表（`status ∈ PENDING/SUBMITTED/APPROVED`） | 无 | `deliverable` 读 + 项目内 | 既有（`requireInProject` 越权面收口）【依据 DeliverableController.java:535-542】 |
| T5 | **查项目成员/角色**（复用） | `projectId` | 名册（`login` + `role_code`）`GET /api/v1/projects/{projectId}/members` | 无 | 项目读 | 既有 |
| T6 | **查重**（复用） | 文本/字段（`objType=TASK`【提案】、`code/name/spec/...`） | 候选 + `score` + `verdict ∈ {DUPLICATE,SUSPECT,OK}` + `matchedFields` `POST /_platform/dedup/compare` | 无 | 平台读 | 服务不可用 ⇒ **降级标注"未查重"**（不当作"无重复"） |
| T7 | **查历史同类**（复用） | 关键词/对象类型 | 全文/向量召回（RRF 双后端）`GET /_platform/search` | 无 | 平台读（+ 结果按权限过滤） | 【依据 11 号文；SearchController.java:39-132】 |
| T8 | **解析引用**（复用） | `PLM:<TYPE>:<CODE>[#<REV>]` | `{status, type, code, displayName, deepLink, logicalId}` `GET /_platform/resolve?id=` | 无 | 平台内省（类型集公开） | **三态**：`invalid_format`/`unknown_type`（400+可读提示）/ `denied_or_notfound`（200，**刻意不区分**）【依据 ResolverController.java:27-71】 |
| T9 | **查工作日历**（**无实现**） | `calendarId`, 日期区间 | 工作日/节假日 | 无 | — | ❌ 表 0 行、无代码读取 ⇒ 一期**不调用**：草稿只给"自然日工期"，**并在草稿上标注"未按工作日历折算"**（见 §5 判据 C2、§10 风险 R4） |
| T10 | **查产能/兼职系数**（**无实现**） | `login` | `capacity_hours_per_week` / `part_time_factor` | 无 | — | ❌ `t_capacity` 0 行；名册上的两列可空 ⇒ 一期**只用于"是否超配"的软提示**，不做硬判 |
| T11 | **草稿自检**（【提案】纯函数） | 草稿树 | `qualityFlags` + `checks` | 无 | 无 | 无 |
| T12 | **建任务 / 加依赖**（复用，**只由后端在确认后执行**） | `CreateReq`（§2.2 注）；依赖体 **逐字**为 `DepAddReq{items:[DepItem{predecessorId, depType, lagDays}]}`（单次可批量） | 任务行（`task_code`/`version`） | **写库 + 审计** | `task.create`（23 角色 ∩ 项目 `member_of`）+ `task.update`（依赖） | 复用既有错误码（§3.1 第⑤步清单）【依据 TaskDtos.java:200-203、TaskController.java:185-201】 |

> **"对象选择器"口径**：任何"选任务/选人/选需求"的界面与工具一律走既有检索面板 `SearchPick` +
> `/_platform/lookup/*`（**禁**把预加载单页当全量）【依据 14 号文「可复用构件与通用 UI 纪律」G-UI 系列（主业务对象选择一律用检索面板）；08 号文 §6.1（禁弹窗录入，本仓代码注释同引）】；
> 其中 `objType=TASK` 的检索**必须带 `projectId`**，否则 `400 LOOKUP_TASK_SCOPE_REQUIRED`，
> 且项目不存在/不可见一律 `LOOKUP_TASK_SCOPE_FORBIDDEN`（两者**同码同文案**）【依据 LookupService.java:250-260】。

---

## 5. 质量判据（每条都给可机检形态）

**总原则**：判据由**代码**执行（可复算、可回溯），模型自述不作数（§3.3）。判据结果分 `PASS/WARN/BLOCK`：
`BLOCK` 阻止进入"人工确认"之后自动落库（**仍可人工逐条修改后接受**），`WARN` 只提示。

| # | 判据 | 含义 | 机检形态（可复算） | 现状对齐 |
|---|---|---|---|---|
| C1 | **完整性** | 每条任务有名称、类型、至少一条引用；**需求/交付物的覆盖不遗漏** | ① `tasks[].name` 非空白且 `citations.length ≥ 1`；② 覆盖度断言：输入里每个 `critical_path=true` 的交付物基线条目，**至少映射到 1 条 `taskType=DELIVERABLE` 草稿**（差集为空，差集非空则列出缺口清单） | 【依据 V167:104（name 非空 CHECK）；V126:50（`critical_path` 字段存在）】 |
| C2 | **工期合理性** | 工期为正、量级可信、**不超出父任务时间窗** | ① `plannedDue ≥ plannedStart`（成对）；② `plannedHours ≥ 0`；③ 子窗 ⊆ 父窗（含等号）；④ 【提案】量级判据：`工期 ≤ 项目其余任务工期中位数 × K`（K 为【待裁定】参数，默认 3）且 **单位是自然日**（T9 缺失故不折算工作日，须在草稿上标注） | 【依据 V167:106-112（DB 双重守卫）、TaskService.java:1923-1960（`TASK_WINDOW_SELF_INCONSISTENT`/`TASK_WBS_WINDOW_VIOLATION`）】 |
| C3 | **依赖一致性** | 四类依赖的**语义**成立；**不得成环**；**不得跨项目**（草稿内同项目）；FS 后继不得早于前序完成 | ① 环检测：对草稿边集做**与既有同算法的**环检测（服务端 `projectEdges/findPath/cycleChain` 就是 BFS+前驱回溯）【依据 TaskService.java:1801/1819/1842】；② `depType ∈ {FS,SS,FF,SF}`、`lagDays ∈ [-365,365]`【依据 TaskService.java:1763-1800 的归一化与范围校验】；③ **日期一致性**（仅当两端都已排期）：`FS: succ.plannedStart ≥ pred.plannedDue + lag`；`SS: succ.plannedStart ≥ pred.plannedStart + lag`；`FF: succ.plannedDue ≥ pred.plannedDue + lag`；`SF: succ.plannedDue ≥ pred.plannedStart + lag`（无排期则记 `WARN 未判`） | ⚠️ **本判据只"检查并提示"，不做自动顺延/改期**：顺延属**明确不做**（§10），与既有裁定一致（依赖"只画线 + 提示"，不做自动排期） |
| C4 | **可执行性（可开工）** | 每条任务**有主责建议**且建议合法；**粒度可执行** | ① `primaryLogin` ∈ 名册（否则 `BLOCK`）；② 【提案】粒度判据：`plannedHours` 有值且 ≤ 单个"工时阈值"（默认 80h）——超阈值则 `WARN 建议再拆一层`；③ 文本判据：名称**不含"等/其他/相关/等等"**结尾（模糊词 ⇒ `WARN`） | 【依据 TaskService.java:1264/1417（`TASK_ASSIGNEE_NOT_IN_PROJECT`）】 |
| C5 | **可分配性** | 不出现"同一天同一人被排满/超配" | 【提案】按 `t_project_member.capacity_hours_per_week`（可空 ⇒ 回落 `t_capacity`，**两表当前均无数据**）算**日负荷**：`Σ plannedHours/工期` 与能力的比值；缺失基准时**只报 `WARN 无基准`**，**不得**默认为 40h 后当硬判 | 【依据 V167:312-314（名册两列）、V167:263-280（`t_capacity`）】 |
| C6 | **可解释性** | 每条都能回答"凭什么拆出它" | ① `citations.length ≥ 1`；② 每个 `logicalId` 经 `T8` 解析：`status=ok` 才计；`denied_or_notfound` ⇒ `BLOCK`（**无效引用不出条**，同 04 号文"无效引用标红"）；③ `rationale` 非空 | 【依据 04 号文 §4.4/§6 铁律 3；ResolverController.java:63-71】 |
| C7 | **幂等与去重** | 同一份输入重复生成，不应把同一件事拆成多条 | 【提案】对已存在的 `t_project_task.name`（同项目内）做**查重类**判据：`T6` 返回 `verdict=DUPLICATE` ⇒ `WARN 疑似与既有任务重复`；另按 `(name)` 在**草稿内**去重（完全相同 ⇒ `BLOCK`） | 【依据 10 号文 §2.6（verdict 阈值与变体守卫）；`/_platform/dedup` 实读】 |

> **判据自身的纪律**（照抄 17 号文 T-A）：① 判据必须能回答"**它在什么情况下会红**"；
> ② **未跑 ≠ 通过**（`T9/T10` 缺基准时必须显式报"未判"，不得留白）；
> ③ 判据**不许有两份实现**（C3 的环检测/范围校验必须调既有服务或与之同源，不得另写一套阈值）。

---

## 6. 人机协同与可解释性

### 6.1 三步人机协同（对齐 04 号文"三模态"）

| 形态 | 触发 | 界面要求（【提案】，按 08 号文口径） |
|---|---|---|
| **任务级 Agent**（主形态） | 项目详情页「✦ 自动分解」 | 草稿评审**网格**（不是弹窗：08 号文 §6.1 禁弹窗录入）；列：临时层级/类型/名称/计划窗/主责建议/引用/置信度/判据标记；行内可改、可勾选接受 |
| **副驾问答**（辅助） | 右栏对话 | 问"为什么这样拆/这条依据是什么" ⇒ 用**同一条 `traceId`** 回答，引用可点（`deepLink`） |
| **单元格 ✦**（轻量） | 单条任务的"建议补全" | 【提案】对已存在任务建议"拆子任务"（复用同一 agent，输入收窄到该任务子树） |

### 6.2 "你凭什么拆出它"——三级回答（这是本设计的**核心可解释面**）

1. **引用级**：`citations[].logicalId` → `T8` 解析成 `displayName + deepLink`（有权才可点）【依据 ResolverController.java:69-71】；
2. **规则级**：`rationale` 说明"由哪条输入推出"（需求/交付物基线条目/模板条目/历史项目）；
3. **判据级**：`qualityFlags` 逐条列出机检结论（含"未判"的显式原因，如 `未按工作日历折算（日历无数据）`）。

**反向要求（防装饰性解释）**：`rationale` 必须**可追溯到结构化输入**——即"每条 rationale 至少对应 1 个 `citations` 项"，
否则视为装饰性文案并标 `BLOCK`（判据 C6②）。**没有引用的解释不算解释。**

### 6.3 采纳粒度【待裁定 Q1】

**既有实现的粒度是"轨迹级"**：`POST /ai/traces/{id}/adopt` 只把 `t_ai_trace.adopted` 置真，**没有"逐条草稿采纳"的载体**
【依据 IpdAgentService.java:64-69、V35:2-14】。三选一（见 §7.2）：
① 复用 `t_ai_trace`（`citations` 里带条目状态）——**零新表**，但"条目级状态"藏在 JSONB 里，**不可查询、不可对账**；
② **【提案】**新增草稿表（`t_ai_draft` + `t_ai_draft_item`），逐条状态可查、可与 `t_ai_trace` 双向对账；
③ 草稿**只在内存/会话里**，采纳即落任务——实现最轻，但"谁拒绝了哪条、为什么"**无留痕**（与 I6 冲突）。

> 我的建议是 **②**：理由不是"更完整"，而是**可对账**——既有迁移纪律要求"管理类数据必须能对账"（13 号文 G-REC 系列），
> "接受了 5 条、拒绝了 3 条、其中 1 条改了工期"这件事若只存在 JSONB 里，巡检与审计都读不出来。
> 但它是**新表**（需要迁移），所以必须由你裁。

---

## 7. 权限、审计与数据边界

### 7.1 谁能触发

| 动作 | 权限判据（**必须两层都过**） | 依据 |
|---|---|---|
| 触发分解（生成草稿） | 域级 `task.create`（23 个角色）**∩** 对象级 `canAccessObject("task","create", AbacAttrs.of(projectId,null))`（fail-closed，命中 `project member_of`） | 【依据 DB `t_permission_rule`：`task.create` 角色集；PermissionService.java:725-732；V172:55-61】 |
| 查看草稿/引用 | `task.read` + 项目 `member_of`；**引用不可越权**：`T8` 对无权对象返回 `denied_or_notfound`（刻意不透露存在） | 【依据 ResolverController.java:63-67】 |
| 采纳并落库 | 同"触发"（落库动作 = 建任务）；**逐条依赖写**另需 `task.update` | 【依据 TaskController.java:185-201/251-252】 |
| 修订既有任务（不被自动分解触碰） | 不在本设计范围（AI **不改**既有任务） | §10 明确不做 |

> **两个"不做"**：① AI **不自动分派人**（只给建议，分派是 `task.assign`/`task.transfer` 的治理动作）；
> ② AI **不越过权限直写**——所有写动作都在"人确认"之后由后端以**触发者身份**执行。

### 7.2 草稿是否落库【待裁定 Q1】——三个选项与代价

| 选项 | 数据形态 | 好处 | 代价/风险 |
|---|---|---|---|
| A. **不落库**（草稿仅在响应与会话里） | 无新表 | 最轻、零迁移 | 拒绝理由/采纳轨迹**无留痕**；刷新即失；与 I6"可解释"只能做到"当次" |
| B. **落草稿表**（`t_ai_draft`/`t_ai_draft_item`，逐条状态） | 2 张新表 + 迁移 | **可查、可对账、可回溯**；支持"改了再接受"与"部分接受" | 需迁移 + 权限点 + 归档策略（否则草稿无限累积） |
| C. **只落 `t_ai_trace`**（复用现有 1 张表） | 无新表（`citations` JSONB 承载条目） | 零迁移、与既有 AI 一致 | 条目级不可查询/不可对账（13 号文 G-REC 口径下"数据在但读不出"） |

**默认建议**：B；**若"先跑通再谈留痕"**，则先用 C 并在文档里登记"条目级采纳不可对账"作为已知缺口（**不得**默认成 A 后无声无息）。

### 7.3 审计链（逐条对齐既有表）

```
触发者 ──POST /ai/agents/task_decompose──► t_ai_trace 1 行
   agent / question(=输入摘要) / question_hash / answer / citations(JSONB) /
   model_version / prompt_hash / adopted(是否采纳) / actor(触发者) / created_at
        │                                    【依据 V35:2-14；IpdAgentService.java:146-159】
        ▼
（按 §7.2 选项）草稿表：draft_id / trace_id / item 逐条状态(ACCEPTED|EDITED|REJECTED) / reason
        │
        ▼
POST /tasks × N + POST /tasks/{id}/deps × M
        │  ⇒ 每条写动作进既有审计（t_audit_log 只增不改）
        ▼
t_project_task(created_by=触发者, version=1) + t_task_assign + t_task_dep
```

**审计要点**：① `t_ai_trace` 是**只增**表（无 UPDATE 语义，除 `adopted` 标志位）；
② 落库任务的 `created_by` 是**触发者**，不是"AI"（AI 不是主体，不变量 I1）；
③ 【提案】`answer` 里保存**可读摘要**（人读），结构化草稿存草稿表或 `citations`（机器读），**两者不互相替代**；
④ **模型版本入配置管理**（升级视同软件变更）是既有要求【依据 04 号文 §6/§7.2】，而 `t_model_version` **当前不存在**
（DB 实读 0 张）⇒ 一期只能靠 `t_ai_trace.model_version` 常量（`plm-agent-r1`）回溯，**如实登记为缺口**。

### 7.4 数据边界（模型输入里不得出现什么）

| 禁项 | 机制 |
|---|---|
| 触发者**不可见**的项目/任务/需求 | 工具取数一律经既有读面（ABAC fail-closed）；`TASK` 检索强制 `projectId`，不存在/不可见**同码同文案** |
| 他人隐私/凭据类数据 | 不提供任何 `_admin/*`、`_me` 类工具；模型上下文只含**业务对象**（任务/需求/交付物/名册 login） |
| 引用"未授权对象" | `T8` 返回 `denied_or_notfound` ⇒ 判据 C6② `BLOCK`（**无效引用不出条**） |
| 虚构不存在的对象 | 同 C6②（"无引用不回答"的机器化落地） |
| 把"未查重/未折算"说成"已检查" | 降级必须**显式标注**（判据 C3③/C7 的 `WARN 未判`），同 `EmbeddingClient` 的"降级可见"纪律 |

---

## 8. 与既有模块的接口提案（**全部为【提案】**）

### 8.1 端点表

| 方法 | 路径 | 入参 | 响应 | 权限 | 错误码 |
|---|---|---|---|---|---|
| POST | `/api/v1/ai/agents/task_decompose` | `{projectId, requirementIds[]?, phases[]?, options{maxTasks?, includeDeps?, includeAssignees?}}` | §2.2 草稿 JSON（含 `traceId`/`refused`） | 【提案】`task.create`（**不沿用既有 AI 入口的无注解形态**） | `TASK_PROJECT_REQUIRED`/`TASK_PROJECT_NOT_FOUND`；`【提案】TASK_DECOMPOSE_NO_INPUT`；`AI_TRACE_FAIL`（既有） |
| POST | `/api/v1/ai/agents/task_decompose/{traceId}/apply` | `{acceptedItemIds[], overrides{按临时键改字段}}` | 逐条回执 `[{tempId, ok, taskId?, taskCode?, errorCode?, message?}]` | 【提案】`task.create`（逐条仍走服务层校验） | 逐条复用既有 `TASK_*` 码（§3.1） |
| GET | `/api/v1/ai/agents/task_decompose/{traceId}` | — | 草稿 + 引用解析态 + 判据结果 | 【提案】`task.read` + 项目可见 | `AI_TRACE_NOT_FOUND`（既有） |
| POST | `/api/v1/ai/traces/{id}/adopt` | — | `{traceId, adopted:true}` | **既有（无注解，见 §3.2 缺口）** | `AI_TRACE_NOT_FOUND`（既有） |
| GET | `/api/v1/_platform/task-templates` | `phase?/medClass?/market?` | 模板条目 | 【提案】`task.read` | 【提案】空 ⇒ 200 空列表 + `note` 说明原因 |
| POST/PUT | `/api/v1/_platform/task-templates` | 模板条目 | 条目 | 【提案】【待裁定 Q4】：新增 `task.template.manage`（**不改既有 8 枚**），角色面与配置类权限对齐 | 【提案】`TASK_TEMPLATE_*` |

> **接口纪律**（照抄 18 号文 E 错误契约 / 08 号文分页契约）：
> ① 列表一律走标准分页对象（**分页是展示口径，导出是取全量**）；
> ② 错误响应的 `code` 必须是**机读常量**、`message` 指向**可行动作**（如"请在目标父任务下新建子任务"这种既有写法）；
> ③ 合法值清单（任务类型/状态/进度口径）**从元数据读**，不在前端另写一份。

### 8.2 与"落库"相关的既有契约复用（逐字对齐，不新造）

- 建任务：`POST /api/v1/tasks`，入参 = `CreateReq(projectId, parentId, taskType, name, description, plannedStart, plannedDue, plannedHours, sortNo, milestone, ownerLogin, progressMode, orgId, productLineId)`【依据 TaskDtos.java:28-43、TaskController.java:251-252】
- 加/改/删依赖：`POST|PUT|DELETE /api/v1/tasks/{id}/deps[/{depId}]`（权限 `task.update`）【依据 TaskController.java:185-201】
- 任务树读取：`GET /api/v1/tasks/tree`；甘特：`GET /api/v1/tasks/gantt`（`deps` 随行下发）【依据 TaskController.java:65-66、128-129】
- **改父不支持**：`UpdateReq.parentId` 与现值不同时**显式拒绝** `TASK_PARENT_CHANGE_UNSUPPORTED`（用户裁定）
  【依据 TaskService.java:837-848】⇒ 草稿**不得**表达"把既有任务挪到别处"，只能表达"新建"。

---

## 9. 分期落地计划

> 人日为**粗估**（含设计对齐、实现、迁移、判据、真浏览器走查），不含业务侧的数据准备工时（§2.1 第 5/6 项）。

| 期 | 目标 | 交付物 | 验收断言（可机检） | 粗估 |
|---|---|---|---|---|
| **P1 规则版分解（先闭环）** | 无 LLM 也能生成可用 WBS 草稿 | ① 任务模板表【提案】+ 迁移；② `task_decompose`（规则引擎 + 模板 + 交付物基线）；③ 判据 C1–C7 的机检实现；④ 草稿评审网格（08 号文口径）；⑤ 落库走既有服务 | A. 直连接口：证据为空 ⇒ `refused=true` 且 `tasks==[]`；B. 覆盖度断言：`critical_path` 交付物缺口集为空；C. 反例：构造成环依赖 ⇒ `BLOCK` 且可读原因含编号链；D. 落库后逐条断言 `t_project_task.status='DRAFT'` 且 `created_by=触发者`；E. 权限：非成员触发 ⇒ 403/404（不得泄露项目存在）；F. 残留自证：夹具项目/任务/依赖回收 0 | 12–18 |
| **P2 模板与日历接入** | 工期与排期"有依据" | ① 模板维护页（配置类权限）；② 工作日历数据接入（**需用户给节假日**）+ 工期按工作日折算；③ 判据 C2/C5 升级为硬判（有基准时） | A. 给 3 个节假日样本 ⇒ 折算断言（跨节假日工期 +N 天）；B. 无日历时行为不变且**显式标注"未折算"**；C. 超配样本 ⇒ `WARN` 且给出具体日期与被挤占的人 | 8–12 |
| **P3 LLM 增强（provider 接入）** | 提升"从自然语言需求到任务"的质量 | ① provider 适配（DSH subagent 或私有 vLLM，【待裁定 Q2】）；② 降级开关与状态可见（照抄 `EmbeddingClient` 三律）；③ 提示词版本化（`prompt_hash` 已在表内） | A. 关掉 provider ⇒ 自动回落 P1 规则版且响应体标注降级；B. 状态可查（能力端点暴露"最近成功/失败/模型名"）；C. 同一输入的两次调用 `prompt_hash` 一致（提示词未被运行时污染） | 10–15 |
| **P4 逐条采纳与对账** | 采纳轨迹可查、可对账 | ① 草稿表（§7.2 选 B 时）+ 逐条状态；② 巡检/对账条目（草稿 vs 落库任务条数守恒）；③ 模型版本登记（若引入真模型） | A. 接受 3 / 拒绝 2 ⇒ 草稿表 5 行状态正确、`t_project_task` 恰好 +3；B. 对账断言：`count(ACCEPTED) == count(新建任务)`；C. 拒绝理由可检索 | 6–10 |

**合计粗估**：**36–55 人日**（不含数据准备）。**最小可用切片 = P1**（无 LLM、无日历、模板内置），
理由是它把**不变量 I1/I2/I4/I5** 全部跑通，且**不依赖任何外部模型与缺失数据**——
与既有 `IpdAgentService`（一期 = 规则聚合引擎）的落地路径一致【依据 IpdAgentService.java:22-23】。

---

## 10. 风险与明确不做

### 10.1 风险清单（含触发条件与缓解）

| # | 风险 | 触发条件 | 缓解（设计内） |
|---|---|---|---|
| R1 | **幻觉任务**（拆出库中不存在依据的条目） | 模型编造 rationale/引用 | 判据 C6：引用必须经 `T8` 解析为 `ok`，否则 `BLOCK`；"无引用不回答"（I2）在**条目级**再落地一次 |
| R2 | **样本不足导致"学历史"退化成"编"** | DEV `t_project_task` 仅 5 行人工数据 | 历史信号**只作排序辅助**、不作为主要证据；一期以**模板 + 交付物基线**为主依据；草稿显式标注"依据来源" |
| R3 | **工期估算不可靠** | 无历史工时（`t_task_hours` 0 行、无写接口） | 一期工期**来自模板**而非模型猜测；模型不得输出"精确到天"的臆测值（无模板 ⇒ 留空并标 `WARN`） |
| R4 | **日历/产能空表导致排期是"自然日"** | `t_work_calendar`/`t_capacity` 0 行 | 空表时**不折算、不硬判**，草稿上**显式标注"未按工作日历折算"**；数据由用户给（【待裁定 Q5】） |
| R5 | **模板缺失使 P1 无依据** | `t_template*` 不存在 | P1 先落**内置模板 + 迁移**（【提案】），并把"模板从哪来"作为 P1 的验收项（不得靠 prompt 里写死清单） |
| R6 | **AI 入口无权限点**（既有缺口） | `IpdAgentController` 三个端点无 `@PreAuthorize` | 本设计**不沿用**：新入口必须挂权限点（§8.1）；**既有缺口建议单独立项收口**（不在本报告范围） |
| R7 | **长任务/超时** | 大项目分解耗时长 | 与 16 号文 SLO 对齐；超时必须有**明确的"未完成"回执**（不得返回半份草稿当完整）；必要时异步化（04 号文 §9 的异步任务形态，但该表 `t_ai_task` **当前不存在**，需另议） |
| R8 | **模型版本漂移** | 换模型/换版本 | `t_ai_trace.model_version` +（P4）模型版本登记；升级视同软件变更（04 号文 §7.2） |
| R9 | **一次性生成过多** | 大项目几百条 | 【待裁定 Q3】单次条数上限 + 分页/分层生成（先"阶段级骨架"再"逐阶段展开"） |

### 10.2 明确不做（避免被当成漏做）

| 不做 | 理由（有依据的给依据） |
|---|---|
| **不自动改期 / 不自动顺延依赖** | 依赖"只画线 + 提示"是既有裁定；本设计只**检查**日期一致性（C3③）并提示，不改既有任务日期 |
| **不自动分派人** | 分派是治理动作（`task.assign`/`task.transfer` 属角色面）；AI 只给**建议**并受"必须 ∈ 项目名册"约束 |
| **不越过权限直写库** | 不变量 I4（V167 自证⑦：任务必须走服务进审计链） |
| **不自动签署 / 不作为签署主体** | BR-20 六铁律之一【依据 04 号文 §6】 |
| **不移动/删除既有任务、不改父** | `TASK_PARENT_CHANGE_UNSUPPORTED` 是用户裁定【依据 TaskService.java:837-848】；删除另有 `TASK_DELETE_FORBIDDEN_*` 系列守卫 |
| **不做成本核算 / 敏捷看板** | 无需求证据（既有裁定） |
| **不做"AI 自动完成 OP 拆除的另一半"**（遗留问题复查任务的出站承接） | 与任务分解是两件事，需独立设计（出站承接现状：`OPEN_ISSUE_CREATED → kcp.createReviewTask`，OP 拆除后该端口需替换）【依据 PmsIntegrationHandler.java:49-57】 |
| **不改任何既有文档/迁移/产品代码（本报告自身边界）** | 用户对本报告的要求：只写文档 |

---

## 附录 A · 本报告引用的事实与取证位置（人可复核）

| 事实 | 取证 |
|---|---|
| 任务表/字段/CHECK（含 `task_code` 形状、计划窗、`planned_hours`、`version`、归属列） | `V167__task-domain-foundation.sql:66-132`（自证见同文件 357-716） |
| 任务状态值域改为 5 态、`progress_percent`、`auto_closed`、`description`；`t_task_comment` | `V170__task-model-realign.sql:41-51/68-71/103-115/198` |
| 权限点 8 + 2 枚、任务域角色集与反向对照 | `V168__task-permission-points.sql:23-40`；`V171`（`task.progress`）、`V174:59-63`（`task.transfer`） |
| ABAC：`TASK.read` 15 条、`TASK.write` 25 条（含 3 条 owner self） | DB `t_role_abac` 实读；`V169`/`V172`/`V173` |
| `canAccessObject` fail-closed、admin 与治理动作短路、`abacActionFor` | `PermissionService.java:483/700-732/776-781` |
| 依赖四类、lag 范围、环检测（BFS + 前驱回溯）、错误码 | `TaskService.java:1763-1800/1801-1849`；`V167:172-184` |
| 父窗口守卫、跨项目、WBS 环 | `TaskService.java:1849-1960` |
| 改父显式拒绝（用户裁定） | `TaskService.java:837-848` |
| 任务接口全集与权限注解 | `TaskController.java:24-281` |
| `CreateReq` 字段 | `TaskDtos.java:28-43` |
| AI 五 agent / 拒答 / 采纳单通道 / `t_ai_trace` 写入 | `IpdAgentService.java:14-69/146-159`；`IpdAgentController.java:10-26`；`V35__ai-trace.sql:2-14` |
| 降级三律（含 9 天静默事故） | `EmbeddingClient.java:22-38` |
| 查重服务与阈值口径 | `DedupController.java:14-34`；`docs/plm-tech/10-语义查重与AI查重服务设计.md §2.5/§2.6/§3` |
| 引用解析三态与"不区分存在性" | `ResolverController.java:27-71` |
| `TASK` 检索必须带 `projectId` | `LookupService.java:250-260` |
| 交付物模板/实交付字段与阶段值域、阶段门退役 | `V126__deliverable-baseline.sql:40-79`；`V7__item-bom-change.sql:184-194` |
| 需求字段与树 | `V1__schema.sql:55-84` |
| 工作日历/产能/工时表结构与"不填种子"纪律 | `V167:195-303` |
| OP 承接现状（项目骨架/复查任务） | `PmsIntegrationHandler.java:41-57`；`ProjectLifecyclePort.java:9-21`；`docs/plm-tech/ipd-extension/01-现状盘点.md:65`；`docs/plm-user-guide/03-项目管理与评审门.md:4` |
| 运行库实际行数（评审/任务/日历/AI 轨迹等） | 本报告编写时的 DB 实读：`t_project_task`=5、`t_task_assign`=5、`t_task_dep`=2、`t_task_hours`=0、`t_capacity`=0、`t_work_calendar`=0、`t_deliverable`=51、`t_deliverable_template`=155、`t_ai_trace`=21、`t_project_member`=51、`t_requirement`=2258、`t_search_index`=4077；**不存在**：`t_template*`、`t_skill`、`t_user_skill`、`t_knowledge_chunk`、`t_model_version`、`t_ai_task`、任何草稿表（`%draft%` 无匹配） |
| 迁移头 | `flyway_schema_history` 最大版本 = **174**（本报告基于 V174 口径） |

## 附录 B · 未在仓内找到依据（需确认，**不猜**）

1. 【未找到依据】**"OP 拆除"的具体范围与时间表**：仓内只见"PLM 原生承接"的**方向性**材料与 OP 集成现状；拆除的**范围/停用日期/数据迁移范围**未见权威文档 ⇒ 需你确认（影响 §9 的排期紧迫度，不影响设计本身）。
2. 【未找到依据】**"任务模板"的业务内容**：模板应含哪些字段、由谁维护、是否按产品线/市场分档——仓内**零实现**（`t_template*` 不存在）⇒ 需业务给首版模板（否则 P1 只能给"内置最小集"）。
3. 【未找到依据】**`t_gate_map` 11 行的处置**：阶段门已退役但表与端点仍在 ⇒ 是否清理，**未在仓内找到裁定记录**。
4. 【未找到依据】**历史"同类项目"的判定口径**：什么算"同类"（产品线？市场？器械类别？规模？）——仓内无定义。
5. 【未找到依据】**人日口径**：本仓是否存在标准人日估算基线（如 05 号文的工作包估算口径）——本次未核实，P1–P4 的人日为**粗估**。
6. 【未找到依据】**模型/提供商**：企业可用的模型清单、是否允许外网 API——仓内只有 04 号文的**目标态**描述，无当前可用清单。

## 附录 C · 与 10/11 号文的契约对齐（同形，不另立一套）

| 维度 | 10 号文（AI 查重） | 11 号文（检索/索引） | 本设计（任务分解） |
|---|---|---|---|
| 能力缺失时的行为 | 向量层缺席 ⇒ **降级 SimHash**，公式与阈值**不变** | 嵌入不可用 ⇒ 回落词法层（**不阻断**） | provider 不可用 ⇒ 回落**模板 + 规则**分解，判据口径不变 |
| 状态可见性 | 判定结果带 `method`（`EXACT/SIMHASH/TOKEN/HYBRID`） | `/capabilities` + 健康指示器暴露降级 | 草稿带 `qualityFlags`/`checks`，并标注"未折算/未查重/无基准" |
| 阈值/权重纪律 | 公式权重不得随意改；加守卫不得顺手调阈值 | POC 结论：向量仅作召回增强 | 判据阈值（K、条数上限等）**集中一处**、改动需裁定（【待裁定 Q3】） |
| 结论的用法 | `DUPLICATE` 驱动**人**做处置；软提示不阻断写入 | 检索结论供人参考 | 草稿只是**建议**；采纳是人单通道（I1） |
| 人工确认 | 详情面板候选 + 重新查重 | — | 草稿评审网格 + 逐条接受/拒绝（§6.3） |
| 审计 | 判定可回溯（命中字段） | 索引重建/一致性可查 | `t_ai_trace` + 引用可解析（§7.3） |

---

## 11. 待裁定清单（开工前必须定，**共 5 条**）

| # | 待裁定 | 选项 | 不裁定的后果 |
|---|---|---|---|
| **Q1** | **草稿是否落库**（§7.2） | A 不落库 / B 落草稿表（**建议**）/ C 只落 `t_ai_trace` | 不裁定就无法设计"逐条采纳"与对账；若默认成 A，"谁拒绝过哪条"永久无痕 |
| **Q2** | **Agent 用哪个 provider**（§3.4） | A 一期规则引擎 `plm-agent-r1`（**建议打底**）/ B DSH subagent / C 私有 vLLM（或 B/C 作增强层） | 不裁定就只能按 A 设计，P3 的排期与依赖（GPU/网关）无法确定 |
| **Q3** | **分解粒度与规模上限** | 粒度：几层（建议"阶段→任务→子任务"三层为界）；规模：单次条数上限（建议 50 条，超出分层生成） | 无上限会让大项目一次生成数百条草稿，评审网格不可用 |
| **Q4** | **是否新增权限点** | 默认**复用** `task.create`（触发/落库）与 `task.update`（依赖）；模板维护建议新增 `task.template.manage`（【提案】，角色面与配置类权限对齐） | 不裁定则模板维护只能走 SQL（违反"配置即数据"的既有方向） |
| **Q5** | **谁给两处缺失数据** | ① 工作日历（节假日，公司级事实）；② 团队技能（词表 + 逐人技能）；另：首版**任务模板**的业务内容 | 无日历 ⇒ 工期只能按自然日（判据 C2 无法硬判）；无技能 ⇒ 主责建议只能基于名册与角色 |

> 其中 **Q1/Q2/Q3** 是开工前最有决定性的三条（见本报告交付摘要）。

---

*本文档为设计报告（不含实现）。开工前请先裁定 §11 的 Q1–Q5，并补齐 §2.1 的两处数据缺口（工作日历、团队技能）。*
