// debug-combined-gate.mjs — 关键实验：L4 cosine 单独 vs "L4粗筛+L5精判" 的相关性判别力对比
// 背景：cosine 阈值在"模型把查询扩展成关键词串"时重叠（相关最低 0.536 vs 库外最高 0.570），
// 需要用 reranker 分数作为最终判定。此脚本量化两者各自的分离区间。
import { config as loadDotenv } from "dotenv";
loadDotenv();
const { query } = await import("../agents/junwuyou/lib/pg-client.js");
const { getEmbedder, getReranker } = await import("../agents/junwuyou/lib/embedding.js");

const emb = await getEmbedder();
const rr = await getReranker();
const { rows: faqs } = await query(`SELECT id, question, answer FROM faq_items ORDER BY id`);
for (const f of faqs) f.vec = await emb.embed(f.question);
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// 覆盖：字面 / 改写 / 模型关键词扩展 / 库外自然句 / 库外关键词扩展
const cases = [
  { q: "消杀后多久能回家", exp: 2 },
  { q: "打完药要等多久才能进屋", exp: 2 },
  { q: "打完药 通风 多久 进屋 时间", exp: 2 },        // 模型实际扩展版（线上零召回）
  { q: "喷完药多久可以进去", exp: 2 },
  { q: "家里有宝宝能喷药吗", exp: 1 },
  { q: "家里有宝宝 孕妇 小孩 喷药 安全", exp: 1 },      // 模型扩展版
  { q: "灭了以后又出现虫子怎么办", exp: 15 },
  { q: "一张报销凭证", exp: 11 },
  { q: "你们支持比特币付款吗", exp: null },
  { q: "你们支持 比特币 付款 方式", exp: null },        // 库外关键词扩展 → cosine 0.570（高于相关最低）
  { q: "能不能帮忙修电脑", exp: null },
  { q: "帮我 修电脑 电脑维修", exp: null },
];

const rel = { cos: [], l5: [] };
const irr = { cos: [], l5: [] };

console.log("查询".padEnd(30), "| 类型 | L4top1    | L5分数(top1) | 期望条目L5分");
console.log("-".repeat(88));
for (const c of cases) {
  const qv = await emb.embed(c.q);
  const ranked = faqs.map((f) => ({ ...f, c: cos(qv, f.vec) })).sort((a, b) => b.c - a.c);
  const top = ranked[0];
  const l5Top = await rr.score(c.q, `${top.question} ${top.answer}`);
  const expScore = c.exp ? await rr.score(c.q, `${ranked.find((r) => r.id === c.exp).question} ${ranked.find((r) => r.id === c.exp).answer}`) : null;
  const kind = c.exp ? "相关" : "库外";
  (c.exp ? rel : irr).cos.push(top.c);
  (c.exp ? rel : irr).l5.push(l5Top);
  console.log(
    c.q.padEnd(28), "|", kind, "|", `#${String(top.id).padStart(2)} ${top.c.toFixed(3)}`, "|",
    l5Top.toFixed(3).padStart(11), "|", expScore === null ? "   -   " : expScore.toFixed(3)
  );
}

console.log("\n=== 分离度对比 ===");
const rng = (a) => `[${Math.min(...a).toFixed(3)}, ${Math.max(...a).toFixed(3)}]`;
console.log(`L4 cosine  相关 ${rng(rel.cos)}   库外 ${rng(irr.cos)}`);
console.log(`           相关最低 ${Math.min(...rel.cos).toFixed(3)} vs 库外最高 ${Math.max(...irr.cos).toFixed(3)} → ${
  Math.min(...rel.cos) > Math.max(...irr.cos) ? "✅ 可分" : "❌ 重叠"
}`);
console.log(`L5 rerank  相关 ${rng(rel.l5)}   库外 ${rng(irr.l5)}`);
console.log(`           相关最低 ${Math.min(...rel.l5).toFixed(3)} vs 库外最高 ${Math.max(...irr.l5).toFixed(3)} → ${
  Math.min(...rel.l5) > Math.max(...irr.l5) ? "✅ 可分" : "❌ 仍重叠"
}`);
process.exit(0);
