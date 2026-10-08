# 不变量：唯一性与存在性（invariants）

> 本片是 `ontology/invariants.md` 分片组的第 1 部分——**原为单片，加「性质/保证」两列后超 12 288 B 上限，按类别拆开**。
> 表头固定为 `| ID | 断言 | 类别 | 由谁强制 | 机械断言 | 性质 | 保证 | → 指针 |`。`性质`/`保证` 口径见 `interfaces/README.md` §③；本片全部 `as-built` + `def:同指针`。**入选门槛**：能被写成测试、能给出「谁在什么条件下强制」。

## 1. A 唯一性（V-001~V-010）

| ID | 断言 | 类别 | 由谁强制 | 机械断言 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| V-001 | 当存在两条物料行时，`item_code` 必须不同——**全库全局唯一，不按项目分域** | A | DB `UNIQUE` | 无 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V7__item-bom-change.sql#t_item |
| V-002 | 当同一父件同一版本内已有指向同一子件同视图的 BOM 行时，再加必被拒；**跨版本可各有一条** | A | DB 唯一索引 + 服务层 | `BomViewVocabularyTest`（仅词表） | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V7__item-bom-change.sql#t_bom_line |
| V-003 | 当互替组内已有某成员料号时，再加同一料号必被拒 | A | DB `uq_substitute_group_member` | `V157` 自证⑧反向探针 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V157__item-substitution-group.sql#t_item_substitute |
| V-004 | 当互替组内已有优先级 `1` 时，再加一条优先级 `1` 必被拒（**主选唯一**） | A | DB `uq_substitute_group_priority` | `V157` 自证⑧ | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V157__item-substitution-group.sql#t_item_substitute |
| V-005 | 当门点字典存在两条同 `seq` 的行时必须被拒——**门序是严格全序，不得并列** | A | DB 唯一索引 + 启动自检 | `GateVerifiabilityIntegrationTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V185__gate-map-seq-align.sql#t_gate_map |
| V-006 | 当一条需求已被订正过时，**第三条不得再订正它**（一条需求最多被一条条目订正） | A | DB 部分唯一索引 + 服务层 | 无 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V104__requirement-supersede-link.sql#t_requirement |
| V-007 | 当某 BOM 头某版本某类型已冻结过基线时，重复冻结必被拒 | A | DB 部分唯一索引 + 服务层 | 无 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V156__generic-baseline-and-bom-freeze.sql#t_baseline |
| V-008 | 当一个任务已存在主责分配行时，不得再出现第二行 `is_primary=true` | A | DB 部分唯一索引 | `TaskModuleOptimizationTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V170__task-model-realign.sql#t_task_assign |
| V-009 | 当同一评审已有同角色同动作的**生效**签署时，再写一条 ACTIVE 必被拒 | A | DB 部分唯一索引 | `ReviewDomainIntegrationTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V46__ipd-roles-gate-map-review-signers.sql#t_review_signer |
| V-010 | 当某幂等键已在保留窗口内被同方法同路径用过时，第二次写不得产生第二条记录 | A | DB `uq_idempotency_key_method_path` | 无 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V69__idempotency-key-store.sql#t_idempotency |

## 2. B 存在性 / 参照完整性（V-011~V-018）

| ID | 断言 | 类别 | 由谁强制 | 机械断言 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| V-011 | 当互替组成员行存在时，组与成员都必须指向真实存在的 `t_item` 行 | B | DB 外键 ×2 | `V157` 自证④ | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V157__item-substitution-group.sql#t_item_substitute |
| V-012 | 当 BOM 头写入 `frozen_baseline_id` 时，该基线必须存在 | B | DB 外键 | 无 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V156__generic-baseline-and-bom-freeze.sql#t_bom |
| V-013 | 当 `t_req_trace.target_type='ITEM_REV'` 时，`target_id` 必须是 `item.id` 的十进制数字串（**引用必须带版本后缀**） | B | DB `CHECK` 正则 | `GateVerifiabilityIntegrationTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V107__req-trace-item-rev-guard.sql#t_req_trace |
| V-014 | 当 BOM 行 `cbb_source` 非空时，`cbb_id` 必须非空（来源不能脱离它描述的事实） | B | DB `CHECK` | 无 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V177__bom-three-state-and-cbb-source.sql#t_bom_line |
| V-015 | 当需求进入锁定态（`APPROVED` 及之后）时，正文写入必须被拒；**改数只能走订正通道** | B | 服务层守卫 | `ReqBatch28DefectTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/requirement/RequirementService.java#update |
| V-016 | 当需求基线纳入成员时，被纳入的必须是**本项目下需求的内容快照行**（跨项目纳入必须被服务层守住） | B | DB 外键 + 服务层 | 无 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V150__req-version-and-baseline.sql#t_req_baseline_item |
| V-017 | 当任务依赖边存在时，predecessor 与 successor 都必须指向真实任务**且不得自指** | B | DB 外键 ×2 + `CHECK` | `TaskModuleOptimizationTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V167__task-domain-foundation.sql#t_task_dep |
| V-018 | 当订正链上溯已回到本条需求时，订正必须被拒（**成环检测**，限深 20） | B | 服务层守卫 | 无 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/requirement/RequirementService.java#applySupersedeLink |

