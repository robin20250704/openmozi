# 变更域：ECR / ECO 单据本体（change-control）

> 本片只声明 **ECR / ECO 单据本体**的写路径判据与硬约束：建单、编辑锁定、乐观锁、五维评估、CCB 决议、状态迁移守卫、
> 受影响对象取值域。**变更执行（apply）与 ECN 下发已拆到同目录 `change-control-execution.md`**（本片原为单片，超 12 288 B 上限）。
> 状态机的迁移边清单属 `ontology` 树；三单据为何不能合并见
> `→ docs/plm-tech/23-变更域三单据与工作台设计.md#1. 三表对照（事实基线）`。
> 证据级别：全部 `有代码校验`（抛点行号已核实）。**空值一律显式先判**：`List.of(...).contains(null)` 会抛 NPE 变 500，
> 不得让缺字段退化成 500。

| ID | 条件 → 判定 | 例外 | 违反后果 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- |
| R-026 | 创建 ECR 时 `problemDesc` 为空或空白 → 拒 400「变更问题描述不能为空」 | 无 | 建单失败 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#createEcr` |
| R-027 | 创建 ECR 时 `source` 为 null → 拒 400「来源不能为空」 | 无 | 建单失败 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#createEcr` |
| R-028 | ECR 状态迁移的 `to` 不在 `ecr` 流程 YAML 对 `from` 定义的出边内 → 拒 400「非法状态迁移: from → to」 | 无 | 非法迁移被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#transitionEcr` |
| R-029 | ECR 状态不在 `OPEN`/`TRIAGED` → `PUT /ecrs/{id}` 拒 400 `ECR_LOCKED` | 无 | 已转变更单/已关闭的申请不可改，只能作废重开 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#updateEcr` |
| R-030 | ECR 更新把 `problemDesc` 改成空白 → 拒 400 `ECR_PROBLEM_DESC_REQUIRED` | 无 | 不能把问题描述改空 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#updateEcr` |
| R-031 | ECO 状态不在 `DRAFT`/`EVALUATING`/`CCB_REVIEW` → `PUT /ecos/{id}` 拒 400 `ECO_LOCKED` | 无 | 变更单锁定不可编辑 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#updateEco` |
| R-032 | ECO 更新请求缺 `version` → 拒 400 `ECO_VERSION_REQUIRED`，不静默放过 | 无 | 旧客户端无法绕过整道乐观锁 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#updateEco` |
| R-033 | 请求 `version` 与库内当前版本不一致 → 409 `ECO_VERSION_CONFLICT`，带双方版本号且不落库 | 无 | 调用方须刷新重做 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/common/OptimisticLock.java#require` |
| R-034 | 要挂到 ECO 上的 ECR 状态不在 `OPEN`/`TRIAGED` → 拒 400 `ECR_NOT_LINKABLE` | 无 | 已转变更单/已关闭/已取消的申请不可再挂新单 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#updateEco` |
| R-035 | ECO 挂上 ECR 成功 → 该 ECR 状态自动置 `TO_ECO`（创建与更新两条路径同口径） | 无 | 申请不会永远停在 `OPEN`，看板对得上账 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#createEco` |
| R-036 | 回填批准文号时 ECO 状态不是 `VERIFYING`/`CLOSING` → 拒 400 `ECO_APPROVAL_NO_TOO_EARLY`（BR-05 关闭前置） | 无 | 堵住"建单+填一个字符串即跳到 CLOSING"的旁路 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#updateEco` |
| R-037 | 批准文号不得隐式驱动状态：`VERIFYING` 下回填才推进到 `CLOSING`，其余一律走显式 `transition` | 无 | 绕过 CCB 授权与变更执行的门被封 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#updateEco` |
| R-038 | 变更类别不在 `MINOR`/`MAJOR`/`REG`/`EMERGENCY` → 拒 400 `ECO_CHANGE_CLASS_INVALID`；null/空白归一为 `MAJOR` | 空白默认 `MAJOR` | 非法类别入库即拒，报错附合法值清单 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/EcoVocabulary.java#CHANGE_CLASSES` |
| R-039 | 创建 ECO 时 `title` 为空或空白 → 拒 400「变更单标题不能为空」 | 无 | 建单失败 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#createEco` |
| R-040 | 提交五维评估的 `dimension` 不在 `tech`/`reg`/`risk`/`vv`/`mfg` → 拒 400「非法维度」 | 无 | 非法维度被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/EcoVocabulary.java#DIMENSIONS` |
| R-041 | ECO 状态不是 `EVALUATING` 时提交评估 → 拒 400「仅评估阶段可提交评估」 | 无 | 评估错阶段被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#submitEval` |
| R-042 | 维度绑定责任角色矩阵（唯一定义处）：tech=`system_engineer`/`SE`；reg=`ra`/`RA`；risk=`risk`/`risk_owner`/`quality`/`pdt_quality`；vv=`verification`；mfg=`pdt_mfg` | `admin` 豁免 | 越维签署 403，可签账号可能归零 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#submitEval` |
| R-043 | 非 admin 且当前用户角色与该维度责任角色**零交集** → 拒 403 `FORBIDDEN`「维度 X 的评估须由责任角色签署」 | `admin` 豁免（平台全权惯例） | 越维签署被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#submitEval` |
| R-044 | 评估人即 ECO 编制人（自评）且组织内**还有**该维度其他合格签署人 → 必须写 `selfApproveReason` 且 trim 后 ≥10 字，否则 400 `SEGREGATION_OF_DUTIES` | 无第二签署人时允许自评，仅打 `NO_PEER` 标 | 静默自评被拒；放行时理由永久留痕审计 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#submitEval` |
| R-045 | 五维 `conclusion` **刻意不判值域**（`eval_*` 为 jsonb，存量绝大多数是自由文本，三值仅为界面建议选项） | 无 | 不得按"通过/有条件通过/不通过"做闭合校验，会拒掉既有数据 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/EcoVocabulary.java#EVAL_CONCLUSION_PRESETS` |
| R-046 | CCB `result` 为 null 或不在 `APPROVED`/`CONDITIONAL`/`REJECTED` → 拒 400「非法 CCB 决议」（null 显式先判，防 NPE→500） | 无 | 缺字段得 400 而非 500 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#ccb` |
| R-047 | CCB 决议人即 ECO 编制人（自决）且组织内**还有**具备 `eco.ccb` 资格的其他成员 → 必须写 `selfApproveReason` 且 ≥10 字，否则 400 `SEGREGATION_OF_DUTIES` | 无第二决议人时允许自决，打 `NO_PEER` 标 | 静默自决被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#ccb` |
| R-048 | CCB 决议为 `REJECTED` → ECO 状态自动置 `CANCELLED`（QA 一票否决） | 无 | 否决不驱动状态会使整条变更流程对该单永久不可达 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#ccb` |
| R-049 | ECO 迁移到 `CCB_REVIEW` 时五维未全部签署 → 拒 400「五维评估未全部签署，不可进 CCB 评审」 | 无 | 跳门被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#transitionEco` |
| R-050 | ECO 迁移到 `APPROVED` 时 `ccbResult` 不在 `APPROVED`/`CONDITIONAL` → 拒 400「CCB 决议必须为通过或附条件，方可批准」 | 无 | 无 CCB 授权不得批准 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#transitionEco` |
| R-051 | 沿 `isRework(from,to)` 判定的**退回边**迁移且 `reason` 为空/空白 → 拒 400「退回需填写原因」 | 非退回边不要求 reason | 退回无原因被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#transitionEco` |
| R-052 | ECO 迁移到 `EVALUATING` → `evalRound` +1，评估签名按轮追加（`EVALUATING→DRAFT` 退回重评不新增轮） | 无 | 重评不覆盖上一轮签署 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#transitionEco` |
| R-065 | 受影响对象 `objType` 为 null 或不在 `ITEM_REV`/`DOC_REV`/`BOM`/`REG`/`SOFTWARE` → 拒 400 `ECO_AFFECTED_TYPE_INVALID` | 无 | 垃圾 objType 入库口关闭 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/EcoVocabulary.java#AFFECTED_OBJ_TYPES` |
| R-066 | 受影响对象 `action` 为 null 或不在 `REVISE`/`ADD`/`OBSOLETE` → 拒 400 `ECO_AFFECTED_ACTION_INVALID` | 无 | 非法动作被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/EcoVocabulary.java#AFFECTED_ACTIONS` |
| R-067 | `disposeType` 非空且不在 `USE_UP`/`SCRAP`/`REWORK`/`IMMEDIATE` → 拒 400 `ECO_DISPOSE_TYPE_INVALID` | null/空白放行（不填即不判） | 非法处置方式被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/EcoVocabulary.java#DISPOSE_TYPES` |
| R-068 | 物料已发布（受控）而被直接改动 → 拒 400 `CHANGE_WINDOW_REQUIRED`（BR-01：发布后改动必须走变更 ECO 授权） | 无 | 绕过变更单改正式结构被封（此前无守门） | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#assertChangeWindow` |
| R-071 | ECO 任务状态写入不在 `PENDING`/`DONE`/`REVIEW` → 拒 400「非法任务状态」 | 无 | 非法状态被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#updateEcoTask` |
| R-072 | ECO 值域表为**单一事实源**（五维、CCB 三值、受影响三字段、变更类别），中文显示词随码值同处下发，界面不自持 | 无 | 值域与显示词分家会产生"两张皮" | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/EcoVocabulary.java#DIMENSIONS` |
