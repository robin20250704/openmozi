/**
 * tests/agent-registry.test.ts — P4 断言 A6 / A10 / A11 / A14(键前缀) 的**单测段**
 *
 * 判据来源：`.creature/tasks/openmozi-earendil-upgrade/spec-p4.md` §三
 *   A6  缺 route → 默认 agent（单 agent 行为不变）
 *   A10 同 route 两 agent 声明 → 启动即失败并点名
 *   A11 两 agent toolset 交集为空（逐名比对，不是"数量不同"）
 *   A14/A21 会话键前缀按 agentId 隔离
 */
import { describe, expect, it } from "vitest";
import { AgentRegistry, AgentRouteConflictError, type AgentDescriptor } from "../src/agents/registry.js";

/** 造假 agent/runtime：本文件只测路由与描述符逻辑，不碰 LLM */
const fakeAgent = (id: string) => ({ id, processMessage: async () => ({ content: id }) }) as never;
const fakeRuntime = (id: string) => ({ agentId: id }) as never;

const JUNWUYOU_TOOLS = [
  "faq_search", "query_pricing", "propose_slots", "create_appointment", "cancel_appointment",
  "get_customer_appointments", "query_customer_profile", "update_collected_info",
  "request_admin_approval", "confirm_order_details", "get_current_time",
];

function descriptor(over: Partial<AgentDescriptor> & { id: string }): AgentDescriptor {
  return {
    name: over.id,
    promptRef: "prompt.md",
    toolset: [],
    toolsModule: "tools/index.js",
    libDir: `agents/${over.id}/lib`,
    dataDomain: over.id,
    allowedOrigins: [`http://127.0.0.1:53000`],
    accountRoutes: [],
    ...over,
  };
}

function registryWithBoth(): AgentRegistry {
  const reg = new AgentRegistry();
  reg.registerAgent(
    descriptor({ id: "junwuyou", accountRoutes: ["qq:1905601942"], toolset: JUNWUYOU_TOOLS }),
    fakeAgent("junwuyou"), fakeRuntime("junwuyou")
  );
  reg.registerAgent(
    descriptor({
      id: "yuanyi",
      accountRoutes: ["qq:YUANYI_APP_ID"],
      toolset: ["query_sku", "quote_price", "query_leadtime"],
      dataDomain: "yuanyi",
      allowedOrigins: ["http://127.0.0.1:53100"],
    }),
    fakeAgent("yuanyi"), fakeRuntime("yuanyi")
  );
  reg.setDefault("junwuyou");
  return reg;
}

describe("AgentRegistry 路由（A6/A7 的机制层）", () => {
  it("A6: 缺 agentRoute → 默认 agent，且 matched=false（行为不变）", () => {
    const reg = registryWithBoth();
    for (const route of [undefined, "", "   ", "qq:unknown-account"]) {
      const r = reg.resolve(route);
      expect(r.record.descriptor.id).toBe("junwuyou");
      expect(r.matched).toBe(false);
      expect(r.reason).toBe("default-fallback");
    }
  });

  it("命中账号路由 → 该 agent，matched=true", () => {
    const reg = registryWithBoth();
    const a = reg.resolve("qq:1905601942");
    const b = reg.resolve("qq:YUANYI_APP_ID");
    expect(a.record.descriptor.id).toBe("junwuyou");
    expect(a.matched).toBe(true);
    expect(a.reason).toBe("route");
    expect(b.record.descriptor.id).toBe("yuanyi");
    expect(b.matched).toBe(true);
  });

  it("默认 agent 未显式指定时取第一个注册者（兼容 createGateway 单 agent 路径）", () => {
    const reg = new AgentRegistry();
    reg.registerAgent(descriptor({ id: "junwuyou", toolset: JUNWUYOU_TOOLS }), fakeAgent("junwuyou"), fakeRuntime("junwuyou"));
    expect(reg.resolve(undefined).record.descriptor.id).toBe("junwuyou");
    expect(reg.defaultId).toBe("junwuyou");
  });

  it("空注册表 → 解析即抛错（不静默返回 undefined）", () => {
    const reg = new AgentRegistry();
    expect(() => reg.resolve("qq:x")).toThrow(/没有可用的默认 agent/);
  });
});

