# 分片：PLM HTTP 契约（plm-http-contract）

| ID | 名称 | 签名/路由 | 鉴权 | 幂等 | 错误码 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| I-081 | PLM 服务基地址 | `http://127.0.0.1:8081`（dev 容器 `plm-service`；nginx 侧 `plm-web` :5174 反代 `/api`） | 视端点 | — | — | as-built | def:同指针 | → ipd/deploy/wsl/plm-app/docker-compose.plm-app.yml |
| I-082 | **PLM HTTP 真身 = 生成的 OpenAPI** | `GET /v3/api-docs`（匿名可达，白名单内）；实测 2026-10-05：**438 路径 / 530 操作 / 51 个 controller tag** | 免认证 | — | — | as-built | def:同指针 | → ipd/plm-app/backend/pom.xml#springdoc-openapi-starter-webmvc-ui |
| I-083 | **部署态只认 `oidc`**：`X-PLM-User` 不是身份 | `PLM_AUTH_MODE` 兜底恒为 `oidc`（Keycloak JWT）；带该头的匿名请求 **401** | 须认证 | — | 401 | contract | assert:ipd/deploy/wsl/plm-app/plm-b33-security-verify.py | → ipd/deploy/wsl/plm-app/docker-compose.plm-app.yml#PLM_AUTH_MODE |
| I-084 | 凭据形态（`oidc` 是唯一部署态，见 I-083） | `Authorization: Bearer <JWT>`；角色取自 `realm_access.roles`，授权前缀空串 | — | — | — | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/security/SecurityConfig.java#jwtConverter |
| I-085 | 免认证白名单是**闭集**：恰好 8 条 | `/swagger-ui.html`、`/swagger-ui/**`、`/v3/api-docs/**`、`/actuator/health`、`/error`、`/api/v1/_platform/pms/webhook`、`/api/v1/documents/files/download-by-ticket`、`/api/v1/_tiangong/auth` | 免认证 | — | 其余一律 401 | contract | assert:ipd/deploy/wsl/plm-app/plm-b33-security-verify.py | → ipd/plm-app/backend/src/main/java/com/plm/security/SecurityConfig.java#filterChain |
| I-086 | **生成的 spec 里没有任何 `security` 声明**（530 个操作全为空） | 照 `/v3/api-docs` 判断"这个接口要不要凭据"会得出**全部免认证**的错误结论 | — | — | — | as-built | def:同指针 | → ipd/plm-app/backend/src/main/java/com/plm/security/SecurityConfig.java#filterChain |
| I-087 | 写请求幂等键（可选头） | `Idempotency-Key: <≤200 字符>`；仅对 `POST`/`PUT`/`PATCH`/`DELETE` 且 URI 以 `/api/` 开头生效；缺头或超长 ⇒ 不走幂等 | 需认证 | 是 | — | contract | assert:.creature/tasks/plm-reverse-engineering-complete/probe-idempotency.cjs | → ipd/plm-app/backend/src/main/java/com/plm/security/IdempotencyFilter.java#shouldNotFilter |
| I-088 | 幂等键的匹配三元组与保留窗口 | 命中 `(idem_key, method, path)` 且未过期 ⇒ **重放原响应、不执行副作用**；只缓存 2xx（非 5xx），窗口 **24 h**，过期行惰性清理 | 需认证 | 是 | — | contract | assert:.creature/tasks/plm-reverse-engineering-complete/probe-idempotency.cjs | → ipd/plm-app/backend/src/main/java/com/plm/security/IdempotencyFilter.java#doFilterInternal |
| I-089 | 幂等重放的可观测信号 | 重放响应带 `Idempotent-Replay: true` 头——调用方可据此区分"真执行"与"重放" | — | — | — | contract | assert:.creature/tasks/plm-reverse-engineering-complete/probe-idempotency.cjs | → ipd/plm-app/backend/src/main/java/com/plm/security/IdempotencyFilter.java#doFilterInternal |
| I-090 | 幂等记录表与唯一约束 | `t_idempotency`，唯一键 `(idem_key, method, path)`；并发同键写入 `ON CONFLICT DO NOTHING`；登记失败只告警**不影响业务响应** | 须认证 | 是 | — | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration |
| I-091 | 幂等键绑定 actor | 同一键被**不同** actor 复用时**拒绝重放**（防重放他人响应），按新请求执行并告警 | 须认证 | — | — | contract | assert:.creature/tasks/plm-reverse-engineering-complete/probe-idempotency.cjs | → ipd/plm-app/backend/src/main/java/com/plm/security/IdempotencyFilter.java#doFilterInternal |
| I-092 | **统一错误体** `{code, message, ts}` | 过滤链出口（401/403）与 MVC 出口共用同一份单点序列化；`VersionConflict` 的 409 在同一形状上**多带双方版本号** | — | — | 见 I-093 | contract | assert:ipd/deploy/wsl/plm-app/plm-b33-security-verify.py | → ipd/plm-app/backend/src/main/java/com/plm/security/SecurityConfig.java#filterChain |
| I-093 | 错误码 → HTTP 映射（代码是权威） | `BizException.code` 由各 `@ExceptionHandler` 映射：401 未认证 / 403 `FORBIDDEN` / 404 不存在 / 409 `VERSION_CONFLICT` / 410 已作废 / 413 / 416 / 400 参数非法 / 503 下游不可用 / 502 网关错 | — | — | 10 类 | contract | assert:ipd/deploy/wsl/plm-app/plm-b33-security-verify.py | → ipd/plm-app/backend/src/main/java/com/plm/common/GlobalExceptionHandler.java |
| I-094 | 幂等头契约的定义点在后端，前端只是消费者 | 前端 `plm-grid/commit.ts` + `api/client.ts` 按同一契约注入头；**成功后才轮换键**（不轮换会让第二次编辑拿到第一次的响应） | — | — | — | contract | assert:.creature/tasks/plm-reverse-engineering-complete/probe-idempotency.cjs | → ipd/plm-app/backend/src/main/java/com/plm/security/IdempotencyFilter.java |
| I-095 | **DB 层的约束与触发器不在 spec 里**（第二个措辞级坑，与 I-086 并列） | spec 说"这个字段是 string"，**不等于**"什么 string 都写得进去"：`t_product.status` 有 7 态闭集 CHECK、`t_project` 双列有 CHECK + 触发器（见 R-184~R-186）。**读 spec 得出"可以随便填"⇒ 调用会在 DB 层被拒** | — | — | — | as-built | def:同指针 | → ipd/plm-app/backend/src/main/resources/db/migration |

