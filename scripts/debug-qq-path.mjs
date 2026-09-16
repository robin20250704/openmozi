// debug-qq-path.mjs — 忠实复刻 launcher 装配，驱动 QQ 形状的 context 两轮
// 目的：确认 (1) QQ 会话是否落盘 (2) 第二轮是否带历史 (3) senderId 缺失是否串会话
import { config as loadDotenv } from "dotenv";
loadDotenv();
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const { loadAndApply } = await import("../config-adapter.mjs");
const { moziConfig } = loadAndApply();

// 关键：必须导入适配器模块，否则 anthropic-messages stream 未注册 → LLM 调用静默失败（回复为空）
await import("../pi-anthropic-patch.mjs");

const { createGateway } = await import("../dist/gateway/server.js");
const { createLogger, setLogger } = await import("../dist/utils/logger.js");
setLogger(createLogger({ level: "warn" }));

// —— 与 launcher 一致：注册 9 个 custom tools ——
const tools = await Promise.all([
  import("../agents/junwuyou/tools/faq-search.js"),
  import("../agents/junwuyou/tools/query-pricing.js"),
  import("../agents/junwuyou/tools/propose-slots.js"),
  import("../agents/junwuyou/tools/create-appointment.js"),
  import("../agents/junwuyou/tools/cancel-appointment.js"),
  import("../agents/junwuyou/tools/get-customer-appointments.js"),
  import("../agents/junwuyou/tools/query-customer-profile.js"),
  import("../agents/junwuyou/tools/update-collected-info.js"),
  import("../agents/junwuyou/tools/request-admin-approval.js"),
]);
const customTools = tools.map((m) => Object.values(m)[0]);

const OPENID = "QQTEST0000000000000000000000CCCC";
// 消息列表可用 QQ_TEST_TURNS 覆盖（JSON 数组），用于验证"同 openid 二次会话是否从 transcript 恢复历史"
const TURNS = process.env.QQ_TEST_TURNS
  ? JSON.parse(process.env.QQ_TEST_TURNS)
  : ["我在深圳南山科技园，家里80平米，有蟑螂", "灭蟑螂多少钱？"];
const ctx = (content) => ({
  channelId: "qq",
  chatId: `c2c:${OPENID}`,
  chatType: "direct",
  senderId: OPENID,
  senderName: "测试用户",
  content,
});

const gateway = await createGateway({
  ...moziConfig,
  customTools,
  // 用独立端口启动（避免与正在运行的 33000 冲突）；start() 才会完成模型/密钥等初始化
  server: { ...(moziConfig.server || {}), port: 33999 },
});
for (const t of customTools) gateway.agent.runtime.registerCustomTool(t);
const spPath = path.join(ROOT, ".pi", "SYSTEM.md");
if (fs.existsSync(spPath)) gateway.agent.runtime.config.systemPrompt = fs.readFileSync(spPath, "utf8");
await gateway.start();
console.log(`装配完成：customTools=${customTools.length}，systemPrompt=${gateway.agent.runtime.config.systemPrompt?.length ?? 0} chars，已 start()`);

const rt = gateway.agent.runtime;

for (const [i, msg] of TURNS.entries()) {
  console.log(`\n--- 轮次 ${i + 1}: ${msg} ---`);
  try {
    const r = await gateway.agent.processMessage(ctx(msg));
    console.log(`回复(${r.content.length}字):`, r.content.replace(/\n/g, " ").slice(0, 180));
  } catch (e) {
    console.log("❌ 抛错:", e.message);
  }
  console.log("会话信息:", JSON.stringify(rt.getSessionInfo(ctx(""))));
  // 诊断：agent 是否真的绑定了模型与工具
  const sess = await rt.getOrCreateSession(rt.getSessionKey(ctx("")));
  const st = sess.agent.state;
  console.log(
    `  [诊断] model=${st.model?.id ?? "❌未设置"} | provider=${st.model?.provider ?? "-"} | tools=${st.tools?.length ?? 0} | systemPrompt=${st.systemPrompt?.length ?? 0}chars`
  );
}

// —— senderId 缺失场景 ——
console.log("\n--- 边界：senderId 缺失 ---");
console.log("sessionKey =", JSON.stringify(rt.getSessionKey({ channelId: "qq", chatType: "direct", senderId: undefined, chatId: "c2c:unknown" })));
console.log("--- 内存中的会话 ---");
for (const [k] of rt.sessions ?? []) console.log("  ", k);

// —— 优雅关闭（触发落盘）——
await gateway.shutdown().catch(() => {});
console.log("\n已优雅关闭 gateway");
process.exit(0);
