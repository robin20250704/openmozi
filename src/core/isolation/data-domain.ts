/**
 * data-domain.ts — 数据域边界强制（P4 契约 C-P4-5，**唯一实现**，V-014）
 *
 * 为什么需要它：多 agent 隔离里，"工具隔离"与"会话隔离"靠 runtime 天然分家，
 * 但**数据隔离**不会自动成立——第二个商户的工具只要拼一个绝对 URL，就能打到
 * 君无忧的业务后端（客户档案/订单）。提示词里写"只查自己的数据"是概率性约束，
 * 隔离是安全属性，必须落在**执行侧**（V-015：规则类代码必须有"规则真的生效"的断言）。
 *
 * ⚠️ 血的教训（P4a 回炉 1 次）：域上下文**必须是"每轮请求"的**，不能是"每个 runtime"的。
 * 第一版把域写成模块级变量、由 AgentRuntime 构造时赋值 —— 两个 agent 在同一进程时，
 * **后装配的 agent 覆盖前一个**：元一装配完，君无忧的工具就带着元一的白名单去调调度器，
 * 被自己的隔离层拒掉（`E_DATA_DOMAIN_VIOLATION: agent=yuanyi 不得访问 35801`），
 * 线上报价链路整条断掉（E2/E4/E9/E11 红）。所以：
 *   · **请求期**：`runWithDataDomain(...)` 用 AsyncLocalStorage 绑定本轮 agent 的域（权威）；
 *   · **请求外**（诊断脚本 / 定时任务 / 直接调 lib）：`setFallbackDataDomain(...)` 兜底，
 *     且**不覆盖**已有 fallback（防止"最后装配者通吃"重演）。
 *
 * 其余设计要点：
 *  1. **fail-closed**（V-018 同族）：`allowedOrigins` 为空 → 一律拒绝。
 *     "没配白名单"绝不等价于"放行一切"——那是把隔离开关默认关掉。
 *  2. **无域时放行**：完全没配域（诊断脚本/harness/单测）→ 放行，
 *     这样既有调用方零改动就能通过；一旦配了域，就以域为准。
 *  3. **降级可观测**：`DATA_DOMAIN_ENFORCE=false` 时只打点告警，**不静默**——降级必须留痕。
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** 越权访问的稳定错误码（断言与日志按它匹配，不要按自然语言匹配） */
export const DATA_DOMAIN_VIOLATION = "E_DATA_DOMAIN_VIOLATION";

/** 数据域上下文：描述"某一轮请求属于哪个 agent 的哪个数据域" */
export interface DataDomainContext {
  agentId?: string;
  dataDomain?: string;
  allowedOrigins?: string[];
}

/** 请求期上下文（权威）：每轮对话在 runWithDataDomain 内执行 */
const als = new AsyncLocalStorage<DataDomainContext>();

/** 请求外兜底（诊断/定时任务）：首个设置者生效，后续不覆盖（防"最后装配者通吃"） */
let fallbackDomain: DataDomainContext | null = null;

/**
 * 按 agentId 登记的数据域（**兜底判定的唯一可靠来源**）。
 *
 * 为什么需要它：AsyncLocalStorage 的上下文只在**同一条 await 链**上传播。pi 的工具执行
 * 是在自己的事件回调里跑的（工具调用由 agent 内部派发），并不保证继承发起本轮对话的那条
 * 链——实测：元一的 query_sku 在工具回调里读到的域是**兜底域**（属于君无忧）→ 元一打自己的
 * 后端被拒。所以业务客户端调用 `enforceDataOrigin(url, AGENT_ID)` 显式声明"我是谁"，
 * 这里按 id 查表拿域。显式声明优于"猜上下文"，也不受执行链影响。
 */
const byAgent = new Map<string, DataDomainContext>();

/** 登记某 agent 的数据域（AgentRuntime 构造时调用；同一 id 重复登记以最后一次为准） */
export function registerAgentDataDomain(ctx: DataDomainContext): void {
  if (ctx.agentId) byAgent.set(ctx.agentId, ctx);
}

/** 读某 agent 已登记的数据域（诊断与断言用） */
export function getRegisteredDataDomain(agentId: string): DataDomainContext | null {
  return byAgent.get(agentId) ?? null;
}

