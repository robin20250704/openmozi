// agents/yuanyi/tools/query-sku.js
//
// query_sku：元器件型号/参数检索（元一电子）。
//
// 为什么这个工具是本期第一个：电子元器件客服的入口动作就是"客户给个型号或参数，
// 我要找到对应 SKU"。找不到型号 → 后面报价/交期全无从谈起（D17 已确认 SKU 上万）。
//
// P4 口径：确定性打分检索（完全/前缀/包含/关键词/描述），结果里带 match.why，
// 让模型能如实告诉客户"我按什么匹配到的"，而不是含糊其辞。
import { searchSku } from "../lib/business-client.js";

export const querySkuTool = {
  name: "query_sku",
  label: "查询元器件型号",
  description:
    "按型号或参数检索元器件 SKU（泰科/TE 连接器、Hirose 等同轴件等）。" +
    "参数：query 为型号（如 1-1734592-2、1734592）或参数描述（如 2.54mm 双排 20pin）。" +
    "返回型号/品牌/描述/基准价/最小起订量/包装倍数/现货/交期。找不到时返回空列表，不要臆造型号。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "型号或参数关键词（客户原话可直接传入）" },
      limit: { type: "number", description: "返回条数上限，默认 5" },
    },
    required: ["query"],
  },
  // V-004：pi 工具签名是 4 参（toolCallId, params, signal, onUpdate）
  async execute(_toolCallId, params) {
    const query = String(params?.query ?? "").trim();
    if (!query) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: "query 不能为空" }) }],
        isError: true,
      };
    }
    try {
      const res = await searchSku(query, Number(params?.limit) || 5);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message, hint: "检索服务不可用时如实告知客户稍后确认，不要凭记忆报价" }) }],
        isError: true,
      };
    }
  },
};
