# 核心实体：文档 / 变更 / 评审门 / 任务（entities-change-review）

> 表头固定为 `| ID | 实体 | 承载表 | Java 承载 | 关键字段与逻辑 ID 口径 | 性质 | 保证 | → 指针 |`。`性质`/`保证` 口径见 `interfaces/README.md` §③；本片全部 `as-built` + `def:同指针`。**以代码为真身**（`ontology/README.md` §3.3）。
> 本片是 `ontology/entities.md` 分片组的第 2 部分。分片组：本文｜`entities.md`（项目/需求/物料/BOM/产品）｜`entities-risk-pv.md`（风险/注册/产品包/IPD/财务/上市后/跨域口径）。
> **读法提醒**：本片的文档域 / 变更域 / 评审域 / 任务域**全部无 JPA 实体**（除 `document`、`change` 两个包），「Java 承载」列写的是 Service 或 Entity——两者**不是一回事**。

## 1. 文档 / 变更（ECR-ECO-ECN）/ PCO

| ID | 实体 | 承载表 | Java 承载 | 关键字段与逻辑 ID 口径 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E-015 | 文档主档 | `t_document` | `DocumentEntity`（JPA） | 逻辑 ID = `doc_no` UNIQUE；**状态不在主档、在版本行**（`V18:7` 注释）——这是文档域的核心口径；`item_id`/`product_id` **无 FK**，是逻辑引用 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/document/DocumentEntity.java#DocumentEntity |
| E-016 | 文档版本 | `t_doc_rev` | `DocRevEntity`（JPA） | `rev` A/B/C…；`UNIQUE(doc_id, rev)`；`released_by`/`released_on` 是受控发布的落点（BR-13） | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/document/DocRevEntity.java#DocRevEntity |
| E-017 | DHF/DMR 章节 | `t_dhf_section` | `DhfSectionEntity`（JPA） | **唯一定义用 `code TEXT PRIMARY KEY`，不是 BIGSERIAL**（`DHF-01..08` / `DMR-01..05`）；`kind` ∈ {DHF, DMR} | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V18__document-registration.sql#t_dhf_section |
| E-018 | 变更申请 ECR | `t_ecr` | `EcrEntity`（JPA） | 逻辑 ID = `ecr_code` UNIQUE；`source` ∈ {CAPA, PCN, IMPROVE, COST, REG, COMPLAINT}（与上市后域互相引用） | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/change/EcrEntity.java#EcrEntity |
| E-019 | 变更单 ECO | `t_eco` | `EcoEntity`（JPA，`@Version`） | 五维评估 `eval_tech`/`eval_reg`/`eval_risk`/`eval_vv`/`eval_mfg` **各一列 JSONB**，每维内含 status+assessor+signed_on；`ccb_result` 三值；`version` 走 JPA `@Version` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/change/EcoEntity.java#EcoEntity |
| E-020 | 变更通知 ECN | `t_ecn` | `EcnEntity`（JPA） | `eco_id` FK **NOT NULL**（一个 ECO 必有 ECN）；`targets` JSONB 下发目标；回执闭环在 `t_ecn_receipt`，`UNIQUE(ecn_id, target)` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/change/EcnEntity.java#EcnEntity |
| E-021 | ECR/ECO/ECN 的三层关系 | `t_ecr` → `t_eco.ecr_id` → `t_ecn.eco_id` | 同上 | **关系用真外键，JSONB 只放属性不放关系**（`V7:4` 头部原则）；三层各自独立发号，各有 UNIQUE 业务码 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V7__item-bom-change.sql#t_eco |
| E-022 | 项目变更单 PCO | `t_pco` | `PcoService`（**无 JPA**，JdbcTemplate） | 逻辑 ID = `pco_code` UNIQUE；`before_json` 由服务端**自动快照**；`impact_assessed` 进 SUBMITTED 前必须 TRUE；`RESOURCE` 类别保留词表但服务端返 `PCO_CLASS_NOT_IMPLEMENTED` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V203__project-change-order-pco.sql#t_pco |
| E-023 | PCO 门禁影响面 | `t_pco_gate_impact` | `PcoGateImpactService`（**无 JPA**） | `auto_hit` = true 规则算出 / false 人工追加留痕；`UNIQUE(pco_id, gate_code)` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V203__project-change-order-pco.sql#t_pco_gate_impact |

