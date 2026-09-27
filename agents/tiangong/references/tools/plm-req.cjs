#!/usr/bin/env node
'use strict';
/**
 * plm-req.cjs · PLM 客服 creature 的**登记器官**（把需求写进 PLM UAT）
 *
 * 用法（工作区根目录执行；口令从 `.env` 读，命令行不回显）：
 *   node plm-req.cjs check                      环境自检（.env / 浏览器 / 登录 / 权限 / 项目 / 分类）
 *   node plm-req.cjs login [--force]            取 token 并打印身份（token 只进缓存，不进 stdout）
 *   node plm-req.cjs whoami                     打印当前 token 的身份与角色（不重新登录）
 *   node plm-req.cjs submit -f draft.json [--dry-run] [--allow-duplicate]
 *   node plm-req.cjs list [--project 87] [--status PROPOSED] [--keyword X] [--page-size 20]
 *   node plm-req.cjs get <id 或 REQ-YYYY-NNNN>  [--flow] [--history]
 *   node plm-req.cjs dedup --title "…" [--content "…"] [--project 87] [--threshold 0.55]
 *   node plm-req.cjs track                      读回自己登记过的条目状态（按本地台账）
 *   node plm-req.cjs projects [--keyword PLM]   列项目（选 projectId 用）
 *   node plm-req.cjs classes                    列需求分类
 *   node plm-req.cjs doctor                     kill 占用 CDP 端口的孤儿浏览器（排障）
 *
 * 设计纪律（为什么这么写）：
 *   · **默认 dry-run 友好**：`submit` 不带 `--dry-run` 才真写；写之前**先查重**，命中相似条目则**拦下**
 *     （除非显式 `--allow-duplicate`）——PLM 的"缺陷一律先查重再登记"是项目硬纪律（X-04）。
 *   · **幂等靠台账**：PLM 创建接口没有幂等键（见 registration-contract.md），同一 draft 的 `fingerprint`
 *     已登记过则拒绝重发（`--allow-duplicate` 可覆盖），杜绝"同一痛点登记成两条编号"。
 *   · **落库即记账**：每次成功登记都追写 `.creature/kb/registration-ledger.md`，让 creature 能 `track` 回来。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  loadConfig, describeConfig, getToken, probeLogin, plmFetch, decodeJwt,
  readSession, killOrphanBrowser, tokenExpiryMs,
} = require('./plm-sso.cjs');

// ------------------------------------------------------------ 小工具

const C = process.stdout.isTTY
  ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[2m', x: '\x1b[0m' }
  : { r: '', g: '', y: '', b: '', d: '', x: '' };
const ok = (m) => console.log(`${C.g}✔${C.x} ${m}`);
const bad = (m) => console.log(`${C.r}✘${C.x} ${m}`);
const warn = (m) => console.log(`${C.y}!${C.x} ${m}`);
const info = (m) => console.log(`${C.b}·${C.x} ${m}`);
const dim = (m) => console.log(`${C.d}${m}${C.x}`);
const out = (o) => console.log(JSON.stringify(o, null, 2));

/**
 * 解析命令行。支持 `--key value` / `--key=value` / `-f value` / 裸 `--flag`（布尔）。
 * 注意 `-f` / `--f` 是**同一个键**（`f`）——历史上这里只认 `--`，导致 `-f draft.json` 静默变成
 * "用法提示"，看起来像命令写错了，其实是解析器不肯认单横线（一次真实误判）。
 */
function parseArgs(argv) {
  const a = { _: [] };
  const isOpt = (t) => t.length > 1 && t[0] === '-' && !/^-\d/.test(t);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!isOpt(t)) { a._.push(t); continue; }
    let body = t.replace(/^-+/, '');
    let inline = null;
    const eq = body.indexOf('=');
    if (eq >= 0) { inline = body.slice(eq + 1); body = body.slice(0, eq); }
    if (inline !== null) { a[body] = inline; continue; }
    const next = argv[i + 1];
    if (next !== undefined && !isOpt(next)) { a[body] = next; i++; } else { a[body] = true; }
  }
  return a;
}

/** 中文/英文混合分词：抽出用于本地相似度比较的"实词"。 */
const STOP = new Set(['的', '了', '和', '与', '在', '是', '有', '我', '你', '他', '这', '那', '个', '我们', '你们', '他们', '需要', '希望', '可以', '不能', '问题', '系统', '功能', '支持', '一个', '进行', '时候', '没有', '就是', '但是', '因为', '所以', '如果', '什么', '怎么', '如何', 'the', 'a', 'an', 'of', 'to', 'and', 'for', 'in', 'on', 'is', 'are']);
function tokens(text) {
  const s = String(text || '').toLowerCase();
  const latin = s.match(/[a-z][a-z0-9_.-]{1,}/g) || [];
  const cjk = s.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  const bi = [];
  for (const run of cjk) {
    for (let i = 0; i < run.length - 1; i++) bi.push(run.slice(i, i + 2));
    if (run.length >= 3) bi.push(run);
  }
  return [...new Set([...latin, ...bi])].filter((t) => !STOP.has(t));
}
/** 加权 Jaccard：标题词权重高（标题相同 = 几乎必然重复）。 */
function similarity(aTitle, aContent, bTitle, bContent) {
  const A = new Map();
  for (const t of tokens(aTitle)) A.set(t, 3);
  for (const t of tokens(aContent)) A.set(t, Math.max(A.get(t) || 0, 1));
  const B = new Map();
  for (const t of tokens(bTitle)) B.set(t, 3);
  for (const t of tokens(bContent)) B.set(t, Math.max(B.get(t) || 0, 1));
  if (!A.size || !B.size) return 0;
  let inter = 0; let union = 0;
  for (const [t, w] of A) { union += w; if (B.has(t)) inter += Math.min(w, B.get(t)); }
  for (const [t, w] of B) if (!A.has(t)) union += w;
  return union ? inter / union : 0;
}

function fingerprint(draft) {
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  return crypto.createHash('sha256').update(norm(draft.title) + '|' + norm((draft.content || '').slice(0, 400))).digest('hex').slice(0, 16);
}

// ------------------------------------------------------------ 台账（登记账本）

