// plugins/audit.js — 全量消息审计 + 敏感信息脱敏
// C-037：写入 audit_logs 表
// 脱敏规则：手机号/身份证/银行卡/详细地址 → ***替换

const PATTERNS = [
  // 手机号（中国大陆 11 位）
  { name: "phone", regex: /\b1[3-9]\d{9}\b/g, mask: (m) => m.slice(0, 3) + "****" + m.slice(-4) },
  // 身份证（18 位）
  { name: "idcard", regex: /\b\d{17}[\dXx]\b/g, mask: (m) => m.slice(0, 4) + "**********" + m.slice(-4) },
  // 银行卡（16-19 位连续数字）
  { name: "bankcard", regex: /\b\d{16,19}\b/g, mask: (m) => m.slice(0, 4) + "********" + m.slice(-4) },
  // 详细地址（包含"XX市XX区XX路XX号"等）
  { name: "address", regex: /[\u4e00-\u9fa5]{2,}(市|区|县)[\u4e00-\u9fa5]{2,}(路|街|道|镇)[\u4e00-\u9fa5A-Za-z0-9]{2,}/g, mask: () => "[地址已脱敏]" },
];

export function redact(text) {
  if (!text) return text;
  let out = String(text);
  for (const p of PATTERNS) {
    out = out.replace(p.regex, p.mask);
  }
  return out;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  external_user_id TEXT,
  direction TEXT NOT NULL,
  role TEXT,
  content_redacted TEXT,
  tool_calls JSONB DEFAULT '[]'::jsonb,
  timestamp TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_logs (session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_channel ON audit_logs (channel, timestamp);`;

let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured) return;
  const { query } = await import("../lib/pg-client.js");
  await query(SCHEMA_SQL);
  schemaEnsured = true;
}

async function logEvent(direction, context) {
  try {
    await ensureSchema();
    const { query } = await import("../lib/pg-client.js");
    const content = context?.message?.content || context?.content || context?.text || "";
    const role = direction === "inbound" ? "user" : "assistant";
    await query(
      `INSERT INTO audit_logs (session_id, channel, external_user_id, direction, role, content_redacted, tool_calls)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        context?.session_id || "unknown",
        context?.channel || "unknown",
        context?.external_user_id || null,
        direction,
        role,
        redact(content),
        JSON.stringify(context?.tool_calls || []),
      ]
    );
  } catch (e) {
    console.error("[audit] log error:", e.message);
  }
}

export function registerAudit(api) {
  api.registerHook("message_received", async (context) => {
    await logEvent("inbound", context);
  });
  api.registerHook("message_sent", async (context) => {
    await logEvent("outbound", context);
  });
}
