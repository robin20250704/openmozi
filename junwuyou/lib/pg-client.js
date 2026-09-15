// pg-client.js — PostgreSQL 连接池（pgvector + pg_trgm）
// 用于 faq-search、audit、转人工工单、faq_items CRUD
//
// 设计：
// - 单例 pool（不每次 connect/disconnect）
// - 优雅关闭（process.on('SIGTERM', close)）
// - 启动时 ping 健康检查

import pg from "pg";
const { Pool } = pg;

const cfg = {
  host: process.env.PG_HOST || "127.0.0.1",
  port: parseInt(process.env.PG_PORT || "5434", 10),
  user: process.env.PG_USER || "openmozi",
  password: process.env.PG_PASSWORD || "openmozi_dev_only",
  database: process.env.PG_DATABASE || "openmozi",
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

let pool = null;

export function getPool() {
  if (!pool) {
    pool = new Pool(cfg);
    pool.on("error", (err) => {
      console.error("[pg] pool error:", err.message);
    });
  }
  return pool;
}

export async function query(text, params) {
  const p = getPool();
  const start = Date.now();
  try {
    const res = await p.query(text, params);
    const ms = Date.now() - start;
    if (ms > 200) console.warn(`[pg] slow query ${ms}ms: ${text.slice(0, 80)}`);
    return res;
  } catch (e) {
    console.error("[pg] query error:", e.message, "SQL:", text.slice(0, 100));
    throw e;
  }
}

export async function healthCheck() {
  try {
    const res = await query("SELECT 1 AS ok, version()");
    return { ok: true, version: res.rows[0].version };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

process.on("SIGTERM", closePool);
process.on("SIGINT", closePool);
