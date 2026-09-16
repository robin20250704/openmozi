/**
 * Agent Runtime - 使用 pi-coding-agent 的 createAgentSession 高层 API
 * 管理多会话，提供 chat 和 chatStream 接口
 */

import { join } from "path";
import * as os from "os";
import {
  createAgentSession,
  AgentSession,
  SessionManager,
  ModelRuntime,
  type ToolDefinition,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { MoziConfig, ProviderId, InboundMessageContext } from "../types/index.js";
import { initModelResolver, getApiKeyForProvider } from "../providers/model-resolver.js";
import { getChildLogger } from "../utils/logger.js";
import { buildSystemPrompt } from "./system-prompt.js";
import type { SkillsRegistry } from "../skills/index.js";
import type { MemoryManager } from "../memory/index.js";
import type { CronService } from "../cron/service.js";

const logger = getChildLogger("runtime");

/** Runtime 配置 */
export interface RuntimeConfig {
  model: string;
  provider: ProviderId;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  workingDirectory?: string;
  sessionDir?: string;
  memoryManager?: MemoryManager;
  cronService?: CronService;
}

/** Chat 响应 */
export interface ChatResponse {
  content: string;
  provider: ProviderId;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/** Stream 事件 */
export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; name: string; argsPreview: string }
  | { type: "tool_end"; isError: boolean };

/**
 * AgentRuntime - 管理 AgentSession 实例
 */
export class AgentRuntime {
  private sessions = new Map<string, AgentSession>();
  private config: RuntimeConfig;
  /** transcript 存储（惰性加载；webchat 由 WS 层负责，渠道由本类负责） */
  private _store: unknown = null;
  private _storeLoaded: boolean | undefined = undefined;
  private sessionDir: string;
  private skillsRegistry: SkillsRegistry | null = null;
  private customTools: AgentTool[] = [];
  /** 惰性共享的 ModelRuntime（pi 0.85：替代旧 AuthStorage+ModelRegistry，内置 minimax-cn provider） */
  private _modelRuntime: ModelRuntime | null = null;

  constructor(config: RuntimeConfig) {
    this.config = config;
    this.sessionDir = config.sessionDir ?? join(os.homedir(), ".mozi", "sessions");

    logger.info({ sessionDir: this.sessionDir }, "AgentRuntime initialized");
  }

  /** 设置 SkillsRegistry */
  setSkillsRegistry(registry: SkillsRegistry): void {
    this.skillsRegistry = registry;
  }

  /** 注册自定义工具 */
  registerCustomTool(tool: AgentTool): void {
    this.customTools.push(tool);
  }

  /**
   * P1 升级（pi 0.85）：把 OpenMozi 的 provider 映射到 pi 内置 provider。
   * 旧版用 custom-anthropic（手动注册 api.minimax.chat 的 anthropic 通道）；0.85 内置 minimax-cn
   * （api.minimaxi.com，我们的 MINIMAX_API_KEY 实测有效，MiniMax-M3 走标准 anthropic-messages）。
   * 这样删掉整段手动 AuthStorage+ModelRegistry+registerProvider 装配（也正是 L-102 被旁路的代码）。
   */
  private piProviderId(): string {
    const p = String(this.config.provider);
    // custom-anthropic / minimax / custom-openai（MiniMax 各历史通道）统一收敛到内置 minimax-cn
    if (p === "custom-anthropic" || p === "minimax" || p === "custom-openai") return "minimax-cn";
    return p;
  }

  /** 取 MiniMax API key（优先 config.providers，回退 MINIMAX_API_KEY 环境变量） */
  private minimaxApiKey(): string | undefined {
    return (
      getApiKeyForProvider(this.config.provider) ||
      getApiKeyForProvider("minimax") ||
      getApiKeyForProvider("minimax-cn") ||
      process.env.MINIMAX_API_KEY
    );
  }

  /** 惰性创建共享 ModelRuntime：注入 minimax-cn 凭据（env 解耦，走 InMemoryCredentialStore） */
  private async getOrCreateModelRuntime(): Promise<ModelRuntime> {
    if (this._modelRuntime) return this._modelRuntime;
    const creds = new InMemoryCredentialStore();
    const key = this.minimaxApiKey();
    if (key) {
      await creds.modify("minimax-cn", () => Promise.resolve({ type: "api_key" as const, key }));
    }
    this._modelRuntime = await ModelRuntime.create({ credentials: creds });
    return this._modelRuntime;
  }

  /** 获取或创建会话 */
  private async getOrCreateSession(sessionKey: string): Promise<AgentSession> {
    let session = this.sessions.get(sessionKey);
    if (session) return session;

    // P1 升级（pi 0.85）：用内置 provider + ModelRuntime 取模型（替代旧 resolveModel+AuthStorage+ModelRegistry 手动装配）
    const modelRuntime = await this.getOrCreateModelRuntime();
    const piProvider = this.piProviderId();
    const model = modelRuntime.getModel(piProvider, this.config.model);
    if (!model) {
      const avail = modelRuntime.getModels(piProvider).map((m) => m.id).join(", ");
      throw new Error(`Cannot resolve model: ${piProvider}/${this.config.model} (available: ${avail || "none"})`);
    }
    logger.debug({ provider: piProvider, model: model.id, baseUrl: model.baseUrl }, "Model resolved via built-in provider");

    // 为每个会话创建独立的 SessionManager
    const sessionFile = join(this.sessionDir, `${this.sanitizeSessionKey(sessionKey)}.jsonl`);
    const sessionManager = SessionManager.create(this.config.workingDirectory ?? process.cwd(), sessionFile);

    // 构建自定义工具定义
    const customToolDefinitions: ToolDefinition[] = this.customTools.map((tool) => ({
      name: tool.name,
      label: tool.label ?? tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: tool.execute,
    }));

    // 创建 AgentSession（pi 0.85：传 modelRuntime + model；不再传 authStorage/modelRegistry）
    const { session: newSession } = await createAgentSession({
      cwd: this.config.workingDirectory ?? process.cwd(),
      modelRuntime,
      model,
      thinkingLevel: "medium" as ThinkingLevel,
      sessionManager,
      customTools: customToolDefinitions,
      noTools: "builtin",  // L-034: 禁用 read/bash/edit/write 等 coding tools，对话客服用不到
      tools: customToolDefinitions.map((t) => t.name),  // 只激活 custom tools
    });

    // 设置系统提示 (pi 0.73: state.systemPrompt 替代 setSystemPrompt)
    const systemPrompt = this.buildSystemPromptText();

    // L-035: 先调用 setActiveToolsByName 让 base system prompt 包含 custom tools 的描述
    if (this.customTools.length > 0 && typeof (newSession as any).setActiveToolsByName === "function") {
      (newSession as any).setActiveToolsByName(this.customTools.map((t) => t.name));
    }

    // L-036: 改写 _baseSystemPrompt（注入小君角色 prompt）
    // 这样 pi-agent 内部 line 797 重置时仍用 OpenMozi 的 prompt
    if ((newSession as any)._baseSystemPrompt !== undefined) {
      // 保留 setActiveToolsByName 注入的 tool descriptions（小君 prompt 已被 setStateSystemPrompt 覆盖）
      (newSession as any)._baseSystemPrompt = systemPrompt;
    }
    newSession.agent.state.systemPrompt = systemPrompt;

    // 如果有自定义工具，追加到 agent（不要覆盖 createAgentSession 已注册的 customTools）
    // L-034: 0.60 时 setTools(this.customTools) 是必须的（没 customTools 参数），
    // 但 0.73 createAgentSession({ customTools }) 已经把工具注册好；
    // 再次赋值会丢失 createAgentSession 内部的工具 wrapper（包括 onUpdate 回调）。
    // 解法：检查 state.tools 是否已有 customTools 名字，没有才追加。
    if (this.customTools.length > 0) {
      const existingNames = new Set((newSession.agent.state.tools || []).map((t: any) => t.name));
      const toAdd = this.customTools.filter((t) => !existingNames.has(t.name));
      if (toAdd.length > 0) {
        newSession.agent.state.tools = [...(newSession.agent.state.tools || []), ...toAdd];
      }
    }

    this.sessions.set(sessionKey, newSession);
    logger.debug({ sessionKey }, "New session created");

    return newSession;
  }

  /**
   * 在"请求上下文"中执行一次对话轮次（需求 1/2/4 的关键接线）。
   *
   * 做了什么：
   *  1. 取客户档案（跨会话，按客户身份而非 session_id）；
   *  2. 把 { sessionKey, identity, profileText } 放进 AsyncLocalStorage —— 适配器
   *     构造发往 LLM 的请求时读出，把档案作为**请求级尾部后缀**注入（不落历史）；
   *  3. 后缀不破坏前缀 → 系统提示 + 工具 + 历史消息这一段仍能命中提示词缓存。
   */
  private async runWithProfile<T>(sessionKey: string, context: InboundMessageContext, fn: () => Promise<T>): Promise<T> {
    // P0.6：先解析客户身份（会话键已按客户汇聚）→ 身份/客户 id 进请求上下文，
    // 模型侧看不到数字主键（V-009），但工具层能取到（订单归属、回投目标都靠它）。
    const resolved = await this.resolveIdentity(context, sessionKey);
    const rc = await this.loadBusinessLib("request-context");
    // ctx 是**同一个对象引用**：先把身份放进去，档案加载完再补 profileText。
    // 适配器在发请求时（晚于本函数）才读 profileText，因此单层上下文即可（不必嵌套两层）。
    const ctx: Record<string, unknown> = {
      sessionKey,
      identity: resolved.identity || sessionKey,
      customerId: resolved.customerId ?? null,
      profileText: "",
      channelSuffix: this.buildChannelSuffix(context),
    };
    return await rc.runWithRequestContext(ctx, async () => {
      if (process.env.PROFILE_INJECT !== "false") {
        try {
          const lib = await this.loadBusinessLib("customer-profile");
          ctx.profileText = (await lib.loadProfileText(resolved.identity || sessionKey)) || "";
        } catch (e) {
          logger.warn({ error: (e as Error).message, sessionKey }, "Profile load failed; continuing without profile");
        }
      }
      return await fn();
    });
  }

  /** 构建系统提示 */
  private buildSystemPromptText(): string {
    // 需求 4（前缀稳定/提升缓存率）：系统提示位于**可缓存前缀的最前面**，
    // 一旦含动态内容（如 "Current time: 22:45"），前缀每轮都变 →
    // 提示词缓存全量失效、成本全额。故默认**不注入时间**；
    // 需要时间的能力（如"今天几号"）改由预约工具返回真实日期，或显式开 env 退回去。
    const includeDateTime = process.env.AGENT_INCLUDE_DATETIME === "true";
    return buildSystemPrompt({
      basePrompt: this.config.systemPrompt,
      workingDirectory: this.config.workingDirectory,
      includeEnvironment: true,
      includeDateTime,
      includeToolRules: false,
      skillsPrompt: this.skillsRegistry?.buildPrompt(),
      enableMemory: !!this.config.memoryManager,
    });
  }

  /** 动态加载 junwuyou 业务库（纯 JS，不参与 tsc 编译，故用变量路径避免类型解析） */
  private async loadBusinessLib(name: string): Promise<any> {
    const spec = `../../junwuyou/lib/${name}.js`;
    return await import(spec);
  }

  /** 渠道级提示词后缀（P0.6）：按渠道切换交互范式，但**不动可缓存前缀**（L-063） */
  private buildChannelSuffix(context: InboundMessageContext): string {
    if (context.channelId === "email") {
      const sla = process.env.EMAIL_SLA_MINUTES ?? "240";
      return [
        "【渠道要求：邮件】",
        "本轮对话来自邮件渠道，与即时通讯不同，必须遵守：",
        "1. 语气正式、书面化：不用「哈」「～」「啦」这类口语与颜文字，不用 emoji；",
        "2. 有称呼与落款：开头写「您好，」，结尾写「如需进一步协助，请直接回复本邮件。君无忧客服」；",
        "3. 结构清晰：把要点分条写清（纯文本 1. 2. 3.），不要用 markdown 标记；",
        `4. 时效口径：邮件回复时限约为 ${sla} 分钟（非即时），需要确认或等待的事项要如实说明，不要承诺「马上」；`,
        "5. 内容完整：一封邮件里把客户问的事说清楚，避免来回多封。",
      ].join("\n");
    }
    return "";
  }

  /**
   * 解析入站消息的客户身份（P0.6 / C-039~C-042）。
   *
   * 为什么必须在这一层做：会话键原来 = `{channel}:{senderId}`，同一人跨渠道就是两个会话、
   * 两份档案。身份汇聚的**判定**在业务库侧（`junwuyou/server/identity/store.js`，唯一实现），
   * 这里只负责"问一次、拿到 customer_id 与会话键"。
   *
   * 为什么 webchat 不参与：它是本机调试页，`webchat:client_*` 每连接新建（实测 60/66 行
   * 客户是它的测试产物，P-22）；把它纳入汇聚只会继续污染客户表。**残留 R13**。
   *
   * 兜底（V-016）：业务库不可达时不阻塞对话，回退旧键（本次不记忆，但绝不共用占位键）。
   */
  private async resolveIdentity(context: InboundMessageContext, legacyKey: string | null): Promise<{
    ok: boolean; customerId: number | null; sessionKey: string; identity: string; fallback: boolean; error?: string;
  }> {
    if (context.channelId === "webchat") {
      return { ok: false, customerId: null, sessionKey: legacyKey ?? "", identity: legacyKey ?? "", fallback: true, error: "webchat-excluded" };
    }
    try {
      const lib = await this.loadBusinessLib("identity-client");
      return await lib.resolveInboundIdentity({
        channel: context.channelId,
        senderId: context.senderId,
        chatId: context.chatId,
        chatType: context.chatType,
        senderName: context.senderName,
        legacySessionKey: legacyKey,
      });
    } catch (e) {
      logger.warn({ error: (e as Error).message, channel: context.channelId }, "Identity client unavailable; falling back to legacy session key");
      return { ok: false, customerId: null, sessionKey: legacyKey ?? "", identity: legacyKey ?? "", fallback: true, error: (e as Error).message };
    }
  }

  /** 清理 session key 使其可作为文件名 */
  private sanitizeSessionKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  /**
   * 旧键（渠道身份）：`{channel}:{senderId}`，逐级回退到 chatId，再退化为**每次请求独立**的临时身份。
   *
   * L-057：原先直接用 `context.senderId`，若渠道未取到 openid 会得到 "qq:undefined" ——
   * 所有这类用户共用一个会话、互相能看到历史。宁可"这次不记得"，也绝不与他人串话。
   */
  private legacySessionKey(context: InboundMessageContext): string {
    const stable = context.senderId || context.chatId;
    if (stable) {
      return `${context.channelId}:${stable}`;
    }
    const temp = `tmp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    logger.warn(
      { channelId: context.channelId, sessionKey: `${context.channelId}:${temp}` },
      "渠道未提供稳定身份（senderId/chatId 均缺失）→ 使用临时身份（本轮会话不跨轮、不与他人共享）"
    );
    return `${context.channelId}:${temp}`;
  }

  /**
   * 会话键（P0.6 / C-040）：**按客户汇聚**。
   *
   * 顺序：身份层解析出 customer_id → `customer:{id}`（同一人跨渠道落在同一会话）；
   * 解析不可用（业务库不可达 / 无身份 / 群聊）→ 回退旧键 `{channel}:{senderId}`（V-016 兜底）。
   * 键的形态只有这一处决定（V-014），别处不得再拼一遍。
   */
  private async sessionKeyFor(context: InboundMessageContext, legacyKey: string): Promise<string> {
    const r = await this.resolveIdentity(context, legacyKey);
    if (r.ok && r.sessionKey) return r.sessionKey;
    return legacyKey;
  }

  /** 非流式聊天 */
  async chat(context: InboundMessageContext): Promise<ChatResponse> {
    const legacyKey = this.legacySessionKey(context);
    const sessionKey = await this.sessionKeyFor(context, legacyKey);
    logger.debug({ sessionKey, legacyKey, content: context.content.slice(0, 100) }, "Processing message");

    const session = await this.getOrCreateSession(sessionKey);

    // L-056: 渠道消息（QQ 等）原先不经过 webchat 的 SessionStore，transcript 从不落盘
    // → 网关重启即失忆（实测 qq_*.jsonl 全是 0 字节）。这里补落盘 + 新会话时恢复。
    const store = await this.getTranscriptStore();
    await this.persistAndRestore(context, sessionKey, session, store);

    // 发送消息（先强制设置 systemPrompt，覆盖 pi-agent 0.73 的默认 "Robin Writer"）
    const systemPrompt = this.buildSystemPromptText();
    session.agent.state.systemPrompt = systemPrompt;
    await this.appendTurn(store, context, sessionKey, "user", context.content);
    await this.runWithProfile(sessionKey, context, async () => {
      await session.prompt(context.content);
      await session.agent.waitForIdle();
    });

    // 提取最后一条助手消息
    let lastText = session.getLastAssistantText() ?? "";

    // D8/P2 安全兜底：MiniMax-M3 在复杂 prompt 首轮会把工具调用写成 DSML 文本（非标准 tool_use），
    // 内置 provider 标准解析器把 DSML 当纯文本透传 → 漏给客户。这里识别并就地处理：
    // 白名单工具 → 直接执行后带结果重问；非白名单/不可解析 → 剥掉 DSML 强提示重问一次。
    if (this.containsDsml(lastText)) {
      lastText = await this.recoverFromDsmlLeak(session, lastText, context);
    }

    await this.appendTurn(store, context, sessionKey, "assistant", lastText);

    // 获取使用统计
    const stats = session.getSessionStats();

    return {
      content: lastText,
      provider: this.config.provider,
      model: this.config.model,
      usage: {
        promptTokens: stats.tokens.input,
        completionTokens: stats.tokens.output,
        totalTokens: stats.tokens.total,
      },
    };
  }

  /** 检测助手回复里是否漏出 MiniMax DSML 工具调用语法（D8/P2 安全兜底） */
  private containsDsml(text: string): boolean {
    return typeof text === "string" && text.includes("<｜｜DSML｜｜");
  }

  /**
   * 从 DSML 文本里解析工具调用（name + arguments）。
   * 兼容实测形态：`<｜｜DSML｜｜ invoke name="X" arguments="{...}">...</｜｜DSML｜｜ invoke>`。
   * arguments 可能是含转义引号的 JSON，用非贪婪 + 转义感知捕获。
   */
  private extractDsmlToolCalls(text: string): Array<{ name: string; args: Record<string, unknown> }> {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const re = /<｜｜DSML｜｜\s*invoke\s+name="([^"]+)"\s+arguments="((?:[^"\\]|\\.)*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = m[1] ?? "";
      if (!name) continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse((m[2] ?? "").replace(/\\"/g, '"')) as Record<string, unknown>;
      } catch {
        args = {};
      }
      calls.push({ name, args });
    }
    return calls;
  }

  /**
   * DSML 泄漏就地恢复（D8/P2）：
   * 1) 若 DSML 里解析出**白名单内**工具 → 直接执行该工具，把结果喂回会话重问，让模型用大白话作答；
   * 2) 否则（幻觉工具名/不可解析）→ 剥掉 DSML 文本，带强提示重问一次。
   * 重试上限 2 次，仍泄漏则吞掉 DSML 段落、只留自然语言，绝不把 `<｜｜DSML｜｜` 透给客户。
   */
  private async recoverFromDsmlLeak(session: AgentSession, leaked: string, context: InboundMessageContext): Promise<string> {
    const stripDsml = (s: string) =>
      s
        .replace(/<｜｜DSML｜｜[\s\S]*?<｜｜DSML｜｜\s*calls>/g, "")
        .replace(/<｜｜DSML｜｜[\s\S]*$/g, "")
        .trim();

    for (let attempt = 0; attempt < 2; attempt++) {
      const calls = this.extractDsmlToolCalls(leaked);
      const whitelisted = calls.find((c) => this.customTools.some((t) => t.name === c.name));

      try {
        if (whitelisted) {
          const tool = this.customTools.find((t) => t.name === whitelisted.name)!;
          logger.warn({ tool: whitelisted.name, args: whitelisted.args }, "DSML leak: executing whitelisted tool directly");
          const result = await tool.execute("dsml-guard", whitelisted.args as never);
          const resultText = (result?.content ?? [])
            .map((c: { type: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : ""))
            .join("\n");
          await session.prompt(
            `（系统提示：你刚才想调用工具 ${whitelisted.name}，系统已替你执行。返回结果如下，请直接用大白话回答客户，禁止再输出任何 <｜｜DSML｜｜ 工具语法。）\n工具结果：${resultText}`
          );
        } else {
          logger.warn({ leaked: leaked.slice(0, 120) }, "DSML leak: no whitelisted tool parsed, re-prompting with nudge");
          await session.prompt(
            `（系统提示：请直接用自然语言回答客户，禁止输出任何 <｜｜DSML｜｜ 工具调用语法；如需查价/查知识库，请调用你已有的工具拿到结果后，用大白话告诉客户。）\n客户原话：${context.content}`
          );
        }
        await session.agent.waitForIdle();
        leaked = session.getLastAssistantText() ?? "";
        if (!this.containsDsml(leaked)) return leaked.trim();
      } catch (e) {
        logger.warn({ error: (e as Error).message }, "DSML leak recovery attempt failed");
        break;
      }
    }
    // 兜底：仍泄漏则吞掉 DSML 段落，只留自然语言
    const cleaned = stripDsml(leaked);
    return cleaned.length > 0 ? cleaned : "您好，这个问题我帮您确认一下，稍后回复您。";
  }

  /** 流式聊天 */
  async *chatStream(
    context: InboundMessageContext,
    options?: { signal?: AbortSignal }
  ): AsyncGenerator<StreamEvent, ChatResponse, unknown> {
    const legacyKey = this.legacySessionKey(context);
    const sessionKey = await this.sessionKeyFor(context, legacyKey);
    logger.debug({ sessionKey, legacyKey, content: context.content.slice(0, 100) }, "Processing message (stream)");

    const session = await this.getOrCreateSession(sessionKey);

    // 事件队列
    const eventQueue: StreamEvent[] = [];
    let done = false;
    let promptError: Error | null = null;

    // D8/P2 流式 DSML 兜底：MiniMax 偶发把工具调用写成 DSML 文本增量透传。
    // 用状态机吞掉 DSML 段落（<｜｜DSML｜｜ ... </｜｜DSML｜｜ calls>），只放行自然语言增量。
    // 处理跨增量被切开的标记：把未决尾巴留在 pending，等下一个增量拼齐再判。
    const DSML_OPEN = "<｜｜DSML｜｜";
    const DSML_CLOSE = "</｜｜DSML｜｜";
    let dsmlPending = "";
    let dsmlInBlock = false;
    const dsmlFilter = (delta: string): string => {
      let buf = dsmlPending + delta;
      let out = "";
      for (;;) {
        if (dsmlInBlock) {
          const closeIdx = buf.indexOf(DSML_CLOSE);
          if (closeIdx === -1) { buf = ""; break; } // 整块仍在 DSML 内，全吞
          buf = buf.slice(closeIdx + DSML_CLOSE.length);
          // 跳过到 calls> 结束（若紧跟）
          const gt = buf.indexOf(">");
          if (gt !== -1 && gt <= 6) buf = buf.slice(gt + 1);
          dsmlInBlock = false;
          continue;
        }
        const openIdx = buf.indexOf(DSML_OPEN);
        if (openIdx === -1) {
          // 无开标记：保留可能是半个开标记的尾巴，其余放行
          const tail = buf.length >= DSML_OPEN.length ? buf.slice(-(DSML_OPEN.length - 1)) : buf;
          const emitEnd = buf.length - tail.length;
          out += buf.slice(0, emitEnd);
          buf = tail;
          break;
        }
        // 有开标记：放行其前的干净文本，进入吞 DSML 模式
        out += buf.slice(0, openIdx);
        buf = buf.slice(openIdx);
        dsmlInBlock = true;
      }
      dsmlPending = buf;
      return out;
    };

    // 订阅事件
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "message_update") {
        const updateEvent = event as { type: "message_update"; assistantMessageEvent: { type: string; delta?: string } };
        // 处理 text_delta（正常内容）
        if (updateEvent.assistantMessageEvent?.type === "text_delta" && updateEvent.assistantMessageEvent.delta) {
          const clean = dsmlFilter(updateEvent.assistantMessageEvent.delta);
          if (clean) eventQueue.push({ type: "text_delta", delta: clean });
        }
        // thinking_delta 不转发给用户（reasoning 内容是内部的，不应暴露给终端客户）
        // 通过 config.agent.thinkingVisible=true 可重新打开（调试用）
        else if (updateEvent.assistantMessageEvent?.type === "thinking_delta" && updateEvent.assistantMessageEvent.delta && process.env.AGENT_THINKING_VISIBLE === "true") {
          eventQueue.push({ type: "text_delta", delta: updateEvent.assistantMessageEvent.delta });
        }
      } else if (event.type === "tool_execution_start") {
        const toolEvent = event as any;
        const argsPreview = this.getArgsPreview(toolEvent.args);
        eventQueue.push({ type: "tool_start", name: toolEvent.toolName, argsPreview });
      } else if (event.type === "tool_execution_end") {
        const toolEvent = event as any;
        if (toolEvent.isError) {
          console.error(`[runtime] tool ${toolEvent.toolName} error:`, toolEvent.result?.errorMessage || JSON.stringify(toolEvent.result));
        }
        eventQueue.push({ type: "tool_end", isError: toolEvent.isError });
      } else if (event.type === "agent_end") {
        done = true;
      }
    });

    // 启动 prompt（先强制设置 systemPrompt，覆盖 pi-agent 0.73 的默认 "Robin Writer"）
    const systemPrompt = this.buildSystemPromptText();
    session.agent.state.systemPrompt = systemPrompt;
    const promptPromise = this.runWithProfile(sessionKey, context, () =>
      session.prompt(context.content, { streamingBehavior: "followUp" }).then(() => session.agent.waitForIdle())
    )
      .catch((err: unknown) => {
        done = true;
        promptError = err instanceof Error ? err : new Error(String(err));
      });

    // 流式输出事件
    try {
      while (!done) {
        if (options?.signal?.aborted) {
          session.agent.abort();
          throw new DOMException("Aborted", "AbortError");
        }

        while (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        }

        if (!done) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      // 排空剩余事件
      while (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      }
    } finally {
      unsubscribe();
    }

    await promptPromise;

    if (promptError) {
      throw promptError;
    }

    // 获取结果
    const lastText = session.getLastAssistantText() ?? "";
    const stats = session.getSessionStats();

    return {
      content: lastText,
      provider: this.config.provider,
      model: this.config.model,
      usage: {
        promptTokens: stats.tokens.input,
        completionTokens: stats.tokens.output,
        totalTokens: stats.tokens.total,
      },
    };
  }

  /** 获取参数预览 */
  private getArgsPreview(args: Record<string, unknown>): string {
    if (!args) return "";
    const mainArg = args.path ?? args.directory ?? args.command ?? args.query ?? args.pattern;
    if (typeof mainArg === "string") {
      const preview = mainArg.replace(/\n/g, " ").trim();
      return preview.length > 40 ? preview.slice(0, 40) + "…" : preview;
    }
    return "";
  }

  /** 清除会话 */
  async clearSession(context: InboundMessageContext): Promise<void> {
    const sessionKey = await this.sessionKeyFor(context, this.legacySessionKey(context));
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.dispose();
      this.sessions.delete(sessionKey);
    }
    logger.debug({ sessionKey }, "Session cleared");
  }

  /** 获取会话信息（webchat 用；同步接口，身份未解析时以旧键为准） */
  async getSessionInfo(context: InboundMessageContext): Promise<{
    messageCount: number;
    lastUpdate: Date;
  } | null> {
    // P1：与 chat 用同一汇聚会话键（sessionKeyFor），否则身份解析出 customer:{id} 后
    // 这里按旧键 {channel}:{senderId} 查 → 永远 null（原实现与 chat 不一致的潜在缺陷，
    // 此前被"模型不可解析"的 mock 失败掩盖，升级后暴露）。
    const legacyKey = this.legacySessionKey(context);
    const sessionKey = await this.sessionKeyFor(context, legacyKey);
    const session = this.sessions.get(sessionKey);
    if (!session) return null;

    const stats = session.getSessionStats();
    return {
      messageCount: stats.totalMessages,
      lastUpdate: new Date(),
    };
  }

  /** 从历史恢复会话 */
  async restoreSessionFromTranscript(
    sessionKey: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>
  ): Promise<void> {
    const session = await this.getOrCreateSession(sessionKey);
    if (!messages || messages.length === 0) {
      return;
    }

    // L-055: 原实现是空壳（只打日志），导致 webchat 刷新/断线重连/网关重启后
    // UI 显示着历史、但 agent 的 LLM 上下文是空的 → 客户接着问，agent 当没听过，
    // 反复追问已提供的信息（客户反馈的真实症状）。
    // 现在真正把 transcript 注入 pi-agent 的 state.messages（pi-agent 文档化 API：
    // "Assigning state.tools or state.messages copies the provided top-level array"）。
    const existing = (session.agent?.state?.messages as unknown[] | undefined) || [];
    if (existing.length > 0) {
      logger.debug({ sessionKey, existing: existing.length }, "Session already has context, skip restore");
      return;
    }

    const mdl = (session.agent?.state?.model as { api?: string; provider?: string; id?: string } | undefined) || {};
    const now = Date.now();
    const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const restored: unknown[] = [];

    for (const m of messages) {
      if (typeof m?.content !== "string" || !m.content.trim()) {
        continue;
      }
      if (m.role === "user") {
        restored.push({
          role: "user",
          content: [{ type: "text", text: m.content }],
          timestamp: now,
        });
      } else if (m.role === "assistant") {
        restored.push({
          role: "assistant",
          content: [{ type: "text", text: m.content }],
          api: mdl.api ?? "anthropic-messages",
          provider: mdl.provider ?? this.config.provider,
          model: mdl.id ?? String(this.config.model ?? ""),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zeroCost },
          stopReason: "stop",
          timestamp: now,
        });
      }
    }

    if (restored.length === 0) {
      return;
    }
    session.agent.state.messages = restored as unknown as typeof session.agent.state.messages;
    logger.info({ sessionKey, restored: restored.length }, "Session context restored from transcript");
  }

  /** 惰性加载 transcript 存储 */
  private async getTranscriptStore(): Promise<{ getOrCreate: Function; loadTranscript: Function; appendTranscript: Function } | null> {
    if (this._storeLoaded === undefined) {
      try {
        const mod = await import("../sessions/store.js");
        this._store = mod.getSessionStore() as never;
      } catch (e) {
        logger.warn({ error: (e as Error).message }, "Session store unavailable; transcript persistence disabled");
        this._store = null;
      }
      this._storeLoaded = true;
    }
    return this._store as never;
  }

  /** 渠道消息：新会话时从 transcript 恢复上下文（webchat 由 WS 层自己 restore） */
  private async persistAndRestore(
    context: InboundMessageContext,
    sessionKey: string,
    session: AgentSession,
    store: { getOrCreate: Function; loadTranscript: Function } | null
  ): Promise<void> {
    if (!store || context.channelId === "webchat") {
      return;
    }
    try {
      const entry = (await store.getOrCreate(sessionKey)) as { sessionId: string };
      const existing = (session.agent?.state?.messages as unknown[] | undefined) || [];
      if (existing.length === 0) {
        const messages = (await store.loadTranscript(entry.sessionId)) as Array<{
          role: "user" | "assistant";
          content: string;
        }>;
        if (messages.length > 0) {
          await this.restoreSessionFromTranscript(sessionKey, messages);
          logger.info({ sessionKey, restored: messages.length }, "Channel session restored from transcript");
        }
      }
    } catch (e) {
      logger.warn({ error: (e as Error).message, sessionKey }, "Failed to restore channel session");
    }
  }

  /** 渠道消息落盘（webchat 由 WS 层负责，避免重复追加） */
  private async appendTurn(
    store: { getOrCreate: Function; appendTranscript: Function } | null,
    context: InboundMessageContext,
    sessionKey: string,
    role: "user" | "assistant",
    content: string
  ): Promise<void> {
    if (!store || !content || context.channelId === "webchat") {
      return;
    }
    try {
      const entry = (await store.getOrCreate(sessionKey)) as { sessionId: string };
      await store.appendTranscript(entry.sessionId, sessionKey, {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role,
        content,
        timestamp: Date.now(),
        // P0.6 / C-042：**渠道来源必须随每条消息保存**（会话键按客户汇聚后，
        // 不记来源就无法回投 —— 把企微的回复发到 QQ 是事故）。
        sourceChannel: context.channelId,
        sourceExternalId: context.senderId || context.chatId,
        sourceSessionKey: this.legacySessionKey(context),
      });
    } catch (e) {
      logger.warn({ error: (e as Error).message, sessionKey }, "Failed to append transcript");
    }
  }

  /** 关闭所有会话 */
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    logger.info("All sessions disposed");
  }
}

/** 创建 AgentRuntime */
export function createAgentRuntime(config: MoziConfig): AgentRuntime {
  const runtimeConfig: RuntimeConfig = {
    model: config.agent.defaultModel,
    provider: config.agent.defaultProvider,
    systemPrompt: config.agent.systemPrompt,
    temperature: config.agent.temperature,
    maxTokens: config.agent.maxTokens,
    workingDirectory: config.agent.workingDirectory,
    sessionDir: config.sessions?.directory,
  };

  // 初始化模型解析器
  initModelResolver(config);

  return new AgentRuntime(runtimeConfig);
}
