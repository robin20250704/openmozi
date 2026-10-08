#!/usr/bin/env node
/**
 * scripts/sync-plm-references.mjs — 把 PLM 的业务逻辑与技术实现文档**拷贝**进
 * agents/tiangong/references/，使小天（及随包的部署单元）不依赖 jcode 仓即可自足。
 *
 * 为什么要拷贝而不是在 references 里写引用（V-014 的例外要说清）：
 *   references/ 是天工客服的**打包单元**——部署到客户现场时只有 openmozi 这一个仓
 *   （见 docs/openmozi-multi-agent-deployment-guide.md 的部署边界）。若只留一条指向
 *   `D:\project\jcode` 的路径，离线部署就等于没有事实源：plm_read_reference 会在现场
 *   读不到任何东西，而"能读文档"正是小天不编造的前提。
 *
 * 三条纪律：
 *   ① **只拷贝，不改写内容**：除下面显式列出的脱敏替换外，逐字节保持一致（--check 守住）。
 *   ② **凭据不进包**：源文档里出现过真实口令明文，拷贝时必须脱敏；拷完还要**再扫一遍**
 *      确认没有残留——"脱敏动作本身没生效"是静默失败（L-133），所以它必须可判定。
 *   ③ **可复算**：PROVENANCE.md 记录每个源目录的文件数/字节数与逐文件 sha256，
 *      现场可以对账"这份参考资料是从哪一版拷来的"。
 *
 * 用法：
 *   node scripts/sync-plm-references.mjs            # 拷贝 + 脱敏 + 写 PROVENANCE
 *   node scripts/sync-plm-references.mjs --check     # 只核对，不写盘；有漂移则退出码 1
 *   PLM_DOCS_SRC=D:\project\jcode\docs node ...      # 换源目录
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SRC = process.env.PLM_DOCS_SRC || "D:\\project\\jcode\\docs";
const DEST = path.join(ROOT, "agents", "tiangong", "references");
const CHECK_ONLY = process.argv.includes("--check");

/** 要拷贝的两个目录名（用户 2026-09-28 明确指定） */
const DIRS = ["plm-reverse-engineering", "plm-tech"];

/**
 * 脱敏规则：路径 → 替换。
 *
 * 为什么要脱敏：`plm-tech/20-账户与密码管理设计.md` 里写着 Keycloak 迁移用的
 * **真实口令明文**（与部署时用的 PLM_PASSWORD 同一个值）。原件在 jcode 仓里，
 * 那里的风险是历史问题；但这份资料要被打包分发给多个部署现场，再抄一遍
 * 就是把一个能直接登录 PLM 的口令扩散到更多机器上。所以拷贝版本必须遮。
 *
 * 规则写成"显式路径 + 显式模式"而不是全局正则替换：宁可漏脱敏（被 ② 的残留扫描抓住），
 * 也不要误伤文档正文里的正常描述。
 */
const REDACTIONS = [
  {
    file: "plm-tech/20-账户与密码管理设计.md",
    pattern: /同一口令\s*`[^`\s]+`/g,
    replacement: "同一口令（迁移期统一口令；实际取值见部署包 agents/tiangong/.env 的 PLM_PASSWORD，不随文档分发）",
    why: "源文档含真实口令明文",
  },
];

/** 拷贝后必须为 0 的残留特征。刻意做得**很窄**，只打真实凭据，不打代码标识符。
 *  （A8 那条更宽的 `sk-…` 判据在 ta**sk-**domain-foundation.sql 这类文件名上会误报，
 *    收紧方式是加左侧词边界，见 verify-tiangong.mjs 的 A8/A8b。） */
const RESIDUAL_SECRET_PATTERNS = [
  { name: "疑似 API Key", re: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/ },
  { name: "AppSecret 明文", re: /AppSecret\s*[:=]\s*["'][^"']{8,}/i },
  { name: "client_secret 明文", re: /client_?secret\s*[:=]\s*["'][A-Za-z0-9]{16,}/i },
  { name: "口令明文赋值", re: /(?:password|passwd|口令|密码)\s*[:：=]\s*["'`]?[A-Za-z0-9@#!^&*._-]{8,}/i },
  { name: "PRIVATE KEY 块", re: /-----BEGIN [A-Z ]*PRIVATE KEY/ },
];

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else if (e.isFile()) out.push({ abs: full, rel: path.relative(base, full).split(path.sep).join("/") });
  }
  return out;
}

if (!fs.existsSync(SRC)) {
  console.error(`[sync-plm-refs] 源目录不存在：${SRC}\n  用 PLM_DOCS_SRC=<docs 目录> 指定。`);
  process.exit(2);
}

const report = [];
let totalFiles = 0, totalBytes = 0, changed = 0, drift = 0, redacted = 0;
const residual = [];

