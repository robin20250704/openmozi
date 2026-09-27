// agents/tiangong/tools/plm-requirements.js
//
// 需求填写工具族（小天用）：把 PLM 登记器官 `references/tools/plm-req.cjs` 的子命令
// 暴露成**一个个单一职责的工具**，而不是"一个 shell 工具让模型自己拼命令行"。
//
// 为什么拆成多工具而不是给一个 shell：
//   · 用户明确要求"去掉写代码工具、只能用需求填写工具" —— 给 shell 等于把任意命令还回去了；
//   · 单职责工具的参数是**结构化**的（title/content/threshold…），不需要模型学引号转义，
//     也不会出现"参数拼错却看起来像 PLM 拒了"的误判（这类误判在 §失败处置 里占了一整行）；
//   · 危险参数（`--allow-duplicate`）必须由模型**显式**表达，工具层不允许默认放开。
//
// 唯一会改动 PLM 数据的工具是 plm_submit_requirement（POST 一条 PROPOSED 需求）。
// 它默认 **dry-run**：模型必须先看一遍请求体，再显式 submit=true 才真写。
// 这是"不可逆副作用边界"（登记不可回退，只能作废）在工具层的体现 —— 不是可调参数。
import fs from "node:fs";
import path from "node:path";
import { AGENT_DIR, runPlmCli, toToolResult } from "../lib/plm-cli.js";

/**
 * exit code → 语义（**必须翻译，不能让模型自己猜**）。
 * `plm-req.cjs` 自己定义了这套码：0 成功 / 1 失败 / 2 用法错 / 3 有疑似重复。
 * 关键判断：**3 不是失败** —— 它是"查重命中"这个业务结论，把它标成 isError 会让模型
 * 以为工具坏了，从而放弃查重结论（这正是"重复编号污染台账"的入口）。
 */
function exitSemantics(exitCode) {
  return ({
    0: "ok",
    1: "failed",
    2: "usage_error",
    3: "duplicates_found（查重命中，这是业务结论不是故障；按三条出路处置）",
  })[exitCode] ?? `unknown_exit_${exitCode}`;
}

/** 统一的工具返回封装 */
function reply(r, opts) {
  const { payload, raw } = toToolResult(r, opts);
  const withSemantics = { ...payload, exit_semantics: exitSemantics(r.exitCode) };
  return {
    content: [{ type: "text", text: `${JSON.stringify(withSemantics, null, 2)}\n\n--- 原始输出 ---\n${raw}` }],
    isError: !r.ok && r.exitCode !== 3,
  };
}
function failed(msg) {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: msg }) }], isError: true };
}

// ── 只读：环境自检 ───────────────────────────────────────────────
export const plmCheckEnvTool = {
  name: "plm_check_env",
  label: "PLM 环境自检",
  description:
    "PLM 环境自检：凭据是否就位、PLM 是否可达、SSO 能否登录、有没有 requirement.create 权限、项目与分类是否可用、词表是否与服务端一致。" +
    "**排障第一命令**：任何 PLM 相关操作失败（登录失败/权限不足/登记被拒）之前或之后，先跑它，看是哪一段红。" +
    "注意：它会在需要时起一个专用 headless 浏览器做真实 SSO 登录（首次约 20-60 秒，之后走 token 缓存/refresh，不再起浏览器）。",
  parameters: { type: "object", properties: {} },
  async execute() {
    // 首次可能需要起浏览器登录：给足超时（工具默认 180s，这里放宽）
    return reply(await runPlmCli("check", [], { timeoutMs: 300_000 }));
  },
};

// ── 只读：当前身份 ──────────────────────────────────────────────
export const plmWhoamiPlmTool = {
  name: "plm_whoami_plm",
  label: "PLM 当前身份与角色",
  description:
    "打印**当前登录 PLM 的身份与角色**（不重新登录，读 token 缓存）。答复任何权限类问题（403/看不到按钮/超授权范围）之前先看它。" +
    "注意区别于 plm_whoami：那个是**网页访客**在本客服系统里的身份，这个是**小天登录 PLM 系统的账号**。",
  parameters: { type: "object", properties: {} },
  async execute() {
    // --ensure：缓存为空/过期时自动走 refresh 或完整 SSO（`plm-req.cjs whoami --ensure`）。
    // 不加它的话，重启后第一次问身份会拿到"无令牌缓存"这种对用户毫无意义的回答。
    return reply(await runPlmCli("whoami", ["--ensure"], { timeoutMs: 300_000 }));
  },
};

// ── 只读：项目 / 分类 / 列表 / 单条 / 台账 ────────────────────────
export const plmListProjectsTool = {
  name: "plm_list_projects",
  label: "列 PLM 项目",
  description: "列出 PLM 项目（选 projectId 用）。天工的需求必须挂项目 87（PRJ-2026-0087 天工AI PLM 1.0）；不挂项目的需求后续无法批准。",
  parameters: {
    type: "object",
    properties: { keyword: { type: "string", description: "按名称筛选，如 PLM" } },
  },
  async execute(_id, params) {
    const kw = String(params?.keyword ?? "").trim();
    return reply(await runPlmCli("projects", kw ? ["--keyword", kw] : []));
  },
};

