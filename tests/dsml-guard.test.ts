/**
 * DSML 泄漏守卫安全测试（P2 / D8）
 *
 * 安全属性（L-053 相关）：
 *   1. 模型幻觉**白名单外**工具（bash/read/write 等）并以 DSML 文本发出时，
 *      该工具**不被执行**、DSML **不漏给客户**；
 *   2. 模型幻觉**白名单内**工具（如 query_pricing）时，守卫直接执行该工具、
 *      带结果重问，最终回复无 DSML。
 *
 * 用有状态的 mock session：首次 getLastAssistantText 返回 DSML，
 * prompt()（守卫重问）后返回干净文本。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentRuntime } from "../src/agents/runtime.js";

// —— 有状态 session：可控"当前助手文本" + 记录 prompt/工具执行 ——
// dsmlFirstText：若非空，getLastAssistantText 第 1 次返回它（模拟泄漏），之后返回 cleanText（模拟重问后恢复）
let dsmlFirstText = "";
let cleanText = "";
let lastTextCallCount = 0;
const promptLog: string[] = [];
const queryPricingExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: '{"price":189}' }] });

const testModel = vi.hoisted(() => ({
  id: "test-model", name: "Test Model", api: "openai-completions", provider: "test-provider",
  baseUrl: "https://api.test.com/v1", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: vi.fn().mockResolvedValue({
    session: {
      prompt: vi.fn().mockImplementation(async (msg: string) => { promptLog.push(msg); }),
      subscribe: vi.fn().mockReturnValue(() => {}),
      // 第 1 次读返回 dsmlFirstText（泄漏），其后返回 cleanText（守卫重问后模型恢复）
      getLastAssistantText: vi.fn().mockImplementation(() => {
        lastTextCallCount++;
        return lastTextCallCount === 1 && dsmlFirstText ? dsmlFirstText : cleanText;
      }),
      getSessionStats: vi.fn().mockReturnValue({ tokens: { input: 1, output: 1, total: 2 }, totalMessages: 2 }),
      dispose: vi.fn(),
      agent: { setSystemPrompt: vi.fn(), setTools: vi.fn(), waitForIdle: vi.fn().mockResolvedValue(undefined), abort: vi.fn(), state: { systemPrompt: "", tools: [], messages: [], model: null } },
    },
  }),
  SessionManager: { create: vi.fn().mockReturnValue({}) },
  ModelRuntime: { create: vi.fn().mockResolvedValue({ getModel: vi.fn().mockReturnValue(testModel), getModels: vi.fn().mockReturnValue([testModel]) }) },
}));

vi.mock("@earendil-works/pi-ai", () => ({
  InMemoryCredentialStore: vi.fn().mockImplementation(() => ({ modify: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock("../src/providers/model-resolver.js", () => ({
  resolveModel: vi.fn().mockReturnValue(testModel),
  initModelResolver: vi.fn(),
  getApiKeyForProvider: vi.fn().mockReturnValue("test-key"),
}));

vi.mock("../src/utils/logger.js", () => ({
  getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../src/agents/system-prompt.js", () => ({ buildSystemPrompt: vi.fn().mockReturnValue("prompt") }));

// 白名单工具：query_pricing（可执行）；故意**不放** bash/read

function makeRuntime(): AgentRuntime {
  const rt = new AgentRuntime({ model: "test-model", provider: "test-provider", systemPrompt: "小君", workingDirectory: "/tmp" });
  rt.registerCustomTool({
    name: "query_pricing", label: "query_pricing", description: "查价",
    parameters: { type: "object", properties: { area_sqm: { type: "number" } } },
    execute: queryPricingExecute as never,
  } as never);
  return rt;
}

const ctx = { channelId: "qq", chatId: "c1", chatType: "direct" as const, senderId: "u1", content: "蟑螂100平米多少钱", messageId: "m1", timestamp: Date.now() };

describe("DSML 守卫安全属性（P2/D8）", () => {
  beforeEach(() => {
    dsmlFirstText = "";
    cleanText = "";
    lastTextCallCount = 0;
    promptLog.length = 0;
    queryPricingExecute.mockClear();
  });

  it("幻觉白名单外工具 bash：不执行、DSML 不漏给客户", async () => {
    dsmlFirstText = '<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="bash"> <｜｜DSML｜｜ parameter name="command" string="true">ls -R</｜｜DSML｜｜ parameter> </｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>';
    cleanText = "报价 189 元，家庭 90-140㎡ 档。";
    const rt = makeRuntime();
    const res = await rt.chat(ctx);

    expect(res.content).not.toContain("<｜｜DSML｜｜");
    expect(res.content).toContain("189");
    // 关键安全断言：bash 不在白名单，绝不能被执行
    expect(queryPricingExecute).not.toHaveBeenCalled();
    // 守卫重问了（带"禁止 DSML"提示）；prompt 共 2 次（初始 1 + 守卫重问 1）
    expect(promptLog.filter((m) => m.includes("禁止输出任何 <｜｜DSML｜｜")).length).toBe(1);
  });

  it("幻觉白名单内工具 query_pricing：守卫执行它、最终无 DSML", async () => {
    dsmlFirstText = '<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="query_pricing"> <｜｜DSML｜｜ parameter name="arguments" string="false">{"area_sqm":100,"pest_type":"蟑螂"}</｜｜DSML｜｜ parameter> </｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>';
    cleanText = "100㎡ 住宅灭蟑螂报价 189 元。";
    const rt = makeRuntime();
    const res = await rt.chat(ctx);

    expect(res.content).not.toContain("<｜｜DSML｜｜");
    // 白名单工具被执行（带幻觉参数）
    expect(queryPricingExecute).toHaveBeenCalledWith("dsml-guard", { area_sqm: 100, pest_type: "蟑螂" });
  });

  it("正常回复（无 DSML）不触发守卫、不重问", async () => {
    cleanText = "报价 189 元。";
    const rt = makeRuntime();
    const res = await rt.chat(ctx);
    expect(res.content).toBe("报价 189 元。");
    expect(promptLog.length).toBe(1); // 仅初始 prompt，无守卫重问
    expect(queryPricingExecute).not.toHaveBeenCalled();
  });
});
