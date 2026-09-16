// scripts/probe-pricing-slots.mjs — 诊断：核实报价规则与 slot 语义（需求 4）
// 用 Node fetch 而不是 PowerShell Invoke-WebRequest：后者在 Windows 上对 body 的
// 中文编码不可控（实测把「白蚁」变成 "??"），会造出假缺陷。
import { resolveApiToken } from "../agents/junwuyou/lib/root-env.js";

const BASE = process.env.SCHEDULER_API_URL || "http://127.0.0.1:35801";
// P0（D-24）：/schedule/* 需要分组 token；诊断脚本从进程环境或仓库根 .env 取，缺则显式提示。
const { token: TOKEN, source: TOKEN_SOURCE } = resolveApiToken("SCHEDULER_API_TOKEN", ["SCHEDULER_API_KEY"]);
if (!TOKEN) {
  console.error("✗ SCHEDULER_API_TOKEN 未配置（仓库根 .env）——诊断会全是 401，先补凭据再跑。");
  process.exit(2);
}
console.log(`[probe] BASE=${BASE} auth=Bearer(${TOKEN_SOURCE})`);

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

console.log("=== query_pricing 矩阵 ===");
const cases = [
  [100, "蟑螂"], [160, "蟑螂"], [200, "蟑螂"],
  [100, "老鼠"], [200, "老鼠"],
  [60, "白蚁"], [100, "白蚁"], [160, "白蚁"], [200, "白蚁"], [400, "白蚁"],
  [100, "蚊蝇"], [200, "蚊蝇"],
  [200, "甲醛"],
];
for (const [area, pest] of cases) {
  const r = await call("POST", "/schedule/pricing", { area_sqm: area, pest_type: pest });
  console.log(`${String(area).padStart(3)}㎡ ${pest.padEnd(3)} → ${r.status} ${r.body}`);
}

console.log("\n=== propose_slots 返回结构（看是否含日期字段）===");
const p = await call("POST", "/schedule/propose", {
  preferred_date: "2026-09-14", community_name: "百花南天二花园", service_slots: 2, top_k: 3,
});
console.log(`${p.status} ${p.body}`);

console.log("\n=== 过去日期能否下单（应被拒绝，不落库）===");
const past = await call("POST", "/schedule/appointments", {
  customer_id: 9, technician_id: "tech_003", scheduled_date: "2026-05-14",
  start_slot: 18, end_slot: 20, address: "诊断探测", community_name: "诊断探测",
  area_sqm: 1, pest_type: "蟑螂", price: 1,
});
console.log(`past-date → ${past.status} ${past.body}`);
// 防御性清理：万一写进去了（例如服务未更新），立刻取消，避免污染排期
if (past.status === 200) {
  try {
    const id = JSON.parse(past.body)?.appointment_id;
    const JW = process.env.JUNWUYOU_API_URL || "http://127.0.0.1:53000";
    if (id) {
      await fetch(`${JW}/api/orders/${id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ reason: "诊断探测测试订单，自动清理" }),
      });
      console.log(`  ⚠️ 竟然被接受 → 已自动取消订单 #${id}（说明写者侧校验未生效）`);
    }
  } catch (e) {
    console.log(`  清理失败：${e.message}`);
  }
} else {
  console.log("  ✅ 被写者拒绝，未产生任何订单行");
}

console.log("\n=== slot 语义（0=00:00，半小时粒度）===");
console.log("18→09:00  20→10:00  28→14:00  36→18:00（与 Rust slot_to_time 一致）");
