/**
 * registry.ts — Agent 注册表 + 渠道账号路由（P4 契约 C-P4-3）
 *
 * 为什么需要它：网关原来持有**唯一** `agent`（`gateway/server.ts:28`），
 * `handleMessage` 直接 `this.agent.processMessage`（:171）。要支持"不同渠道账号 → 不同 agent"
 * （D13），路由决策必须有一处**唯一实现**（V-014），且缺省行为必须与单 agent 时代**逐字等价**
 * （U-4 回滚前提：未配置第二 agent 时零影响）。
 *
 * 设计要点：
 *  1. **缺省路由 = 默认 agent**：`agentRoute` 缺失/未命中 → 返回默认 agent 且 `matched=false`，
 *     调用方据此打日志即可，不做任何行为分叉。
 *  2. **路由冲突 = 启动即失败**：同一 route 被两个 agent 声明 → 抛错并**点名**冲突键
 *     （配置错了要在启动时炸，不要等到某条消息被发错人才发现）。
 *  3. **描述符是事实源**：一个 agent 的 toolset / dataDomain / accountRoutes / sessionKeyPrefix
 *     全从它自己的描述符来，不在别处再抄一遍（V-014）。
 *  4. **describe() 是隔离审计的观测面**：`GET /agent-diag` 直接镜像它，断言（A11）逐名比对
 *     两个 agent 的 toolset 交集必须为空——"数量不同"这种弱判据不允许。
 */

import type { Agent } from "../agents/agent.js";
import type { AgentRuntime } from "../agents/runtime.js";

/** Agent 描述符（`agents/<id>/agent.plugin.json` 的 schema，契约 C-P4-2） */
export interface AgentDescriptor {
  /** agentId：同时是会话键前缀与会话文件名前缀（`[a-z0-9_-]+`） */
  id: string;
  /** 人设显示名（仅日志/诊断用，不进 prompt） */
  name: string;
  /** 相对描述符文件的 prompt 文件（如 "prompt.md"） */
  promptRef: string;
  /** 工具名清单：**激活白名单的唯一事实源** */
  toolset: string[];
  /** 工具模块入口（导出 `{ tools: AgentTool[] }`），相对描述符目录 */
  toolsModule: string;
  /** 业务 lib 目录（`loadBusinessLib` 的根）—— 数据隔离的执行点 */
  libDir: string;
  /** 数据域 id（诊断与断言用） */
  dataDomain: string;
  /** 该 agent 的业务后端 origin 白名单（`enforceDataOrigin` 用） */
  allowedOrigins: string[];
  /** LLM 档位（缺省沿用全局 agent 配置） */
  llmProfile?: { provider?: string; model?: string };
  /** 本 agent 接管的渠道账号路由键（`<channelId>:<accountId>`） */
  accountRoutes: string[];
  /** 描述符所在目录（装配期用于解析 promptRef/toolsModule） */
  dir?: string;
}

export interface AgentRecord {
  descriptor: AgentDescriptor;
  agent: Agent;
  runtime: AgentRuntime;
  /** 会话键前缀（= `${id}:`），与会话隔离断言（A14/A21）对齐 */
  sessionKeyPrefix: string;
  isDefault: boolean;
}

export interface RouteResolution {
  agent: Agent;
  record: AgentRecord;
  /** 实际命中的 route（缺省时为空串） */
  route: string;
  /** 是否命中显式账号路由（false = 走了默认 agent，等价单 agent 行为） */
  matched: boolean;
  /** 本次解析的原因（日志/断言用） */
  reason: "route" | "default-fallback" | "no-default-agent";
}

export interface AgentDiagEntry {
  id: string;
  name: string;
  dataDomain: string;
  allowedOrigins: string[];
  sessionKeyPrefix: string;
  routes: string[];
  toolset: string[];
  isDefault: boolean;
}

