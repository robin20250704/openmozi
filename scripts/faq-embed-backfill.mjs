// faq-embed-backfill.mjs — 回填 faq_items.embedding（L4 语义向量层）
//
// 背景（L-044）：faq-import.mjs 按设计把 embedding 留 NULL，指望"容器内加载模型后回填"，
// 但从未有回填步骤 → 18 条 FAQ 全部 embedding IS NULL → L4 向量层即使模型可用也召回为空。
//
// 用法：
//   node scripts/faq-embed-backfill.mjs            # 只回填 embedding IS NULL 的行（幂等）
//   node scripts/faq-embed-backfill.mjs --force    # 全部重算
//
// 嵌入文本选择：FAQ 的 question（与用户提问对称，L1~L3 也以 question 为检索键）；
// L5 reranker 才用 "question answer" 作为 passage。

import { config as loadDotenv } from "dotenv";
loadDotenv();

// L-042 同族：pg-client / embedding 读模块级 env，必须在 dotenv 之后动态 import
const { query, getPool } = await import("../junwuyou/lib/pg-client.js");
const { getEmbedder } = await import("../junwuyou/lib/embedding.js");

const FORCE = process.argv.includes("--force");

const embedder = await getEmbedder();
if (!embedder) {
  console.error("❌ embedder 不可用 —— 先修复 embedding.js（依赖/模型路径），回填中止");
  process.exit(1);
}

const where = FORCE ? "" : "WHERE embedding IS NULL";
const { rows } = await query(
  `SELECT id, question, answer FROM faq_items ${where} ORDER BY id`
);

const total = await query(`SELECT COUNT(*)::int AS n FROM faq_items`);
console.log(`FAQ 总数=${total.rows[0].n}，待回填=${rows.length}${FORCE ? "（--force 全量重算）" : "（仅 NULL 行）"}`);

let ok = 0;
let fail = 0;
const t0 = Date.now();

for (const row of rows) {
  try {
    const vec = await embedder.embed(row.question);
    if (!Array.isArray(vec) || vec.length !== 512) {
      throw new Error(`维度异常: ${vec?.length}`);
    }
    const vecLit = "[" + vec.join(",") + "]";
    await query(`UPDATE faq_items SET embedding = $1::vector, updated_at = now() WHERE id = $2`, [
      vecLit,
      row.id,
    ]);
    ok++;
    console.log(`  ✓ id=${row.id} ${row.question.slice(0, 24)} (${vec.length}维)`);
  } catch (e) {
    fail++;
    console.error(`  ✗ id=${row.id} ${row.question.slice(0, 24)}: ${e.message}`);
  }
}

const ms = Date.now() - t0;
const after = await query(`SELECT COUNT(*)::int AS n FROM faq_items WHERE embedding IS NOT NULL`);
console.log(`\n回填完成：成功 ${ok} / 失败 ${fail}，用时 ${ms}ms（${(ms / Math.max(ok, 1)).toFixed(0)}ms/条）`);
console.log(`库内 embedding 非空行数：${after.rows[0].n} / ${total.rows[0].n}`);

await getPool().end();
process.exit(fail > 0 ? 1 : 0);
