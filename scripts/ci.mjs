#!/usr/bin/env node
/**
 * scripts/ci.mjs — OpenMozi 单一版本流水线（唯一发布入口）
 *
 * 解决的病：src/*.ts 是源码、dist/*.js 是构建产物（且被 .gitignore），
 * 但历史上的修复被直接改在 dist 里 → 两份真相 → 重新构建会静默回退修复。
 * 本流水线确立：**dist 只允许由 src 构建产生**，任何绕过构建的改动都会被拦下。
 *
 * 用法：
 *   node scripts/ci.mjs            完整流水线：构建 → 漂移校验 → 部署重启 → 健康检查 → 端到端验收
 *   node scripts/ci.mjs --check    只做构建一致性校验（秒级，提交前/钩子用）
 *   node scripts/ci.mjs --no-deploy 不重启网关（只构建+校验）
 *   node scripts/ci.mjs --no-e2e   构建+部署+健康检查，跳过端到端
 */
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");
const STAMP = path.join(DIST, ".build-stamp.json");
const PORT = Number(process.env.GATEWAY_PORT || 33000);
const LAUNCHER = "junwuyou-launcher.mjs";

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes("--check");
const NO_DEPLOY = args.includes("--no-deploy");
const NO_E2E = args.includes("--no-e2e");
/** 可替换的启动器：用于"环境需要额外装配"的批次（如从仓库根 .env 注入共享凭据） */
const LAUNCHER_OVERRIDE = (() => {
  const i = args.indexOf("--launcher");
  return i >= 0 ? args[i + 1] : null;
})();
const LAUNCHER_ARG = LAUNCHER_OVERRIDE
  ? path.resolve(ROOT, LAUNCHER_OVERRIDE)
  : null;

const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", b: "\x1b[36m", d: "\x1b[90m", x: "\x1b[0m" };
const log = (m) => console.log(m);
const step = (m) => log(`\n${C.b}━━━ ${m} ━━━${C.x}`);
const ok = (m) => log(`  ${C.g}✅${C.x} ${m}`);
const bad = (m) => log(`  ${C.r}❌${C.x} ${m}`);
const warn = (m) => log(`  ${C.y}⚠️${C.x} ${m}`);

const failures = [];
const fail = (m) => { failures.push(m); bad(m); };

/** 对目录做确定性指纹（排序后逐文件 sha256） */
function fingerprint(dir, { skip = [] } = {}) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (skip.some((s) => p === s)) continue;
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  if (!fs.existsSync(dir)) return { hash: "MISSING", count: 0 };
  walk(dir);
  const h = createHash("sha256");
  for (const f of files) {
    h.update(path.relative(dir, f).replace(/\\/g, "/"));
    h.update(fs.readFileSync(f));
  }
  return { hash: h.digest("hex"), count: files.length };
}

function readStamp() {
  try {
    return JSON.parse(fs.readFileSync(STAMP, "utf8"));
  } catch {
    return null;
  }
}

// ───────────────────────── 1. 构建一致性校验（--check） ─────────────────────────
if (CHECK_ONLY) {
  step("构建一致性校验（src ⇄ dist）");
  const src = fingerprint(SRC);
  const dist = fingerprint(DIST, { skip: [STAMP] });
  const stamp = readStamp();

  if (!stamp) {
    fail("缺少构建标记 dist/.build-stamp.json —— 请先运行 `node scripts/ci.mjs`（或 npm run ci）");
  } else {
    src.hash === stamp.srcHash
      ? ok(`src 与上次构建一致（${src.count} 文件）`)
      : fail(`src 有改动但未重新构建 —— 运行 \`npm run ci\`（src ${stamp.srcHash.slice(0, 8)} → ${src.hash.slice(0, 8)}）`);
    dist.hash === stamp.distHash
      ? ok(`dist 与构建产物一致（${dist.count} 文件）`)
      : fail(`dist 被绕过构建直接改动 —— 请改 src 后运行 \`npm run ci\`（禁止手改 dist）`);
  }

  log(failures.length === 0 ? `\n${C.g}校验通过：dist 就是 src 的构建产物，单一版本 ✅${C.x}` : `\n${C.r}校验失败：${failures.length} 项${C.x}`);
  process.exit(failures.length ? 1 : 0);
}

// ───────────────────────── 2. 构建 ─────────────────────────
step("1/5 构建（src → dist）");
const build = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], { cwd: ROOT, stdio: "inherit" });
if (build.status !== 0) {
  fail(`tsc 构建失败（exit ${build.status}）`);
  log(`\n${C.r}构建未通过，流水线中止${C.x}`);
  process.exit(1);
}
ok("tsc 构建成功、0 编译错误");

