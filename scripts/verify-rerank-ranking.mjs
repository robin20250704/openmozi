// verify-rerank-ranking.mjs — 全量排序验证：每个查询对全部 18 条 FAQ 打分，看正确条目是否排第一
// 目的：① 验证 L4+L5 的端到端排序质量 ② 用实测分布定 L5 阈值（不拍脑袋）
import { config as loadDotenv } from "dotenv";
loadDotenv();
const { query } = await import("../junwuyou/lib/pg-client.js");
const { getEmbedder, getReranker } = await import("../junwuyou/lib/embedding.js");

const emb = await getEmbedder();
const rr = await getReranker();
if (!emb || !rr) { console.error("模型不可用"); process.exit(1); }

const { rows: faqs } = await query(`SELECT id, question, answer FROM faq_items ORDER BY id`);
for (const f of faqs) f.vec = await emb.embed(f.question);

const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// 查询集：字面 + 改写 + 库外
const cases = [
  { q: "消杀后多久能回家", exp: 2, kind: "字面" },
  { q: "打完药要等多久才能进屋", exp: 2, kind: "改写" },
  { q: "喷完药多久可以进去", exp: 2, kind: "改写" },
  { q: "家里有宝宝能喷药吗", exp: 1, kind: "改写" },
  { q: "药对孩子有影响吗", exp: 1, kind: "改写" },
  { q: "灭了以后又出现虫子怎么办", exp: 15, kind: "改写" },
  { q: "可以晚点再来吗时间能改吗", exp: 8, kind: "改写" },
  { q: "一张报销凭证", exp: 11, kind: "改写" },
  { q: "价钱怎么算的", exp: 9, kind: "改写" },
  { q: "我想退款怎么办", exp: 16, kind: "字面" },
  { q: "临时有事想取消这次上门", exp: 8, kind: "改写" },
  { q: "能不能帮忙修电脑", exp: null, kind: "库外" },
  { q: "你们支持比特币付款吗", exp: null, kind: "库外" },
];

let top1 = 0;
let top3 = 0;
let inScope = 0;
const relScores = [];
const irrScores = [];

console.log("查询".padEnd(22), "| 类型 | L4top1 | L5top1 | 正确? | L5最高分 | 正确条目分");
console.log("-".repeat(95));

for (const c of cases) {
  const qv = await emb.embed(c.q);
  const l4 = faqs.map((f) => ({ id: f.id, cos: cos(qv, f.vec) })).sort((a, b) => b.cos - a.cos);
  const l4Top1 = l4[0].id;

  // L5 对全部 18 条精排（比线上更严格：线上只 rerank L4 候选）
  const scored = [];
  for (const f of faqs) {
    const s = await rr.score(c.q, `${f.question} ${f.answer}`);
    scored.push({ id: f.id, s });
  }
  scored.sort((a, b) => b.s - a.s);
  const l5Top1 = scored[0].id;
  const expScore = c.exp === null ? null : scored.find((x) => x.id === c.exp)?.s;

  if (c.kind !== "库外") {
    inScope++;
    if (l5Top1 === c.exp) top1++;
    if (scored.slice(0, 3).some((x) => x.id === c.exp)) top3++;
    relScores.push(expScore);
  }
  // 库外：全部 18 条的最高分（越低越好）
  if (c.kind === "库外") irrScores.push(scored[0].s);

  const ok = c.exp === null ? (scored[0].s < 0 ? "✓(低分)" : "✗(高分误召)") : (l5Top1 === c.exp ? "✓" : `✗(期望${c.exp})`);
  console.log(
    c.q.padEnd(20), "|", c.kind, "|", String(l4Top1).padStart(6), "|", String(l5Top1).padStart(6), "|", ok.padEnd(14),
    "|", scored[0].s.toFixed(3).padStart(8), "|", expScore === null ? "  -  " : expScore.toFixed(3).padStart(8)
  );
}

console.log("\n=== 汇总 ===");
console.log(`范围内查询: L5 top1 正确 ${top1}/${inScope}，top3 覆盖 ${top3}/${inScope}`);
console.log(`范围内查询的正确条目分数: [${relScores.map((s) => s.toFixed(2)).join(", ")}]  最低=${Math.min(...relScores).toFixed(2)}`);
console.log(`库外查询的最高分:        [${irrScores.map((s) => s.toFixed(2)).join(", ")}]  最高=${Math.max(...irrScores).toFixed(2)}`);
console.log(`分离区间: 相关最低 ${Math.min(...relScores).toFixed(2)} vs 不相关最高 ${Math.max(...irrScores).toFixed(2)}`);
process.exit(0);
