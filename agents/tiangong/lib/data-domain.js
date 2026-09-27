// agents/tiangong/lib/data-domain.js
//
// 本文件与 yuanyi/lib/data-domain.js 同契约、同手法（V-014：同一实现不写两遍逻辑，
// 但**每个 agent 各一份文件**是 P4 数据隔离的直接后果——libDir 是 per-agent 的，
// A 的 lib 目录不给 B 用）。
//
// 为什么业务侧要经这一层而不是直接 import 框架：保持三层归属（业务插件不依赖框架内部路径），
// 同时让"数据域校验"在业务 HTTP 客户端里有**单一入口**。
// 上溯：runtime/openmozi/agents/tiangong/lib/ → 上溯 3 级 = runtime/openmozi/ → dist/core/isolation/
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = path.resolve(HERE, "..", "..", "..");
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
 * 为什么显式声明而不是靠运行时推断：pi 的工具执行跑在自己的事件回调里，
 * 不一定继承发起本轮对话的那条 await 链 —— AsyncLocalStorage 可能读不到当前 agent
 * 的上下文，于是"当前是谁"会被兜底值（往往是另一个 agent）回答（P4 实测：L-107 家族）。
 * 这个常量按文件位置定死，不可能被别的 agent 的上下文污染。
 */
export const AGENT_ID = "tiangong";

/** 校验业务 HTTP 目标 URL 是否属于本 agent 的数据域（无域时原样返回，但上方已告警） */
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
