// junwuyou/lib/request-context.js
// 单次 LLM 请求的上下文载体（AsyncLocalStorage）。
//
// 为什么需要它（参考 jcode 的 ephemeral suffix 设计）：
//   客户档案是"每轮都可能变"的动态内容。若把它塞进 system prompt 或历史消息，
//   提示词缓存的前缀就被破坏，缓存命中率归零、成本全额。
//   正确做法：档案作为**请求级尾部后缀**注入 —— 不落历史、不污染前缀。
//   而"请求级"数据必须随异步调用链传播（同一进程内有多个会话并发），
//   所以用 AsyncLocalStorage 而不是模块级变量（模块级变量在并发时会串号）。
import { AsyncLocalStorage } from "node:async_hooks";

export const requestContext = new AsyncLocalStorage();

/** 在给定上下文中执行（runtime 调用 session.prompt 时包一层） */
export function runWithRequestContext(ctx, fn) {
  return requestContext.run(ctx, fn);
}

/** 取当前请求上下文（适配器构造请求时读） */
export function getRequestContext() {
  return requestContext.getStore() ?? null;
}

/** 客户档案文本（无则空串，适配器据此决定是否加后缀） */
export function getProfileText() {
  return requestContext.getStore()?.profileText ?? "";
}

/**
 * 渠道级提示词后缀（P0.6）：**按渠道切换交互范式**而不改可缓存前缀。
 * 例：邮件渠道要求正式语气（"哈哈～"在邮件里不合适），IM 渠道保持轻松人设。
 * 为什么不直接改 system prompt：那是可缓存前缀的一部分，按渠道改会拆掉缓存（L-063）。
 */
export function getChannelSuffix() {
  return requestContext.getStore()?.channelSuffix ?? "";
}

/** 客户身份（工具层写入档案时用，避免让模型猜 id） */
export function getIdentity() {
  return requestContext.getStore()?.identity ?? null;
}

/**
 * 业务库客户主键（P0.6 身份汇聚后**由身份层解析得到**，V-009：绝不来自模型）。
 * 与 identity 的区别：identity 是"渠道身份键"（给模型看/给业务库换档案用），
 * customerId 是数字主键（订单归属、回投目标用）。两者都可能为空 —— 调用方必须处理。
 */
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
