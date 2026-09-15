#!/usr/bin/env node
/**
 * scripts/install-hooks.mjs — 安装 git 钩子，让"绕过构建直接改 dist / 改了 src 忘记构建"无法被提交
 * 幂等：重复执行只覆盖本工具自己写的钩子（以标记行识别，不覆盖他人的钩子内容）
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const r = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: ROOT, encoding: "utf8" });
if (r.status !== 0) {
  console.error("❌ 不是 git 仓库，无法安装钩子");
  process.exit(1);
}
const gitDir = path.resolve(ROOT, r.stdout.trim());
const hooksDir = path.join(gitDir, "hooks");
fs.mkdirSync(hooksDir, { recursive: true });

const MARK = "# >>> openmozi ci drift guard >>>";
const hookPath = path.join(hooksDir, "pre-commit");
let body = "";
if (fs.existsSync(hookPath)) {
  body = fs.readFileSync(hookPath, "utf8");
  if (body.includes(MARK)) {
    console.log("✅ 钩子已存在，无需重复安装");
    process.exit(0);
  }
}

const block = [
  MARK,
  'echo "[ci] 校验 src ⇄ dist 一致性..."',
  'node scripts/ci.mjs --check || { echo "[ci] 提交被拦截：请先运行 npm run ci（构建+验收）"; exit 1; }',
  "# <<< openmozi ci drift guard <<<",
  "",
].join("\n");

fs.writeFileSync(hookPath, body + (body && !body.endsWith("\n") ? "\n" : "") + block, { mode: 0o755 });
console.log(`✅ 已安装 pre-commit 钩子 → ${hookPath}`);
console.log("   作用：src 改了却没构建、或 dist 被手改，都会被提交拦截");
