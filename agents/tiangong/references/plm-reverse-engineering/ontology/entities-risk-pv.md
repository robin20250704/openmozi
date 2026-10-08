# 核心实体：风险 / 注册 / 产品包 / IPD / 财务 / 上市后 / 跨域口径（entities-risk-pv）

> 表头固定为 `| ID | 实体 | 承载表 | Java 承载 | 关键字段与逻辑 ID 口径 | 性质 | 保证 | → 指针 |`。`性质`/`保证` 口径见 `interfaces/README.md` §③；本片全部 `as-built` + `def:同指针`。**以代码为真身**（`ontology/README.md` §3.3）。
> 本片是 `ontology/entities.md` 分片组的第 3 部分。分片组：`entities.md`（项目/需求/物料/BOM/产品）｜`entities-change-review.md`（文档/变更/评审门/任务）｜本文。

## 1. 风险 / 注册 / 产品包 / IPD / 财务 / 上市后

| ID | 实体 | 承载表 | Java 承载 | 关键字段与逻辑 ID 口径 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E-034 | 风险命中项（引擎侧） | `t_risk_item` | `RiskItemEntity`（JPA） | 业务唯一键 `risk_uid` = `objType:objId:ruleCode` ⇒ **同规则+同对象只更新不重复建行**；这是机器发现器，不是人登记的账 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/platform/risk/RiskItemEntity.java#RiskItemEntity |
| E-035 | 业务风险台账（ISO 14971） | `t_risk_item_ledger` | `RiskLedgerService`（**无 JPA**） | 逻辑 ID = `risk_code` UNIQUE；**`risk_level` = S×P 由系统算、不可人工编辑**（`V87:19-20`）；PMS 校准**保留原判定不覆盖** | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V87__risk-ledger-iso14971.sql#t_risk_item_ledger |
| E-036 | 引擎与台账的关系 | `t_risk_item.rule_code` → `t_risk_item_ledger.source_rule_code` | 同上 | **单向关联**：台账不依赖规则存在（`V87:11-16`）。两个域合用「风险」一词但角色不同——一个是发现器，一个是账本 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V87__risk-ledger-iso14971.sql#t_risk_item_ledger |
| E-037 | 注册证照 | `t_registration` | `RegistrationEntity`（JPA，`@Version`） | 逻辑 ID = `cert_no` UNIQUE；`expire_date` 有 `idx_reg_expire` 索引（BR-19 效期预警）；**效期分级 `EXPIRED/L30/L60/L90/OK` 是查询态计算、不落库** | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/registration/RegistrationEntity.java#RegistrationEntity |
| E-038 | 申报组装 Dossier | `t_reg_dossier` + `t_reg_dossier_item` | `RegDossierEntity`（JPA） | `dossier_no` UNIQUE；章节明细 `UNIQUE(dossier_id, dhf_section)`；`gap_flag` 是 DHF 缺章标记；注册变更回填在 `t_reg_change`（**复用批准文号口径，不另造**） | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V18__document-registration.sql#t_reg_dossier |
| E-039 | 产品包 | `t_offering` | `OfferingEntity`（JPA，`@Version`） | 逻辑 ID = `offering_code` UNIQUE；`product_id` **已被 V22 降级为"由首个 PRODUCT 明细行推导的冗余显示字段"** | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/offering/OfferingEntity.java#OfferingEntity |
| E-040 | 产品包明细行 | `t_offering_line` | `OfferingLineEntity`（JPA） | `ref_type`+`ref_id` 是**多态引用、无 FK**；`UNIQUE(offering_id, line_type, ref_type, ref_id)` 充当幂等键；明细行**无独立业务码** | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V22__offering-lines.sql#t_offering_line |
| E-041 | 管道快照 | `t_pipeline_snapshot` | `PipelineService` / `PmsAdapter`（**无 JPA**） | **以 `V23` 形态为准**（`snapshot_type`/`stage`/`source`/`metrics`）；`V32` 的同名建表因 `IF NOT EXISTS` 是空操作，其 4 列从未落库（冲突簿 C-009） | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V23__ipd-model.sql#t_pipeline_snapshot |
| E-042 | 退市检查单 | `t_eol_plan` | `PipelineService`（**无 JPA**） | `project_id` FK **UNIQUE** ⇒ 一项目一单；IBR-12：全项完成才允许退市生效；配套 `t_termination` 记处置结果 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V32__pipeline-eol.sql#t_eol_plan |
| E-043 | PLM↔PMS 对象映射 | `t_pm_mapping` | `IpdModelService`（**无 JPA**） | `plm_obj` 形如 `PLM:PRJ:PRJ-2026-0001` + `pms_obj` + `mapping_type` ∈ {PROJECT, KCP, TASK} 唯一 —— 双系统关联的唯一载体 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V23__ipd-model.sql#t_pm_mapping |
| E-044 | 财务模型 | `t_fin_model` | `FinModelService`（**无 JPA**） | 表级 CHECK：**至少挂 charter 或 project 之一**（孤立模型无意义，`V81:47`）；`unit_note` 是单位口径声明，**缺单位时数字不可比**；**无独立业务码**，逻辑标识 = `(charter_id\|project_id, version)` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V81__fin-model.sql#t_fin_model |
| E-045 | 投诉 / CAPA / 召回 | `t_complaint` / `t_capa` / `t_recall` | `PvService`（**无 JPA**） | 逻辑 ID 各为 `complaint_code`/`capa_code`/`recall_code` UNIQUE。**三对象独立、用引用串成闭环而非合成大表**（节拍不同：投诉当天 / CAPA 数月 / 召回按天，`V90:13-19`） | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V90__pv-complaint-capa-recall.sql#t_complaint |

