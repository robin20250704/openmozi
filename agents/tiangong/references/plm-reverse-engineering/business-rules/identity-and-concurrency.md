# 身份、编号与并发（identity-and-concurrency）

> 本片声明"跨域通用的判底规则"：逻辑 ID 寻址格式、错误码到 HTTP 状态的映射、乐观并发、写幂等。
> 域内状态迁移不在本片，见 `workflow-and-approval.md` / `change-control.md` / `review-gates.md`。
> 证据级别：全部 `有代码校验`（已逐条核实抛点行号）。

| ID | 条件 → 判定 | 例外 | 违反后果 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- |
| R-001 | 逻辑 ID 为 null 或空白 → 解析失败，抛 `IllegalArgumentException("逻辑 ID 不能为空")` | 无 | 解析抛异常；无 HTTP 语义（属调用方代码缺陷） | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/common/LogicalId.java#parse` |
| R-002 | 逻辑 ID 去掉 `PLM:` 前缀后不含冒号 → 抛 `IllegalArgumentException("非法逻辑 ID (缺类型)")` | CODE 本身可含冒号，只要求首个冒号前为类型段 | 解析失败 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/common/LogicalId.java#parse` |
| R-003 | 逻辑 ID 的 type 段或 code 段 trim 后为空白 → 抛 `IllegalArgumentException("非法逻辑 ID")` | 无 | 解析失败 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/common/LogicalId.java#parse` |
| R-004 | 逻辑 ID 规范形态为 `PLM:<TYPE>:<CODE>[#<REV>]`；`#` 之后整段为 rev，允许为空串以外的任意值 | 输入允许携带 `📎` 前缀，解析时先剔除并 trim | 不按此形态书写的引用无法被 `LogicalId.parse` 解析 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/common/LogicalId.java#parse` |
| R-005 | 业务校验失败抛 `BizException` → 默认 HTTP **400**，body 为 `{code,message,ts}`，code 缺省为 `BIZ_ERROR` | 无 | 返回 400 + `BIZ_ERROR` | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/common/BizException.java#BizException` |
| R-006 | 抛 `BizException` 且 code 命中 `isAuthorizationDenial(...)` → HTTP **403**，否则仍落 400 | 无 | 越权与入参错误用不同状态码分流 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/common/GlobalExceptionHandler.java#biz` |
| R-007 | 抛 `BizException` 且 code 为 `TASK_NOT_FOUND` / `TASK_PROJECT_NOT_FOUND` / `CBB_NOT_FOUND` / `REUSE_ANALYSIS_NOT_FOUND` → HTTP **404** | 无（刻意与"越权"同码，fail-closed） | 非成员按 id 直取与"资源真的不存在"返回同一响应，防止 id 存在性探针 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/common/GlobalExceptionHandler.java#biz` |
| R-008 | 抛 `BizException` 且 code 为 `CONTROLLED_TOO_LARGE` 或 `FILE_TOO_LARGE_FOR_INLINE` → HTTP **413** | 无 | 请求合法但实体超限，明确拒绝而非 OOM | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/common/GlobalExceptionHandler.java#biz` |
| R-009 | 抛 `DownloadTicketService.RangeNotSatisfiable` → HTTP **416**，且响应必带 `Content-Range: bytes */<len>` | 无 | 客户端据此得知文件真实长度 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/common/GlobalExceptionHandler.java#biz` |
| R-010 | 下载凭据码为 `DOWNLOAD_TICKET_INVALID` 或 `DOWNLOAD_TICKET_REQUIRED` → HTTP **401** | 无 | 401 语义 = 凭据缺失/无效 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/common/GlobalExceptionHandler.java#biz` |
| R-011 | 下载凭据码为 `DOWNLOAD_TICKET_ALREADY_USED` → HTTP **403**（凭据有效但状态不允许再来一次） | 无 | 与 401 区分：不是"没带凭据" | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/common/GlobalExceptionHandler.java#biz` |
| R-012 | 下载凭据码为 `DOWNLOAD_TICKET_EXPIRED` → HTTP **410 GONE` | 无 | 凭据过期不可复用 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/common/GlobalExceptionHandler.java#biz` |
| R-013 | 码为 `CREDENTIAL_SERVICE_UNAVAILABLE` → **503**；`CREDENTIAL_SERVICE_UNREACHABLE` → **502** | 无（不做通配） | 依赖不可用与依赖不可达分开，运维不会把 400 当用户输入问题 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/common/GlobalExceptionHandler.java#biz` |
| R-014 | 码为 `CREDENTIAL_USER_NOT_IN_IDP` 或 `CREDENTIAL_DEV_MODE` → HTTP **409** | 无 | 账号集合与授权集合不一致 / dev 模式无凭据体系，显式拒绝不静默成功 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/common/GlobalExceptionHandler.java#biz` |
| R-015 | 抛 `com.plm.common.VersionConflict`（任务域命名子类及需求/物料/项目/文档四域共用）→ HTTP **409**，body 额外带 `currentVersion` 与 `yourVersion` | 无 | 调用方据版本号决定"刷新重做"而非"改参数" | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/common/GlobalExceptionHandler.java#versionConflict` |
| R-016 | 抛 `OptimisticLockingFailureException` 或 `OptimisticLockException`（JPA `@Version` 延迟刷新路径）→ HTTP **409**，code `VERSION_CONFLICT`，不带双方版本号 | 无（该路径取不到实体上下文） | 兜底使延迟刷新冲突不变成 500 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/common/GlobalExceptionHandler.java#optimisticLock` |
| R-017 | 抛 Spring `AccessDeniedException` → HTTP **403**，code 固定 `FORBIDDEN`，message 取 `AccessDeniedContext.describe(...)` | 无 | 越权统一出口 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/common/GlobalExceptionHandler.java#denied` |
| R-018 | 写方法（POST/PUT/PATCH/DELETE）且 URI 以 `/api/` 开头、携带长度 1..200 的 `Idempotency-Key` → 进入幂等登记链路 | GET 不参与；无键或超长键直接跳过过滤器 | 无键写请求不受幂等保护 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/security/IdempotencyFilter.java#shouldNotFilter` |
| R-019 | 命中 `(idem_key, method, path)` 且未过期（窗口 **24 小时**）且 actor 一致 → 直接重放原响应，不重复执行副作用，响应带 `Idempotent-Replay: true` | 无 | 重试不再重复建单；不同路径互不干扰 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/security/IdempotencyFilter.java#doFilterInternal` |
| R-020 | 同一幂等键被**不同用户**复用 → **不重放**，降级为按新请求执行 | 无 | 避免"重放他人响应"的信息泄露；仅记 WARN 日志 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/security/IdempotencyFilter.java#doFilterInternal` |
| R-021 | 业务响应状态码为 **2xx** 才写入 `t_idempotency`；非 2xx 不落库 | 无 | 失败/异常不占幂等键，用户可原样重试 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/security/IdempotencyFilter.java#doFilterInternal` |
| R-022 | 幂等登记（`t_idempotency` INSERT 或过期清理）抛异常 → 吞掉，业务响应照常返回 | 无 | 幂等能力不可用不拖垮已成功的业务写入，仅告警 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/security/IdempotencyFilter.java#doFilterInternal` |
| R-023 | `t_idempotency` 查询抛异常（表未就绪等）→ `findReplay` 返回 null，退化为**无幂等** | 无 | 退化为无幂等不影响业务正确性 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/security/IdempotencyFilter.java#findReplay` |
| R-024 | 过期幂等行不主动调度清理，靠每次写请求顺带 `DELETE ... WHERE expires_at < now()` | 无 | 超期键视同新请求；过期行惰性堆积 | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/security/IdempotencyFilter.java#doFilterInternal` |
| R-025 | 写操作成功后需**轮换** `Idempotency-Key`；键在页面挂载时生成一次且不轮换会导致第二次编辑拿到第一次响应 | 无 | 静默丢失用户修改（缺陷形态，规则方向为前端契约） | as-built | def:同指针 | `→ ipd/plm-app/backend/src/main/java/com/plm/security/IdempotencyFilter.java#doFilterInternal` |
