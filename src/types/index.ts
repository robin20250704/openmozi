/**
 * 核心类型定义
 */

// ============== 模型相关类型 ==============

/** 支持的模型 API 类型 */
export type ModelApi =
  | "openai-compatible"      // OpenAI 兼容接口 (DeepSeek, Kimi, Stepfun)
  | "openai"                 // OpenAI 原生/兼容接口 (自定义)
  | "anthropic"              // Anthropic 兼容接口 (自定义)
  | "minimax-v1"             // MiniMax 原生接口
  | "anthropic-messages";    // Anthropic 消息接口

/** 模型提供商 ID */
export type ProviderId =
  | "deepseek" | "doubao" | "minimax" | "kimi" | "stepfun" | "modelscope" | "dashscope" | "zhipu"
  | "openai" | "ollama" | "openrouter" | "together" | "groq"
  | "azure-openai" | "vllm"
  | "custom-openai" | "custom-anthropic";

/** 模型定义 */
export interface ModelDefinition {
  id: string;
  name: string;
  provider: ProviderId;
  api: ModelApi;
  contextWindow: number;
  maxTokens: number;
  supportsVision: boolean;
  supportsReasoning: boolean;
  /** 是否支持工具调用 (默认 true) */
  supportsToolCalls?: boolean;
  cost?: {
    input: number;   // 每百万 token 成本
    output: number;
    cacheRead?: number;
  };
}

/** 简化的提供商配置 (用于用户配置) */
export interface SimpleProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  groupId?: string;  // MiniMax specific
}

// ============== 消息相关类型 ==============

/** 消息角色 */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/** 消息内容类型 */
export type ContentType = "text" | "image";

/** 文本内容 */
export interface TextContent {
  type: "text";
  text: string;
}

/** 图片内容 */
export interface ImageContent {
  type: "image";
  url?: string;
  base64?: string;
  mediaType?: string;
}

/** 消息内容 */
export type MessageContent = TextContent | ImageContent;

/** 工具调用 (在 assistant 消息中) */
export interface MessageToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;  // JSON 字符串
  };
}

/** 聊天消息 */
export interface ChatMessage {
  role: MessageRole;
  content: string | MessageContent[] | null;
  /** assistant 消息中的工具调用 */
  tool_calls?: MessageToolCall[];
  /** tool 消息中的工具调用 ID */
  tool_call_id?: string;
  /** tool 消息中的工具名称 */
  name?: string;
}

// ============== 通道相关类型 ==============

/** 通道 ID */
export type ChannelId = "feishu" | "dingtalk" | "qq" | "wecom" | "webchat" | "email" | "miniprogram";

/** 聊天类型 */
export type ChatType = "direct" | "group";

/** 通道能力 */
export interface ChannelCapabilities {
  chatTypes: ChatType[];
  supportsMedia: boolean;
  supportsReply: boolean;
  supportsMention: boolean;
  supportsReaction: boolean;
  supportsThread: boolean;
  supportsEdit: boolean;
  maxMessageLength: number;
}

/** 通道元数据 */
export interface ChannelMeta {
  id: ChannelId;
  name: string;
  description: string;
  capabilities: ChannelCapabilities;
}

/** 入站消息上下文 */
export interface InboundMessageContext {
  channelId: ChannelId;
  messageId: string;
  chatId: string;
  chatType: ChatType;
  senderId: string;
  senderName?: string;
  content: string;
  mediaUrls?: string[];
  replyToId?: string;
  mentions?: string[];
  timestamp: number;
  raw?: unknown;
  /**
   * 渠道账号路由键（P4 契约 C-P4-1）：`<channelId>:<accountId>`，如 `qq:1905601942`。
   *
   * 由**渠道实例**按其账号标识注入（同一渠道可有多账号 → 多个实例）。
   * 网关据此选 agent（D13：不同渠道账号 → 不同 agent）与选回投通道实例。
   * **缺失/未命中 → 走默认 agent**（单 agent 时代行为不变，U-4 回滚前提）。
   */
  agentRoute?: string;
}

/** 出站消息 */
export interface OutboundMessage {
  chatId: string;
  content: string;
  replyToId?: string;
  mediaUrls?: string[];
  mentions?: string[];
}

/** 发送结果 */
export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// ============== 配置相关类型 ==============

/** 飞书配置 */
export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  enabled?: boolean;
}

/** 钉钉配置 */
export interface DingtalkConfig {
  appKey: string;
  appSecret: string;
  robotCode?: string;
  enabled?: boolean;
}

/** QQ 机器人配置 */
export interface QQConfig {
  appId: string;
  clientSecret: string;
  enabled?: boolean;
  /** 是否使用沙箱环境 */
  sandbox?: boolean;
  /**
   * 账号标识（P4 多账号）：作为 `agentRoute = qq:<account>` 的账号段。
   * 缺省回退 `appId`（单账号配置零改动），多账号配置里显式给（便于用别名而不是长数字）。
   */
  account?: string;
}