/**
 * 台账文件名**必须带 `plm-` 前缀**——这里踩过一次真实缺陷（2026-09-27）：
 * 初版写成 `registration-ledger.md`（无前缀），而 `.creature/kb/` 是**多个 creature 共用的家园**，
 * 交付型实例在这里有自己的同名文件 ⇒ 两条后果同时发生：
 *   ① PLM 客服的登记台账把交付型的台账**挤掉/混在一起**（谁覆盖谁取决于写入顺序，最难查的一类冲突）；
 *   ② 我自己的 `plm-kb.cjs` 检索只认 `plm-` 前缀 ⇒ **自己写的台账自己检索不到**，看起来像"没记账"。
 * 这正是本 skill 反复强调的"跨域污染"在**文件名**层面的版本：**命名前缀是域隔离的第一道物理屏障**，
 * 不是命名风格偏好。
 */
function ledgerPath(cfg) { return path.join(cfg.root, '.creature', 'kb', 'plm-registration-ledger.md'); }

function readLedger(cfg) {
  const p = ledgerPath(cfg);
  if (!fs.existsSync(p)) return [];
  const rows = [];
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('| ') || line.includes('---') || /reqCode/.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 9) continue;
    const [, ts, reqCode, projectId, title, fp, status, by, notes] = cells;
    if (!/^REQ-/.test(reqCode)) continue;
    rows.push({ ts, reqCode, projectId, title, fp, status, by, notes });
  }
  return rows;
}

function appendLedger(cfg, row) {
  const p = ledgerPath(cfg);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, [
      '# 登记台账（registration-ledger）',
      '',
      '> 由 `plm-req.cjs submit` 自动追加；是 creature 的 L2 电容器条目（批量召回：本轮登记了什么、编号是多少）。',
      '> 人工只读；如需修正状态，请改 status 列并注明来源（避免与 PLM 运行态不一致时无从判断谁是对的）。',
      '',
      '| 登记时间 | reqCode | projectId | 标题 | fingerprint | 登记时状态 | 登记人 | 备注 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      '',
    ].join('\n'), 'utf8');
  }
  const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '/').replace(/\r?\n/g, ' ');
  fs.appendFileSync(p, `| ${esc(row.ts)} | ${esc(row.reqCode)} | ${esc(row.projectId)} | ${esc(row.title).slice(0, 80)} | ${esc(row.fp)} | ${esc(row.status)} | ${esc(row.by)} | ${esc(row.notes)} |\n`, 'utf8');
}

// ------------------------------------------------------------ 远端查询

async function fetchAllPages(cfg, apiPath, { pageSize = 100, maxPages = 10, token, log } = {}) {
  const items = [];
  for (let page = 0; page < maxPages; page++) {
    const sep = apiPath.includes('?') ? '&' : '?';
    const r = await plmFetch(cfg, `${apiPath}${sep}page=${page}&pageSize=${pageSize}`, { token, log });
    if (!r.ok) throw new Error(`GET ${apiPath} 失败 http=${r.status} ${String(r.text).slice(0, 200)}`);
    const list = (r.json && (r.json.items || r.json.content)) || [];
    items.push(...list);
    const total = r.json && (r.json.total ?? r.json.totalElements);
    if (!list.length || list.length < pageSize || (total != null && items.length >= total)) break;
  }
  return items;
}

/** 提交前查重：先用服务端 keyword 收窄，再用本地加权相似度精排。 */
async function dedupCheck(cfg, { title, content = '', projectId = null, threshold = 0.55, token, log } = {}) {
  const words = tokens(title).sort((a, b) => b.length - a.length).slice(0, 6);
  const seen = new Map();
  let serverKeywordHits = 0;
  for (const w of words.length ? words : [title.slice(0, 4)]) {
    const q = `/requirements?keyword=${encodeURIComponent(w)}` + (projectId ? `&projectId=${projectId}` : '');
    let list = [];
    try { list = await fetchAllPages(cfg, q, { pageSize: 50, maxPages: 3, token, log }); } catch (e) { log && log(`keyword=${w} 查询失败：${e.message}`); continue; }
    serverKeywordHits += list.length;
    for (const it of list) seen.set(it.id, it);
  }
  const scored = [...seen.values()]
    .map((it) => ({ id: it.id, reqCode: it.reqCode, title: it.title, status: it.status, projectId: it.projectId, createdBy: it.createdBy, sim: similarity(title, content, it.title, it.content || '') }))
    .filter((x) => x.sim > 0.15)
    .sort((a, b) => b.sim - a.sim);
  const hits = scored.filter((x) => x.sim >= threshold);
  return { threshold, serverKeywordHits, candidateCount: scored.length, hits, top: scored.slice(0, 8) };
}

// ------------------------------------------------------------ 草稿 → 请求体

/**
 * <h3>为什么"登记时只写客观描述字段"（本工具最反直觉、也最重要的一条规则）</h3>
 * PLM 把需求字段按**阶段**切成两档，权威是元数据 `t_attr_template.is_post_analysis_only`（V144）：
 *   · **分析前可写**（客观描述）：`title` / `content` / `reqType` / `reqClassId` / `sourceType` /
 *     `stdClause` / `paramName` / `paramValue` / `paramUom` / `parentId` / `projectId`；
 *   · **分析后才可写**（分析结论）：`priority` / `dfxDimension` / `verifyMethod` / `userPersona` /
 *     `userTags` / `solution` / `appealsDim` / `attrs.source_channel`（`sourceChannel` 有豁免，见下）。
 * 新建的需求恒为 `PROPOSED`，服务端 `RequirementService.assertStageAllowsOnCreate` 会对**带了值的**
 * 后一档字段直接抛 `400 REQ_FIELD_STAGE_LOCKED`（源码：`RequirementService.java:407-463`）。
 * 换句话说：**"客服把优先级/DFX 一起填提交"必然 400**——不是权限问题，是阶段约束，且**故意如此**
 * （"谁都能标 P0 等于没有优先级"，分级是分析结论）。
 * 因此本工具把草稿切成两半：
 *   ① `body`（登记就写）——只含分析前字段；
 *   ② `postAnalysis`（登记后移交分析人）——含优先级/DFX/价值维度/验证方法等，**写进需求正文的
 *      「分析输入」段**（正文是分析前可写字段，所以这才是这些结论在**登记那一刻**唯一可靠的落地位置），
 *      同时回显到台账与终端，供分析人进入 ANALYZED 后按需补录。
 * 另有一类字段**连正文都只能"描述"不能"填值"**——量化三件套（见 `CREATE_TIME_DEADLOCK`）：
 *   它的两半规则互相排斥，登记时无解，故本工具**本地硬拒**并给出改道写法。
 * 唯一例外：`sourceChannel`（来源通道）在服务端 `SOURCE_CHANNEL_STAGE_EXEMPT` 白名单里**不锁**
 * （裁定 P0-1-a：分发前必录、发起阶段必须能填）。但本工具**默认仍不写它**——因为一旦写 attrs，
 * 就会触发 `validateIpdAttrs` 对 attrs 的格式校验链；少一个写入面就少一类 400。确需登记来源可
 * 在草稿里显式给 `sourceChannel`（走白名单，安全）。
 */