## 2. 跨域口径事实（E-046~E-051）

| ID | 实体 | 承载表 | Java 承载 | 关键字段与逻辑 ID 口径 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E-046 | 表命名前缀 | 全部业务表 `t_` 前缀 | — | 206 个迁移文件统一 `t_` 前缀；视图用 `v_`（如 `v_gate_legacy`） | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V1__schema.sql#t_ |
| E-047 | JPA 实体的覆盖边界 | — | 42 个 `@Table`，覆盖 8 个包 | **只有** bom/change/document/registration/item/offering/project/requirement 八个包 + `platform/risk` 三个有实体；其余九包走原始 SQL ⇒ 「Java 承载」列不能一律写"实体类" | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/pco/PcoService.java#PcoService |
| E-048 | 乐观并发的两种载体 | `version` 列 | 3 个 `@Version` 实体 + `OptimisticLock` 16 个调用点 | `@jakarta.persistence.Version` **全仓只有 3 个实体**（ECO/产品包/注册证）；其余 13 域是手拼 `AND version = ?`。**语义一致、载体不同**（冲突簿 C-018） | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/common/OptimisticLock.java#VERSION_GUARD |
| E-049 | 并发版本的读写口径 | `version` 列 | `OptimisticLock.require` | 缺 `version` ⇒ 400 且**一个字都不写**；不一致 ⇒ 409 且**不落库、版本号不变**；成功 ⇒ **恰好 +1**。读面下发的 `version` 必须等于库内真值，否则前端无可回传凭据 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/common/OptimisticLock.java#require |
| E-050 | 业务引用**不靠 DB 外键** | 59 个 `*_id` 形态列 | 应用层 + 对账脚本 | `V146:27` 明写：本库口径是「业务引用不靠 DB 外键守（另有 59 个 `*_id` 形态列同样无 FK）」，改由 `plm-logical-refs.txt` 登记 + `plm-ref-integrity.sh` 巡检兜。**例外**：互替组、BOM 冻结基线、任务依赖等**有**真外键 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V146__doc-type-dictionary-and-enum-authority.sql#t_document |
| E-051 | 命名遗留：状态机 ID 词表 | `t_obj_type.status_machine` | — | `PCO_FSM`/`BOM_FSM` 是**历史命名遗留**，自证 `t_lifecycle` 表并不存在，实际流程 id 是 `pco`/`flows/pco-flow.yaml`。**这两个值不能被读成"状态机 ID"**（冲突簿 C-016） | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V203__project-change-order-pco.sql#t_obj_type |
