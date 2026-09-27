#!/usr/bin/env node
/**
 * scripts/probe-ctx-window.mjs — 上下文窗口开关的**最小**探针（不依赖网关/端口）
 *
 * 为什么单独一个探针而不是直接跑完整 harness：
 *   · 完整 harness 会占用生产的 53112 端口（要先停产品知识库），代价大、周期长；
 *   · 而"配置值 → 运行时读数 → 落到会话模型对象"这条链是**纯函数 + 一次会话创建**，可以就地验。
 * 完整验收仍在 `scripts/verify-tiangong.mjs`（A27/A27b/A27c/A28）里跑，本探针只做快速回归。
 *
 * 用法：node scripts/probe-ctx-window.mjs           # 读 agent .env 的实际配置
 *       KIMI_CODING_CTX_LENGTH=100K node scripts/probe-ctx-window.mjs   # 覆盖成别的值看是否生效
 * 输出：末行 `BATCH_CTX_PROBE PASS=<n> FAIL=<m>`
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

let pass = 0, fail = 0;
const check = (id, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✅ ${id}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  ❌ ${id}${detail ? " — " + detail : ""}`); }
};

// 1) agent 级 .env 注入（与生产 launcher 同一实现，V-014）
const { injectAgentEnv } = await import("./agent-env.mjs");
const lines = injectAgentEnv(ROOT);
console.log(`[probe] agent .env 注入：${lines.join("｜")}`);

// 2) 纯函数层：解析与优先级
const { parseContextWindowValue, resolveContextWindowOverride } = await import("../dist/agents/runtime.js");
check("parse:256K", parseContextWindowValue("256K") === 262144, `256K → ${parseContextWindowValue("256K")}`);
check("parse:262144", parseContextWindowValue("262144") === 262144, `262144 → ${parseContextWindowValue("262144")}`);
check("parse:1M", parseContextWindowValue("1M") === 1048576, `1M → ${parseContextWindowValue("1M")}`);
const saved = process.env.KIMI_CODING_CTX_LENGTH;
process.env.KIMI_CODING_CTX_LENGTH = "不是数字";
let threw = false;
try { resolveContextWindowOverride("kimi-coding", "kimi-for-coding"); } catch { threw = true; }
check("bad-value-loud", threw, threw ? "非法值抛错（不静默忽略）" : "非法值被静默忽略");
if (saved === undefined) delete process.env.KIMI_CODING_CTX_LENGTH; else process.env.KIMI_CODING_CTX_LENGTH = saved;
check("descriptor-priority", resolveContextWindowOverride("kimi-coding", "kimi-for-coding", 4096)?.source === "descriptor",
  "描述符声明优先于环境变量");

// 3) 装配层：运行时读数 + 页面渲染（页面用真实 render 函数，不另写一份期望值）
const { loadAndApply, readAgentAssemblyPlan } = await import("../config-adapter.mjs");
const { assembleAgent } = await import("../dist/agents/assemble.js");
const { renderPlmChatHtml } = await import("../dist/web/plm-chat.js");

const applied = loadAndApply();
const plan = readAgentAssemblyPlan(applied.env);
const descPath = path.join(ROOT, "agents", "tiangong", "agent.plugin.json");
const desc = JSON.parse(fs.readFileSync(descPath, "utf8"));

const asm = await assembleAgent(descPath, applied.moziConfig, {
  baseDir: ROOT,
  sessionDir: path.join(ROOT, ".verify-sessions", "ctx-probe"),
});
const info = asm.runtime.llmInfo();
console.log(`[probe] llmInfo = ${JSON.stringify(info)}`);
// 期望值独立算：环境变量字面量（探针里若注入过覆盖值，就以覆盖值为准）
const envRaw = process.env.KIMI_CODING_CTX_LENGTH;
const expectWin = envRaw ? parseContextWindowValue(envRaw) : 262144; // pi 目录 kimi-for-coding 自带 262144
check("runtime-effective", info.contextWindow === expectWin,
  `运行时 ${info.contextWindow}｜期望 ${expectWin}（来源 ${info.contextWindowSource}）`);
check("provider-model", info.provider === "kimi-coding" && info.model === desc.llmProfile.model,
  `${info.provider} / ${info.model}`);
check("display-name-is-config", asm.runtime.modelDisplayName() === desc.llmProfile.model,
  `显示名 ${asm.runtime.modelDisplayName()} == 描述符 ${desc.llmProfile.model}`);

const html = renderPlmChatHtml({
  agentId: "tiangong",
  config: applied.moziConfig,
  llm: { ...info, displayName: asm.runtime.modelDisplayName() },
});
const shown = /模型：<code>([^<]*)<\/code>/.exec(html)?.[1];
const baseline = applied.moziConfig.agent.defaultModel;
check("page-model-real", shown === desc.llmProfile.model && shown !== baseline,
  `页面显示 ${shown}｜描述符 ${desc.llmProfile.model}｜基线档 ${baseline}`);
check("page-ctx-shown", new RegExp(`上下文：<code>${Math.round(expectWin / 1024)}K</code>`).test(html),
  `页面含上下文 ${Math.round(expectWin / 1024)}K`);

// 4) 一句真实对话：验证会话模型对象上的窗口值（"生效"的唯一可信判据）
let modelCtx = null;
try {
  const a = await asm.runtime.chat({
    channelId: "webchat",
    chatId: "ctx-probe",
    chatType: "direct",
    senderId: "probe",
    content: "回复两个字：收到",
    messageId: "ctx-probe-1",
    timestamp: Date.now(),
  });
  const session = [...asm.runtime.sessions.values()][0];
  modelCtx = session?.agent?.state?.model?.contextWindow ?? null;
  console.log(`[probe] 真实对话回复：${(a.content || "").slice(0, 60)}｜会话模型 contextWindow=${modelCtx}`);
} catch (e) {
  console.log(`[probe] 真实对话失败（不据此判红，只记录）：${e.message}`);
}
check("session-model-window", modelCtx === null ? false : modelCtx === expectWin,
  modelCtx === null ? "未取到会话模型（模型端点不可用？）" : `会话模型窗口 ${modelCtx}｜期望 ${expectWin}`);

console.log(`\nBATCH_CTX_PROBE PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
