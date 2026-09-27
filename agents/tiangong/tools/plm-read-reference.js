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
//   ③ 单次返回限长：超大文件（如 57KB 的系统地图）按段返回并告知续读偏移，
//      免得一次把上下文烧光——"读文件"不该变成"把整个 KB 灌进去"。
import fs from "node:fs";
import path from "node:path";
import { REFERENCES_DIR } from "../lib/plm-cli.js";

const MAX_CHARS = 20_000; // 单次返回上限（约 20K 字符；超出部分靠 offset 续读）

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

export const plmReadReferenceTool = {
  name: "plm_read_reference",
  label: "读参考资料（只读）",
  description:
    "读取小天自己的参考资料（**只读**，且限定在 agents/tiangong/references/ 目录内）。" +
    "不传 path 时返回可读文件清单。这些资料是 PLM 客服的事实源：" +
    "kb/plm-module-map.md（系统地图：侧边栏/路由/IPD 主线/角色边界）、kb/plm-faq.md（权威答复库）、" +
    "kb/plm-known-deviations.md（已知偏差 + 分诊表）、kb/plm-requirement-intake-schema.md（需求登记字段与词表）、" +
    "sub-skills/（答客导航 / 需求结构化 / 登记规程）、templates/（草稿与会话模板）。" +
    "大文件请用 offset 续读；不要把整份文件一次性读进回答里。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "references/ 下的相对路径，如 kb/plm-known-deviations.md；缺省=列目录" },
      offset: { type: "number", description: "从第几个字符开始读（缺省 0）" },
      limit: { type: "number", description: "最多读多少字符（缺省 20000，上限 20000）" },
    },
    required: [],
  },
  async execute(_toolCallId, params) {
    try {
      const rel = String(params?.path ?? "").trim();
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
        return { content: [{ type: "text", text: listTree(target, rel).join("\n") }] };
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
