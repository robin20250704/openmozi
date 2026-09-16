// verify-faq-search.mjs — FAQ 五级检索验收 harness
//
// 断言分三组：
//   A. 组件可用性（embedder/reranker 加载 + 健康检查）
//   B. 改写提问（L1~L3 会漏，必须靠 L4/L5 命中）—— 本次修复的核心价值
//   C. 字面提问（L1~L3 命中）—— 确认没引入回归
//
// 用法：node scripts/verify-faq-search.mjs

import { config as loadDotenv } from "dotenv";
loadDotenv();

const { faqSearch, faqHealthCheck } = await import("../agents/junwuyou/lib/faq-search-engine.js");
const { getEmbedder, getReranker } = await import("../agents/junwuyou/lib/embedding.js");

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
};

// ---------- A. 组件可用性 ----------
console.log("=== A. 组件可用性 ===");
const emb = await getEmbedder();
check("embedder 加载", !!emb, emb ? `dim=${emb.dim}` : "不可用（L4 将降级）");
const rr = await getReranker();
check("reranker 加载", !!rr, rr ? "ok" : "不可用（L5 退化为 ANN top-3）");

const health = await faqHealthCheck();
check("L4 层状态", health.layers?.l4 === "ok", `layers.l4=${health.layers?.l4}`);
check("L5 层状态", health.layers?.l5 === "ok", `layers.l5=${health.layers?.l5}`);
check("向量覆盖率", health.faq_with_embedding > 0 && health.faq_with_embedding === health.faq_total,
  `${health.faq_with_embedding}/${health.faq_total}`);

// ---------- B. 改写提问（需 L4/L5）----------
console.log("\n=== B. 改写提问（L1~L3 漏检，验证向量层真实生效）===");
const paraphraseCases = [
  { q: "家里有宝宝能喷药吗", expectId: 1, note: "FAQ1 药剂对小孩孕妇宠物安全吗" },
  { q: "打完药要等多久才能进屋", expectId: 2, note: "FAQ2 消杀后多久能回家" },
  { q: "打完药 通风 多久 进屋 时间", expectId: 2, note: "★模型实际的关键词扩展式查询（修复前零召回）" },
  { q: "杀了还会有虫是不是没效果", expectId: 15, note: "FAQ15 服务后还有虫子怎么办" },
  { q: "你们接不接抓黄鼠狼", expectId: 13, note: "FAQ13 黄鼠狼蛇蝙蝠这些能处理吗" },
  { q: "可以开个报销用的单据吗", expectId: 11, note: "FAQ11 能开发票吗" },
];
for (const c of paraphraseCases) {
  const r = await faqSearch(c.q, 3);
  const ids = r.hits.map((h) => h.id);
  const hit = ids.includes(c.expectId);
  const degraded = r.degraded?.length ? ` degraded=${JSON.stringify(r.degraded)}` : "";
  check(`"${c.q}" 命中 FAQ#${c.expectId}`, hit, `layer=${r.matched_layer} conf=${r.confidence} ids=[${ids}]${degraded}`);
}

// ---------- C. 字面提问（L1~L3）----------
console.log("\n=== C. 字面提问（回归检查）===");
const literalCases = [
  { q: "药剂对小孩孕妇宠物安全吗", expectId: 1 },
  { q: "消杀后多久能回家", expectId: 2 },
  { q: "怎么收费", expectId: 9 },
];
for (const c of literalCases) {
  const r = await faqSearch(c.q, 3);
  const ids = r.hits.map((h) => h.id);
  check(`"${c.q}" 命中 FAQ#${c.expectId}`, ids.includes(c.expectId), `layer=${r.matched_layer} conf=${r.confidence} ids=[${ids}]`);
}

// ---------- D. 库外问题（L-049 契约：不再要求零召回，而要求"低置信 + 兜底提示"）----------
// 实测证明检索层无法用单一阈值干净分离相关/库外（cosine 与 rerank 分布均重叠），
// 故契约改为：必须给出低置信信号，让 agent 转人工而非编造。
console.log("\n=== D. 知识库外的问题（契约：低置信 + 兜底提示，供 agent 转人工）===");
for (const q of ["你们支持比特币付款吗", "能不能帮忙修电脑", "今天天气怎么样"]) {
  const r = await faqSearch(q, 3);
  const ok = r.confidence === "low" || r.confidence === "none";
  check(`"${q}" 标记为低/无置信`, ok, `conf=${r.confidence} layer=${r.matched_layer} top=${r.top_score?.toFixed?.(3)} hint=${r.hint ? "有" : "无"}`);
  if (r.confidence !== "none") {
    check(`"${q}" 带兜底提示`, !!r.hint, r.hint ? r.hint.slice(0, 30) : "缺失");
  }
}

// ---------- E. 模型扩展式查询（真实失败场景回归）----------
console.log("\n=== E. 关键词扩展式查询（模型实际用法，修复前零召回导致编造）===");
const expanded = [
  { q: "打完药 通风 多久 进屋 时间", expectId: 2 },
  { q: "家里有宝宝 孕妇 小孩 喷药 安全", expectId: 1 },
];
for (const c of expanded) {
  const r = await faqSearch(c.q, 3);
  const ids = r.hits.map((h) => h.id);
  check(`"${c.q}" 命中 FAQ#${c.expectId}`, ids.includes(c.expectId), `layer=${r.matched_layer} conf=${r.confidence} ids=[${ids}]`);
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail > 0 ? 1 : 0);
