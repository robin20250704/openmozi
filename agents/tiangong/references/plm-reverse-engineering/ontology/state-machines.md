# 状态机与迁移（ontology 树 · 声明层）

> 表头固定为 `| ID | 状态机 | 状态取值 | 初始 → 终态 | 边 | 守卫口径 | 可编辑状态集 | 性质 | 保证 | → 指针 |`（**同一分片内所有表必须同宽**——`selfcheck` 按**最后一个** `ID` 表头定位 `性质`/`保证` 列，列数不一致会整片判不合格）。
> `性质`/`保证` 口径见 `interfaces/README.md` §③；本片全部 `as-built` + `def:同指针`。
> **证据纪律**：所有 `文件:行号` 以直读磁盘为准。本仓 `read` 工具曾对 `SubstituteService.java` 返回陈旧版本（496 行旧版 vs 磁盘 524 行新版），行号全错。

## 1. 口径先说清三条（不然下表会被误读）

1. **YAML 里没有「初始态 / 终态」字段**。`FlowEngine.load()`（`platform/flow/FlowEngine.java:26-138`）只读 `flow`/`label`/`states`/`transitions`/`editableStatuses`/`attachmentStatuses`/`ownerTransferStatuses`，**不解析任何 initial/final/type**。
   下表的「初始 → 终态」一律**由图结构推出**：入度 0 = 初始态；出度 0 = 终态。**这是推论，不是 YAML 的显式声明**。
2. **`cond` 不被解析**。引擎实际解析的边级字段只有 `from`/`to`/`label`/`rework`/`roles`/`guards`/`signers`/`join`/`countersign`/`task{mode,assigneeFrom,candidateRole,dueDays}`/`requires[{field,label}]`/`reason`/`ownerOnly`/`gate`。
   全部 23 个 YAML 里**没有任何一条边**使用 `cond`/`guards`/`signers`/`join`/`countersign`（`pco-flow.yaml:34-35` 自述此事实）。
3. **「守卫口径」列的三个数**依次是「角色门边数 / 理由门边数 / 守卫写在边上的边数」。真正的业务前置（五维签齐、CCB 授权、变更窗口等）**大多不在边字段里，而在服务层**——那是 `business-rules` 树的地盘，本片不重复声明。

## 2. 表 A：23 台状态机（S-001~S-023）

