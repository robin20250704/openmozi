// tools/faq-search.js — faq_search Tool（5级混合检索）
// 严格按 faq-search-design.md 设计
import { faqSearch } from "../lib/faq-search-engine.js";

export const faqSearchTool = {
  name: "faq_search",
  description: "搜索 FAQ 知识库。返回 question/answer/score/ai_should_handle/matched_layer。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "用户问题文本" },
      top_k: { type: "integer", description: "返回 top-K（1-10，默认 3）", default: 3, minimum: 1, maximum: 10 },
    },
    required: ["query"],
  },
  execute: async (_toolCallId, params) => {
    // 审计日志：记录召回结果，便于区分"知识库没召回"与"召回了但模型没用"（L-047）
    const t0 = Date.now();
    console.log(`[faq_search] start query="${params.query}" top_k=${params.top_k || 3}`);
    try {
      const res = await faqSearch(params.query, params.top_k || 3);
      const ids = res.hits.map((h) => `${h.id}(${Number(h.score).toFixed(3)})`).join(", ");
      console.log(
        `[faq_search] ok ${Date.now() - t0}ms layer=${res.matched_layer} hits=[${ids}] degraded=${JSON.stringify(res.degraded)}`
      );
      for (const h of res.hits) {
        console.log(`[faq_search]   #${h.id} ${h.question} → ${String(h.answer).slice(0, 60)}`);
      }
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    } catch (e) {
      console.error(`[faq_search] FAIL ${Date.now() - t0}ms: ${e.message}`);
      throw e;
    }
  },
};