## 2. 评审门 / 任务书 / 任务

| ID | 实体 | 承载表 | Java 承载 | 关键字段与逻辑 ID 口径 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E-024 | 统一评审 | `t_review` | `ReviewService`（**无 JPA**，JdbcTemplate） | 逻辑 ID = `review_code` UNIQUE；`conclusion` 的 CHECK **按 `review_type` 隔离取值域**（DCP 四值 / TR 三值）；`precheck_result` 是机器预审 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V24__review-domain.sql#t_review |
| E-025 | 评审清单项 | `t_review_item` | 同上 | `judge_role` → 允许角色集查 `JudgeRoleMatrix`（唯一定义处）；`UNIQUE(review_id, item_no)`；`conclusion` 只有 PASS/COND/FAIL（**项只属 TR 门**） | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V24__review-domain.sql#t_review_item |
| E-026 | 门点字典 | `t_gate_map` | `GateMapService`（**无 JPA**） | `seq` **全局 UNIQUE**（`V185:92`）⇒ 门序是严格全序、不得并列；`old_gate_code` 是 G1..G7 的双写映射；`blocks_dcp` 是 IBR-01 TR 阻断关系 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/review/GateMapService.java#load |
| E-027 | 旧阶段门（并存） | `t_gate` / `t_gate_check` / `t_project_gate` / `t_gate_result` | `GateEntity` 等（JPA **仍在**） | **双轨制**：旧表仍在库并有实体，通过只读视图 `v_gate_legacy` 兼容（`V24:183`）；`t_gate_map` 是新旧门之间的桥。**退役程度未核实**（冲突簿 C-020） | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V24__review-domain.sql#v_gate_legacy |
| E-028 | 任务书 | `t_charter` | `CharterService` / `IpdModelService`（**无 JPA**） | 逻辑 ID = `charter_code` UNIQUE；`fin_estimate` 登记时标 `sec_level='SECRET'`；评审反向引用走 `t_review.charter_id`（**逻辑引用，无 FK**）；`status` **无 DB CHECK** | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V23__ipd-model.sql#t_charter |
| E-029 | 业务计划书 | `t_biz_plan` + `t_biz_plan_rev` | `IpdModelService`（**无 JPA**） | **头 + 版本两层，只有版本行有 `status`**；`project_id` 可空（立项前先行编写）；`bound_review_id` 绑定 DCP | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V23__ipd-model.sql#t_biz_plan_rev |
| E-030 | 计划任务（WBS 节点） | `t_project_task` | `TaskService`（**无 JPA**，JdbcTemplate） | 逻辑 ID = `task_code` UNIQUE 且 CHECK 正则 `^TASK-[0-9]{4}-[0-9]{4,}$`；`version` 是并发版本**不是业务版本**；`owning_org_id`/`owning_product_line_id` **明确不作授权判据** | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V167__task-domain-foundation.sql#t_project_task |
| E-031 | 任务分配 | `t_task_assign` | 同上 | `UNIQUE(task_id, assignee_login)` ⇒ **改派 = 更新该行，不新增**；`is_primary` 有部分唯一索引 ⇒ 一个任务只有一个主责 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V170__task-model-realign.sql#t_task_assign |
| E-032 | 流程待办 | `t_flow_task` | `FlowTaskService` | **状态机才是事实源，`t_flow_task` 是可从对象状态重建的衍生视图**（`V38:2`）；DB 侧**无 `org_id` 列**；`mode` ∈ {ASSIGNED, CANDIDATE}（认领制） | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V38__flow-task.sql#t_flow_task |
| E-033 | 两类任务不可合并 | `t_project_task` vs `t_flow_task` | 同上 | 前者 = 项目计划里的工作项（工期/工作量/甘特）；后者 = 处理某对象的待办。**生命周期节拍不同，合表后状态机无法自洽** | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V38__flow-task.sql#t_flow_task |
