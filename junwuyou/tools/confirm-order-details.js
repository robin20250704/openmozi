// junwuyou/tools/confirm-order-details.js — confirm_order_details Tool
// 需求 2：正式生产订单前，必须与用户确认"理解是否正确"。
// 本工具是 create_appointment 的前置闸门：把订单参数快照存到服务端并签发令牌。
//
// 2026-09-14 改进：
//   - 摘要里补上**星期几**（由后端日历算，不让模型推算）；
//   - 明确告诉模型：拿到令牌后下单**只需带 token**，不必重抄参数（消除漂移误拒）；
//   - 打结构化日志，事故可回溯。
import { currentIdentity, ensureCustomerId } from "../lib/customer-profile.js";
import { issueConfirmation } from "../lib/order-confirmation.js";
import { slotRangeLabel, SLOT_DOC } from "../lib/slot-time.js";
import { describeDate, normalizeDate, nowInfo } from "../lib/calendar-cn.js";

export const confirmOrderDetailsTool = {
  name: "confirm_order_details",
  description:
    "下单前的确认步骤：把你将用于下单的全部信息复述给客户、取得客户同意后，以 customer_confirmed=true 调用，返回 confirm_token。" +
    `create_appointment 必须携带该 token（且只需携带 token，参数以本次确认为准）。customer_id 由系统自动填写，不要自己填。${SLOT_DOC}`,
  parameters: {
    type: "object",
    properties: {
      customer_id: { type: "integer", description: "（不用填，由系统按当前客户自动填写）" },
      technician_id: { type: "string", description: "技术员 ID（来自 propose_slots）" },
      scheduled_date: { type: "string", description: "预约日期 YYYY-MM-DD（必须来自 get_current_time 的结果）" },
      start_slot: { type: "integer", description: "开始 slot（来自 propose_slots；20=10:00）" },
      end_slot: { type: "integer", description: "结束 slot（来自 propose_slots；22=11:00）" },
      address: { type: "string", description: "详细地址/小区名" },
      community_name: { type: "string", description: "小区名" },
      area_sqm: { type: "number", description: "面积" },
      pest_type: { type: "string", description: "虫害类型" },
      price: { type: "number", description: "价格（来自 query_pricing，不得自行估算）" },
      customer_confirmed: {
        type: "boolean",
        description: "客户是否已明确确认以上要点（必须先把要点复述给客户并得到同意，才可传 true）",
      },
    },
    required: [
      "technician_id",
      "scheduled_date",
      "start_slot",
      "end_slot",
      "address",
      "community_name",
      "area_sqm",
      "pest_type",
      "price",
      "customer_confirmed",
    ],
  },
  execute: async (_toolCallId, params) => {
    const identity = currentIdentity(null);
    // customer_id 一律以服务端解析结果为准，忽略模型传入的值（防止挂错客户）
    let customerId;
    try {
      customerId = await ensureCustomerId(identity);
    } catch (e) {
      console.log(`[tool confirm_order_details] 拒绝 identity=${identity} reason=no_customer: ${e.message}`);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: `无法确定当前客户（${e.message}），请先确认客户资料。` }) }],
      };
    }
    if (params?.customer_id != null && Number(params.customer_id) !== Number(customerId)) {
      console.log(
        `[tool confirm_order_details] 忽略模型传入的 customer_id=${params.customer_id}，改用上下文解析的 ${customerId}（identity=${identity}）`
      );
    }
    const r = issueConfirmation(identity, { ...params, customer_id: customerId });
    if (!r.ok) {
      console.log(`[tool confirm_order_details] 拒绝 identity=${identity} reason=${r.reason}`);
      return { content: [{ type: "text", text: JSON.stringify(r) }] };
    }

    // 用后端日历补齐"星期几"，并复核日期是否为过去（过去日期不能下单）
    const date = normalizeDate(params.scheduled_date);
    const info = date ? describeDate(date) : null;
    const enriched = {
      ...r,
      slot_label: slotRangeLabel(params.start_slot, params.end_slot),
      scheduled_date_weekday: info?.weekday ?? null,
      scheduled_date_relative: info?.relative ?? null,
      scheduled_date_type: info?.day_type_label ?? null,
      next_step:
        "请把上面 summary 里的要点原样复述给客户做最后确认；客户同意后调用 create_appointment，" +
        "**只需传 confirm_token**（不要再重抄日期/时段/价格，参数以本次确认为准）。",
    };
    if (date && info?.is_past) {
      enriched.warning = `${date} 已经过去（${info.relative}），不能作为上门日期。请先用 get_current_time 确认今天的日期，再与客户核对。`;
    }
    if (date && info?.holiday_data_covered === false) {
      enriched.holiday_caveat = `${date.slice(0, 4)} 年节假日安排未收录，不要对客户断言该日是否为法定节假日。`;
    }
    if (!date) {
      enriched.warning = `scheduled_date「${params.scheduled_date}」不是合法日期（需 YYYY-MM-DD）。今天是 ${nowInfo().date}。`;
    }

    console.log(
      `[tool confirm_order_details] ok identity=${identity} draft=${r.draft_id} date=${params.scheduled_date}(${enriched.scheduled_date_weekday}) slot=${enriched.slot_label} ${params.pest_type} ${params.area_sqm}㎡ ${params.price}元`
    );
    return { content: [{ type: "text", text: JSON.stringify(enriched) }] };
  },
};