/** 企业微信配置 */
export interface WeComConfig {
  corpId: string;
  corpSecret: string;
  agentId: number;
  token?: string;
  encodingAESKey?: string;
  enabled?: boolean;
}

/**
 * 邮件渠道配置（P0.6 / D-17/D-21/D-33）
 *
 * 邮件是 OpenMozi 无原生实现的渠道（5 渠道中"需自研"的一个），交互范式与 IM 差异大：
 * 异步、主题线程、轮询、正式语气、**独立 SLA**（客户按天/小时预期回复，不是 IM 的分钟级）。
 */
export interface EmailConfig {
  /** 收信（IMAP 轮询） */
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPassword: string;
  /** IMAP 是否使用隐式 TLS（默认 true；false = 明文，仅内网/测试用） */
  imapSecure?: boolean;
  /** 发信（SMTP） */
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  /** 是否使用隐式 TLS（SMTPS，端口 465）；false 则走明文 + STARTTLS（端口 587） */
  smtpSecure?: boolean;
  /** IMAP 轮询间隔（秒），默认 30 */
  pollIntervalSec?: number;
  /** 只处理该时间之后到达的邮件（ISO 时间串），避免首次启动把整个收件箱当新消息 */
  sinceIso?: string;
  /** 独立 SLA：邮件渠道的响应时限（分钟），默认 240（IM 侧是分钟级，两者口径不同） */
  slaMinutes?: number;
  /** 发件人显示名，默认「君无忧客服」 */
  fromName?: string;
  enabled?: boolean;
  /** 只处理这些发件人域（可选，空 = 不限） */
  allowedSenderDomains?: string[];
}

/** Agent 配置 */
export interface AgentConfig {
  defaultModel: string;
  defaultProvider: ProviderId;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /** 工作目录 */
  workingDirectory?: string;
  /** 是否启用 function calling */
  enableFunctionCalling?: boolean;
}

/** 会话存储配置 */
export interface SessionStoreConfig {
  /** 存储类型 */
  type: "memory" | "file";
  /** 文件存储目录 */
  directory?: string;
  /** 会话 TTL (毫秒) */
  ttlMs?: number;
}

/** Memory 配置 */
export interface MemoryConfig {
  enabled?: boolean;
  /** 存储目录 */
  directory?: string;
  /** 嵌入模型 */
  embeddingModel?: string;
  /** 嵌入提供商 */
  embeddingProvider?: ProviderId;
}

/** 主配置 */
export interface MoziConfig {
  providers: Record<string, SimpleProviderConfig | Record<string, unknown>>;
  channels: {
    feishu?: FeishuConfig;
    dingtalk?: DingtalkConfig;
    qq?: QQConfig;
    wecom?: WeComConfig;
    email?: EmailConfig;
    /**
     * 同类型渠道的**附加账号**（P4 / D13）：每个元素 = 一个独立通道实例，
     * 各自 `agentRoute = <channelId>:<account>`，路由到各自的 agent。
     * 缺省空数组 = 只有主账号（线上现状，零影响）。
     */
    accounts?: {
      qq?: QQConfig[];
      wecom?: Array<WeComConfig & { account?: string }>;
      email?: Array<EmailConfig & { account?: string }>;
    };
  };
  agent: AgentConfig;
  server: {
    port: number;
    host?: string;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
  };
  /** 会话存储配置 */
  sessions?: SessionStoreConfig;
  /** Memory 配置 */
  memory?: MemoryConfig;
  /** Skills 配置 */
  skills?: {
    enabled?: boolean;
    userDir?: string;
    workspaceDir?: string;
    disabled?: string[];
    only?: string[];
  };
}

// ============== 事件相关类型 ==============

/** 事件类型 */
export type EventType =
  | "message_received"
  | "message_sent"
  | "error"
  | "channel_connected"
  | "channel_disconnected";

/** 事件处理器 */
export type EventHandler<T = unknown> = (data: T) => void | Promise<void>;

// ============== 错误类型 ==============

/** Mozi 错误 */
export class MoziError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "MoziError";
  }
}

/** 提供商错误 */
export class ProviderError extends MoziError {
  constructor(
    message: string,
    public provider: ProviderId,
    details?: unknown
  ) {
    super(message, "PROVIDER_ERROR", details);
    this.name = "ProviderError";
  }
}

/** 通道错误 */
export class ChannelError extends MoziError {
  constructor(
    message: string,
    public channel: ChannelId,
    details?: unknown
  ) {
    super(message, "CHANNEL_ERROR", details);
    this.name = "ChannelError";
  }
}
