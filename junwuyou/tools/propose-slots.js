// tools/propose-slots.js — propose_slots Tool
// 推荐 2-3 个候选时段
//
// 需求 1 的两处修正：
//   ① 原返回体只有裸的 start_slot/end_slot（如 18/20），模型必须自己换算成时间；
//      而工具描述里的映射写错了（写「0=10:00」，真实是 0=00:00）→ 模型报给客户
//      「10:00-11:00」，实际下单是 09:00-10:00。现在由后端**直接给出 time_label**，
//      模型只负责复述，不再有换算机会出错。
//   ② 原返回体不含日期（调度器接口本身就不回日期），模型因此编造日期。
//      现在把请求的日期解析结果（星期/是否节假日/距今几天/是否已过去）一并返回。
import { proposeSlots } from "../lib/scheduler-client.js";
import { slotRangeLabel, durationLabel, SLOT_DOC, WORK_WINDOW, parseTimeOfDay, slotToTime } from "../lib/slot-time.js";
import { describeDate, normalizeDate, resolveDateSpec, nowInfo, weekdayCn } from "../lib/calendar-cn.js";

export const proposeSlotsTool = {
  name: "propose_slots",
  description:
    "根据客户期望日期/小区/服务时长推荐候选时段。返回结果里的 time_label 是可直接告诉客户的时段文本，请照它复述。" +
    `preferred_date 必须是 get_current_time 解析出的 YYYY-MM-DD。客户如果说了想要几点，把**原话**放进 wish_time（如「上午10点」「10:00」），不要自己换算。${SLOT_DOC}`,
  parameters: {
    type: "object",
    properties: {
      preferred_date: { type: "string", description: "期望日期 YYYY-MM-DD（必须来自 get_current_time）" },
      community_name: { type: "string", description: "小区名称" },
      service_slots: { type: "integer", description: "服务时长（半小时粒度），1=半小时，默认 2（=1小时）", default: 2 },
      wish_time: { type: "string", description: "客户希望的上门时间原话，如「上午10点」「10:00」（框架会解析，不要自己换成 slot 数字）" },
      wish_start: { type: "integer", description: "（一般不用传）期望最早开始 slot" },
      wish_end: { type: "integer", description: "（一般不用传）期望最晚结束 slot" },
      top_k: { type: "integer", description: "推荐数量", default: 3 },
    },
    required: ["preferred_date", "community_name"],
  },
  execute: async (_toolCallId, params) => {
    const today = nowInfo().date;
    // 容错：模型可能传「后天」这类原话而不是 YYYY-MM-DD
    const raw = String(params?.preferred_date ?? "").trim();
    let date = normalizeDate(raw) || resolveDateSpec(raw, today);
    const dateInfo = date ? describeDate(date) : null;
    const warnings = [];
    if (!date) {
      warnings.push(`preferred_date「${raw}」无法解析成具体日期，已退化为按今天 ${today} 查询。请先调 get_current_time。`);
      date = today;
    }
    if (dateInfo?.is_past) {
      warnings.push(`preferred_date ${date} 已经过去（${dateInfo.relative}），不能用于上门预约。今天是 ${today}。`);
    }

    // 客户口语时间 → slot（后端解析，避免模型换算出错）
    const duration = Number(params?.service_slots ?? 2);
    let wishStart = params?.wish_start;
    let wishEnd = params?.wish_end;
    let wishSlot = null;
    if (params?.wish_time) {
      wishSlot = parseTimeOfDay(params.wish_time);
      if (wishSlot == null) {
        warnings.push(`wish_time「${params.wish_time}」无法解析成时间，已忽略该偏好。`);
      } else {
        wishStart = wishSlot;
        wishEnd = wishSlot + duration;
      }
    }

    const req = { ...params, preferred_date: date };
    delete req.wish_time;
    if (wishStart != null) req.wish_start = wishStart;
    if (wishEnd != null) req.wish_end = wishEnd;

    const res = await proposeSlots(req);
    const slots = Array.isArray(res) ? res : [];
    const enriched = slots.map((s) => ({
      technician_id: s.technician_id,
      technician_name: s.technician_name,
      start_slot: s.start_slot,
      end_slot: s.end_slot,
      time_label: slotRangeLabel(s.start_slot, s.end_slot),
      start_time: slotToTime(s.start_slot),
      duration: durationLabel(s.start_slot, s.end_slot),
      matches_customer_wish: wishSlot == null ? null : Number(s.start_slot) === wishSlot,
      score: s.score,
    }));

    // 客户希望的时段若不在候选里，必须如实告知（不要默默换一个时间给客户）
    let wishStatus = null;
    if (wishSlot != null) {
      const exact = enriched.find((s) => s.matches_customer_wish);
      wishStatus = exact
        ? `客户希望的 ${slotToTime(wishSlot)} 可约（${exact.technician_name}）`
        : `客户希望的 ${slotToTime(wishSlot)} 当天不可约，请在上面的候选里另约并明确告诉客户该时间不可用`;
    }

    const out = {
      ok: true,
      preferred_date: date,
      preferred_date_weekday: weekdayCn(date),
      preferred_date_type: dateInfo?.day_type_label ?? null,
      today,
      customer_wish_time: params?.wish_time ?? null,
      customer_wish_slot_label: wishSlot != null ? slotRangeLabel(wishSlot, wishSlot + duration) : null,
      wish_status: wishStatus,
      service_window: WORK_WINDOW,
      slots: enriched,
      rules: [
        "给客户报时段时，直接复述 slots[].time_label（这是准确的时钟时间）。",
        "下单时 start_slot / end_slot 用 slots[] 里的原值，不要自己换算。",
        "日期一律用 preferred_date 字段里的 YYYY-MM-DD。",
        "要优先推荐 matches_customer_wish 为 true 的时段。",
      ],
    };
    if (warnings.length) out.warnings = warnings;

    console.log(
      `[tool propose_slots] date=${date}(${weekdayCn(date)}) community=${params.community_name} wish=${params?.wish_time ?? "-"} → ${enriched.length} 个时段 ${enriched.map((s) => s.time_label).join(",")}`
    );
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
  },
};