const REQ_TYPES = ['UR', 'SR', 'REG', 'RC', 'DFX', 'COST', 'MKT', 'DSVC', 'SRV2'];
const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'];
const SOURCE_CHANNELS = ['MARKET', 'CUSTOMER', 'REGULATION', 'COMPETITOR', 'INTERNAL'];
/**
 * `sourceType`（需求来源）与 `sourceChannel`（来源通道）是**两个不同的字段、两套词表**——
 * 这里踩过一次实测坑：初始版本抄了 `sourceChannel` 的五值当 `sourceType` 用，
 * UAT 直接回 `400 ATTR_INVALID REQ.sourceType 非法值: CUSTOMER（合法值: [MARKET/STANDARD/RISK/CAPA/
 * CLINICAL/OTHER/PLM_SELF/REGULATION]）`。
 * 教训：**同一"来源"语义在系统里有两套词表**，本工具按"以服务端为准"写死实测词表（并在 check 里复核）。
 * `PLM_SELF` = 针对 PLM 系统自身提出的需求（本客服 creature 的默认来源，项目 87 即承接此类）。
 */
const SOURCE_TYPES = ['MARKET', 'STANDARD', 'RISK', 'CAPA', 'CLINICAL', 'OTHER', 'PLM_SELF', 'REGULATION'];
const VERIFY_METHODS = ['TEST', 'ANALYSIS', 'INSPECTION', 'DEMO'];
const DFX_DIMS = ['DFM', 'DFR', 'DFT', 'DFU', 'SAFETY', 'ENV', 'COST', 'IP', 'COMPLIANCE'];
const APPEALS_DIMS = ['PRICE', 'QUALITY', 'TIME', 'VARIETY', 'SERVICE', 'CHANNEL', 'BRAND', 'RELATIONSHIP'];
/**
 * 三个"看起来能填、实际填了必被拒"的字段——**登记时的死锁区**（源码实证，2026-09-27）：
 *
 *   `paramValue`（量化指标值）填了 ⇒ 服务端 `assertVerifiable` 要求 `verifyMethod` 与 `verification`
 *   同时非空（`RequirementService.java:1136-1142`）；而 `verifyMethod` 又在「分析后才可填」名单里
 *   ⇒ **带上 `verifyMethod` 会被 `REQ_FIELD_STAGE_LOCKED` 拒（阶段锁在前），不带它会被
 *   `VERIFICATION_REQUIRED` 拒（可验证性校验在后）——两头都堵，`paramValue` 在登记时无解**。
 *
 * 这是典型的"两条各自正确的规则在交集处形成死锁"，也是本工具**必须替使用者挡下来**的地方：
 * 服务端两次报错都只说"哪个不满足"，不会告诉你"这两个要求互相排斥、你永远填不进去"。
 * 处置：量化要求（指标名、目标值、单位、怎么算验收）**写成正文里的量化段**交分析人，登记后再补。
 */
const CREATE_TIME_DEADLOCK = ['paramValue', 'paramUom', 'verification'];

/**
 * 服务端 `assertStageAllowsOnCreate` 会拦的字段（登记时带了值即 400 REQ_FIELD_STAGE_LOCKED）。
 * ⚠ 这里曾把 `solution` 误写成 `'paramsolution'`——该常量只用于**报错提示**（真正剥离靠
 * `CREATE_FIELDS` 白名单），所以没有引发错误行为，但它会让"未来某天有人拿这个列表做校验"时漏掉
 * `solution`。**凡"名单常量"，拼写错误都是定时炸弹**：今天无害、明天致命。
 */
const POST_ANALYSIS_FIELDS = ['priority', 'dfxDimension', 'verifyMethod', 'userPersona', 'userTags', 'solution', 'appealsDim'];
/**
 * 登记时服务端认识的字段白名单（多余键会被 Jackson 静默丢弃——比报错更危险）。
 * 白名单是**唯一**决定"什么会进请求体"的地方；把死锁字段与后置字段排除在外，
 * 等于让工具从结构上不可能发出"必被拒"的请求（而不是靠记得别填）。
 */
const CREATE_FIELDS = ['reqType', 'title', 'content', 'paramName', 'parentId',
  'reqClassId', 'sourceType', 'stdClause', 'projectId', 'attrs', 'sourceChannel'];

/**
 * 校验并规范化草稿。**字段知识是"提交前的门"**：宁可在本地拦下并说清怎么填，
 * 也不要让服务端 400 打回（服务端只告诉你"哪个字段不能写"，不告诉你"应该写到哪去"）。
 */
