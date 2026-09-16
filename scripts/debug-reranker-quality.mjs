// debug-reranker-quality.mjs — 验证 bge-reranker-base 的判别力（明确相关 vs 明确不相关）
import { config as loadDotenv } from "dotenv";
loadDotenv();
const { getReranker } = await import("../agents/junwuyou/lib/embedding.js");

const rr = await getReranker();
if (!rr) { console.error("reranker 不可用"); process.exit(1); }

// 真实场景：用户问句 vs FAQ "question answer"
const tests = [
  { q: "打完药要等多久才能进屋", rel: "消杀后多久能回家 一般通风 2-4 小时即可，特殊情况技师会现场告知", irr: "怎么付款 目前支持定金预约上门，服务完成后付尾款" },
  { q: "家里有宝宝能喷药吗", rel: "药剂对小孩孕妇宠物安全吗 我们用的是生物配方药剂，安全无毒", irr: "服务范围覆盖哪些区域 目前覆盖深圳市" },
  { q: "能不能开张发票", rel: "能开发票吗 可以开具电子发票", irr: "你们公司在哪里 深圳" },
  { q: "怎么取消预约", rel: "怎么改期或取消 提前联系客服即可", irr: "一次服务要多久 1 小时" },
];

let correct = 0;
console.log("查询".padEnd(20), "| 相关分 | 不相关分 | 判别");
console.log("-".repeat(70));
for (const t of tests) {
  const sRel = await rr.score(t.q, t.rel);
  const sIrr = await rr.score(t.q, t.irr);
  const ok = sRel > sIrr;
  if (ok) correct++;
  console.log(t.q.padEnd(18), "|", sRel.toFixed(4).padStart(7), "|", sIrr.toFixed(4).padStart(8), "|", ok ? "✅" : "❌");
}

// 同一 FAQ，不同查询（检验单调性）
console.log("\n=== 同一相关文档对不同查询的分数 ===");
const doc = "消杀后多久能回家 一般通风 2-4 小时即可，特殊情况技师会现场告知";
for (const q of ["消杀后多久能回家", "打完药要等多久才能进屋", "喷完药多久可以进去", "怎么付款"]) {
  console.log(`  "${q}" → ${(await rr.score(q, doc)).toFixed(4)}`);
}

console.log(`\n判别正确率: ${correct}/${tests.length}`);
process.exit(correct === tests.length ? 0 : 1);
