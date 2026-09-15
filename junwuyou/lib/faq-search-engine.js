// faq-search-engine.js — 5 级混合检索管线（C-041 + L-026）
// L1 精确键  → L2 SimHash → L3 中文 Jaccard → L4 语义向量 → L5 CrossEncoder rerank
// 每层独立降级，向量层（embedding/rerank）加载失败不阻断
//
// 设计参考：
// - plm-app SearchService.java（4 级管线 + EmbeddingClient 降级）
// - jcode-embedding Embedder + CrossEncoder（rust crate，借设计不借代码）
// - L-025：跨语言只借设计不借代码；L-026：向量层强制降级

import { query } from "./pg-client.js";
import { getEmbedder, getReranker } from "./embedding.js";

// ============== 阈值（L-046，均可用 env 覆盖以便调优）==============
// 依据：scripts/debug-thresholds.mjs 的实测分离度（18 条 FAQ 库）
//   层       改写提问得分        库外提问得分        可分性
//   L2 dist  [6, 6, 4, 6, 6]   [6, 8, 4]          ❌ 完全重叠（SimHash 对短中文区分度不足）
//   L3 trgm  [0, 0, 0, .125, 0][.118, .071, 0]    ❌ 完全重叠
//   L4 cos   [.619,.588,.756,.625,.637] [.520,.521,.399]  ✅ 干净可分
// 结论：L2/L3 只作"字面近重复快速通道"，改写召回必须靠 L4；阈值按此设定。
const L2_MAX_DIST = Number(process.env.FAQ_L2_MAX_DIST || 2); // 只认近重复（字面问题实测 dist=0）
const L3_MIN_TRGM = Number(process.env.FAQ_L3_MIN_TRGM || 0.45); // 字面实测 1.0；改写/库外均 ≤0.13
// L4 定位为"粗筛召回闸门"（不是最终判定）：实测自然句相关 ≥0.588、库外 ≤0.521，
// 但模型会把查询扩展成关键词串（如"打完药 通风 多久 进屋 时间"→0.536，库外关键词串→0.570），
// 两者重叠 → 单一 cosine 阈值无法同时保证召回与精度。故取偏召回的 0.50，
// 由 confidence 信号 + agent 兜底行为（见 faqSearch 返回值与 system prompt）承担安全性。
const L4_MIN_COSINE = Number(process.env.FAQ_L4_MIN_COSINE || 0.50);
// 高置信阈值：cosine ≥ 0.60 视为明确的语义命中（实测清晰改写如"家里有宝宝能喷药吗"=0.619、
// "喷完药多久可以进去"=0.587、"打完药 通风 多久"=0.536）。
// **L-054：不再使用 cross-encoder reranker** —— 实测其排序收益 ≈ 0（L4 ANN top1 与
// rerank top1 在 10/11 例完全相同，唯一不同的一例还改坏了），却要 +1060MB 常驻内存。
// 改为把候选连同分数交给 LLM 自行判断（结果仅供 LLM 参考，不直接对客输出）。
const L4_CONF_HIGH = Number(process.env.FAQ_L4_CONF_HIGH || 0.60);
// 可选：FAQ_ENABLE_RERANK=true 时才加载 cross-encoder（默认关闭以省内存）
const ENABLE_RERANK = process.env.FAQ_ENABLE_RERANK === "true";

// ============== 文本归一化 ==============
function normalizeText(text) {
  if (!text) return "";
  return String(text)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[^\w\u4e00-\u9fa5]/g, "");
}

// ============== SimHash（64 bit）==============
// 简化版：词频 → 加权 hash → 位累加 → 符号位形成 64 bit
// 不追求完美的 SimHash 精度，plm-app 用的是 64bit 词频加权版；这里做工程近似
function tokenize(text) {
  const normalized = normalizeText(text);
  const tokens = new Set();
  // 1-gram + 2-gram (中文 bi-gram)
  for (let i = 0; i < normalized.length; i++) {
    tokens.add(normalized[i]);
    if (i + 1 < normalized.length) tokens.add(normalized.slice(i, i + 2));
  }
  return tokens;
}

function simhash(text) {
  const tokens = tokenize(text);
  const bits = new Array(64).fill(0);
  for (const tok of tokens) {
    let h = 5381;
    for (let i = 0; i < tok.length; i++) {
      h = ((h << 5) + h + tok.charCodeAt(i)) >>> 0;
    }
    for (let b = 0; b < 64; b++) {
      if ((h >> b) & 1) bits[b] += 1;
      else bits[b] -= 1;
    }
  }
  let result = 0n;
  for (let b = 0; b < 64; b++) {
    if (bits[b] > 0) result |= 1n << BigInt(b);
  }
  return result;
}

function popcountBigInt(a, b) {
  let x = a ^ b;
  let count = 0;
  while (x) {
    x &= x - 1n;
    count++;
  }
  return count;
}

