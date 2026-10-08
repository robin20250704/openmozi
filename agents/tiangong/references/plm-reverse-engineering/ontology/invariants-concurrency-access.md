# 不变量：乐观并发与权限角色（invariants-concurrency-access）

> 本片是 `ontology/invariants.md` 分片组的第 3 部分——**原为单片，加「性质/保证」两列后超 12 288 B 上限，按类别拆开**。
> 表头固定为 `| ID | 断言 | 类别 | 由谁强制 | 机械断言 | 性质 | 保证 | → 指针 |`。`性质`/`保证` 口径见 `interfaces/README.md` §③；本片全部 `as-built` + `def:同指针`。**入选门槛**：能被写成测试、能给出「谁在什么条件下强制」。

## 5. E 乐观并发（V-040~V-044）

> **读法**：这一组回答"为什么会出现一次『保存失败』"。**乐观锁在本仓是两种载体**（见 E-048 与冲突 C-018）：
> JPA `@Version` **全仓只有 3 个实体**（ECO/产品包/注册证），其余 13 域是手拼 `AND version = ?`。语义一致。

| ID | 断言 | 类别 | 由谁强制 | 机械断言 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| V-040 | 当客户端更新任一并发受控域对象而**未携带 `version`** 时，必须拒且**一个字都不写**（不得静默当最新） | E | 服务层统一入口 | `EcoOptimisticLockTest`、`RiskLedgerOptimisticLockTest`、`CbbAndOpenIssueOptimisticLockTest`、`RegOfferingPvOptimisticLockTest`、`BizPlanOptimisticLockTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/common/OptimisticLock.java#require |
| V-041 | 当携带的 `version` 与库内不一致时，必须冲突退出且**不落库、版本号不变** | E | 服务层守卫 | `EcoOptimisticLockTest`、`RiskLedgerOptimisticLockTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/common/OptimisticLock.java#assertVersionHit |
| V-042 | 当 JPA 域保存时，ORM 必须在每条 UPDATE 上加版本条件——靠 `@Version` 而非手拼 | E | JPA 注解 | `EcoOptimisticLockTest`（ORM 栅栏用例） | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/change/EcoEntity.java#version |
| V-043 | 当 JDBC 域更新时，`WHERE` 必须带 `AND version = ?`，影响 0 行即冲突 | E | 服务层守卫（唯一写法） | `RiskLedgerOptimisticLockTest`、`RegOfferingPvOptimisticLockTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/common/OptimisticLock.java#VERSION_GUARD |
| V-044 | 当读面下发对象时，`version` 必须等于库内真值（否则前端无可回传凭据，保存必被拒） | E | 服务层读面 | `EcoOptimisticLockTest`、`RiskLedgerOptimisticLockTest`、`CbbAndOpenIssueOptimisticLockTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/common/OptimisticLock.java#jpaSave |

## 6. F 权限与角色（V-045~V-050）

| ID | 断言 | 类别 | 由谁强制 | 机械断言 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| V-045 | 当签署 DCP/TR 评审结论时，当前身份必须是该门类型主席（DCP=`ipmt_chair`；TR=`tr_chair` 或 `pdt_manager`），admin 豁免 | F | 服务层守卫 | `ReviewDomainIntegrationTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/platform/governance/GovernanceService.java#isChairOf |
| V-046 | 当判定某检查项时，其 `judge_role` 必须在 `JudgeRoleMatrix` 中有键，且操作者角色与之有交集（**未登记 ⇒ 允许集为空 ⇒ 非 admin 无人可判**） | F | 服务层守卫（矩阵） | `ReviewDomainIntegrationTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/review/JudgeRoleMatrix.java#allowed |
| V-047 | 当把文档从 DRAFT 提交 REVIEW 时，当前身份**必须是该文档 owner/编制人**；越权尝试必须留痕 | F | YAML 声明 + 服务层执行 | `DocumentAuthorOnlyTransitionTest`（六条断言全绿） | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/doc-flow.yaml#transitions |
| V-048 | 当把文档置为 `OBSOLETE` 时，角色必须 ∈ {dcc, quality, RA, pdt_manager, admin} 且**理由必填** | F | YAML 边级角色门 | `DocumentAuthorOnlyTransitionTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/doc-flow.yaml#transitions |
| V-049 | 当改动「正式结构事实」时，该物料必须处于某条 IMPLEMENTING/VERIFYING 的 ECO 受影响集内（**BR-01 变更窗口**） | F | 服务层守卫（跨域唯一实现） | `EcoStructureChangeListTest` | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#assertChangeWindow |
| V-050 | 当域级权限点未覆盖其细粒度资格角色并集时，服务必须**拒绝启动** | F | 启动自检 | `ApiParamContractTest`（间接） | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/platform/permission/PermissionConsistencyCheck.java#UNION_RULES |

## 7. 刻意**不**作为不变量收的（否则会把"明确不做"写成"漏做"）

| 声明 | 为什么不算不变量 | 出处 |
| --- | --- | --- |
| 基线冻结后的需求变更**强制走 ECO** | `V150:20-21` **明说不建任何硬拦**（ADVISORY）："不强制走 ECO ⇒ 本迁移不碰 CHECK…也不建任何硬拦" | 冲突簿 C-022 |
| 「引用一律用逻辑 ID + 版本」 | **只对 `ITEM_REV` 落地**（本片 V-013）；其余类型无 DB 约束——`V146:26-31` 明写"业务引用不靠 DB 外键守（另有 59 个 `*_id` 形态列同样无 FK）" | 冲突簿 C-023 |
| 「文档受控版 = 已批准的真相源」 | `doc-flow.yaml` 只声明 `APPROVED→RELEASED` 边，**未核到"只有已批准才可发布"的代码守卫** | 冲突簿 C-024，`[未核实]` |

> **「机械断言」列的 `无` 是可数的债**：本片 50 条里有 **11 条 `无`**，集中在服务层守卫（BOM 冻结锁、REGBOM 禁占位件、幂等键唯一性）。
> 收敛路径是每条补一个专项测试用例；`假测试名` 比 `无` 危险——`无` 可数，假名不可数。

