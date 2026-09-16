// junwuyou/lib/order-confirmation.js
// 下单前"理解是否正确"的确认闸门（需求 2）
//
// 为什么需要硬约束而不是只写提示词：档案复用带来的风险是**用错信息下单**
// （客户去年住 A 小区，今年搬到 B 小区，agent 直接用档案里的 A 下单）。
// 所以规则必须是可执行的：create_appointment 必须携带一个**专门确认步骤**签发的令牌。
//
// ── 2026-09-14 重构（QQ 真实事故驱动）─────────────────────────────
// 事故：客户已确认，下单却报「token 失效了」，客户被迫重听一遍确认。
// 原设计的脆弱点：令牌绑定**参数指纹**，要求模型在两次工具调用之间把 10 个字段
// 原样重抄。模型是在"自然语言→工具参数"之间转写，任何一处漂移都会指纹不匹配；
// 而实际最易漂移的 start_slot 之所以漂移，是因为**我们自己的工具描述写错了**
// （描述「0=10:00」，而 propose_slots 返回 18-20，真实语义 20=10:00）。
// 结论：指纹闸门要保留（它防的是"客户确认 A、系统下单 B"），但**不能要求模型重抄**。
// 改法：
//   1. confirm_order_details 把**完整参数快照存到服务端**（pending-orders.js），
//      下单只带 token，参数从快照取 → 结构上不可能漂移；
//   2. 模型若仍传了参数，与本快照逐字段比对，返回**字段级差异**（哪个字段、
//      确认时是什么、现在是什么），让模型能分辨"客户改主意"还是"自己抄错"；
//   3. 每一次闸门判定都打日志（[order-gate]）——原实现三处工具一行日志都没有，
//      导致这次事故**无法从证据定位**，只能靠推断。不可观测 = 不可诊断。
import { createHash } from "node:crypto";
import { slotRangeLabel, slotToTime } from "./slot-time.js";
import { saveDraft, getDraft } from "./pending-orders.js";

const TTL_MS = Number(process.env.ORDER_CONFIRM_TTL_MS || 10 * 60 * 1000); // 10 分钟
const REQUIRED = [
  "customer_id", "technician_id", "scheduled_date", "start_slot", "end_slot",
  "address", "community_name", "area_sqm", "pest_type", "price",
];

/** 令牌表：token -> { identity, fingerprint, params, at, summary, draftId } */
const tokens = new Map();

function log(event, data) {
  console.log(`[order-gate] ${event} ${JSON.stringify(data)}`);
}

function fingerprint(params) {
  const parts = REQUIRED.map((k) => `${k}=${params?.[k] ?? ""}`).join("|");
  return createHash("sha1").update(parts).digest("hex").slice(0, 16);
}

/** 草稿 id：同一份订单（身份+参数指纹）重复确认时复用同一草稿，不产生重复条目 */
function draftIdFor(identity, params) {
  return createHash("sha1").update(`${identity}|${fingerprint(params)}`).digest("hex").slice(0, 12);
}

/** 人类可读的确认摘要（agent 要把它复述给客户） */
export function summarizeOrder(params) {
  const s = Number(params.start_slot ?? 0);
  const e = Number(params.end_slot ?? s + 2);
  return [
    `日期：${params.scheduled_date || "（未定）"}（${params.scheduled_date_weekday || ""}）`.replace("（）", ""),
    `时段：${slotRangeLabel(s, e)}`,
    `地址：${params.community_name || ""} ${params.address || ""}`.trim(),
    `服务：${params.pest_type || "（未定）"} ${params.area_sqm ?? ""}㎡`,
    `价格：${params.price ?? "（未定）"} 元`,
  ].join("\n");
}

/**
 * 签发确认令牌（只有明确声明"客户已确认"才签发）
 * 参数快照与草稿一起落盘 → 下单不必重抄参数
 * @returns {{ok:boolean, token?:string, summary?:string, draft_id?:string, params?:object, reason?:string}}
 */
