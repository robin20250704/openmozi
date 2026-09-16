/**
 * assemble.ts — 按描述符装配一个 agent（P4 契约 C-P4-2/C-P4-3 的装配实现）
 *
 * 为什么需要它：原来装配是**硬编码的单个 junwuyou**（launcher 里 11 个动态 import +
 * 一份 SYSTEM.md + 一个 runtime）。要"再接一个商户"，就不能再往 launcher 里加一段复制粘贴的
 * 硬编码——装配必须由**声明式描述符**驱动，新增 agent = 新增一个 `agents/<id>/` 目录。
 *
 * 装配顺序（与设计文档 §六 一致）：
 *   读描述符 → 载工具（toolsModule）→ 建 runtime（agentId/libDir/dataDomain/origins/llmProfile）
 *   → 注册工具进该 runtime → 校验工具名集合与 toolset 一致 → 挂 prompt（系统提示 + 落盘
 *   `.agents/<id>/.pi/SYSTEM.md`）→ 返回可注册进 AgentRegistry 的三元组。
 *
 * 两个**装配期硬校验**（错了必须当场炸，不能等到客户消息发错人）：
 *   ① 工具名集合 == 描述符 toolset（漏注册/串注册 = 安全事件，A12/A13）；
 *   ② 每个 agent 的工作目录独立（`.agents/<id>/`）——否则两个 agent 的 SYSTEM.md 会互相覆盖
 *      （pi ResourceLoader 从 cwd 读），第二个 agent 会带着第一个人设说话（F11）。
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { MoziConfig } from "../types/index.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Agent, createAgent } from "./agent.js";
import { createAgentRuntime } from "./runtime.js";
import type { AgentDescriptor, AgentRecord } from "./registry.js";
import { getChildLogger } from "../utils/logger.js";

const logger = getChildLogger("assemble");

/** 描述符文件名（放在 `agents/<id>/` 下） */
export const AGENT_DESCRIPTOR_FILE = "agent.plugin.json";

export interface AgentAssembly {
  descriptor: AgentDescriptor;
  agent: Agent;
  runtime: ReturnType<typeof createAgentRuntime>;
  /** 该 agent 的独立工作目录（`.agents/<id>/`） */
  workDir: string;
  /** 实际注册进 runtime 的工具名（装配期校验的证据） */
  registeredToolNames: string[];
}

/** 读一个 agent 的描述符（JSON，无注释） */
export function readDescriptor(descriptorPath: string): AgentDescriptor {
  const raw = fs.readFileSync(descriptorPath, "utf8");
  let parsed: AgentDescriptor;
  try {
    parsed = JSON.parse(raw) as AgentDescriptor;
  } catch (e) {
    throw new Error(`描述符不是合法 JSON：${descriptorPath}（${(e as Error).message}）`);
  }
  const dir = path.dirname(descriptorPath);
  const desc: AgentDescriptor = { ...parsed, dir };
  validateDescriptor(desc, descriptorPath);
  return desc;
}

function validateDescriptor(d: AgentDescriptor, where: string): void {
  const problems: string[] = [];
  if (!d.id || !/^[a-z0-9_-]+$/.test(d.id)) {
    problems.push(`id 必须匹配 [a-z0-9_-]+（收到 ${JSON.stringify(d.id)}）——它同时是会话键前缀`);
  }
  if (!d.name) problems.push("name 缺失");
  if (!d.promptRef) problems.push("promptRef 缺失");
  if (!Array.isArray(d.toolset) || d.toolset.length === 0) problems.push("toolset 必须是非空数组（激活白名单的事实源）");
  if (!d.toolsModule) problems.push("toolsModule 缺失");
  if (!d.libDir) problems.push("libDir 缺失（数据隔离执行点）");
  if (!d.dataDomain) problems.push("dataDomain 缺失");
  if (!Array.isArray(d.allowedOrigins)) problems.push("allowedOrigins 必须是数组（可为空 = fail-closed）");
  if (!Array.isArray(d.accountRoutes)) problems.push("accountRoutes 必须是数组（可为空）");
  if (problems.length) throw new Error(`描述符校验失败 ${where}：\n  - ${problems.join("\n  - ")}`);
}

/** 载入工具模块（约定导出 `{ tools: AgentTool[] }` 或 `{ default: { tools } }`） */
async function loadTools(modulePath: string): Promise<AgentTool[]> {
  const mod = await import(pathToFileURL(modulePath).href);
  const tools = mod.tools ?? mod.default?.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error(`${modulePath} 未导出 { tools: AgentTool[] }（多 agent 装配的约定入口）`);
  }
  return tools as AgentTool[];
}

