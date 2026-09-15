// scripts/debug-restore.mjs — 查 phase1 会话的索引条目与 transcript 内容
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = path.join(os.homedir(), ".mozi", "sessions");
const key = fs.readFileSync(".reconnect-key", "utf8").trim();
console.log("查询 sessionKey:", key);

const idx = JSON.parse(fs.readFileSync(path.join(dir, "sessions.json"), "utf8"));
const entry = idx[key];
console.log("索引条目:", JSON.stringify(entry));

if (entry?.sessionId) {
  const tp = path.join(dir, `${entry.sessionId}.jsonl`);
  if (fs.existsSync(tp)) {
    const raw = fs.readFileSync(tp, "utf8");
    const lines = raw.trim().split("\n");
    console.log(`transcript 文件: ${tp}`);
    console.log(`大小 ${raw.length}B，${lines.length} 行`);
    for (const l of lines) {
      try {
        const o = JSON.parse(l);
        console.log(`  [${o.type || o.role}] ${String(o.content ?? "").slice(0, 60)}`);
      } catch {
        console.log("  (解析失败)");
      }
    }
  } else {
    console.log("❌ transcript 文件不存在:", tp);
  }
} else {
  console.log("❌ 索引里没有这个 sessionKey");
}
process.exit(0);