/** 在"本轮请求的域"内执行（AgentRuntime 调用 session.prompt 时包一层） */
export function runWithDataDomain<T>(ctx: DataDomainContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

/**
 * 把上下文**绑定到当前异步执行链的剩余部分**（不返回闭包）。
 * 用于异步生成器（`async *chatStream`）这类"包一层闭包会改变 yield 语义"的场景。
 * 注意：enterWith 影响当前 async 资源及其后续子调用，且不像 run 那样自动退出——
 * 只有在"这之后整段都是该 agent 的活"时才可用（流式对话正是这种情况）。
 */
export function enterWithDataDomain(ctx: DataDomainContext): void {
  als.enterWith(ctx);
}

/**
 * 设置**请求外**的兜底域（由 AgentRuntime 构造时调用）。
 * 只在尚未设置时生效：多 agent 同进程时，"谁兜底"必须是确定的，不能被装配顺序决定。
 */
export function setFallbackDataDomain(ctx: DataDomainContext | null): void {
  if (ctx === null) { fallbackDomain = null; return; }
  // 同时登记进"按 agentId 查表"，供工具回调显式声明身份时使用（见 byAgent 注释）
  registerAgentDataDomain(ctx);
  if (fallbackDomain === null) fallbackDomain = ctx;
}

/** 读当前域（诊断与断言用）：请求期优先，其次兜底 */
export function getDataDomain(): DataDomainContext | null {
  return als.getStore() ?? fallbackDomain;
}

/**
 * 解析"这次调用属于哪个域"，按**权威顺序**三档：
 *   ① 传入的 agentId 显式声明 → 按表查（最可靠：不受执行链影响，工具回调也能拿到真身）
 *   ② AsyncLocalStorage 请求期上下文（同一条 await 链上传播时最快）
 *   ③ 请求外兜底（诊断脚本/定时任务/单 agent 场景）
 * 返回 null = 完全没有域信息 → 放行（诊断脚本、单测、尚未接线的老路径）。
 */
function resolveDomain(agentIdHint?: string): DataDomainContext | null {
  if (agentIdHint) {
    const exact = byAgent.get(agentIdHint);
    if (exact) return exact;
  }
  return als.getStore() ?? fallbackDomain;
}

/** 是否强制（默认 true；显式 false 才降级为"只告警"） */
export function isEnforceEnabled(): boolean {
  return process.env.DATA_DOMAIN_ENFORCE !== "false";
}

function originOf(rawUrl: string): { origin: string; ok: boolean; reason?: string } {
  try {
    const u = new URL(rawUrl);
    return { origin: u.origin, ok: true };
  } catch {
    return { origin: "", ok: false, reason: `URL 无法解析（${rawUrl.slice(0, 80)}）` };
  }
}

/** 归一化白名单项：允许写 `http://127.0.0.1:53000/` 这类带尾斜杠/路径的形式 */
function normalizeAllowed(list: string[]): string[] {
  const out: string[] = [];
  for (const item of list) {
    const raw = String(item ?? "").trim();
    if (!raw) continue;
    const parsed = originOf(raw);
    out.push(parsed.ok ? parsed.origin : raw.replace(/\/+$/, ""));
  }
  return out;
}

/**
 * 校验一个**业务 HTTP 目标 URL** 是否属于当前 agent 的数据域。
 *
 * @returns 校验通过的 URL 字符串（原样返回，便于 `fetch(enforceDataOrigin(url))` 内联使用）
 * @throws  Error(code=E_DATA_DOMAIN_VIOLATION) 越权 / 白名单为空
 */
export function enforceDataOrigin(rawUrl: string, agentIdHint?: string): string {
  const ctx = resolveDomain(agentIdHint);
  // 完全无域（诊断脚本、harness、单测、尚未接线）：放行
  if (!ctx || ctx.allowedOrigins === undefined) return rawUrl;

  // agentId 以"显式声明"为准：业务客户端知道自己是哪个 agent 的库（按文件位置定），
  // 比"猜当前上下文是谁"可靠——执行链一断，猜出来的可能正好是别的 agent。
  const agentId = agentIdHint || ctx.agentId || "(unknown-agent)";
  const allowed = normalizeAllowed(ctx.allowedOrigins);
  const parsed = originOf(rawUrl);

  if (!parsed.ok) {
    return guard(agentId, rawUrl, rawUrl, parsed.reason ?? "URL 非法", allowed);
  }

  if (allowed.length === 0) {
    // fail-closed：没配白名单 = 没有可用数据域，任何业务调用都拒绝
    return guard(agentId, parsed.origin, rawUrl, "数据域白名单为空（fail-closed）", allowed);
  }

  if (!allowed.includes(parsed.origin)) {
    return guard(agentId, parsed.origin, rawUrl, "目标 origin 不在本 agent 的数据域白名单内", allowed);
  }
  return rawUrl;
}

/**
 * 越权处理：强制模式 → 抛错；降级模式（`DATA_DOMAIN_ENFORCE=false`）→ 打 warn 后**原样放行**。
 * **降级必须留痕**（不静默）：降级状态要在日志与验收报告里如实记录，否则等于偷偷关掉隔离。
 */
function guard(agentId: string, target: string, rawUrl: string, why: string, allowed: string[]): string {
  const message =
    `${DATA_DOMAIN_VIOLATION}: agent=${agentId} 不得访问 ${target}（${why}；` +
    `allowed=[${allowed.join(", ") || "空"}]）`;
  if (!isEnforceEnabled()) {
    console.warn(`[data-domain] ⚠️ 降级放行（DATA_DOMAIN_ENFORCE=false）：${message}`);
    return rawUrl;
  }
  const e = new Error(message) as Error & { code?: string };
  e.code = DATA_DOMAIN_VIOLATION;
  throw e;
}

/** 判断一个错误是否数据域越权（工具层据此返回 {ok:false} 而不抛给模型） */
export function isDataDomainViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  return e.code === DATA_DOMAIN_VIOLATION || (typeof e.message === "string" && e.message.includes(DATA_DOMAIN_VIOLATION));
}

/** 兼容保留：测试与调用方可继续用 setDataDomain 设置兜底域 */
export function setDataDomain(ctx: DataDomainContext | null): void {
  setFallbackDataDomain(ctx);
}