function normalizeDraft(raw, cfg) {
  const errors = [];
  const warnings = [];
  const d = { ...raw };
  const postAnalysis = {};

  if (!d.title || String(d.title).trim().length < 6) errors.push('title 必填且需自解释（≥6 字）：写"哪里不对 + 期望什么"，不要写"系统有问题"');
  if (!d.content || String(d.content).trim().length < 20) errors.push('content 必填且需可复现（≥20 字）：现象 / 影响 / 期望 三段式，见 references/requirement-draft-template.md');

  d.reqType = String(d.reqType || 'SR').toUpperCase();
  if (!REQ_TYPES.includes(d.reqType)) errors.push(`reqType=${d.reqType} 不在词表 ${REQ_TYPES.join('/')}`);

  // —— 后置字段：不写 body，收进 postAnalysis（附原因，回显到正文与台账）——
  const pushPost = (key, value, why) => { if (value != null && value !== '') postAnalysis[key] = { value, why }; };
  pushPost('priority', d.priority ? String(d.priority).toUpperCase() : null, '分级是分析结论（阶段锁 REQ_FIELD_STAGE_LOCKED）');
  pushPost('dfxDimension', d.dfxDimension ? String(d.dfxDimension).toUpperCase() : null, 'DFx 维度由交付/制造视角在分析后判定');
  pushPost('verifyMethod', d.verifyMethod ? String(d.verifyMethod).toUpperCase() : null, '怎么验证属工程决策（分析后填）');
  pushPost('appealsDim', d.appealsDim ? (Array.isArray(d.appealsDim) ? d.appealsDim : [d.appealsDim]).map((x) => String(x).toUpperCase()).join('/') : null, '$APPEALS 价值维度属分析归类结论');
  pushPost('userPersona', d.userPersona, '用户画像属分析产出');
  pushPost('userTags', d.userTags, '用户标签属分析产出');

  // 词表校验（即使是后置字段也要校验，避免把非法值写进正文传给分析人）
  if (postAnalysis.priority && !PRIORITIES.includes(postAnalysis.priority.value)) errors.push(`priority=${postAnalysis.priority.value} 不在词表 ${PRIORITIES.join('/')}`);
  if (postAnalysis.dfxDimension && !DFX_DIMS.includes(postAnalysis.dfxDimension.value)) errors.push(`dfxDimension=${postAnalysis.dfxDimension.value} 不在词表 ${DFX_DIMS.join('/')}`);
  if (postAnalysis.verifyMethod && !VERIFY_METHODS.includes(postAnalysis.verifyMethod.value)) errors.push(`verifyMethod=${postAnalysis.verifyMethod.value} 不在词表 ${VERIFY_METHODS.join('/')}`);
  if (postAnalysis.appealsDim) for (const x of postAnalysis.appealsDim.value.split('/')) if (!APPEALS_DIMS.includes(x)) errors.push(`appealsDim=${x} 不在词表 ${APPEALS_DIMS.join('/')}`);

  if (d.sourceType != null) {
    d.sourceType = String(d.sourceType).toUpperCase();
    if (!SOURCE_TYPES.includes(d.sourceType)) errors.push(`sourceType=${d.sourceType} 不在词表 ${SOURCE_TYPES.join('/')}`);
  }

  // sourceChannel：服务端白名单豁免（不锁），默认仍不写——少一个写入面就少一类 400
  if (d.sourceChannel != null && d.sourceChannel !== '' && d.sourceChannel !== false) {
    d.sourceChannel = String(d.sourceChannel).toUpperCase();
    if (!SOURCE_CHANNELS.includes(d.sourceChannel)) errors.push(`sourceChannel=${d.sourceChannel} 不在词表 ${SOURCE_CHANNELS.join('/')}`);
  } else {
    delete d.sourceChannel;
    warnings.push(`未写 sourceChannel（默认不写）：它是「分发前必录」字段，由分析人补录——如需登记时即写明，请在草稿里显式给 sourceChannel`);
  }

  /**
   * 量化三件套：**登记时的死锁区，一律硬拒并改道**（见 `CREATE_TIME_DEADLOCK` 的说明）。
   * 这里**故意不做"少填一个就放行"的降级**——因为任何降级都会把死锁转嫁给服务端：
   * 用户在本地"通过"了，却在服务端吃一个看不懂的 400。**宁可本地报错讲清楚，也不让服务端打回。**
   */
  const quantified = ['paramValue', 'paramUom', 'verification'].filter((k) => d[k] != null && String(d[k]).trim() !== '');
  if (quantified.length) {
    for (const k of quantified) delete d[k];
    const hasMethod = d.verifyMethod != null && String(d.verifyMethod).trim() !== '';
    errors.push(
      `登记时不能写 ${quantified.join(' / ')}（量化三件套与验收准则）——这是**死锁字段**，不是"填法不对"：`
      + `填了 paramValue ⇒ 服务端要求 verifyMethod + verification 同时非空（assertVerifiable）；`
      + `而 verifyMethod 属「分析后才可填」，`
      + (hasMethod
        ? '你这次带了 verifyMethod ⇒ 会被 400 REQ_FIELD_STAGE_LOCKED 先拒'
        : '不带它就会被 400 VERIFICATION_REQUIRED 拒')
      + ` ⇒ 两头都堵，登记时无论怎么填都进不去。`
      + `\n    处置：把量化要求写进 content 的量化段（指标名 paramName 可以写，因为它在可写名单里），例如`
      + `"【量化期望】导出耗时 ≤ 3s（指标名：export_latency）；验收：同一筛选条件连续导出 3 次，行数一致"——交分析人在进入 ANALYZED 后补录三件套。`,
    );
  } else if (d.paramName) {
    warnings.push('写了 paramName（指标名）——它在登记时可写，已写入请求；对应的 paramValue/paramUom/verification 属死锁区，请写进正文量化段交分析人');
  }

  d.projectId = Number(d.projectId || cfg.defaultProjectId || 0) || null;
  if (!d.projectId) errors.push('projectId 必填（缺项目时该需求**无法被批准**：服务端报 400 PROJECT_REQUIRED）——用 `plm-req.cjs projects` 查可用项目');

  // 组请求体：只保留服务端认识的键（多余键会被静默丢弃）
  const body = {};
  const dropped = [];
  for (const k of Object.keys(d)) {
    if (k.startsWith('_') || k === 'expect') continue;
    if (CREATE_FIELDS.includes(k)) { if (d[k] != null && d[k] !== '') body[k] = d[k]; }
    else dropped.push(k);
  }
  if (dropped.length) warnings.push(`已忽略未知/后置字段（不会写进请求）：${dropped.join(', ')}`);

  // 正文追加「分析输入」段：让分析人拿到客服采集的诉求与建议分级（正文是分析前可写字段）
  if (Object.keys(postAnalysis).length) {
    const lines = ['', '【分析输入 · 由客服采集，待分析人裁定】'];
    for (const [k, v] of Object.entries(postAnalysis)) lines.push(`· ${k} = ${v.value} —— ${v.why}`);
    body.content = String(body.content).replace(/\s+$/, '') + '\n' + lines.join('\n');
  }

  /**
   * **自检：后置字段名单 vs 实际剥离行为**（防止"名单常量"与实际逻辑分叉）。
   * 为什么值得写：这两个名单来自两处——`postAnalysis` 由 `pushPost(...)` 手工登记，剥离由
   * `CREATE_FIELDS` 白名单决定。它们**必须同源**；一旦有人加了 `pushPost` 却忘了从 `CREATE_FIELDS` 里
   * 排除（或反之），就会出现"文档说没写、实际写了"这类**沉默的偏差**——本工具历史上已因此把
   * `solution` 拼错成 `paramsolution` 而无人发现。断言比注释可靠。
   */
  const declaredPost = Object.keys(postAnalysis).filter((k) => POST_ANALYSIS_FIELDS.includes(k));
  const leakedPost = Object.keys(postAnalysis).filter((k) => !POST_ANALYSIS_FIELDS.includes(k));
  if (leakedPost.length) {
    warnings.push(`自检：后置字段 ${leakedPost.join(', ')} 不在 POST_ANALYSIS_FIELDS 名单里（名单该更新了——否则将来做"分析结论禁写"校验时会漏掉它们）`);
  }
  const writtenPost = Object.keys(body).filter((k) => POST_ANALYSIS_FIELDS.includes(k));
  if (writtenPost.length) {
    errors.push(`自检失败：后置字段 ${writtenPost.join(', ')} 出现在请求体里（应只进正文）——这是工具缺陷，请勿提交并报告维护者`);
  }
  const writtenDeadlock = Object.keys(body).filter((k) => CREATE_TIME_DEADLOCK.includes(k));
  if (writtenDeadlock.length) {
    errors.push(`自检失败：死锁字段 ${writtenDeadlock.join(', ')} 出现在请求体里——这是工具缺陷，请勿提交并报告维护者`);
  }

  return { body, postAnalysis, errors, warnings };
}

