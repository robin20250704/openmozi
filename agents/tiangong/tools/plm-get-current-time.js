// agents/tiangong/tools/plm-get-current-time.js
//
// plm_get_current_time：查当前时间 + 目标日期的星期/相对日解析。
//
// 为什么这个 agent 也需要它：runtime 的系统提示**默认不注入时间**（AGENT_INCLUDE_DATETIME
// 缺省 false，为了保住可缓存前缀，见 runtime.ts 的注释）——所以模型没有任何内置日历，
// 凡"今天/下周几/还剩几天"都必须调本工具，否则会自己推算（出错代价最高的一类）。
//
// 与君无忧的 get_current_time 的差异：本工具**不查节假日表**（PLM 场景用不到，且节假日口径
// 属业务数据而非框架知识；缺了它就不能对一个不存在的日历给断言——这正是"宁可不答"的纪律）。
// 工具名带 plm_ 前缀：工具隔离断言（A4）要求与另一 agent 的名字零交集。

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

/** 把 Date 按**本地时区**格式化为 YYYY-MM-DD（不用 toISOString：那是 UTC，会差一天） */
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 解析相对日期表达（"今天/明天/后天/大后天/昨天/周一~周日/本周X/下周X/上周X"）。
 *
 * 返回 { date, label } 或 null（解析不了就返回 null，让模型如实说"请给具体日期"，
 * **绝不猜**——猜错日期比不回答更糟）。
 */
function resolveRelative(term, now) {
  const t = String(term ?? "").trim();
  if (!t) return null;
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const simple = {
    今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3, 昨天: -1, 前天: -2,
  };
  if (t in simple) {
    const d = new Date(base);
    d.setDate(d.getDate() + simple[t]);
    return { date: ymd(d), label: t };
  }

  // 周X / 星期X / 礼拜X（默认指**本周内**的那个：本周一=本周已过去的周一）
  const m1 = t.match(/^(?:本)?(?:周|星期|礼拜)([一二三四五六日天])$/);
  // 下周X / 下星期X
  const m2 = t.match(/^下(?:周|星期|礼拜)([一二三四五六日天])$/);
  // 上周X
  const m3 = t.match(/^上(?:周|星期|礼拜)([一二三四五六日天])$/);
  const m = m1 || m2 || m3;
  if (m) {
    const ch = m[1];
    const target = ch === "日" || ch === "天" ? 0 : "一二三四五六".indexOf(ch) + 1;
    const cur = base.getDay();
    let delta = target - cur;
    if (m1) {
      // 本周：把差值收进 [-6,0] 区间 → "本周三"永远是**已过去或今天**的那个周三
      if (delta > 0) delta -= 7;
    } else if (m2) {
      // 下周：先到本周日之前的偏移，再加 7
      if (delta <= 0) delta += 7;
      delta += 0; // 保持 base 为本周同一天，delta 已指向下周该天
    } else {
      // 上周
      if (delta >= 0) delta -= 7;
      delta -= 7;
    }
    const d = new Date(base);
    d.setDate(d.getDate() + delta);
    return { date: ymd(d), label: t };
  }

  // 已经是绝对日期：原样规范化为 YYYY-MM-DD 并算星期
  const mAbs = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (mAbs) {
    const d = new Date(Number(mAbs[1]), Number(mAbs[2]) - 1, Number(mAbs[3]));
    if (!Number.isNaN(d.getTime())) return { date: ymd(d), label: t };
  }
  return null;
}

export const plmGetCurrentTimeTool = {
  name: "plm_get_current_time",
  label: "查询当前日期时间",
  description:
    "查询当前日期时间，并把相对日期（今天/明天/后天/本周三/下周一/昨天/绝对日期）解析为 YYYY-MM-DD 与星期。" +
    "凡用户提到日期、星期、还剩几天、截止时间，**必须先调本工具**，禁止自己推算。" +
    "解析不了的说法会在 unresolved 里返回，此时应请用户给出具体日期，不得猜。",
  parameters: {
    type: "object",
    properties: {
      date: { type: "string", description: "要解析的日期表达（如「今天」「下周一」「2026-10-08」）；不给则只返回当前时间" },
    },
    required: [],
  },
  async execute(_toolCallId, params) {
    const now = new Date();
    const term = params?.date;
    const resolved = term ? resolveRelative(term, now) : null;
    const payload = {
      ok: true,
      now: {
        datetime: `${ymd(now)} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
        date: ymd(now),
        weekday: WEEKDAYS[now.getDay()],
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
      },
      resolved: resolved
        ? {
            input: String(term),
            date: resolved.date,
            weekday: WEEKDAYS[new Date(`${resolved.date}T00:00:00`).getDay()],
            days_from_today: Math.round(
              (new Date(`${resolved.date}T00:00:00`).getTime() - new Date(`${ymd(now)}T00:00:00`).getTime()) / 86400000
            ),
          }
        : null,
      // 解析不了要显式回传（而不是丢个 null 让模型自己编）
      unresolved: term && !resolved ? String(term) : null,
      note: "本工具不含节假日表；节假日相关问题请如实说需要人工确认，不要断言。",
    };
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  },
};
