// junwuyou/tools/get-current-time.js — get_current_time Tool（需求 1）
//
// 存在理由：agent 原本**没有任何时间坐标**（实测它会回答「我这边没有日历功能」），
// 却会把「今天/后天」编成具体日期并写进订单库。时间必须由后端提供：
//   (a) 查当前时间（日期/时钟/星期/是否节假日）；
//   (b) 把客户的日期说法（今天/后天/下周一/9月16日）解析成明确日期，
//       并给出星期几、是否节假日、距今多少天、是否已过去。
// 所有结论都来自 lib/calendar-cn.js 的计算，模型只被允许复述。
import { currentTimeCard, describeDate, resolveDateSpec, addDays, nowInfo, normalizeDate } from "../lib/calendar-cn.js";

export const getCurrentTimeTool = {
  name: "get_current_time",
  description:
    "查询当前日期时间，以及任意目标日期是星期几、是否节假日。凡是涉及日期就要先调用本工具，禁止自己推算日期。" +
    "参数 date 可传具体日期（2026-09-16）或客户的相对说法（今天/明天/后天/下周一等）。",
  parameters: {
    type: "object",
    properties: {
      date: {
        type: "string",
        description: "要查询的目标日期：'YYYY-MM-DD'，或 '今天'/'明天'/'后天'/'大后天'/'下周一'/'9月16日' 等客户原话。省略则只返回当前时间。",
      },
      days_ahead: {
        type: "integer",
        description: "可选：相对今天之后第几天（1=明天）。与 date 二选一。",
      },
    },
  },
  execute: async (_toolCallId, params) => {
    const card = currentTimeCard();
    const result = {
      ok: true,
      now: card.now,
      today: card.today,
      today_type: card.today_day_type_label,
      service_window: card.service_window,
      upcoming_holidays: card.upcoming_holidays,
    };

    const spec = params?.date ?? (params?.days_ahead != null ? addDays(nowInfo().date, Number(params.days_ahead)) : null);
    if (spec != null && String(spec).trim() !== "") {
      const raw = String(spec).trim();
      const resolved = normalizeDate(raw) || resolveDateSpec(raw);
      if (!resolved) {
        result.target = null;
        result.error = `无法把「${raw}」解析成具体日期。请向客户确认一个明确的日期，不要猜测。`;
      } else {
        const info = describeDate(resolved);
        result.target = { requested_as: raw, ...info };
        if (info.is_past) {
          result.target.warning = `该日期（${info.date}）已经过去 ${-info.days_from_today} 天，不能作为上门日期。`;
        }
        if (info.holiday_data_covered === false) {
          result.target.holiday_caveat = `注意：${info.date.slice(0, 4)} 年的节假日安排本系统未收录，只能确认它是否为周末，不要断言是/不是法定节假日。`;
        }
      }
    }

    result.usage_rule =
      "以上为系统计算结果，是日期问题的唯一事实来源。请直接使用这些日期/星期/节假日的结论，" +
      "不得自行推算或改写；下单时 scheduled_date 必须使用这里返回的 YYYY-MM-DD。";

    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
};
