# harness API 事件与错误码（ApiEvent / ErrorCode）

服务端 → 客户端方向的回帧与推送帧。请求侧清单见 `harness-api-requests.md`，传输契约见 `harness-api-transport.md`。

- 事件行在线路上写作 `{"v":1,"reply_to":<u64?>,"ev":<tag>}`，`tag` 取自 `rename_all="snake_case"`。
- **本片的事件均为服务端推送/回帧，幂等列统一记 `推送帧`（该维度不适用）**；鉴权列未声明者记 `未声明`。
- `hello_ok.capabilities` 的实际取值由桥接进程固定，见 I-043。

| ID | 名称 | 签名/路由 | 鉴权 | 幂等 | 错误码 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| I-043 | 握手确认 | hello_ok {version, server, capabilities?} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::HelloOk |
| I-044 | 通用成功回执 | ok | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::Ok |
| I-045 | 失败回执 | error {code: ErrorCode, message} | 未声明 | 推送帧 | 见 I-076~I-080 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::Error |
| I-046 | 会话列表 | sessions {sessions: [SessionInfo]} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::Sessions |
| I-047 | 已挂载会话 | attached {session} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::Attached |
| I-048 | 历史回执 | history {session_id, messages} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::History |
| I-049 | 存活回执 | pong | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::Pong |
| I-050 | 文本增量 | text_delta {session_id, text} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::TextDelta |
| I-051 | 推理增量 | reasoning_delta {session_id, text} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::ReasoningDelta |
| I-052 | 推理结束 | reasoning_done {session_id, duration_secs?} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::ReasoningDone |
| I-053 | 工具调用开始 | tool_start {session_id, call_id, name} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::ToolStart |
| I-054 | 工具入参增量 | tool_input_delta {session_id, call_id, delta} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::ToolInputDelta |
| I-055 | 工具执行 | tool_exec {session_id, call_id, name} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::ToolExec |
| I-056 | 工具结束 | tool_done {session_id, call_id, name, output, error?} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::ToolDone |
| I-057 | 令牌用量 | token_usage {session_id, input, output, cache_read_input?} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::TokenUsage |
| I-058 | 回合结束 | turn_done {session_id} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::TurnDone |
| I-059 | 外部唤醒请求 | wake_requested {session_id, reason, notification} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::WakeRequested |
| I-060 | 后台进度 | background_progress {session_id, task_id, label, percent?, summary, done} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::BackgroundProgress |
| I-061 | 消息已受理 | message_accepted {session_id} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::MessageAccepted |
| I-062 | 权限请求 | permission_request {session_id, request_id, tool_name, description} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::PermissionRequest |
| I-063 | 会话状态变更 | session_status {session_id, status} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::SessionStatus |
| I-064 | 链路阶段 | connection_phase {session_id, phase} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::ConnectionPhase |
| I-065 | 模型信息 | model_info {session_id, provider?, model?, reasoning_effort?} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::ModelInfo |
| I-066 | 模型目录 | models {session_id, models, current?} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::Models |
| I-067 | 运行时信息 | runtime_info {session_id, provider?, model?, reasoning_effort?, routes} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::RuntimeInfo |
| I-068 | 凭据已变更 | credential_updated {provider, configured} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::CredentialUpdated |
| I-069 | 文件内容 | file_content {session_id, path, content, size, truncated} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::FileContent |
| I-070 | 文件路径列表 | files {session_id, paths} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::Files |
| I-071 | 文本命中 | text_matches {session_id, matches} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::TextMatches |
| I-072 | 文件元数据 | file_status {session_id, path, exists, kind, size?, modified_ms?} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::FileStatus |
| I-073 | 压缩已受理 | compacted {session_id, message}；仅表示已受理，非已压缩 | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::Compacted |
| I-074 | 会话已改名 | session_renamed {session_id, title?, display_title} | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::SessionRenamed |
| I-075 | 未知事件兜底 | unknown（`#[serde(other)]`）；客户端须静默跳过 | 未声明 | 推送帧 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ApiEvent::Unknown |
| I-076 | 错误码·版本不支持 | unsupported_version | 未声明 | 推送帧 | — | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ErrorCode |
| I-077 | 错误码·请求未知 | unknown_request | 未声明 | 推送帧 | — | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ErrorCode |
| I-078 | 错误码·会话未知 | unknown_session | 未声明 | 推送帧 | — | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ErrorCode |
| I-079 | 错误码·请求非法 | invalid_request | 未声明 | 推送帧 | — | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ErrorCode |
| I-080 | 错误码·内部失败 | internal | 未声明 | 推送帧 | — | contract | assert: TODO | → crates/jcode-harness-api/src/events.rs#ErrorCode |

## 请求 → 错误码对照

映射**不在** `translate.rs` 里集中声明，而是分散在各 handler 分支中就地产生。以下为源码中可判定的实际产出点（非穷举）。

| 请求变体 | 错误码 | 触发条件 | → 指针 |
| --- | --- | --- | --- |
| hello | unsupported_version | 首帧非 `hello`，或 min/max 版本区间不含 v1 | → crates/jcode-harness-api-server/src/lib.rs#run_bridge |
| 18 个需挂载的请求 | unknown_session | 连接未 attach，或请求的 `session_id` ≠ 已挂载会话 | → crates/jcode-harness-api-server/src/translate.rs#REQUIRES_ATTACH |
| archive_session / restore_session | unknown_session | 会话记录文件不存在 | → crates/jcode-harness-api-server/src/translate.rs#api_request_to_legacy |
| archive_session / restore_session | internal | 归档状态落盘失败 | → crates/jcode-harness-api-server/src/translate.rs#api_request_to_legacy |
| permission_response | invalid_request | 恒定失败：桥接路径不发权限提示，无可回应对象 | → crates/jcode-harness-api-server/src/translate.rs#api_request_to_legacy |
| 任意未匹配 tag | unknown_request | 落入 `match` 的兜底 `other` 分支 | → crates/jcode-harness-api-server/src/translate.rs#api_request_to_legacy |
| read_file / find_files / search_text / file_status | invalid_request | 路径越出会话工作目录、或非普通文件 | → crates/jcode-harness-api-server/src/translate.rs#safe_session_path |
| read_file | internal | 文件打开后读取 I/O 失败 | → crates/jcode-harness-api-server/src/translate.rs#read_session_file |
| search_text | invalid_request | 查询串为空 | → crates/jcode-harness-api-server/src/translate.rs#api_request_to_legacy |
