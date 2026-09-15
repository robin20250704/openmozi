// debug-sessions.mjs — 审计会话文件：按 channelKey 分类、找 QQ 会话、检查是否为空
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = path.join(os.homedir(), ".mozi", "sessions");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));

const byKey = new Map();
let empty = 0;
let unreadable = 0;

for (const f of files) {
  const full = path.join(dir, f);
  try {
    const st = fs.statSync(full);
    if (st.size === 0) {
      empty++;
      byKey.set(`(空文件) ${f}`, 0);
      continue;
    }
    const fd = fs.openSync(full, "r");
    const b = Buffer.alloc(500);
    const n = fs.readSync(fd, b, 0, 500, 0);
    fs.closeSync(fd);
    const head = b.toString("utf8", 0, n);
    const m = head.match(/"sessionKey":"([^"]+)"/);
    const key = m ? m[1] : "(无 sessionKey)";
    byKey.set(key, Math.round(st.size / 1024));
  } catch {
    unreadable++;
  }
}

const groups = {};
for (const k of byKey.keys()) {
  const prefix = k.startsWith("(空文件)") ? "空文件" : k.split(":")[0];
  groups[prefix] = (groups[prefix] || 0) + 1;
}

console.log("总 JSONL:", files.length, "| 空文件:", empty, "| 读不了:", unreadable);
console.log("按渠道分组:", JSON.stringify(groups));

const qq = [...byKey.entries()].filter(([k]) => k.startsWith("qq"));
console.log("\nQQ 相关会话:", qq.length);
for (const [k, kb] of qq) console.log(`  ${k} — ${kb} KB`);

// 空文件里 key 以 qq_ 开头的（文件名即 sanitized key）
const emptyQQ = files.filter((f) => f.startsWith("qq_"));
console.log("\n文件名为 qq_* 的文件:", emptyQQ.length);
for (const f of emptyQQ) {
  const st = fs.statSync(path.join(dir, f));
  console.log(`  ${f} — ${st.size} bytes — 修改于 ${st.mtime.toLocaleString("zh-CN")}`);
}
process.exit(0);