export const plmListClassesTool = {
  name: "plm_list_classes",
  label: "列需求分类",
  description: "列出 PLM 需求分类（1 功能 / 2 性能 / 3 安全 / 4 可靠性 / 5 准入法规 / 6 可用性 / 7 可制造可供应 / 8 可测试性 / 9 成本），登记时用 reqClassId。",
  parameters: { type: "object", properties: {} },
  async execute() {
    return reply(await runPlmCli("classes", []));
  },
};

export const plmListRequirementsTool = {
  name: "plm_list_requirements",
  label: "检索 PLM 需求",
  description: "按项目/状态/关键词检索 PLM 需求（查重辅助、看趋势）。返回里能看到编号（REQ-YYYY-NNNN）与状态，用它判断「这个痛点是不是已经有人提过」。",
  parameters: {
    type: "object",
    properties: {
      project: { type: "number", description: "项目 id（天工恒为 87）" },
      status: { type: "string", description: "状态过滤，如 PROPOSED / ANALYZED / APPROVED / IMPLEMENTED" },
      keyword: { type: "string", description: "关键词（服务端收窄）" },
      page_size: { type: "number", description: "每页条数，缺省 20" },
    },
  },
  async execute(_id, params) {
    const args = [];
    if (params?.project) args.push("--project", String(params.project));
    if (params?.status) args.push("--status", String(params.status));
    if (params?.keyword) args.push("--keyword", String(params.keyword));
    if (params?.page_size) args.push("--page-size", String(params.page_size));
    return reply(await runPlmCli("list", args, { timeoutMs: 120_000 }));
  },
};

export const plmGetRequirementTool = {
  name: "plm_get_requirement",
  label: "读单条 PLM 需求",
  description:
    "读一条 PLM 需求的详情（传编号 REQ-YYYY-NNNN 或数字 id）。`flow=true` 返回 9 段流程阶段（下一步是谁），`history=true` 返回审计历史。" +
    "**回访与「下一步是谁」的权威口径**：答复用户进展前必须用它，不许凭记忆。",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "需求编号 REQ-YYYY-NNNN 或数字 id" },
      flow: { type: "boolean", description: "是否返回流程阶段" },
      history: { type: "boolean", description: "是否返回审计历史" },
    },
    required: ["id"],
  },
  async execute(_id, params) {
    const id = String(params?.id ?? "").trim();
    if (!id) return failed("id 必填（REQ-YYYY-NNNN 或数字 id）");
    const args = [id];
    if (params?.flow) args.push("--flow");
    if (params?.history) args.push("--history");
    return reply(await runPlmCli("get", args, { timeoutMs: 120_000 }));
  },
};

export const plmTrackRequirementsTool = {
  name: "plm_track_requirements",
  label: "台账回读与对账",
  description:
    "按本地登记台账逐条回读 PLM 运行态，打印「登记时状态 vs 现在状态」的漂移与下一步。**L2 对账命令**：定期跑、以及用户问「我提的那些需求怎么样了」时跑。" +
    "报出不一致时必须据实说明（台账是查重与回访的地基，地基漂了后面每一步都错）。",
  parameters: { type: "object", properties: {} },
  async execute() {
    return reply(await runPlmCli("track", [], { timeoutMs: 180_000 }), { maxChars: 6000 });
  },
};

// ── 登记前查重 ──────────────────────────────────────────────────
export const plmDedupRequirementTool = {
  name: "plm_dedup_requirement",
  label: "登记前查重",
  description:
    "登记**之前必做**的查重：服务端关键词收窄 + 本地加权 Jaccard 相似度，命中疑似重复会返回候选清单（退出码 3 表示有疑似重复）。" +
    "为什么必须做：PLM 的需求表**没有标题唯一约束**，不查重就会真建两条，重复编号会稀释 backlog。" +
    "命中后的三条出路（按优先级）：① 补证据到既有条目（推荐）；② 确认是不同痛点 ⇒ 把差异写显式并显式要求覆盖；③ 对既有条目的订正 ⇒ 建 supersedes 追溯。",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "需求标题" },
      content: { type: "string", description: "需求正文（越长越准）" },
      project: { type: "number", description: "项目 id（天工恒为 87）" },
      threshold: { type: "number", description: "相似度阈值，缺省 0.55（越小越敏感）" },
    },
    required: ["title"],
  },
  async execute(_id, params) {
    const title = String(params?.title ?? "").trim();
    if (!title) return failed("title 必填");
    const args = ["--title", title];
    if (params?.content) args.push("--content", String(params.content));
    if (params?.project) args.push("--project", String(params.project));
    if (params?.threshold) args.push("--threshold", String(params.threshold));
    return reply(await runPlmCli("dedup", args, { timeoutMs: 120_000 }));
  },
};

