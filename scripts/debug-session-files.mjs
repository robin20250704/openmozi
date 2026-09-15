// debug-session-files.mjs — 对比 runtime 命名文件 vs UUID 文件的大小分布，定位"谁在真正落盘"
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = path.join(os.homedir(), ".mozi", "sessions");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));

const buckets = { qq: [], webchatNamed: [], uuid: [], other: [] };
for (const f of files) {
  let size = 0;
  try {
    size = fs.statSync(path.join(dir, f)).size;
  } catch {
    continue;
  }
  if (f.startsWith("qq_")) buckets.qq.push({ f, size });
  else if (f.startsWith("webchat_")) buckets.webchatNamed.push({ f, size });
  else if (/^[0-9a-f-]{36}\.jsonl$/.test(f)) buckets.uuid.push({ f, size });
  else buckets.other.push({ f, size });
}

for (const [k, arr] of Object.entries(buckets)) {
  const nonEmpty = arr.filter((x) => x.size > 0);
  const total = arr.reduce((s, x) => s + x.size, 0);
  console.log(
    `${k}: ${arr.length} 个 | 非空 ${nonEmpty.length} 个 | 总字节 ${total}`
  );
  for (const x of arr.slice(0, 4)) console.log(`   ${x.f} — ${x.size}B`);
}
process.exit(0);
