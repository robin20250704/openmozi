#!/usr/bin/env node
'use strict';
/**
 * plm-kb.cjs · PLM 客服 creature 的**电容器运维工具**（工作区 `.creature/kb/`）
 *
 * 为什么需要它（而不是"用 read 一个个读文件"）：
 *   ① **开工包**：一次调用给出"该读的几份文件 + 与本次问题相关的条目候选"，
 *      替代"读 4~6 个大文件再自己筛"——这正是设计原则③"能靠就近缓存解决的，就不跨器官传输"
 *      与度量里"电容器命中率"的落地形式（省的是 token 与注意力，不是磁盘）。
 *   ② **初始化**：工作区第一次使用时把 skill 自带的 `references/kb/`、`references/templates/`
 *      种子复制进工作区——种子随 skill 走（可版本化），家园在工作区（可积累）。
 *   ③ **写入纪律**：追加条目统一走本工具（自动起 ID、自动加索引行、grep 守卫防重复），
 *      避免"手写条目 → 索引没更新 → 下次检索不到"（电容器失效最隐蔽的一种）。
 *
 * 用法（工作区根执行）：
 *   node plm-kb.cjs init [--refresh|--force]  安装/更新工作区 KB 种子（默认不覆盖；--refresh 只更新未被本地改过的种子副本；--force 无条件覆盖并逐个备份）
 *   node plm-kb.cjs boot [--budget 200]   开工包：列必读文件 + 关键词命中的条目候选
 *   node plm-kb.cjs query <词...> [-k 8]  分级检索：先索引行 → 再条目标题 → 兜底全文
 *   node plm-kb.cjs append --domain lessons|negatives --title "…" --body-file f.md [--evidence "…"]
 *   node plm-kb.cjs doctor                体检：文件是否齐、台账与缓存、行数（超限提示整理）
 *
 * 命名约定：本 skill 的电容器文件一律以 `plm-` 前缀命名——**不覆盖**工作区里别的 creature
 * （如交付型）已有的 `MISSION.md` / `conventions.md`（它们的域不属于 PLM 客服，覆盖会让两个
 * creature 互相污染对方的偏置源）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig } = require('./plm-sso.cjs');

const SKILL_ROOT = path.resolve(__dirname, '..');
const SEED_KB = path.join(SKILL_ROOT, 'kb');
const SEED_TPL = path.join(SKILL_ROOT, 'templates');

/** 开工必读（每次会话开始按此顺序读，其余按需）。 */
const BOOT_FILES = [
  ['plm-MISSION.md', '偏置源：mission/矛盾/代价不对称（先定"听谁的"）'],
  ['plm-contracts.md', '硬约束 C-01~C-12（写操作前必命中）'],
  ['plm-conventions.md', '约定 V-01~V-15（怎么做更好）'],
  ['plm-faq.md', 'FAQ 权威答复库（答客问首选）'],
  ['plm-known-deviations.md', '已知偏差 + 是不是缺陷分诊表（分诊门依据）'],
  ['plm-module-map.md', '系统地图：模块/路由/角色/端点（定位用）'],
];
/** 按需读（有对应动作时才读）。 */
const ON_DEMAND = [
  ['plm-requirement-intake-schema.md', '把口语转成需求的字段契约'],
  ['plm-voice-of-customer.md', '客户原话台账（查"以前谁提过"）'],
  ['plm-pain-clusters.md', '痛点主题簇（洞察线；判断"是不是第 N 次反馈"）'],
  ['plm-registration-ledger.md', '登记台账（工具自动写；track 回读）'],
  ['plm-requirement-outcome-tracker.md', '登记-结果追踪（需求被采纳/实现情况）'],
  ['plm-answer-quality.md', '答复质量记账（度量一次命中率）'],
  ['plm-user-profiles.md', '角色画像（权限类问题先看这里）'],
  ['plm-tool-registry.md', '工具选型与降级链'],
  ['plm-lessons.md', '错误教训'],
  ['plm-negatives.md', '负结果缓存（已排除的结论）'],
  ['plm-health.md', '健康指标与预算'],
];

