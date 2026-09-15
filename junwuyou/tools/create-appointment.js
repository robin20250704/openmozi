// junwuyou/tools/create-appointment.js — create_appointment Tool
// 委托给 scheduler（HTTP）— L-022
//
// 需求 2 的强制闸门：必须先经 confirm_order_details 签发令牌，才允许真正下单。
// 参数以**确认时的服务端快照**为准 —— 下单只需带 token，模型不必重抄参数
// （重抄漂移曾被误判成"token 失效"，见 lib/order-confirmation.js 的说明）。
//
// 需求 1 的日期硬化：过去日期一律拒绝。事故证据：QQ 真实对话里 agent 把
// 「今天/后天」编成 2026-05-14/05-16（真实今天 2026-09-14），**并成功写进了订单库**，
// 排期在 4 个月前 —— 系统当时没有任何日期校验。
import { createAppointment } from "../lib/scheduler-client.js";
import { currentIdentity, ensureCustomerId } from "../lib/customer-profile.js";
import { verifyConfirmation } from "../lib/order-confirmation.js";
import { markStatus } from "../lib/pending-orders.js";
import { slotRangeLabel } from "../lib/slot-time.js";
import { normalizeDate, daysBetween, nowInfo, weekdayCn } from "../lib/calendar-cn.js";

export const createAppointmentTool = {
  name: "create_appointment",
  description:
    "创建上门服务预约。必须先调用 confirm_order_details 取得 confirm_token（即先与客户确认要点），否则会被拒绝。" +
    "调用时只需传 confirm_token 即可，日期/时段/地址/价格以客户确认过的内容为准。",
  parameters: {
    type: "object",
    properties: {
      confirm_token: {
        type: "string",
        description: "confirm_order_details 返回的确认令牌（必填；未确认无法下单）",
      },
      scheduled_date: { type: "string", description: "（可选，一般不用传）预约日期 YYYY-MM-DD" },
      start_slot: { type: "integer", description: "（可选，一般不用传）开始 slot" },
      end_slot: { type: "integer", description: "（可选，一般不用传）结束 slot" },
      address: { type: "string", description: "（可选，一般不用传）详细地址" },
      community_name: { type: "string", description: "（可选，一般不用传）小区名" },
      area_sqm: { type: "number", description: "（可选，一般不用传）面积" },
      pest_type: { type: "string", description: "（可选，一般不用传）虫害类型" },
      price: { type: "number", description: "（可选，一般不用传）价格" },
      technician_id: { type: "string", description: "（可选，一般不用传）技术员 ID" },
      customer_id: { type: "integer", description: "（可选，一般不用传）客户 ID" },
    },
    required: ["confirm_token"],
  },
  execute: async (_toolCallId, params) => {
    const identity = currentIdentity(null);
    // 忽略模型传入的 customer_id：订单归属必须由服务端按当前身份解析
    const { confirm_token, customer_id: _ignoredCustomerId, ...overrides } = params ?? {};

    // 闸门：未确认 / 参数相对确认时被改动 → 拒绝（并给出字段级差异）
    const gate = verifyConfirmation(identity, confirm_token, overrides);
    if (!gate.ok) {
      const payload = { ok: false, rejected: true, error: gate.reason };
      if (gate.changed) payload.changed = gate.changed;
      if (gate.confirmed_params) payload.confirmed_params = gate.confirmed_params;
      if (gate.summary) payload.confirmed_summary = gate.summary;
      console.log(`[tool create_appointment] 拒绝 identity=${identity} reason=${gate.reason}`);
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    }

    const orderParams = { ...gate.params };
    try {
      orderParams.customer_id = await ensureCustomerId(identity);
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `无法确定当前客户：${e.message}` }) }] };
    }

    // ── 日期硬化（需求 1）──
    const today = nowInfo().date;
    const date = normalizeDate(orderParams.scheduled_date);
    if (!date) {
      console.log(`[tool create_appointment] 拒绝 非法日期 ${orderParams.scheduled_date}`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              rejected: true,
              error: `scheduled_date「${orderParams.scheduled_date}」不是合法日期（应为 YYYY-MM-DD）。今天是 ${today}，请先调 get_current_time 取得正确日期，并与客户重新确认。`,
            }),
          },
        ],
      };
    }
    const diff = daysBetween(date, today);
    if (diff < 0) {
      console.log(`[tool create_appointment] 拒绝 过去日期 ${date} (今天 ${today})`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              rejected: true,
              error: `预约日期 ${date}（${weekdayCn(date)}）已经过去 ${-diff} 天，不能作为上门日期。今天是 ${today}，请与客户重新确认上门日期后再下单。`,
            }),
          },
        ],
      };
    }

    let res;
    try {
      res = await createAppointment(orderParams);
    } catch (e) {
      console.log(`[tool create_appointment] 调度失败 ${e.message}`);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: `下单失败：${e.message}` }) }],
      };
    }

    const ok = res?.appointment_id > 0 && res?.status !== "failed";
    console.log(
      `[tool create_appointment] ${ok ? "成功" : "失败"} identity=${identity} draft=${gate.draft_id} order=${res?.appointment_id} ${date} ${slotRangeLabel(orderParams.start_slot, orderParams.end_slot)} ${orderParams.pest_type} ${orderParams.area_sqm}㎡ ${orderParams.price}元`
    );
    if (ok && gate.draft_id) {
      markStatus(identity, gate.draft_id, "booked", { order_id: res.appointment_id, booked_at: Date.now() });
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...res,
            ok,
            confirmed_with_customer: true,
            confirmed_summary: gate.summary,
            slot_label: slotRangeLabel(orderParams.start_slot, orderParams.end_slot),
            scheduled_date_weekday: weekdayCn(date),
          }),
        },
      ],
    };
  },
};
