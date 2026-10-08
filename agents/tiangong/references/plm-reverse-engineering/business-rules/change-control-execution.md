# 变更域：变更执行（apply）与 ECN 下发（change-control-execution）

> 本片只声明**变更执行**（把 ECO 的授权真正落到目标对象上）与 **ECN 下发**两条写路径的硬约束。
> 建单、编辑、五维评估、CCB 决议与状态迁移守卫在同目录的 `change-control.md`。
> 状态机的迁移边清单属 `ontology` 树；三单据为何不能合并见
> `→ docs/plm-tech/23-变更域三单据与工作台设计.md#1. 三表对照（事实基线）`。
> 证据级别：全部 `有代码校验`（抛点行号已核实）。**空值一律显式先判**：`List.of(...).contains(null)` 会抛 NPE 变 500，
> 不得让缺字段退化成 500。

| ID | 条件 → 判定 | 例外 | 违反后果 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- |
| R-053 | 变更执行（`apply`）时 ECO 状态不在 `IMPLEMENTING`/`VERIFYING` → 拒 400 `ECO_APPLY_STATE` | 无 | 已关闭/已取消的 ECO 不得补执行 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#apply` |
| R-054 | 本 ECO 未登记任何受影响对象 → 拒 400 `ECO_APPLY_EMPTY`（空集空转 = 变更未真正执行） | 无 | 不允许空转通过 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#apply` |
| R-055 | 受影响对象中无一为 `ITEM_REV` → 拒 400 `ECO_APPLY_UNSUPPORTED`，逐行报出需在目标域自行修改 | 无 | 非 `ITEM_REV` 类型本期不自动写回 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#apply` |
| R-056 | `apply` 的 `items` 为 null 或空 → 拒 400 `ECO_APPLY_EMPTY_REQUEST` | 无 | 无执行项被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#apply` |
| R-057 | 同一 `items` 内同一 `objItemId` 出现两次 → 拒 400 `VALIDATION_ERROR`，须合并为一条 | 无 | 防止同事务双写双审计 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#apply` |
| R-058 | `items` 中物料不在本 ECO 的受影响对象内 → 拒 400 `ECO_APPLY_SCOPE` | 无 | 变更执行不得越出本 ECO 授权对象 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#apply` |
| R-059 | 受影响行 `appliedAt` 非空 → 该行本次标 `IDEMPOTENT` 跳过，不重复写入与重复审计 | 无 | 重试安全 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#apply` |
| R-060 | 字段 `stdCost` 经变更执行写入 → 拒 400 `ECO_APPLY_FIELD`（`std_cost` 为 ERP 回写、PLM 只读） | 无 | PLM 不得改标准成本 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#apply` |
| R-061 | 字段不在白名单 → 拒 400 `ECO_APPLY_FIELD`。白名单：主档 `{name,spec}`；版本行 `{planCost,currency,priceUom,supplierCode,supplierName,refPrice,refLeadTimeDays}` | 无 | id/编码/状态/合规打标一律不得经此端点写入 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#apply` |
| R-062 | 目标物料 `isEditable(status)` 为假 → 拒 400 `ECO_APPLY_ITEM_STATE` | 登记 REVISE 会把 RELEASED 物料置 `CHANGING` 打开变更窗口 | 未开变更窗口不得改 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#apply` |
| R-063 | `fields` 为空且受影响行 `newRev` 为空或等于当前版本 → 拒 400 `ECO_APPLY_EMPTY_LINE` | 无 | 无可执行内容被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#apply` |
| R-064 | 目标版本号已存在且其 `releaseEcoCode` 不是本 ECO → 拒 400 `ECO_APPLY_REV_CONFLICT` | 本 ECO 自建的同名版本行可复用 | 版本规划冲突被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#apply` |
| R-069 | 创建 ECN 时 ECO 状态不是 `CLOSING` → 拒 400「仅关闭阶段可生成 ECN（需先完成批准文号回填等）」 | 无 | 提前下发变更通知被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#createEcn` |
| R-070 | 同一 ECO 已有 ECN → **复用**该 ECN（不新建、不重复发号），并重置其状态为 `PENDING` | 无 | 一 ECO 一 ECN | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/change/ChangeService.java#createEcn` |