// ── 登记（两步纪律：先 dry-run，再 submit=true）────────────────────
export const plmSubmitRequirementTool = {
  name: "plm_submit_requirement",
  label: "登记需求到 PLM（先 dry-run）",
  description:
    "把需求登记进 PLM（项目 87），**唯一会改动 PLM 数据的工具**。默认行为是 **dry-run：不落库**，只打印将要提交的请求体与「阶段约束剥离清单」。\n" +
    "两步纪律（硬）：先 dry_run（默认）看一遍 body → 确认无误后再以 submit=true 真提交。\n" +
    "调用前必须已经过：分诊（不是已知偏差）→ 查重（plm_dedup_requirement 无命中）→ 质量门四判据（现象可复现/影响可描述/期望可验收/证据可指认）。\n" +
    "字段纪律（服务端会 400，工具也会本地拦）：`priority`/`dfxDimension`/`verifyMethod`/`appealsDim`/`userPersona`/`solution` 属「分析后才可填」，**不要写进 draft**，写进正文的「分析输入」段；`paramValue`/`paramUom`/`verification` 是死锁区，量化期望写进正文【量化期望】段。\n" +
    "`allow_duplicate=true` 只在「确认是不同痛点、已使差异显式」时才用；它会绕过查重门，滥用等于架空查重。",
  parameters: {
    type: "object",
    properties: {
      draft: {
        type: "object",
        description: "需求草稿（形状见 references/templates/requirement-draft-template.json 与 kb/plm-requirement-intake-schema.md）。常用字段：title、content、reqType（UR/SR/REG/RC/DFX/COST/MKT/DSVC/SRV2）、reqClassId（1..9）、sourceType（MARKET/STANDARD/RISK/CAPA/CLINICAL/OTHER/PLM_SELF/REGULATION）、projectId（87）、parentId、stdClause、paramName",
      },
      submit: { type: "boolean", description: "false/缺省 = dry-run 不落库；true = 想真提交（**还必须同时给 user_confirmed=true**，见下）" },
      user_confirmed: {
        type: "boolean",
        description:
          "用户是否已明确同意登记（默认 false）。**必须已经在对话里把草稿念给用户（标题+现象/影响/期望+影响面）并得到明确同意**，才可以传 true。" +
          "未传 true 时无论 submit 传什么，工具都只跑 dry-run、不落库、不返回编号。",
      },
      allow_duplicate: { type: "boolean", description: "绕过查重门（默认 false）。仅在确认是不同痛点且已使差异显式时使用" },
      threshold: { type: "number", description: "本次提交内查重的相似度阈值，缺省 0.55" },
    },
    required: ["draft"],
  },
  async execute(_id, params) {
    const draft = params?.draft;
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) return failed("draft 必须是对象");
    // ── 落库前的"用户已确认"闸门（2026-09-27 实测后加，理由见下）──
    // 实测：模型在只跑过 dry-run、**用户从未确认过**的情况下，直接以 submit=true 连调三次，
    // 结果真在项目 87 建了一条需求（REQ-2026-3231）。内容是合格的，但**流程不合格** ——
    // 用户还没看到"将要提交什么"就落库了，而登记不可逆。
    // 所以把"必须先在对话里把草稿念给用户、并拿到明确同意"做成**工具层闸门**：
    // 没带 user_confirmed=true 时，无论 submit 传什么，一律只返回 dry-run —— 模型拿不到编号，
    // 也就不会对用户宣称"已登记"；它只能回到对话里先问一句。
    // 注意：这不是防恶意（模型可以自己传 true），而是防止**默认路径**滑向"未经确认就落库"。
    const confirmed = params?.user_confirmed === true;
    const wantSubmit = params?.submit === true && confirmed;
    const dir = path.join(AGENT_DIR, ".cache", "drafts");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `draft-${Date.now()}.json`);
    try {
      fs.writeFileSync(file, JSON.stringify(draft, null, 2), "utf8");
      const args = ["-f", file];
      if (!wantSubmit) args.push("--dry-run");
      if (params?.allow_duplicate === true) args.push("--allow-duplicate");
      if (params?.threshold) args.push("--threshold", String(params.threshold));
      const r = await runPlmCli("submit", args, { timeoutMs: 240_000 });
      const wrapped = reply(r, { maxChars: 6000 });
      if (wantSubmit) return wrapped;
      wrapped.content[0].text +=
        (params?.submit === true && !confirmed
          ? "\n\n【未落库·缺少用户确认】submit=true 但没有 user_confirmed=true：**只跑了 dry-run**。把上面这段请求体念给用户（标题 + 现象/影响/期望 + 影响面），拿到明确同意后再带 user_confirmed=true 调一次。不要对用户说「已登记」——你现在拿不到编号。"
          : "\n\n【提示】以上是 dry-run 结果，**尚未落库**。把请求体核对清楚、并与用户确认（拿到明确同意）后，再用 submit=true + user_confirmed=true 真提交。");
      return wrapped;
    } finally {
      // 草稿文件是中间产物：登记/试跑结束即删（含用户原话，不留痕）
      try { fs.unlinkSync(file); } catch { /* 已删或不存在 */ }
    }
  },
};