for (const d of DIRS) {
  const srcDir = path.join(SRC, d);
  if (!fs.existsSync(srcDir)) {
    console.error(`[sync-plm-refs] 缺少源目录：${srcDir}`);
    process.exit(2);
  }
  const files = walk(srcDir);
  const destDir = path.join(DEST, d);
  const seen = new Set();
  const manifest = [];
  for (const f of files) {
    const relInDest = f.rel;                 // 例如 plm-tech/backup/xx.md
    const key = `${d}/${f.rel}`;
    seen.add(key);
    let text = fs.readFileSync(f.abs, "utf8");
    for (const r of REDACTIONS) {
      if (r.file === key) {
        const n = (text.match(r.pattern) || []).length;
        text = text.replace(r.pattern, r.replacement);
        redacted += n;
      }
    }
    const buf = Buffer.from(text, "utf8");
    totalFiles++;
    totalBytes += buf.length;
    manifest.push(`${key}  ${String(buf.length).padStart(8)}B  sha256:${sha(buf)}`);

    for (const p of RESIDUAL_SECRET_PATTERNS) {
      if (p.re.test(text)) residual.push(`${key} :: ${p.name}`);
    }

    const outPath = path.join(DEST, key);
    const cur = fs.existsSync(outPath) ? fs.readFileSync(outPath) : null;
    const same = cur && cur.equals(buf);
    if (same) continue;
    if (CHECK_ONLY) {
      drift++;
      console.error(`[sync-plm-refs] 漂移：${key}（${cur ? "内容不一致" : "目标缺失"}）`);
    } else {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, buf);
      changed++;
    }
  }

  // --check 的另一半：目标里多出来的文件（本脚本不删文件，只报告，避免误删同目录的人工件）
  const destFiles = fs.existsSync(destDir) ? walk(destDir).map((f) => `${d}/${f.rel}`) : [];
  const extra = destFiles.filter((k) => !seen.has(k));
  if (extra.length) console.warn(`[sync-plm-refs] 提示：${d}/ 下有 ${extra.length} 个非本脚本产物（保持原样）：${extra.slice(0, 5).join(", ")}`);

  report.push({ dir: d, count: files.length, bytes: files.reduce((n, f) => n + fs.statSync(f.abs).size, 0), manifest });
}

if (residual.length) {
  console.error(`[sync-plm-refs] ❌ 拷贝结果里仍有疑似凭据（${residual.length} 处），不写 PROVENANCE，请先处理：\n  ${residual.slice(0, 20).join("\n  ")}`);
  process.exit(3);
}

const provPath = path.join(DEST, "PROVENANCE.md");
if (!CHECK_ONLY) {
  const lines = [
    "# 参考资料出处（PROVENANCE）",
    "",
    "本目录下的 `plm-reverse-engineering/`（业务逻辑）与 `plm-tech/`（技术实现）由脚本",
    "`scripts/sync-plm-references.mjs` 从外部文档仓**拷贝**而来，目的是让本 agent 的参考资料",
    "自足（可独立部署打包），不依赖那台机器上的另一个仓库。",
    "",
    `- 源目录：\`${SRC}\``,
    `- 拷贝目标：\`agents/tiangong/references/\``,
    `- 重新同步：\`node scripts/sync-plm-references.mjs\`；核对：\`node scripts/sync-plm-references.mjs --check\``,
    "",
    "## 脱敏记录（拷贝与原件的唯一差异）",
    "",
    "| 文件 | 处理 | 原因 |",
    "| --- | --- | --- |",
    ...REDACTIONS.map((r) => `| \`${r.file}\` | ${r.pattern} → 遮蔽 | ${r.why} |`),
    "",
    "> 原件（外部仓）仍含该口令明文，建议在源仓一并整改。",
    "",
    "## 清单（sha256 前 16 位）",
    "",
  ];
  for (const r of report) {
    lines.push(`### ${r.dir}/ — ${r.count} 个文件 / ${(r.bytes / 1024).toFixed(1)} KB`, "", "```");
    lines.push(...r.manifest);
    lines.push("```", "");
  }
  fs.writeFileSync(provPath, lines.join("\n"), "utf8");
}

const kb = (n) => (n / 1024).toFixed(1);
console.log(
  `[sync-plm-refs] ${CHECK_ONLY ? "核对" : "拷贝"}完成：${totalFiles} 个文件 / ${kb(totalBytes)}KB` +
  `｜脱敏规则 ${REDACTIONS.length} 条（命中 ${redacted} 处）｜写入 ${changed} 个｜漂移 ${drift} 个｜残留凭据 ${residual.length} 处` +
  `${CHECK_ONLY ? "" : `｜PROVENANCE.md 已写：${path.relative(ROOT, provPath)}`}`
);
if (CHECK_ONLY && drift > 0) process.exit(1);
