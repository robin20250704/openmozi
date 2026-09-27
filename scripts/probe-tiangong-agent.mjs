#!/usr/bin/env node
/**
 * scripts/probe-tiangong-agent.mjs — 绕过 WebChat，直接打 AgentRuntime（临时诊断脚本）
 *
 * 为什么需要它：Web UI 里回答为空时，"是 agent 不出话"还是"是 WS 层没转发"必须分开判定。
 * 本脚本直接把一句话喂给指定 agent 的 runtime（同一套描述符装配、同一套工具），
 * 打印**非流式**结果与耗时，把故障面缩到一处。
 *
 * 用法：node scripts/probe-tiangong-agent.mjs [--q="..."] [--agent=tiangong] [--stream]
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
}));
const agentId = args.agent || "tiangong";
const question = args.q || "新增料号在哪里操作？";

const envText = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
for (const k of ["MINIMAX_API_KEY", "MINIMAX_MODEL", "MINIMAX_ANTHROPIC_BASE_URL", "AGENT_DEFAULT_PROVIDER", "AGENT_DEFAULT_MODEL", "LOG_LEVEL"]) {
  const v = envText.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();
  if (v && process.env[k] === undefined) process.env[k] = v;
}
if (process.env.MINIMAX_CN_API_KEY === undefined && process.env.MINIMAX_API_KEY) process.env.MINIMAX_CN_API_KEY = process.env.MINIMAX_API_KEY;
process.env.TIANGONG_API_URL = process.env.TIANGONG_API_URL || "http://127.0.0.1:53112";
if (args.debug) process.env.LOG_LEVEL = "debug";

const { loadAndApply } = await import("../config-adapter.mjs");
const { assembleAgent, AGENT_DESCRIPTOR_FILE } = await import("../dist/agents/assemble.js");
const { setLogger, createLogger } = await import("../dist/utils/logger.js");
setLogger(createLogger({ level: process.env.LOG_LEVEL || "info" }));

const { moziConfig } = loadAndApply();
console.log(`[probe] provider=${moziConfig.agent.defaultProvider} model=${moziConfig.agent.defaultModel} keyLen=${(process.env.MINIMAX_API_KEY || "").length}`);
const tmpSessions = path.join(ROOT, ".verify-sessions", "probe-agent");
fs.rmSync(tmpSessions, { recursive: true, force: true });
fs.mkdirSync(tmpSessions, { recursive: true });

const descriptorPath = path.join(ROOT, "agents", agentId, AGENT_DESCRIPTOR_FILE);
const asm = await assembleAgent(descriptorPath, moziConfig, { baseDir: ROOT, sessionDir: tmpSessions });
console.log(`[probe] agent=${agentId} 工具=${asm.registeredToolNames.join(",")} libDir=${asm.descriptor.libDir}`);

const context = {
  channelId: "webchat",
  chatId: `webchat:probe.${Date.now()}`,
  messageId: "probe-1",
  senderId: "plm.probe",
  senderName: "探针",
  content: question,
  chatType: "direct",
  timestamp: Date.now(),
};

const t0 = Date.now();
if (args.stream) {
  let text = "";
  let events = 0;
  try {
    for await (const ev of asm.runtime.chatStream(context, {})) {
      events++;
      const kind = ev?.type || typeof ev;
      console.log(`[probe] +${Date.now() - t0}ms event#${events} ${kind} ${JSON.stringify(ev).slice(0, 200)}`);
      if (typeof ev === "string") text += ev;
      else if (ev?.delta) text += ev.delta;
    }
  } catch (e) {
    console.log(`[probe] 流异常 +${Date.now() - t0}ms: ${e.message}`);
  }
  console.log(`[probe] 流完成 +${Date.now() - t0}ms｜事件 ${events}｜正文 ${text.length} 字：${text.slice(0, 300)}`);
} else {
  try {
    const r = await asm.runtime.chat(context);
    console.log(`[probe] chat() 完成 +${Date.now() - t0}ms`);
    console.log(`[probe] content(${String(r?.content || "").length} 字)：${String(r?.content || "").slice(0, 400)}`);
    console.log(`[probe] usage=${JSON.stringify(r?.usage)}`);
  } catch (e) {
    console.log(`[probe] chat() 异常 +${Date.now() - t0}ms: ${e.message}`);
  }
}
process.exit(0);
