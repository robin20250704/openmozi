// tools/request-admin-approval.js — request_admin_approval Tool
// 红线场景兜底：投诉、退款、大客户折扣等
import { query } from "../lib/pg-client.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS handoff_tickets (
  id SERIAL PRIMARY KEY,
  session_id TEXT,
  channel TEXT,
  external_user_id TEXT,
  status TEXT DEFAULT 'pending',
  priority TEXT DEFAULT 'high',
  summary TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);`;

let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured) return;
  await query(SCHEMA_SQL);
  schemaEnsured = true;
}

export const requestAdminApprovalTool = {
  name: "request_admin_approval",
  description: "**红线场景专用**：客户要求退款/投诉/特殊折扣等 AI 无法处理的请求。",
  parameters: {
    type: "object",
    properties: {
      customer_id: { type: "string", description: "客户 ID" },
      session_id: { type: "string", description: "会话 ID" },
      channel: { type: "string", description: "渠道（wecom/qq/email/webchat/...）" },
      request_type: {
        type: "string",
        enum: ["free_service", "refund", "discount", "reschedule", "complaint"],
        description: "请求类型",
      },
      reason: { type: "string", description: "请求原因（用户原话）" },
      amount: { type: "number", description: "金额（退款/折扣场景）" },
    },
    required: ["customer_id", "request_type", "reason"],
  },
  execute: async (_toolCallId, params) => {
    await ensureSchema();
    const res = await query(
      `INSERT INTO handoff_tickets (session_id, channel, external_user_id, status, priority, summary)
       VALUES ($1, $2, $3, 'pending', 'high', $4)
       RETURNING id, created_at`,
      [
        params.session_id || "unknown",
        params.channel || "webchat",
        params.customer_id,
        `[${params.request_type}] ${params.reason}${params.amount ? ` (¥${params.amount})` : ""}`,
      ]
    );
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ticket_id: res.rows[0].id,
          status: "pending_admin_approval",
          hint: "AI 不直接处理，已提交给管理员审核。",
        }),
      }],
    };
  },
};
