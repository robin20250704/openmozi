// junwuyou/lib/calendar-cn.js
// 日期/星期/节假日计算（需求 1）
//
// 为什么必须在后端算、而不是让模型算：
//   实测（scripts/probe-agent-dates.mjs）向 agent 问「今天几月几号」，它回答
//   「我这边没有实时的日历功能」——即它**没有任何时间坐标**。
//   QQ 真实对话里它却把「今天/后天」编成了 5/14、5/16，并**写进了数据库**。
//   根因是上一轮为了保住提示词缓存前缀稳定，把 system prompt 里的动态时间去掉了
//   （见 src/agents/runtime.ts 的 AGENT_INCLUDE_DATETIME），却没有补上替代的取时途径。
//   正确解法：时间作为**工具**按需获取（不污染可缓存前缀），所有日期判断由后端计算。
//
// 时区：显式固定为 Asia/Shanghai，不依赖宿主机时区（部署机时区变更不会算错日子）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TZ = "Asia/Shanghai";
const WEEKDAY_CN = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const WEEKDAY_SHORT = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const __dirname = dirname(fileURLToPath(import.meta.url));
let HOLIDAYS = null;
function holidayTable() {
  if (HOLIDAYS) return HOLIDAYS;
  try {
    HOLIDAYS = JSON.parse(readFileSync(join(__dirname, "..", "data", "holidays-cn.json"), "utf8"));
  } catch {
    HOLIDAYS = { years: {} };
  }
  return HOLIDAYS;
}

const pad = (n) => String(n).padStart(2, "0");
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 严格校验并规范化 "YYYY-MM-DD"（不接受 2026-02-30 这类不存在的日期） */
export function normalizeDate(input) {
  const m = DATE_RE.exec(String(input || "").trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (dt.getUTCFullYear() !== Number(y) || dt.getUTCMonth() !== Number(mo) - 1 || dt.getUTCDate() !== Number(d)) {
    return null;
  }
  return `${y}-${mo}-${d}`;
}

/** 当前上海时间（不依赖宿主时区） */
export function nowInfo() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  // Intl 在 24 小时制下可能给出 "24"（部分 ICU 版本），归一化到 00
  const hour = get("hour") === "24" ? "00" : get("hour");
  return { date, time: `${hour}:${get("minute")}`, hour: Number(hour), weekdayIndex: weekdayIndex(date) };
}

/** 日期 → 星期索引（0=周日） */
export function weekdayIndex(dateStr) {
  const d = normalizeDate(dateStr);
  if (!d) return -1;
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
}

export function weekdayCn(dateStr) {
  const i = weekdayIndex(dateStr);
  return i < 0 ? "?" : WEEKDAY_CN[i];
}

export function isWeekend(dateStr) {
  const i = weekdayIndex(dateStr);
  return i === 0 || i === 6;
}

/** 日期加减天数（基于 UTC 运算，避开夏令时/时区误差） */
export function addDays(dateStr, days) {
  const d = normalizeDate(dateStr);
  if (!d) return null;
  const [y, m, dd] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, dd));
  dt.setUTCDate(dt.getUTCDate() + Number(days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** 相差天数（a - b），按自然日 */
export function daysBetween(a, b) {
  const na = normalizeDate(a);
  const nb = normalizeDate(b);
  if (!na || !nb) return null;
  const t = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((t(na) - t(nb)) / 86400000);
}

/** 相对今天的说法：今天/明天/后天/大后天/N天后/昨天/N天前 */
export function relativeLabel(dateStr, baseDate) {
  const base = baseDate || nowInfo().date;
  const diff = daysBetween(dateStr, base);
  if (diff === null) return "?";
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === 2) return "后天";
  if (diff === 3) return "大后天";
  if (diff === -1) return "昨天";
  if (diff === -2) return "前天";
  return diff > 0 ? `${diff}天后` : `${-diff}天前`;
}

/**
 * 节假日判断。
 * 返回 {kind, name, note, covered}
 *   kind: holiday（法定放假日）/ makeup_workday（调休上班的周末）/ weekend / workday
 *   covered: 该年份是否已收录权威安排（未收录时不得推测）
 */
export function holidayInfo(dateStr) {
  const d = normalizeDate(dateStr);
  if (!d) return { kind: "unknown", covered: false, note: "日期格式无效" };
  const year = d.slice(0, 4);
  const table = holidayTable();
  const y = table.years?.[year];
  const weekend = isWeekend(d);
  if (!y) {
    return {
      kind: weekend ? "weekend" : "workday",
      covered: false,
      note: `${year} 年的法定节假日安排未收录，仅能判断是否为周末（${weekend ? "是周末" : "是工作日"}）；如需确认请查国务院办公厅通知。`,
    };
  }
  if (y.holidays?.[d]) {
    return { kind: "holiday", name: y.holidays[d], covered: true, note: `法定节假日（${y.holidays[d]}）` };
  }
  if (y.makeup_workdays?.[d]) {
    return { kind: "makeup_workday", name: y.makeup_workdays[d], covered: true, note: `调休上班日（${y.makeup_workdays[d]}，虽是周末但要上班）` };
  }
  return { kind: weekend ? "weekend" : "workday", covered: true, note: weekend ? "普通周末（非法定节假日）" : "普通工作日" };
}

/**
 * 把客户的日期说法解析成具体日期。
 * 支持：今天/明天/后天/大后天/昨天/前天、这周X、下周X、X月X日、M/D、YYYY-MM-DD。
 * 无法解析返回 null（调用方应转问客户，禁止猜）。
 */
export function resolveDateSpec(spec, baseDate) {
  const base = baseDate || nowInfo().date;
  const s = String(spec || "").trim();
  if (!s) return null;

  const direct = normalizeDate(s);
  if (direct) return direct;

  const rel = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3, 昨天: -1, 前天: -2 };
  if (s in rel) return addDays(base, rel[s]);

  // X月X日 / X月X号
  const md = /^(\d{1,2})月(\d{1,2})[日号]$/.exec(s);
  if (md) return mmddToDate(base, Number(md[1]), Number(md[2]));

  // M/D 或 M-D
  const slash = /^(\d{1,2})[/-](\d{1,2})$/.exec(s);
  if (slash) return mmddToDate(base, Number(slash[1]), Number(slash[2]));

  // 这周X / 本周X / 下周X / 周X / 星期X
  const w = /^(这|本|下)?(?:周|星期|礼拜)([一二三四五六日天])$/.exec(s);
  if (w) {
    const target = "一二三四五六日天".indexOf(w[2]) + 1; // 周一=1 … 周日=7
    const idx = target === 7 ? 0 : target;
    const baseIdx = weekdayIndex(base);
    const baseMon = addDays(base, -((baseIdx + 6) % 7)); // 本周一
    const offset = idx === 0 ? 6 : idx - 1;
    const weekShift = w[1] === "下" ? 7 : w[1] === "这" || w[1] === "本" ? 0 : (offset < ((baseIdx + 6) % 7) ? 7 : 0);
    return addDays(baseMon, offset + weekShift);
  }

  return null;
}

