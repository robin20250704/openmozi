// agents/tiangong/lib/plm-cli.js
//
// PLM 命令行器官的**唯一调用出口**（小天用）。
//
// 为什么要有这一层而不是每个工具各自 spawn：
//   ① 调用纪律要一致 —— 只读子命令与"会落库"的子命令必须用不同口径（见下）；
//   ② 输出形态要一致 —— PLM 工具是给人看的彩色文本，模型需要的是**结构化结果**；
//   ③ 失败口径要一致 —— exit code 的语义（0 成功 / 1 失败 / 2 用法错 / 3 有疑似重复）
//      必须翻译成模型能判断的字段，而不是把一坨文本丢回去让它猜。
//
// ⚠️ 工作目录 = `agents/tiangong/`（不是 runtime/openmozi/）。
//    `plm-sso.cjs` 的 loadConfig 会向上找**最近的含 `.env` 或 `.creature/` 的祖先**当工作区根；
//    本 agent 目录里两样都有，所以它稳定停在这里：
//      · 凭据来自 `agents/tiangong/.env`
//      · token 缓存、登记台账落在 `agents/tiangong/.{cache,creature}/`
//    这也是"把账号密码存进 agent 运行目录"这条需求能成立的原因 —— 换成 runtime 根就会串到别的域。
//    兜底：plm-cli 自己再显式设一遍 PLM_SESSION_CACHE（相对路径以 root 解析），
//    免得将来有人把 .creature 目录删了导致缓存落到别处。

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** agent 运行目录（= 工作区根）= agents/tiangong/ */
export const AGENT_DIR = path.resolve(HERE, "..");
export const REFERENCES_DIR = path.join(AGENT_DIR, "references");
const TOOLS_DIR = path.join(REFERENCES_DIR, "tools");
const REQ_SCRIPT = path.join(TOOLS_DIR, "plm-req.cjs");

/** 只读子命令白名单：碰不到 PLM 数据、只读本地缓存/远端查询 */
const READ_ONLY_SUBCOMMANDS = new Set([
  "check", "whoami", "projects", "classes", "list", "get", "dedup", "track", "doctor",
]);

/**
 * 调用 `plm-req.cjs` 的某个子命令。
 *
 * @param {string} subcommand 子命令（必须在上面的白名单或写命令白名单里）
 * @param {string[]} args     附加参数（**由本文件按固定形状拼**，不接受模型自由拼装）
 * @param {{timeoutMs?: number, allowWrite?: boolean}} opts
 * @returns {Promise<{ok: boolean, exitCode: number, subcommand: string, stdout: string, stderr: string, error?: string}>}
 */
export function runPlmCli(subcommand, args = [], opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  if (!READ_ONLY_SUBCOMMANDS.has(subcommand) && subcommand !== "submit") {
    return Promise.resolve({
      ok: false, exitCode: 2, subcommand, stdout: "", stderr: "",
      error: `不允许的子命令：${subcommand}（只读命令与 submit 之外的写操作为禁用面）`,
    });
  }
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [REQ_SCRIPT, subcommand, ...args],
      {
        cwd: AGENT_DIR,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        // UAT 是自签证书：只影响"探测可达性"这一步（真登录走浏览器，证书由工具自己忽略）。
        // 显式写在这里而不是让 .env 承担，是为了让"为什么允许不安全 TLS"有唯一可读的解释点。
        env: {
          ...process.env,
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
          PLM_SESSION_CACHE: process.env.PLM_SESSION_CACHE || path.join(AGENT_DIR, ".cache", "plm-session.json"),
        },
      },
      (err, stdout, stderr) => {
        const exitCode = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        const out = String(stdout || "");
        const errOut = String(stderr || "");
        // 去掉 node 的 TLS 警告噪音（它每次都会打，混在结果里会干扰模型读输出）
        const cleanErr = errOut.split(/\r?\n/).filter((l) => !/NODE_TLS_REJECT_UNAUTHORIZED|trace-warnings/.test(l)).join("\n").trim();
        const hitTimeout = Boolean(err && err.killed);
        resolve({
          ok: exitCode === 0,
          exitCode,
          subcommand,
          stdout: out.trim(),
          stderr: cleanErr,
          ...(hitTimeout ? { error: `命令超时（${timeoutMs}ms）——PLM 侧可能正在起浏览器登录，稍后重试或先跑 plm_check_env` } : {}),
        });
      }
    );
  });
}

/** 从工具输出里抠出第一段完整 JSON（工具常先打人类可读的标题行，再打 JSON） */
export function firstJson(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  if (start < 0) return null;
  for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* 再往前缩 */ }
  }
  return null;
}

/**
 * 把一次 CLI 调用收敛成**给模型看的**结果：
 * 结构化字段 + 被裁剪过的原始输出（保底可读，但不把 20KB 帮助文本灌进上下文）。
 * 纪律：`ok=false` 时**必须**把错误原文带上——这是"答不了就说清楚"的依据（prompt §事实纪律）。
 */
export function toToolResult(r, { maxChars = 4000 } = {}) {
  const parsed = firstJson(r.stdout);
  const payload = {
    ok: r.ok,
    exit_code: r.exitCode,
    subcommand: r.subcommand,
    ...(parsed ? { result: parsed } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.stderr ? { stderr: r.stderr.slice(0, 1500) } : {}),
  };
  const raw = r.stdout.length > maxChars ? r.stdout.slice(0, maxChars) + `\n…（输出过长已截断，共 ${r.stdout.length} 字符）` : r.stdout;
  return { payload, raw };
}
