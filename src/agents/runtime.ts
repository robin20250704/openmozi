/**
 * Agent Runtime - 使用 pi-coding-agent 的 createAgentSession 高层 API
 * 管理多会话，提供 chat 和 chatStream 接口
 */

import { join, isAbsolute, resolve as resolvePath, dirname } from "path";
import { pathToFileURL, fileURLToPath } from "url";
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
import { setFallbackDataDomain, runWithDataDomain, enterWithDataDomain } from "../core/isolation/data-domain.js";
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
  /**
   * Agent 标识（P4 / C-P4-6）：会话键前缀 + 会话文件名前缀。
   * 缺省 undefined → 键形态与单 agent 时代**逐字一致**（U-4 回滚前提）。
   */
  agentId?: string;
  /**
   * 业务 lib 目录（P4 / C-P4-5）：`loadBusinessLib` 的根。
   * 缺省回退 `../../agents/junwuyou/lib/`（老行为，零改动）。
   */
  libDir?: string;
  /** 数据域 id（诊断用） */
  dataDomain?: string;
  /** 本 agent 的业务后端 origin 白名单（`enforceDataOrigin` 用；缺省 undefined = 不启用域约束） */
  allowedOrigins?: string[];
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

    // P4（C-P4-5）：把本 agent 的数据域登记为**请求外兜底**。
    // ⚠️ 为什么是"兜底"而不是"全局设置"：多 agent 同进程时，模块级变量会被**后装配的 agent 覆盖**，
    // 结果 A 的工具带着 B 的白名单发请求 → 被自己的隔离层拒掉（P4a 实测：元一装配后君无忧报价全断）。
    // 因此请求期改用 ALS 上下文（见 chat/chatStream 里的 runWithDataDomain），这里只提供请求外兜底，
    // 且 setFallbackDataDomain **不覆盖**已设置的值（谁兜底由装配顺序之外的规则决定）。
    if (config.allowedOrigins !== undefined) {
      setFallbackDataDomain({
        agentId: config.agentId,
        dataDomain: config.dataDomain,
        allowedOrigins: config.allowedOrigins,
      });
    }

    logger.info(
      { sessionDir: this.sessionDir, agentId: config.agentId ?? "(default)", libDir: config.libDir ?? "(default)" },
      "AgentRuntime initialized"
    );
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
   * 已注册的自定义工具（P4 装配期断言用）。
   *
   * 用途：`assembleAgent` 在装配后断言"注册进本 runtime 的工具名集合 == 描述符声明的 toolset"——
   * 多 agent 下漏注册/串注册（B 的 runtime 里混进 A 的工具）是**安全事件**，
   * 不能等到客户问出错答案才发现（A12/A13）。
   */
  get registeredTools(): AgentTool[] {
    return this.customTools;
  }

  /** 已注册工具名（同上，断言直接可比对） */
  registeredToolNames(): string[] {
    return this.customTools.map((t) => t.name);
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
  private async runWithProfile<T>(sessionKey: string, context: InboundMessageContext, fn: (profileSuffix: string) => Promise<T>): Promise<T> {
    // P0.6：先解析客户身份（会话键已按客户汇聚）→ 身份/客户 id 进请求上下文，
    // 模型侧看不到数字主键（V-009），但工具层能取到（订单归属、回投目标都靠它）。
    const resolved = await this.resolveIdentity(context, sessionKey);
    // P4：business lib 是**每个 agent 各一份**的（数据隔离的直接后果）。新 agent 未必已经
    // 备齐 request-context / customer-profile，缺了不能让整轮对话挂掉 —— 降级为"无档案注入"
    // 并打告警（V-016 兜底：宁可这次不记得，也不中断服务）。缺失本身由 harness/CI 兜底发现。
    let rc: any = null;
    try {
      rc = await this.loadBusinessLib("request-context");
    } catch (e) {
      logger.warn({ error: (e as Error).message, libDir: this.config.libDir }, "request-context 缺失 → 本轮不注入档案/渠道后缀");
    }
    if (!rc?.runWithRequestContext) {
      return await this.runWithProfileDegraded(context, fn);
    }
    // ctx 是**同一个对象引用**：先把身份放进去，档案加载完再补 profileText。
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
      // P1 回归修复：原 pi-anthropic-patch 适配器（已退役）在发请求时把档案/渠道后缀
      // 作为**请求级尾部**注入 LLM。适配器退役后档案虽加载却没人注入 → 模型看不到档案、
      // 重复问地址/电话。这里在 prompt 前显式拼到消息尾部（不落历史、不进可缓存前缀），
      // 由调用方（chat/chatStream）把它追加到本轮用户消息上。
      const suffix = [ctx.profileText, ctx.channelSuffix]
        .filter((s) => typeof s === "string" && s.trim())
        .join("\n\n");
      return await fn(suffix);
    });
  }

  /** 业务库缺失时的降级路径：仍要注入渠道后缀（渠道范式是框架侧知识，不依赖业务库） */
  private async runWithProfileDegraded<T>(context: InboundMessageContext, fn: (profileSuffix: string) => Promise<T>): Promise<T> {
    return await fn(this.buildChannelSuffix(context));
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

  /**
   * 动态加载业务库（纯 JS，不参与 tsc 编译，故用变量路径避免类型解析）。
   *
   * P4（F6/数据隔离）：**根目录可配**。原实现把 `../../agents/junwuyou/lib/` 写死，
   * 于是第二个 agent 的档案/身份/请求上下文**仍然全部来自君无忧** ——
   * 那样"数据隔离"只是名义上的（B 的客户档案查得到 A 的客户）。
   * 现在：`config.libDir` 若给了绝对路径用它；否则相对仓库 `runtime/openmozi/` 解析；
   * 都没给时保留老路径（单 agent 零改动）。
   */
  private async loadBusinessLib(name: string): Promise<any> {
    const configured = this.config.libDir;
    let spec: string;
    if (configured) {
      const base = isAbsolute(configured) ? configured : resolvePath(this.baseDir(), configured);
      // ⚠️ Windows 上绝对路径必须先转 file:// URL：直接丢给 import() 会报
      // ERR_UNSUPPORTED_ESM_URL_SCHEME（协议被解析成 'd:'）。P4 接上 libDir 后
      // **两个 agent 都走这条分支**，漏了这一步会导致元一装配即报"找不到 request-context.js"。
      spec = pathToFileURL(join(base, `${name}.js`)).href;
    } else {
      spec = `../../agents/junwuyou/lib/${name}.js`;
    }
    return await import(spec);
  }

  /** 仓库内 `runtime/openmozi/` 的绝对路径（dist/<分层>/x.js → 上溯到 runtime/openmozi） */
  private baseDir(): string {
    // 本文件编译后位于 dist/agents/runtime.js（或 src/agents/runtime.ts）
    const here = fileURLToPath(import.meta.url);
    return resolvePath(dirname(here), "..", "..");
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
   * 会话键（P0.6 / C-040）：**按客户汇聚**；P4（C-P4-6）：**再按 agent 命名空间隔离**。
   *
   * 顺序：身份层解析出 customer_id → `customer:{id}`（同一人跨渠道落在同一会话）；
   * 解析不可用（业务库不可达 / 无身份 / 群聊）→ 回退旧键 `{channel}:{senderId}`（V-016 兜底）。
   * **P4 加了 agentId 前缀**：两个 agent 的客户 id 由**各自的业务库**产生，
   * 数值会撞（A 的 customer:9 与 B 的 customer:9 是两个人），不加前缀就会**共用会话**。
   * 键的形态只有这一处决定（V-014），别处不得再拼一遍。
   *
   * 前缀缺省不加（`config.agentId` 未设）→ 与单 agent 时代逐字一致。
   */
  private async sessionKeyFor(context: InboundMessageContext, legacyKey: string): Promise<string> {
    const r = await this.resolveIdentity(context, legacyKey);
    const base = r.ok && r.sessionKey ? r.sessionKey : legacyKey;
    return this.namespaced(base);
  }

  /** 给会话键加 agent 命名空间前缀（唯一实现，V-014） */
  private namespaced(key: string): string {
    const id = this.config.agentId;
    if (!id) return key;
    const prefix = `${id}:`;
    return key.startsWith(prefix) ? key : `${prefix}${key}`;
  }

  /**
   * 本轮请求的数据域上下文（P4 / C-P4-5）：**每轮绑定本 runtime 的域**，
   * 供业务 HTTP 客户端在 `enforceDataOrigin` 里读取。
   *
   * 为什么必须每轮绑定而不是 runtime 构造时全局设置：见 data-domain.ts 里"血的教训"——
   * 多 agent 同进程时全局变量会被后装配者覆盖，导致 A 的工具用 B 的白名单发请求。
   */
  private domainContext(): { agentId?: string; dataDomain?: string; allowedOrigins?: string[] } | null {
    if (this.config.allowedOrigins === undefined) return null;
    return {
      agentId: this.config.agentId,
      dataDomain: this.config.dataDomain,
      allowedOrigins: this.config.allowedOrigins,
    };
  }

  /** 在"本轮 agent 的数据域"内执行（无域配置时直接执行，行为不变） */
  private async withDomain<T>(fn: () => Promise<T>): Promise<T> {
    const ctx = this.domainContext();
    return ctx ? runWithDataDomain(ctx, fn) : fn();
  }

  /** 非流式聊天 */
  async chat(context: InboundMessageContext): Promise<ChatResponse> {
    const legacyKey = this.legacySessionKey(context);
    const sessionKey = await this.sessionKeyFor(context, legacyKey);
    logger.debug({ sessionKey, legacyKey, content: context.content.slice(0, 100) }, "Processing message");
    return this.withDomain(() => this.chatWithSession(context, sessionKey));
  }

  /** chat 的主体（已解析会话键）——单独拆出，便于把整轮包进数据域上下文 */
  private async chatWithSession(context: InboundMessageContext, sessionKey: string): Promise<ChatResponse> {

    const session = await this.getOrCreateSession(sessionKey);

    // L-056: 渠道消息（QQ 等）原先不经过 webchat 的 SessionStore，transcript 从不落盘
    // → 网关重启即失忆（实测 qq_*.jsonl 全是 0 字节）。这里补落盘 + 新会话时恢复。
    const store = await this.getTranscriptStore();
    await this.persistAndRestore(context, sessionKey, session, store);

    // 发送消息（先强制设置 systemPrompt，覆盖 pi-agent 0.73 的默认 "Robin Writer"）
    const systemPrompt = this.buildSystemPromptText();
    session.agent.state.systemPrompt = systemPrompt;
    await this.appendTurn(store, context, sessionKey, "user", context.content);
    // ⚠️ 传给 runWithProfile 的必须是**身份键**（`webchat:xxx` / `customer:N`），不能是加了
    // agentId 命名空间的会话键 —— 两者语义不同：会话键管"存哪条会话"，身份键管"档案/订单归谁"。
    // P4 实测踩过：把命名空间键当身份键传 → 客户档案查不到 → **模型重复问客户已给过的地址**
    // （verify-profile-cache D 段 + 真实 webchat 探针双双复现）。
    const identityKey = this.legacySessionKey(context);
    await this.runWithProfile(identityKey, context, async (profileSuffix) => {
      const message = profileSuffix ? `${context.content}\n\n${profileSuffix}` : context.content;
      await session.prompt(message);
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
   * 兼容实测的多种形态：
   *   A) `<｜｜DSML｜｜ invoke name="X" arguments="{...}">`（arguments 作属性）
   *   B) `<｜｜DSML｜｜ invoke name="X"> ... <｜｜DSML｜｜ parameter name="arguments" ...>{...}</｜｜DSML｜｜ parameter>`
   *      （arguments 在子 parameter 里，M3 常见；也有 name="command" 等非 arguments 参数）
   * arguments 可能是含转义引号的 JSON，用非贪婪 + 转义感知捕获。
   */
  private extractDsmlToolCalls(text: string): Array<{ name: string; args: Record<string, unknown> }> {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const parseJson = (raw: string): Record<string, unknown> => {
      try {
        return JSON.parse(raw.replace(/\\"/g, '"')) as Record<string, unknown>;
      } catch {
        return {};
      }
    };

    // 形态 A：arguments 作属性
    const reAttr = /<｜｜DSML｜｜\s*invoke\s+name="([^"]+)"\s+arguments="((?:[^"\\]|\\.)*)"/g;
    let m: RegExpExecArray | null;
    while ((m = reAttr.exec(text)) !== null) {
      const name = m[1] ?? "";
      if (name) calls.push({ name, args: parseJson(m[2] ?? "") });
    }

    // 形态 B：arguments 在子 parameter（跳过已在 A 命中的 name 位置，避免重复）
    const reChild = /<｜｜DSML｜｜\s*invoke\s+name="([^"]+)"[^>]*>[\s\S]*?<｜｜DSML｜｜\s*parameter\s+name="arguments"[^>]*>((?:[^<]|<(?!\/｜｜DSML))*)<\/｜｜DSML｜｜/g;
    while ((m = reChild.exec(text)) !== null) {
      const name = m[1] ?? "";
      if (!name) continue;
      if (calls.some((c) => c.name === name)) continue; // A 已解析过
      calls.push({ name, args: parseJson((m[2] ?? "").trim()) });
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
      // P2 安全打点：DSML 里出现的**全部**工具名（含白名单外）。白名单外工具（如 bash/read/write）
      // 是安全事件——模型幻觉了不该有的工具，必须既不被执行、也不漏给客户。
      const blockedTools = calls.filter((c) => !this.customTools.some((t) => t.name === c.name)).map((c) => c.name);

      try {
        if (whitelisted) {
          const tool = this.customTools.find((t) => t.name === whitelisted.name)!;
          logger.warn({ tool: whitelisted.name, args: whitelisted.args, blockedTools }, "DSML leak: executing whitelisted tool directly");
          const result = await tool.execute("dsml-guard", whitelisted.args as never);
          const resultText = (result?.content ?? [])
            .map((c: { type: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : ""))
            .join("\n");
          await session.prompt(
            `（系统提示：你刚才想调用工具 ${whitelisted.name}，系统已替你执行。返回结果如下，请直接用大白话回答客户，禁止再输出任何 <｜｜DSML｜｜ 工具语法。）\n工具结果：${resultText}`
          );
        } else {
          // 安全事件：白名单外工具（bash/read/write 等）幻觉 → 不执行、吞 DSML、强提示重问
          logger.warn({ blockedTools, leaked: leaked.slice(0, 120) }, "DSML leak: BLOCKED non-whitelisted tool hallucination (not executed, suppressed)");
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
    // P4：整条流式路径也包进本轮 agent 的数据域上下文（与 chat 同一口径，V-014）。
    // ⚠️ enterWith 的上下文**不会自动退出**：它留在当前异步执行链上，链上后续无关的活
    // （另一轮对话、另一个 agent 的工具回调）会读到它 —— harness 首次接线就踩了：
    // 前一段探针留下的"君无忧域"污染了后一段元一工具的调用。故这里在 finally 里显式复位。
    const domainCtx = this.domainContext();
    if (domainCtx) enterWithDataDomain(domainCtx);
    try {
      return yield* this.chatStreamInner(context, options);
    } finally {
      if (domainCtx) enterWithDataDomain({});
    }
  }

  /** chatStream 主体（数据域上下文已绑定） */
  private async *chatStreamInner(
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
    const promptPromise = this.runWithProfile(this.legacySessionKey(context), context, (profileSuffix) => {
      const message = profileSuffix ? `${context.content}\n\n${profileSuffix}` : context.content;
      return session.prompt(message, { streamingBehavior: "followUp" }).then(() => session.agent.waitForIdle());
    })
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
    // P4：与 chat() 用**同一**命名空间（V-014）。调用方（webchat WS 层）传的是它自己的
    // `webchat:xxx` 键，而 chat() 会加 agentId 前缀；若这里不加，恢复与创建会指向两个会话
    // → 客户"刷新后失忆"（L-055 同型症状）。前缀缺省（未设 agentId）时行为不变。
    sessionKey = this.namespaced(sessionKey);
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
export function createAgentRuntime(config: MoziConfig, overrides?: Partial<RuntimeConfig>): AgentRuntime {
  const runtimeConfig: RuntimeConfig = {
    model: config.agent.defaultModel,
    provider: config.agent.defaultProvider,
    systemPrompt: config.agent.systemPrompt,
    temperature: config.agent.temperature,
    maxTokens: config.agent.maxTokens,
    workingDirectory: config.agent.workingDirectory,
    sessionDir: config.sessions?.directory,
    // P4：装配器可覆盖 agentId / libDir / dataDomain / allowedOrigins / systemPrompt /
    // workingDirectory / llmProfile（provider+model）。缺省不传 → 与单 agent 时代逐字一致。
    ...(overrides ?? {}),
  };

  // 初始化模型解析器
  initModelResolver(config);

  return new AgentRuntime(runtimeConfig);
}