// ============== L1 精确键 ==============
async function layer1ExactKey(query_text, topK) {
  const normalized = normalizeText(query_text);
  if (!normalized) return [];
  const res = await query(
    `SELECT id, category, question, answer, source, ai_should_handle, 1.0 AS score, 'L1' AS matched_layer
     FROM faq_items
     WHERE normalized_q = $1
     LIMIT $2`,
    [normalized, topK]
  );
  return res.rows;
}

// ============== L2 SimHash（近重复快速通道）==============
// L-046: 阈值由 8 收紧到 L2_MAX_DIST(2)。原 <=8 几乎对所有 FAQ 成立（实测改写与库外
// 问题的最小距离分布完全重叠），导致 L2 无差别命中并短路掉 L4 → 既召回错答案又阻止
// 向量层生效。收紧后仅命中真正近重复（字面变体），其余交给 L3/L4。
async function layer2SimHash(query_text, topK) {
  const sh = simhash(query_text);
  const res = await query(
    `SELECT id, category, question, answer, source, ai_should_handle,
            hamming_distance(simhash, $1) AS dist
     FROM faq_items
     WHERE simhash IS NOT NULL AND hamming_distance(simhash, $1) <= $3
     ORDER BY dist ASC
     LIMIT $2`,
    [sh.toString(), topK, L2_MAX_DIST]
  );
  return res.rows.map((r) => ({ ...r, score: 1 - r.dist / 64, matched_layer: "L2" }));
}

// ============== L3 中文 Jaccard（pg_trgm）==============
// L-046: 阈值 0.2 → L3_MIN_TRGM(0.45)。实测改写提问最高仅 0.125、库外最高 0.118，
// 0.2 会把二者一并放进"命中"并短路掉 L4；0.45 只放行真正的字面近似（实测 1.0）。
async function layer3Jaccard(query_text, topK) {
  const res = await query(
    `SELECT id, category, question, answer, source, ai_should_handle,
            similarity(question, $1) AS jscore
     FROM faq_items
     WHERE question % $1
     ORDER BY jscore DESC
     LIMIT $2`,
    [query_text, topK]
  );
  return res.rows
    .filter((r) => r.jscore >= L3_MIN_TRGM)
    .map((r) => ({ ...r, score: r.jscore, matched_layer: "L3" }));
}

