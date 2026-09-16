#!/usr/bin/env node
/**
 * agents/yuanyi/business-server.mjs — 元一电子**业务应用**（三层归属 ③，端口 53100）
 *
 * 归属说明（设计文档 §5.3）：这是"人/系统用的业务后端"，**不是** agent 插件的一部分。
 * agent 插件（`agents/yuanyi/tools/*`）只通过 HTTP 调它，不直接读它的数据文件。
 *
 * P4 范围（spec-p4.md §十）：只提供最小接口，用于证明
 *   ① 第二个 agent 有**自己的数据源**（物理隔离，不共用 junwuyou 库）；
 *   ② `query_sku` 的**型号模糊检索**可用（上万 SKU 时这是第一瓶颈，D17 已确认规模）。
 * 报价策略引擎的**完整**实现（6 类策略 × 优先级 × 取整/币种/审批）属 **P5**：
 * 这里只落"够用且可断言"的一层（阶梯价 → 客户等级折扣 → 浮动价 → 固定价口径），
 * 并显式标注哪些是 P5 待补。
 *
 * 契约（C-P4 系列，与 junwuyou 业务库同风格：**业务库唯一写者**思路，本服务只读 SKU/FAQ）：
 *   GET  /health
 *   GET  /api/sku/search?q=&limit=     型号/关键词模糊检索（多字段命中打分排序）
 *   GET  /api/sku/:part_no             单型号详情（含阶梯价/替代料/交期）
 *   POST /api/quote  {part_no|q, qty, customer_level?}
 *                                      → 单价/总价/依据说明/MOQ 提示（服务端算，不让模型算，V-010）
 *   GET  /api/faq?q=                   常见问题
 *
 * 安全：只监听回环（与 C-045 监听面契约同口径）；无凭据接口只读、不含客户数据。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.YUANYI_DATA_FILE || path.join(HERE, "data", "skus.json");
const PORT = Number(process.env.YUANYI_PORT || 53100);
const HOST = process.env.YUANYI_HOST || "127.0.0.1";

function loadData() {
  const raw = fs.readFileSync(DATA_FILE, "utf8");
  return JSON.parse(raw);
}

/** 归一化检索词：去空格/连字符、转小写 —— 型号检索里 "1‑1734592‑2" 与 "1734592" 都要能命中 */
function norm(s) {
  return String(s ?? "").toLowerCase().replace(/[\s\-_.]/g, "");
}

/**
 * SKU 模糊检索（P4 最小形态）。
 *
 * 打分口径（可断言的确定性规则，不靠"感觉像"）：
 *   100 型号完全匹配 ／ 80 型号前缀匹配 ／ 60 型号包含
 *   55 "紧凑字段"包含（型号+关键词+描述压平后的包含判断——参数式提问如
 *      "2.54mm 双排 20pin" 归一后是 "2.54mm双排20pin"，直接包含在描述里）
 *   40 关键词命中 ／ 30 词元全命中（把查询拆词后逐个找料，全部找到才给分）
 *   20 描述命中 ／ 15 部分词元命中（容忍客户只记得一半参数）
 * 排序：分数降序 → 现货量降序（同分优先有货的）。
 *
 * **为什么要有"词元"这一档**：元器件客户的提问往往是**参数组合**（间距+排数+位数），
 * 而不是型号；只做整串包含会全 miss（实测 "2.54mm 双排 20pin" 命中 0）。
 * **P5 待补**：上万 SKU 时这里换成向量/参数化索引（BGE 嵌入 + 混合检索 + 置信度，
 * 复用君无忧已交付设施），并处理错别字与同义参数（mm/mil、公母/插针插孔）。
 */
function searchSkus(data, q, limit = 5) {
  const nq = norm(q);
  if (!nq) return [];
  // 词元：按非字母数字/汉字切分，取长度 ≥2 的片段（"2.54mm 双排 20pin" → 2.54mm, 双排, 20pin）
  const tokens = String(q).toLowerCase().split(/[^a-z0-9\u4e00-\u9fff.]+/).map((t) => t.replace(/\.$/, "")).filter((t) => t.length >= 2);
  const scored = [];
  for (const sku of data.skus) {
    const npn = norm(sku.part_no);
    // 紧凑字段：把型号/关键词/描述里所有非字母数字汉字去掉再拼接（mn 已是小写去分隔符的形态）
    const compact = norm([sku.part_no, ...(sku.keywords ?? []), sku.description].join(" "));
    let score = 0;
    let why = "";
    if (npn === nq) { score = 100; why = "型号完全匹配"; }
    else if (npn.startsWith(nq)) { score = 80; why = "型号前缀匹配"; }
    else if (npn.includes(nq)) { score = 60; why = "型号包含"; }
    else if (compact.includes(nq)) { score = 55; why = "参数/描述匹配"; }
    else if ((sku.keywords ?? []).some((k) => norm(k).includes(nq) || nq.includes(norm(k)))) { score = 40; why = "关键词命中"; }
    else {
      // 词元档：全部词元都能在本料上找到 → 30；只有一部分 → 15（按命中的比例给分，但低于全命中）
      const hits = tokens.filter((tk) => compact.includes(norm(tk)) || (sku.keywords ?? []).some((k) => norm(k).includes(norm(tk))));
      if (tokens.length >= 2 && hits.length === tokens.length) { score = 30; why = `${tokens.length} 个参数全命中`; }
      else if (hits.length > 0) { score = 15; why = `${hits.length}/${tokens.length} 个参数命中`; }
      else if (norm(sku.description).includes(nq)) { score = 20; why = "描述命中"; }
    }
    if (score > 0) scored.push({ sku, score, why });
  }
  scored.sort((a, b) => b.score - a.score || (b.sku.stock ?? 0) - (a.sku.stock ?? 0));
  return scored.slice(0, limit);
}

