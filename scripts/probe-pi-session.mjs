#!/usr/bin/env node
// scripts/probe-pi-session.mjs — 直接打 pi 会话层（临时诊断；回答为空时用来分离"模型没吐"与"上层没转发"）
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..");
process.chdir(ROOT);
const envText = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
for (const k of ["MINIMAX_API_KEY", "MINIMAX_MODEL", "AGENT_DEFAULT_PROVIDER", "AGENT_DEFAULT_MODEL", "MINIMAX_ANTHROPIC_BASE_URL"]) {
  const v = envText.match(new RegExp("^" + k + "=(.*)$", "m"))?.[1]?.trim();
  if (v && process.env[k] === undefined) process.env[k] = v;
}
if (!process.env.MINIMAX_CN_API_KEY) process.env.MINIMAX_CN_API_KEY = process.env.MINIMAX_API_KEY;

const { loadAndApply } = await import("../config-adapter.mjs");
const { assembleAgent, AGENT_DESCRIPTOR_FILE } = await import("../dist/agents/assemble.js");
const { moziConfig } = loadAndApply();
const asm = await assembleAgent(path.join(ROOT, "agents", "tiangong", AGENT_DESCRIPTOR_FILE), moziConfig, {
  baseDir: ROOT,
  sessionDir: path.join(ROOT, ".verify-sessions", "probe-raw"),
});
const rt = asm.runtime;
console.log("runtime 原型方法:", Object.getOwnPropertyNames(Object.getPrototypeOf(rt)).join(","));

const svc = await rt.getOrCreateSession("tiangong:webchat:raw.probe");
console.log("session 就绪:", Boolean(svc), "session.prompt:", typeof svc?.prompt, "agent:", typeof svc?.agent);
// 事件留痕：pi 到底有没有开始跑（agent_start/turn_start），是"没调模型"还是"调了但没内容"的分界线
const seen = [];
svc.subscribe((e) => { seen.push(e?.type || "?"); });
const t0 = Date.now();
try {
  // ① 不带 streamingBehavior（默认口径），看是否真的触发模型调用
  const p = await svc.prompt("你好，请只回复两个字：收到");
  console.log(`prompt(默认) 返回 +${Date.now() - t0}ms type=${typeof p} value=${JSON.stringify(p)?.slice(0, 200)}`);
  await svc.agent.waitForIdle();
  console.log(`idle +${Date.now() - t0}ms lastText=`, JSON.stringify(svc.getLastAssistantText?.() ?? "").slice(0, 200));
  console.log(`事件序列：${seen.join(" → ")}`);
  console.log(`stats=${JSON.stringify(svc.getSessionStats?.() ?? null).slice(0, 240)}`);
} catch (e) {
  console.log(`prompt 异常 +${Date.now() - t0}ms: ${e.message}`);
}
process.exit(0);