export function issueConfirmation(identity, params) {
  if (params?.customer_confirmed !== true) {
    log("issue.rejected", { identity, reason: "not_confirmed" });
    return {
      ok: false,
      reason:
        "尚未确认。请先把订单要点完整复述给客户（日期/时段/地址/服务/价格），客户明确表示同意后，" +
        "再以 customer_confirmed=true 调用本工具。",
    };
  }
  const missing = REQUIRED.filter((k) => params[k] === undefined || params[k] === null || params[k] === "");
  if (missing.length) {
    log("issue.rejected", { identity, reason: "missing_fields", missing });
    return { ok: false, reason: `以下字段缺失，无法确认：${missing.join(", ")}` };
  }

  // 快照只保留订单字段（丢掉 customer_confirmed 等控制位）
  const snapshot = {};
  for (const k of REQUIRED) snapshot[k] = params[k];

  const token = createHash("sha1")
    .update(`${identity}|${fingerprint(snapshot)}|${Date.now()}|${Math.random()}`)
    .digest("hex")
    .slice(0, 24);
  const draftId = draftIdFor(identity, snapshot);
  const summary = summarizeOrder(snapshot);
  tokens.set(token, { identity, fingerprint: fingerprint(snapshot), params: snapshot, at: Date.now(), summary, draftId });
  saveDraft(identity, draftId, snapshot, { status: "confirmed", summary });

  log("issue.ok", {
    identity,
    draft_id: draftId,
    token: token.slice(0, 8),
    date: snapshot.scheduled_date,
    slot: slotRangeLabel(snapshot.start_slot, snapshot.end_slot),
    pest: snapshot.pest_type,
    price: snapshot.price,
  });

  return { ok: true, token, summary, draft_id: draftId, params: snapshot };
}

/**
 * 校验令牌并解析出**真正用于下单的参数**。
 * - 只传 token（推荐）→ 直接用确认时的快照，无法漂移；
 * - 同时传了参数 → 逐字段比对，有差异即拒绝并返回 diff（不是一句含糊的"令牌失效"）。
 * @returns {{ok:boolean, reason?:string, summary?:string, params?:object, changed?:Array}}
 */
export function verifyConfirmation(identity, token, overrides) {
  if (!token) {
    log("verify.rejected", { identity, reason: "no_token" });
    return {
      ok: false,
      reason:
        "缺少 confirm_token：创建订单前必须先调用 confirm_order_details，把要点复述给客户并取得同意。",
    };
  }
  const rec = tokens.get(token);
  if (!rec) {
    log("verify.rejected", { identity, token: token.slice(0, 8), reason: "unknown_token" });
    return { ok: false, reason: "confirm_token 无效或已过期，请重新确认订单要点。" };
  }
  if (Date.now() - rec.at > TTL_MS) {
    tokens.delete(token);
    log("verify.rejected", { identity, reason: "expired", age_ms: Date.now() - rec.at });
    return {
      ok: false,
      reason: "confirm_token 已过期（超过 10 分钟），请重新与客户确认。",
      draft_id: rec.draftId,
      summary: rec.summary,
    };
  }
  if (rec.identity && identity && rec.identity !== identity) {
    log("verify.rejected", { identity, reason: "identity_mismatch", token_identity: rec.identity });
    return { ok: false, reason: "confirm_token 与当前客户不匹配。" };
  }

  // 字段级比对：只比模型这次真正传了的字段
  const changed = [];
  if (overrides && typeof overrides === "object") {
    for (const k of REQUIRED) {
      const v = overrides[k];
      if (v === undefined || v === null || v === "") continue;
      if (String(v) !== String(rec.params[k])) {
        changed.push({ field: k, confirmed: rec.params[k], submitted: v });
      }
    }
  }
  if (changed.length > 0) {
    log("verify.rejected", { identity, reason: "params_changed", changed, draft_id: rec.draftId });
    return {
      ok: false,
      reason:
        "提交的订单参数与客户确认时不一致。请二选一：① 客户改了主意 → 用新参数重新调用 confirm_order_details 取得新令牌后再下单；" +
        "② 只是你抄错了 → 直接只带 confirm_token 调用 create_appointment（参数以客户确认的为准）。",
      changed,
      confirmed_params: rec.params,
      draft_id: rec.draftId,
      summary: rec.summary,
    };
  }

  tokens.delete(token); // 一次性
  // 注意：这里**只**校验令牌，不把草稿标记为已下单。
  // 曾经在这里 markStatus("booked")，但那只证明"参数校验通过"，不代表订单真的建成了——
  // 若随后调调度器/业务库失败（或超时），草稿会带着"已下单"状态从"进行中"列表消失，
  // 这一单就真的丢了（客户以为下好了、系统里什么都没有）。
  // 正确顺序：由 create-appointment.js 在**接口返回成功之后**才标记 booked。
  log("verify.ok", {
    identity,
    draft_id: rec.draftId,
    date: rec.params.scheduled_date,
    slot: slotRangeLabel(rec.params.start_slot, rec.params.end_slot),
    had_overrides: changed.length,
  });
  return { ok: true, summary: rec.summary, params: rec.params, draft_id: rec.draftId };
}

/** 过期清理（防止长跑进程内存增长） */
export function sweep() {
  const now = Date.now();
  let n = 0;
  for (const [k, v] of tokens) if (now - v.at > TTL_MS) { tokens.delete(k); n++; }
  return n;
}

/** 诊断：当前有效令牌数 */
export function tokenCount() {
  return tokens.size;
}

export { REQUIRED as REQUIRED_ORDER_FIELDS, slotToTime };
// 便利导出：草稿读取（供确认摘要展示"进行中的订单"）
export { getDraft };
