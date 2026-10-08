// agents/tiangong/tools/plm-faq-propose.js
//
// plm_faq_propose：把"这轮客户问的东西"记成一条 **FAQ 候选**，进 53112 的候选台账。
//
// 为什么需要它（用户 2026-09-28：skill 要增加自己归类总结客户常见、类似问题形成 FAQ 清单的循环）：
//   faq.json 是**人工维护**的知识库。小天每轮都在产出新事实（客户到底在问什么），
//   但这些事实没有出口——写文件工具已被用户禁用（只读），改知识库又不该由它做。
//   于是把"归纳成 FAQ"这件事拆成两半：
//     小天能做的：记**发生过什么**（问法原文 + 归类 + 这轮答了什么要点）——可判定、可追溯。
//     人来做的：核对后并入 faq.json——需要判断"这条该不该成为对外口径"。
//   阈值（同一归类攒够 N 种不同问法，默认 3）是这两半之间的闸门：不到阈值不动，达阈值出**草稿**给人看。
//
// 硬约束（不接受参数放宽，这是本工具存在的全部意义）：
//   ① 只能追加一条记录，没有"修改/删除/覆盖"任何参数；
//   ② 碰不到 faq.json：候选台账是另一个文件（faq-candidates.jsonl），后端只写它；
//   ③ 不记提问人身份：没有 user 参数，后端也不收——归类靠问题本身。
//
// 用错它比不用它更糟，所以调用纪律也写在这里：
//   - 只在**答客线且答的是 PLM 事实**时记；寒暄、"你们怎么收费"、"谢谢"不记。
//   - question 用**客户原话**（可去掉"你好""谢谢"这类壳），不要改写成"规范问法"——
//     改写之后聚类就失真了，而聚类正是这个工具存在的理由。
//   - category 用**知识库已有的分类**（plm_faq_search 返回的 category，如 流程与状态/数据与字段/
//     界面与页面/登录与身份/权限与治理/术语与对象/故障与排查/导出与下载）；实在没有现成类才新起一个，
//     此后始终用同一个词——靠现编同义类目能把任何数据聚成零散一堆，这是它最典型的失败形态。
//   - answerPoints 写**这轮实际答出的要点**，1–6 条；没答出实质内容就别记（后端会拒）。
import { proposeFaqCandidate } from "../lib/business-client.js";

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: "text", text: JSON.stringify({ ok: false, error: msg }) }], isError: true });

export const plmFaqProposeTool = {
  name: "plm_faq_propose",
  label: "记一条 FAQ 候选",
  description:
    "把这一轮客户问的问题记成一条 FAQ 候选（答客线的沉淀动作，每轮最多一条）。" +
    "记录内容只有三样：客户原话 question、稳定的归类 category（优先沿用知识库已有分类，如 流程与状态 / " +
    "数据与字段 / 界面与页面 / 登录与身份 / 权限与治理 / 术语与对象 / 故障与排查 / 导出与下载；" +
    "实在没有现成类才新起一个，此后始终用同一个词）、这轮实际答出的要点 answerPoints（1–6 条）。" +
    "它**只能追加一条**，不会修改知识库；同一归类攒够阈值（默认 3 种不同问法）时返回里会带一份 FAQ 草稿，" +
    "供人工核对后并入知识库——不要自行声称『已经写进知识库』。" +
    "只在客户问到 PLM 业务事实、且你确实答出了内容时调用；寒暄、闲聊、没答上来的一律不记。" +
    "同一轮不要重复调用；同一问题连续被问到照记——台账是事件流，但同一问法不占过闸额度，"
    + "过闸看的是**问法种类**（重复问法的证据力在于它被反复问到，不会被当成多种问法）。",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "客户原话（去掉寒暄壳即可，不要改写成规范问法；≤200 字）" },
      category: { type: "string", description: "稳定的业务归类，≤40 字；同一类必须始终用同一个词" },
      answerPoints: {
        type: "array",
        description: "这轮实际答出的要点，1–6 条，每条 ≤200 字",
        items: { type: "string" },
      },
    },
    required: ["question", "category", "answerPoints"],
  },
  async execute(_toolCallId, params) {
    const question = String(params?.question ?? "").trim();
    const category = String(params?.category ?? "").trim();
    const answerPoints = (Array.isArray(params?.answerPoints) ? params.answerPoints : [])
      .map((p) => String(p).trim())
      .filter(Boolean);

    // 前置校验放在工具侧，是为了给出**可照着改**的错误；后端仍会独立校验一遍（不信任调用方）。
    if (!question) return fail("question 不能为空：写客户这轮的原话");
    if (!category) return fail("category 不能为空：聚类只靠它；用业务归类（如 变更流程），不要用随机措辞");
    if (answerPoints.length === 0) return fail("answerPoints 至少 1 条：写这轮你实际答了什么；没答出内容就不该记这条");
    if (answerPoints.length > 6) return fail("answerPoints 最多 6 条：合并同义要点后再记");

    try {
      const r = await proposeFaqCandidate({ question, category, answerPoints });
      return ok({ ok: true, category_status: r.category_status, next: r.next, ledger: r.ledger });
    } catch (e) {
      // 台账记不上必须让小天知道：答客话术不能因此中断，所以这里返回 isError 但信息明确，
      // 小天只需在心里记下"这轮没沉淀"，不需要向客户解释（客户不需要为台账故障买单）。
      return fail(`候选没记上：${e.message}。照常回答客户；这轮不算沉淀，不要向客户报错。`);
    }
  },
};