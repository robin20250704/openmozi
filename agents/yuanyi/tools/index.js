// agents/yuanyi/tools/index.js
//
// 元一电子业务工具集入口（P4 最小形态）。
//
// P4 只落 3 个工具，目的**不是**做完电子元器件客服，而是证明：
//   ① 第二个 agent 有自己的工具集（与君无忧零交集 → 工具隔离 A11/A12 可断言）；
//   ② 工具的数据来自**自己的**业务后端（53100）而不是君无忧的（53000/35801）；
//   ③ 型号模糊检索可用（上万 SKU 的第一瓶颈，D17）。
// 报价策略引擎的完整实现（6 类策略的优先级/取整/审批）→ **P5**（spec-p4.md §十）。
//
// 动态 import（L-042）：这些模块读 env（YUANYI_API_URL 等），必须等 launcher 注入 env 后再加载。

export const tools = [
  (await import("./query-sku.js")).querySkuTool,
  (await import("./quote-price.js")).quotePriceTool,
  (await import("./search-faq.js")).searchFaqTool,
];

export default { tools };