const c = process.stdout.isTTY ? { g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[2m', x: '\x1b[0m' } : { g: '', y: '', b: '', d: '', x: '' };
const ok = (m) => console.log(`${c.g}✔${c.x} ${m}`);
const warn = (m) => console.log(`${c.y}!${c.x} ${m}`);
const info = (m) => console.log(`${c.b}·${c.x} ${m}`);

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
    if (next !== undefined && !isOpt(next)) { a[body] = next; i++; } else a[body] = true;
  }
  return a;
}

const kbDir = (cfg) => path.join(cfg.root, '.creature', 'kb');
const tplDir = (cfg) => path.join(cfg.root, '.creature', 'templates');

// ------------------------------------------------------------ init

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifestPath = (cfg) => path.join(kbDir(cfg), '.plm-seed-manifest.json');

/**
 * 比对用的规范化字节：**剥掉 UTF-8 BOM**。
 * 为什么必须剥：Windows 上 `Set-Content -Encoding UTF8` 会写 BOM，于是"同一份内容"在字节层面
 * 多了 3 字节、哈希全不同 —— 实测踩过：工作区文件与种子只差一个 BOM，`--refresh` 却报"已本地改动，保留"，
 * 明明什么都没改过却被当成改过（**假阳性比对**会让安全更新功能形同虚设）。
 * 内容比对看的是**文本**，不是"文件的二进制身份"——BOM/行尾都不该参与判断（但**换行结构参与**，
 * 因为行结构本身就是 Markdown 的语义）。
 */
const normBytes = (buf) => (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF ? buf.subarray(3) : buf);

/**
 * 种子清单（上次安装/更新时"种子"的哈希），记在 KB 目录里。
 * **它存在的原因**：为了区分"**未被改动过的种子副本**"与"**已经被本地经验改过的档案**"——
 * 只有前者可以安全地被新种子覆盖；后者覆盖就等于抹掉记忆。
 * 没有这份区分的后果是实测过的：`init --force` 会把整个 KB 备份一遍再全量覆盖（17 个文件全进备份、
 * 连内容完全相同的也照抄一遍），既制造垃圾，又让人以为"覆盖是常规操作"——而下一次被覆盖的
 * 可能正是辛苦积累的 lesson。**"批量覆盖"这类命令必须默认危险，不能默认方便。**
 */
function readManifest(cfg) {
  const p = manifestPath(cfg);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}
function writeManifest(cfg, m) {
  try { fs.writeFileSync(manifestPath(cfg), JSON.stringify(m, null, 2), 'utf8'); }
  catch (e) { info(`种子清单写入失败（不影响本次结果）：${e.message}`); }
}

function cmdInit(cfg, args) {
  const kb = kbDir(cfg); const tp = tplDir(cfg);
  fs.mkdirSync(kb, { recursive: true }); fs.mkdirSync(tp, { recursive: true });
  const manifest = readManifest(cfg);
  const refresh = Boolean(args.refresh);          // 只更新"未被本地改过的种子副本"
  const force = Boolean(args.force);              // 无条件覆盖（会备份）——**只在明确知道会丢什么时用**
  let added = 0; let refreshed = 0; let skipped = 0; let overwritten = 0;
  const report = [];

  const pairs = [
    ...fs.readdirSync(SEED_KB).filter((f) => f.endsWith('.md')).map((f) => [path.join(SEED_KB, f), path.join(kb, f), 'kb']),
    ...(fs.existsSync(SEED_TPL) ? fs.readdirSync(SEED_TPL).map((f) => [path.join(SEED_TPL, f), path.join(tp, f), 'templates']) : []),
  ];
  for (const [src, dst, label] of pairs) {
    const key = `${label}/${path.basename(dst)}`;
    const srcHash = sha(src);
    const exists = fs.existsSync(dst);
    if (!exists) { fs.copyFileSync(src, dst); manifest[key] = srcHash; added++; report.push(`+ ${key}`); continue; }
    const dstHash = sha(dst);
    if (dstHash === srcHash) { manifest[key] = srcHash; skipped++; continue; }   // 已是最新，**不碰它**
    const pristine = manifest[key] === dstHash;                                  // 未被本地改过的种子副本
    if (refresh && pristine) {
      fs.copyFileSync(src, dst); manifest[key] = srcHash; refreshed++; report.push(`↻ ${key}（本地未改动 ⇒ 安全更新）`);
      continue;
    }
    /**
     * **冻结检测**：文件既不是最新种子、也匹配不上清单里记的种子哈希 ⇒ 无法证明"它没被本地改过"。
     * 为什么专门认这一种：实测踩过——我用一条 PowerShell 管道把 `plm-lessons.md` 的行结构压坏
     * （30 行 → 1 行），此后 `--refresh` **拒绝更新它**（因为哈希对不上清单），文件就永久卡在损坏态，
     * 而工具只报"保留"，不报"它已经不是它该有的样子"。
     * 判据用**长度**而不是哈希：只读同尺寸窗口比较——既避开"逐字节统计出现次数"这种笨办法，
     * 又能可靠识破"换行被吃掉了"（同一批文字，字节数必然显著变小且长窗口不可能相同）。
     */
    if (refresh && !pristine && manifest[key]) {
      const a = normBytes(fs.readFileSync(dst)); const b = normBytes(fs.readFileSync(src));
      const windowSame = a.length <= b.length && Buffer.compare(a, b.subarray(0, a.length)) === 0;
      if (windowSame) {
        fs.copyFileSync(dst, `${dst}.bak-frozen-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        fs.copyFileSync(src, dst); manifest[key] = srcHash; refreshed++;
        report.push(`↻ ${key}（**冻结已修复**：与种子同前缀但更短 ⇒ 行结构疑似被破坏；旧内容已备份）`);
        continue;
      }
    }
    if (force) {
      fs.copyFileSync(dst, `${dst}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      fs.copyFileSync(src, dst); manifest[key] = srcHash; overwritten++; report.push(`! ${key}（已备份后覆盖）`);
      continue;
    }
    skipped++;
    report.push(`= ${key}（**已本地改动，保留**${pristine ? '；`--refresh` 可安全更新它' : ''}）`);
  }
  writeManifest(cfg, manifest);
  for (const r of report) console.log(`    ${r}`);
  ok(`KB 初始化完成：新增 ${added}，安全更新 ${refreshed}，跳过 ${skipped}，强制覆盖 ${overwritten}`);
  info(`家园：${kb}`);
  if (skipped && !refresh) {
    info(`提示：想更新"从未改过"的种子副本用 \`init --refresh\`（只动 pristine 副本，不动你积累的内容）；`);
    info(`      \`init --force\` 会无条件覆盖（逐个备份）——那只在确认要放弃本地改动时用。`);
  }
  if (!fs.existsSync(path.join(cfg.root, '.env'))) warn(`未发现 .env —— 登记前请先补齐（PLM_USER/PLM_PASSWORD/PLM_WEB_BASE）`);
  return 0;
}

// ------------------------------------------------------------ 检索

/**
 * 只读**本 creature 的**电容器文件（`plm-` 前缀）。
 * 为什么必须过滤：工作区 `.creature/kb/` 可能是**多个 creature 共用的家园**（例如交付型实例在这里
 * 有 contracts.md / lessons.md / negatives.md）。若不过滤，PLM 客服检索"导出"会命中交付型的
 * "空数据集导出崩溃"条目——**跨域污染**，会让客服把别人的教训当 PLM 的事实引用。
 * 这是"就近优先"的反面：就近缓存必须**按域隔离**，否则缓存越近越危险。
 */
function readKbFiles(cfg) {
  const dir = kbDir(cfg);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f.startsWith('plm-'))
    .map((f) => ({ name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

/** 切条目：以 `## ` 标题为界（也认 `### Q:` 形式的 FAQ 条目）。 */
function splitEntries(text) {
  const lines = text.split(/\r?\n/);
  const out = []; let cur = null;
  for (const line of lines) {
    if (/^#{2,3}\s+/.test(line)) {
      if (cur) out.push(cur);
      cur = { title: line.replace(/^#+\s*/, '').trim(), lines: [line] };
    } else if (cur) cur.lines.push(line);
    else { cur = { head: true, title: '(文首)', lines: [] }; }
  }
  if (cur) out.push(cur);
  /**
   * **丢掉"文首"伪条目**：它其实是"`## ` 之前的文件头（用途说明 + 规矩）"，不是一条知识。
   * 实测噪声案例：查"互替组 顺序"时它靠"顺"字命中得 4 分、排在真命中之前——因为它比任何真条目都长，
   * 只要有一个字沾边就能攒分。**把文件头当条目 = 给检索器一个"永远能命中"的兜底项**，而兜底项
   * 恰恰是最该被排除的（它会把注意力从"没有命中"引向"好像命中了"）。
   * 文件头的规矩仍会被整读时看到（`boot` 的必读清单就是整读），不需要靠检索兜。
   */
  const real = out.filter((e) => !e.head || /^#{2,3}\s+/.test(e.lines[0] || ''));
  return real.map((e) => ({ title: e.title, body: e.lines.join('\n') }));
}

const STOP = new Set(['的', '了', '和', '与', '在', '是', '有', '我', '你', '他', '这', '那', '个', '怎么', '为什么', '如何', '什么', 'the', 'a', 'of', 'to', 'and', 'for', 'is']);
const tokenize = (s) => {
  const t = String(s || '').toLowerCase();
  const latin = t.match(/[a-z][a-z0-9_.-]{1,}/g) || [];
  const cjk = t.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  const bi = [];
  for (const run of cjk) { for (let i = 0; i < run.length - 1; i++) bi.push(run.slice(i, i + 2)); if (run.length >= 3) bi.push(run); }
  return [...new Set([...latin, ...bi])].filter((x) => !STOP.has(x));
};

/**
 * 检索打分：**标题命中权重 3、正文命中权重 1**，乘 IDF 软化系数 `1/(1+ln(df))`，并分两档：
 *   · **强命中（≥3.5）**：可以直接当依据用，答复里抄它的「权威依据」。
 *   · **弱候选（1.0~3.5）**：只是"沾边"，**不得直接当依据**——列出来是为了给人一个线索方向，
 *     而不是让客服把弱候选当结论（这正是 C-07 要防的"看起来命中"）。
 * 两处阈值都是实测噪声逼出来的：
 *   · 起初无 IDF、无下限：查"互替组 顺序"时文件头与命令速记靠"顺"字各得 4 分并排在真命中之前 ⇒ 噪声。
 *   · 随后 IDF 过猛（`1 − ln(df)/ln(N)`）：把"权限"这种**高频但关键**的词罚到近零 ⇒ 真命中一个都进不来
 *     （0 命中比噪声更糟：客服会以为 KB 根本没有这块知识，转而去猜）。
 * 结论：**区分度低 ≠ 无关**——要么降权保留（软化 IDF），要么明确标成"弱候选"，不要一端切掉。
 */
function cmdQuery(cfg, args) {
  const words = args._.slice(1);
  if (!words.length) { warn('用法：query <词...> [-k 8]'); return 2; }
  const k = Number(args.k || 8);
  const toks = tokenize(words.join(' '));
  const files = readKbFiles(cfg);
  if (!files.length) { warn(`工作区 KB 不存在或为空：${kbDir(cfg)} —— 先跑 init`); return 3; }
  const entries = [];
  for (const f of files) for (const e of splitEntries(f.text)) entries.push({ file: f.name, ...e });
  const df = new Map();
  for (const t of toks) {
    let n = 0;
    for (const e of entries) if ((e.title + '\n' + e.body).toLowerCase().includes(t)) n++;
    df.set(t, n);
  }
  const scored = [];
  const q = words.join(' ').toLowerCase();
  for (const e of entries) {
    const title = e.title.toLowerCase(); const hay = (e.title + '\n' + e.body).toLowerCase();
    let base = 0;
    let present = 0;
    for (const t of toks) {
      if (!hay.includes(t)) continue;
      present++;
      base += (title.includes(t) ? 3 : 1) * (1 / (1 + Math.log(df.get(t) || 1)));
    }
    if (base <= 0) continue;
    /**
     * **覆盖率激励**：命中词占查询词的比例，按平方计入（`coverage²`）。
     * 为什么需要它：KB 的每个文件**主题高度集中**——`plm-faq.md` 里 40% 的条目都含"权限"，
     * 于是 IDF 必然把"权限"罚得很低，**一篇真正讲该问题的条目反而进不了"强命中"**。
     * 这是"小语料 + 强主题"下 IDF 的固有偏差：**在这里区分度低的词，不代表它不关键**。
     * 覆盖率从另一头补：**答全了查询的所有词**才配叫强命中——它天然防"沾一个字就上榜"。
     */
    const coverage = present / Math.max(1, toks.length);
    // 整串短语命中（查询词连在一起出现在标题里）是最硬的证据，给一次高权加成
    const phraseBonus = (toks.length > 1 && title.includes(q.replace(/\s+/g, ''))) ? 6 : 0;
    const score = base * coverage * coverage + phraseBonus;
    if (score < 1.0) continue;
    scored.push({
      file: e.file, title: e.title, score: Math.round(score * 10) / 10, coverage: Math.round(coverage * 100) / 100,
      excerpt: e.body.split(/\r?\n/).filter((l) => l.trim() && !/^#/.test(l)).slice(0, 2).join(' ').slice(0, 220),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  /**
   * 三档分级（**"能不能当依据"必须由覆盖率说话，不能只由分数说话**）：
   *   · **强命中**：查询词**全覆盖** 且分数 ≥2.5 ⇒ 抄它的「权威依据」即可。
   *   · **可参考**：查询词全覆盖 但分数 <2.5 ⇒ 相关（只是用词在 KB 里太常见），**读它、按它的依据指针自行核对**，不要凭印象转述。
   *   · **弱候选**：**未全覆盖** ⇒ 只是沾边，**不得当依据**（C-07/C-08）。
   * 为什么要分"可参考"这一档：起初只两档，结果 `导出 分页` 这类**真命中被丢进"不得当依据"**
   * （分数 1.2 但覆盖率 100%）。把真命中与"沾一个字"混为一谈，会让客服对本该相信的条目也失去信心——
   * 这本身就是可信度门的失真。
   */
  const full = scored.filter((x) => x.coverage >= 0.999);
  const strong = full.filter((x) => x.score >= 2.5).slice(0, k);
  const reference = full.filter((x) => x.score < 2.5).slice(0, 3);
  const weak = scored.filter((x) => x.coverage < 0.999).slice(0, 3);

  if (!strong.length && !reference.length && !weak.length) {
    warn(`0 命中（词：${toks.join(',')}）——按 C-07/C-08：明确告知"未核实"并给验证方法，不要编`);
    return 4;
  }
  if (strong.length) {
    console.log(`${c.b}== 强命中 ${strong.length} 条（查询词全覆盖，可直接当依据）==${c.x}`);
    for (const h of strong) console.log(`\n[${h.score}] ${h.file} · ${h.title}\n    ${h.excerpt}`);
  }
  if (reference.length) {
    console.log(`\n${c.b}== 可参考 ${reference.length} 条（查询词全覆盖，但用词在 KB 中常见 ⇒ 请按其依据指针自行核对）==${c.x}`);
    for (const h of reference) console.log(`\n[${h.score}] ${h.file} · ${h.title}\n    ${h.excerpt}`);
  }
  if (!strong.length && !reference.length && weak.length) {
    warn(`无全覆盖命中（词：${toks.join(',')}）——下面只是弱候选，**不得直接当依据**；按 C-07/C-08 答复"未核实 + 验证路径"`);
    for (const h of weak) console.log(`\n[${h.score}·弱·覆盖${Math.round(h.coverage * 100)}%] ${h.file} · ${h.title}\n    ${h.excerpt}`);
  }
  return (strong.length || reference.length) ? 0 : 4;
}

function cmdBoot(cfg, args) {
  const budget = Number(args.budget || 200);
  const kb = kbDir(cfg);
  console.log(`${c.b}== PLM 客服开工包 ==${c.x}  家园=${kb}`);
  console.log('\n【必读（按序）】');
  let lines = 0;
  for (const [f, why] of BOOT_FILES) {
    const p = path.join(kb, f);
    if (fs.existsSync(p)) {
      const n = fs.readFileSync(p, 'utf8').split(/\r?\n/).length;
      lines += n;
      console.log(`  ${f.padEnd(30)} ${String(n).padStart(4)} 行   ${c.d}${why}${c.x}`);
    } else console.log(`  ${f.padEnd(30)} ${'—'.padStart(4)}      ${c.y}缺失（跑 init 安装种子）${c.x}`);
  }
  console.log(`\n【按需读（触发条件写在括号里）】`);
  for (const [f, why] of ON_DEMAND) {
    const p = path.join(kb, f);
    console.log(`  ${(fs.existsSync(p) ? f : f + '（缺）').padEnd(30)} ${c.d}${why}${c.x}`);
  }
  const words = args._.slice(1);
  if (words.length) {
    console.log(`\n【本次问题相关候选（词：${words.join(' ')}）】`);
    const rc = cmdQuery(cfg, { _: ['query', ...words], k: args.k || 6 });
    if (rc === 4) info('（KB 无命中：按 C-07/C-08 标注"未核实"+给验证方法）');
  }
  console.log(`\n必读合计约 ${lines} 行；建议预算 ≈ ${budget} 行（超预算说明 KB 该做 L2 整理了）。`);
  console.log('开工包结束 —— 看到本行说明输出完整（被管道截断时会看不到）。');
  return 0;
}

// ------------------------------------------------------------ append（写入纪律）

function nextId(text, prefix) {
  const re = new RegExp(`${prefix}-(\\d{3,})`, 'g');
  let max = 0; let m;
  while ((m = re.exec(text)) !== null) max = Math.max(max, Number(m[1]));
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

function cmdAppend(cfg, args) {
  const domain = String(args.domain || '');
  const map = { lessons: ['plm-lessons.md', 'L'], negatives: ['plm-negatives.md', 'N'], answer: ['plm-answer-quality.md', 'A'], voc: ['plm-voice-of-customer.md', 'VOC'], cluster: ['plm-pain-clusters.md', 'PC'] };
  if (!map[domain]) { warn(`--domain 取 ${Object.keys(map).join('/')}`); return 2; }
  const [file, prefix] = map[domain];
  const p = path.join(kbDir(cfg), file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : `# ${domain}\n\n`;
  const id = nextId(text, prefix);
  const title = String(args.title || '').trim();
  if (!title) { warn('--title 必填（一句话说明这条经验/负结果）'); return 2; }
  let body = args['body-file'] ? fs.readFileSync(path.resolve(cfg.root, String(args['body-file'])), 'utf8') : String(args.body || '');
  /**
   * 重复守卫：同标题（去空白后）已存在即拒绝——**教训条目重复 = 电容器污染**，
   * 而污染最难发现（读的人以为"两次都记了说明很重要"，实际是同一个坑记了两遍）。
   * 想补充内容请直接编辑既有条目（保持 ID 稳定，引用它的地方不会失效）。
   */
  const norm = (s) => s.replace(/\s+/g, '');
  if (text.split(/\r?\n/).some((l) => /^#{2,3}\s+/.test(l) && norm(l) === norm(title))) {
    warn(`已存在同标题条目，拒绝重复追加（请直接编辑既有条目）：${title}`);
    return 3;
  }
  const entry = [
    '', `## ${id} ${title}`,
    `- 时间: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    body.trim() ? body.trim() : '- （正文待补）',
    args.evidence ? `- 证据: ${args.evidence}` : null,
    '', '---', '',
  ].filter((x) => x !== null).join('\n');
  fs.appendFileSync(p, entry, 'utf8');
  ok(`已追加 ${id} → ${file}`);
  console.log(entry.trim());
  return 0;
}

// ------------------------------------------------------------ doctor

function cmdDoctor(cfg) {
  const kb = kbDir(cfg);
  let problems = 0;
  console.log(`${c.b}== PLM 客服电容器体检 ==${c.x}`);
  if (!fs.existsSync(kb)) { warn(`KB 目录不存在：${kb}（跑 init）`); return 5; }
  const files = readKbFiles(cfg);
  console.log(`KB 文件 ${files.length} 个：`);
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
    const n = f.text.split(/\r?\n/).length;
    const flag = n > 400 ? `${c.y}（>400 行，建议 L2 整理/拆分）${c.x}` : '';
    console.log(`  ${f.name.padEnd(38)} ${String(n).padStart(5)} 行 ${flag}`);
    if (n > 400) problems++;
  }
  for (const [f] of BOOT_FILES) if (!fs.existsSync(path.join(kb, f))) { warn(`缺必读文件：${f}`); problems++; }
  const ledger = path.join(kb, 'plm-registration-ledger.md');
  if (fs.existsSync(ledger)) {
    /**
     * 认"数据行"要用**行里有 `REQ-XXXX-XXXX` 编号**，不能用 `^\|\s*REQ-`。
     * 实测踩过（2026-09-27，第三次同类错误）：台账的**第一列是登记时间**，编号在第二列，
     * 于是 `^\|\s*REQ-` 恒不命中 ⇒ doctor 报"台账 0 条"，而台账里明明有一行。
     * 这类"自检判据与实际数据结构不一致"的 bug 最误导人：**它让系统否认自己刚做过的事**，
     * 于是人开始怀疑记账本身坏了（而不是怀疑自检）。
     * 教训：**自检的判据要锚在"内容特征"（编号形态）上，而不是"列位置/格式细节"上**。
     */
    const rows = fs.readFileSync(ledger, 'utf8').split(/\r?\n/).filter((l) => /^\|/.test(l) && /REQ-\d{4}-\d+/.test(l));
    // 编号在第 2 列（cells[0] 为空字符串，因为行以 `|` 开头）
    const lastCode = rows.length ? (rows[rows.length - 1].split('|')[2] || '').trim() : '';
    info(`登记台账：${rows.length} 条${lastCode ? `（最近：${lastCode}）` : ''}`);
  } else info('登记台账尚未生成（首次成功登记后由工具自动创建）');
  const cache = cfg.sessionCache;
  if (cache && fs.existsSync(cache)) {
    try {
      const s = JSON.parse(fs.readFileSync(cache, 'utf8'));
      info(`令牌缓存：user=${s.user} base=${s.base} refresh=${s.refresh_token ? '有' : '无'}`);
    } catch { warn('令牌缓存文件损坏（删掉即可，下次会重新登录）'); problems++; }
  } else info('无令牌缓存（首次调用会自动登录，需浏览器）');
  if (!fs.existsSync(path.join(cfg.root, '.env'))) { warn('缺 .env（登记/登录均不可用）'); problems++; }
  const tpl = tplDir(cfg);
  if (!fs.existsSync(tpl) || !fs.readdirSync(tpl).length) { warn('缺 .creature/templates/ 种子（跑 init）'); problems++; }
  console.log('');
  if (problems) { warn(`体检发现 ${problems} 项待处理`); return 5; }
  ok('体检通过');
  return 0;
}

// ------------------------------------------------------------ main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'boot';
  const cfg = loadConfig(process.cwd());
  const table = {
    init: () => cmdInit(cfg, args),
    boot: () => cmdBoot(cfg, args),
    query: () => cmdQuery(cfg, args),
    append: () => cmdAppend(cfg, args),
    doctor: () => cmdDoctor(cfg),
  };
  if (!table[cmd]) { warn(`未知子命令：${cmd}（可用 ${Object.keys(table).join('/')}）`); return 2; }
  return table[cmd]();
}

if (require.main === module) main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
module.exports = { BOOT_FILES, ON_DEMAND, splitEntries, tokenize };
