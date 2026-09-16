// agents/yuanyi/lib/business-client.js
//
// 元一电子业务后端的 HTTP 客户端（三层归属 ② → ③）。
//
// 设计要点（与 junwuyou 的 scheduler-client/identity-client 同风格）：
//  1. **一切业务数据经 HTTP 取**，插件不直读业务库文件（L-022：访问入口唯一）；
//  2. 发请求前过 `enforceDataOrigin`（P4 契约 C-P4-5）——本 agent 的域是元一后端，
//     打君无忧的 53000/35801 会被拒（E_DATA_DOMAIN_VIOLATION），这是数据隔离的执行点；
//  3. 不缓存模块级 URL：env 由 launcher 注入，动态 import 时读取（L-042）。

import { enforceDataOrigin } from "./data-domain.js";

const BASE = process.env.YUANYI_API_URL || "http://127.0.0.1:53100";
const TIMEOUT_MS = Number(process.env.YUANYI_TIMEOUT_MS || 5000);

console.log(`[yuanyi-client] BASE=${BASE}（跨域将被数据域边界拒绝）`);

/** 允许模型/工具层传入的最大等待时间（错误必须显式回给模型，不静默超时） */
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
    if (!res.ok) throw new Error(`元一业务后端 ${method} ${pathname} ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  } catch (e) {
    // 数据域越权要**原样抛**（安全事件，不能被包装成"网络错误"而失去可判定性）
    if (String(e?.message ?? "").includes("E_DATA_DOMAIN_VIOLATION")) throw e;
    throw new Error(`元一业务后端 ${method} ${pathname} 调用失败：${e.message}（BASE=${BASE}）`);
  } finally {
    clearTimeout(timer);
  }
}

/** 型号/关键词模糊检索（P4 最小形态：确定性打分；P5 换向量/参数化索引） */
export async function searchSku(query, limit = 5) {
  return request("GET", "/api/sku/search", { query: { q: query, limit } });
}

/** 型号详情（含阶梯价/替代料/交期/包装倍数） */
export async function getSku(partNo) {
  return request("GET", `/api/sku/${encodeURIComponent(partNo)}`);
}

/** 报价（**服务端算价**，模型只复述 —— V-010） */
export async function quotePrice({ partNo, query, qty, customerLevel }) {
  const payload = {
    part_no: partNo,
    q: query,
    qty,
    customer_level: customerLevel,
  };
  return request("POST", "/api/quote", { body: payload });
}

/** 常见问题（P4：简单命中；P5 接语义检索） */
export async function searchFaq(query) {
  return request("GET", "/api/faq", { query: { q: query } });
}

export async function healthCheck() {
  try {
    const res = await request("GET", "/health", { timeoutMs: 3000 });
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
