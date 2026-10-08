# 不变量：值域闭集与迁移守卫（invariants-values-guards）

> 本片是 `ontology/invariants.md` 分片组的第 2 部分——**原为单片，加「性质/保证」两列后超 12 288 B 上限，按类别拆开**。
> 表头固定为 `| ID | 断言 | 类别 | 由谁强制 | 机械断言 | 性质 | 保证 | → 指针 |`。`性质`/`保证` 口径见 `interfaces/README.md` §③；本片全部 `as-built` + `def:同指针`。**入选门槛**：能被写成测试、能给出「谁在什么条件下强制」。

## 3. C 值域闭集（V-019~V-029）

| ID | 断言 | 类别 | 由谁强制 | 机械断言 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| V-019 | 当评审 `review_type='DCP'` 时 `conclusion` 只能取 GO/GO_WITH_RISK/TERMINATE/REDIRECT；`TR` 只能取 PASS/COND/FAIL——**取值域按类型隔离** | C | DB `uq_review_conclusion` | `DecideDryRunTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V24__review-domain.sql#t_review |
| V-020 | 当列出「DCP 评审通过」集合时，只能取 GO/GO_WITH_RISK；**TERMINATE/REDIRECT 虽合法但不算通过** | C | Java 常量（权威源） | `ReviewDomainIntegrationTest`、`PlmServiceIntegrationTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/review/GateConclusionVocabulary.java#DCP_OK |
| V-021 | 当签署记录存在时，`signer_role` ∈ {CHAIR, MEMBER, QA} 且 `action` ∈ {SIGN, VETO, ABSTAIN, OPINION} | C | DB `CHECK` ×2 | `ReviewListBatchEquivalenceTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V46__ipd-roles-gate-map-review-signers.sql#t_review_signer |
| V-022 | 当产品或项目带 `product_kind` 时，只能取 DEVICE/SW_IN_DEVICE/SW_SAMD/SW_STANDALONE/SYS_INTERNAL/OTHER 六值之一 | C | DB `CHECK` ×2 | `ProductKindIntegrationTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V72__product-kind.sql#t_product |
| V-023 | 当物料写入 `make_buy` 时，只能取 MAKE/BUY/PHANTOM/**SUBSTITUTE** 四值（V210 新增第四值） | C | DB `CHECK` | 无 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V210__substitute-group-vocabulary.sql#t_item |
| V-024 | 当 BOM 视图存在时，`bom_view` 只能取 EBOM/PBOM/MBOM/SBOM/REGBOM | C | DB `CHECK` | `BomViewVocabularyTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V7__item-bom-change.sql#t_bom_line |
| V-025 | 当 BOM 头存在时，`status` 只能取 DRAFT/DESIGN/RELEASED 三值 | C | DB `CHECK` | `BomViewVocabularyTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V177__bom-three-state-and-cbb-source.sql#t_bom |
| V-026 | 当任务 `status='DONE'` 时，`completed_by_kind` 必须非空（**不得凭空完成**） | C | DB `CHECK` | `TaskModuleOptimizationTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V167__task-domain-foundation.sql#t_project_task |
| V-027 | 当任务存在时，`task_code` 必须匹配 `^TASK-[0-9]{4}-[0-9]{4,}$` | C | DB `CHECK`（正则） | 无 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V167__task-domain-foundation.sql#t_project_task |
| V-028 | 当某域词表下发界面时，**显示词键集必须与值域完全相等**（少键裸显码值；多键可选出服务端不认的值） | C | 测试守卫 | 本条即测试 | as-built | def:同指针 | → ipd/plm-app/backend/src/test/java/com/plm/EcoVocabularyTest.java#labelKeysMatchValueDomains |
| V-029 | 当全平台 flow YAML 被加载时，**每个 YAML 都必须产出定义**（漏加载即数量不等） | C | 测试守卫 | 本条即测试 | as-built | def:同指针 | → ipd/plm-app/backend/src/test/java/com/plm/platform/flow/FlowEngineRequiresTest.java#loadsAllFlows |

## 4. D 迁移守卫（V-030~V-039）

| ID | 断言 | 类别 | 由谁强制 | 机械断言 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| V-030 | 当 BOM 已 `RELEASED`（冻结为不可变基线）时，**任何结构写操作必须被拒，唯一出路是先升版** | D | 服务层守卫 | 无（`BOM_FROZEN_STRUCTURE_LOCKED` 无专项测试） | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/bom/BomService.java#assertStructureEditable |
| V-031 | 当 BOM 头态非「草稿」时，新增行的子件必须已 `RELEASED`；草稿态可挂 WIP 件但标「待发布」 | D | 服务层守卫 | 无 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/bom/BomService.java#add |
| V-032 | 当向 REGBOM 新增行时，子件**不得是互替组占位件**（注册载明必须指名具体料号） | D | 服务层守卫 | 无 | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/bom/BomService.java#add |
| V-033 | 当发起门 G 的评审时，同项目所有 `seq < seq(G)` 的门都必须已有 `DECIDED` 评审，否则拒收 | D | 服务层守卫（两读面同源） | `ReviewDomainIntegrationTest`、`ReqFeedback20260914Test` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/review/GateOrderGuard.java#assertSatisfied |
| V-034 | 当项目做 `from→to` 阶段流转且该流转映射到某 DCP 时，该门必须已 `DECIDED` 且结论 ∈ {GO, GO_WITH_RISK} | D | 服务层守卫 | `PlmServiceIntegrationTest`、`ReviewDomainIntegrationTest`、`CharterDomainIntegrationTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#assertStageGuard |
| V-035 | 当业务计划书当前版本为 `APPROVED` 时，正文不可改写，**只能滚动升版**（升版前置为 APPROVED 或 REVIEW） | D | 服务层守卫 | `CharterDomainIntegrationTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/ipd/IpdModelService.java#createRev |
| V-036 | 当 ECO 状态不在 {DRAFT, EVALUATING, CCB_REVIEW} 时，字段编辑必须被拒 | D | 服务层守卫 | `EcoOptimisticLockTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#updateEco |
| V-037 | 当存在未撤回的 ACTIVE 否决时，签署/记录结论必须被拒 | D | 服务层守卫 | `ReviewDomainIntegrationTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#sign |
| V-038 | 当主席已签署时，不得再否决（**否决只在签署前有效**） | D | 服务层守卫 | `ReviewDomainIntegrationTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/review/ReviewService.java#veto |
| V-039 | 当对任务书下受控订正时，`status`/`dcp0_review_id`/`project_id`/`charter_code` 等**结论性与归属字段永不可订正**（白名单外一律拒） | D | 服务层守卫（白名单） | `CharterDomainIntegrationTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/ipd/IpdModelService.java#correctCharter |

