// debug-thresholds.mjs — 数据驱动地看三层（L2 hamming / L3 trgm / L4 cosine）区分度
// 目的：确定"该问题与最相似 FAQ"的分数分布，据此定阈值（宁严勿漏）
import { config as loadDotenv } from "dotenv";
loadDotenv();
const { query } = await import("../junwuyou/lib/pg-client.js");
const { getEmbedder } = await import("../junwuyou/lib/embedding.js");

const emb = await getEmbedder();
if (!emb) { console.error("embedder 不可用"); process.exit(1); }

// 复用引擎的 simhash 实现（保持口径一致）
function normalizeText(t) {
  return String(t || "").toLowerCase().replace(/[\s\u3000]+/g, "").replace(/[^\w\u4e00-\u9fa5]/g, "");
}
function tokenize(text) {
  const n = normalizeText(text);
  const s = new Set();
  for (let i = 0; i < n.length; i++) { s.add(n[i]); if (i + 1 < n.length) s.add(n.slice(i, i + 2)); }
  return s;
}
function simhash(text) {
  const tokens = tokenize(text);
  const bits = new Array(64).fill(0);
  for (const tok of tokens) {
    let h = 5381;
    for (let i = 0; i < tok.length; i++) h = ((h << 5) + h + tok.charCodeAt(i)) >>> 0;
    for (let b = 0; b < 64; b++) (h >> b) & 1 ? bits[b]++ : bits[b]--;
  }
  let r = 0n;
  for (let b = 0; b < 64; b++) if (bits[b] > 0) r |= 1n << BigInt(b);
  return r;
}
function ham(a, b) { let x = a ^ b, c = 0; while (x) { x &= x - 1n; c++; } return c; }

const { rows: faqs } = await query(`SELECT id, question, answer, simhash FROM faq_items ORDER BY id`);
const faqVecs = [];
for (const f of faqs) faqVecs.push({ id: f.id, q: f.question, vec: await emb.embed(f.question) });

const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const trgm = async (q) => {
  const r = await query(`SELECT id, similarity(question, $1) AS s FROM faq_items ORDER BY s DESC LIMIT 3`, [q]);
  return r.rows;
};

const cases = [
  { q: "家里有宝宝能喷药吗", expect: 1, kind: "改写" },
  { q: "打完药要等多久才能进屋", expect: 2, kind: "改写" },
  { q: "杀了还会有虫是不是没效果", expect: 15, kind: "改写" },
  { q: "你们接不接抓黄鼠狼", expect: 13, kind: "改写" },
  { q: "可以开个报销用的单据吗", expect: 11, kind: "改写" },
  { q: "药剂对小孩孕妇宠物安全吗", expect: 1, kind: "字面" },
  { q: "怎么收费", expect: 9, kind: "字面" },
  // 库外（应无命中）
  { q: "你们支持比特币付款吗", expect: null, kind: "库外" },
  { q: "能不能帮忙修电脑", expect: null, kind: "库外" },
  { q: "今天天气怎么样", expect: null, kind: "库外" },
];

console.log("问题".padEnd(24), "| 类型 | 期望 | L2最小距离(命中?) | L3最高trgm | L4最高cosine(命中?)");
console.log("-".repeat(110));
for (const c of cases) {
  const qh = simhash(c.q);
  const dists = faqs.map((f) => ham(qh, BigInt(f.simhash))).sort((a, b) => a - b);
  const minDist = dists[0];
  const minId = faqs[dists.indexOf(minDist)]?.id;
  const t3 = await trgm(c.q);
  const qv = await emb.embed(c.q);
  const coss = faqVecs.map((f) => ({ id: f.id, s: cosine(qv, f.vec) })).sort((a, b) => b.s - a.s);
  const top = coss[0];
  const ok = c.expect === null ? "—" : (top.id === c.expect ? "✓" : "✗");
  console.log(
    c.q.padEnd(22),
    "|", c.kind, "|", String(c.expect ?? "-").padStart(2),
    "| dist=" + String(minDist).padStart(2) + "(id" + minId + ")",
    "| trgm=" + (t3[0]?.s ?? 0).toFixed(3),
    "| cos=" + top.s.toFixed(3) + "(id" + top.id + " " + ok + ")"
  );
}

// 汇总：改写 vs 库外 的分数分离度
console.log("\n=== 分离度汇总 ===");
const summarize = async (qs) => {
  const out = { l2min: [], l3max: [], l4max: [] };
  for (const q of qs) {
    const qh = simhash(q);
    out.l2min.push(Math.min(...faqs.map((f) => ham(qh, BigInt(f.simhash)))));
    const r = await query(`SELECT MAX(similarity(question, $1)) AS s FROM faq_items`, [q]);
    out.l3max.push(parseFloat(r.rows[0].s));
    const qv = await emb.embed(q);
    out.l4max.push(Math.max(...faqVecs.map((f) => cosine(qv, f.vec))));
  }
  return out;
};
const inScope = await summarize(cases.filter((c) => c.kind === "改写").map((c) => c.q));
const outScope = await summarize(cases.filter((c) => c.kind === "库外").map((c) => c.q));
const fmt = (a) => `[${a.map((x) => (typeof x === "number" ? x.toFixed(3) : x)).join(", ")}]`;
console.log("改写问题 L2最小距离:", fmt(inScope.l2min), " 库外问题:", fmt(outScope.l2min));
console.log("改写问题 L3最高trgm:", fmt(inScope.l3max), " 库外问题:", fmt(outScope.l3max));
console.log("改写问题 L4最高cosine:", fmt(inScope.l4max), " 库外问题:", fmt(outScope.l4max));
process.exit(0);