/** 路由冲突（同一 route 被两个 agent 声明）—— 启动期错误，不降级 */
export class AgentRouteConflictError extends Error {
  constructor(public route: string, public agentIds: string[]) {
    super(`路由冲突：${route} 被多个 agent 声明（${agentIds.join(", ")}）——请修正 AGENT_ROUTES / 描述符`);
    this.name = "AgentRouteConflictError";
  }
}

export class AgentRegistry {
  private records = new Map<string, AgentRecord>();
  private routes = new Map<string, string>();
  private defaultAgentId: string | null = null;

  /** 注册一个 agent（默认 agent 用 setDefault 指定） */
  registerAgent(descriptor: AgentDescriptor, agent: Agent, runtime: AgentRuntime): AgentRecord {
    if (!descriptor?.id) throw new Error("AgentDescriptor.id 不能为空");
    if (this.records.has(descriptor.id)) throw new Error(`agent 重复注册：${descriptor.id}`);

    for (const route of descriptor.accountRoutes ?? []) {
      const owner = this.routes.get(route);
      if (owner && owner !== descriptor.id) throw new AgentRouteConflictError(route, [owner, descriptor.id]);
      this.routes.set(route, descriptor.id);
    }

    const record: AgentRecord = {
      descriptor,
      agent,
      runtime,
      sessionKeyPrefix: `${descriptor.id}:`,
      isDefault: false,
    };
    this.records.set(descriptor.id, record);
    return record;
  }

  /** 指定默认 agent（缺省路由的落点）。不指定时取第一个注册的 agent。 */
  setDefault(agentId: string): void {
    if (!this.records.has(agentId)) throw new Error(`setDefault 失败：未注册的 agent ${agentId}`);
    this.defaultAgentId = agentId;
    for (const r of this.records.values()) r.isDefault = r.descriptor.id === agentId;
  }

  get defaultId(): string | null {
    return this.defaultAgentId ?? [...this.records.keys()][0] ?? null;
  }

  byId(id: string): AgentRecord | undefined {
    return this.records.get(id);
  }

  all(): AgentRecord[] {
    return [...this.records.values()];
  }

  /** route 表镜像（诊断用） */
  routeTable(): Record<string, string> {
    return Object.fromEntries(this.routes);
  }

  /**
   * 路由解析：命中账号路由 → 该 agent；未命中/未提供 → 默认 agent（行为不变）。
   * **这是唯一的解析实现**，调用方不得自行查表。
   */
  resolve(route?: string): RouteResolution {
    const fallback = this.defaultId ? this.records.get(this.defaultId)! : undefined;
    const key = (route ?? "").trim();
    if (key) {
      const agentId = this.routes.get(key);
      if (agentId) {
        const record = this.records.get(agentId)!;
        return { agent: record.agent, record, route: key, matched: true, reason: "route" };
      }
    }
    if (!fallback) throw new Error("AgentRegistry 为空：没有可用的默认 agent");
    return {
      agent: fallback.agent,
      record: fallback,
      route: key,
      matched: false,
      reason: this.defaultAgentId ? "default-fallback" : "no-default-agent",
    };
  }

  /** 工具集交集（隔离审计 A11 的直接判据：必须为空数组） */
  toolsetOverlap(aId: string, bId: string): string[] {
    const a = this.records.get(aId);
    const b = this.records.get(bId);
    if (!a || !b) return [];
    const bSet = new Set(b.descriptor.toolset);
    return a.descriptor.toolset.filter((t) => bSet.has(t));
  }

  /** 诊断镜像（`GET /agent-diag` 的响应体） */
  describe(): AgentDiagEntry[] {
    return [...this.records.values()].map((r) => ({
      id: r.descriptor.id,
      name: r.descriptor.name,
      dataDomain: r.descriptor.dataDomain,
      allowedOrigins: r.descriptor.allowedOrigins ?? [],
      sessionKeyPrefix: r.sessionKeyPrefix,
      routes: (r.descriptor.accountRoutes ?? []).slice(),
      toolset: (r.descriptor.toolset ?? []).slice(),
      isDefault: r.descriptor.id === this.defaultId,
    }));
  }
}
