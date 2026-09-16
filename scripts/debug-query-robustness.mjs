// debug-query-robustness.mjs — 阈值对不同问法（自然句 vs 模型扩展的关键词串）的稳健性
import { config as loadDotenv } from "dotenv";
loadDotenv();
const { query } = await import("../agents/junwuyou/lib/pg-client.js");
const { getEmbedder } = await import("../agents/junwuyou/lib/embedding.js");

const emb = await getEmbedder();
const { rows: faqs } = await query(`SELECT id, question FROM faq_items ORDER BY id`);
const vecs = {};
for (const f of faqs) vecs[f.id] = await emb.embed(f.question);
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

const groups = [
  {
    label: "P2 等多久进屋 (期望FAQ#2)",
    exp: 2,
    variants: [
      "打完药要等多久才能进屋",
      "打完药 通风 多久 进屋 时间",           // 模型实际扩展的版本（线上零召回）
      "消杀后多久能回家",
      "喷完药多久可以进去",
    ],
  },
  {
    label: "P1 宝宝安全 (期望FAQ#1)",
    exp: 1,
    variants: [
      "家里有宝宝能喷药吗",
      "家里有宝宝 孕妇 小孩 喷药 安全",       // 模型实际扩展的版本（线上命中 4.79）
      "药剂对小孩孕妇宠物安全吗",
    ],
  },
  {
    label: "库外（应低于阈值）",
    exp: null,
    variants: ["你们支持比特币付款吗", "能不能帮忙修电脑", "你们支持 比特币 付款 方式"],
  },
];

for (const g of groups) {
  console.log(`\n=== ${g.label} ===`);
  for (const v of g.variants) {
    const qv = await emb.embed(v);
    const ranked = Object.entries(vecs).map(([id, vec]) => ({ id: Number(id), c: cos(qv, vec) })).sort((a, b) => b.c - a.c);
    const top = ranked[0];
    const expC = g.exp ? ranked.find((r) => r.id === g.exp).c : null;
    console.log(
      `  "${v}"`.padEnd(46),
      `top1=#${String(top.id).padStart(2)} (${top.c.toFixed(3)})`,
      expC !== null ? `期望#${g.exp}=${expC.toFixed(3)} ${expC >= 0.55 ? "✅过阈" : "❌低于0.55"}` : ""
    );
  }
}
process.exit(0);
