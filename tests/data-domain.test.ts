/**
 * tests/data-domain.test.ts — P4 断言 A16 / A17 的**单测段**（越权 origin 被拒 + fail-closed）
 *
 * 判据来源：`spec-p4.md` §三
 *   A16 第二个 agent 的工具打第一个 agent 的 origin → 抛 E_DATA_DOMAIN_VIOLATION
 *   A17 allowedOrigins 为空 → 任何业务调用即拒绝（fail-closed，V-018 同族）
 *
 * 为什么必须有这组断言：数据隔离是**安全属性**，不能靠"提示词里写了别乱查"（V-015）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DATA_DOMAIN_VIOLATION,
  enforceDataOrigin,
  enterWithDataDomain,
  getDataDomain,
  isDataDomainViolation,
  runWithDataDomain,
  setDataDomain,
  setFallbackDataDomain,
} from "../src/core/isolation/data-domain.js";

const JUNWUYOU = "http://127.0.0.1:53000";
const YUANYI = "http://127.0.0.1:53100";

afterEach(() => {
  setDataDomain(null);
  setFallbackDataDomain(null);
  vi.restoreAllMocks();
});

/**
 * ⚠️ P4a 回炉 1 次的回归网：**多 agent 同进程时，域上下文不能被"最后装配者"覆盖**。
 *
 * 事故经过：第一版把域写成模块级变量、由 AgentRuntime 构造时赋值。装配顺序是
 * junwuyou → yuanyi，于是元一的域覆盖了君无忧的；君无忧的工具带着 `allowed=[53100]`
 * 去调调度器 35801 → 被自己的隔离层拒 → **线上报价链路整条断掉**
 * （日志：`E_DATA_DOMAIN_VIOLATION: agent=yuanyi 不得访问 http://127.0.0.1:35801`）。
 * 修法：请求期用 AsyncLocalStorage 绑定本轮 agent 的域；请求外兜底**只认第一个**。
 */
describe("多 agent 域上下文隔离（P4a 事故回归）", () => {
  it("两个 runtime 并发/先后请求：各自的工具只用自己的白名单（不串域）", async () => {
    // 模拟两个 agent 的两轮请求同时进行（真实网关就是并发处理多账号消息的）
    const jw = () => runWithDataDomain({ agentId: "junwuyou", allowedOrigins: [JUNWUYOU] }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return enforceDataOrigin(`${JUNWUYOU}/schedule/pricing`);
    });
    const yy = () => runWithDataDomain({ agentId: "yuanyi", allowedOrigins: [YUANYI] }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return enforceDataOrigin(`${YUANYI}/api/quote`);
    });
    const [a, b] = await Promise.all([jw(), yy()]);
    expect(a).toContain("53000");
    expect(b).toContain("53100");
    // 交叉方向必须被拒（各自的域之外一律拒绝）—— 同步函数用 try/catch 断言
    const cross = async (ctx: { agentId: string; allowedOrigins: string[] }, url: string) => {
      return runWithDataDomain(ctx, async () => {
        try { enforceDataOrigin(url); return null; } catch (e) { return e as Error; }
      });
    };
    const e1 = await cross({ agentId: "junwuyou", allowedOrigins: [JUNWUYOU] }, `${YUANYI}/api/quote`);
    const e2 = await cross({ agentId: "yuanyi", allowedOrigins: [YUANYI] }, `${JUNWUYOU}/schedule/pricing`);
    expect(isDataDomainViolation(e1)).toBe(true);
    expect(String(e1?.message)).toContain("agent=junwuyou");
    expect(isDataDomainViolation(e2)).toBe(true);
    expect(String(e2?.message)).toContain("agent=yuanyi");
  });

  it("请求外兜底只认第一个设置者 —— 后装配的 agent 不得覆盖（本次事故的直接成因）", () => {
    setFallbackDataDomain({ agentId: "junwuyou", allowedOrigins: [JUNWUYOU] });
    setFallbackDataDomain({ agentId: "yuanyi", allowedOrigins: [YUANYI] }); // 装配顺序后到者
    expect(getDataDomain()?.agentId).toBe("junwuyou");
    // 君无忧的工具在请求外调用（如定时任务）不得被元一的域拒掉
    expect(enforceDataOrigin(`${JUNWUYOU}/schedule/pricing`)).toContain("53000");
  });

  it("请求期上下文覆盖兜底上下文（权威顺序：本轮 > 兜底）", async () => {
    setFallbackDataDomain({ agentId: "junwuyou", allowedOrigins: [JUNWUYOU] });
    // 注意：enforceDataOrigin 是**同步**函数，这里用 try/catch 而不是 await expect(...).rejects
    // （写错断言形状会让"同步抛出"变成测试框架的未捕获错误，掩盖真实结论）
    await runWithDataDomain({ agentId: "yuanyi", allowedOrigins: [YUANYI] }, async () => {
      expect(getDataDomain()?.agentId).toBe("yuanyi");
      expect(enforceDataOrigin(`${YUANYI}/api/quote`)).toContain("53100");
      let err: unknown = null;
      try { enforceDataOrigin(`${JUNWUYOU}/schedule/pricing`); } catch (e) { err = e; }
      expect(isDataDomainViolation(err)).toBe(true);
      expect(String((err as Error).message)).toContain("agent=yuanyi");
    });
  });

  it("enterWithDataDomain（流式路径）绑定当前执行链", async () => {
    enterWithDataDomain({ agentId: "yuanyi", allowedOrigins: [YUANYI] });
    expect(getDataDomain()?.agentId).toBe("yuanyi");
  });
});

