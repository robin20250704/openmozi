// agents/tiangong/tools/plm-read-reference.js
//
// plm_read_reference：读小天自己的参考资料（**只读，且在 references/ 目录里**）。
//
// 为什么只有这一个文件类工具：
//   用户明确要求"去掉写文件工具、写代码工具；只能读文件"。
//   pi 的内置文件工具（read/bash/edit/write/grep/ls…）在装配时就被 `noTools: "builtin"` 关掉了
//   （runtime.ts），所以这里必须提供一个**受约束的**读入口，否则小天连自己的 FAQ/系统地图都看不到。
//
// 安全边界（三条，全部硬编码，不接受参数放宽）：
//   ① 路径必须落在 `agents/tiangong/references/` 内 —— `path.resolve` 之后做前缀校验，
//      `../` 攀爬与绝对路径都会被拒（Windows 的 `\` 与 `/` 都会被 normalize）。
//   ② 只读，永不写；没有"创建/追加/覆盖"这种参数。
//      唯一的写入通道是 `plm_faq_propose`，它只能往 53112 的候选台账追加一行（见 tools/plm-faq-propose.js）。
//   ③ 单次返回限长：超大文件（如 57KB 的系统地图）按段返回并告知续读偏移，
//      免得一次把上下文烧光——"读文件"不该变成"把整个 KB 灌进去"。
//
// 2026-09-28：参考资料扩容到 90 个文件（copied plm-tech/ + plm-reverse-engineering/，1.87MB）。
// 扩容带来两个新问题，这里各自对应一处改动：
//   A) "列目录"再逐行打印 90 个文件 = 每次都烧掉几千字符上下文，却几乎不含信息。
//      → 顶层改为**分组摘要**（每个语料库多少文件/多大/含哪些子目录），要看细节再指定子目录。
//   B) 90 个文件没法靠肉眼翻找。
//      → 增加 `q` 子串检索（只读、只命中 references 内、限条数），让小天能定位到"哪一份文档第几行"再定点续读。
import fs from "node:fs";
import path from "node:path";
import { REFERENCES_DIR } from "../lib/plm-cli.js";

const MAX_CHARS = 20_000;   // 单次读取上限（约 20K 字符；超出部分靠 offset 续读）
const MAX_GREP_HITS = 40;   // 子串检索最多回多少条命中

/** 把相对路径解析到 references 内；越界即抛错（不返回 null —— 静默失败比报错危险） */
function resolveInside(rel) {
  const target = path.resolve(REFERENCES_DIR, rel || ".");
  const base = path.resolve(REFERENCES_DIR);
  const inBase = target === base || target.startsWith(base + path.sep);
  if (!inBase) {
    throw new Error(`路径越界：只允许读 references/ 目录内的文件（收到：${rel}）`);
  }
  return target;
}

/** 列出参考资料清单（当 path 缺省或指向目录时） */
function listTree(dir, prefix = "", depth = 0) {
  if (depth > 3) return [];
  const lines = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      lines.push(`📁 ${rel}/`);
      lines.push(...listTree(full, rel, depth + 1));
    } else {
      const size = fs.statSync(full).size;
      lines.push(`   ${rel}  （${(size / 1024).toFixed(1)}KB）`);
    }
  }
  return lines;
}

/** 递归统计某个目录的文件数与字节数（用于顶层摘要） */
function statTree(dir) {
  let files = 0, bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { const s = statTree(full); files += s.files; bytes += s.bytes; }
    else if (entry.isFile()) { files++; bytes += fs.statSync(full).size; }
  }
  return { files, bytes };
}

/**
 * 顶层摘要：references/ 现在有 90 个文件，逐行列出来等于给模型灌噪声。
 * 只回答"哪个语料库、装了什么、多大"——真要看细节自己带 path 进来。
 */
