#!/usr/bin/env node
/**
 * agents/tiangong/business-server.mjs — 天工 PLM 客服的**知识库后端**（端口 53112）
 *
 * 归属说明（与 yuanyi/business-server.mjs 同族）：这是"知识和数据所在的那一层"，
 * **不是** agent 插件的一部分。插件（`agents/tiangong/tools/*`）只经 HTTP 调它，
 * 不直读数据文件——这样"访问入口唯一"（L-022），也让数据可被单独替换与体检。
 *
 * 契约：
 *   GET  /health                          → { status, faqCount, categories, schemaVersion, sample_data, dataFile, candidateCount, faqThreshold }
 *   GET  /api/faq/search?q=&limit=        → { ok, q, hits[{id,title,category,answer,source,score,why}], confidence, top_score, note }
 *   GET  /api/faq/categories              → { ok, total, categories:[{name,count}] }
 *   GET  /api/faq/:id                     → 单条详情（供"看原文"类问题）
 *   POST /api/faq/candidates              → **追加一条** FAQ 候选（见下）
 *   GET  /api/faq/candidates?limit=       → 最近若干条候选
 *   GET  /api/faq/candidates/digest?threshold= → 归类计数 + 达阈值的 FAQ 草稿
 *
 * FAQ 候选闭环（2026-09-28 新增，用户要求"skill 增加自己归类总结客户常见、类似问题形成 FAQ 清单的循环"）：
 *   数据流是 **单向、只追加、事件在先**：
 *     小天答完一轮 → POST 一条候选（问法原文 + 归类 + 答案要点）→ 追加进 `faq-candidates.jsonl`
 *     → digest 按 `category` 聚类，某个归类攒够 ≥ 阈值（默认 3）**不同问法**才产出 FAQ 草稿 → **人工**并入 faq.json
 *   为什么阈值按"不同问法"而不是"提问次数"：
 *     同一问法重复 3 次可能是客户重问、验收脚本回归或机器人重连，不构成"客户共性问题"；
 *     要整理的是问法本身，所以 distinct 过闸，events 只作展示。
 *   为什么"只记候选、不自动改知识库"：
 *     自动改知识库 = 让被考核者给自己判卷（L-133 家族）。小天记的是**发生过什么**（事件），
 *     "这条算不算 FAQ、答案怎么写"是编辑决定，必须由人做。阈值本身就是那道闸门。
 *   为什么 ledger 是事件而不是"每个问题一行 + 计数"：
 *     计数是派生事实（可以被重算），事件是事实本身。重复问法天然落成多行，计数由 digest 算。
 *     ——单点事实源（V-014）：台账只存事件，计数/草稿一律现算。
 *
 * 隐私口径：**候选台账不记提问人身份**（不问 user、不存 userId），与本后端原有的
 *   "不含任何客户数据"契约保持一致。归类靠问题本身的 category 字段，不需要知道谁问的。
 *
 * 检索口径（确定性、可断言，不靠"感觉像"）：
 *   100 标题完全匹配 ／ 90 标题包含 ／ 80 全部关键词词元命中
 *   60 单个关键词命中（取最高，按命中比例略降）／ 40 正文包含查询串 ／ 20 单字散命中
 *   命中为空**不加"兜底猜测"**：confidence=none 且 note 明说未收录——
 *   空集上的"看起来还行"是最坏的失败形态（宁可让模型说"没收录"）。
 *
 * 安全：只监听回环（C-045 家族口径）；检索接口只读、不含任何客户数据；
 *   唯一可写的 POST 只往本进程自己的候选台账追加一行，不触碰 faq.json。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.TIANGONG_DATA_FILE || path.join(HERE, "data", "faq.json");
const CANDIDATE_FILE = process.env.TIANGONG_CANDIDATE_FILE || path.join(HERE, "data", "faq-candidates.jsonl");
const FAQ_THRESHOLD = Math.max(1, Number(process.env.TIANGONG_FAQ_THRESHOLD || 3) || 3);
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

// ───────────────── FAQ 候选台账（只追加）─────────────────
const MAX_Q = 200, MAX_CATEGORY = 40, MAX_POINT = 200, MAX_POINTS = 6, MAX_BODY = 64 * 1024;

/** 读事件台账。坏行**不静默跳过**：计入 malformed 并在响应里报出来（静默丢数据 = 台账会说谎）。 */
function readCandidates() {
  if (!fs.existsSync(CANDIDATE_FILE)) return { rows: [], malformed: 0 };
  const rows = [];
  let malformed = 0;
  for (const line of fs.readFileSync(CANDIDATE_FILE, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o.question === "string" && typeof o.category === "string") rows.push(o);
      else malformed++;
    } catch { malformed++; }
  }
  return { rows, malformed };
}