> **本片为什么只有 15 条、而不是 530 条**：530 个操作的真身是**生成的** spec（I-082），抄进树就是造第二份真身、且必漂移。
> 本片只声明 spec **给不出**、或 spec **会说错**的东西——那就是它的全部理由：
> ① `security` 全空（I-086）；② **DB 层约束/触发器不在 spec 里**（I-095）；
> ③ 免认证闭集与错误体形状（代码里、不在注解里）；④ 幂等键契约（在 filter 里，扫注解看不见）；
> ⑤ 服务基地址与**部署态认证口径**（在部署编排里，不在 spec 里）。
>
> **`def:同指针` 的解析目标必须是代码、不是散文**（本树纪律 §1）：所以本片指针一律指 `.java`，
> 只有 I-081 与 I-083 指部署编排（这两条事实的唯一定义点就是那份 compose）。
>
> **`assert:` 的两条已落地**：I-083 / I-085 / I-092 / I-093 由常驻套件 `plm-b33-security-verify.py` 守；
> I-087~I-089 / I-091 / I-094 由**运行态探针** `probe-idempotency.cjs` 守（2026-10-05 实测 **19/19 绿**，
> 含 4 组负向对照：无键不幂等 / 换路径不重放 / 换 actor 不重放 / 失败不入表）。
> **诚实标注**：该探针目前是**一次性脚本**，还没回收成 `plm-suites.tsv` 里的常驻套件——那是下一步。
>
> **I-083 为什么不写成"二选一"**：代码里 `plm.security.mode` 确有 `dev`/`oidc` 两值，`application.yml`
> 的兜底甚至仍是 `dev`（服务"宿主直跑 `mvn spring-boot:run`"的本地开发）。但**接口契约描述的必须是
> 对调用方有效的运行态**：容器部署路径一律 oidc，`dev` 要改配置 + 重启才开。写成"二选一"会让读者
> 以为可以拿 `X-PLM-User` 调接口——而实测是 401（S1.3）。故本行只声明 oidc，并把"不是二选一"这条
> 判据交给常驻套件守（S1.6 断言 compose 兜底 = oidc）。
