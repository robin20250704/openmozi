// agents/tiangong/tools/index.js
//
// 小天（天工 PLM 客服）的工具集入口。
//
// 工具面按用户 2026-09-27 的要求收紧为三类，**不含任何写文件/写代码工具**：
//   ① 参考资料只读：`plm_read_reference`（路径锁在 references/ 内，永不可写）
//   ② 需求填写族：`plm_check_env` / `plm_whoami_plm` / `plm_list_projects` / `plm_list_classes` /
//      `plm_list_requirements` / `plm_get_requirement` / `plm_dedup_requirement` /
//      `plm_submit_requirement`（唯一会改动 PLM 数据的工具，默认 dry-run）/ `plm_track_requirements`
//   ③ 客服事实与身份观测：`plm_faq_search` / `plm_faq_propose` / `plm_get_current_time` / `plm_whoami`
//
// 唯一新增的写工具 `plm_faq_propose`（2026-09-28，用户要求"自己归类总结客户常见、类似问题形成 FAQ 清单"）：
//   它只往知识库后端的**候选台账**追加一行，既不是文件也不是代码，更碰不到 faq.json。
//   ——"去掉写文件工具"的诉求是"别让客服 agent 自己改事实源"，而不是"任何写入都算违规"。
//   候选台账记的是发生过的事件，FAQ 草稿由人核对后并入，两段之间隔着阈值闸门。
//
// pi 的内置编码工具（read / write / edit / bash / glob / grep / ls…）由装配期的
// `noTools: "builtin"` 关闭（见 runtime.ts）—— 所以"删掉写文件工具"不是靠提示词自律，
// 而是**工具根本没注册**（本文件与描述符 toolset 是唯一的工具来源，A4/A5 断言守着这一点）。
//
// 动态 import（L-042）：这些模块读 env（TIANGONG_API_URL / PLM_* 等），
// 必须等 launcher 注入 env 之后再加载，所以**不能**在文件顶部静态 import。

export const tools = [
  // ① 只读参考资料
  (await import("./plm-read-reference.js")).plmReadReferenceTool,

  // ② 需求填写族（PLM 登记器官）
  (await import("./plm-requirements.js")).plmCheckEnvTool,
  (await import("./plm-requirements.js")).plmWhoamiPlmTool,
  (await import("./plm-requirements.js")).plmListProjectsTool,
  (await import("./plm-requirements.js")).plmListClassesTool,
  (await import("./plm-requirements.js")).plmListRequirementsTool,
  (await import("./plm-requirements.js")).plmGetRequirementTool,
  (await import("./plm-requirements.js")).plmDedupRequirementTool,
  (await import("./plm-requirements.js")).plmSubmitRequirementTool,
  (await import("./plm-requirements.js")).plmTrackRequirementsTool,

  // ③ 客服事实与身份观测
  (await import("./plm-faq-search.js")).plmFaqSearchTool,
  (await import("./plm-faq-propose.js")).plmFaqProposeTool,
  (await import("./plm-get-current-time.js")).plmGetCurrentTimeTool,
  (await import("./plm-whoami.js")).plmWhoamiTool,
];

export default { tools };