/** 指纹 = 归一化后的「归类|问法」；用来算"同一问法被问了几次"（去空格/标点/大小写） */
function fingerprint(category, question) {
  return crypto.createHash("sha1").update(`${norm(category)}|${norm(question)}`).digest("hex").slice(0, 12);
}

/**
 * 聚类摘要：按 category 归组，计数、算不同问法数，达阈值（默认 3）的归类产出 FAQ 草稿。
 * 草稿是**给人看的建议**，不是知识库内容：这里的答案=历次答案要点的合并去重，
 * 由人核对后写进 faq.json —— 后端不替人做判断，所以它只做可判定的计数与合并。
 */
function digestCandidates(rows, threshold) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.category;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const [category, items] of groups) {
    const fps = new Set(items.map((i) => i.fingerprint || fingerprint(i.category, i.question)));
    const questions = [...new Set(items.map((i) => String(i.question).trim()))];
    const points = [];
    for (const it of items) {
      for (const p of it.answerPoints ?? []) {
        const t = String(p).trim();
        if (t && !points.some((x) => norm(x) === norm(t))) points.push(t);
      }
    }
    // 阈值按**不同问法数**算，不按提问次数算：同一个问题被问 3 次（客户重问、
    // 验收脚本回归、机器人重连）不该算成"客户共性问题"。要整理的是**问法本身**，
    // 所以 distinct 是闸门的分母，events 只用于展示与排序的次级依据。
    const ready = fps.size >= threshold;
    out.push({
      category,
      events: items.length,
      distinct: fps.size,
      first_asked_at: items[0]?.ts ?? null,
      last_asked_at: items[items.length - 1]?.ts ?? null,
      ready,
      questions,
      draft: ready
        ? {
            title: questions[0],
            category,
            answer: points.map((p, i) => `${i + 1}. ${p}`).join("\n"),
            keywords: [...new Set(questions.flatMap((q) => tokens(q)))]
              .filter((t) => t.length <= 8)   // 中文整句会切成一个长词元，超过 8 字的是问句不是关键词
              .slice(0, 8),
            source: "候选台账聚合（待人工核对后并入 faq.json）",
            evidence: `${items.length} 次提问 / ${fps.size} 种问法`,
          }
        : null,
    });
  }
  out.sort((a, b) => b.distinct - a.distinct || b.events - a.events || a.category.localeCompare(b.category));
  return out;
}

/** 追加一条候选（校验 → 落一行 → 回摘要）。只有这一个写接口，且写不到 faq.json。 */
function appendCandidate(body) {
  const question = String(body?.question ?? "").trim();
  const category = String(body?.category ?? "").trim();
  const rawPoints = Array.isArray(body?.answerPoints) ? body.answerPoints : [];
  if (!question) return { code: 400, body: { ok: false, error: "question 不能为空（记原话，别自己改写）" } };
  if (question.length > MAX_Q) return { code: 400, body: { ok: false, error: `question 超长（${question.length} > ${MAX_Q}）` } };
  if (!category) return { code: 400, body: { ok: false, error: "category 不能为空（这是聚类的唯一依据）" } };
  if (category.length > MAX_CATEGORY) return { code: 400, body: { ok: false, error: `category 超长（${category.length} > ${MAX_CATEGORY}）` } };
  const answerPoints = rawPoints.map((p) => String(p).trim()).filter(Boolean);
  if (answerPoints.length === 0) return { code: 400, body: { ok: false, error: "answerPoints 至少 1 条：记下这轮你实际答了什么要点（没有就说明这轮不该记）" } };
  if (answerPoints.length > MAX_POINTS) return { code: 400, body: { ok: false, error: `answerPoints 最多 ${MAX_POINTS} 条` } };
  if (answerPoints.some((p) => p.length > MAX_POINT)) return { code: 400, body: { ok: false, error: `单条要点超长（上限 ${MAX_POINT} 字符）` } };

  const row = {
    ts: new Date().toISOString(),
    question,
    category,
    fingerprint: fingerprint(category, question),
    answerPoints,
  };
  fs.mkdirSync(path.dirname(CANDIDATE_FILE), { recursive: true });
  fs.appendFileSync(CANDIDATE_FILE, JSON.stringify(row) + "\n", "utf8");
  const { rows, malformed } = readCandidates();
  const group = digestCandidates(rows.filter((r) => r.category === category), FAQ_THRESHOLD)[0];
  return {
    code: 200,
    body: {
      ok: true,
      recorded: row,
      ledger: { total: rows.length, malformed, file: path.basename(CANDIDATE_FILE) },
      category_status: {
        category,
        events: group?.events ?? 1,
        distinct: group?.distinct ?? 1,
        threshold: FAQ_THRESHOLD,
        ready: !!group?.ready,
        draft: group?.draft ?? null,
      },
      next:
        (group?.ready ?? false)
          ? "该归类已达阈值，摘要里有 FAQ 草稿：请在回答里用一句话告诉客户『这类问题已被收录成 FAQ』，草稿由人工核对后并入知识库。"
          : `已记候选（该归类 ${group?.distinct ?? 1}/${FAQ_THRESHOLD} 种问法，共 ${group?.events ?? 1} 次提问）。不必向客户提及。`,
    },
  };
}

