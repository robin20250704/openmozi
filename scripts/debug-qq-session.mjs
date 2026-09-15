// debug-qq-session.mjs — 全量搜索会话记录里的 qq 会话（不只看头部）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = path.join(os.homedir(), ".mozi", "sessions");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));

let hits = [];
let scanned = 0;
for (const f of files) {
  const full = path.join(dir, f);
  let content;
  try {
    content = fs.readFileSync(full, "utf8");
  } catch {
    continue;
  }
  scanned++;
  if (content.includes('"sessionKey":"qq')) {
    const key = content.match(/"sessionKey":"(qq[^"]*)"/)?.[1];
    const lines = content.trim() ? content.trim().split("\n").length : 0;
    hits.push({ file: f, key, lines, size: content.length });
  }
}
console.log("扫描文件:", scanned, "| 含 qq sessionKey 的:", hits.length);
for (const h of hits) console.log(`  ${h.file} | key=${h.key} | 条目=${h.lines} | ${h.size}B`);

// 顺便：统计每个渠道真正落盘的会话数
const keys = new Map();
for (const f of files) {
  let head;
  try {
    const fd = fs.openSync(path.join(dir, f), "r");
    const b = Buffer.alloc(600);
    const n = fs.readSync(fd, b, 0, 600, 0);
    fs.closeSync(fd);
    head = b.toString("utf8", 0, n);
  } catch {
    continue;
  }
  const m = head.match(/"sessionKey":"([^"]+)"/);
  if (m) keys.set(m[1], (keys.get(m[1]) || 0) + 1);
}
const prefixes = {};
for (const k of keys.keys()) {
  const p = k.split(":")[0];
  prefixes[p] = (prefixes[p] || 0) + 1;
}
console.log("\n落盘会话按渠道:", JSON.stringify(prefixes));
process.exit(0);
