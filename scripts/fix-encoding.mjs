// scripts/fix-encoding.mjs — 修复被 PowerShell Add-Content 污染为 GBK 的尾行
// 症状：漂移测试用 Add-Content 追加中文注释到 UTF-8 源文件 → 非法 UTF-8
import fs from "node:fs";

const files = ["src/agents/runtime.ts", "dist/agents/runtime.js"];
let fixed = 0;
for (const rel of files) {
  const p = new URL(`../${rel}`, import.meta.url).pathname.replace(/^\//, "");
  if (!fs.existsSync(p)) {
    console.log(`跳过（不存在）: ${rel}`);
    continue;
  }
  let buf = fs.readFileSync(p);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    console.log(`✅ 已是合法 UTF-8: ${rel}`);
    continue;
  } catch {
    /* 需要修复 */
  }
  // 定位 GBK 编码的 "// 模拟 src 改动"
  const marker = Buffer.from([0x2f, 0x2f, 0x20, 0xc4, 0xa3, 0xc4, 0xe2, 0x20, 0x73, 0x72, 0x63, 0x20, 0xb8, 0xc4, 0xb6, 0xaf]);
  const idx = buf.lastIndexOf(marker);
  if (idx === -1) {
    console.error(`❌ ${rel}: 未找到污染标记，未改动`);
    continue;
  }
  buf = buf.subarray(0, idx);
  // 去掉尾部空白与孤立换行，保证以 "}\n" 结束
  let s = buf.toString("utf8").replace(/\s+$/, "");
  s += "\n";
  fs.writeFileSync(p, s, "utf8");
  new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(p));
  console.log(`🔧 已修复: ${rel}（截断 ${idx} 字节处）`);
  fixed++;
}
console.log(`\n修复文件数: ${fixed}`);