// 非 TS 的运行期模块也要做语法自检：prompt-junwuyou.mjs / junwuyou-launcher.mjs /
// pi-anthropic-patch.mjs / junwuyou/**/*.js 都不经 tsc。曾经因为 prompt 里漏了一个
// 字符串结束符，网关重启后直接起不来（服务中断）——语法错误必须在**部署之前**拦下。
const CHECK_FILES = [
  "prompt-junwuyou.mjs", "junwuyou-launcher.mjs", "pi-anthropic-patch.mjs", "config-adapter.mjs",
];
const walkJs = (dir, acc = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p, acc);
    else if (/\.(mjs|cjs|js)$/.test(e.name)) acc.push(p);
  }
  return acc;
};
for (const p of walkJs(path.join(ROOT, "agents", "junwuyou")).filter((f) => !f.includes("node_modules"))) CHECK_FILES.push(path.relative(ROOT, p));
const syntaxBad = [];
for (const rel of CHECK_FILES) {
  const r2 = spawnSync(process.execPath, ["--check", rel], { cwd: ROOT, encoding: "utf8" });
  if (r2.status !== 0) syntaxBad.push(`${rel}: ${(r2.stderr || "").split("\n").filter(Boolean).slice(-3).join(" ")}`);
}
if (syntaxBad.length) {
  fail(`运行期模块语法错误 ${syntaxBad.length} 个（部署已中止）`);
  syntaxBad.forEach((s) => log(`     ${C.d}${s.slice(0, 160)}${C.x}`));
  log(`\n${C.r}语法自检未通过，流水线中止（未重启服务）${C.x}`);
  process.exit(1);
}
ok(`运行期模块语法自检通过（${CHECK_FILES.length} 个文件）`);

const srcFp = fingerprint(SRC);
const distFp = fingerprint(DIST, { skip: [STAMP] });
fs.writeFileSync(
  STAMP,
  JSON.stringify({ srcHash: srcFp.hash, distHash: distFp.hash, srcFiles: srcFp.count, distFiles: distFp.count, builtAt: new Date().toISOString() }, null, 2)
);
ok(`已写入构建标记：dist ${distFp.count} 文件 ⇄ src ${srcFp.count} 文件`);

if (NO_DEPLOY) {
  log(`\n${C.g}构建完成（--no-deploy，未重启服务）${C.x}`);
  process.exit(0);
}