function listRootSummary() {
  const lines = [`📁 references/ 顶层（共 ${statTree(REFERENCES_DIR).files} 个文件）`, ""];
  for (const entry of fs.readdirSync(REFERENCES_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(REFERENCES_DIR, entry.name);
    if (entry.isDirectory()) {
      const s = statTree(full);
      const sub = fs.readdirSync(full, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${e.name}/`);
      lines.push(`📁 ${entry.name}/  — ${s.files} 个文件 / ${(s.bytes / 1024).toFixed(0)}KB${sub.length ? `  子目录：${sub.join("、")}` : ""}`);
    } else {
      lines.push(`   ${entry.name}  （${(fs.statSync(full).size / 1024).toFixed(1)}KB）`);
    }
  }
  lines.push(
    "",
    "怎么读：带 path=<目录或文件> 看具体内容；带 q=<关键词> 在 references 内做子串检索并返回 文件:行号。",
  );
  return lines;
}

/** 子串检索：返回 `文件:行号: 该行片段`。字面量匹配（不编译正则，避免构造出灾难性回溯）。 */
function grepReferences(q, subdir) {
  const needle = q.toLowerCase();
  const hits = [];
  let scanned = 0;
  const walk = (dir) => {
    if (hits.length >= MAX_GREP_HITS) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (hits.length >= MAX_GREP_HITS) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(md|json|js|cjs|mjs|txt)$/i.test(entry.name)) continue;
      scanned++;
      const rel = path.relative(REFERENCES_DIR, full).split(path.sep).join("/");
      const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < MAX_GREP_HITS; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          const preview = lines[i].trim().slice(0, 160);
          hits.push(`${rel}:${i + 1}: ${preview}`);
        }
      }
    }
  };
  walk(resolveInside(subdir || "."));
  return { scanned, hits };
}

export const plmReadReferenceTool = {
  name: "plm_read_reference",
  label: "读参考资料（只读）",
  description:
    "读取小天自己的参考资料（**只读**，且限定在 agents/tiangong/references/ 目录内）。三种用法：" +
    "① 不传 path = 看语料库清单摘要；② path=<目录或文件> 看具体内容（大文件用 offset 续读，" +
    "单次最多 20000 字符，别把整份文件搬进回答）；③ q=<关键词> 在 references 内做子串检索，" +
    "返回 `文件:行号: 片段`，用来定位「该读哪一份的第几行」。" +
    "四个语料库：kb/ 是 PLM 客服的权威事实源（plm-module-map 系统地图、plm-faq 权威答复库、" +
    "plm-known-deviations 已知偏差与分诊表、plm-requirement-intake-schema 需求登记字段与词表）；" +
    "plm-tech/ 是技术实现（01–31 编号文档 + frontend/ ipd-extension/ backup/）；" +
    "plm-reverse-engineering/ 是业务逻辑（business-rules/ interfaces/ ontology/ inventory/）；" +
    "另有 sub-skills/ 与 templates/。出处与脱敏记录见 PROVENANCE.md。" +
    "注意：plm-tech 与 plm-reverse-engineering 是**深挖用的工程资料**（接口、表结构、约束、前端实现），" +
    "答客优先走 kb/ 与 faq_search，只有要解释『为什么这么设计』『这个字段/单据到底怎么落库』时才进 plm-tech。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "references/ 下的相对路径，如 kb/plm-known-deviations.md、plm-tech/frontend；缺省=列顶层摘要" },
      q: { type: "string", description: "子串关键词；给定则在 references 内检索并返回 文件:行号:片段（最多 40 条）" },
      offset: { type: "number", description: "从第几个字符开始读（缺省 0）" },
      limit: { type: "number", description: "最多读多少字符（缺省 20000，上限 20000）" },
    },
    required: [],
  },
  async execute(_toolCallId, params) {
    try {
      const rel = String(params?.path ?? "").trim();
      const q = String(params?.q ?? "").trim();

      // 检索模式：不要求 path 存在，先搜再说（"我有印象但记不清在哪儿"是这个工具的主要用途）
      if (q) {
        const { scanned, hits } = grepReferences(q, rel);
        const head = `【在 ${rel || "references/"} 内检索「${q}】：扫了 ${scanned} 个文件，命中 ${hits.length} 条${hits.length >= MAX_GREP_HITS ? `（已截断在 ${MAX_GREP_HITS} 条，请缩小关键词或用 path 限定范围）` : ""}\n\n`;
        return {
          content: [{ type: "text", text: hits.length ? head + hits.join("\n") + "\n\n（下一步：用 path=<命中文件> 配合 offset/limit 读那一段）" : head + "无命中：换关键词，或改查 faq_search / 直接说明未收录。" }],
        };
      }

      const target = resolveInside(rel || ".");
      if (!fs.existsSync(target)) {
        const near = fs.readdirSync(path.dirname(target) === target ? REFERENCES_DIR : path.dirname(target), { withFileTypes: true })
          .slice(0, 20).map((e) => e.name).join(", ");
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: `文件不存在：${rel}`, 同级目录下有: near }) }],
          isError: true,
        };
      }
      if (fs.statSync(target).isDirectory()) {
        const body = (rel && rel !== "." && rel !== "") ? listTree(target, rel) : listRootSummary();
        return { content: [{ type: "text", text: body.join("\n") }] };
      }
      const text = fs.readFileSync(target, "utf8");
      const offset = Math.max(0, Number(params?.offset) || 0);
      const limit = Math.min(MAX_CHARS, Math.max(500, Number(params?.limit) || MAX_CHARS));
      const slice = text.slice(offset, offset + limit);
      const more = offset + limit < text.length;
      const head = `【${rel}】字符 ${offset}–${offset + slice.length} / 共 ${text.length}${more ? `（未完，续读请传 offset=${offset + limit}）` : "（已到末尾）"}\n\n`;
      return { content: [{ type: "text", text: head + slice }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }], isError: true };
    }
  },
};
