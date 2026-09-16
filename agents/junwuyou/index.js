// junwuyou/index.js — 主入口：注册所有 Tool + Plugin
// OpenMozi 通过 definePlugin(meta, (api) => {...}) 加载
//
// 注册顺序：
// 1. faq_search（首选）
// 2. 业务 Tool（query_pricing/propose_slots/create_appointment/...）
// 3. router Plugin（红线转人工）
// 4. audit Plugin（审计脱敏）

import { queryPricingTool } from "./tools/query-pricing.js";
import { proposeSlotsTool } from "./tools/propose-slots.js";
import { createAppointmentTool } from "./tools/create-appointment.js";
import { cancelAppointmentTool } from "./tools/cancel-appointment.js";
import { getCustomerAppointmentsTool } from "./tools/get-customer-appointments.js";
import { queryCustomerProfileTool } from "./tools/query-customer-profile.js";
import { updateCollectedInfoTool } from "./tools/update-collected-info.js";
import { faqSearchTool } from "./tools/faq-search.js";
import { requestAdminApprovalTool } from "./tools/request-admin-approval.js";

import { registerRouter } from "./plugins/router.js";
import { registerAudit } from "./plugins/audit.js";

export const PLUGIN_META = {
  id: "junwuyou",
  name: "君无忧 AI 客服",
  version: "1.0.0",
  description: "君无忧消杀服务多渠道 AI 客服：FAQ 5 级智能搜索 + 订单/排程/红线 + 全量审计",
};

export function register(api) {
  // 业务 Tool（faq_search 放最前）
  api.registerTools([
    faqSearchTool,
    queryPricingTool,
    proposeSlotsTool,
    createAppointmentTool,
    cancelAppointmentTool,
    getCustomerAppointmentsTool,
    queryCustomerProfileTool,
    updateCollectedInfoTool,
    requestAdminApprovalTool,
  ]);

  // Hooks
  registerRouter(api);
  registerAudit(api);

  console.log(`[junwuyou] plugin registered: ${PLUGIN_META.name} v${PLUGIN_META.version}`);
  console.log(`[junwuyou] tools: ${[faqSearchTool, queryPricingTool, proposeSlotsTool, createAppointmentTool, cancelAppointmentTool, getCustomerAppointmentsTool, queryCustomerProfileTool, updateCollectedInfoTool, requestAdminApprovalTool].map(t => t.name).join(", ")}`);
  console.log(`[junwuyou] hooks: router + audit`);
}

// OpenMozi 插件加载器期望 default export 是函数或 {meta, ...} 对象
// 见 ref/openmozi/src/plugins/loader.ts::moduleToDefinition
export default register;