| ID | 状态机 | 状态取值 | 初始 → 终态 | 边 | 守卫口径（角色/理由/边守卫） | 可编辑状态集 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S-001 | 业务计划书版本（bizplan） | WIP / REVIEW / APPROVED / SUPERSEDED | WIP → SUPERSEDED | 4 | 0 / 1 / 0 | WIP, REVIEW | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/bizplan-flow.yaml#states |
| S-002 | BOM 结构状态（bom） | DRAFT / DESIGN / RELEASED | DRAFT → RELEASED | 2 | 0 / 1 / 0 | DRAFT, DESIGN, RELEASED | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/bom-flow.yaml#states |
| S-003 | 纠正预防措施（capa） | PROPOSED / ASSESSED / IMPLEMENTING / VERIFYING / EFFECTIVENESS / CLOSED / REJECTED | PROPOSED → CLOSED, REJECTED | 8 | 0 / 3 / 0 | PROPOSED…EFFECTIVENESS | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/capa-flow.yaml#states |
| S-004 | CBB 成熟度（cbb） | DEV / VERIFIED / RELEASED / MAINT / DECOM | DEV → DECOM | 6 | 0 / 2 / 0 | （空） | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/cbb-flow.yaml#states |
| S-005 | 任务书（charter） | DRAFT / CDT_DEV / PRE_REVIEW / DCP0_REVIEW / APPROVED / REJECTED / HOLD / OBSOLETE | DRAFT → APPROVED, REJECTED, OBSOLETE | 12 | 3 / 3 / 0 | DRAFT, CDT_DEV | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/charter-flow.yaml#states |
| S-006 | 投诉（complaint） | NEW / ASSESSED / CONVERTED / CLOSED / REJECTED | NEW → CLOSED, REJECTED | 6 | 0 / 2 / 0 | NEW, ASSESSED | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/complaint-flow.yaml#states |
| S-007 | 文档（doc） | DRAFT / REVIEW / APPROVED / RELEASED / OBSOLETE | DRAFT → OBSOLETE | 7 | 2 / 2 / 1（`ownerOnly`） | DRAFT | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/doc-flow.yaml#states |
| S-008 | 变更通知（ecn） | PENDING / SENT / ACKNOWLEDGED / CLOSED | PENDING → CLOSED | 3 | 0 / 0 / 0 | PENDING | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/ecn-flow.yaml#states |
| S-009 | 变更单（eco） | DRAFT / EVALUATING / CCB_REVIEW / APPROVED / IMPLEMENTING / VERIFYING / CLOSING / CLOSED / CANCELLED | DRAFT → CLOSED, CANCELLED | 9 | 0 / 2 / 0 | DRAFT | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/eco-flow.yaml#states |
| S-010 | 变更申请（ecr） | OPEN / TRIAGED / TO_ECO / CANCELLED / CLOSED | OPEN → CANCELLED, CLOSED | 5 | 0 / 2 / 0 | OPEN, TRIAGED | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/ecr-flow.yaml#states |
| S-011 | 物料（item） | WIP / REVIEW / RELEASED / CHANGING / PHASEOUT / OBSOLETE | WIP → OBSOLETE | 8 | 0 / 1 / 0 | WIP, CHANGING | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/item-flow.yaml#states |
| S-012 | 产品包（offering） | DRAFT / ACTIVE / RETIRED | DRAFT → **无终态** | 4 | 4 / 0 / 0 | DRAFT | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/offering-flow.yaml#states |
| S-013 | 遗留问题闭环（openissue） | OPEN / VERIFYING / CLOSED / OVERDUE / **VOID（作废）** | OPEN → CLOSED, VOID | 9 | 0 / 4 / 0 | OPEN | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/openissue-flow.yaml#states |
| S-014 | 项目变更单（pco） | DRAFT / SUBMITTED / APPROVED / REJECTED / IMPLEMENTING / CLOSED / CANCELLED | DRAFT → CLOSED, CANCELLED | 7 | 2 / 3 / 0 | DRAFT | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/pco-flow.yaml#states |
| S-015 | 产品（product） | 概念 / 设计 / 样机验证 / 注册申报 / 量产 / 退市 / 作废 | 概念 → 退市, 作废 | 7 | 5 / 2 / 6（`task`+`gate`） | 概念, 设计, 样机验证 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/product-flow.yaml#states |
| S-016 | 项目（project） | 立项 / 概念 / 计划 / 开发 / 验证 / 注册申报 / 设计转换 / 上市 / 维护 / 退市 / 已终止 | 立项 → 退市, 已终止 | 9 | 9 / 0 / 9（`task`） | 立项, 概念, 计划 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/project-flow.yaml#states |
| S-017 | 召回（recall） | PLANNED / INITIATED / EXECUTING / COMPLETED / CLOSED / ABORTED | PLANNED → CLOSED, ABORTED | 6 | 0 / 2 / 0 | PLANNED…COMPLETED | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/recall-flow.yaml#states |
| S-018 | 注册证照（reg） | PREPARING / SUBMITTED / SUPPLEMENT / APPROVED / RENEWAL / EXPIRED | PREPARING → EXPIRED | 10 | 0 / 2 / 0 | PREPARING, SUBMITTED, SUPPLEMENT | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/reg-flow.yaml#states |
| S-019 | 需求基线（req-baseline） | DRAFT / APPROVED / ARCHIVED / OBSOLETE | DRAFT → OBSOLETE | 6 | 6 / 4 / 0 | DRAFT | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/req-baseline-flow.yaml#states |
| S-020 | 需求（requirement） | PROPOSED / ANALYZED / APPROVED / SOLUTION_DEFINING / IMPLEMENTED / VERIFIED / ACCEPTED / CLOSED / OBSOLETE | PROPOSED → CLOSED, OBSOLETE | 16 | 12 / 7 / 5（`task`+`requires`） | PROPOSED, ANALYZED, SOLUTION_DEFINING | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/requirement-flow.yaml#states |
| S-021 | 复用分析（reuse-analysis） | WIP / APPROVED / RETRACTED | WIP → RETRACTED | 3 | 0 / 2 / 0 | （空） | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/reuse-analysis-flow.yaml#states |
| S-022 | 业务风险台账条目（riskledger） | OPEN / VERIFYING / ACCEPTED / CLOSED | OPEN → **无终态** | 5 | 0 / 2 / 0 | OPEN, VERIFYING, ACCEPTED | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/riskledger-flow.yaml#states |
| S-023 | 计划任务（task） | DRAFT / IN_PROGRESS / BLOCKED / DONE / CANCELLED | DRAFT → CANCELLED | 11 | 10 / 5 / 0 | DRAFT, IN_PROGRESS, BLOCKED | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/task-flow.yaml#states |

