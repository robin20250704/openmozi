#!/usr/bin/env node
/**
 * scripts/probe-xiaotian.mjs —— 小天（天工PLM客服）装配 + 模型 + 工具 冒烟探针
 *
 * 为什么单独写（而不是复用 verify-tiangong.mjs）：本批改了三件事 —— 模型换成 kimi-for-coding、
 * 工具面按"只读 + 需求填写"重建、agent 级 .env 注入凭据。这三件事的故障形态**都不是"页面 500"**，
 * 而是"模型不吭声""工具没注册""凭据没进来"。所以需要一个能一次把这三层都打出来的短探针。
 *
 * 检查项（每项都打印证据，不打印凭据）：
 *   ① 装配：工具个数与名字、模型 provider/model、数据域与白名单
 *   ② 模型：provider 能解析出模型（getModel 成功）+ 真实一次对话有输出（**这是本批的验收核心**）
 *   ③ 工具：plm_read_reference 的越界拒绝、plm_check_env / plm_whoami_plm 的真实返回
 *   ④ 写工具缺席：工具名里不含 write/edit/bash/glob/grep/ls 等编码工具
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
}));
const AGENT_ID = args.agent || "tiangong";
const QUESTION = args.q || "你好，请用一句话介绍你自己";
const SKIP_LLM = args.skipLlm === true;

// ── 环境：与生产同一条路（agent .env → process.env）─────────────────
const envText = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
for (const k of ["MINIMAX_API_KEY", "MINIMAX_MODEL", "AGENT_DEFAULT_PROVIDER", "AGENT_DEFAULT_MODEL", "LOG_LEVEL"]) {
  const v = envText.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();
  if (v && process.env[k] === undefined) process.env[k] = v;
}
const { injectAgentEnv } = await import("./agent-env.mjs");
for (const line of injectAgentEnv(ROOT)) console.log(`[probe] ${line}`);
console.log(`[probe] 模型 key 就位：KIMI_CODING_API_KEY=${process.env.KIMI_CODING_API_KEY ? "已配置" : "缺失"}｜PLM_USER=${process.env.PLM_USER || "缺失"}｜PLM_PASSWORD=${process.env.PLM_PASSWORD ? "已配置" : "缺失"}`);

const { loadAndApply } = await import("../config-adapter.mjs");
const { assembleAgent, AGENT_DESCRIPTOR_FILE } = await import("../dist/agents/assemble.js");
const { setLogger, createLogger } = await import("../dist/utils/logger.js");
setLogger(createLogger({ level: process.env.LOG_LEVEL || "warn" }));

const { moziConfig } = loadAndApply();
const sessionDir = path.join(ROOT, ".verify-sessions", "probe-xiaotian", "sessions");
fs.rmSync(path.dirname(sessionDir), { recursive: true, force: true });
fs.mkdirSync(sessionDir, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail) => { ok ? pass++ : fail++; console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); };

// ── ① 装配 ─────────────────────────────────────────────────────────
const asm = await assembleAgent(path.join(ROOT, "agents", AGENT_ID, AGENT_DESCRIPTOR_FILE), moziConfig, {
  baseDir: ROOT, sessionDir,
});
const toolNames = asm.registeredToolNames;
console.log(`[probe] 工具(${toolNames.length})：${toolNames.join(", ")}`);
console.log(`[probe] 模型：provider=${asm.runtime.config?.provider ?? "?"} model=${asm.runtime.config?.model ?? "?"}`);
console.log(`[probe] 数据域：${asm.descriptor.dataDomain}｜白名单=${JSON.stringify(asm.descriptor.allowedOrigins)}`);

check("①装配:描述符模型档", String(asm.descriptor.llmProfile?.provider) === "kimi-coding" && String(asm.descriptor.llmProfile?.model) === "kimi-for-coding",
  `llmProfile=${JSON.stringify(asm.descriptor.llmProfile)}`);
const declared = new Set(asm.descriptor.toolset ?? []);
const missing = [...declared].filter((t) => !toolNames.includes(t));
const extra = toolNames.filter((t) => !declared.has(t));
check("①装配:工具集与注册一致", missing.length === 0 && extra.length === 0, missing.length || extra.length ? `缺=${missing.join(",") || "-"} 多=${extra.join(",") || "-"}` : `${toolNames.length} 个，逐名一致`);

// ── ② 编码类写工具必须缺席 ──────────────────────────────────────────
// 判据分两段（第二版，第一版自己踩了两次坑，留档）：
//   ① 只看**非 plm_ 命名空间**的工具名 —— pi 的内置编码工具叫 `read`/`write`/`bash`…（**没有前缀**），
//      所以"有没有裸名的编码工具"才是真判据；`plm_read_reference` 是自研的只读工具，名字里必然含 read。
//   ② 再用**边界匹配**扫一遍，针对裸名/其他前缀的工具（子串匹配会把上一条误报）。
// 两版都不对的原因值得记：第一版用子串 → 把 plm_read_reference 误报；第二版只用边界 → 同样误报
// （`plm_read_reference` 的 `_read_` 正好满足边界）。**根因是"名字里含 read"与"是个读文件工具"不等价**，
// 所以判据必须锚在命名空间上，而不是锚在词形上（L-130 家族：判据的作用域要落在语义边界上）。
const FORBIDDEN = ["write", "write_file", "edit", "bash", "shell", "exec", "run_command", "glob", "grep", "ls", "read", "read_file", "create_file", "apply_patch", "str_replace"];
const builtinish = toolNames.filter((t) => !/^plm_/.test(t));
const present = builtinish.filter((t) => FORBIDDEN.some((f) => new RegExp(`(^|_)${f}($|_)`, "i").test(t)));
const strayNames = builtinish.filter((t) => !/^plm_/.test(t));
check("②工具面:无写文件/写代码/执行类工具", present.length === 0,
  present.length
    ? `发现禁用工具：${present.join(",")}`
    : `非 plm_ 命名空间工具 ${strayNames.length} 个（应为 0：pi 内置编码工具应已被 noTools:"builtin" 关闭）；plm_ 命名空间下已复核为只读/需求登记类`);

// ── ③ 只读工具的安全边界（越界必须被拒）────────────────────────────
const { plmReadReferenceTool } = await import(pathToFileURL(path.join(ROOT, "agents", AGENT_ID, "tools", "plm-read-reference.js")).href);
const traversal = await plmReadReferenceTool.execute("t1", { path: "../../../package.json" });
const traversalText = traversal.content?.[0]?.text ?? "";
check("③只读:越界路径被拒", traversal.isError === true && /路径越界/.test(traversalText), traversalText.slice(0, 90));
const listing = await plmReadReferenceTool.execute("t2", {});
check("③只读:可列参考资料", /kb\/plm-module-map\.md/.test(listing.content?.[0]?.text ?? ""), "清单含 kb/plm-module-map.md");
const slice1 = await plmReadReferenceTool.execute("t3", { path: "kb/plm-faq.md", limit: 500 });
check("③只读:分段读大文件", /共 \d+/.test(slice1.content?.[0]?.text ?? "") && /续读/.test(slice1.content?.[0]?.text ?? ""), "返回首段并给出续读偏移");

// ── ④ 需求填写族：只读命令真跑（不落库）───────────────────────────
const { runPlmCli } = await import(pathToFileURL(path.join(ROOT, "agents", AGENT_ID, "lib", "plm-cli.js")).href);
const whoRes = await runPlmCli("whoami", []);
const whoText = `${whoRes.stdout} ${whoRes.stderr}`;
check("④plm:whoami 可达（token 或明确报错）", whoRes.exitCode === 0 || /token|登录|expired|未配置/i.test(whoText),
  `exit=${whoRes.exitCode}｜${whoText.replace(/\s+/g, " ").slice(0, 120)}`);

const classesRes = await runPlmCli("classes", []);
check("④plm:classes 返回 9 个分类", classesRes.exitCode === 0 && /9/.test(classesRes.stdout), `exit=${classesRes.exitCode}｜${classesRes.stdout.replace(/\s+/g, " ").slice(0, 120)}`);

const rootRes = await runPlmCli("init", []);
check("④plm:未知/禁止子命令被本地拦下", rootRes.ok === false && /不允许的子命令/.test(rootRes.error ?? ""), rootRes.error ?? "");

// ── ⑤ 真实模型对话（本批验收核心）────────────────────────────────
if (SKIP_LLM) {
  console.log("⏭  ⑤模型对话 SKIPPED（--skipLlm）");
} else {
  const context = {
    channelId: "webchat", chatId: `webchat:probe.${Date.now()}`, messageId: "probe-1",
    senderId: "plm.probe", senderName: "探针", content: QUESTION, chatType: "direct", timestamp: Date.now(),
  };
  const t0 = Date.now();
  let text = "";
  let toolCalls = [];
  try {
    const stream = asm.runtime.chatStream(context, {});
    for await (const ev of stream) {
      if (ev?.type === "text_delta" && ev.delta) text += ev.delta;
      if (ev?.type === "tool_start") toolCalls.push(ev.name);
    }
  } catch (e) {
    console.log(`[probe] 模型对话异常 +${Date.now() - t0}ms：${e.message}`);
  }
  const ms = Date.now() - t0;
  console.log(`[probe] 模型对话 +${ms}ms｜工具调用=${toolCalls.join(",") || "无"}`);
  console.log(`[probe] 回答(${text.length} 字)：${text.slice(0, 300).replace(/\n/g, " ")}`);
  check("⑤模型:kimi-for-coding 有输出", text.trim().length > 0, text.trim().length > 0 ? `${text.length} 字 / ${ms}ms` : "零输出（模型或 key 有问题）");
}

console.log(`\nBATCH_XIAOTIAN_SMOKE PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);

