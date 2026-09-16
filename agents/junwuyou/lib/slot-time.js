// junwuyou/lib/slot-time.js
// slot ↔ 时钟时间的**唯一实现**（需求 1 附带缺陷：工具描述里的映射是错的）
//
// 事故背景：工具描述写「start_slot 开始 slot（0=10:00）」「28=14:00」，
// 但调度器 Rust 侧（src/scheduler/types.rs）的真实定义是
//   slot_to_time(0)="00:00"、slot_to_time(18)="09:00"、slot_to_time(20)="10:00"
// 即 **slot 0 = 当天 00:00，1 slot = 30 分钟**。
// 后果：客户说「都10点」，模型按下单逻辑传了 18-20，实际写入库的是 09:00-10:00
// （比客户要求早一小时），而模型按错误的映射告诉客户「10:00-11:00」。
//
// 因此：所有时间换算集中在本文件；工具描述与确认摘要都从这里取，
// 避免同一个语义在两处各写一遍、且其中一处是错的。

const SLOT_MINUTES = 30;

/** slot → "HH:MM"（0=00:00） */
export function slotToTime(slot) {
  const n = Number(slot);
  if (!Number.isFinite(n) || n < 0) return "?";
  const total = n * SLOT_MINUTES;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "HH:MM" → slot（无法解析返回 null） */
export function timeToSlot(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || "").trim());
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (minutes % SLOT_MINUTES !== 0) return null;
  return minutes / SLOT_MINUTES;
}

/**
 * 解析客户口语时间 → slot。
 * 支持 "10:00" / "10点" / "上午10点" / "10点半" / "下午2点" / "晚上7点30分"，
 * **并且容忍前后缀**：真实路径上模型传进来的往往是客户原话整句，
 * 例如「明天上午10点」「后天下午2点半」——
 * 早期实现用整串锚定匹配（^...$），遇到「明天」前缀就**静默失败**，
 * 客户的期望时间被丢弃、系统改推荐别的时段（实测发生过：客户要 10 点，
 * propose_slots 却推 09:00-10:00 与 11:00-12:00，agent 只好说"10点已排满"）。
 * 所以这里改为**在整句里搜索**时间片段，并忽略其它词。
 */
export function parseTimeOfDay(text) {
  const s = String(text ?? "")
    .replace(/\s+/g, "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)); // 全角数字归一
  if (!s) return null;

  // ① 优先 "H:MM" 形式
  const hm = /(\d{1,2}):(\d{1,2})/.exec(s);
  if (hm) {
    const minutes = Number(hm[1]) * 60 + Number(hm[2]);
    if (hm[1] && minutes < 24 * 60 && minutes % SLOT_MINUTES === 0) return minutes / SLOT_MINUTES;
  }

  // ② "上午10点" / "下午2点半" / "晚上7点30分"，允许出现在句中任意位置
  const m = /(上午|早上|早晨|中午|下午|傍晚|晚上)?(\d{1,2})(?:点|时)(半|\d{1,2}分?)?/.exec(s);
  if (!m) return null;
  let h = Number(m[2]);
  const period = m[1] || "";
  const minute = m[3] === "半" ? 30 : m[3] ? Number(String(m[3]).replace("分", "")) : 0;
  if ((period === "下午" || period === "傍晚" || period === "晚上") && h < 12) h += 12;
  if (h > 23 || minute >= 60) return null;
  const minutes = h * 60 + minute;
  return minutes % SLOT_MINUTES === 0 ? minutes / SLOT_MINUTES : null;
}

/** 时段可读标签，如 "09:00-10:00" */
export function slotRangeLabel(startSlot, endSlot) {
  return `${slotToTime(startSlot)}-${slotToTime(endSlot)}`;
}

/** 服务时长（小时，保留一位小数），如 2 slot → "1小时" */
export function durationLabel(startSlot, endSlot) {
  const slots = Number(endSlot) - Number(startSlot);
  if (!Number.isFinite(slots) || slots <= 0) return "?";
  const hours = (slots * SLOT_MINUTES) / 60;
  return Number.isInteger(hours) ? `${hours}小时` : `${hours.toFixed(1)}小时`;
}

/** 技师工作窗口（与君无忧库 technicians 表一致：18→09:00，42→21:00） */
export const WORK_WINDOW = { startSlot: 18, endSlot: 42, startTime: "09:00", endTime: "21:00" };

/** 工具描述里用的一句话说明（避免描述与实现再次漂移） */
export const SLOT_DOC = `slot 为半小时粒度，0=当天00:00；例如 18=09:00、20=10:00、28=14:00。师傅工作时段为 ${WORK_WINDOW.startTime}-${WORK_WINDOW.endTime}（slot ${WORK_WINDOW.startSlot}-${WORK_WINDOW.endSlot}）。`;
