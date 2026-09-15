// scripts/migrate-prompt.mjs — 一次性：把 launcher 内联提示词换成 prompt-junwuyou.mjs 模块
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const f = path.join(ROOT, "junwuyou-launcher.mjs");
let src = fs.readFileSync(f, "utf8");

// 1) 加 import
if (!src.includes("prompt-junwuyou.mjs")) {
  src = src.replace(
    'import { setOpenmoziSystemPrompt } from "./pi-anthropic-patch.mjs";',
    'import { JUNWUYOU_PROMPT } from "./prompt-junwuyou.mjs";\nimport { setOpenmoziSystemPrompt } from "./pi-anthropic-patch.mjs";'
  );
}

// 2) 替换 setOpenmoziSystemPrompt(...) 整块（从调用处到紧随其后的 ");")
const start = src.indexOf("setOpenmoziSystemPrompt(");
if (start === -1) throw new Error("找不到 setOpenmoziSystemPrompt 调用");
const endMarker = "`,\n);\n";
const end = src.indexOf(endMarker, start);
if (end === -1) throw new Error("找不到提示词块结尾");

const replacement = 'setOpenmoziSystemPrompt(\n  process.env.OPENMOZI_AGENT_PROMPT || JUNWUYOU_PROMPT,\n);\n';
src = src.slice(0, start) + replacement + src.slice(end + endMarker.length);
fs.writeFileSync(f, src, "utf8");
console.log("✅ 已替换提示词块，新长度:", src.length);