/** 阶梯价：按数量落在哪个区间（边界含左不含右；最高档 max_qty=null 表示无上限） */
function tierPrice(sku, qty) {
  const tiers = sku.tier_prices ?? [];
  for (const t of tiers) {
    const max = t.max_qty ?? Number.POSITIVE_INFINITY;
    if (qty >= t.min_qty && qty <= max) return { price: t.price, tier: t };
  }
  // 低于最小档：按最小档价 + 显式提示（不静默给基准价）
  const lowest = tiers[0];
  return lowest ? { price: lowest.price, tier: lowest, below_moq: true } : { price: sku.base_price, tier: null, below_moq: true };
}

/** 浮动价：按挂钩指数与系数给出可加动的区间（P4：用配置系数静态计算；P5 接真实指数） */
function floatAdjust(sku) {
  const f = sku.float_ref;
  if (!f) return { delta: 0, note: "无浮动条款" };
  const expired = f.valid_until ? new Date(f.valid_until) < new Date() : false;
  if (expired) return { delta: 0, note: `浮动基准已于 ${f.valid_until} 过期 → 按基准价报，需业务确认` };
  const delta = Number((sku.base_price * f.factor * 0.1).toFixed(4)); // 简化：仅演示口径（P5 接真实指数变动）
  return { delta, note: `挂钩 ${f.index}（系数 ${f.factor}，区间 ${f.min_delta}~${f.max_delta}，有效期至 ${f.valid_until}）` };
}

/**
 * 报价（服务端**唯一**算价实现，V-014；模型只复述，V-010）。
 *
 * 优先级（P4 已落部分 → P5 补全）：
 *   ① 项目/合同价（客户×SKU 协议价）…………… P5（需客户-价格协议表）
 *   ② 客户等级折扣 …………………………………… ✅ 本文件 customer_levels
 *   ③ 订货量阶梯价 …………………………………… ✅ 本文件 tier_prices
 *   ④ 浮动价（挂钩基准 + 上下限 + 有效期）…… ⚠️ 简化口径（P5 接真实指数）
 *   ⑤ 固定价（现货/特价/一口价）………………… P5（需 fixed_price 字段与优先级开关）
 *   ⑥ 兜底：基准价 …………………………………… ✅
 */