// ============== L4 语义向量（pgvector HNSW，降级点）==============
// L-046: 加相关性阈值 L4_MIN_COSINE(0.55)。实测改写提问 cosine ≥0.588、库外提问 ≤0.521，
// 0.55 可干净分离；无阈值时库外问题也会召回（agent 会据此编造答案）。
// 无命中即返回空 → 上层返回空结果 → agent 转人工，而不是靠低质召回硬答。
async function layer4Vector(query_text, topK, annFetch = topK * 4) {
  const embedder = await getEmbedder();
  if (!embedder) return { hits: [], available: false };
  const queryVec = await embedder.embed(query_text);
  const vecLit = "[" + queryVec.join(",") + "]";
  const res = await query(
    `SELECT id, category, question, answer, source, ai_should_handle,
            1 - (embedding <=> $1::vector) AS cosine
     FROM faq_items
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [vecLit, annFetch]
  );
  const hits = res.rows
    .map((r) => ({ ...r, score: parseFloat(r.cosine), matched_layer: "L4" }))
    .filter((r) => r.score >= L4_MIN_COSINE);
  return { hits, available: true };
}

// ============== L5 CrossEncoder rerank（降级点）==============
async function layer5Rerank(query_text, candidates, topK) {
  if (candidates.length === 0) return candidates;
  const reranker = await getReranker();
  // 降级：reranker 不可用时按 L4 cosine 顺序取 topK（候选已被 L4_MIN_COSINE 过滤过）
  if (!reranker) return candidates.slice(0, topK);
  const scored = [];
  for (const c of candidates) {
    const passage = `${c.question} ${c.answer}`;
    const s = await reranker.score(query_text, passage);
    scored.push({ ...c, score: s, matched_layer: "L5" });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ============== 结果封装（含置信度与给 agent 的兜底指令）==============
// L-049: 实测证明 cosine 与 rerank 分数都无法用单一阈值干净分离"相关/库外"
// （模型把查询扩展成关键词串后：相关最低 cosine 0.510 / rerank -2.60，
//  库外最高 cosine 0.570 / rerank +1.21 —— 两者重叠）。
// 因此不追求"检索层绝对判定对错"，改为：粗筛召回 + 显式置信度 + agent 兜底禁令。
const HINT_NO_HIT =
  "知识库无匹配条目。禁止凭记忆回答具体事实（时长/次数/价格/剂量/承诺）；请转人工或请用户补充信息。";
const HINT_LOW_CONF =
  "召回置信度低：返回条目可能只是话题相近而非真命中。请自行判断是否真的回答了用户问题——不是就直接转人工，不要硬套或用它编造具体数值。";

function buildResult(hits, matched_layer, degraded, topScore, confHigh) {
  const confidence =
    hits.length === 0 ? "none" : matched_layer === "L1" || matched_layer === "L2" || matched_layer === "L3"
      ? "high" // 字面/近重复层已按阈值过滤，可信
      : confHigh
        ? "high"
        : "low";
  const out = { hits, matched_layer, confidence, degraded };
  if (confidence === "none") out.hint = HINT_NO_HIT;
  else if (confidence === "low") out.hint = HINT_LOW_CONF;
  // 提示 LLM：这是候选列表，需自行判断相关性（L-054：不用 reranker，判定权交给 LLM）
  out.note =
    "以上为候选条目（按语义相似度排序），**不保证相关**。请自行判断哪条真正回答了用户问题；若都不相关请转人工。";
  if (topScore !== undefined) out.top_score = Number(topScore.toFixed?.(4) ?? topScore);
  return out;
}

// ============== 主入口 ==============
export async function faqSearch(query_text, topK = 3) {
  if (!query_text || !query_text.trim()) {
    return { hits: [], matched_layer: null, confidence: "none", degraded: [], hint: HINT_NO_HIT };
  }

  const degraded = [];

  // L1
  try {
    const hits = await layer1ExactKey(query_text, topK);
    if (hits.length >= topK) return buildResult(hits.slice(0, topK), "L1", degraded, hits[0].score, true);
    if (hits.length > 0) return buildResult(hits, "L1", degraded, hits[0].score, true); // 不足也接受
  } catch (e) {
    console.error("[faq] L1 error:", e.message);
    degraded.push({ layer: "L1", error: e.message });
  }

  // L2
  try {
    const hits = await layer2SimHash(query_text, topK);
    if (hits.length > 0) return buildResult(hits, "L2", degraded, hits[0].score, true);
  } catch (e) {
    console.error("[faq] L2 error:", e.message);
    degraded.push({ layer: "L2", error: e.message });
  }

  // L3
  try {
    const hits = await layer3Jaccard(query_text, topK);
    if (hits.length > 0) return buildResult(hits, "L3", degraded, hits[0].score, true);
  } catch (e) {
    console.error("[faq] L3 error:", e.message);
    degraded.push({ layer: "L3", error: e.message });
  }

  // L4 语义向量
  let annHits = [];
  try {
    const { hits, available } = await layer4Vector(query_text, topK);
    if (!available) {
      degraded.push({ layer: "L4", error: "embedder_unavailable" });
    } else {
      annHits = hits;
    }
  } catch (e) {
    console.error("[faq] L4 error:", e.message);
    degraded.push({ layer: "L4", error: e.message });
  }

  if (annHits.length === 0) {
    return buildResult([], null, degraded, undefined, false);
  }

  // L5 rerank（默认关闭：L-054 实测排序收益≈0 却需 +1060MB 内存）
  const top = annHits[0];
  if (!ENABLE_RERANK) {
    const confHigh = top.score >= L4_CONF_HIGH;
    return buildResult(annHits.slice(0, topK), "L4", degraded, top.score, confHigh);
  }

  try {
    const reranked = await layer5Rerank(query_text, annHits, topK);
    if (reranked[0]?.matched_layer !== "L5") {
      // reranker 实际不可用 → 退回 L4 排序
      return buildResult(annHits.slice(0, topK), "L4", degraded, top.score, top.score >= L4_CONF_HIGH);
    }
    const rtop = reranked[0];
    // reranker 可用时以其分数判定置信度（实测高置信样本 ≥ -0.27 且多为正分）
    const L5_CONF_HIGH = Number(process.env.FAQ_L5_CONF_HIGH || 0.5);
    return buildResult(reranked.slice(0, topK), "L5", degraded, rtop.score, rtop.score >= L5_CONF_HIGH);
  } catch (e) {
    console.error("[faq] L5 error:", e.message);
    degraded.push({ layer: "L5", error: e.message });
    return buildResult(annHits.slice(0, topK), "L4", degraded, top.score, top.score >= L4_CONF_HIGH);
  }
}

// 健康检查（C-043）
export async function faqHealthCheck() {
  const layers = { l1: "ok", l2: "ok", l3: "ok", l4: "unavailable", l5: "unavailable" };
  let faq_total = 0;
  let faq_with_embedding = 0;

  try {
    const r1 = await query("SELECT COUNT(*)::int AS n FROM faq_items");
    faq_total = r1.rows[0].n;
    const r2 = await query("SELECT COUNT(*)::int AS n FROM faq_items WHERE embedding IS NOT NULL");
    faq_with_embedding = r2.rows[0].n;
  } catch (e) {
    return { ok: false, error: e.message };
  }

  try {
    const { getEmbedder } = await import("./embedding.js");
    const e = await getEmbedder();
    if (e) layers.l4 = "ok";
    const { getReranker } = await import("./embedding.js");
    const r = await getReranker();
    if (r) layers.l5 = "ok";
  } catch (e) {
    // ignore
  }

  return {
    ok: true,
    layers,
    faq_total,
    faq_with_embedding,
    last_checked_at: new Date().toISOString(),
  };
}
