# harness API 请求清单（ApiRequest）

客户端 → 服务端方向的对端请求变体。传输/信封契约见 `harness-api-transport.md`，回帧事件与错误码见 `harness-api-events.md`。

所有请求行在 NDJSON 帧内写作 `{"v":1,"id":<u64>,"req":<下表 tag>}`；`tag` 取自枚举的 `rename_all="snake_case"`。

| ID | 名称 | 签名/路由 | 鉴权 | 幂等 | 错误码 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| I-011 | 版本握手 | `hello {min_version, max_version, client}`；必须是连接首帧 | 无凭据字段 | 否（建立连接态） | `unsupported_version` | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::Hello |
| I-012 | 列出会话 | `list_sessions {include_archived=false}` | 无凭据字段 | 有副作用（可触发保留期自动归档） | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::ListSessions |
| I-013 | 归档会话 | `archive_session {session_id}` | 无凭据字段 | 是（转录不删除） | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::ArchiveSession |
| I-014 | 恢复会话 | `restore_session {session_id}` | 无凭据字段 | 是 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::RestoreSession |
| I-015 | 设置保留策略 | `set_retention_policy {archive_after_days?}`；缺省为关闭 | 无凭据字段 | 是（覆盖式设置） | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::SetRetentionPolicy |
| I-016 | 新建并挂载会话 | `create_session {working_dir?}` | 无凭据字段 | 否（每次新建） | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::CreateSession |
| I-017 | 挂载已有会话 | `attach_session {session_id}`，并订阅其事件流 | 无凭据字段 | 是 | `unknown_session`（文档） | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::AttachSession |
| I-018 | 取消挂载 | `detach_session {session_id}` | 无凭据字段 | 是 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::DetachSession |
| I-019 | 发送用户消息 | `send_message {session_id, content, images, no_reply=false}` | 无凭据字段 | 否（入队并起新回合） | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::SendMessage |
| I-020 | 取消生成 | `cancel {session_id}`，中止在途生成 | 无凭据字段 | 未声明 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::Cancel |
| I-021 | 软中断 | `soft_interrupt {session_id, content, urgent=false}`；下个安全点注入，不取消当前回合 | 无凭据字段 | 否 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::SoftInterrupt |
| I-022 | 读取历史 | `get_history {session_id}`；只对本连接已挂载的会话有效 | 无凭据字段 | 是 | `unknown_session`（文档） | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::GetHistory |
| I-023 | 窥视任意会话尾部 | `peek_session {session_id, limit?}`；无需挂载，取末尾若干条 | 无凭据字段 | 是 | `unknown_session`（文档） | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::PeekSession |
| I-024 | 清空历史 | `clear {session_id}` | 无凭据字段 | 否（不可逆删历史） | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::Clear |
| I-025 | 回退历史 | `rewind {session_id, message_index}`；index 为 1 基 | 无凭据字段 | 否（破坏性） | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::Rewind |
| I-026 | 回应权限请求 | `permission_response {session_id, request_id, decision}` | 无凭据字段 | 未声明 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::PermissionResponse |
| I-027 | 列出可用模型 | `list_models {session_id}`；取自 attach 时下发的目录 | 无凭据字段 | 是 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::ListModels |
| I-028 | 取运行时信息 | `get_runtime_info {session_id}`；回 provider 与全部路由 | 无凭据字段 | 是 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::GetRuntimeInfo |
| I-029 | 写入 API Key | `set_api_key {provider, api_key}`；落 owner-only 凭据库，OAuth token 不在内 | 无凭据字段 | 是（覆盖写） | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::SetApiKey |
| I-030 | 清除 API Key | `clear_api_key {provider}` | 无凭据字段 | 是（幂等删除） | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::ClearApiKey |
| I-031 | 读文件 | `read_file {session_id, path, max_bytes?}`；路径限定在会话工作目录内 | 无凭据字段 | 是 | `invalid_request`（文档：越界/非 UTF-8） | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::ReadFile |
| I-032 | 查文件 | `find_files {session_id, query, limit?}`；按路径子串匹配，不区分大小写 | 无凭据字段 | 是 | `invalid_request`（文档） | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::FindFiles |
| I-033 | 全文搜索 | `search_text {session_id, query, path?, limit?}`；字面量匹配 UTF-8 文本 | 无凭据字段 | 是 | `invalid_request`（文档） | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::SearchText |
| I-034 | 读文件元数据 | `file_status {session_id, path}`；回 exists/kind/size/modified_ms | 无凭据字段 | 是 | `invalid_request`（文档） | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::FileStatus |
| I-035 | 切换模型 | `set_model {session_id, model}`；model 取自 `list_models` | 无凭据字段 | 是 | `invalid_request`（文档：未知模型） | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::SetModel |
| I-036 | 设置思考强度 | `set_reasoning_effort {session_id, effort}` | 无凭据字段 | 是 | `invalid_request`（文档：provider 拒绝时报错） | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::SetReasoningEffort |
| I-037 | 请求压缩上下文 | `compact {session_id}`；异步，下个安全点摘要，不打断当轮 | 无凭据字段 | 否（触发摘要） | `invalid_request`（文档：占用 <约 10% 时拒绝） | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::Compact |
| I-038 | 重命名会话 | `rename_session {session_id, title?}`；title 缺省表示清除自定义标题 | 无凭据字段 | 是 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::RenameSession |
| I-039 | 撤销回退 | `rewind_undo {session_id}`；恢复上一次 `rewind` 删掉的部分 | 无凭据字段 | 否（依赖上一步 rewind） | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::RewindUndo |
| I-040 | 撤回软中断 | `cancel_soft_interrupts {session_id}`；丢弃已排队未投递的软中断 | 无凭据字段 | 是（清空队列） | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::CancelSoftInterrupts |
| I-041 | 存活探测 | `ping`；无字段，回 `pong` | 无凭据字段 | 是 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::Ping |
| I-042 | 未知请求兜底 | `#[serde(other)] Unknown`；服务端回错误帧而非静默丢弃 | 无凭据字段 | 未声明 | `unknown_request` | contract | assert: TODO | → crates/jcode-harness-api/src/requests.rs#ApiRequest::Unknown |
