// agents/yuanyi/lib/data-domain.js
//
// 业务源文件里**不能出现 `import ... from "dist/..."`**（L-059：dist 是构建产物，
// 手写 dist 路径会让"源码→产物"的单一版本约束失效，也让 tsc 的模块解析失效）。
// 框架侧的实现放在 `src/core/isolation/data-domain.ts`（编译到 dist）。
//
// 所以这里用**同一个上溯手法**（root-env.js 已用同一手法定位仓库根 .env，V-014 同源）：
// 本文件位于 runtime/openmozi/agents/yuanyi/lib/ → 上溯 3 级 = runtime/openmozi/，
// 再进 dist/core/isolation/data-domain.js。
//
// 为什么业务侧要经这一层而不是直接 import 框架：保持三层归属（业务插件不依赖框架内部路径），
// 同时让"数据域校验"在业务 HTTP 客户端里有**单一入口**（P5 的元一客户端同样用它）。
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // runtime/openmozi/agents/junwuyou/lib
const RUNTIME_ROOT = path.resolve(HERE, "..", "..", ".."); // runtime/openmozi
const MODULE_PATH = process.env.DATA_DOMAIN_MODULE
  || path.join(RUNTIME_ROOT, "dist", "core", "isolation", "data-domain.js");

let impl = null;
try {
  impl = await import(pathToFileURL(MODULE_PATH).href);
} catch (e) {
  // 未构建 / 模块缺失时**不静默放行**：打显著告警（数据域隔离是安全属性，降级必须留痕）
  console.warn(
    `[data-domain] ⚠️ 无法加载数据域实现（${MODULE_PATH}）：${e.message}\n` +
    `   → 本次运行为"无域放行"（等同未启用数据域约束）。部署前请先 \`npm run ci\` 构建。`
  );
}

/**
 * 本 agent 的身份（数据域查表的键）。
 *
 * 为什么由业务侧**显式声明**而不是靠运行时推断：pi 的工具执行跑在自己的事件回调里，
 * 不一定继承发起本轮对话的那条 await 链 —— AsyncLocalStorage 可能读不到当前 agent 的
 * 上下文，于是"当前是谁"会被兜底值（往往是另一个 agent）回答。这个常量按文件位置定死，
 * 不可能被别的 agent 的上下文污染。
 */
export const AGENT_ID = "yuanyi";

/**
 * 校验业务 HTTP 目标 URL 是否属于本 agent 的数据域。
 * 无域（未装配/未构建）→ 原样返回（与旧行为一致），但**已在上方打告警**。
 */
export function enforceDataOrigin(url) {
  if (!impl?.enforceDataOrigin) return url;
  return impl.enforceDataOrigin(url, AGENT_ID);
}

export function isDataDomainViolation(err) {
  if (!impl?.isDataDomainViolation) return false;
  return impl.isDataDomainViolation(err);
}

export function getDataDomain() {
  if (!impl?.getDataDomain) return null;
  return impl.getDataDomain();
}