// ------------------------------------------------------------ 子命令

async function cmdCheck(cfg, args) {
  const log = (...a) => dim('  ' + a.join(' '));
  console.log(`${C.b}== PLM 客服 · 环境自检 ==${C.x}`);
  console.log('配置：'); out(describeConfig(cfg));

  let fail = 0;
  const step = async (name, fn) => {
    try { const r = await fn(); ok(`${name}：${r}`); return true; }
    catch (e) { bad(`${name}：${e.message}`); fail++; return false; }
  };

  await step('工作区/.env', async () => {
    if (!cfg.envFileExists) throw new Error(`缺少 ${cfg.envFile}（需含 PLM_USER / PLM_PASSWORD / PLM_WEB_BASE）`);
    if (!cfg.password) throw new Error('.env 里 PLM_PASSWORD 为空');
    return `${cfg.envFile}（口令已设置，长度 ${cfg.password.length}，不回显）`;
  });

  await step('PLM 可达性', async () => {
    const r = await fetch(`${cfg.base}/plm-config.js`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`GET /plm-config.js http=${r.status}`);
    const t = await r.text();
    return `http=200；${t.replace(/\s+/g, ' ').match(/devLogin:\s*(true|false)/) ? t.replace(/\s+/g, ' ').slice(t.indexOf('window'), t.indexOf('window') + 60) : ''}`;
  });

  await step('SSO 登录（真表单）', async () => {
    const p = await probeLogin(cfg, { log: (m) => dim('    ' + m) });
    return `user=${p.user} roles=[${p.realmRoles.join(',')}] token 有效期 ${Math.round((p.expiresInSec || 0) / 60)}min`;
  });

  await step('创建需求权限（requirement.create）', async () => {
    // 有意发一个**必然被拒**的空 body：400 说明鉴权已过（进到了校验层），403 才是权限不足。
    const r = await plmFetch(cfg, '/requirements', { method: 'POST', body: {}, log });
    if (r.status === 403) throw new Error(`403：当前身份没有 requirement.create（robinzeng 应为 pdt_manager/developer 等，请核对角色）`);
    if (r.status === 400 || r.status === 422) return `鉴权通过（空 body 被业务校验拒绝 http=${r.status} ${String((r.json && r.json.code) || r.json && r.json.message || '').slice(0, 80)}）`;
    if (r.status === 200 || r.status === 201) return `⚠ 空 body 竟创建成功（http=${r.status}）——请立即人工核对是否产生垃圾条目：${JSON.stringify(r.json).slice(0, 200)}`;
    return `http=${r.status} ${String(r.text).slice(0, 120)}`;
  });

  await step('默认项目可用性', async () => {
    if (!cfg.defaultProjectId) throw new Error('未配置 PLM_DEFAULT_PROJECT_ID');
    const r = await plmFetch(cfg, `/projects/${cfg.defaultProjectId}`, { log });
    if (!r.ok) throw new Error(`GET /projects/${cfg.defaultProjectId} http=${r.status}（该 id 可能不存在于 UAT）`);
    const p = r.json || {};
    return `#${cfg.defaultProjectId} ${p.prjCode || ''} ${p.name || ''}（PM=${p.pmLogin || '-'}，状态=${p.status || '-'}）`;
  });

  await step('需求分类清单', async () => {
    const r = await plmFetch(cfg, '/requirement-classes', { log });
    if (!r.ok) throw new Error(`http=${r.status}`);
    const list = Array.isArray(r.json) ? r.json : (r.json && (r.json.items || r.json.content)) || [];
    return `${list.length} 个分类`;
  });

  /**
   * 词表漂移自检（本工具写死的枚举 vs 服务端元数据）。
   * 为什么必须有：`sourceType` 曾因"抄错另一套词表"在真实登记时 400（实测 2026-09-27）。
   * 写死词表是为了提交前能拦截错误；**写死就必须能发现漂移**——由本步在 check 里比对，
   * 不一致即报红并打印服务端真值（而不是等到登记时被打回）。
   */
  await step('词表一致性（写出枚举 vs 服务端元数据）', async () => {
    const r = await plmFetch(cfg, '/_platform/metadata/detail-fields?objType=REQ', { log });
    if (!r.ok) throw new Error(`http=${r.status}`);
    const fields = Array.isArray(r.json) ? r.json : (r.json && (r.json.fields || r.json.items)) || [];
    const pick = (k) => {
      const f = fields.find((x) => x.code === k || x.attrCode === k || x.key === k);
      return f && (f.enumValues || f.enum_values) ? f.enumValues || f.enum_values : null;
    };
    const local = { reqType: REQ_TYPES, sourceType: SOURCE_TYPES, sourceChannel: SOURCE_CHANNELS, priority: PRIORITIES, dfxDimension: DFX_DIMS, verifyMethod: VERIFY_METHODS };
    const diffs = [];
    for (const [k, mine] of Object.entries(local)) {
      const srv = pick(k);
      if (!srv) continue;                                   // 元数据未下发该键 ⇒ 不做判定（不是失败）
      const s = Array.isArray(srv) ? srv.map(String) : [];
      const onlyServer = s.filter((x) => !mine.includes(x));
      const onlyLocal = mine.filter((x) => !s.includes(x));
      if (onlyServer.length || onlyLocal.length) diffs.push(`${k}: 服务端多[${onlyServer.join(',')}] 本地多[${onlyLocal.join(',')}]`);
    }
    if (diffs.length) throw new Error(`词表漂移——以服务端为准修正 plm-req.cjs 的常量：${diffs.join(' | ')}`);
    const checked = Object.keys(local).filter((k) => pick(k)).length;
    return checked ? `${checked} 个键一致` : '元数据未下发可枚举字段（跳过，非失败）';
  });

  await step('令牌缓存', async () => {
    const s = readSession(cfg);
    if (!s) return '无缓存（下次调用会重新登录）';
    const exp = tokenExpiryMs(s);
    return `${cfg.sessionCache}（剩余 ${Math.max(0, Math.round((exp - Date.now()) / 1000))}s，refresh_token ${s.refresh_token ? '有' : '无'}）`;
  });

  console.log('');
  if (fail) { bad(`自检未通过：${fail} 项失败——**不要带病登记**（先修再跑）`); return 1; }
  ok('自检全部通过：可以登记需求');
  return 0;
}

