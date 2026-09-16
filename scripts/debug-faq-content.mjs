// debug-faq-content.mjs — 打印关键 FAQ 原文，作为端到端断言的事实基准
import { config as loadDotenv } from "dotenv";
loadDotenv();
const { query } = await import("../agents/junwuyou/lib/pg-client.js");
const ids = [1, 2, 10, 13, 14, 15];
const r = await query(`SELECT id, question, answer FROM faq_items WHERE id = ANY($1) ORDER BY id`, [ids]);
for (const row of r.rows) {
  console.log(`\n[FAQ#${row.id}] Q: ${row.question}`);
  console.log(`        A: ${row.answer}`);
}
process.exit(0);
