/**
 * 一次性诊断：Web 端看到的答案在 10 个字符处断掉（"你是「plm.zha"），
 * 但同一句问两次都断在同一处 —— 确定性截断，不像网络抖动。
 *
 * 判别思路：**比两处文本**
 *   · 流式累加的 text_delta（用户看到的）
 *   · session.getLastAssistantText()（chatStream 的返回值，pi 认的最终正文）
 * 两者不等 ⇒ 是**转发链路丢字**（实现缺陷）；相等 ⇒ 是上游只吐了这么多（上游问题）。
 * 另外把 tool_start/tool_end 也打出来：如果答案正好停在"要调工具"的位置，就是工具回合的后续文本没被转发。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..");
const TMP = path.join(ROOT, ".verify-sessions", "diag-trunc");

// agent 级 .env（与生产 launcher 同一套注入，V-014）
const { injectAgentEnv } = await import(pathToFileURL(path.join(ROOT, "scripts", "agent-env.mjs")).href);
injectAgentEnv(ROOT);

// 天工工具在模块加载时读 BASE（L-042）：指向**临时知识库**，避免诊断写生产台账
process.env.TIANGONG_API_URL = process.env.TIANGONG_DIAG_API_URL || "http://127.0.0.1:53197";
process.env.TIANGONG_PORT = "53197";
process.env.P4_DIAG_ENABLED = "true";

const { loadAndApply } = await import(pathToFileURL(path.join(ROOT, "config-adapter.mjs")).href);
const { assembleAgent, AGENT_DESCRIPTOR_FILE } = await import(pathToFileURL(path.join(ROOT, "dist/agents/assemble.js")).href);

const applied = loadAndApply();
const gwConfig = { ...applied.moziConfig, channels: {}, sessions: { type: "file", directory: path.join(TMP, "sessions") } };
fs.mkdirSync(path.join(TMP, "sessions"), { recursive: true });

const asm = await assembleAgent(path.join(ROOT, "agents", "tiangong", AGENT_DESCRIPTOR_FILE), gwConfig, {
  baseDir: ROOT, sessionDir: path.join(TMP, "sessions"),
});

const context = {
  channelId: "webchat", chatId: "diag:trunc", messageId: "diag-1",
  senderId: "plm.zhang", senderName: "张工",
  content: process.argv[2] || "你知道我是谁吗？只回答身份，不要做别的事。",
  chatType: "direct", timestamp: Date.now(),
};

const t0 = Date.now();
const gen = asm.runtime.chatStream(context, {});
let streamed = "";
const events = [];
let ret = null;
for (;;) {
  const { value, done } = await gen.next();
  if (done) { ret = value; break; }
  if (value?.type === "text_delta") streamed += value.delta;
  else events.push(`${value?.type}:${value?.name ?? ""}${value?.isError ? "(err)" : ""}`);
}
const finalText = String(ret?.content ?? "");
console.log(JSON.stringify({
  elapsedMs: Date.now() - t0,
  toolEvents: events,
  streamedLen: streamed.length,
  finalLen: finalText.length,
  equal: streamed === finalText,
  // 与 harness 的 A35 判据同式：流式文本是最终正文的前缀且更短 ⇒ 丢了尾巴
  tailLost: finalText.startsWith(streamed) && streamed.length < finalText.length,
  streamed,
  final: finalText,
  usage: ret?.usage,
}, null, 2));
process.exit(0);