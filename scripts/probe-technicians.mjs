// 核实"是否真有师傅"以及订单的承接情况——只读查询，不修改任何数据
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const dbPath = process.env.JUNWUYOU_DB || "D:/project/ai-sales/junwuyou/server/db/junwuyou.db";
const db = new DatabaseSync(dbPath, { readOnly: true });

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log("表:", tables.map((t) => t.name).join(", "));

console.log("\n=== technicians（技师/师傅名册） ===");
const techs = db.prepare("SELECT * FROM technicians").all();
console.log(`共 ${techs.length} 行`);
for (const t of techs) console.log(" ", JSON.stringify(t));

console.log("\n=== orders 汇总 ===");
const agg = db
  .prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END) AS confirmed,
            SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
            SUM(CASE WHEN technician_id IS NULL OR technician_id='' THEN 1 ELSE 0 END) AS no_tech
     FROM orders`
  )
  .get();
console.log(" ", JSON.stringify(agg));

console.log("\n=== 未取消订单明细（看是否指派了技师） ===");
const rows = db
  .prepare(
    `SELECT id, status, technician_id, pest_type, area_sqm, price, scheduled_date, start_slot, end_slot, community_name
     FROM orders WHERE status != 'cancelled' ORDER BY id`
  )
  .all();
for (const r of rows) console.log(" ", JSON.stringify(r));

console.log("\n=== customers（客户） ===");
const cs = db.prepare("SELECT id, wecom_user_id, name, phone, address, community_name FROM customers").all();
console.log(`共 ${cs.length} 行`);
for (const c of cs) console.log(" ", JSON.stringify(c));

db.close();
process.exitCode = 0;
