// yuanyi/lib/request-context.js
// 单次 LLM 请求的上下文载体（AsyncLocalStorage）—— 与 junwuyou 同名模块同契约。
//
// 为什么每个 agent 都要有一份：runtime 用 `loadBusinessLib("request-context")` 按
// **本 agent 的 libDir** 加载它（P4 数据隔离的直接后果：A 的 lib 目录不能给 B 用）。
// 缺了它 → 元一装配后第一轮对话就失败（Cannot find module .../yuanyi/lib/request-context.js）。
//
// 为什么用 AsyncLocalStorage 而不是模块级变量：同一进程内有多个会话/多个 agent 并发，
// 模块级变量会串号（把甲客户的档案后缀贴到乙客户的请求上）。
import { AsyncLocalStorage } from "node:async_hooks";

export const requestContext = new AsyncLocalStorage();

/** 在给定上下文中执行（runtime 调用 session.prompt 时包一层） */
export function runWithRequestContext(ctx, fn) {
  return requestContext.run(ctx, fn);
}

/** 取当前请求上下文 */
export function getRequestContext() {
  return requestContext.getStore() ?? null;
}

/** 客户档案文本（无则空串） */
export function getProfileText() {
  return requestContext.getStore()?.profileText ?? "";
}

/** 渠道级提示词后缀：按渠道切换交互范式而不改可缓存前缀（L-063） */
export function getChannelSuffix() {
  return requestContext.getStore()?.channelSuffix ?? "";
}

/** 客户身份（工具层用，避免让模型猜身份） */
export function getIdentity() {
  return requestContext.getStore()?.identity ?? null;
}

/** 业务库客户主键（P0.6 身份汇聚后由身份层解析得到，V-009：绝不来自模型） */
export function getCustomerId() {
  const v = requestContext.getStore()?.customerId;
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 会话键（缓存追踪器按会话隔离） */
export function getSessionKey() {
  return requestContext.getStore()?.sessionKey ?? null;
}
