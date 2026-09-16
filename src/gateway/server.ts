/**
 * Gateway 服务器 - HTTP Webhook 处理 + WebChat
 */

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { createServer, type Server as HttpServer } from "http";
import NodeCache from "node-cache";
import type { MoziConfig, InboundMessageContext } from "../types/index.js";
import { createFeishuChannel, type FeishuChannel } from "../channels/feishu/index.js";
import { createDingtalkChannel, type DingtalkChannel } from "../channels/dingtalk/index.js";
import { createQQChannel, type QQChannel } from "../channels/qq/index.js";
import { createWeComChannel, type WeComChannel } from "../channels/wecom/index.js";
import { createEmailChannel, type EmailChannel } from "../channels/email/index.js";
import {
  registerChannel,
  registerChannelAccount,
  getChannel,
  getChannelAccount,
  channelAccountRoutes,
} from "../channels/common/index.js";
import { formatForChannel } from "../channels/common/markdown-plain.js";
import { createAgent, type Agent } from "../agents/agent.js";
import { AgentRegistry } from "../agents/registry.js";
import { initializeProviders } from "../providers/index.js";
import { getChildLogger, setLogger, createLogger } from "../utils/logger.js";
import { WsServer } from "../web/websocket.js";
import { handleStaticRequest } from "../web/static.js";

const logger = getChildLogger("gateway");

export class Gateway {
  private app: Express;
  private httpServer: HttpServer;
  private config: MoziConfig;
  /**
   * P4：单 agent → **Agent 注册表**（C-P4-3）。
   * 路由解析只有一处实现（`registry.resolve`）；缺省走默认 agent，
   * 因此单 agent 部署的行为与升级前逐字一致（U-4 回滚前提）。
   */
  private agents: AgentRegistry = new AgentRegistry();
  /** 兼容访问器：单 agent 时代的默认 agent（webchat 等老路径用） */
  private get agent(): Agent {
    return this.agents.resolve(undefined).agent;
  }
  private feishuChannel?: FeishuChannel;
  private dingtalkChannel?: DingtalkChannel;
  private qqChannel?: QQChannel;
  private wecomChannel?: WeComChannel;
  private emailChannel?: EmailChannel;
  /** P4：附加账号的通道实例（每个 = 独立 agentRoute） */
  private extraChannels: Array<{ route: string; channel: { initialize(): Promise<void>; shutdown(): Promise<void> } }> = [];
  private wsServer?: WsServer;
  /** 已处理的消息 ID 缓存（用于去重，带 TTL 与最大条数） */
  private processedMessages: NodeCache;
  /** 消息缓存过期时间 (秒，5 分钟) */
  private readonly MESSAGE_CACHE_TTL_SEC = 300;
  /** 消息去重缓存最大条数 */
  private readonly MESSAGE_CACHE_MAX_KEYS = 10000;

  constructor(config: MoziConfig) {
    this.config = config;
    this.app = express();
    this.httpServer = createServer(this.app);
    this.processedMessages = new NodeCache({
      stdTTL: this.MESSAGE_CACHE_TTL_SEC,
      maxKeys: this.MESSAGE_CACHE_MAX_KEYS,
      useClones: false,
    });

    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * 初始化默认 Agent（异步）
   *
   * P4：默认 agent 仍是 `createAgent(config)`（单 agent 路径零改动）。
   * 多 agent 装配由 launcher 经 `agents.registerAgent(...)` 追加（每个 agent 自带
   * runtime/toolset/prompt），本类不感知业务。
   *
   * 注册 id 用 `junwuyou`（本项目默认业务人设）——launcher 装配真实 junwuyou agent 时
   * 会**先注册它自己的描述符**，本方法检测到同名已存在即跳过（不重复注册、不覆盖）。
   */
  async initAgent(): Promise<void> {
    if (this.agents.defaultId) return; // launcher 已装配默认 agent
    if (this.agentAssembled) return;   // 同上（描述符装配路径）
    const agent = await createAgent(this.config);
    const runtime = (agent as unknown as { runtime?: unknown }).runtime as never;
    this.agents.registerAgent(
      {
        id: "junwuyou",
        name: "默认 agent（未装配业务插件）",
        promptRef: "",
        toolset: [],
        toolsModule: "",
        libDir: "",
        dataDomain: "junwuyou",
        allowedOrigins: [],
        accountRoutes: [],
      },
      agent,
      runtime
    );
    this.agents.setDefault("junwuyou");
  }

  /** Agent 注册表（launcher 装配多 agent 用；测试/诊断亦读它） */
  getAgentRegistry(): AgentRegistry {
    return this.agents;
  }

  /** 是否已有 agent 完成装配（launcher 装配 descriptor 驱动时置 true，跳过默认 agent） */
  private agentAssembled = false;

  /** launcher 装配前调用：标记"默认 agent 由描述符装配提供" */
  markAgentAssembled(): void {
    this.agentAssembled = true;
  }

  /** 设置中间件 */
  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // 请求日志
    this.app.use((req, res, next) => {
      logger.debug({ method: req.method, path: req.path }, "Incoming request");
      next();
    });
  }

