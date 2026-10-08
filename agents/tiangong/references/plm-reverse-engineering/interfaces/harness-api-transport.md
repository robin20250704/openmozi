# harness API 传输与帧契约

对外稳定接口（`jcode api-bridge` 提供）在线路上的封装与端点。请求清单见 `harness-api-requests.md`，事件与错误码见 `harness-api-events.md`。

| ID | 名称 | 签名/路由 | 鉴权 | 幂等 | 错误码 | 性质 | 保证 | → 指针 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| I-001 | API 套接字路径 | `JCODE_API_SOCKET`，否则 `<runtime_dir>/jcode-api.sock` | 未声明 | 是 | 未声明 | as-built | def:同指针 | → crates/jcode-harness-api/src/sockets.rs#api_socket_path |
| I-002 | 内部守护套接字路径 | `JCODE_SOCKET`，否则 `<runtime_dir>/jcode.sock` | 未声明 | 是 | 未声明 | as-built | def:同指针 | → crates/jcode-harness-api/src/sockets.rs#legacy_socket_path |
| I-003 | 运行时目录解析 | 顺序 `JCODE_RUNTIME_DIR` → `XDG_RUNTIME_DIR` → macOS `TMPDIR` → `temp_dir()/jcode-<user>` | 未声明 | 是 | 未声明 | as-built | def:同指针 | → crates/jcode-harness-api/src/sockets.rs#runtime_dir |
| I-004 | API 桥单实例锁 | `<api_socket>.lock` 上 `flock(LOCK_EX\|LOCK_NB)`；抢不到即退出 | 未声明 | 是 | 未声明 | as-built | def:同指针 | → crates/jcode-harness-api-server/src/lib.rs#single_instance_lock |
| I-005 | 单帧字节上限 | 16 MiB（`MAX_FRAME_BYTES`）；超限帧被拒，不断行即报错 | 未声明 | 是 | `internal`（读帧失败） | contract | assert: TODO | → crates/jcode-harness-api-server/src/lib.rs#MAX_FRAME_BYTES |
| I-006 | 协议版本常量 | `API_VERSION_MAJOR=1`、`API_VERSION_MINOR=0` | 未声明 | 是 | `unsupported_version` | contract | assert: TODO | → crates/jcode-harness-api/src/lib.rs#API_VERSION_MAJOR |
| I-007 | 客户端帧信封 | `{"v":<major>,"id":<u64>,"req":<ApiRequest>}`；`id` 每连接单调递增 | 无凭据字段 | 否（占 id） | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/lib.rs#ClientFrame |
| I-008 | 服务端帧信封 | `{"v":<major>,"reply_to":<u64\|null>,"ev":<ApiEvent>}`；流式事件可无 `reply_to` | 无凭据字段 | 是 | 未声明 | contract | assert: TODO | → crates/jcode-harness-api/src/lib.rs#ServerFrame |
| I-009 | 帧写入 | `write_frame<W:Write,T:Serialize>`：序列化为单行 NDJSON 并 flush | 未声明 | 是 | `FrameError::Io` / `Json` | contract | assert: TODO | → crates/jcode-harness-api/src/client.rs#write_frame |
| I-010 | 帧读取 | `read_frame<R:BufRead,T:DeserializeOwned>`：跳空行；EOF 返回 `FrameError::Eof` | 未声明 | 是 | `FrameError::Eof` | contract | assert: TODO | → crates/jcode-harness-api/src/client.rs#read_frame |
