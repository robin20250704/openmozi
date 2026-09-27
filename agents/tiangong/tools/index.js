// agents/tiangong/tools/index.js
//
// 天工 PLM 客服的工具集入口（本批最小形态）。
//
// 本批 3 个工具的目的**不是**做完 PLM 客服，而是：
//   ① 证明第三个 agent 有自己的工具集（与 junwuyou / yuanyi 零交集 → 工具隔离断言 A4 可判定）；
//   ② 证明工具的数据来自**自己的**后端（53112）而不是君无忧（53000/35801）或元一（53100）；
//   ③ 证明需求 4 的身份头链路端到端可达（plm_whoami 是那条链路的观测面）。
//
// 动态 import（L-042）：这些模块读 env（TIANGONG_API_URL 等），必须等 launcher 注入 env 后再加载。

export const tools = [
  (await import("./plm-faq-search.js")).plmFaqSearchTool,
  (await import("./plm-get-current-time.js")).plmGetCurrentTimeTool,
  (await import("./plm-whoami.js")).plmWhoamiTool,
];

export default { tools };
