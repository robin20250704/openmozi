#!/usr/bin/env node
/**
 * tiangong-relay.mjs —— 把本机回环上的小天网关，映射到一个"可供 WSL 容器 / 反向隧道访问"的端口。
 *
 * ===========================================================================
 * 为什么需要它（而不是让 nginx 直接连 127.0.0.1:33000）
 *
 * 小天网关（openmozi）按安全裁定只监听回环。而 PLM 的部署形态是 **WSL/Docker 容器**：
 *   容器 → host.docker.internal → 宿主的 WSL 侧地址（172.28.0.1）→ 需要宿主有个**非回环**监听口。
 * 三条可行路线，本脚本取第三条：
 *   ① 让 openmozi 自己监听 0.0.0.0：可行，但那是"把无鉴权的服务直接暴露到局域网"，
 *      C-045 家族的裁定要求它保持回环；且用户会看到"端口对全网开放"，风险与收益不成比例。
 *   ② Windows `netsh portproxy`：要管理员权限 + 一条**防火墙放行规则**（否则请求被静默丢弃，
 *      症状是"容器连不上但没有报错"，极难排查）。本机已在用一堆 portproxy（见 env-pool E-006），
 *      再加一条会继续加深这种依赖。
 *   ③ **本脚本**：纯用户态 TCP 转发，不碰注册表、不改防火墙、不需要管理员。
 *      代价是要多跑一个 50 行的 node 进程（由 `start-tiangong.ps1` 负责拉起与守护）。
 *
 * 端口分工（刻意分开，便于"哪一段断了"可判定）：
 *   33000  小天网关自身（回环，认证由 PLM 网关负责，这里不碰）
 *   33030  本转发监听口 = **PLM 前端镜像里写死的上游**（frontend/nginx.conf 的 $tiangong_upstream）
 *          dev：容器经 host.docker.internal 直达这里
 *          UAT：开发机经反向 SSH 隧道把本口映射到 UAT 宿主 127.0.0.1:33030，容器再经宿主网关到达
 *
 * ===========================================================================
 * 明确不做的事（避免"半个反向代理"这种最难维护的东西）
 *   · 不解析 HTTP、不检查票据、不改任何头 —— 身份注入是 PLM 前端 nginx 的职责，
 *     在这里再做一层就等于出现第二份判定实现。
 *   · 不做 TLS。
 *   · 不做访问控制：它只应监听本机 + WSL/隧道可达面。真正的门在 PLM 侧（须先认证）。
 *
 * 用法：
 *   node tiangong-relay.mjs                 # 默认 0.0.0.0:33030 → 127.0.0.1:33000
 *   LISTEN_PORT=... TARGET_PORT=... node tiangong-relay.mjs
 */

import net from "node:net";

const LISTEN_HOST = process.env.RELAY_HOST || "0.0.0.0";
const LISTEN_PORT = Number(process.env.RELAY_PORT || 33030);
const TARGET_HOST = process.env.RELAY_TARGET_HOST || "127.0.0.1";
const TARGET_PORT = Number(process.env.RELAY_TARGET_PORT || 33000);

let connSeq = 0;
let active = 0;

const server = net.createServer({ allowHalfOpen: false }, (client) => {
  const id = ++connSeq;
  active++;
  const upstream = net.connect({ host: TARGET_HOST, port: TARGET_PORT });

  // 双向管道用 pipe：它自动处理背压与 FIN 传播（自己写 data 转发会漏掉半关闭，
  // 表现为 WebSocket 连接"发得出去、收不回来"，而两端日志都正常）。
  const done = (why) => {
    if (!client.destroyed) client.destroy();
    if (!upstream.destroyed) upstream.destroy();
    if (why) log(`#${id} 结束（${why}）`);
  };

  upstream.on("connect", () => {
    log(`#${id} 已连上 ${TARGET_HOST}:${TARGET_PORT}（来自 ${client.remoteAddress}）`);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  upstream.on("error", (e) => done(`上游错误 ${e.code || e.message}`));
  client.on("error", (e) => done(`客户端错误 ${e.code || e.message}`));
  // 只在一侧统计连接数（两侧都减会把计数打成负数 ⇒ 关停时的"活动连接 N"读数失真）
  client.on("close", () => { active--; if (!upstream.destroyed) upstream.end(); });
  upstream.on("close", () => { if (!client.destroyed) client.end(); });
});

function log(msg) {
  process.stdout.write(`[tiangong-relay] ${new Date().toISOString()} ${msg}\n`);
}

server.on("error", (e) => {
  // 端口被占是**最常见**的失败（例如上一份 relay 没退干净）。
  // 必须显式区分"端口占用"与"目标不可达"：前者要杀旧进程，后者要起小天。
  log(`监听失败：${e.code || e.message}` + (e.code === "EADDRINUSE" ? "（端口被占用：先停掉旧的 relay 进程）" : ""));
  process.exit(1);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`已就绪 ${LISTEN_HOST}:${LISTEN_PORT} → ${TARGET_HOST}:${TARGET_PORT}`);
  log(`PLM 前端（容器）经 host.docker.internal:${LISTEN_PORT} 到达这里；本口不鉴权，门在 PLM 侧`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`收到 ${sig}，关闭中（活动连接 ${active}）`);
    server.close(() => process.exit(0));
    // 不等长连接自然结束，否则"关了但没退出"会让守护脚本以为它还活着
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
