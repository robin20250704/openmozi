/**
 * WebSocket 服务器 - 提供实时通信
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer, IncomingMessage } from "http";
import { getChildLogger } from "../utils/logger.js";
import { generateId } from "../utils/index.js";
import type {
  WsFrame,
  WsRequestFrame,
  WsResponseFrame,
  WsEventFrame,
  ChatSendParams,
  ChatDeltaEvent,
  SystemStatus,
  SessionsListParams,
  SessionsHistoryParams,
  SessionsDeleteParams,
  SessionsResetParams,
  SessionsRestoreParams,
  ConfigInfo,
  ConfigSaveParams,
  ConfigValidateResult,
} from "./types.js";
import type { Agent } from "../agents/agent.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { MoziConfig, ProviderId } from "../types/index.js";
import { getAllProviders } from "../providers/index.js";
import { getAllChannels } from "../channels/index.js";
import { getSessionStore, type TranscriptMessage } from "../sessions/index.js";
import { join } from "path";
import { homedir } from "os";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import json5 from "json5";
const logger = getChildLogger("websocket");

/** WebSocket 客户端 */
interface WsClient {
  id: string;
  ws: WebSocket;
  sessionKey: string | null;  // null 表示尚未绑定 session
  sessionId: string | null;
  lastPing: number;
  /** 当前聊天请求的 AbortController，用于取消 */
  currentAbortController: AbortController | null;
  /** 本连接绑定的 agent id（`?agent=` 或默认 agent）——一个连接只服务一个 agent */
  agentId: string;
  /** 本连接调用的 agent（多 agent 时取自注册表；单 agent 时即构造参数里的 agent） */
  agent: Agent;
  /**
   * 提问者身份（Web UI 需求 4）：由升级请求头 `X-PLM-User` / `X-PLM-User-Name`
   * 或查询参数 `?user=` / `?name=` 提供；缺省为匿名。
   * 一旦绑定就属于**这个连接**，后续每条消息都用它——不给"每条消息各自带身份"留口子
   * （那会让同一条对话里出现两个提问者，且会话键会跟着漂移）。
   */
  user: { id: string | null; name: string | null; source: "header" | "query" | "none" };
}

/** 提问者身份（WS 层解析结果） */
export interface WsCallerIdentity {
  id: string | null;
  name: string | null;
  source: "header" | "query" | "none";
}

/** WebSocket 服务选项 */
export interface WsServerOptions {
  server: HttpServer;
  agent: Agent;
  config: MoziConfig;
  /**
   * 多 agent 注册表（P4 起由 launcher 注入）。
   *
   * 为什么是可选：单 agent 部署（`AGENT_IDS=junwuyou`）时网关也单 agent，
   * 不注入时行为必须与"只有一个 agent"的时代**逐字一致**（U-4 回滚前提）。
   * 注入后：`/ws?agent=<id>` 命中注册表则用该 agent，未命中/未传则回落默认 agent。
   */
  registry?: AgentRegistry;
  /** 心跳检测间隔 (毫秒), 默认 30000 */
  heartbeatInterval?: number;
  /** 客户端超时时间 (毫秒), 默认 60000 */
  clientTimeout?: number;
}

/**
 * 身份头的取值解码。
 *
 * ⚠️ 实测（本批 A14 第一次跑红）：**HTTP 头值只能是 latin-1/ASCII 字节**，
 * 直接传中文显示名（`X-PLM-User-Name: 张工`）会被 Node 的 HTTP 解析器拒绝：
 * `Invalid character in header content ["X-PLM-User-Name"]` —— 连接根本建不起来。
 * 浏览器 `fetch` 也会抛 `TypeError: Invalid value`。所以中文名称**必须**按
 * RFC 3986 的百分号编码传（`%E5%BC%A0%E5%B7%A5`），服务端在这里解码。
 * ASCII 名称（`Zhang Gong`）两种形态都能收（解码后与原文相同 → 幂等）。
 */
function pickHeader(v: unknown): string | null {
  const s = Array.isArray(v) ? String(v[0]) : v == null ? "" : String(v);
  return decodeIdentityValue(s);
}

/** 查询参数（浏览器 WS 无法设自定义头时的回落）—— URLSearchParams 已解码，这里只需裁剪 */
function pickQuery(v: string | null): string | null {
  const t = (v ?? "").trim();
  return t ? t.slice(0, 128) : null;
}

/** 百分号编码 → 原文；解码失败时原样返回（绝不因为一个坏字符丢身份） */
function decodeIdentityValue(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (/%[0-9a-fA-F]{2}/.test(s)) {
    try {
      s = decodeURIComponent(s);
    } catch {
      /* 保留原样 */
    }
  }
  s = s.trim().slice(0, 128);
  return s || null;
}

