/**
 * 通道注册表
 *
 * P4（多 agent + 隔离）扩展：**按渠道账号注册**。
 *
 * 为什么必须扩展：原实现是 `Map<ChannelId, ChannelAdapter>` —— 同类型渠道只能有一个实例，
 * 后注册者覆盖前者（`registerChannel` 覆盖语义）。多渠道账号（D13）下这会导致
 * **出站回投选错账号**（第二个 QQ 账号的回复打到第一个账号）＝ 跨商户泄漏。
 *
 * 设计原则（零破坏）：
 *  1. 原有 `registerChannel(id)` / `getChannel(id)` / `getAllChannels()` / `hasChannel(id)`
 *     语义**逐字不变**（现有调用方：`gateway/server.ts:194`、`outbound/index.ts:105/258/265`、
 *     `web/websocket.ts:447`）——多账号是**附加**能力，不是替换。
 *  2. 账号维度用**复合键** `route = ${channelId}:${accountId}` 索引；
 *     单账号渠道（webchat/静态/未标账号者）不产生 route 记录，走老路径。
 *  3. `getAllChannels()` 仍返回**每个渠道一个代表实例**（老 API 兼容）；多账号全量走
 *     `getAllChannelAccounts()`（控制台/诊断用）。
 */

import type { ChannelId } from "../../types/index.js";
import type { ChannelAdapter, MessageHandler } from "./base.js";
import { getChildLogger } from "../../utils/logger.js";

export * from "./base.js";

const logger = getChildLogger("channels");

/** 通道注册表（每渠道一个代表实例，兼容老 API） */
const channels = new Map<ChannelId, ChannelAdapter>();

/** 账号级注册表：route(`<channelId>:<accountId>`) → 通道实例（P4） */
const channelAccounts = new Map<string, ChannelAdapter>();

/** 全局消息处理器 */
let globalMessageHandler: MessageHandler | undefined;

/** 拼账号路由键（**唯一实现**，V-014；别处不得再拼一遍） */
export function channelRouteKey(channelId: ChannelId, accountId: string): string {
  return `${channelId}:${accountId}`;
}

/** 注册通道（老 API：每渠道一个代表实例） */
export function registerChannel(channel: ChannelAdapter): void {
  channels.set(channel.id, channel);

  // 如果有全局消息处理器，设置到通道
  if (globalMessageHandler && "setMessageHandler" in channel) {
    (channel as { setMessageHandler: (h: MessageHandler) => void }).setMessageHandler(
      globalMessageHandler
    );
  }

  logger.info({ channel: channel.id }, "Channel registered");
}

/**
 * 按账号注册通道实例（P4）：同一渠道类型可有多个账号实例。
 * 必须与 `registerChannel` 同批调用（前者供老 API 取代表实例，后者供按账号回投）。
 */
export function registerChannelAccount(channel: ChannelAdapter, route: string): void {
  if (!route || !route.includes(":")) {
    throw new Error(`registerChannelAccount: route 形态应为 <channelId>:<accountId>，收到 ${JSON.stringify(route)}`);
  }
  if (!route.startsWith(`${channel.id}:`)) {
    throw new Error(`registerChannelAccount: route(${route}) 与通道(${channel.id}) 不匹配`);
  }
  const prev = channelAccounts.get(route);
  if (prev && prev !== channel) {
    logger.warn({ route }, "同账号 route 被重复注册（后者生效）");
  }
  channelAccounts.set(route, channel);
  if (globalMessageHandler && "setMessageHandler" in channel) {
    (channel as { setMessageHandler: (h: MessageHandler) => void }).setMessageHandler(globalMessageHandler);
  }
  logger.info({ route }, "Channel account registered");
}

/** 获取通道（老 API：按渠道类型取代表实例） */
export function getChannel(id: ChannelId): ChannelAdapter | undefined {
  return channels.get(id);
}

/**
 * 按账号路由取通道实例（P4 出站回投用）。
 * 缺省回退到该渠道类型的代表实例（单账号场景与老行为完全一致）。
 */
export function getChannelAccount(route: string | undefined): ChannelAdapter | undefined {
  if (!route) return undefined;
  const hit = channelAccounts.get(route);
  if (hit) return hit;
  const channelId = route.split(":")[0] as ChannelId;
  return channelId ? channels.get(channelId) : undefined;
}

/** 获取所有通道（老 API：每渠道一个代表） */
export function getAllChannels(): ChannelAdapter[] {
  return Array.from(channels.values());
}

/** 获取所有**账号级**通道实例（多账号诊断/控制台用） */
export function getAllChannelAccounts(): Array<{ route: string; channel: ChannelAdapter }> {
  return Array.from(channelAccounts.entries()).map(([route, channel]) => ({ route, channel }));
}

/** 账号路由表镜像（`/agent-diag` 与断言用） */
export function channelAccountRoutes(): string[] {
  return Array.from(channelAccounts.keys());
}

/** 检查通道是否可用 */
export function hasChannel(id: ChannelId): boolean {
  return channels.has(id);
}

/** 设置全局消息处理器 */
export function setGlobalMessageHandler(handler: MessageHandler): void {
  globalMessageHandler = handler;

  // 更新所有已注册通道的处理器
  for (const channel of channels.values()) {
    if ("setMessageHandler" in channel) {
      (channel as { setMessageHandler: (h: MessageHandler) => void }).setMessageHandler(handler);
    }
  }
  for (const channel of channelAccounts.values()) {
    if ("setMessageHandler" in channel) {
      (channel as { setMessageHandler: (h: MessageHandler) => void }).setMessageHandler(handler);
    }
  }
}

/** 初始化所有通道 */
export async function initializeAllChannels(): Promise<void> {
  for (const channel of channels.values()) {
    try {
      await channel.initialize();
      logger.info({ channel: channel.id }, "Channel initialized");
    } catch (error) {
      logger.error({ channel: channel.id, error }, "Failed to initialize channel");
    }
  }
}

/** 关闭所有通道 */
export async function shutdownAllChannels(): Promise<void> {
  for (const channel of channels.values()) {
    try {
      await channel.shutdown();
      logger.info({ channel: channel.id }, "Channel shut down");
    } catch (error) {
      logger.error({ channel: channel.id, error }, "Failed to shut down channel");
    }
  }
}
