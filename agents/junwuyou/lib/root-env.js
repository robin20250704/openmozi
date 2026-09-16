/**
 * 根 `.env` 的指定键读取（**唯一实现**）
 *
 * 背景：本项目有多处"读根 .env"的需求（Express 的 env-config.js 单独实现了一份，
 * 因为它在 CJS 环境下运行）。本模块给 **runtime/openmozi 侧的 ESM 调用方**用，
 * 避免同一语义在三处各写一遍（约定 V-014）。
 *
 * 规则（与 junwuyou/server/env-config.js 保持一致）：
 * 1. **进程环境变量优先，其次 `.env` 文件**；
 * 2. **只取指定的键**，不整体加载 `.env`（整体加载会把 PORT/ADMIN_TOKEN 之类灌进本进程）；
 * 3. `.env` 位置可用 `SERVICE_ENV_FILE` / `AMAP_ENV_FILE` 覆盖（默认仓库根 `.env`）。
 *
 * 为什么调用方需要它：诊断脚本（`scripts/probe-*.mjs`）与 harness 是**直接 node 运行**的，
 * 没有 launcher 的 env 注入（config-adapter 只在 launcher 装配时注入，见 L-042）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // runtime/openmozi/agents/junwuyou/lib

/** 根 `.env` 路径（可被环境变量覆盖）。P3 搬迁：junwuyou/ → agents/junwuyou/ 多了一层，上溯 5 级到仓库根。 */
export const ROOT_ENV_PATH =
  process.env.SERVICE_ENV_FILE || process.env.AMAP_ENV_FILE ||
  path.resolve(HERE, '..', '..', '..', '..', '..', '.env');

/** 从根 `.env` 读单个键（找不到/不可读返回 ''） */
export function readRootEnvKey(name) {
  try {
    const txt = fs.readFileSync(ROOT_ENV_PATH, 'utf8');
    const re = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`);
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(re);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  } catch { /* 文件不存在/不可读 → 视为未配置 */ }
  return '';
}

/**
 * 解析一个 API token：**进程环境变量 → 根 `.env`**，依次在候选键名中查找。
 *
 * @param {string} name 规范键名（如 `SCHEDULER_API_TOKEN`）
 * @param {string[]} legacyNames 兼容的旧键名（如 `SCHEDULER_API_KEY`）
 * @returns {{ token: string, source: string }} source 用于诊断，**不含 token 值**
 */
export function resolveApiToken(name, legacyNames = []) {
  const names = [name, ...legacyNames];
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return { token: v.trim(), source: `env:${n}` };
  }
  for (const n of names) {
    const v = readRootEnvKey(n);
    if (v) return { token: v, source: `file:${ROOT_ENV_PATH}#${n}` };
  }
  return { token: '', source: 'none' };
}

/**
 * 取 token 或**明确报错**（不静默回退到占位值）。
 *
 * 为什么不用默认值：旧代码写作 `process.env.SCHEDULER_API_KEY || "dev_only_token"`，
 * 一旦环境注入失败（L-042 的 ESM 静态提升、或进程重启丢配置 L-084），
 * 它会带着一个"看起来能用"的假凭据去调用，失败表现是 401 而不是"配置缺失"，
 * 把排查方向带偏（同族教训 L-078：静默降级比显式失败危险）。
 */
export function requireApiToken(name, legacyNames = []) {
  const { token, source } = resolveApiToken(name, legacyNames);
  if (!token) {
    throw new Error(
      `${name} 未配置：该接口需要 Bearer 凭据（见仓库根 .env；读取位置 ${ROOT_ENV_PATH}）。` +
      '不接受任何默认/占位值——缺失即失败，避免用假凭据调用造成 401 误判。'
    );
  }
  return { token, source };
}
