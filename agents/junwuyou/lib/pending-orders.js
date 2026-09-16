// junwuyou/lib/pending-orders.js
// 「进行中的订单」草稿存储（需求 2 + 需求 5 的压缩安全）
//
// 两个问题共用一个解：
//   ① 需求 2：原设计的 confirm_token 绑定**参数指纹**，要求模型在
//      confirm_order_details 和 create_appointment 两次调用里把 10 个字段
//      **原样重抄一遍**。而模型是在"自然语言→工具参数"之间转写，只要有一处
//      漂移（实测最可能的是 start_slot：工具描述写着错误的「0=10:00」，
//      而 propose_slots 返回的是 18-20），指纹就不匹配 → 被拒 → 客户看到
//      「token 失效了」这种莫名其妙的话。**这是设计脆弱，不是模型的错。**
//      改法：确认时把**完整参数快照存到服务端**，下单只需带 token，
//      参数从快照取 → 结构上不可能漂移；若模型确实又传了参数且与快照不一致，
//      则返回**字段级差异**，让它能判断是"客户改了主意"还是"自己抄错了"。
//   ② 需求 5：会话压缩（或网关重启）会把"正在进行的订单"细节从上下文里抹掉。
//      把草稿落盘并在每轮的档案后缀里回注，压缩/重启都不会丢单。
//
// 落盘而非纯内存：网关重启后订单草稿仍在（确认令牌本身仍是内存 + 10 分钟 TTL，
// 过期后需重新确认，但草稿内容可复用，不必再问客户一遍）。
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATE_DIR = process.env.JUNWUYOU_STATE_DIR || join(homedir(), ".mozi", "junwuyou");
const FILE = join(STATE_DIR, "pending-orders.json");
/** 草稿保留时长：订单谈成前后都够用，又不会无限堆积 */
const TTL_MS = Number(process.env.PENDING_ORDER_TTL_MS || 24 * 60 * 60 * 1000);
const MAX_PER_IDENTITY = 5;

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
  } catch {
    cache = {};
  }
  if (typeof cache !== "object" || cache === null) cache = {};
  return cache;
}

function persist() {
  const data = load();
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, FILE);
  } catch (e) {
    // 落盘失败不能阻断下单主流程，但必须可见
    console.warn(`[pending-orders] 落盘失败: ${e.message}`);
  }
}

function fresh(identity) {
  const data = load();
  const now = Date.now();
  const list = (data[identity]?.orders ?? []).filter((o) => now - (o.updated_at ?? 0) < TTL_MS);
  data[identity] = { orders: list };
  return list;
}

/** 保存/更新一份订单草稿；同一份草稿（draft_id 相同）为覆盖更新 */
export function saveDraft(identity, draftId, params, extra = {}) {
  if (!identity) throw new Error("saveDraft 需要 identity");
  const data = load();
  const list = fresh(identity);
  const now = Date.now();
  const idx = list.findIndex((o) => o.draft_id === draftId);
  const draft = {
    draft_id: draftId,
    status: extra.status ?? "draft",
    params,
    summary: extra.summary ?? null,
    created_at: idx >= 0 ? list[idx].created_at : now,
    updated_at: now,
  };
  if (idx >= 0) list[idx] = draft;
  else list.push(draft);
  // 只保留最近 N 份，避免无限增长
  list.sort((a, b) => b.updated_at - a.updated_at);
  data[identity] = { orders: list.slice(0, MAX_PER_IDENTITY) };
  persist();
  return draft;
}

export function getDraft(identity, draftId) {
  return fresh(identity).find((o) => o.draft_id === draftId) ?? null;
}

/** 未完成（草稿或已确认待下单）的订单 —— 用于注入档案后缀 */
export function listActive(identity) {
  return fresh(identity).filter((o) => o.status === "draft" || o.status === "confirmed");
}

export function listAll(identity) {
  return fresh(identity);
}

export function markStatus(identity, draftId, status, extra = {}) {
  const data = load();
  const list = fresh(identity);
  const d = list.find((o) => o.draft_id === draftId);
  if (!d) return null;
  d.status = status;
  d.updated_at = Date.now();
  Object.assign(d, extra);
  data[identity] = { orders: list };
  persist();
  return d;
}

export function removeDraft(identity, draftId) {
  const data = load();
  const list = fresh(identity).filter((o) => o.draft_id !== draftId);
  data[identity] = { orders: list };
  persist();
}

/** 渲染成给模型看的一段文字（放进档案后缀，随每轮注入 → 压缩也丢不掉） */
export function renderActiveText(identity, slotRangeLabel) {
  const active = listActive(identity);
  if (active.length === 0) return "";
  const lines = ["【进行中的订单（跨轮保留，请勿重复询问这些内容）】"];
  active.forEach((o, i) => {
    const p = o.params ?? {};
    const when = [p.scheduled_date, slotRangeLabel ? slotRangeLabel(p.start_slot, p.end_slot) : null]
      .filter(Boolean)
      .join(" ");
    const what = [p.pest_type, p.area_sqm ? `${p.area_sqm}㎡` : null].filter(Boolean).join(" ");
    const where = [p.community_name, p.address].filter(Boolean).join(" ");
    lines.push(
      `${i + 1}. [${o.status === "confirmed" ? "已与客户确认、待下单" : "未确认"}] ${when} ${what} ${where} ${
        p.price != null ? `${p.price}元` : ""
      }`.trim()
    );
  });
  lines.push("下单请直接用对应订单的 confirm_token 调 create_appointment，不要重新采集这些信息。");
  return lines.join("\n");
}

/** 只读的诊断/测试辅助 */
export function stats() {
  const data = load();
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.orders?.length ?? 0]));
}

export function _reset() {
  cache = {};
  persist();
}

export const _FILE = FILE;
