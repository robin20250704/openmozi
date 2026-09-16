// junwuyou/lib/customer-profile.js
// 客户档案（跨会话）读写 —— 需求 1/2 的数据层
//
// 为什么需要：原先 update_collected_info 以 **session_id** 为主键，新会话就丢光，
// 所以 agent 每次都得重新问地址。档案必须按**客户身份**存，才能"不反复要地址"。
// 后端能力（已存在，无需新建服务）：junwuyou Express 53000
//   GET  /api/customers/:wecom_user_id
//   POST /api/customers/upsert  { wecom_user_id, openid, name, phone, address, community_name, notes, tags }
import { getIdentity } from "./request-context.js";

const API = process.env.JUNWUYOU_API_URL || "http://127.0.0.1:53000";
const TTL_MS = Number(process.env.PROFILE_CACHE_TTL_MS || 15000);
const TIMEOUT_MS = Number(process.env.PROFILE_TIMEOUT_MS || 3000);

/** identity -> { at, profile } */
const cache = new Map();

async function fetchJson(path, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}${path}`, {
      ...init,
      signal: ctl.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 取客户档案（带 TTL 缓存；404 视为"暂无档案"） */
export async function getProfile(identity) {
  if (!identity) return null;
  const hit = cache.get(identity);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.profile;
  try {
    const data = await fetchJson(`/api/customers/${encodeURIComponent(identity)}`);
    const profile = data?.customer ?? null;
    cache.set(identity, { at: Date.now(), profile });
    return profile;
  } catch {
    // 后端不可用时不能阻塞对话：返回上一次的缓存（若有），否则 null
    if (hit) return hit.profile;
    return null;
  }
}

/** 从当前请求上下文取身份（工具层用，避免让模型猜 id） */
export function currentIdentity(fallback) {
  const id = getIdentity();
  return id || fallback || null;
}

/**
 * 取（必要时创建）当前身份对应的业务库客户 id。
 *
 * 为什么必须由后端解析：`customer_id` 是订单挂到哪个客户名下的外键。
 * 端到端走查实测（test-e2e-order-flow.mjs）发现：模型没有可靠途径得知这个数字，
 * 于是**猜了一个 1**，订单被挂到了另一个客户（verify:test1）名下 ——
 * 订单归属错误会让历史订单、售后、统计全部错位。
 * 这与"不要让模型猜身份"是同一类问题（update_collected_info 早已改为从上下文取身份），
 * 这里把 create_appointment 路径也补齐。
 */
export async function ensureCustomerId(identity) {
  if (!identity) throw new Error("ensureCustomerId 需要客户身份");
  const profile = await getProfile(identity);
  if (profile?.id) return profile.id;
  // 尚无档案：先建一条最小客户记录（前端下单/首次咨询都会产生主键）
  const data = await fetchJson(`/api/customers/upsert`, {
    method: "POST",
    body: JSON.stringify({ wecom_user_id: identity }),
  });
  cache.delete(identity);
  const id = data?.customer?.id ?? null;
  if (!id) throw new Error(`无法为身份 ${identity} 建立客户记录`);
  return id;
}

/**
 * 增量写入客户档案（只写有值的字段）
 * @returns {Promise<object|null>} 更新后的 customer
 */
export async function upsertProfile(identity, fields) {
  if (!identity) throw new Error("upsertProfile 需要客户身份");
  const clean = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && !v.trim()) continue;
    clean[k] = v;
  }
  if (Object.keys(clean).length === 0) return null;
  const data = await fetchJson(`/api/customers/upsert`, {
    method: "POST",
    body: JSON.stringify({ wecom_user_id: identity, ...clean }),
  });
  cache.delete(identity); // 立即失效，避免同轮读到旧值
  return data?.customer ?? null;
}

/** 客户历史订单（用于下单前确认与简化对话） */
export async function getRecentOrders(customerId, limit = 3) {
  if (!customerId) return [];
  try {
    const data = await fetchJson(`/api/orders?customer_id=${encodeURIComponent(customerId)}`);
    const orders = Array.isArray(data?.orders) ? data.orders : [];
    // 两个修正（实测发现）：
    //  ① 业务库按 scheduled_date **DESC** 返回，原实现 `slice(-limit)` 取到的是**最旧**的几条
    //     ——恰好把最新订单丢掉、留下最老的；
    //  ② 已取消订单（含诊断/测试数据）不该进客户上下文：会把"测试"这种占位地址
    //     当成客户的房产喂给模型，影响它向客户核对地址的准确性。
    return orders
      .filter((o) => o && o.status !== "cancelled")
      .sort((a, b) => String(b.scheduled_date || "").localeCompare(String(a.scheduled_date || "")))
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * 把档案渲染成给 LLM 看的紧凑文本（作为**请求级尾部后缀**注入，不落历史）。
 * 返回空串表示无档案 → 适配器不加后缀 → 前缀与前一轮完全一致（缓存友好）。
 */
export function renderProfileText(identity, profile, orders = []) {
  if (!identity || !profile) return "";
  const lines = [];
  const push = (label, val) => {
    if (val !== undefined && val !== null && String(val).trim()) lines.push(`- ${label}：${String(val).trim()}`);
  };
  push("姓名", profile.name);
  push("电话", profile.phone);
  push("地址", profile.address);
  push("小区", profile.community_name);
  push("偏好/备注", profile.notes);
  if (Array.isArray(profile.tags) && profile.tags.length) push("标签", profile.tags.join("、"));
  if (orders.length) {
    // 带上门址：客户档案里 address 可能为空（例如多套房产时无法确定"主地址"），
    // 而历史订单是地址的可靠来源。带上它，agent 才能"用历史地址向客户核对"，
    // 而不是因为 profile.address 为空就再问一遍地址。
    const brief = orders
      .map((o) =>
        [
          o.scheduled_date || "?",
          o.pest_type || "",
          o.area_sqm ? `${o.area_sqm}㎡` : "",
          o.community_name || o.address || "",
          o.status || "",
        ]
          .filter(Boolean)
          .join(" ")
          .trim()
      )
      .join("；");
    push("最近订单", brief);
  }
  if (lines.length === 0) return "";
  return [
    "【系统提供的已知客户档案】",
    `客户标识：${identity}`,
    ...lines,
    "使用规则：以上是本系统已记录的信息，可直接使用，不要再次询问客户这些内容；",
    "但涉及下单/预约时，必须先把将使用的信息复述给客户确认，客户确认后才能创建订单。",
  ].join("\n");
}

/** 组装"身份 → 档案文本"（runtime 每轮调用一次） */
export async function loadProfileText(identity) {
  if (!identity) return "";
  const profile = await getProfile(identity);

  // 进行中订单草稿：随每轮注入 → 会话压缩/网关重启都不会丢掉"正在谈的单"
  // （需求 5：压缩会不会让进行中的交易损失？只靠对话历史会，靠这里不会。）
  let activeText = "";
  try {
    const po = await import("./pending-orders.js");
    const { slotRangeLabel } = await import("./slot-time.js");
    activeText = po.renderActiveText(identity, slotRangeLabel);
  } catch {
    activeText = "";
  }

  if (!profile) return activeText;
  const orders = await getRecentOrders(profile.id);
  const base = renderProfileText(identity, profile, orders);
  return activeText ? `${base}\n\n${activeText}` : base;
}

export function invalidate(identity) {
  cache.delete(identity);
}
