# 工作流与审批（workflow-and-approval）

> 本片声明流程引擎的**通用判据**：迁移合法性、可编辑性、边级角色门执行点、任务归属与流转。
> 各流程的具体状态与迁移边属 `ontology` 树；YAML 定义在 `→ ipd/plm-app/backend/src/main/resources/flows/`。
> 设计口径见 `→ docs/plm-tech/09-工作流引擎与元数据扩展设计.md#1.1 问题`。
> 证据级别：全部 `有代码校验`（抛点行号已核实）。

| ID | 条件 → 判定 | 例外 | 违反后果 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- |
| R-109 | 全部流程定义来自 `resources/flows/*.yaml`（当前 **23** 个 YAML），启动时一次性加载进内存 | 无 | YAML 解析失败 → 启动即抛「流程定义加载失败」 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/platform/flow/FlowEngine.java#FlowEngine` |
| R-110 | 以不存在的 `flowId` 调 `getFlow` → 抛 `IllegalArgumentException("未知流程: X")` | 无 | 取不到流程定义 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/platform/flow/FlowEngine.java#getFlow` |
| R-111 | 状态迁移合法性**只看**流程定义里 `from→to` 真的存在的那条边，不另查本地清单 | 无 | 非法边 400「状态 X 不能推进到 Y（合法目标：…）」 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/task/TaskService.java#transition` |
| R-112 | 自环边（`from == to`）是系统按时间自动执行的路径 → 用户显式触发 400 `TASK_TRANSITION_INVALID` | 无 | 手动推进自动完成被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/task/TaskService.java#transition` |
| R-113 | 推进任务必须携带 `version` → 缺则 400 `TASK_VERSION_REQUIRED` | 无 | 乐观并发凭据不可省 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/task/TaskService.java#transition` |
| R-114 | `DRAFT→IN_PROGRESS`、`→CANCELLED`、`DONE→IN_PROGRESS` 三类动作 → 仅**创建者**可执行，否则 400 `TASK_NOT_CREATOR` | 无 | 越权推进被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/task/TaskService.java#requireCreator` |
| R-115 | 其余推进动作（含反馈进度）→ 仅**主责**可执行，否则 400 `TASK_NOT_PRIMARY` | **创建者也被放行且是有意设计**：避免主责离职/不理时形成死局；代价是进度可能由创建者改动，已被用户裁定接受 | 越权推进被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/task/TaskService.java#requirePrimary` |
| R-116 | `DRAFT→IN_PROGRESS` 时 `t_task_assign` 中不存在 `is_primary` 行 → 400 `TASK_PRIMARY_REQUIRED` | 无（判据是**关系存在性**而非字段非空，避免"填了名字没落分配行"假过） | 无主责不得开工 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/task/TaskService.java#transition` |
| R-117 | 沿 `rework` 位标记的边迁移且 `reason` 为空 → 400 `TASK_REASON_REQUIRED` | 非 rework 边不要求 reason | 改变既有结论的动作无据可查被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/task/TaskService.java#transition` |
| R-118 | 实际日期不由更新接口直改：进入 `IN_PROGRESS` 自动落 `actual_start`，进入 `DONE` 自动落 `actual_done` | 人工纠正实际日期走独立通道；**不得开半条通道** | 人工改期无审计 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/task/TaskService.java#transition` |
| R-119 | 任务状态落在终态集 `{DONE, CANCELLED}` → 改进度 400 `TASK_PROGRESS_LOCKED`；进度 <0 或 >100 → 400 `TASK_PROGRESS_INVALID`；`percent` 为 null → 400 `TASK_PROGRESS_REQUIRED` | 无（判据直接表达"终态即锁定"，**不做例外**；需修正须先"退回执行"） | 完成事实被静默改写被堵 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/task/TaskService.java#updateProgress` |
| R-120 | 同一入口的多道门必须共用**同一个权限点**；任务进度更新两道门均为 `task.progress` | 无 | 用不同权限点时报文点名的是另一道门，极难排查 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/task/TaskService.java#updateProgress` |
| R-121 | 任务评论 → 仅项目**名册成员**（创建者/主责/参与者/项目成员）可加，否则 400 `TASK_NOT_MEMBER` | 无 | 守卫显式查名册，不得依赖读可见性的上游副作用（防空转守卫） | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/task/TaskService.java#requireCommenter` |
| R-122 | 任务更新改 `parentId` 且与现值不同 → 400 `TASK_PARENT_CHANGE_UNSUPPORTED`（用户裁定 B7「不支持改父」） | 与现值相同视为回传，放行 | "收了但静默忽略"被显式拒绝取代 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/task/TaskService.java#updateTask` |
| R-123 | 只给 `plannedStart` 或 `plannedDue` 其中之一 → 400 `TASK_PLAN_HALF_WINDOW` | 两者同时为 null 表示整窗清空 | 半窗（无法计算偏差的坏数据）被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/task/TaskService.java#updateTask` |
| R-124 | 改责任人 = 改**主责位**：旧主责降为参与者（保留行不删，他干过的事要留痕），新主责升位，归属组织随新主责走 | 调用方显式给了 `orgId` 时以传入值为准 | 责任关系可追溯 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/task/TaskService.java#updateTask` |
| R-125 | 任务域读可见性 fail-closed：非项目成员按 id 直取与"任务真的不存在"返回**同一个** `TASK_NOT_FOUND`（404） | 无 | 端点不会变成"某个 id 是不是任务"的存在性探针 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/domain/task/TaskService.java#getTask` |
| R-126 | 流程查询传未登记视图 → 服务端显式抛错，SQL 占位符数与参数必须匹配 | 无 | 参数不匹配返回错误而非拼出错误 SQL | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/platform/flow/FlowTaskService.java#query` |
| R-127 | 认领任务：任务必须 `status='OPEN'` 且 `mode='CANDIDATE'` 且当前身份命中该角色，否则 400/403 | 无 | 重复认领、非候选池、非角色用户被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/platform/flow/FlowTaskService.java#claim` |
| R-128 | 释放任务：仅 `status='CLAIMED'` 且**仅认领人本人**可释放，否则 400/403 | 无 | 越权释放被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/platform/flow/FlowTaskService.java#release` |
| R-129 | 指派任务：`assignee` 为空 → 400；任务状态不可指派 → 400；无指派权 → 403；用户不存在或未启用 → 400 | 无 | 无效指派被拒 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/platform/flow/FlowTaskService.java#assign` |
| R-130 | YAML 里声明了 `roles:` 的边，若该流程域**没有** `edge.roleAllowed(...)` 执行点 → 状态为 `DECLARED_NOT_ENFORCED`（装饰门，T4-6 对账报 FAIL） | 未声明 `roles:` 的边状态 `NOT_DECLARED`，走域级 RBAC 兜底，不是门 | 不在白名单的用户仍可完成迁移 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/platform/flow/EdgeGateEnforcement.java#annotate` |
| R-131 | 已登记执行点的流程域（截至代码实测 10 个）：`requirement`/`project`/`doc`/`charter`/`offering`/`product`/`req-baseline`/`pco` 等，边级角色门为 `ENFORCED` | 登记集合与 CI 的 T4-6 实扫集合必须双向一致，不一致即 FAIL | 任一方漂移被门禁抓住 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/platform/flow/EdgeGateEnforcement.java#CALL_SITES` |
| R-132 | 边的 `roles:` 声明与执行点**必须同批落地**，禁止拆批；中间那一批就是装饰门 | 无 | T4-6 判 FAIL | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/platform/flow/EdgeGateEnforcement.java#CALL_SITES` |
| R-133 | `editableStatuses` 未声明 ⇒ `attachmentStatuses` / `ownerTransferStatuses` 回落为 `editableStatuses`（存量流程零行为变化） | 无 | 声明即生效：YAML 写下的键必须有消费者 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/platform/flow/FlowEngine.java#FlowEngine` |
