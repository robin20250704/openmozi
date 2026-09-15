// scripts/dump-business-db.mjs — 只读导出君无忧业务库内容（诊断用）
// 为什么要拷贝再读：生产进程以 WAL 模式持有该库，直接打开有风险；
// 拷贝（含 -wal/-shm）后在副本上读，绝不影响生产。
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SRC = process.env.JUNWUYOU_DB || "D:\\project\\ai-sales\\junwuyou\\server\\db\\junwuyou.db";
const copy = join(tmpdir(), `junwuyou-diag-${Date.now()}.db`);

for (const suffix of ["", "-wal", "-shm"]) {
  const s = SRC + suffix;
  if (existsSync(s)) copyFileSync(s, copy + suffix);
}

const db = new DatabaseSync(copy, { readOnly: true });
const all = (sql) => db.prepare(sql).all();

console.log("=== tables ===");
console.log(all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name).join(", "));

for (const [label, sql] of [
  ["customers", "SELECT * FROM customers"],
  ["orders", "SELECT * FROM orders"],
  ["technicians", "SELECT * FROM technicians"],
]) {
  console.log(`\n=== ${label} ===`);
  const rows = all(sql);
  console.log(`count=${rows.length}`);
  for (const r of rows) console.log(JSON.stringify(r));
}

db.close();
for (const suffix of ["", "-wal", "-shm"]) rmSync(copy + suffix, { force: true });