/** 读请求体（限长；超限即拒，不做流式大文件支持） */
function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); resolve({ error: `请求体超限（>${MAX_BODY} 字节）` }); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (size > MAX_BODY) return;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({ body: {} });
      try { resolve({ body: JSON.parse(text) }); }
      catch (e) { resolve({ error: `JSON 解析失败：${e.message}` }); }
    });
    req.on("error", () => resolve({ error: "请求体读取失败" }));
  });
}

const server = http.createServer(async (req, res) => {
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
      const { rows, malformed } = readCandidates();
      return sendJson(res, 200, {
        status: "ok",
        faqCount: data.faqs.length,
        categories: new Set(data.faqs.map((f) => f.category)).size,
        schemaVersion: data.schema_version,
        sample_data: data.sample_data === true,
        dataFile: path.basename(DATA_FILE),
        candidateCount: rows.length,
        candidateMalformed: malformed,
        faqThreshold: FAQ_THRESHOLD,
        timestamp: new Date().toISOString(),
      });
    }

    // 候选台账：先于 /api/faq/:id 判，否则 "candidates" 会被当成 id 吞掉
    if (p === "/api/faq/candidates" && req.method === "POST") {
      const r = await readBody(req);
      if (r.error) return sendJson(res, 400, { ok: false, error: r.error });
      const out = appendCandidate(r.body);
      return sendJson(res, out.code, out.body);
    }

    if (p === "/api/faq/candidates/digest") {
      const { rows, malformed } = readCandidates();
      const th = Number(url.searchParams.get("threshold") || FAQ_THRESHOLD);
      const threshold = Number.isFinite(th) && th > 0 ? Math.min(100, th) : FAQ_THRESHOLD;
      const groups = digestCandidates(rows, threshold);
      return sendJson(res, 200, {
        ok: true,
        threshold,
        total: rows.length,
        malformed,
        ready: groups.filter((g) => g.ready),
        pending: groups.filter((g) => !g.ready).map((g) => ({ category: g.category, events: g.events, distinct: g.distinct, need: threshold - g.distinct })),
        note: "阈值按**不同问法数**算（同问重复不占额度）；ready 里的草稿需人工核对后并入 data/faq.json；小天不自动改知识库。",
      });
    }

    if (p === "/api/faq/candidates") {
      const { rows, malformed } = readCandidates();
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 20) || 20));
      return sendJson(res, 200, { ok: true, total: rows.length, malformed, recent: rows.slice(-limit).reverse() });
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
  const { rows } = readCandidates();
  console.log(
    `[tiangong-business] 已就绪 http://${HOST}:${PORT} ｜ 知识库 ${data.faqs.length} 条` +
    `${data.sample_data ? "（示例数据，替换 data/faq.json 后重启即可）" : ""} ｜ 文件 ${path.basename(DATA_FILE)}` +
    ` ｜ 候选台账 ${rows.length} 条（阈值 ${FAQ_THRESHOLD}，达阈值只出草稿、不自动改库）`
  );
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[tiangong-business] 收到 ${sig}，关闭中`);
    server.close(() => process.exit(0));
  });
}