  /** 设置路由 */
  private setupRoutes(): void {
    // 健康检查
    this.app.get("/health", (req, res) => {
      res.json({ status: "ok", timestamp: new Date().toISOString() });
    });

    /**
     * P4 隔离审计观测面（只读）。
     *
     * 为什么需要一个端点：隔离是安全属性，"两个 agent 的工具/数据/会话互不可见"
     * 必须能被**外部断言**观测（A11/A12/A14/A21），否则只能靠读代码相信它。
     *
     * 安全约束（与 C-043/C-045 一致，且不破坏其不变式）：
     * ① **默认关闭**，必须显式 `P4_DIAG_ENABLED=true` 才挂载（生产不暴露）；
     * ② 只答**回环**来源（与三服务的监听面契约同口径），非回环一律 403；
     * ③ 只回**名字与标识**（toolset/routes/domain），不回提示词、密钥、客户数据。
     */
    if (process.env.P4_DIAG_ENABLED === "true") {
      this.app.get("/agent-diag", (req: Request, res: Response) => {
        const ip = req.ip || req.socket.remoteAddress || "";
        const isLoopback = ip.includes("127.0.0.1") || ip === "::1" || ip.includes("::ffff:127.0.0.1");
        if (!isLoopback) {
          logger.warn({ ip }, "agent-diag 拒绝非回环访问");
          res.status(403).json({ error: "loopback only" });
          return;
        }
        const entries = this.agents.describe();
        res.json({
          ok: true,
          defaultAgent: this.agents.defaultId,
          routes: this.agents.routeTable(),
          channelAccountRoutes: channelAccountRoutes(),
          agents: entries,
          // 隔离审计的直接判据（A11）：两两 toolset 交集必须为空
          toolsetOverlap: entries.flatMap((a) =>
            entries
              .filter((b) => b.id !== a.id)
              .map((b) => ({ pair: `${a.id}|${b.id}`, overlap: this.agents.toolsetOverlap(a.id, b.id) }))
          ),
          sessionKeyPrefixes: Object.fromEntries(entries.map((e) => [e.id, e.sessionKeyPrefix])),
        });
      });
      logger.info("agent-diag 已启用（P4_DIAG_ENABLED=true，仅回环可访问）");
    }

    // 飞书 (WebSocket 长连接)
    if (this.config.channels.feishu) {
      this.feishuChannel = createFeishuChannel(this.config.channels.feishu);
      this.feishuChannel.setMessageHandler(this.handleMessage.bind(this));
      this.app.use("/feishu", this.feishuChannel.createRouter());
      this.registerChannelWithAccount(this.feishuChannel);
      logger.info("Feishu channel enabled (WebSocket mode)");
    }

    // 钉钉 (Stream 长连接)
    if (this.config.channels.dingtalk) {
      this.dingtalkChannel = createDingtalkChannel(this.config.channels.dingtalk);
      this.dingtalkChannel.setMessageHandler(this.handleMessage.bind(this));
      this.app.use("/dingtalk", this.dingtalkChannel.createRouter());
      this.registerChannelWithAccount(this.dingtalkChannel);
      logger.info("DingTalk channel enabled (Stream mode)");
    }

    // QQ 机器人（P4：支持同渠道多账号 —— 每个账号一个实例 + 一个 agentRoute）
    this.setupQQChannels();

    // 企业微信
    if (this.config.channels.wecom) {
      this.wecomChannel = createWeComChannel(this.config.channels.wecom);
      this.wecomChannel.setAccountId((this.config.channels.wecom as { account?: string }).account || this.config.channels.wecom.corpId);
      this.wecomChannel.setMessageHandler(this.handleMessage.bind(this));
      this.app.use("/wecom", this.wecomChannel.createRouter());
      this.registerChannelWithAccount(this.wecomChannel);
      logger.info({ route: this.wecomChannel.agentRoute }, "WeCom webhook enabled at /wecom/webhook");
    }

    // 邮件（P0.6 自研：IMAP 轮询收信 + SMTP 回信；主题线程 + 独立 SLA）
    if (this.config.channels.email) {
      this.emailChannel = createEmailChannel(this.config.channels.email);
      this.emailChannel.setAccountId((this.config.channels.email as { account?: string }).account || this.config.channels.email.imapUser);
      this.emailChannel.setMessageHandler(this.handleMessage.bind(this));
      this.registerChannelWithAccount(this.emailChannel);
      logger.info(
        { imap: this.config.channels.email.imapHost, slaMinutes: this.config.channels.email.slaMinutes },
        "Email channel enabled (IMAP polling + SMTP)"
      );
    }

    // P4：**附加账号**（D13 多账号）—— 每个账号一个实例，各自 agentRoute
    for (const extra of this.config.channels.accounts?.wecom ?? []) {
      const ch = createWeComChannel(extra);
      ch.setAccountId(extra.account || extra.corpId);
      ch.setMessageHandler(this.handleMessage.bind(this));
      this.registerChannelWithAccount(ch);
      this.extraChannels.push({ route: ch.agentRoute ?? `wecom:${extra.account ?? extra.corpId}`, channel: ch });
    }
    for (const extra of this.config.channels.accounts?.email ?? []) {
      const ch = createEmailChannel(extra);
      ch.setAccountId(extra.account || extra.imapUser);
      ch.setMessageHandler(this.handleMessage.bind(this));
      this.registerChannelWithAccount(ch);
      this.extraChannels.push({ route: ch.agentRoute ?? `email:${extra.account ?? extra.imapUser}`, channel: ch });
    }

    // WebChat 静态文件服务 (放在其他路由之后，作为默认处理)
    this.app.use((req, res, next) => {
      const handled = handleStaticRequest(req, res, { config: this.config });
      if (!handled) {
        next();
      }
    });

    // 404 处理
    this.app.use((req, res) => {
      res.status(404).json({ error: "Not found" });
    });

    // 错误处理
    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      logger.error({ error: err }, "Unhandled error");
      res.status(500).json({ error: "Internal server error" });
    });
  }

  /**
   * P4：注册通道（老 API「每渠道一个代表实例」+ 新 API「按账号路由」**同批**）。
   *
   * 为什么两个都要注册：老 API 供 `getChannel(id)`/`getAllChannels()` 的既有调用方
   * （outbound 主动出站、控制台渠道列表、webchat），新 API 供 `getChannelAccount(route)`
   * 的按账号回投。只注册一个就会出现"出站回投选错账号"或"老调用方踩空"（R2）。
   */
  private registerChannelWithAccount(channel: { id: string; agentRoute?: string }): void {
    registerChannel(channel as never);
    const route = channel.agentRoute;
    if (route) registerChannelAccount(channel as never, route);
  }

  /**
   * P4：QQ 渠道装配（同渠道多账号）。
   *
   * 主账号 = `config.channels.qq`（老配置，线上现状）；
   * 附加账号 = `config.channels.accounts.qq[]`（D13 第二商户等）。
   * 每个账号一个通道实例 → 各自的 `agentRoute = qq:<account>`；
   * 账号路由缺失时（未配置附加账号）行为与单账号完全一致。
   */
  private setupQQChannels(): void {
    const main = this.config.channels.qq;
    const extras = this.config.channels.accounts?.qq ?? [];
    const first = main ?? extras[0];
    if (!first) return;

    this.qqChannel = createQQChannel(first);
    this.qqChannel.setMessageHandler(this.handleMessage.bind(this));
    this.registerChannelWithAccount(this.qqChannel);
    logger.info({ route: this.qqChannel.agentRoute }, "QQ bot enabled (WebSocket mode)");

    for (const extra of extras) {
      // 主账号与附加账号是同一个对象时跳过（配置里重复）
      if (main && extra === main) continue;
      const ch = createQQChannel(extra);
      ch.setMessageHandler(this.handleMessage.bind(this));
      this.registerChannelWithAccount(ch);
      this.extraChannels.push({ route: ch.agentRoute ?? `qq:${extra.account ?? extra.appId}`, channel: ch });
      logger.info({ route: ch.agentRoute, appId: extra.appId }, "QQ extra account enabled");
    }
  }

  /** 处理入站消息 */
  private async handleMessage(context: InboundMessageContext): Promise<void> {
    // 消息去重检查
    if (this.isDuplicateMessage(context.messageId)) {
      logger.debug({ messageId: context.messageId }, "Skipping duplicate message");
      return;
    }

    // P4（D13）：按渠道账号路由到对应 agent。缺省/未命中 → 默认 agent（行为不变）。
    const resolved = this.agents.resolve(context.agentRoute);

    logger.info(
      {
        channel: context.channelId,
        agentRoute: context.agentRoute ?? "(none)",
        agent: resolved.record.descriptor.id,
        routeMatched: resolved.matched,
        chatId: context.chatId,
        senderId: context.senderId,
        content: context.content.slice(0, 100),
      },
      "Received message"
    );

    // 忽略空消息
    if (!context.content.trim()) {
      return;
    }

    try {
      // 处理消息
      const response = await resolved.agent.processMessage(context);

      // 发送回复
      await this.sendReply(context, response.content);

      logger.info(
        {
          channel: context.channelId,
          agent: resolved.record.descriptor.id,
          chatId: context.chatId,
          responseLength: response.content.length,
        },
        "Reply sent"
      );
    } catch (error) {
      logger.error({ error, context }, "Failed to process message");

      // 发送错误提示
      await this.sendReply(context, "抱歉，处理您的消息时出现了错误。请稍后重试。");
    }
  }

  /**
   * 发送回复。
   *
   * P4（D13 / F1-F3）：**按 agentRoute 选通道实例**，而不是按渠道类型取"代表实例" ——
   * 同类型多账号下，后者会把第二个账号的回复打到第一个账号（跨商户泄漏）。
   * route 缺失时回退到渠道类型代表实例（单账号场景与老行为一致）。
   */
  private async sendReply(context: InboundMessageContext, text: string): Promise<void> {
    const channel = getChannelAccount(context.agentRoute) ?? getChannel(context.channelId);
    if (!channel) {
      logger.warn({ channelId: context.channelId, agentRoute: context.agentRoute }, "No channel registered for reply");
      return;
    }
    // 需求 3：按渠道把回复渲染成该渠道能正确显示的格式（QQ 等纯文本渠道去掉 markdown）
    const rendered = formatForChannel(context.channelId, text);
    try {
      await channel.replyToContext(context, rendered);
    } catch (error) {
      logger.error({ error, channelId: context.channelId, chatId: context.chatId }, "Failed to send reply");
    }
  }

  /** 检查是否为重复消息（使用带容量上限的缓存，自动过期） */
  private isDuplicateMessage(messageId: string): boolean {
    if (this.processedMessages.has(messageId)) {
      return true;
    }
    this.processedMessages.set(messageId, 1);
    return false;
  }

  /** 初始化 */
  async initialize(): Promise<void> {
    logger.info("Initializing gateway...");

    // 初始化模型提供商
    initializeProviders(this.config);

    // 初始化 WebSocket 服务器
    this.wsServer = new WsServer({
      server: this.httpServer,
      agent: this.agent,
      config: this.config,
    });

    // 初始化通道
    if (this.feishuChannel) {
      await this.feishuChannel.initialize();
    }
    if (this.dingtalkChannel) {
      await this.dingtalkChannel.initialize();
    }
    if (this.qqChannel) {
      await this.qqChannel.initialize();
    }
    if (this.wecomChannel) {
      await this.wecomChannel.initialize();
    }
    if (this.emailChannel) {
      await this.emailChannel.initialize();
    }
    // P4：附加账号通道（多账号）
    for (const extra of this.extraChannels) {
      try {
        await extra.channel.initialize();
        logger.info({ route: extra.route }, "额外渠道账号已初始化");
      } catch (error) {
        // 附加账号初始化失败**不得**拖垮主流程（如第二商户账号凭据是占位符）——
        // 但必须显式告警：失败的路由收不到消息，属于可观测事件而非可忽略事件。
        logger.warn({ route: extra.route, error: (error as Error).message }, "额外渠道账号初始化失败（该路由暂不工作，主流程继续）");
      }
    }

    logger.info("Gateway initialized");
  }

  /** 启动服务器 */
  async start(): Promise<void> {
    await this.initialize();

    const { port, host } = this.config.server;

    this.httpServer.listen(port, host || "0.0.0.0", () => {
      logger.info({ port, host: host || "0.0.0.0" }, "Gateway server started");
      console.log(`\n🚀 Mozi Gateway 已启动`);
      console.log(`   地址: http://${host || "localhost"}:${port}`);
      console.log(`   WebChat: http://${host || "localhost"}:${port}/`);
      console.log(`   控制台: http://${host || "localhost"}:${port}/control`);
      console.log(`   健康检查: http://${host || "localhost"}:${port}/health`);
      if (this.feishuChannel) {
        console.log(`   飞书: WebSocket 长连接已启动`);
      }
      if (this.dingtalkChannel) {
        console.log(`   钉钉: Stream 长连接已启动`);
      }
      if (this.qqChannel) {
        console.log(`   QQ 机器人: WebSocket 长连接已启动`);
      }
      if (this.wecomChannel) {
        console.log(`   企业微信 Webhook: http://${host || "localhost"}:${port}/wecom/webhook`);
      }
      if (this.emailChannel) {
        const c = this.config.channels.email!;
        console.log(`   邮件: IMAP ${c.imapHost}（轮询 ${c.pollIntervalSec ?? 30}s，SLA ${c.slaMinutes ?? 240} 分钟）→ SMTP ${c.smtpHost}`);
      }
      console.log("");
    });
  }

  /** 关闭 */
  async shutdown(): Promise<void> {
    logger.info("Shutting down gateway...");

    if (this.wsServer) {
      this.wsServer.close();
    }

    if (this.feishuChannel) {
      await this.feishuChannel.shutdown();
    }
    if (this.dingtalkChannel) {
      await this.dingtalkChannel.shutdown();
    }
    if (this.qqChannel) {
      await this.qqChannel.shutdown();
    }
    if (this.wecomChannel) {
      await this.wecomChannel.shutdown();
    }
    if (this.emailChannel) {
      await this.emailChannel.shutdown();
    }
    for (const extra of this.extraChannels) {
      try {
        await extra.channel.shutdown();
      } catch (error) {
        logger.warn({ route: extra.route, error: (error as Error).message }, "额外渠道账号关闭失败");
      }
    }

    this.httpServer.close();

    logger.info("Gateway shut down");
  }

  /** 获取 Express 应用 */
  getApp(): Express {
    return this.app;
  }
}

/** 创建 Gateway */
export async function createGateway(config: MoziConfig, opts?: { skipDefaultAgent?: boolean }): Promise<Gateway> {
  const gateway = new Gateway(config);
  // P4：launcher 用描述符装配默认 agent 时，**必须在 initAgent 之前**标记跳过，
  // 否则会先创建并注册一个 "junwuyou" 默认 agent，随后描述符装配再注册同名 → 重复注册抛错。
  if (opts?.skipDefaultAgent) gateway.markAgentAssembled();
  await gateway.initAgent();
  return gateway;
}

/** 启动 Gateway 服务器 */
export async function startGateway(config: MoziConfig): Promise<Gateway> {
  // 设置日志
  setLogger(createLogger({ level: config.logging.level }));

  const gateway = await createGateway(config);
  await gateway.start();

  // 优雅关闭
  process.on("SIGINT", async () => {
    console.log("\n收到 SIGINT 信号，正在关闭...");
    await gateway.shutdown();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log("\n收到 SIGTERM 信号，正在关闭...");
    await gateway.shutdown();
    process.exit(0);
  });

  return gateway;
}