describe("数据域边界（A16）", () => {
  it("自己的 origin → 放行（原样返回，便于内联 fetch）", () => {
    setDataDomain({ agentId: "yuanyi", dataDomain: "yuanyi", allowedOrigins: [YUANYI] });
    const url = `${YUANYI}/api/sku/query?q=1-1734592-2`;
    expect(enforceDataOrigin(url)).toBe(url);
  });

  it("打到另一个 agent 的 origin → 抛 E_DATA_DOMAIN_VIOLATION，报错里点名 agentId 与目标", () => {
    setDataDomain({ agentId: "yuanyi", dataDomain: "yuanyi", allowedOrigins: [YUANYI] });
    let err: unknown;
    try {
      enforceDataOrigin(`${JUNWUYOU}/api/orders?customer_id=9`);
    } catch (e) {
      err = e;
    }
    expect(isDataDomainViolation(err)).toBe(true);
    const msg = (err as Error).message;
    expect(msg).toContain(DATA_DOMAIN_VIOLATION);
    expect(msg).toContain("agent=yuanyi");            // 谁越权
    expect(msg).toContain("127.0.0.1:53000");          // 打了谁
    expect(msg).toContain("53100");                    // 允许的是谁（排查用）
  });

  it("白名单写带尾斜杠/路径的形式也能匹配（配置容错，不靠人工写对）", () => {
    setDataDomain({ agentId: "yuanyi", dataDomain: "yuanyi", allowedOrigins: [`${YUANYI}/`] });
    expect(enforceDataOrigin(`${YUANYI}/api/sku`)).toBe(`${YUANYI}/api/sku`);
  });

  it("未配置域上下文（诊断脚本/harness/单测）→ 放行，且 getDataDomain() 为 null", () => {
    setDataDomain(null);
    expect(getDataDomain()).toBeNull();
    expect(enforceDataOrigin(`${JUNWUYOU}/api/orders`)).toBe(`${JUNWUYOU}/api/orders`);
  });

  it("非法 URL → 拒绝（不是放行）", () => {
    setDataDomain({ agentId: "yuanyi", dataDomain: "yuanyi", allowedOrigins: [YUANYI] });
    expect(() => enforceDataOrigin("not-a-url")).toThrow(/E_DATA_DOMAIN_VIOLATION/);
  });
});

describe("fail-closed（A17）", () => {
  it("allowedOrigins 为空数组 → 任何业务调用都拒绝", () => {
    setDataDomain({ agentId: "yuanyi", dataDomain: "yuanyi", allowedOrigins: [] });
    let err: unknown;
    try {
      enforceDataOrigin(`${YUANYI}/api/sku`);
    } catch (e) {
      err = e;
    }
    expect(isDataDomainViolation(err)).toBe(true);
    expect((err as Error).message).toContain("白名单为空");
  });

  it("allowedOrigins 全是空串/空白 → 等价于空白名单（不被'\t'骗过）", () => {
    setDataDomain({ agentId: "yuanyi", dataDomain: "yuanyi", allowedOrigins: ["", "  ", "\t"] });
    expect(() => enforceDataOrigin(`${YUANYI}/api/sku`)).toThrow(/E_DATA_DOMAIN_VIOLATION/);
  });

  it("降级开关 DATA_DOMAIN_ENFORCE=false → 只告警不拦，但**必须留痕**（不静默）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.DATA_DOMAIN_ENFORCE = "false";
    try {
      setDataDomain({ agentId: "yuanyi", dataDomain: "yuanyi", allowedOrigins: [YUANYI] });
      const url = `${JUNWUYOU}/api/orders`;
      expect(enforceDataOrigin(url)).toBe(url); // 放行
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("降级放行");
    } finally {
      delete process.env.DATA_DOMAIN_ENFORCE;
    }
  });
});
