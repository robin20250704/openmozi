// validate-appointment.js — L-012 create_appointment 一次性校验所有字段
// 参考 wecom-gateway/src/jcode/tools.rs::handle_create_appointment
// 教训 L-012：缺字段校验用 `?` 短路导致 LLM 每轮只补一个字段，烧光工具循环上限

const REQUIRED_FIELDS = [
  "technician_id",
  "scheduled_date",
  "start_slot",
  "end_slot",
  "address",
  "community_name",
  "area_sqm",
  "pest_type",
  "price",
];

export function validateCreateAppointmentParams(params) {
  if (!params || typeof params !== "object") {
    return { ok: false, missing: REQUIRED_FIELDS.slice() };
  }
  const missing = [];
  for (const f of REQUIRED_FIELDS) {
    if (params[f] === undefined || params[f] === null || params[f] === "") {
      missing.push(f);
    }
  }
  return missing.length === 0
    ? { ok: true }
    : {
        ok: false,
        missing,
        hint: `Missing required fields: ${missing.join(", ")}. 请一次性补齐全部缺失字段后重试（客户已提供的虫害/面积/地址/价格等信息在对话上下文中，请全部填入）。`,
      };
}