// ───────────────────────── 3. 部署（重启网关） ─────────────────────────
function findPidOnPort(port) {
  const r = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
  for (const line of (r.stdout || "").split(/\r?\n/)) {
    if (line.includes(`:${port}`) && /LISTENING/i.test(line)) {
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function restartGateway() {
  const old = findPidOnPort(PORT);
  if (old) {
    try { process.kill(old); } catch { /* 已退出 */ }
    for (let i = 0; i < 30 && findPidOnPort(PORT); i++) await sleep(500);
    ok(`已停止旧实例（pid ${old}）`);
  } else {
    ok("无旧实例在运行");
  }
  const out = fs.openSync(path.join(ROOT, "launcher.log"), "w");
  const err = fs.openSync(path.join(ROOT, "launcher-err.log"), "w");
  const launcherPath = LAUNCHER_ARG || LAUNCHER;
  const child = spawn("node.exe", ["--max-old-space-size=4096", launcherPath], {
    cwd: ROOT, detached: true, stdio: ["ignore", out, err],
  });
  child.unref();
  ok(`已启动新实例（pid ${child.pid}${LAUNCHER_ARG ? `，launcher=${path.basename(launcherPath)}` : ""}）`);
}

async function waitReady(timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (findPidOnPort(PORT)) return true;
    await sleep(1000);
  }
  return false;
}

step("2/5 部署（重启网关）");
await restartGateway();
if (!(await waitReady())) {
  fail(`网关 90000ms 内未监听 ${PORT}`);
  log(`\n${C.r}部署失败${C.x}`);
  process.exit(1);
}
ok(`网关已监听 ${PORT}`);

// ───────────────────────── 4. 健康检查 ─────────────────────────
step("3/5 健康检查");
try {
  const resp = await fetch(`http://127.0.0.1:${PORT}/`);
  const html = await resp.text();
  resp.status === 200 ? ok("HTTP 200（Web UI 可访问）") : fail(`HTTP ${resp.status}`);
  html.includes("小君") ? ok("页面标题含正确身份「小君」") : fail("页面未含「小君」——身份可能仍是上游默认人格");
  html.includes("墨子") && fail("页面仍含上游默认人格「墨子」");
} catch (e) {
  fail(`HTTP 探测失败：${e.message}`);
}

const errLog = fs.existsSync(path.join(ROOT, "launcher-err.log")) ? fs.readFileSync(path.join(ROOT, "launcher-err.log"), "utf8") : "";
errLog.trim() === "" ? ok("stderr 干净") : warn(`stderr 有输出（前 200 字）：${errLog.trim().slice(0, 200)}`);

// ───────────────────────── 5. 端到端验收 ─────────────────────────
if (NO_E2E) {
  log(`\n${failures.length ? C.r + "流水线失败：" + failures.length + " 项" + C.x : C.g + "流水线通过（--no-e2e，未跑端到端）" + C.x}`);
  process.exit(failures.length ? 1 : 0);
}

function runNode(script, label, extraArgs = []) {
  const r = spawnSync(process.execPath, [script, ...extraArgs], { cwd: ROOT, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  // 优先取"合计"行（多段 harness 有小计与合计之分），否则取首个汇总
  const m = out.match(/合计\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/) || out.match(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败/);
  const passed = r.status === 0;
  const detail = m ? `(${m[1]} 通过 / ${m[2]} 失败)` : "";
  passed ? ok(`${label} ${detail}`) : fail(`${label} ${detail}`.trim());
  if (!passed) log(out.split("\n").slice(-14).map((l) => `     ${C.d}${l}${C.x}`).join("\n"));
  return passed;
}

step("4/5 检索层单元断言");
runNode("scripts/verify-faq-search.mjs", "FAQ 五层检索断言");

step("5/5 端到端验收");
runNode("verify-profile-cache.mjs", "档案/缓存/压缩配置（31 断言）");
runNode("verify-qq-conversation-fixes.mjs", "QQ 会话缺陷回归（时间/slot/确认闸门/报价/渠道格式/压缩安全）");
// 唯一断言"落库订单行"的用例：只有它能抓到订单归属错误（customer_id 错挂到别人名下，
// 单元测试与话术断言全绿也发现不了）。会自动取消测试订单，不占用真实排期。
runNode("test-e2e-order-flow.mjs", "完整下单链路走查（真实落库断言 13 例，自动清理）");
runNode("test-e2e-chat.mjs", "基础对话（4 例）");
runNode("test-e2e-paraphrase.mjs", "改写与库外提问（4 例）");
runNode("test-e2e-memory.mjs", "多轮记忆（3 例）");

// 「重启后不失忆」是客户可见缺陷的回归防线：必须跨真实重启验证
step("5b/5 跨重启记忆（两点式验收）");
const p1 = spawnSync(process.execPath, ["test-e2e-reconnect.mjs", "phase1"], { cwd: ROOT, encoding: "utf8" });
if (p1.status !== 0) {
  fail("phase1（给出信息）失败");
} else {
  ok("phase1 完成：客户已给出地址+面积+虫害");
  await restartGateway();
  if (!(await waitReady())) {
    fail("phase2 前重启网关失败");
  } else {
    ok("网关已重启（内存会话清空）");
    runNode("test-e2e-reconnect.mjs", "重启后恢复上下文", ["phase2"]);
  }
}

// 作业层（P0.5）：自带临时业务库 + 独立端口 + 高德 stub，**不碰生产库、不重启网关**
// —— 生产库已被测试数据污染（附录 D8/D9），这条 harness 刻意不再加剧
step("5c/5 作业层验收（P0.5 师傅端：身份/打卡/位置三级兜底/合规/密码安全）");
runNode("scripts/verify-worker-p05.mjs", "作业层断言 A17–A24（60 断言，隔离库）");

// 安全前置（P0）：分组 token + fail-closed。
// 用 --quick：其内部的 E2E 子套件（QQ/下单/作业层）已由 5/5、5c 覆盖，
// 这里不重复跑（省时，且避免同一批真实订单被重复写入）。
// 隔离实例用于验证 fail-closed 与 ALLOW_INSECURE 语义（不能拿线上服务做实验），
// 线上态探针用于验证"凭据真的配齐了"（只验隔离变体会漏掉漏配凭据这一类事故）。
step("5d/5 安全前置验收（P0：鉴权全覆盖 + fail-closed + 监听面，A16a–A16j）");
runNode("scripts/verify-p0-auth.mjs", "P0 鉴权断言（隔离实例 + 线上态探针）", ["--quick"]);

// 残留收尾（P0.7）：主管工作台（录单/在岗看板）+ R1 修复 + 监听面收敛。
// 用 --quick：重套件（记忆连跑 2 次 / 作业层 / QQ / 下单）已由 5/5、5b、5c 覆盖。
// 隔离实例用于"真的录单/指派/改派"（不能拿生产库做写操作）；
// 线上态探针用于断言**部署态**（监听面是否真的收敛、R1 是否真的修好）—— L-085/V-019。
step("5e/5 残留收尾验收（P0.7：主管录单/在岗看板/R1/监听面，A30–A34）");
runNode("scripts/verify-p07-admin.mjs", "P0.7 断言（隔离实例 + 线上态探针）", ["--quick"]);

// 客户身份汇聚 + 邮件渠道（P0.6）：隔离 Express + 隔离网关（独立端口与临时 .env 副本，
// 不碰生产库、不碰线上 33000）。邮件组需要真实 LLM（走 launcher 同一条运行时链路）。
// 这组断言的价值在于**跨渠道汇聚**：单渠道断言全绿也发现不了"会话键没按客户汇聚"。
step("5f/5 客户身份汇聚 + 邮件渠道验收（P0.6：A25–A29 + 部署态探针）");
runNode("scripts/verify-p06-identity.mjs", "身份汇聚/邮件渠道断言（A25–A29）", []);

const s = readStamp();
log(`\n${"─".repeat(52)}`);
if (failures.length === 0) {
  log(`${C.g}流水线通过 ✅  dist ⇄ src 单一版本${C.x}`);
  log(`${C.d}构建标记：src ${s.srcHash.slice(0, 8)} / dist ${s.distHash.slice(0, 8)} @ ${s.builtAt}${C.x}`);
} else {
  log(`${C.r}流水线失败：${failures.length} 项${C.x}`);
  failures.forEach((f) => log(`  ${C.r}·${C.x} ${f}`));
}
process.exit(failures.length ? 1 : 0);
