# 跨流程口径与引擎契约（state-machines-engine）

> 本片是 `ontology/state-machines.md` 分片组的第 2 部分。分片组：本文（表 B 跨流程口径 S-024~S-033 + 对账）｜`state-machines.md`（口径三条 + 表 A 23 台状态机 S-001~S-023）。
> 表头固定为 `| ID | 状态机 | 状态取值 | 初始 → 终态 | 边 | 守卫口径 | 可编辑状态集 | 性质 | 保证 | → 指针 |`。`性质`/`保证` 口径见 `interfaces/README.md` §③；本片全部 `as-built` + `def:同指针`。**口径三条（初终态由图结构推出 / `cond` 不被解析 / 守卫分三层）见 `state-machines.md` §1，本片不重复声明。**

## 3. 表 B：跨流程口径事实（S-024~S-033）

> 这些不是「某一台状态机」的性质，而是**所有状态机共用的引擎契约**或**已登记的覆盖缺口**。与表 A 同宽（10 列）以满足 `selfcheck` 的列数一致性。

| ID | 状态机 | 状态取值 | 初始 → 终态 | 边 | 守卫口径（角色/理由/边守卫） | 可编辑状态集 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S-024 | 流程引擎解析的顶层键（全部 23 台共用） | flow / label / states / transitions / editableStatuses / attachmentStatuses / ownerTransferStatuses | — | — | **只有这 7 个键会被读**；`initial`/`final`/`type` 不存在 | — | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/platform/flow/FlowEngine.java#load |
| S-025 | 初终态的来源 | — | 由图结构推出 | — | 入度 0 = 初始；出度 0 = 终。**不是 YAML 的显式声明** | — | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/platform/flow/FlowEngine.java#load |
| S-026 | `cond` 边的实际状态 | — | — | 23 个 YAML 中 `cond`/`guards`/`signers`/`join`/`countersign` **零使用** | 不被解析 ⇒ 条件分流只能在服务层做 | — | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/pco-flow.yaml#transitions |
| S-027 | BOM 的 `RELEASED` 无入边 | RELEASED | — | 0 条边指向 RELEASED | 由 `BomHeaderService` 依 `t_baseline` 冻结事实**派生**，不是迁移动作 | — | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/bom-flow.yaml#transitions |
| S-028 | `openissue` 的 DB 比 YAML 多一个态 | DB: OPEN/VERIFYING/CLOSED/OVERDUE/**VOID**；YAML: 无 VOID | — | — | `VOID` 无入边无出边，却能释放 `(source_review_id, source_condition_no)` 幂等键 | — | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V121__open-issue-void.sql#t_open_issue |
| S-029 | `task` 有重复边 `BLOCKED → CANCELLED` | 同上 | — | 12（其中 2 条 `(from,to)` 相同、属性不同） | `FlowEngine` 不去重 ⇒ `canTransition` 返回两条候选 | — | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/task-flow.yaml#transitions |
| S-030 | `t_review` 是一台**没有 flow YAML** 的状态机 | PLANNED / IN_REVIEW / DECIDED / SUSPENDED | PLANNED → DECIDED, SUSPENDED | 无 YAML 边（`SUSPENDED` 由 V201 补） | 覆盖缺口：24 个结论词表有两档，状态机无声明处 | — | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V201__review-suspended-state.sql#t_review |
| S-031 | `charter` / `product` 的状态集 DB 无 CHECK | 8 态 / 7 态 | — | — | 全靠服务层；另 22 台都有 CHECK 钉死 | — | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration/V23__ipd-model.sql#t_charter |
| S-032 | `requirement` 的作废边理由门不一致 | — | — | 4 条 `→OBSOLETE` 中 3 条无 `reason: true` | 只有 `PROPOSED → OBSOLETE` 有；同平台 charter/req-baseline 的作废边**全部**有 | — | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/requirement-flow.yaml#transitions |
| S-033 | `project` / `product` 的状态名是**中文码值** | 立项/概念/…/已终止；概念/…/作废 | — | 9 / 7 | 状态名即码值，无英文枚举层；界面不可自造翻译 | — | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/flows/project-flow.yaml#states |


## 3. 与 DB 的三方对账

**23 台里 20 台的 `states` 与 DB `CHECK` 逐字一致。** 三处例外（`openissue` DB 多一个态、`charter`/`product` DB 无 CHECK、`task` 有重复边）
已登记到 `.creature/tasks/plm-reverse-engineering-complete/conflicts.md` 的 C-001 / C-004 / C-002。

> **本树不做「漂移修复」**：按 `decisions.md` D-6，发现实现内在冲突只登记、不改代码。
> 「YAML ↔ DB 一致」的逐条对账结论**只在冲突簿里声明一份**，本树不重复声明第二份真身。
