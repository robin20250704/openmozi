# 负结果缓存（negatives）· PLM 客服

> 用途：把"已分析、确认排除"的结论缓存下来，避免重复调研（省的是 token 与注意力）。
> **失效条件必须写**：负结果不是永久真理——环境/版本/口径一变即作废（外部事件触发失效，而非仅时间衰减）。

| ID | 日期 | 结论（已排除） | 依据 | 失效条件 | 状态 |
| --- | --- | --- | --- | --- | --- |
| N-001 | 2026-09-27 | **不能用"Keycloak 密码授权（ROPC）"取 UAT token** —— `POST /realms/plm/protocol/openid-connect/token` 带 `grant_type=password` + `client_id=plm-web` 返回 `400 unauthorized_client: Client not allowed for direct access grants` | 实测（UAT SF-U07 关闭 direct access grant）；`D:\project\jcode\ipd\deploy\uat\harden-uat.sh` | UAT 重新开启 `plm-web` 的 direct access grant（不太可能，属于安全加固项） | 有效 |
| N-002 | 2026-09-27 | **不能复用 `:9222` 上外部 harness 的 headless Chrome 做 UAT 登录** | 见 `plm-lessons.md` L-002 实测 | 该实例带上 `--ignore-certificate-errors` 且可被证明（当前不可能证明） | 有效 |
| N-003 | 2026-09-27 | **`GET /api/v1/requirements/trace-target-types` 在 UAT 不存在**（源码有、UAT 返回 `404 ENDPOINT_NOT_FOUND`） | 实测 2026-09-27；源码 `RequirementController.java:213` | UAT 升级到包含该端点的版本 | 有效 |
| N-004 | 2026-09-27 | **登记时不能写 `priority` / `dfxDimension` / `verifyMethod` / `userPersona` / `userTags` / `appealsDim`**（会 `400 REQ_FIELD_STAGE_LOCKED`） | 源码 `RequirementService.java:407-463` + 元数据 V144 | 元数据 `is_post_analysis_only` 名单变更（须复核 `check` 的词表自检） | 有效 |
| N-005 | 2026-09-27 | **`GET /api/v1/_platform/dedup/clusters` 实测 504 超时**（不要用它做查重） | 实测（子代理勘验记录 `registration-contract.md`） | 该端点性能修复后 | 有效（次级证据，需复验） |
