// scripts/probe-minimax-cache.mjs — 探测 MiniMax M3 是否支持/回报 prompt caching
// 方法：同一段长前缀连发两次，看第二次的 usage 里有没有 cache_read_input_tokens
import { config as loadDotenv } from "dotenv";
loadDotenv();

const BASE = process.env.MINIMAX_ANTHROPIC_BASE_URL || "https://api.minimax.chat/anthropic/v1";
const KEY = process.env.MINIMAX_API_KEY;
const MODEL = process.env.MINIMAX_MODEL || "MiniMax-M3";

// 造一段足够长的稳定前缀（>1024 token，Anthropic 缓存的最小粒度）
const LONG = Array.from({ length: 120 }, (_, i) => `第${i + 1}条知识：君无忧提供消杀服务，覆盖蟑螂、老鼠、白蚁、蚊蝇、除甲醛，服务范围深圳市。`).join("\n");

async function call(label, extra) {
  const res = await fetch(`${BASE}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 64,
      system: [{ type: "text", text: `你是客服小君。\n${LONG}`, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: extra }],
    }),
  });
  const text = await res.text();
  const usageLine = text.split("\n").filter((l) => l.includes('"usage"'));
  console.log(`\n--- ${label} --- HTTP ${res.status}`);
  for (const l of usageLine) console.log("  " + l.trim().slice(0, 300));
  if (!usageLine.length) console.log("  (无 usage 行) 响应片段:", text.slice(0, 300));
  return text;
}

console.log(`BASE=${BASE}\nMODEL=${MODEL}\n系统提示长度=${LONG.length} 字符（约 ${Math.round(LONG.length / 4)} token）`);
await call("第 1 次（写入缓存）", "你好");
await new Promise((r) => setTimeout(r, 2000));
await call("第 2 次（应命中缓存）", "你好");