/**
 * 从 WS 升级请求里取提问者身份（Web UI 需求 4）。
 *
 * 优先级：**HTTP 头 > 查询参数**。
 * 头名沿用 PLM 既有口径 `X-PLM-User`（08-前端实现规格 §6.9 恒发该头），
 * `X-PLM-User-Name` 为本项目新增（PLM 侧目前只有 ID）。
 *
 * 为什么保留查询参数回落：浏览器 `WebSocket` API **天生无法设置自定义头**，
 * 所以"前端网关注入头"在纯浏览器场景拿不到——回落参数是让本机自测可用的最小手段。
 *
 * 信任边界（必须知道）：查询参数等价于**用户自报**。所以提供
 * `PLM_REQUIRE_HEADER_IDENTITY=1` 彻底关掉回落（生产口径：只认前端网关注入的头）。
 * 默认 0 是因为本服务只监听回环（C-045 家族）；一旦 `OPENMOZI_HOST=0.0.0.0`，
 * 必须先设 1 并给服务加鉴权——否则同网段任何人都能自称任意身份。
 */
export function parseCallerIdentity(req: { headers?: Record<string, unknown>; url?: string }): WsCallerIdentity {
  const h = req.headers ?? {};
  const headerId = pickHeader(h["x-plm-user"] ?? h["x-user-id"]);
  const headerName = pickHeader(h["x-plm-user-name"] ?? h["x-user-name"]);
  if (headerId || headerName) {
    return { id: headerId, name: headerName, source: "header" };
  }
  if (process.env.PLM_REQUIRE_HEADER_IDENTITY === "1") {
    if (req.url && /[?&](user|name)=/.test(req.url)) {
      logger.warn(
        { url: req.url.split("?")[0] },
        "PLM_REQUIRE_HEADER_IDENTITY=1：忽略查询参数里的身份（该口径只接受前端网关注入的请求头）"
      );
    }
    return { id: null, name: null, source: "none" };
  }
  try {
    const u = new URL(req.url || "/", "http://localhost");
    const qid = pickQuery(u.searchParams.get("user"));
    const qname = pickQuery(u.searchParams.get("name"));
    if (qid || qname) return { id: qid, name: qname, source: "query" };
  } catch {
    /* URL 解析失败：按匿名处理，不阻塞连接 */
  }
  return { id: null, name: null, source: "none" };
}

/**
 * webchat 的 senderId：**必须稳定且不与他人相同**。
 *
 * 用身份 id 时加 `plm:` 前缀，是为了让"同一个人从浏览器问"与"从 QQ 问"在会话键上可区分；
 * 未带头时回落连接 id（每连接一个会话，与改造前行为一致）。
 * 已有 `plm:` 前缀的不再叠一层（`X-PLM-User: plm.zhang` 会变成 `plm:plm.zhang` ——
 * 会话键里叠前缀会让同一个人的历史分裂成两份）。
 */
function webchatSenderId(user: WsCallerIdentity, clientId: string): string {
  if (!user.id) return clientId;
  return user.id.startsWith("plm:") ? user.id : `plm:${user.id}`;
}

/** WebSocket 服务器类 */
export class WsServer {
  private wss: WebSocketServer;
  private clients = new Map<string, WsClient>();
  private agent: Agent;
  private config: MoziConfig;
  private registry?: AgentRegistry;
  private startTime = Date.now();
  private heartbeatInterval: number;
  private clientTimeout: number;

  constructor(options: WsServerOptions) {
    this.agent = options.agent;
    this.registry = options.registry;
    this.config = options.config;
    this.heartbeatInterval = options.heartbeatInterval ?? 30000;
    this.clientTimeout = options.clientTimeout ?? 60000;

    this.wss = new WebSocketServer({
      server: options.server,
      path: "/ws",
    });

    this.wss.on("connection", (ws, req) => {
      this.handleConnection(ws, req);
    });

    // 心跳检测
    setInterval(() => this.checkHeartbeat(), this.heartbeatInterval);

    logger.info("WebSocket server initialized");
  }

  /** 处理新连接 */
  private async handleConnection(ws: WebSocket, req?: IncomingMessage): Promise<void> {
    const clientId = generateId("client");

    // ① 选 agent：`?agent=<id>` 命中注册表 → 用该 agent；否则默认 agent（单 agent 行为不变）。
    //    为什么要在这里定而不是"每条消息各定一次"：一个连接就是一个人的一段对话，
    //    中途换 agent 会让上下文串到另一个 agent 的会话里（且审计上说不清谁答的）。
    const selection = this.selectAgent(req?.url);
    // ② 取提问者身份（需求 4）；来源是升级请求的 HTTP 头（优先）或查询参数
    const user = req ? parseCallerIdentity(req) : { id: null, name: null, source: "none" as const };
    const sessionKey = `webchat:${webchatSenderId(user, clientId)}`;

    // 不立即创建 session，等待客户端发送 sessions.restore 或 chat.send 时再创建
    const client: WsClient = {
      id: clientId,
      ws,
      sessionKey,
      sessionId: null,
      lastPing: Date.now(),
      currentAbortController: null,
      agentId: selection.agentId,
      agent: selection.agent,
      user,
    };

    this.clients.set(clientId, client);
    logger.info(
      { clientId, agentId: selection.agentId, agentMatched: selection.matched, sessionKey, userSource: user.source, userId: user.id },
      "Client connected"
    );

    // 发送欢迎消息 —— 带上本次连接的 agent 与身份，供前端展示"当前是谁在问、问的是哪个客服"
    this.sendEvent(ws, "connected", {
      clientId,
      version: "1.0.0",
      agent: selection.agentId,
      agentMatched: selection.matched,
      agentRequested: selection.requested ?? null,
      sessionKey,
      user: { id: user.id, name: user.name, source: user.source },
    });

    ws.on("message", (data) => {
      this.handleMessage(client, data.toString());
    });

    ws.on("close", () => {
      this.clients.delete(clientId);
      logger.info({ clientId }, "Client disconnected");
    });

    ws.on("error", (error) => {
      logger.error({ clientId, error }, "WebSocket error");
    });

    ws.on("pong", () => {
      client.lastPing = Date.now();
    });
  }

