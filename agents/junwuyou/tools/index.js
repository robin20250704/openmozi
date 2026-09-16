// agents/junwuyou/tools/index.js
//
// 君无忧业务工具集的**唯一入口**（P4 多 agent 装配约定：导出 { tools: AgentTool[] }）。
//
// 为什么要有这个入口：升级前 launcher 里硬编码了 11 个 `await import(...)`，
// 再接第二个商户就得复制一遍这段清单——新增 agent 的成本从"加一个目录"变成"改框架代码"。
// 现在装配器只读描述符的 `toolsModule`，每个 agent 自己声明自己的工具集（V-014 单一事实源）。
//
// 注意：这些工具模块读 env（scheduler-client 的 BASE 等），**必须动态 import**——
// 静态 import 会被提升到 loadDotenv() 之前执行，模块级常量当场定死为 undefined（L-042）。

export const tools = [
  (await import("./faq-search.js")).faqSearchTool,
  (await import("./query-pricing.js")).queryPricingTool,
  (await import("./propose-slots.js")).proposeSlotsTool,
  (await import("./create-appointment.js")).createAppointmentTool,
  (await import("./cancel-appointment.js")).cancelAppointmentTool,
  (await import("./get-customer-appointments.js")).getCustomerAppointmentsTool,
  (await import("./query-customer-profile.js")).queryCustomerProfileTool,
  (await import("./update-collected-info.js")).updateCollectedInfoTool,
  (await import("./request-admin-approval.js")).requestAdminApprovalTool,
  (await import("./confirm-order-details.js")).confirmOrderDetailsTool,
  (await import("./get-current-time.js")).getCurrentTimeTool,
];

export default { tools };
