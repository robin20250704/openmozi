// scripts/repair-qq-wrong-orders.mjs — 修正事故订单（订单 #1/#2）
//
// 事故：agent 没有时间坐标，把客户的「今天/后天」编成 2026-05-14/05-16
// （真实今天 2026-09-14），且当时库层无日期校验，两笔过去日期的订单被正常创建。
// 另有报价缺陷：白蚁 200㎡ 报 99 元，按权威定价源应为 129 元。
//
// 用户裁定（2026-09-14）：原地修正 —— 日期改 9/14 与 9/16，白蚁价格改成修正后的价。
// 本脚本走 HTTP 的 /api/orders/:id/amend（唯一写者侧校验），不直接改库文件。
const JW = process.env.JUNWUYOU_API_URL || "http://127.0.0.1:53000";
const TOKEN = process.env.ADMIN_TOKEN || "";

async function post(path, body) {
  const url = TOKEN ? `${JW}${path}?token=${encodeURIComponent(TOKEN)}` : `${JW}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保留原文 */ }
  return { status: res.status, json, text };
}

async function get(path) {
  const res = await fetch(`${JW}${path}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保留原文 */ }
  return { status: res.status, json, text };
}

// 修正目标（依据：客户原话「南天的今天、纯水岸的后天」，事故当天 2026-09-14）
//  - #1 纯水岸 白蚁 200㎡：日期 2026-05-16 → 2026-09-16（后天），价格 99 → 129（+超140㎡加收30）
//  - #2 百花南天二花园 蟑螂 100㎡：日期 2026-05-14 → 2026-09-14（今天），价格 189 不变
//  - 时段：客户明确说「都10点」，原写的是 18-20 = 09:00-10:00（早一小时），改为 20-22 = 10:00-11:00
const PLAN = [
  { id: 1, scheduled_date: "2026-09-16", start_slot: 20, end_slot: 22, price: 129, note: "纯水岸 白蚁 200㎡：日期+价格+时段" },
  { id: 2, scheduled_date: "2026-09-14", start_slot: 20, end_slot: 22, price: 189, note: "百花南天二花园 蟑螂 100㎡：日期+时段（价格本就正确）" },
];

console.log("=== 修正前 ===");
const before = await get("/api/orders?customer_id=9");
for (const o of before.json?.orders ?? []) console.log(`#${o.id} ${o.status} ${o.scheduled_date} slot ${o.start_slot}-${o.end_slot} ${o.pest_type} ${o.area_sqm}㎡ ${o.price}元 ${o.community_name}`);

const dryRun = process.argv.includes("--dry-run");
if (dryRun) {
  console.log("\n（--dry-run：只打印计划，不写入）");
  for (const p of PLAN) console.log(`#${p.id} → ${p.scheduled_date} slot ${p.start_slot}-${p.end_slot} ${p.price}元  ${p.note}`);
  process.exit(0);
}

console.log("\n=== 执行修正 ===");
for (const p of PLAN) {
  const r = await post(`/api/orders/${p.id}/amend`, {
    scheduled_date: p.scheduled_date, start_slot: p.start_slot, end_slot: p.end_slot, price: p.price,
  });
  const o = r.json?.order;
  console.log(`#${p.id} ${r.status} ${o ? `→ ${o.scheduled_date} slot ${o.start_slot}-${o.end_slot} ${o.price}元` : r.text}`);
}

console.log("\n=== 修正后 ===");
const after = await get("/api/orders?customer_id=9");
for (const o of after.json?.orders ?? []) console.log(`#${o.id} ${o.status} ${o.scheduled_date} slot ${o.start_slot}-${o.end_slot} ${o.pest_type} ${o.area_sqm}㎡ ${o.price}元 ${o.community_name}`);

// 复核：不能再有过去日期的 pending 订单
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
const bad = (after.json?.orders ?? []).filter((o) => o.status === "pending" && o.scheduled_date < today);
console.log(`\n复核：pending 订单中过去日期的数量 = ${bad.length}（应为 0）`);
// 不要直接 process.exit()：fetch(undici) 句柄正在关闭时硬退出会触发
// libuv 断言（Windows 上表现为退出码 0xC0000409），会让调用方误判为失败。
process.exitCode = bad.length === 0 ? 0 : 1;
await new Promise((r) => setTimeout(r, 400));