function mmddToDate(base, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const y = Number(base.slice(0, 4));
  for (const year of [y, y + 1]) {
    const cand = normalizeDate(`${year}-${pad(month)}-${pad(day)}`);
    if (cand && daysBetween(cand, base) >= 0) return cand;
  }
  return normalizeDate(`${y}-${pad(month)}-${pad(day)}`);
}

/**
 * 生成给模型看的"日期事实卡"。模型只被允许复述这里的内容，不得自行推算。
 */
export function describeDate(dateStr, baseDate) {
  const d = normalizeDate(dateStr);
  if (!d) return null;
  const base = baseDate || nowInfo().date;
  const h = holidayInfo(d);
  const diff = daysBetween(d, base);
  return {
    date: d,
    weekday: weekdayCn(d),
    relative: relativeLabel(d, base),
    days_from_today: diff,
    is_past: diff < 0,
    day_type: h.kind,
    day_type_label:
      h.kind === "holiday" ? `法定节假日（${h.name}）`
      : h.kind === "makeup_workday" ? `调休上班日（${h.name}）`
      : h.kind === "weekend" ? "周末"
      : "工作日",
    holiday_name: h.name ?? null,
    holiday_note: h.note,
    holiday_data_covered: h.covered,
  };
}

export const SERVICE_WINDOW = { start: "09:00", end: "21:00", note: "君无忧师傅上门时段为每天 09:00-21:00" };

/** 服务器当前时间卡（update_collected_info 之外，agent 唯一的取时途径） */
export function currentTimeCard() {
  const n = nowInfo();
  const h = holidayInfo(n.date);
  return {
    now: { date: n.date, time: n.time, weekday: weekdayCn(n.date) },
    today: describeDate(n.date, n.date),
    today_day_type: h.kind,
    today_day_type_label:
      h.kind === "holiday" ? `法定节假日（${h.name}）`
      : h.kind === "makeup_workday" ? `调休上班日（${h.name}）`
      : h.kind === "weekend" ? "周末"
      : "工作日",
    service_window: SERVICE_WINDOW,
    upcoming_holidays: nextHolidays(n.date, 3),
  };
}

/** 未来若干法定节假日（用于"最近有什么节假日"这类提问） */
export function nextHolidays(fromDate, limit = 3) {
  const d = normalizeDate(fromDate);
  if (!d) return [];
  const year = d.slice(0, 4);
  const y = holidayTable().years?.[year];
  if (!y?.holidays) return [];
  const byName = new Map();
  for (const [date, name] of Object.entries(y.holidays)) {
    if (!byName.has(name)) byName.set(name, { name, start: date, end: date });
    const e = byName.get(name);
    if (date < e.start) e.start = date;
    if (date > e.end) e.end = date;
  }
  return [...byName.values()]
    .filter((h) => h.end >= d)
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, limit);
}
