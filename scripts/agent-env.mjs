// scripts/agent-env.mjs —— 逐 agent 注入 `agents/<id>/.env`（唯一实现，V-014）
//
// 谁用：`junwuyou-launcher.mjs`（生产启动）与验收/探针脚本（`probe-tiangong-agent.mjs` 等）。
// 为什么必须共用同一份实现：每个 agent 的**模型 key**与**业务凭据**都靠这套规则进 process.env。
// 若 launcher 与 harness 各写一份，"生产能跑、验收跑不起来"会以最难查的形态出现
// （表现为"模型没输出""PLM 连不上"，而不是配置错误）。
//
// 规则：
//   · 逐个扫 `agents/<id>/.env`；**不覆盖已存在的环境变量**（优先级：显式传参 > agent .env > 全局 .env）；
//   · 只回报"注入了几个键"，**绝不回显值**（启动日志会被 CI/运维留存，打印凭据等于泄露）；
//   · 支持 `KEY=VALUE`、`#` 注释、两侧引号；空值跳过（空值等于没配）。
import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} runtimeRoot runtime/openmozi 的绝对路径
 * @returns {string[]} 给人读的日志行（**不含任何凭据值**）
 */
export function injectAgentEnv(runtimeRoot) {
  const log = [];
  const agentsDir = path.join(runtimeRoot, "agents");
  if (!fs.existsSync(agentsDir)) return log;
  const ids = fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const agentId of ids) {
    const file = path.join(agentsDir, agentId, ".env");
    if (!fs.existsSync(file)) continue;
    let injected = 0;
    let skipped = 0;
    try {
      for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const i = line.indexOf("=");
        if (i <= 0) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
        if (!k || !v) continue;
        if (process.env[k] === undefined) {
          process.env[k] = v;
          injected++;
        } else {
          skipped++;
        }
      }
      log.push(`agent 环境：agents/${agentId}/.env 注入 ${injected} 个键${skipped ? `（另有 ${skipped} 个已存在，未覆盖）` : ""}（值不回显）`);
    } catch (e) {
      log.push(`⚠️ 读 agents/${agentId}/.env 失败：${e.message}`);
    }
  }
  return log;
}
