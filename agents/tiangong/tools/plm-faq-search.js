// agents/tiangong/tools/plm-faq-search.js
//
// plm_faq_search：天工 PLM 知识库检索（流程/字段/单据/术语/权限/快捷键）。
//
// 为什么单列一个知识库工具：事实源唯一（知识库 json），模型只复述不编造。
// 返回里带 confidence 与 note，让模型自己判断"能不能据此回答"（与君无忧 faq_search 同口径）。
import { searchFaq } from "../lib/business-client.js";
import { getSenderLabel } from "../lib/request-context.js";

export const plmFaqSearchTool = {
  name: "plm_faq_search",
  label: "检索 PLM 知识库",
  description:
    "检索天工 PLM 系统的知识库（业务流程、页面与字段、单据类型、术语缩写、权限与角色、快捷键、常见报错）。" +
    "凡涉及 PLM 的具体事实（字段名、状态流转、步骤、单据编号规则）**必须**先调本工具，禁止凭记忆回答。" +
    "命中为空或 confidence=none 时不得编造，应如实说明未收录并建议转对应模块负责人。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "用户问题的关键词或原句（可直接传客户原话）" },
      limit: { type: "number", description: "返回条数，缺省 3" },
    },
    required: ["query"],
  },
  async execute(_toolCallId, params) {
    const query = String(params?.query ?? "").trim();
    if (!query) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "query 不能为空" }) }], isError: true };
    }
    const limit = Number.isFinite(Number(params?.limit)) ? Number(params.limit) : 3;
    try {
      const res = await searchFaq(query, limit);
      // 提问者身份一并回给模型：知识库答案可能因角色不同而不同（权限类问题），
      // 让模型知道"谁在问"才能给出对的答案，也避免它向用户索要已提供的身份。
      return { content: [{ type: "text", text: JSON.stringify({ ...res, asker: getSenderLabel() }) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }],
        isError: true,
      };
    }
  },
};
