#!/usr/bin/env node
/**
 * agents/tiangong/business-server.mjs — 天工 PLM 客服的**知识库后端**（端口 53112）
 *
 * 归属说明（与 yuanyi/business-server.mjs 同族）：这是"知识和数据所在的那一层"，
 * **不是** agent 插件的一部分。插件（`agents/tiangong/tools/*`）只经 HTTP 调它，
 * 不直读数据文件——这样"访问入口唯一"（L-022），也让数据可被单独替换与体检。
 *
 * 契约：
 *   GET /health                  → { status, faqCount, sample_data, dataFile, schemaVersion }
 *   GET /api/faq/search?q=&limit= → { ok, q, hits[{id,title,category,answer,source,score,why}], confidence, top_score, note }
 *   GET /api/faq/categories      → { ok, total, categories:[{name,count}] }
 *   GET /api/faq/:id             → 单条详情（供"看原文"类问题）
 *
 * 检索口径（确定性、可断言，不靠"感觉像"）：
 *   100 标题完全匹配 ／ 90 标题包含 ／ 80 全部关键词词元命中
 *   60 单个关键词命中（取最高，按命中比例略降）／ 40 正文包含查询串 ／ 20 单字散命中
 *   命中为空**不加"兜底猜测"**：confidence=none 且 note 明说未收录——
 *   空集上的"看起来还行"是最坏的失败形态（宁可让模型说"没收录"）。
 *
 * 安全：只监听回环（C-045 家族口径）；接口只读、不含任何客户数据。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.TIANGONG_DATA_FILE || path.join(HERE, "data", "faq.json");
const PORT = Number(process.env.TIANGONG_PORT || 53112);
const HOST = process.env.TIANGONG_HOST || "127.0.0.1";

/** 数据只加载一次并缓存；`--watch` 不算需求，改完数据重启后端即可（部署脚本会重启） */
let DATA = null;
let DATA_MTIME = 0;

function loadData(force = false) {
  const st = fs.statSync(DATA_FILE);
  if (!force && DATA && st.mtimeMs === DATA_MTIME) return DATA;
  DATA = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  DATA_MTIME = st.mtimeMs;
  return DATA;
}

/** 归一化：去空白/标点、小写（中文保留）——"物料 库"与"物料库"要能互相命中 */
function norm(s) {
  return String(s ?? "").toLowerCase().replace(/[\s\-_.,，。/、?？!！:：;；"'（）()\[\]【】]/g, "");
}

/** 词元：按非字母数字汉字切分，取长度 ≥2 的片段（"怎么加 扩展属性" → 怎么加, 扩展属性） */
function tokens(s) {
  return String(s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function search(data, q, limit = 3) {
  const nq = norm(q);
  if (!nq) return { hits: [], confidence: "none", top_score: 0, note: "查询为空" };
  const qt = tokens(q);
  const scored = [];
  for (const f of data.faqs) {
    const nTitle = norm(f.title);
    const kw = (f.keywords ?? []).map(norm);
    const nBody = norm(f.answer);
    const nSrc = norm(f.source);
    const compact = norm([f.title, ...(f.keywords ?? []), f.answer, f.source, f.category].join(" "));
    let score = 0;
    let why = "";

    if (nTitle === nq) {
      score = 100;
      why = "标题完全匹配";
    } else if (nTitle.includes(nq)) {
      score = 90;
      why = "标题包含";
    } else if (qt.length >= 2 && qt.every((t) => compact.includes(norm(t)))) {
      score = 80;
      why = `${qt.length} 个词元全命中`;
    } else if (kw.some((k) => k === nq || k.includes(nq) || nq.includes(k))) {
      score = 60;
      why = "关键词命中";
    } else if (nBody.includes(nq) || nSrc.includes(nq)) {
      score = 40;
      why = "正文/出处包含";
    } else {
      const hitTokens = qt.filter((t) => compact.includes(norm(t)));
      if (hitTokens.length > 0) {
        score = 20;
        why = `${hitTokens.length}/${qt.length} 个词元命中`;
      }
    }
    if (score > 0) scored.push({ faq: f, score, why });
  }
  scored.sort((a, b) => b.score - a.score || a.faq.id.localeCompare(b.faq.id));
  const hits = scored.slice(0, Math.max(1, limit)).map((s) => ({
    id: s.faq.id,
    title: s.faq.title,
    category: s.faq.category,
    answer: s.faq.answer,
    source: s.faq.source,
    score: s.score,
    why: s.why,
  }));
  const top = scored[0]?.score ?? 0;
  const confidence = top >= 80 ? "high" : top >= 40 ? "medium" : top > 0 ? "low" : "none";
  return {
    hits,
    confidence,
    top_score: top,
    note:
      confidence === "none"
        ? "知识库未收录该问题——不得凭记忆编造，应如实说明并建议找对应模块负责人"
        : confidence === "low"
          ? "仅字面近似，可能不相关——涉及具体数值或承诺时不要据此断言"
          : "",
  };
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
  } catch {
    return sendJson(res, 400, { ok: false, error: "bad url" });
  }
  const p = url.pathname;

  try {
    if (p === "/health") {
      const data = loadData();
      return sendJson(res, 200, {
        status: "ok",
        faqCount: data.faqs.length,
        categories: new Set(data.faqs.map((f) => f.category)).size,
        schemaVersion: data.schema_version,
        sample_data: data.sample_data === true,
        dataFile: path.basename(DATA_FILE),
        timestamp: new Date().toISOString(),
      });
    }

    if (p === "/api/faq/search") {
      const data = loadData();
      const q = url.searchParams.get("q") ?? "";
      const limit = Number(url.searchParams.get("limit") || 3);
      const r = search(data, q, Number.isFinite(limit) ? limit : 3);
      return sendJson(res, 200, { ok: true, q, total: data.faqs.length, ...r });
    }

    if (p === "/api/faq/categories") {
      const data = loadData();
      const map = new Map();
      for (const f of data.faqs) map.set(f.category, (map.get(f.category) ?? 0) + 1);
      return sendJson(res, 200, {
        ok: true,
        total: data.faqs.length,
        categories: [...map.entries()].map(([name, count]) => ({ name, count })),
      });
    }

    const mDetail = p.match(/^\/api\/faq\/([^/]+)$/);
    if (mDetail) {
      const data = loadData();
      const id = decodeURIComponent(mDetail[1]);
      const f = data.faqs.find((x) => x.id === id);
      if (!f) return sendJson(res, 404, { ok: false, error: `未找到条目 ${id}` });
      return sendJson(res, 200, { ok: true, faq: f });
    }

    return sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
  }
});

server.listen(PORT, HOST, () => {
  const data = loadData();
  console.log(
    `[tiangong-business] 已就绪 http://${HOST}:${PORT} ｜ 知识库 ${data.faqs.length} 条` +
    `${data.sample_data ? "（示例数据，替换 data/faq.json 后重启即可）" : ""} ｜ 文件 ${path.basename(DATA_FILE)}`
  );
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[tiangong-business] 收到 ${sig}，关闭中`);
    server.close(() => process.exit(0));
  });
}
