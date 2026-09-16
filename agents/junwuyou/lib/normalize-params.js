// normalize-params.js — L-010 参数别名归一化
// LLM 工具调用常见把 schema 字段误写成别名，统一纠正避免无谓的报错重试。
// 参考 wecom-gateway/src/jcode/tools.rs::normalize_param_aliases

const ALIASES = {
  // 通用
  community: "community_name",
  communityName: "community_name",
  customerId: "customer_id",
  area: "area_sqm",
  pest: "pest_type",
  // create_appointment 用 scheduled_date；propose_slots 用 preferred_date
  // （按 tool 区分）
};

function normalizeForTool(toolName, params) {
  if (!params || typeof params !== "object") return params;
  const out = { ...params };
  for (const [alias, canonical] of Object.entries(ALIASES)) {
    if (alias in out && !(canonical in out)) {
      out[canonical] = out[alias];
      delete out[alias];
    }
  }
  // date 别名按工具区分语义
  if ("date" in out && !("scheduled_date" in out) && !("preferred_date" in out)) {
    if (toolName === "create_appointment") {
      out.scheduled_date = out.date;
    } else {
      out.preferred_date = out.date;
    }
    delete out.date;
  }
  return out;
}

export { normalizeForTool };