async function cmdLogin(cfg, args) {
  const t = await getToken(cfg, { force: Boolean(args.force), log: (m) => dim('  ' + m) });
  const c = t.claims || decodeJwt(t.access_token);
  out({ source: t.source, user: c.preferred_username, sub: c.sub, roles: (c.realm_access || {}).roles || [], expiresAt: new Date((c.exp || 0) * 1000).toISOString() });
  return 0;
}

async function cmdWhoami(cfg, args = {}) {
  /**
   * 2026-09-27 小改（**唯一的改动点**，其余保持不变，便于与原始版本对照）：
   * 原实现只读缓存，缓存为空即报「先跑 login」并退 1。但本工具被**客服 agent 当作工具调用**时，
   * "缓存空了"是**常态**（重启/换机器/token 过期），而不是操作失误 —— 此时让 agent 先学会"再跑一次 login"
   * 是多余的仪式：`getToken` 本来就会走「缓存 → refresh 续期 → 完整 SSO」这条降级链。
   * 所以加 `--ensure`：显式要求"拿到有效 token，必要时自动续期/登录"。
   * **默认行为不变**（不带 --ensure 时仍然只读缓存），因为"我只是想知道现在是谁"不该触发浏览器。
   */
  if (args.ensure) {
    const t = await getToken(cfg, { log: (m) => dim('  ' + m) });
    const c2 = t.claims || decodeJwt(t.access_token);
    out({
      user: c2.preferred_username, sub: c2.sub, roles: (c2.realm_access || {}).roles || [],
      source: t.source, refreshToken: Boolean(readSession(cfg)?.refresh_token),
    });
    return 0;
  }
  const s = readSession(cfg);
  if (!s) { bad('无令牌缓存——先跑 `login`（或加 --ensure 让它自动续期/登录）'); return 1; }
  const c = decodeJwt(s.access_token);
  const exp = tokenExpiryMs(s);
  out({ user: c.preferred_username, sub: c.sub, roles: (c.realm_access || {}).roles || [], expired: Date.now() > exp, expiresAt: new Date(exp).toISOString(), refreshToken: Boolean(s.refresh_token) });
  return 0;
}

async function cmdProjects(cfg, args) {
  const list = await fetchAllPages(cfg, '/projects', { pageSize: 100, maxPages: 10, log: (m) => dim('  ' + m) });
  const kw = args.keyword ? String(args.keyword).toLowerCase() : null;
  const rows = list
    .filter((p) => !kw || `${p.prjCode} ${p.name}`.toLowerCase().includes(kw))
    .map((p) => ({ id: p.id, prjCode: p.prjCode, name: p.name, pm: p.pmLogin, status: p.status }));
  console.log(`共 ${rows.length} 个项目（${args.keyword ? `匹配 "${args.keyword}"` : '全部'}）：`);
  for (const r of rows) console.log(`  ${String(r.id).padStart(5)}  ${(r.prjCode || '').padEnd(14)} ${(r.name || '').padEnd(28)} PM=${r.pm || '-'}  ${r.status || ''}`);
  return 0;
}

async function cmdClasses(cfg) {
  const r = await plmFetch(cfg, '/requirement-classes');
  if (!r.ok) { bad(`http=${r.status} ${String(r.text).slice(0, 200)}`); return 1; }
  out(r.json);
  return 0;
}

async function cmdList(cfg, args) {
  const qs = [];
  if (args.project) qs.push(`projectId=${Number(args.project)}`);
  if (args.status) qs.push(`status=${encodeURIComponent(args.status)}`);
  if (args.keyword) qs.push(`keyword=${encodeURIComponent(args.keyword)}`);
  if (args.assignee) qs.push(`assignee=${encodeURIComponent(args.assignee)}`);
  const path0 = '/requirements' + (qs.length ? `?${qs.join('&')}` : '');
  const pageSize = Number(args['page-size'] || 20);
  const r = await plmFetch(cfg, `${path0}${qs.length ? '&' : '?'}pageSize=${pageSize}&page=0`);
  if (!r.ok) { bad(`http=${r.status} ${String(r.text).slice(0, 300)}`); return 1; }
  const items = (r.json && r.json.items) || [];
  console.log(`命中 ${r.json && (r.json.total ?? items.length)} 条（显示前 ${items.length}）：`);
  for (const it of items) {
    console.log(`  ${String(it.id).padStart(5)} ${(it.reqCode || '').padEnd(15)} ${(it.status || '').padEnd(18)} ${(it.priority || '').padEnd(7)} ${String(it.title || '').slice(0, 60)}`);
  }
  return 0;
}

async function cmdGet(cfg, args) {
  const key = args._[1];
  if (!key) { bad('用法：get <id 或 REQ-YYYY-NNNN> [--flow] [--history]'); return 2; }
  let id = Number(key);
  if (!Number.isFinite(id) || id <= 0) {
    const r = await plmFetch(cfg, `/requirements?keyword=${encodeURIComponent(key)}&pageSize=20`);
    const hit = ((r.json && r.json.items) || []).find((x) => x.reqCode === key);
    if (!hit) { bad(`未找到 ${key}`); return 1; }
    id = hit.id;
  }
  const r = await plmFetch(cfg, `/requirements/${id}`);
  if (!r.ok) { bad(`http=${r.status} ${String(r.text).slice(0, 200)}`); return 1; }
  out(r.json);
  if (args.flow) { console.log('\n--- flow-stages ---'); out((await plmFetch(cfg, `/requirements/${id}/flow-stages`)).json); }
  if (args.history) { console.log('\n--- history ---'); out((await plmFetch(cfg, `/requirements/${id}/history`)).json); }
  return 0;
}

