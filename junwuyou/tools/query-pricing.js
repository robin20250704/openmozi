// tools/query-pricing.js — query_pricing Tool
// 委托给 scheduler（HTTP）— L-022 统一数据访问入口
//
// 需求 4：报价必须是"住宅/商户 + 面积"三个维度都传对，否则会报错价。
// 事故证据（QQ 真实对话）：客户 200㎡ 住宅杀白蚁，报 99 元。
// 权威定价源 sales_agent/pricing.json 里有「住宅超出 140㎡ 住宅加收 30 元」，
// 但调度器 engine.rs 对**固定价商品提前 return**，加收规则永不生效；
// 且 query_pricing 根本没有"住宅/商户"入参，>140㎡ 的住宅会被直接报成商户价。
import { queryPricing } from "../lib/scheduler-client.js";

export const queryPricingTool = {
  name: "query_pricing",
  description:
    "根据面积、虫害类型和**客户类型**查询套餐价格。返回 package_name / price / base_price / area_surcharge。" +
    "customer_type 必须按客户实际情况传：小区住户传 住宅，公司/餐厅/商铺传 商户。" +
    "报价时必须把 price 原样告诉客户；若 area_surcharge 大于 0，要一并说明是超出面积加收。禁止自己编价格或估算。",
  parameters: {
    type: "object",
    properties: {
      area_sqm: { type: "number", description: "房屋面积（平方米）" },
      pest_type: { type: "string", description: "虫害类型（蟑螂/老鼠/甲醛/蚊蝇白蚁等）" },
      customer_type: {
        type: "string",
        enum: ["住宅", "商户"],
        description: "客户类型：小区住户=住宅；公司/餐厅/商铺=商户。客户已说明是哪种就按实际传，不要默认。",
      },
    },
    required: ["area_sqm", "pest_type"],
  },
  execute: async (_toolCallId, params) => {
    const customerType = params.customer_type || "住宅";
    console.log(`[tool query_pricing] execute start: ${JSON.stringify({ ...params, customer_type: customerType })}`);
    try {
      const res = await queryPricing(params.area_sqm, params.pest_type || "蟑螂", customerType);
      const base = Number(res?.base_price ?? res?.price ?? 0);
      const surcharge = Number(res?.area_surcharge ?? 0);
      const out = {
        ...res,
        customer_type: res?.customer_type || customerType,
        quote_note:
          surcharge > 0
            ? `报价 ${res.price} 元 = 套餐价 ${base} 元 + 超出面积加收 ${surcharge} 元。要告诉客户这两部分，不要只报总价。`
            : `报价 ${res.price} 元。`,
      };
      console.log(`[tool query_pricing] execute ok: ${JSON.stringify(out).slice(0, 250)}`);
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    } catch (e) {
      console.log(`[tool query_pricing] execute FAIL: ${e.message}`);
      throw e;
    }
  },
};
