// agents/tiangong/lib/business-client.js
//
// 天工 PLM 客服后端（知识库服务）的 HTTP 客户端（三层归属 ② → ③）。
//
// 设计要点（与 yuanyi/business-client.js 同风格，V-014）：
//  1. **一切业务数据经 HTTP 取**，插件不直读数据文件（L-022：访问入口唯一）；
//  2. 发请求前过 `enforceDataOrigin`（P4 契约 C-P4-5）——本 agent 的域只有 PLM 后端 53112，
//     打 53000/35801（君无忧）或 53100（元一）会被拒（E_DATA_DOMAIN_VIOLATION）；
//  3. 不缓存模块级 URL：env 由 launcher 注入，动态 import 时读取（L-042）。
import { enforceDataOrigin } from "./data-domain.js";

const BASE = process.env.TIANGONG_API_URL || "http://127.0.0.1:53112";
const TIMEOUT_MS = Number(process.env.TIANGONG_TIMEOUT_MS || 5000);

console.log(`[tiangong-client] BASE=${BASE}（跨域将被数据域边界拒绝）`);

async function request(method, pathname, { query, body, timeoutMs = TIMEOUT_MS } = {}) {
  const url = new URL(enforceDataOrigin(BASE) + pathname);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`天工知识库后端 ${method} ${pathname} ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  } catch (e) {
    // 数据域越权要**原样抛**（安全事件，不能被包装成"网络错误"而失去可判定性）
    if (String(e?.message ?? "").includes("E_DATA_DOMAIN_VIOLATION")) throw e;
    throw new Error(`天工知识库后端 ${method} ${pathname} 调用失败：${e.message}（BASE=${BASE}）`);
  } finally {
    clearTimeout(timer);
  }
}

/** 知识库检索（返回 hits/matched_layer/confidence/top_score；空集要显式告知，不静默编造） */
export async function searchFaq(query, limit = 3) {
  return request("GET", "/api/faq/search", { query: { q: query, limit } });
}

/** 列出知识库分类（供"你们能答什么"这类问题） */
export async function listCategories() {
  return request("GET", "/api/faq/categories");
}

/**
 * 追加一条 FAQ 候选（答客闭环的写入口）。
 *
 * 边界：这是本 agent **唯一**的写操作，且它只能往候选台账追加一行，
 * 碰不到 faq.json —— 知识库内容只能由人并入。让被考核者自己改考核题库，是这条约束的全部理由。
 * 不传提问人身份：台账不需要"谁问的"就能聚类，而存了就是多一份个人信息。
 */
export async function proposeFaqCandidate({ question, category, answerPoints }) {
  return request("POST", "/api/faq/candidates", { body: { question, category, answerPoints } });
}

/** FAQ 候选聚类摘要：达阈值的归类带 FAQ 草稿（草稿给人工核对，不自动入库） */
export async function faqCandidateDigest(threshold) {
  return request("GET", "/api/faq/candidates/digest", { query: { threshold } });
}

/** 最近若干条候选（自查"我刚才记进去没有"——L-133：写操作要能自证） */
export async function listFaqCandidates(limit = 20) {
  return request("GET", "/api/faq/candidates", { query: { limit } });
}

export async function healthCheck() {
  try {
    const res = await request("GET", "/health", { timeoutMs: 3000 });
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
