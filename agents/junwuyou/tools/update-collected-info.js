// tools/update-collected-info.js — update_collected_info Tool
//
// 需求 1/2 的核心写入路径。三条写入：
//   ① 会话级（PG collected_info，主键 session_id）—— 本轮下单用的"当下草稿"
//   ② **客户级（junwuyou Express /api/customers/upsert）—— 跨会话的客户 Profile**
//   ③ **进行中订单草稿（pending-orders）—— 多套房产/多个订单 + 压缩安全**
//
// 2026-09-14 补齐（QQ 真实事故）：客户有两套房（百花南天二花园 100㎡ 灭蟑螂、
// 纯水岸 200㎡ 白蚁），原工具只有单个 address/community_name 字段，
// 模型索性两个都没填 → 档案里 name/phone 有值，**address 和 community_name 是空的**
//   {"id":9,"wecom_user_id":"qq:...","name":"曾生","phone":"13823343328","address":null,"community_name":null}
// 客户下次来又要重新说地址，Profile 的价值归零。
// 改法：新增 orders[] 数组（每单一条），主地址仍写 profiles，全部订单另存草稿，
// 并由每轮的档案后缀回注 → 多单不丢、压缩不丢。
import { query } from "../lib/pg-client.js";

async function loadLib(name) {
  return await import(`../lib/${name}.js`);
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS collected_info (
  session_id TEXT PRIMARY KEY,
  info JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now()
);`;

let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured) return;
  await query(SCHEMA_SQL);
  schemaEnsured = true;
}

/** 会话级字段 → 客户级 Profile 字段的映射（只映射"跨会话仍然有效"的身份信息） */
function toProfileFields(info) {
  const out = {};
  if (info.name) out.name = String(info.name).trim();
  if (info.phone) out.phone = String(info.phone).trim();
  if (info.address) out.address = String(info.address).trim();
  if (info.community_name) out.community_name = String(info.community_name).trim();
  if (info.preferences) out.notes = String(info.preferences).trim();
  return out;
}

/** 从 orders[] 里取"主地址"（客户最可能常住的那套），供 profile 使用 */
function primaryFromOrders(orders) {
  const first = (orders || []).find((o) => o && (o.address || o.community_name));
  if (!first) return {};
  return {
    address: first.address ? String(first.address).trim() : undefined,
    community_name: first.community_name ? String(first.community_name).trim() : undefined,
  };
}

export const updateCollectedInfoTool = {
  name: "update_collected_info",
  description:
    "记录本次对话采集到的客户信息。联系方式/地址/偏好会写入客户档案（跨会话保留），下次服务可直接复用、无需重复询问。" +
    "客户说出地址后**必须填 address 与 community_name 字段**（不要只放在心里）。" +
    "若客户有**多套房产/多个待办订单**，请用 orders 数组逐条填写，每条含 address/community_name/pest_type/area_sqm/preferred_date。",
  parameters: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "会话 ID" },
      customer_id: { type: "string", description: "客户标识（可省略：默认取当前会话对应的客户）" },
      info: {
        type: "object",
        description: "采集字段（增量合并）",
        properties: {
          pest_type: { type: "string", description: "虫害类型" },
          area_sqm: { type: "number", description: "面积（平米）" },
          address: { type: "string", description: "详细地址（客户提供的地址一定要填这里）" },
          community_name: { type: "string", description: "小区/大厦名（一定要填）" },
          preferred_date: { type: "string", description: "期望日期（YYYY-MM-DD，来自 get_current_time）" },
          preferred_time: { type: "string", description: "期望时段（如 10:00）" },
          phone: { type: "string", description: "联系电话（写入客户档案）" },
          name: { type: "string", description: "称呼/姓名（写入客户档案）" },
          preferences: { type: "string", description: "客户偏好（写入客户档案，如'偏好周末上午'、'家里有宠物'）" },
          orders: {
            type: "array",
            description: "多套房产/多个待办订单时逐条填写（客户有两个地址就必须用这个字段）",
            items: {
              type: "object",
              properties: {
                address: { type: "string" },
                community_name: { type: "string" },
                pest_type: { type: "string" },
                area_sqm: { type: "number" },
                preferred_date: { type: "string", description: "YYYY-MM-DD" },
                preferred_time: { type: "string" },
              },
            },
          },
        },
      },
    },
    required: ["session_id", "info"],
  },
  execute: async (_toolCallId, params) => {
    const info = params.info || {};
    const result = { ok: true, stored: { session: false, profile: false, drafts: 0 } };

    // ① 会话级（保持原行为）
    try {
      await ensureSchema();
      await query(
        `INSERT INTO collected_info (session_id, info, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (session_id)
         DO UPDATE SET info = collected_info.info || $2::jsonb, updated_at = now()`,
        [params.session_id, JSON.stringify(info)]
      );
      result.stored.session = true;
    } catch (e) {
      result.stored.session_error = e.message;
    }

    // ② 客户级（需求 1：形成跨会话 Profile）
    try {
      const { currentIdentity, upsertProfile } = await loadLib("customer-profile");
      const identity = currentIdentity(params.customer_id);
      const orders = Array.isArray(info.orders) ? info.orders : [];
      const fields = { ...toProfileFields(info), ...primaryFromOrders(orders) };
      // 多单时把各订单地址记进备注，保证地址信息不丢
      if (orders.length > 1) {
        const list = orders
          .map((o, i) => `${i + 1})${[o.community_name, o.address].filter(Boolean).join(" ")} ${o.pest_type || ""} ${o.area_sqm ? o.area_sqm + "㎡" : ""}`.trim())
          .join("；");
        fields.notes = [fields.notes, `地址清单：${list}`].filter(Boolean).join(" | ");
      }
      if (identity && Object.keys(fields).length > 0) {
        const customer = await upsertProfile(identity, fields);
        result.stored.profile = !!customer;
        result.customer_id = identity;
        result.profile_fields = Object.keys(fields);
      } else {
        result.stored.profile = false;
        result.profile_skipped = identity ? "无可持久化字段" : "未取到客户身份";
      }

      // ③ 进行中订单草稿（多套房产 + 压缩安全）
      if (identity && orders.length > 0) {
        const po = await loadLib("pending-orders");
        orders.forEach((o, i) => {
          const draft = {
            community_name: o.community_name ?? info.community_name ?? null,
            address: o.address ?? info.address ?? null,
            pest_type: o.pest_type ?? info.pest_type ?? null,
            area_sqm: o.area_sqm ?? info.area_sqm ?? null,
            scheduled_date: o.preferred_date ?? info.preferred_date ?? null,
            preferred_time: o.preferred_time ?? info.preferred_time ?? null,
          };
          const draftId = `draft_${i + 1}_${String(draft.community_name || draft.address || "order").slice(0, 12)}`;
          po.saveDraft(identity, draftId, draft, { status: "draft" });
        });
        const { slotRangeLabel } = await loadLib("slot-time");
        result.stored.drafts = orders.length;
        result.active_orders = po.listActive(identity).length;
      }
    } catch (e) {
      result.stored.profile = false;
      result.profile_error = e.message;
    }

    console.log(
      `[tool update_collected_info] session=${params.session_id} fields=${JSON.stringify(Object.keys(info))} profile=${result.stored.profile} drafts=${result.stored.drafts}`
    );
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
};