function quote(data, { part_no, q, qty, customer_level = "C" }) {
  let sku = null;
  if (part_no) {
    const nq = norm(part_no);
    sku = data.skus.find((s) => norm(s.part_no) === nq) ?? searchSkus(data, part_no, 1)[0]?.sku ?? null;
  } else if (q) {
    sku = searchSkus(data, q, 1)[0]?.sku ?? null;
  }
  if (!sku) {
    return { ok: false, error: "未找到匹配型号", hint: "请提供更完整的型号（如 1-1734592-2）或参数（如 2.54mm 双排 20pin）" };
  }
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: "数量不合法", hint: "请给出采购数量（正整数）", sku: sku.part_no, moq: sku.moq };
  }

  const level = data.customer_levels?.[customer_level] ?? data.customer_levels?.C;
  const { price: tierP, tier, below_moq } = tierPrice(sku, n);
  const afterLevel = Number((tierP * (level?.discount ?? 1)).toFixed(4));
  const float = floatAdjust(sku);
  const unit = Number(Math.max(0, afterLevel + float.delta).toFixed(2));
  const total = Number((unit * n).toFixed(2));

  const basis = [
    `阶梯价 ${tierP} 元（数量 ${n} 落在 [${tier?.min_qty}${tier?.max_qty ? `-${tier.max_qty}` : "+"}]）`,
    `客户等级 ${customer_level}（${level?.name ?? "未知"}）折扣 ${level?.discount ?? 1}`,
  ];
  if (float.delta) basis.push(`浮动调整 ${float.delta > 0 ? "+" : ""}${float.delta} 元（${float.note}）`);

  const warnings = [];
  if (below_moq) warnings.push(`数量 ${n} 低于最小档（${sku.tier_prices?.[0]?.min_qty}），已按最低档价计算`);
  if (sku.pack_multiple && n % sku.pack_multiple !== 0) {
    warnings.push(`数量 ${n} 不是包装倍数（${sku.pack_multiple}）的整数倍，实际成交需按 ${Math.ceil(n / sku.pack_multiple) * sku.pack_multiple} pcs 计价`);
  }
  if ((sku.stock ?? 0) < n) warnings.push(`现货 ${sku.stock} pcs 不足 ${n} pcs，超出部分需调货（交期约 ${sku.lead_time_days} 天）`);

  return {
    ok: true,
    part_no: sku.part_no,
    description: sku.description,
    brand: sku.brand,
    qty: n,
    customer_level,
    currency: sku.currency ?? data.meta?.currency ?? "CNY",
    unit_price: unit,
    total_price: total,
    base_price: sku.base_price,
    moq: sku.moq,
    pack_multiple: sku.pack_multiple,
    stock: sku.stock,
    lead_time_days: sku.lead_time_days,
    basis,
    warnings,
    alternatives: sku.alternatives ?? [],
    // 口径声明：让 agent 能如实告诉客户"这个价还有哪些条款没算"
    strategy_coverage: {
      tier_price: "已计入",
      customer_level: "已计入",
      float_price: float.delta ? "已计入（简化口径）" : "未适用",
      project_price: "P5 待接（无协议价表时一律按本口径报）",
      fixed_price: "P5 待接",
    },
    note: "以上为内部测算口径，未含运费/税费；正式报价由业务经理确认。",
  };
}

function searchFaq(data, q) {
  const nq = norm(q);
  if (!nq) return [];
  return (data.faq ?? [])
    .map((item) => {
      const nqq = norm(item.q);
      const score = nqq.includes(nq) || nq.includes(nqq) ? 2 : norm(item.a).includes(nq) ? 1 : 0;
      return { item, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
}

function send(res, code, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;
  let data;
  try {
    data = loadData(); // 每次读盘：改数据即时生效（P4 简单优先；P5 换缓存/SQLite）
  } catch (e) {
    return send(res, 500, { ok: false, error: `数据加载失败：${e.message}` });
  }

  if (p === "/health") {
    return send(res, 200, {
      status: "ok", merchant: data.meta?.merchant, merchant_id: data.meta?.merchant_id,
      skus: data.skus.length, sample_data: !!data.meta?.sample_data, timestamp: new Date().toISOString(),
    });
  }
  if (p === "/api/sku/search") {
    const q = url.searchParams.get("q") ?? "";
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 5) || 5, 20);
    const hits = searchSkus(data, q, limit).map((h) => ({
      part_no: h.sku.part_no, brand: h.sku.brand, description: h.sku.description,
      base_price: h.sku.base_price, currency: h.sku.currency, moq: h.sku.moq,
      pack_multiple: h.sku.pack_multiple, stock: h.sku.stock, lead_time_days: h.sku.lead_time_days,
      match: { score: h.score, why: h.why },
    }));
    return send(res, 200, { ok: true, query: q, count: hits.length, hits, note: hits.length ? undefined : "未命中：请让客户给更完整的型号或参数" });
  }
  if (p.startsWith("/api/sku/")) {
    const partNo = decodeURIComponent(p.slice("/api/sku/".length));
    const nq = norm(partNo);
    const sku = data.skus.find((s) => norm(s.part_no) === nq);
    return sku ? send(res, 200, { ok: true, sku }) : send(res, 404, { ok: false, error: `未找到型号 ${partNo}` });
  }
  if (p === "/api/quote" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on("end", () => {
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch { return send(res, 400, { ok: false, error: "请求体不是合法 JSON" }); }
      return send(res, 200, quote(data, payload));
    });
    return;
  }
  if (p === "/api/quote" && req.method === "GET") {
    return send(res, 200, quote(data, {
      part_no: url.searchParams.get("part_no") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      qty: url.searchParams.get("qty") ?? undefined,
      customer_level: url.searchParams.get("customer_level") ?? "C",
    }));
  }
  if (p === "/api/faq") {
    const q = url.searchParams.get("q") ?? "";
    const hits = searchFaq(data, q);
    return send(res, 200, { ok: true, query: q, count: hits.length, hits });
  }
  return send(res, 404, { ok: false, error: `未实现的路由 ${p}` });
});

server.listen(PORT, HOST, () => {
  const data = loadData();
  console.log(`[yuanyi-business] 元一电子业务后端 http://${HOST}:${PORT}｜SKU ${data.skus.length} 个｜样本数据=${!!data.meta?.sample_data}｜${DATA_FILE}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { server.close(() => process.exit(0)); });
}
