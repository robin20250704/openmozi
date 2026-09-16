/**
 * 通道基类和接口
 */

import type {
  ChannelId,
  ChannelMeta,
  ChannelCapabilities,
  InboundMessageContext,
  OutboundMessage,
  SendResult,
} from "../../types/index.js";
import { getChildLogger } from "../../utils/logger.js";

/** 通道适配器接口 */
export interface ChannelAdapter {
  /** 通道 ID */
  id: ChannelId;

  /** 通道元数据 */
  meta: ChannelMeta;

  /** 初始化通道 */
  initialize(): Promise<void>;

  /** 关闭通道 */
  shutdown(): Promise<void>;

  /** 发送消息 */
  sendMessage(message: OutboundMessage): Promise<SendResult>;

  /** 发送文本消息 */
  sendText(chatId: string, text: string, replyToId?: string): Promise<SendResult>;

  /**
   * 根据入站消息上下文回复（由 Gateway 统一调用，通道可覆盖以实现会话级回复等）
   */
  replyToContext(context: InboundMessageContext, text: string): Promise<SendResult>;

  /** 检查通道状态 */
  isHealthy(): Promise<boolean>;
}

/** 消息处理器类型 */
export type MessageHandler = (context: InboundMessageContext) => Promise<void>;

/** 通道基类 */
export abstract class BaseChannelAdapter implements ChannelAdapter {
  abstract id: ChannelId;
  abstract meta: ChannelMeta;

  protected logger = getChildLogger("channel");
  protected messageHandler?: MessageHandler;

  /**
   * 渠道**账号**标识（P4 契约 C-P4-1）。
   * 由各渠道的 config 决定（QQ = appId、企微 = corpId、邮件 = imapUser…）。
   * 缺省 undefined = 单账号渠道（webchat/静态）或未配置 —— 此时不产生账号路由，
   * 消息照老路径走默认 agent（行为不变）。
   */
  protected accountId?: string;

  /** 账号路由键 `<channelId>:<accountId>`（有 accountId 才有值） */
  get agentRoute(): string | undefined {
    return this.accountId ? `${this.id}:${this.accountId}` : undefined;
  }

  /** 设置账号标识（构造期或测试用） */
  setAccountId(accountId: string | undefined): void {
    this.accountId = accountId && accountId.trim() ? accountId.trim() : undefined;
  }

  /**
   * 给入站上下文打上账号路由 —— **唯一实现**（V-014）。
   *
   * 两条注入路径都走这里：
   *  ① 经 `handleInboundMessage` 的渠道（企微/邮件/飞书/钉钉）自动注入，各渠道零改动；
   *  ② 自己持有长连接客户端的渠道（QQ 的 `QQWebSocketClient` 直接调 eventHandler，
   *     不经过本基类）必须在回调里显式调 `this.withRoute(ctx)`。
   *
   * 为什么不放在各渠道里逐处拼：账号标识的形态只有一处定义，逐处拼必然漏（L-057 同族）。
   */
  protected withRoute<T extends InboundMessageContext>(context: T): T {
    const route = this.agentRoute;
    if (route) context.agentRoute = route;
    return context;
  }

  /** 设置消息处理器 */
  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /** 处理入站消息 */
  protected async handleInboundMessage(context: InboundMessageContext): Promise<void> {
    const routed = this.withRoute(context);
    if (this.messageHandler) {
      await this.messageHandler(routed);
    } else {
      this.logger.warn("No message handler registered");
    }
  }

  abstract initialize(): Promise<void>;
  abstract shutdown(): Promise<void>;
  abstract sendMessage(message: OutboundMessage): Promise<SendResult>;
  abstract sendText(chatId: string, text: string, replyToId?: string): Promise<SendResult>;

  /** 默认实现：使用 chatId 与 messageId 调用 sendText */
  async replyToContext(context: InboundMessageContext, text: string): Promise<SendResult> {
    return this.sendText(context.chatId, text, context.messageId);
  }

  abstract isHealthy(): Promise<boolean>;
}