  /** 处理消息 */
  private async handleMessage(client: WsClient, data: string): Promise<void> {
    try {
      const frame = JSON.parse(data) as WsFrame;

      if (frame.type === "req") {
        await this.handleRequest(client, frame);
      }
    } catch (error) {
      logger.error({ error, data }, "Failed to handle message");
    }
  }

  /** 处理请求 */
  private async handleRequest(
    client: WsClient,
    frame: WsRequestFrame
  ): Promise<void> {
    const { id, method, params } = frame;

    try {
      let result: unknown;

      switch (method) {
        case "chat.send":
          result = await this.handleChatSend(client, params as ChatSendParams);
          break;
        case "chat.cancel":
          result = this.handleChatCancel(client);
          break;
        case "chat.clear":
          result = await this.handleChatClear(client);
          break;
        case "sessions.list":
          result = await this.handleSessionsList(client, params as SessionsListParams);
          break;
        case "sessions.history":
          result = await this.handleSessionsHistory(client, params as SessionsHistoryParams);
          break;
        case "sessions.delete":
          result = await this.handleSessionsDelete(client, params as SessionsDeleteParams);
          break;
        case "sessions.reset":
          result = await this.handleSessionsReset(client, params as SessionsResetParams);
          break;
        case "sessions.restore":
          result = await this.handleSessionsRestore(client, params as SessionsRestoreParams);
          break;
        case "status.get":
          result = this.getSystemStatus();
          break;
        case "session.info":
          result = await this.getSessionInfo(client);
          break;
        case "config.get":
          // 2026-09-27：改成**按本连接的 agent** 报模型档 ——
          // 原来报的是全局基线档，`?agent=tiangong` 的连接也会显示 MiniMax-M3（显示 ≠ 实际）。
          result = this.getConfigInfo(client);
          break;
        case "config.validate":
          result = this.validateConfig(params as ConfigSaveParams);
          break;
        case "config.save":
          result = await this.saveConfig(params as ConfigSaveParams);
          break;
        case "ping":
          result = { pong: Date.now() };
          break;
        default:
          throw new Error(`Unknown method: ${method}`);
      }

      this.sendResponse(client.ws, id, true, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendResponse(client.ws, id, false, undefined, {
        code: "ERROR",
        message,
      });
    }
  }

  /**
   * 本连接可见的会话键前缀。
   *
   * 为什么需要它：WebChat 的会话列表/历史/删除都按 sessionKey 操作，而会话存储是**全局**
   * 的（同一份 FileSessionStore 里既有 webchat 会话，也有 QQ/企微客户的 `customer:N` 会话）。
   * 不加约束时，网页端的会话列表会把**别的渠道客户的会话**列出来，甚至能按 sessionKey
   * 读到别人的对话记录——这是数据泄漏，不是体验问题。
   */
  private sessionPrefixFor(client: WsClient): string {
    const base = client.user.id ? `webchat:plm:${client.user.id}` : `webchat:${client.id}`;
    return base;
  }

  /** 断言某会话键属于本连接（越权即拒绝，不静默返回空——静默会让越权看起来像"没有数据"） */
  private assertOwnsSession(client: WsClient, sessionKey: string, method: string): void {
    const pref = this.sessionPrefixFor(client);
    if (!sessionKey || !sessionKey.startsWith(pref)) {
      logger.warn({ clientId: client.id, method, sessionKey, allowedPrefix: pref }, "拒绝跨会话访问");
      throw new Error(`拒绝访问：会话不属于本连接（${method}）`);
    }
  }

  /** 确保客户端有 session，如果没有则创建 */
  private async ensureSession(client: WsClient): Promise<void> {
    if (client.sessionKey && client.sessionId) {
      return;
    }

    const store = getSessionStore();
    // sessionKey 在 handleConnection 里已定（含 agent 选择与身份），这里只补齐：
    // 原来这里会把 sessionKey 重写成 `webchat:${client.id}`，多 agent 下会把身份信息抹掉
    // （用户带 `X-PLM-User` 时同一人的会话键会退化成连接 id ⇒ 每次刷新都是一个新会话）。
    const sessionKey = client.sessionKey ?? `webchat:${client.id}`;
    const session = await store.getOrCreate(sessionKey);

    client.sessionKey = sessionKey;
    client.sessionId = session.sessionId;

    logger.info({ clientId: client.id, sessionKey, sessionId: session.sessionId }, "Session created");
  }

  /**
   * 选定本连接使用的 agent（多 agent 路由，P4 唯一解析处是 AgentRegistry.resolve）。
   *
   * 语义：
   *  - 未传 `?agent=` 或没有注册表 → 默认 agent（`this.agent`），`matched=false`；
   *  - 传了且命中 → 该 agent；
   *  - 传了但未命中 → **回落默认 agent 并显式标注**（`matched=false, requested=<id>`）——
   *    不抛错是刻意的：一个拼错的 URL 不该让用户看到空白页，但必须在 connected 事件与日志里
   *    留痕，前端据此提示"该客服不存在，已切到默认客服"（否则用户会以为在用他要的那个）。
   */
  private selectAgent(url?: string): { agent: Agent; agentId: string; matched: boolean; requested?: string } {
    let requested: string | undefined;
    try {
      const u = new URL(url || "/", "http://localhost");
      const a = (u.searchParams.get("agent") || "").trim();
      if (a) requested = a;
    } catch {
      /* 解析失败按未传处理 */
    }
    if (requested && this.registry) {
      const rec = this.registry.byId(requested);
      if (rec) {
        return { agent: rec.agent, agentId: rec.descriptor.id, matched: true, requested };
      }
      logger.warn({ requested, defaultAgent: this.registry.defaultId }, "未知 agent → 回落默认 agent");
    }
    const defaultId = this.registry?.defaultId ?? "default";
    if (!this.registry && requested) {
      logger.warn({ requested }, "未注入 agent 注册表（单 agent 部署）→ 忽略 ?agent= 参数");
    }
    return { agent: this.agent, agentId: defaultId, matched: false, requested };
  }

  /**
   * 取本连接绑定的 agent（唯一访问器，V-014）。
   *
   * 为什么不直接读 `this.agent`：多 agent 部署时 `this.agent` 只是**默认** agent，
   * 用它会让 `?agent=tiangong` 的连接实际由默认 agent 回答 —— 表现是"页面标题是 A、
   * 回答是 B"，而所有内部断言仍是绿的（这是本项目最贵的一类缺陷）。
   */
  private client_agent(client: WsClient): Agent {
    return client.agent ?? this.agent;
  }

  /** 处理聊天发送 */
  private async handleChatSend(
    client: WsClient,
    params: ChatSendParams
  ): Promise<{ messageId: string }> {
    // 确保有 session
    await this.ensureSession(client);

    const { message } = params;
    const messageId = generateId("msg");
    const store = getSessionStore();

    // 构造消息上下文
    // 使用 sessionKey 作为 senderId，确保会话恢复后 Agent 能找到历史上下文
    const stableSenderId = client.sessionKey!.replace("webchat:", "");

    logger.debug(
      { clientId: client.id, sessionKey: client.sessionKey, stableSenderId, message: message.slice(0, 100) },
      "Chat send"
    );

    // 保存用户消息到 transcript
    const userMessage: TranscriptMessage = {
      id: messageId,
      role: "user",
      content: message,
      timestamp: Date.now(),
    };
    await store.appendTranscript(client.sessionId!, client.sessionKey!, userMessage);

    // 需求 4：提问者的 ID/名称随消息一起进 agent（senderId/senderName → 请求上下文）。
    // senderName 未提供时回退到 ID —— 都不能凭空造一个名字（否则 agent 会以为认识对方）。
    const context = {
      channelId: "webchat" as const,
      chatId: client.sessionKey!,
      messageId,
      senderId: stableSenderId,
      senderName: client.user.name || client.user.id || "WebChat User",
      content: message,
      chatType: "direct" as const,
      timestamp: Date.now(),
    };

    const controller = new AbortController();
    client.currentAbortController = controller;

    try {
      const stream = this.client_agent(client).processMessageStream(context, { signal: controller.signal });
      let fullContent = "";

      for await (const delta of stream) {
        fullContent += delta;
        this.sendEvent(client.ws, "chat.delta", {
          sessionId: client.sessionId,
          delta,
          done: false,
        } as ChatDeltaEvent);
      }

      client.currentAbortController = null;

      // 保存助手消息到 transcript
      const assistantMessage: TranscriptMessage = {
        id: generateId("msg"),
        role: "assistant",
        content: fullContent,
        timestamp: Date.now(),
      };
      await store.appendTranscript(client.sessionId!, client.sessionKey!, assistantMessage);

      this.sendEvent(client.ws, "chat.delta", {
        sessionId: client.sessionId,
        delta: "",
        done: true,
      } as ChatDeltaEvent);
    } catch (error) {
      client.currentAbortController = null;
      const isAborted =
        error instanceof Error &&
        (error.name === "AbortError" || error.message === "Aborted" || (error as { code?: string }).code === "ABORT_ERR");
      if (isAborted) {
        this.sendEvent(client.ws, "chat.delta", {
          sessionId: client.sessionId,
          delta: "",
          done: true,
          cancelled: true,
        } as ChatDeltaEvent);
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.sendEvent(client.ws, "chat.error", {
          sessionId: client.sessionId,
          error: errorMessage,
        });
      }
    }

    return { messageId };
  }

  /** 取消当前客户端的聊天请求 */
  private handleChatCancel(client: WsClient): { cancelled: boolean } {
    if (client.currentAbortController) {
      client.currentAbortController.abort();
      client.currentAbortController = null;
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  /** 处理清除会话 */
  private async handleChatClear(client: WsClient): Promise<{ success: boolean; sessionKey: string; sessionId: string }> {
    // 确保有 session
    await this.ensureSession(client);

    const store = getSessionStore();
    const oldSessionKey = client.sessionKey!;

    // 重置会话
    const newSession = await store.reset(client.sessionKey!);

    // 更新客户端会话 ID 和 sessionKey
    client.sessionKey = newSession.sessionKey;
    client.sessionId = newSession.sessionId;

    logger.info(
      { clientId: client.id, oldSessionKey, newSessionKey: newSession.sessionKey, newSessionId: newSession.sessionId },
      "Chat cleared, new session created"
    );

    return {
      success: true,
      sessionKey: newSession.sessionKey,
      sessionId: newSession.sessionId,
    };
  }

  /** 处理会话列表 */
  private async handleSessionsList(client: WsClient, params?: SessionsListParams): Promise<unknown> {
    const store = getSessionStore();
    const sessions = await store.list({
      limit: params?.limit,
      activeMinutes: params?.activeMinutes,
      search: params?.search,
    });
    // 会话列表按本连接的身份前缀过滤（见 ownsSession 的注释：否则 QQ 客户的会话会出现在网页端列表里）
    const pref = this.sessionPrefixFor(client);
    return { sessions: sessions.filter((s) => s.sessionKey.startsWith(pref)), total: sessions.length };
  }

  /** 处理获取会话历史 */
  private async handleSessionsHistory(client: WsClient, params: SessionsHistoryParams): Promise<unknown> {
    this.assertOwnsSession(client, params.sessionKey, "sessions.history");
    const store = getSessionStore();
    const session = await store.get(params.sessionKey);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionKey}`);
    }
    const messages = await store.loadTranscript(session.sessionId);
    return {
      sessionKey: params.sessionKey,
      sessionId: session.sessionId,
      messages,
    };
  }

  /** 处理删除会话 */
  private async handleSessionsDelete(client: WsClient, params: SessionsDeleteParams): Promise<{ success: boolean }> {
    this.assertOwnsSession(client, params.sessionKey, "sessions.delete");
    const store = getSessionStore();
    await store.delete(params.sessionKey);
    return { success: true };
  }

  /** 处理重置会话 */
  private async handleSessionsReset(client: WsClient, params: SessionsResetParams): Promise<unknown> {
    this.assertOwnsSession(client, params.sessionKey, "sessions.reset");
    const store = getSessionStore();
    const session = await store.reset(params.sessionKey);
    return {
      success: true,
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
    };
  }

  /** 处理恢复会话 */
  private async handleSessionsRestore(client: WsClient, params: SessionsRestoreParams): Promise<unknown> {
    this.assertOwnsSession(client, params.sessionKey, "sessions.restore");
    const store = getSessionStore();
    const session = await store.get(params.sessionKey);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionKey}`);
    }

    // 更新客户端会话
    client.sessionKey = session.sessionKey;
    client.sessionId = session.sessionId;

    // 加载历史消息
    const messages = await store.loadTranscript(session.sessionId);

    // 恢复 Agent 的会话上下文
    // Agent 使用 "webchat:{senderId}" 作为 sessionKey，对于 direct chat
    // senderId 从 sessionKey 中提取（去掉 "webchat:" 前缀）
    const agentSessionKey = session.sessionKey; // webchat:session_xxx
    const transcriptMessages = messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string }));

    if (transcriptMessages.length > 0) {
      this.client_agent(client).restoreSessionFromTranscript(agentSessionKey, transcriptMessages);
    }

    return {
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      messages,
    };
  }

  /** 获取系统状态 */
  private getSystemStatus(): SystemStatus {
    const providers = getAllProviders().map((p) => ({
      id: p.id,
      name: p.name,
      available: true,
    }));

    const channels = getAllChannels().map((c) => ({
      id: c.id,
      name: c.id,  // 使用 id 作为 name
      connected: true,  // 简化：假设已配置的通道都是连接的
    }));

    return {
      version: "1.0.0",
      uptime: Date.now() - this.startTime,
      providers,
      channels,
      sessions: this.clients.size,
    };
  }

  /** 获取会话信息 */
  private async getSessionInfo(client: WsClient): Promise<unknown> {
    const context = {
      channelId: "webchat" as const,
      chatId: client.sessionKey || `webchat:${client.id}`,
      messageId: "",
      senderId: (client.sessionKey || `webchat:${client.id}`).replace("webchat:", ""),
      senderName: client.user.name || client.user.id || "",
      content: "",
      chatType: "direct" as const,
      timestamp: Date.now(),
    };

    const info = await this.client_agent(client).getSessionInfo(context);
    return {
      sessionKey: client.sessionKey,
      sessionId: client.sessionId,
      ...info,
    };
  }

  /**
   * 获取配置信息（脱敏）。
   *
   * `client` 用于取**本连接实际服务它的 agent** 的模型档（`?agent=<id>` 时不再是默认 agent 的档）；
   * 不传时回落全局基线档（老调用方/单 agent 部署行为不变）。
   */
  private getConfigInfo(client?: WsClient): ConfigInfo {
    // 提供商信息（脱敏 API Key）
    const providers: Record<string, ConfigInfo["providers"][string]> = {};
    for (const [id, config] of Object.entries(this.config.providers)) {
      providers[id] = {
        id,
        name: (config as any).name || id,
        baseUrl: (config as any).baseUrl,
        hasApiKey: Boolean((config as any).apiKey),
        groupId: (config as any).groupId,
      };
    }

    // 通道信息（脱敏敏感字段）
    const channels: Record<string, ConfigInfo["channels"][string]> = {};
    const channelNames: Record<string, string> = {
      feishu: "飞书",
      dingtalk: "钉钉",
      qq: "QQ",
      wecom: "企业微信",
    };
    for (const [id, config] of Object.entries(this.config.channels)) {
      if (config) {
        const hasConfig = (
          // 飞书
          (id === "feishu" && ((config as any).appId || (config as any).appSecret)) ||
          // 钉钉
          (id === "dingtalk" && ((config as any).appKey || (config as any).appSecret || (config as any).robotCode)) ||
          // QQ
          (id === "qq" && ((config as any).appId || (config as any).clientSecret)) ||
          // 企业微信
          (id === "wecom" && ((config as any).corpId || (config as any).corpSecret || (config as any).agentId || (config as any).token || (config as any).encodingAESKey))
        );
        const channelConfig: ConfigInfo["channels"][string] = {
          id,
          name: channelNames[id] || id,
          hasConfig,
          enabled: hasConfig && ((config as any).enabled ?? true),
        };
        // 添加非敏感字段用于编辑
        if (id === "feishu") {
          (channelConfig as any).appId = (config as any).appId;
          // appSecret 不返回
        } else if (id === "dingtalk") {
          (channelConfig as any).appKey = (config as any).appKey;
          (channelConfig as any).robotCode = (config as any).robotCode;
        } else if (id === "qq") {
          (channelConfig as any).appId = (config as any).appId;
          (channelConfig as any).sandbox = (config as any).sandbox;
          // clientSecret 不返回
        } else if (id === "wecom") {
          (channelConfig as any).corpId = (config as any).corpId;
          (channelConfig as any).agentId = (config as any).agentId;
          (channelConfig as any).token = (config as any).token;
          (channelConfig as any).encodingAESKey = (config as any).encodingAESKey;
          // corpSecret 不返回
        }
        channels[id] = channelConfig;
      }
    }

    // Agent 配置：优先报**本连接 agent 实际在用的档**（多 agent 下全局基线档会显示成别人的模型）
    const connAgent = client ? this.client_agent(client) : undefined;
    let connLlm: { provider: string; model: string; contextWindow?: number; contextWindowSource: string } | undefined;
    try {
      connLlm = connAgent?.llmInfo();
    } catch (e) {
      logger.warn({ error: (e as Error).message }, "取本连接 agent 的模型档失败 → 回落全局基线档");
    }
    const agent = {
      defaultProvider: connLlm?.provider ?? this.config.agent.defaultProvider,
      defaultModel: connLlm?.model ?? this.config.agent.defaultModel,
      temperature: this.config.agent.temperature,
      maxTokens: this.config.agent.maxTokens,
      systemPrompt: this.config.agent.systemPrompt,
    };

    // 服务器配置
    const server = {
      port: this.config.server.port,
      host: this.config.server.host || "0.0.0.0",
    };

    // 日志配置
    const logging = {
      level: this.config.logging.level,
    };

    // 记忆系统配置
    const memory = {
      enabled: this.config.memory?.enabled,
      directory: this.config.memory?.directory,
      embeddingModel: this.config.memory?.embeddingModel,
      embeddingProvider: this.config.memory?.embeddingProvider,
    };

    // Skills 配置
    const skills = {
      enabled: this.config.skills?.enabled,
      userDir: this.config.skills?.userDir,
      workspaceDir: this.config.skills?.workspaceDir,
      disabled: this.config.skills?.disabled,
      only: this.config.skills?.only,
    };

    return {
      providers,
      channels,
      agent,
      server,
      logging,
      memory: memory as ConfigInfo["memory"],
      skills: skills as ConfigInfo["skills"],
    };
  }

  /** 验证配置 */
  private validateConfig(params: ConfigSaveParams): ConfigValidateResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 验证提供商
    if (params.providers) {
      let hasApiKey = false;
      for (const [id, p] of Object.entries(params.providers)) {
        if (p.hasApiKey) {
          hasApiKey = true;
        }
        // 验证自定义 OpenAI/Anthropic 需要 baseUrl
        if (p.hasApiKey && (id === "custom-openai" || id === "custom-anthropic")) {
          if (!p.baseUrl) {
            errors.push(`${id} 需要 baseUrl 配置`);
          }
        }
      }
      if (!hasApiKey && Object.keys(params.providers).length > 0) {
        warnings.push("没有配置任何 API Key，将无法使用模型功能");
      }
    }

    // 验证通道
    if (params.channels) {
      for (const [id, c] of Object.entries(params.channels)) {
        if (c.hasConfig) {
          if (id === "feishu" && !c.appId) {
            errors.push("飞书需要 App ID");
          }
          if (id === "dingtalk" && !c.appKey) {
            errors.push("钉钉需要 App Key");
          }
          if (id === "qq" && !c.appId) {
            errors.push("QQ 需要 App ID");
          }
          if (id === "wecom" && !c.corpId) {
            errors.push("企业微信需要 Corp ID");
          }
        }
      }
    }

    // 验证 Agent 配置
    if (params.agent) {
      const validProviders = [
        "deepseek", "doubao", "minimax", "kimi", "stepfun", "modelscope",
        "dashscope", "zhipu", "openai", "ollama", "openrouter",
        "together", "groq", "custom-openai", "custom-anthropic",
      ];
      if (params.agent.defaultProvider && !validProviders.includes(params.agent.defaultProvider)) {
        errors.push(`无效的提供商: ${params.agent.defaultProvider}`);
      }
      if (params.agent.temperature !== undefined && (params.agent.temperature < 0 || params.agent.temperature > 2)) {
        errors.push("temperature 必须在 0 到 2 之间");
      }
      if (params.agent.maxTokens !== undefined && params.agent.maxTokens < 1) {
        errors.push("maxTokens 必须大于 0");
      }
    }

    // 验证服务器配置
    if (params.server) {
      if (params.server.port < 1 || params.server.port > 65535) {
        errors.push("端口必须在 1 到 65535 之间");
      }
    }

    // 验证日志配置
    if (params.logging) {
      const validLevels = ["debug", "info", "warn", "error"];
      if (params.logging.level && !validLevels.includes(params.logging.level)) {
        errors.push(`无效的日志级别: ${params.logging.level}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /** 保存配置到文件 */
  private async saveConfig(params: ConfigSaveParams): Promise<{ success: boolean; message: string; requiresRestart?: boolean }> {
    const moziDir = join(homedir(), ".mozi");
    const configPath = join(moziDir, "config.local.json5");

    // 验证配置
    const validation = this.validateConfig(params);
    if (!validation.valid) {
      return {
        success: false,
        message: "配置验证失败: " + validation.errors.join("; "),
      };
    }

    // 先读取现有配置，然后合并
    let existingConfig: Partial<MoziConfig> = {};
    if (existsSync(configPath)) {
      try {
        existingConfig = json5.parse(readFileSync(configPath, "utf-8"));
      } catch (e) {
        logger.warn({ error: e }, "Failed to parse existing config, creating new");
      }
    }

    // 构建要保存的配置
    const configToSave: Partial<MoziConfig> = { ...existingConfig };

    // 更新提供商
    if (params.providers) {
      const providers: MoziConfig["providers"] = {};
      // 保留原有的未修改的提供商
      if (existingConfig.providers) {
        for (const [id, p] of Object.entries(existingConfig.providers)) {
          if (id && p) {
            providers[id] = p;
          }
        }
      }
      // 更新/添加新的提供商
      for (const [id, p] of Object.entries(params.providers)) {
        if (!id || !p.hasApiKey) {
          // 删除提供商
          delete providers[id];
          continue;
        }
        // 从现有配置中获取 apiKey
        const existing = (existingConfig.providers as any)?.[id];
        providers[id] = {
          ...existing,
          baseUrl: p.baseUrl,
          ...(p.groupId ? { groupId: p.groupId } : {}),
        };
        // 优先使用前端发送的 apiKey（新增时），否则保留原有 apiKey
        const apiKey = (p as any).apiKey || existing?.apiKey;
        if (apiKey) {
          (providers[id] as any).apiKey = apiKey;
        }
      }
      configToSave.providers = providers;
    }

    // 更新通道
    if (params.channels) {
      const channels: MoziConfig["channels"] = {
        feishu: existingConfig.channels?.feishu,
        dingtalk: existingConfig.channels?.dingtalk,
        qq: existingConfig.channels?.qq,
        wecom: existingConfig.channels?.wecom,
      };

      for (const [id, c] of Object.entries(params.channels)) {
        if (!c.hasConfig) {
          // 删除通道配置
          delete (channels as any)[id];
          continue;
        }
        const existing = (existingConfig.channels as any)?.[id];
        (channels as any)[id] = {
          ...existing,
          enabled: c.enabled,
          ...(c.appId && { appId: c.appId }),
          ...(c.appSecret && { appSecret: c.appSecret }),
          ...(c.appKey && { appKey: c.appKey }),
          ...(c.corpId && { corpId: c.corpId }),
          ...(c.corpSecret && { corpSecret: c.corpSecret }),
          ...(c.agentId && { agentId: c.agentId }),
          ...(c.token && { token: c.token }),
          ...(c.encodingAESKey && { encodingAESKey: c.encodingAESKey }),
          ...(c.clientSecret && { clientSecret: c.clientSecret }),
          ...(c.verificationToken && { verificationToken: c.verificationToken }),
          ...(c.encryptKey && { encryptKey: c.encryptKey }),
          ...(c.sandbox !== undefined && { sandbox: c.sandbox }),
          ...(c.robotCode && { robotCode: c.robotCode }),
        };
      }
      configToSave.channels = channels;
    }

    // 更新 Agent 配置
    if (params.agent) {
      configToSave.agent = {
        ...existingConfig.agent,
        ...params.agent,
        defaultProvider: (params.agent.defaultProvider as ProviderId) || (existingConfig.agent?.defaultProvider ?? "deepseek"),
      };
    }

    // 更新服务器配置
    if (params.server) {
      configToSave.server = {
        ...existingConfig.server,
        ...params.server,
      };
    }

    // 更新日志配置
    if (params.logging) {
      configToSave.logging = {
        ...existingConfig.logging,
        ...params.logging,
      };
    }

    // 更新记忆系统配置
    if (params.memory) {
      configToSave.memory = {
        ...existingConfig.memory,
        ...params.memory,
        embeddingProvider: params.memory.embeddingProvider as ProviderId | undefined,
      };
    }

    // 更新 Skills 配置
    if (params.skills) {
      configToSave.skills = {
        ...existingConfig.skills,
        ...params.skills,
      };
    }

    // 确保目录存在
    if (!existsSync(moziDir)) {
      mkdirSync(moziDir, { recursive: true });
    }

    // 生成 JSON5 格式
    const json5Content = this.generateJson5(configToSave);

    // 写入文件
    writeFileSync(configPath, json5Content, "utf-8");

    logger.info({ configPath }, "Configuration saved");

    // 检查是否需要重启
    let requiresRestart = false;
    if (params.server?.port && params.server.port !== this.config.server.port) {
      requiresRestart = true;
    }
    if (params.channels) {
      // 如果新增或删除了通道，需要重启
      for (const [id, c] of Object.entries(params.channels)) {
        const existingHasConfig = Boolean((existingConfig.channels as any)?.[id]);
        if (c.hasConfig !== existingHasConfig) {
          requiresRestart = true;
          break;
        }
      }
    }

    return {
      success: true,
      message: "配置已保存" + (requiresRestart ? "，需要重启服务才能生效" : ""),
      requiresRestart,
    };
  }

  /** 生成 JSON5 格式的配置字符串 */
  private generateJson5(obj: unknown, indent = 0): string {
    const spaces = "  ".repeat(indent);
    const innerSpaces = "  ".repeat(indent + 1);

    if (obj === null || obj === undefined) {
      return "null";
    }

    if (typeof obj === "string") {
      return `"${obj.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }

    if (typeof obj === "number" || typeof obj === "boolean") {
      return String(obj);
    }

    if (Array.isArray(obj)) {
      if (obj.length === 0) return "[]";
      const items = obj.map((item) => `${innerSpaces}${this.generateJson5(item, indent + 1)}`);
      return `[\n${items.join(",\n")}\n${spaces}]`;
    }

    if (typeof obj === "object") {
      const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return "{}";

      const items = entries.map(([key, value]) => {
        // 使用不带引号的 key（如果是有效的 ECMAScript 标识符）
        const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : `"${key}"`;
        return `${innerSpaces}${safeKey}: ${this.generateJson5(value, indent + 1)}`;
      });

      return `{\n${items.join(",\n")}\n${spaces}}`;
    }

    return String(obj);
  }

  /** 发送响应 */
  private sendResponse(
    ws: WebSocket,
    id: string,
    ok: boolean,
    payload?: unknown,
    error?: { code: string; message: string }
  ): void {
    const frame: WsResponseFrame = { type: "res", id, ok, payload, error };
    ws.send(JSON.stringify(frame));
  }

  /** 发送事件 */
  private sendEvent(ws: WebSocket, event: string, payload?: unknown): void {
    const frame: WsEventFrame = { type: "event", event, payload };
    ws.send(JSON.stringify(frame));
  }

  /** 广播事件 */
  broadcast(event: string, payload?: unknown): void {
    const frame: WsEventFrame = { type: "event", event, payload };
    const data = JSON.stringify(frame);

    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  /** 心跳检测 */
  private checkHeartbeat(): void {
    const now = Date.now();

    for (const [clientId, client] of this.clients) {
      if (now - client.lastPing > this.clientTimeout) {
        logger.info({ clientId }, "Client timeout, disconnecting");
        client.ws.terminate();
        this.clients.delete(clientId);
      } else {
        client.ws.ping();
      }
    }
  }

  /** 关闭服务器 */
  close(): void {
    for (const client of this.clients.values()) {
      client.ws.close();
    }
    this.wss.close();
    logger.info("WebSocket server closed");
  }
}
