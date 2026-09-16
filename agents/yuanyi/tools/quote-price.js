// agents/yuanyi/tools/quote-price.js
//
// quote_price：报价（元一电子）。
//
// 铁律（V-010 / V-014）：**算价在服务端做，模型只复述**。
// 本工具不自己做任何乘法/折扣/取整——它把参数交给业务后端的报价引擎（唯一实现），
// 把返回的 unit_price/total_price/basis/warnings 原样交给模型。理由：
//   · 模型是"自然语言 ↔ 参数"的转写者，任何让它算/换算的环节都是漂移源（L-067/L-068）；
//   · 报价策略有优先级与叠加规则，散落到 prompt 或工具里必然两处不一致。
import { quotePrice } from "../lib/business-client.js";

export const quotePriceTool = {
  name: "quote_price",
  label: "查询报价",
  description:
    "按型号 + 数量（+ 客户等级）查询价格。参数：part_no 型号（如 1-1734592-2）或 query 检索词；" +
    "qty 数量（必填，整数）；customer_level 客户等级 A/B/C（默认 C = 散单）。" +
    "**只复述返回的 unit_price/total_price 与 basis**，禁止自己加减乘除或估算；" +
    "warnings 里的提示（低于最小起订量 / 不是包装倍数 / 现货不足）必须如实告知客户。" +
    "strategy_coverage 说明本次报价已计入与未计入的策略条款，不得省略'未计入'部分。",
  parameters: {
    type: "object",
    properties: {
      part_no: { type: "string", description: "型号（优先用 query_sku 得到的完整型号）" },
      query: { type: "string", description: "型号不确定时可给检索词，由服务端匹配" },
      qty: { type: "number", description: "采购数量（整数）" },
      customer_level: { type: "string", description: "客户等级 A / B / C，默认 C" },
    },
    required: ["qty"],
  },
  async execute(_toolCallId, params) {
    const qty = Number(params?.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: "qty 必须是正整数", hint: "缺数量时先问客户要多少 pcs，不要猜" }) }],
        isError: true,
      };
    }
    if (!params?.part_no && !params?.query) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: "需要 part_no 或 query", hint: "先用 query_sku 定位型号" }) }],
        isError: true,
      };
    }
    try {
      const res = await quotePrice({
        partNo: params?.part_no ? String(params.part_no) : undefined,
        query: params?.query ? String(params.query) : undefined,
        qty,
        customerLevel: params?.customer_level ? String(params.customer_level).toUpperCase() : "C",
      });
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message, hint: "报价服务不可用时如实告知客户稍后确认，绝不凭记忆给价" }) }],
        isError: true,
      };
    }
  },
};
