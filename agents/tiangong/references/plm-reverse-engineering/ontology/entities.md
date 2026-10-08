# 核心实体：项目 / 需求 / 物料 / BOM / 产品（entities）

> 表头固定为 `| ID | 实体 | 承载表 | Java 承载 | 关键字段与逻辑 ID 口径 | 性质 | 保证 | → 指针 |`。`性质`/`保证` 口径见 `interfaces/README.md` §③；本片全部 `as-built` + `def:同指针`。**以代码为真身**（`ontology/README.md` §3.3）。
> 本片是 `ontology/entities.md` 分片组的第 1 部分——**原为单片，加「性质/保证」两列后超 12 288 B 上限，按业务域拆开**。
> 分片组：本文（项目/需求/物料/BOM/产品）｜`entities-change-review.md`（文档/变更/评审门/任务）｜`entities-risk-pv.md`（风险/注册/产品包/IPD/财务/上市后/跨域口径）。

## 0. 三条读法（不先说清，下表会被误读）

1. **物理主键 ≠ 逻辑 ID**。全库主键是 `BIGSERIAL id`，但对外标识是业务码（`prj_code`/`item_code`/`req_code`…）。
   乐观并发的 UPDATE 一律以**业务码 + version** 定位（`domain/pv/PvService.java:147/369/521`），**不是 id**。
2. **逻辑 ID 与版本号是分离的两件事**（见 `terms.md` T-033）：逻辑 ID 在主档行（`t_item.item_code`），版本在版本行（`t_item_rev.rev`，A/B/C）。引用一律「逻辑 ID + 版本」。
3. **只有 8 个包有 JPA 实体（共 42 个类）**。`pco`/`task`/`review`/`charter`/`ipd`/`pipeline`/`pv`/`finance` 九个包**完全没有实体**，走 `JdbcTemplate` 原始 SQL。
   ⇒ 这些域的「Java 承载」只能写 **Service 类**，**不能写"实体类"**（详见 `entities-risk-pv.md` E-047）。

## 1. 项目 / 需求 / 物料 / BOM / 产品

| ID | 实体 | 承载表 | Java 承载 | 关键字段与逻辑 ID 口径 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E-001 | 项目 | `t_project` | `ProjectEntity`（JPA） | 逻辑 ID = `prj_code` UNIQUE（`PRJ-YYYY-NNNN`）；`product_id` FK 才是权威引用，`product_name` 只是自由文本；`status` 11 态；`version` 乐观并发 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/project/ProjectEntity.java#ProjectEntity |
| E-002 | 项目目标（承诺值） | `t_prj_objective` | `ProjectObjectiveService`（**无 JPA**，JdbcTemplate） | 逻辑 ID = `(project_id, dim_code)` UNIQUE；`dim_code` 外键到 `t_prj_obj_dim`（维度定义可配置）；变更史在只增不改的 `t_prj_objective_rev` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V200__project-objective-and-achievement.sql#t_prj_objective |
| E-003 | 项目目标的版本号 | `t_prj_objective_rev.rev` | 同上 | **与 `t_project.version`（并发版本）语义刻意分离**（`V200:83-84` 注释）——前者是业务承诺版本，后者是并发计数 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V200__project-objective-and-achievement.sql#t_prj_objective_rev |
| E-004 | 需求 | `t_requirement` | `RequirementEntity`（JPA） | 逻辑 ID = `req_code` UNIQUE；`parent_id` 自引用成需求树；`verification`（验证说明）与 `verify_method`（验证方式）是**两列**，勿混 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/requirement/RequirementEntity.java#RequirementEntity |
| E-005 | 需求内容版本号 | `t_requirement.version` | 同上 | **只有内容写 +1，状态流转不再 +1**（V150 D45-5 裁定）⇒ 它是内容版本，不是状态计数 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V150__req-version-and-baseline.sql#t_requirement |
| E-006 | 需求版本快照 | `t_req_version` | `ReqVersionEntity`（JPA） | `rev` 是**快照序号**（每需求从 1 独立递增），**≠ `t_requirement.version`**；`UNIQUE(req_id, rev)`；`content` 全字段 JSONB 快照 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/requirement/ReqVersionEntity.java#ReqVersionEntity |
| E-007 | 需求基线 | `t_req_baseline` | `ReqBaselineEntity`（JPA） | 逻辑 ID = `bl_code` UNIQUE（`RB-YYYY-NNNN`）；**基线范围 = 项目**（`project_id`）；成员引用**快照行 `req_version_id`** 而非需求本体 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V150__req-version-and-baseline.sql#t_req_baseline |
| E-008 | 物料主档 | `t_item` | `ItemEntity`（JPA） | 逻辑 ID = `item_code` **全库全局 UNIQUE，不按项目分域**（`V7:9`）；`current_rev` 是读侧冗余快照；五个法规打标 `is_critical`/`patient_contact`/`reg_declared`/`sterile_flag`/`contains_sw` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/item/ItemEntity.java#ItemEntity |
| E-009 | 物料版本 | `t_item_rev` | `ItemRevEntity`（JPA） | `rev` 是 A/B/C 版本号，`UNIQUE(item_id, rev)`；`std_cost` 由 ERP 回写、**PLM 只读**（`V21:23` + 变更执行字段白名单） | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/item/ItemRevEntity.java#ItemRevEntity |
| E-010 | 互替组（占位件身份） | `t_item.item_class='互替组'` | `SubstituteService`（常量 `SUBSTITUTE_GROUP_CLASS`） | **V210 已把值从 `'虚拟件'` 改为 `'互替组'`**，Java 常量同步改名（`SubstituteService.java:54`）。旧符号 `VIRTUAL_CLASS` **已不存在** | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V210__substitute-group-vocabulary.sql#t_item |
| E-011 | 产品 | `t_product` | `ProductEntity`（JPA） | 逻辑 ID = `prod_code` UNIQUE（`P-YYYY-NNNN`）；`status` 7 态**无 DB CHECK**（见 `state-machines.md` S-031）；`risk_accept_threshold` 是风险残值可接受性的比较基准 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/item/ProductEntity.java#ProductEntity |
| E-012 | BOM 头 | `t_bom` | `BomEntity`（JPA） | `UNIQUE(parent_item_id, bom_view)` ⇒ **一个母件的同一视图只有一个 BOM 头**；`frozen_baseline_id` 是「已发布=已冻结为不可变基线」的落点 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/bom/BomEntity.java#BomEntity |
| E-013 | BOM 结构行 | `t_bom_line` | `BomLineEntity`（JPA） | 唯一键 5 元组 `(parent_item_id, parent_rev, child_item_id, child_rev, bom_view)`；`parent_rev` 是**母件版本**、不是 BOM 版本 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/bom/BomLineEntity.java#BomLineEntity |
| E-014 | BOM 版本记录 | `t_bom_rev` | `BomRevEntity`（JPA） | `rev`；升版 `reason` 服务端校验 ≥8 字；`UNIQUE(bom_id, rev)` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/bom/BomRevEntity.java#BomRevEntity |