async function cmdDedup(cfg, args) {
  if (!args.title) { bad('用法：dedup --title "…" [--content "…"] [--project 87] [--threshold 0.55]'); return 2; }
  const res = await dedupCheck(cfg, {
    title: String(args.title), content: String(args.content || ''),
    projectId: args.project ? Number(args.project) : cfg.defaultProjectId,
    threshold: Number(args.threshold || 0.55),
    log: (m) => dim('  ' + m),
  });
  console.log(`服务端关键词命中 ${res.serverKeywordHits} 条；本地相似度候选 ${res.candidateCount} 条；阈值 ${res.threshold}`);
  if (res.hits.length) {
    warn(`发现 ${res.hits.length} 条**疑似重复**（相似度 ≥ ${res.threshold}）——按项目纪律（X-04）应先查重再登记：`);
    for (const h of res.hits) console.log(`  ${(h.sim * 100).toFixed(0)}%  ${String(h.id).padStart(5)} ${(h.reqCode || '').padEnd(15)} ${(h.status || '').padEnd(14)} ${h.title}`);
    console.log('\n建议：若已有条目覆盖同一痛点 → **补充证据到既有条目**（评论/追溯），而不是再开一条编号。');
  } else ok('未发现相似条目（可继续登记）');
  if (res.top.length > res.hits.length) {
    dim('\n相近但未达阈值（供人工判断）：');
    for (const h of res.top.filter((x) => !res.hits.includes(x))) console.log(`  ${(h.sim * 100).toFixed(0)}%  ${String(h.id).padStart(5)} ${(h.reqCode || '').padEnd(15)} ${h.title}`);
  }
  return res.hits.length ? 3 : 0;
}

async function cmdSubmit(cfg, args) {
  const file = args.f || args.file;
  if (!file) { bad('用法：submit -f draft.json [--dry-run] [--allow-duplicate]'); return 2; }
  const p = path.resolve(process.cwd(), String(file));
  if (!fs.existsSync(p)) { bad(`草稿文件不存在：${p}`); return 2; }
  let raw;
  try {
    // ⚠ 必须剥 BOM：Windows 上用 `Set-Content -Encoding UTF8` / Excel 另存的 JSON 都带 UTF-8 BOM，
    // 而 `JSON.parse('\uFEFF{…}')` 直接抛 — 报错信息是"Unexpected token"，会把人引向"JSON 写错了"这个错方向
    // （实测踩过：真正的原因只是文件头多了三个字节）。
    const text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    raw = JSON.parse(text);
  } catch (e) { bad(`草稿不是合法 JSON：${e.message}`); return 2; }

  const { body, postAnalysis, errors, warnings } = normalizeDraft(raw, cfg);
  console.log(`${C.b}== 草稿校验 ==${C.x}`);
  for (const w of warnings) warn(w);
  if (errors.length) { for (const e of errors) bad(e); console.log(''); bad('校验未通过，未提交任何内容'); return 2; }
  ok('字段校验通过');
  const postKeys = Object.keys(postAnalysis);
  if (postKeys.length) {
    info(`阶段约束：以下 ${postKeys.length} 项属"分析后才可填"，**不写进请求**，已并入正文的「分析输入」段：`);
    for (const k of postKeys) console.log(`    · ${k} = ${postAnalysis[k].value}  ${C.d}(${postAnalysis[k].why})${C.x}`);
  }
  console.log('将提交的请求体（对照看一遍再落库）：'); out(body);

  const fp = fingerprint(body);
  const ledger = readLedger(cfg);
  const dupLedger = ledger.filter((r) => r.fp === fp);
  if (dupLedger.length && !args['allow-duplicate']) {
    bad(`本地台账已有相同 fingerprint（${fp}）：${dupLedger.map((r) => r.reqCode).join(', ')} —— 拒绝重复登记（确需再登记请加 --allow-duplicate）`);
    return 3;
  }

  console.log(`\n${C.b}== 提交前查重 ==${C.x}`);
  const dd = await dedupCheck(cfg, { title: body.title, content: body.content, projectId: body.projectId, threshold: Number(args.threshold || 0.55), log: (m) => dim('  ' + m) });
  if (dd.hits.length) {
    if (!args['allow-duplicate']) {
      warn(`发现 ${dd.hits.length} 条疑似重复，**默认不登记**：`);
      for (const h of dd.hits) console.log(`  ${(h.sim * 100).toFixed(0)}%  ${h.reqCode}  ${h.status}  ${h.title}`);
      console.log('\n处理建议（三选一）：');
      console.log('  ① 把新证据补到既有条目上（推荐：同一痛点不要产生第二个编号）；');
      console.log('  ② 若确认是**不同的**痛点 → 改标题/描述使差异显式，再加 --allow-duplicate 重跑；');
      console.log('  ③ 若是既有条目的**订正** → 走订正条目（supersedesId）而非新建。');
      return 4;
    }
    warn(`已用 --allow-duplicate 覆盖查重拦截（${dd.hits.length} 条疑似重复）——请确认这是有意的`);
  } else ok('查重通过（无相似条目）');

  if (args['dry-run']) { console.log(''); ok(`dry-run：未落库。真实执行请去掉 --dry-run。fingerprint=${fp}`); return 0; }

  console.log(`\n${C.b}== 落库 ==${C.x}`);
  /**
   * `Idempotency-Key`（opt-in 幂等键，UAT 已部署）：值取 draft 的 fingerprint。
   * 为什么值得加：网络超时/重试是"建了单但没收到响应"的经典场景，**没有幂等键就会建出两条**；
   * 有了它，同键重放返回第一次的响应（头 `Idempotent-Replay: true`），重试变得安全。
   * ⚠ 已知语义（实测）：重放**不看 body**——同键换内容仍返回旧响应。故 fingerprint 必须**真代表内容**
   * （本工具的 fingerprint = 规范化标题 + 正文前 400 字哈希），改内容即换键。
   */
  const r = await plmFetch(cfg, '/requirements', { method: 'POST', body, headers: { 'Idempotency-Key': fp }, log: (m) => dim('  ' + m) });
  if (!r.ok) {
    bad(`登记失败 http=${r.status}`);
    console.log(String(r.text).slice(0, 1500));
    const code = (r.json && (r.json.code || r.json.error)) || '';
    if (String(code).includes('REQ_FIELD_STAGE_LOCKED') || String(r.text).includes('REQ_FIELD_STAGE_LOCKED')) {
      console.log('\n处置：这是**阶段约束**而非权限问题——服务端拒绝了"分析后才可填"的字段。');
      console.log('  本工具已默认剥离 priority/dfxDimension/verifyMethod/appealsDim 等字段；若仍报此错，');
      console.log('  说明草稿里还有别的后置字段（或该环境元数据名单比源码更宽）⇒ 逐步删字段重试，并把字段名记入 lessons。');
    }
    if (String(code).includes('PROJECT_REQUIRED')) console.log('\n处置：必须给 projectId（否则后续批准会被卡）。用 `plm-req.cjs projects --keyword PLM` 选项目。');
    if (r.status === 403) console.log('\n处置：当前身份没有 requirement.create —— 检查 .env 的 PLM_USER 是否具备 pdt_manager/developer/admin 等角色。');
    return 1;
  }
  const created = r.json || {};
  const replayed = r.headers && String(r.headers.get('Idempotent-Replay') || '').toLowerCase() === 'true';
  if (replayed) warn('服务端标记 Idempotent-Replay：本次是**重放**（此前同 fingerprint 已登记成功，未新建第二条）');
  ok(`已登记：${created.reqCode || '(无 reqCode)'}  id=${created.id}  status=${created.status || 'PROPOSED'}`);

  const s = readSession(cfg);
  const by = (s && decodeJwt(s.access_token).preferred_username) || cfg.user;
  appendLedger(cfg, {
    ts: new Date().toISOString().replace('T', ' ').slice(0, 19),
    reqCode: created.reqCode || '', projectId: body.projectId, title: body.title, fp,
    status: created.status || 'PROPOSED', by,
    notes: `reqType=${body.reqType}${replayed ? ' [replay]' : ''}${postKeys.length ? ' 后置:' + postKeys.join('/') : ''}`,
  });
  ok(`已记账：${ledgerPath(cfg)}`);
  console.log('\n后续流转（本工具只做登记，**不代替责任人做批准/验收**）：');
  console.log('  提案 PROPOSED → 分析 ANALYZED → 批准 APPROVED（须已指定项目）→ 方案制定 → 实现 → 验证 → 验收 → 关闭');
  if (postKeys.length) console.log(`  登记时未写的后置字段（${postKeys.join('/')}）已在正文「分析输入」段：请转给分析人在进入 ANALYZED 后补录。`);
  console.log(`  查看：node plm-req.cjs get ${created.reqCode || created.id} --flow`);
  out({ id: created.id, reqCode: created.reqCode, status: created.status, replayed, postAnalysisNotWritten: postKeys });
  return 0;
}