describe("AgentRegistry 冲突检测（A10）", () => {
  it("同一 route 被两个 agent 声明 → 抛 AgentRouteConflictError 并点名冲突键", () => {
    const reg = new AgentRegistry();
    reg.registerAgent(descriptor({ id: "junwuyou", accountRoutes: ["qq:same"] }), fakeAgent("junwuyou"), fakeRuntime("junwuyou"));
    let err: unknown;
    try {
      reg.registerAgent(descriptor({ id: "yuanyi", accountRoutes: ["qq:same"] }), fakeAgent("yuanyi"), fakeRuntime("yuanyi"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgentRouteConflictError);
    expect((err as Error).message).toContain("qq:same");
    expect((err as Error).message).toContain("junwuyou");
    expect((err as Error).message).toContain("yuanyi");
  });

  it("同 id 重复注册 → 抛错", () => {
    const reg = new AgentRegistry();
    reg.registerAgent(descriptor({ id: "junwuyou" }), fakeAgent("junwuyou"), fakeRuntime("junwuyou"));
    expect(() => reg.registerAgent(descriptor({ id: "junwuyou" }), fakeAgent("junwuyou"), fakeRuntime("junwuyou"))).toThrow(/重复注册/);
  });
});

describe("隔离审计的观测面（A11/A14/A21）", () => {
  it("A11: 两 agent toolset 逐名比对交集为空（不是'数量不同'这种弱判据）", () => {
    const reg = registryWithBoth();
    expect(reg.toolsetOverlap("junwuyou", "yuanyi")).toEqual([]);
    // 反向再核一次：交集为空必须两边都查得到工具，否则"空交集"可能是因为根本没配
    expect(reg.byId("junwuyou")!.descriptor.toolset.length).toBe(11);
    expect(reg.byId("yuanyi")!.descriptor.toolset.length).toBeGreaterThan(0);
  });

  it("A14/A21: 会话键前缀 = `${agentId}:`，两 agent 前缀不同", () => {
    const reg = registryWithBoth();
    expect(reg.byId("junwuyou")!.sessionKeyPrefix).toBe("junwuyou:");
    expect(reg.byId("yuanyi")!.sessionKeyPrefix).toBe("yuanyi:");
    // 同一客户在两个 agent 下必然落成两个键（会话隔离的键层依据）
    const key = (prefix: string, customerKey: string) => `${prefix}${customerKey}`;
    expect(key(reg.byId("junwuyou")!.sessionKeyPrefix, "customer:9")).toBe("junwuyou:customer:9");
    expect(key(reg.byId("yuanyi")!.sessionKeyPrefix, "customer:9")).not.toBe(
      key(reg.byId("junwuyou")!.sessionKeyPrefix, "customer:9")
    );
  });

  it("describe() 是 /agent-diag 的镜像：逐条含 id/dataDomain/toolset/routes/isDefault", () => {
    const reg = registryWithBoth();
    const diag = reg.describe();
    expect(diag).toHaveLength(2);
    const jw = diag.find((d) => d.id === "junwuyou")!;
    const yy = diag.find((d) => d.id === "yuanyi")!;
    expect(jw.isDefault).toBe(true);
    expect(yy.isDefault).toBe(false);
    expect(jw.toolset).toContain("query_pricing");
    expect(yy.toolset).toContain("query_sku");
    expect(yy.toolset).not.toContain("query_pricing");
    expect(reg.routeTable()).toEqual({ "qq:1905601942": "junwuyou", "qq:YUANYI_APP_ID": "yuanyi" });
  });
});
