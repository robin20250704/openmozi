// agents/tiangong/lib/request-context.js
//
// 单次 LLM 请求的上下文载体（AsyncLocalStorage）—— 与 junwuyou / yuanyi 同名模块同契约。
//
// 为什么每个 agent 都要有一份：runtime 用 `loadBusinessLib("request-context")` 按
// **本 agent 的 libDir** 加载它（P4 数据隔离的直接后果）。缺了它 → 该 agent 第一轮对话
// 就走降级路径（runtime 有兜底，但工具层拿不到身份/会话键）。
//
// 本批新增两个读取器（senderness）：`getSenderName()` / `getSenderId()`——需求 4 要求
// "Web UI 把用户 ID、名称随消息一起传给 Agent"，工具层必须能读到它们（而不是让模型猜）。
// 二者由 runtime 侧 `runWithProfile` 填入（与 identity/customerId 同一次赋值）。
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

/** 客户档案文本（本 agent 无跨会话档案体系，恒为空串；保留同契约以免 runtime 降级） */
export function getProfileText() {
  return requestContext.getStore()?.profileText ?? "";
}

/** 渠道级提示词后缀：按渠道切换交互范式而不改可缓存前缀（L-063） */
export function getChannelSuffix() {
  return requestContext.getStore()?.channelSuffix ?? "";
}

/** 身份（工具层用，避免让模型猜身份） */
export function getIdentity() {
  return requestContext.getStore()?.identity ?? null;
}

/** 业务库客户主键（本 agent 无客户库，恒 null — V-009：绝不来自模型） */
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

/**
 * 提问者 ID（需求 4：Web UI 经 HTTP 头 `X-PLM-User` 传入，由 WS 层写入消息上下文）。
 *
 * 回落顺序：上下文的 senderId → 身份键里 `webchat:` 之后的部分 → null。
 * 为什么要回落：webchat 场景下 WS 层用 `webchat:<senderId>` 作会话键（V-007 的分工），
 * 未带头时会话键里仍带着一个稳定 ID，比"匿名"更有用。
 */
export function getSenderId() {
  const ctx = requestContext.getStore();
  const direct = ctx?.senderId;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const id = ctx?.identity;
  if (typeof id === "string" && id.startsWith("webchat:")) return id.slice("webchat:".length);
  return null;
}

/** 提问者显示名（需求 4：HTTP 头 `X-PLM-User-Name`）；未带则为 null，由 prompt 口径回落「匿名访客」 */
export function getSenderName() {
  const v = requestContext.getStore()?.senderName;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** 提问者身份的一句话描述（工具直接回给模型，避免模型自己拼） */
export function getSenderLabel() {
  const id = getSenderId();
  const name = getSenderName();
  if (!id && !name) return "匿名访客";
  if (name && id) return `${name}（${id}）`;
  return name || id;
}