async function cmdTrack(cfg) {
  const ledger = readLedger(cfg);
  if (!ledger.length) { warn('本地台账为空（尚未登记过），或 .creature/kb/registration-ledger.md 不存在'); return 0; }
  console.log(`${C.b}== 台账条目运行态回读 ==${C.x}（共 ${ledger.length} 条，最近 25 条）`);
  const recent = ledger.slice(-25);
  const rows = [];
  for (const r of recent) {
    const g = await plmFetch(cfg, `/requirements?keyword=${encodeURIComponent(r.reqCode)}&pageSize=5`);
    const hit = ((g.json && g.json.items) || []).find((x) => x.reqCode === r.reqCode);
    if (!hit) { rows.push({ ...r, live: '未找到', next: '' }); continue; }
    let next = '';
    const f = await plmFetch(cfg, `/requirements/${hit.id}/flow-stages`);
    if (f.ok && f.json) next = String(f.json.nextHandler || '').slice(0, 28);
    rows.push({ ...r, live: hit.status, next, id: hit.id });
  }
  for (const r of rows) {
    const drift = r.live && r.live !== '未找到' && r.live !== r.status ? ` ${C.y}(台账记 ${r.status})${C.x}` : '';
    console.log(`  ${(r.reqCode || '').padEnd(15)} ${String(r.live).padEnd(18)} ${r.title.slice(0, 34).padEnd(34)} 下一步=${r.next}${drift}`);
  }
  const driftCount = rows.filter((r) => r.live && r.live !== '未找到' && r.live !== r.status).length;
  console.log('');
  console.log(`台账与实际不一致 ${driftCount} 条${driftCount ? '（应回写台账：creature 的 L2 整理动作）' : ''}`);
  return 0;
}

async function cmdDoctor(cfg, args) {
  console.log(`检查 CDP 端口 :${cfg.cdpPort} 的占用者…`);
  const killed = killOrphanBrowser(cfg.cdpPort);
  if (killed.length) ok(`已清理孤儿浏览器进程：${killed.join(', ')}`);
  else info('端口无占用（或清理失败，见下方）');
  return 0;
}

// ------------------------------------------------------------ main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'check';
  const cfg = loadConfig(process.cwd());
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';   // UAT 自签证书；仅影响本进程

  const table = {
    check: () => cmdCheck(cfg, args),
    login: () => cmdLogin(cfg, args),
    whoami: () => cmdWhoami(cfg, args),
    projects: () => cmdProjects(cfg, args),
    classes: () => cmdClasses(cfg),
    list: () => cmdList(cfg, args),
    get: () => cmdGet(cfg, args),
    dedup: () => cmdDedup(cfg, args),
    submit: () => cmdSubmit(cfg, args),
    track: () => cmdTrack(cfg),
    doctor: () => cmdDoctor(cfg, args),
  };
  if (!table[cmd]) { bad(`未知子命令：${cmd}`); console.log(`可用：${Object.keys(table).join(' / ')}`); return 2; }
  try { return await table[cmd](); }
  catch (e) { bad(`命令 ${cmd} 失败：${e.message}`); if (process.env.PLM_DEBUG) console.error(e); return 1; }
}

if (require.main === module) {
  main().then(async (code) => {
    /**
     * ⚠ 不能直接 `process.exit(code)`：`fetch` 的 keep-alive 连接会让 libuv 在关闭期抛
     * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c`（Windows 实测）。
     * 它**不影响退出码与业务结果**，但会往 stderr 喷一行原生断言，让"命令确实成功了"这件事看起来可疑。
     * 对策：给事件循环一点时间自然排空，再以显式码退出。
     */
    await new Promise((r) => setTimeout(r, 120));
    process.exit(code);
  }).catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { similarity, tokens, fingerprint, normalizeDraft, dedupCheck, readLedger, appendLedger, POST_ANALYSIS_FIELDS, CREATE_FIELDS };

