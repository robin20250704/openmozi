// agents/yuanyi/tools/search-faq.js
//
// search_faq：元一电子常见问题（起订量/交期/正品/开票/替代料）。
//
// 为什么单列一个 FAQ 工具而不是并进 query_sku：这两类问题的**事实源不同**
// （SKU 库 vs 服务政策），混在一起会让模型把"政策口径"当"型号数据"编。
import { searchFaq } from "../lib/business-client.js";

export const searchFaqTool = {
  name: "search_faq",
  label: "查询服务常见问题",
  description:
    "检索元一电子的服务政策类问答（最小起订量、交期、是否原厂正品、开票与付款、替代型号等）。" +
    "参数 query 为客户问题的关键词。命中为空时**不得凭记忆回答具体承诺**（账期/折扣/赔付），应转人工。",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "客户问题关键词" } },
    required: ["query"],
  },
  async execute(_toolCallId, params) {
    const query = String(params?.query ?? "").trim();
    if (!query) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "query 不能为空" }) }], isError: true };
    }
    try {
      const res = await searchFaq(query);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }],
        isError: true,
      };
    }
  },
};
