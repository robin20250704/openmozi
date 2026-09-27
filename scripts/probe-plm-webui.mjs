#!/usr/bin/env node
/**
 * scripts/probe-plm-webui.mjs — 天工 PLM Web UI 的端到端探针（临时脚本，人工排查用）
 *
 * 用途：真实走一遍"打开页面 → 连 WS（带身份）→ 发一句话 → 收流式回答"，
 * 并把每一步的**原始观测**打出来（不是结论）。harness（verify-tiangong.mjs）里的
 * 断言与它同源，但 harness 要可重复、可计数；这里给人看现场。
 *
 * 用法：node scripts/probe-plm-webui.mjs [--agent=tiangong] [--user=plm.zhang] [--name=张工] [--q="..."]
 */
import WebSocket from "ws";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  })
);

const BASE = process.env.PLM_BASE || "http://127.0.0.1:33000";
const agent = args.agent || "tiangong";
const user = args.user ?? "plm.zhang";
const name = args.name ?? "张工";
const question = args.q || "你知道我是谁吗？另外问一下，新增料号在哪里操作？";

console.log(`[probe] BASE=${BASE} agent=${agent} user=${user || "(匿名)"} name=${name || "(无)"}`);

// ① 页面
const pageRes = await fetch(`${BASE}/tiangong`);
const pageHtml = await pageRes.text();
const tokens = ["--primary: #2563eb", "--sidebar: #0f172a", "--ai: #8b5cf6", "--bg: #f1f5f9", "--med: #0d9488"];
console.log(`[probe] GET /tiangong → ${pageRes.status} ${pageRes.headers.get("content-type")} ${pageHtml.length}B`);
for (const t of tokens) console.log(`[probe]   令牌 ${t.padEnd(24)} ${pageHtml.includes(t) ? "命中" : "缺失 ✗"}`);
const external = [...pageHtml.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
console.log(`[probe]   外部资源引用：${external.length ? external.join(", ") : "无（离线可用）"}`);

// ② WS：带身份（查询参数回落，等价于浏览器能做到的最大限度）
const qs = new URLSearchParams({ agent });
if (user) qs.set("user", user);
if (name) qs.set("name", name);
const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?${qs}`);

let connectedPayload = null;
let answer = "";
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("90000ms 内没有收到 done")), 90000);
  ws.on("open", () => console.log("[probe] WS 已连接"));
  ws.on("message", (buf) => {
    const frame = JSON.parse(buf.toString());
    if (frame.type === "event" && frame.event === "connected") {
      connectedPayload = frame.payload;
      console.log(`[probe] connected → agent=${frame.payload.agent} matched=${frame.payload.agentMatched} sessionKey=${frame.payload.sessionKey} user=${JSON.stringify(frame.payload.user)}`);
      ws.send(JSON.stringify({ type: "req", id: "1", method: "chat.send", params: { message: question } }));
    }
    if (frame.type === "event" && frame.event === "chat.delta") {
      if (frame.payload.delta) answer += frame.payload.delta;
      if (frame.payload.done) { clearTimeout(timer); resolve(); }
    }
    if (frame.type === "event" && frame.event === "chat.error") {
      clearTimeout(timer);
      reject(new Error(frame.payload.error));
    }
  });
  ws.on("error", (e) => { clearTimeout(timer); reject(e); });
});

try {
  await done;
  console.log("[probe] 提问：", question);
  console.log("[probe] 回答：", answer);
  const hasIdentity = /张工/.test(answer) || /plm\.zhang/.test(answer);
  console.log(`[probe] 身份贯通（回答里出现「张工」或 plm.zhang）：${hasIdentity ? "是" : "否 ✗"}`);
} catch (e) {
  console.error("[probe] 失败：", e.message);
  process.exitCode = 1;
} finally {
  ws.close();
  void connectedPayload;
}