/**
 * 按描述符装配一个 agent。
 *
 * @param descriptorPath `agents/<id>/agent.plugin.json` 的绝对路径
 * @param baseConfig     网关配置（providers/agent 默认档，runtime 从它取默认值）
 * @param opts.baseDir   仓库 `runtime/openmozi/` 绝对路径（用于解析 libDir/promptRef 相对路径）
 */
export async function assembleAgent(
  descriptorPath: string,
  baseConfig: MoziConfig,
  opts: { baseDir: string; sessionDir?: string; agentDataRoot?: string }
): Promise<AgentAssembly> {
  const descriptor = readDescriptor(descriptorPath);
  const dir = descriptor.dir!;
  const workDir = path.join(opts.agentDataRoot ?? path.join(opts.baseDir, ".agents"), descriptor.id);
  fs.mkdirSync(path.join(workDir, ".pi"), { recursive: true });

  // 1) 业务 prompt（描述符目录内）
  const promptPath = path.join(dir, descriptor.promptRef);
  if (!fs.existsSync(promptPath)) throw new Error(`promptRef 指向的文件不存在：${promptPath}`);
  const systemPrompt = fs.readFileSync(promptPath, "utf8");
  // 双写：state.systemPrompt（权威）+ cwd/.pi/SYSTEM.md（pi ResourceLoader 兜底，V-004）
  fs.writeFileSync(path.join(workDir, ".pi", "SYSTEM.md"), systemPrompt, "utf8");
  fs.writeFileSync(path.join(workDir, "AGENTS.md"), systemPrompt, "utf8");

  // 2) 工具（描述符目录内）
  const toolsPath = path.resolve(dir, descriptor.toolsModule);
  const tools = await loadTools(toolsPath);

  // 3) runtime（agentId → 会话键前缀；libDir → 业务库根；allowedOrigins → 数据域边界）
  const libDir = path.resolve(opts.baseDir, descriptor.libDir);
  const configForAgent: MoziConfig = {
    ...baseConfig,
    agent: {
      ...baseConfig.agent,
      // llmProfile 覆盖 provider/model（缺省沿用全局档）
      defaultProvider: (descriptor.llmProfile?.provider as MoziConfig["agent"]["defaultProvider"]) ?? baseConfig.agent.defaultProvider,
      defaultModel: descriptor.llmProfile?.model ?? baseConfig.agent.defaultModel,
      // 每个 agent 独立工作目录：否则 .pi/SYSTEM.md 互相覆盖（F11）
      workingDirectory: workDir,
      systemPrompt,
    },
  };
  const runtime = createAgentRuntime(configForAgent, {
    agentId: descriptor.id,
    libDir,
    dataDomain: descriptor.dataDomain,
    allowedOrigins: descriptor.allowedOrigins,
    workingDirectory: workDir,
    systemPrompt,
    sessionDir: opts.sessionDir,
    provider: configForAgent.agent.defaultProvider,
    model: configForAgent.agent.defaultModel,
  });

  for (const t of tools) runtime.registerCustomTool(t);

  // 4) 装配期硬校验：注册的工具名集合必须与 toolset **完全一致**
  const registered = runtime.registeredToolNames();
  const missing = descriptor.toolset.filter((n) => !registered.includes(n));
  const unexpected = registered.filter((n) => !descriptor.toolset.includes(n));
  if (missing.length || unexpected.length) {
    throw new Error(
      `agent ${descriptor.id} 工具装配与描述符不一致（安全事件）：\n` +
        `  描述符未声明但已注册：${unexpected.join(", ") || "无"}\n` +
        `  声明了但未注册：${missing.join(", ") || "无"}`
    );
  }

  // 5) Agent 实例（沿用 createAgent 的 memory/skills/cron 装配，零分叉）
  //    把已配好的 runtime 传进去 —— 否则 createAgent 会再建一个（两个 runtime 各持一套会话，
  //    被丢弃的那个白建，且日志里出现 "agentId: (default)" 的噪声，排障时会被误导）。
  const agent = await createAgent(configForAgent, { runtime });

  logger.info(
    { agentId: descriptor.id, workDir, libDir, tools: registered.length, dataDomain: descriptor.dataDomain },
    "agent 装配完成"
  );

  return { descriptor, agent, runtime, workDir, registeredToolNames: registered };
}

/** 装配并注册进注册表（含路由冲突检测） */
export async function assembleAndRegister(
  registry: { registerAgent: (d: AgentDescriptor, a: Agent, r: never) => AgentRecord },
  descriptorPath: string,
  baseConfig: MoziConfig,
  opts: { baseDir: string; sessionDir?: string; agentDataRoot?: string }
): Promise<AgentAssembly> {
  const asm = await assembleAgent(descriptorPath, baseConfig, opts);
  registry.registerAgent(asm.descriptor, asm.agent, asm.runtime as never);
  return asm;
}
