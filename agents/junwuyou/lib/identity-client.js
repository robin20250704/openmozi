// junwuyou/lib/identity-client.js
// 客户身份汇聚的**运行时入口**（P0.6；契约 C-039/C-040/C-041/C-042）
//
// 为什么需要它：会话键过去是 `{channel}:{senderId}` —— 同一人在 QQ 与企业微信
// 就是两个会话、两个客户档案（实测 66 个客户里 60 个是 webchat 测试产物）。
// 身份汇聚的判定**不在这一层**：判定只写在 `junwuyou/server/identity/store.js`
// （唯一实现，V-014），本模块只负责"把入站消息的身份问一次、把结果放进请求上下文"。
//
// 兜底（V-016）：业务库不可达（超时/5xx）时**绝不**阻塞对话——回退旧键
// `{channel}:{senderId}`（本次不记忆，但绝不与他人串话），并打 warn 日志。
import { runWithRequestContext, getIdentity, getCustomerId } from "./request-context.js";
import { requireApiToken } from "./root-env.js";

const API = process.env.JUNWUYOU_API_URL || "http://127.0.0.1:53000";
const TIMEOUT_MS = Number(process.env.IDENTITY_TIMEOUT_MS || 3000);
const CACHE_TTL_MS = Number(process.env.IDENTITY_CACHE_TTL_MS || 30000);

/** channel:senderId -> { at, resolved } */
const cache = new Map();

/**
 * 业务库（Express）管理面凭据。
 *
 * ⚠️ 为什么**不能**只用 `process.env.JUNWUYOU_ADMIN_TOKEN`：
 * 那个键在 openmozi 的 `.env` 里**根本不存在**（只有仓库根 `.env` 的 `ADMIN_TOKEN`），
 * 而 Express 的 `adminAuth` 认的就是根 `.env` 的 `ADMIN_TOKEN`
 * —— 轮次 1 实测拿不到凭据 → 身份接口 401 → 静默回退旧会话键，
 * **整批身份汇聚在线上等于没生效，而所有内部断言都是绿的**（L-085 的变体：
 * "内部变体全绿 ≠ 部署态接线正确"）。
 *
 * 复用共享解析器（`root-env.js`，与 scheduler-client 同一实现，V-014）：
 * 键名解析顺序 = 进程环境变量 → 仓库根 .env。
 */
function adminToken() {
  try {
    return requireApiToken("ADMIN_TOKEN", ["JUNWUYOU_ADMIN_TOKEN"]).token || "";
  } catch (e) {
    console.warn(`[identity] 取管理面凭据失败（${e.message}）；身份解析将回退旧会话键`);
    return "";
  }
}

async function postJson(path, body, timeoutMs = TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = { "Content-Type": "application/json" };
    const token = adminToken();
    if (token) headers["X-Admin-Token"] = token;
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 401 要**显式指向凭据问题**：否则"身份不生效"会被当成业务库故障查半天
      const hint = res.status === 401
        ? "（凭据不匹配：核对仓库根 .env 的 ADMIN_TOKEN 与业务库 adminAuth 口径，见 identity-client.adminToken）"
        : "";
      throw new Error(`${path} ${res.status} ${text.slice(0, 200)}${hint}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 每个渠道身份只解析一次（短 TTL），避免每轮对话都打一次业务库 */
async function resolveCached(payload, key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.resolved;
  const resolved = await postJson("/api/identity/resolve", payload);
  cache.set(key, { at: Date.now(), resolved });
  return resolved;
}

/**
 * 解析入站消息的身份。
 * @param {object} p { channel, senderId, chatId, chatType?, senderName?, legacySessionKey? }
 * @returns {Promise<{ok:boolean, customerId:number|null, sessionKey:string, identity:string, fallback:boolean, error?:string, raw?:object}>}
 */
export async function resolveInboundIdentity(p) {
  const channel = String(p.channel || "").trim();
  const externalId = String(p.senderId ?? p.chatId ?? "").trim();
  const legacyKey = p.legacySessionKey || (externalId ? `${channel}:${externalId}` : null);

  // 群聊不进客户身份体系（D-22：本期只做客户 1:1 + 邮件）
  if (!channel || !externalId || p.chatType === "group") {
    return { ok: false, customerId: null, sessionKey: legacyKey, identity: legacyKey, fallback: true, error: "no-identity" };
  }

  const key = `${channel}:${externalId}`;
  try {
    const resolved = await resolveCached(
      {
        channel,
        external_id: externalId,
        evidence: {},
        sender_name: p.senderName || null,
        legacy_session_key: legacyKey,
      },
      key
    );
    if (!resolved || !resolved.customer_id) throw new Error("resolve 未返回 customer_id");
    return {
      ok: true,
      customerId: Number(resolved.customer_id),
      sessionKey: resolved.session_key || `customer:${resolved.customer_id}`,
      // 客户标识：**给模型看的是渠道身份，不是数字主键**（V-009：外键不得经模型流转）
      identity: key,
      fallback: false,
      raw: resolved,
    };
  } catch (e) {
    // 兜底：不阻塞对话（本次不记忆，但绝不与他人共用会话键 —— V-016/L-057）
    console.warn(`[identity] 身份解析失败（回退旧键 ${legacyKey}）：${e.message}`);
    return { ok: false, customerId: null, sessionKey: legacyKey, identity: legacyKey, fallback: true, error: e.message };
  }
}

/**
 * 在"请求上下文"中执行一轮对话。
 * @param {object} r 已解析结果（resolveInboundIdentity 的返回值）
 * @param {object} ctx { sessionKey }
 * @param {Function} fn
 */
export function runWithResolvedIdentity(r, fn) {
  return runWithRequestContext(
    {
      sessionKey: r.sessionKey,
      identity: r.identity,
      customerId: r.customerId,
      profileText: "",
    },
    fn
  );
}

/** 登记回投目标（C-042）：客户 × 渠道 → 最近一次会话的投递地址 */
export async function recordDestination(customerId, channel, externalId) {
  if (!customerId || !channel || !externalId) return false;
  try {
    await postJson("/api/identity/destination", {
      customer_id: customerId,
      channel,
      external_id: externalId,
    });
    return true;
  } catch (e) {
    console.warn(`[identity] 回投目标登记失败：${e.message}`);
    return false;
  }
}

export { getIdentity, getCustomerId };
