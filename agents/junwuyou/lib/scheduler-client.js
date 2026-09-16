// scheduler-client.js — OpenMozi Plugin 调用 Rust scheduler 的 HTTP 客户端
// 契约：C-034
//
// scheduler 是 Rust 服务（src/scheduler/engine.rs），通过 /scheduler/* 暴露
// - query_pricing(area_sqm, pest_type) → { package_name, price, description }
// - propose_slots(preferred_date, community_name, ...) → [{ technician_id, ... }]
// - create_appointment(customer_id, technician_id, ...) → { appointment_id }
// - cancel_appointment(appointment_id, reason) → { ok }
// - query_customer_orders(customer_id) → [{ id, status, ... }]
//
// 鉴权：Bearer Token（仓库根 .env 的 SCHEDULER_API_TOKEN，见 spec-p0.md D-24）
// 超时：query/propose 5s；create/cancel 10s

import { requireApiToken } from "./root-env.js";
// P4 数据域边界（C-P4-5）：本进程属于哪个 agent 的数据域，由 AgentRuntime 在装配时写入；
// 这里只做"发请求前校验目标 origin"这一步。**无域时放行**（诊断脚本/harness/单测不设域）。
import { enforceDataOrigin } from "./data-domain.js";

// 默认值修正（P0）：原为 58081 —— 该端口从来没有服务（真实网关端口见根 config.toml
// [server] port = 35801）。默认值指向死端口＝"配置一丢就静默连错地方"（L-042/L-084 同族）。
const BASE = process.env.SCHEDULER_API_URL || "http://127.0.0.1:35801";
// 业务库（客户/订单）接口在君无忧 Express 上，不在调度器上。
// 2026-09-14 实测：调度器 35801 上 GET /api/orders 与 POST /schedule/cancel-appointment
// 都返回 404 —— 也就是 cancel_appointment 与 get_customer_appointments 两个工具一直是坏的。
// 契约是"君无忧 Node 是业务库唯一写者"，所以这两个调用必须走 53000。
const JUNWUYOU = process.env.JUNWUYOU_API_URL || "http://127.0.0.1:53000";
// token 延迟解析（**不缓存成模块级常量**）：launcher 用 config-adapter 注入 env 后才动态
// import 本模块（L-042），但诊断脚本/harness 直接运行时没有注入 —— 两种路径都要能取到。
console.log(`[scheduler-client] BASE=${BASE} business=${JUNWUYOU} auth=Bearer(<env|根 .env>)`);

/** 调业务库（君无忧 Express）：无需调度器鉴权头 */
async function businessCall(method, path, body, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // P4：数据域校验（越权即抛 E_DATA_DOMAIN_VIOLATION，fail-closed）
    const res = await fetch(`${enforceDataOrigin(JUNWUYOU)}${path}`, {
      method,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`junwuyou ${method} ${path} ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function call(method, path, body, timeoutMs = 5000) {
  const { token, source } = requireApiToken("SCHEDULER_API_TOKEN", ["SCHEDULER_API_KEY"]);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(`${enforceDataOrigin(BASE)}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const ms = Date.now() - start;
    if (!res.ok) {
      const text = await res.text();
      // 401 单独提示：这是"凭据不对/没配"，不是"调度器挂了"，两者排查方向不同
      if (res.status === 401) {
        throw new Error(
          `scheduler ${method} ${path} 401 unauthorized（凭据来源 ${source}）——` +
          `请核对仓库根 .env 的 SCHEDULER_API_TOKEN 与网关侧一致`,
        );
      }
      throw new Error(`scheduler ${method} ${path} ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.json();
  } catch (e) {
    // L-067: 记录 fetch 失败的具体原因（cause 里有 ECONNREFUSED/ECONNRESET 等）
    throw new Error(`scheduler ${method} ${path} failed: ${e.message} cause=${e.cause ? `${e.cause.code} ${e.cause.address}:${e.cause.port}` : "none"}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function queryPricing(area_sqm, pest_type = "蟑螂") {
  return call("POST", "/schedule/pricing", { area_sqm, pest_type }, 5000);
}

export async function proposeSlots(req) {
  return call("POST", "/schedule/propose", req, 5000);
}

export async function createAppointment(req) {
  return call("POST", "/schedule/appointments", req, 10000);
}

/** 取消预约 —— 走业务库（君无忧 Node 是唯一写者），调度器上没有该路由 */
export async function cancelAppointment(appointment_id, reason) {
  return businessCall("POST", `/api/orders/${encodeURIComponent(appointment_id)}/cancel`, { reason }, 10000);
}

/** 客户历史订单 —— 同样走业务库 */
export async function queryCustomerOrders(customer_id) {
  return businessCall("GET", `/api/orders?customer_id=${encodeURIComponent(customer_id)}`, null, 5000);
}

export async function healthCheck() {
  try {
    const res = await call("GET", "/health", null, 3000);
    return { ok: true, latency_ms: res.latency_ms ?? null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
