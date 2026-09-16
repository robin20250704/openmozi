// tools/query-customer-profile.js — query_customer_profile Tool
// 经 junwuyou Express 53000 查客户档案（HTTP /api/customers/:wecom_user_id）
const JUNWUYOU_API = process.env.JUNWUYOU_API_URL || "http://127.0.0.1:53000";

async function fetchJson(path) {
  const res = await fetch(`${JUNWUYOU_API}${path}`, { headers: { "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(`junwuyou ${path} ${res.status}: ${await res.text()}`);
  return await res.json();
}

export const queryCustomerProfileTool = {
  name: "query_customer_profile",
  description: "查询客户档案（电话/地址/历史订单）。",
  parameters: {
    type: "object",
    properties: {
      wecom_user_id: { type: "string", description: "客户标识（wecom_user_id / openid）" },
    },
    required: ["wecom_user_id"],
  },
  execute: async (_toolCallId, params) => {
    const profile = await fetchJson(`/api/customers/${encodeURIComponent(params.wecom_user_id)}`);
    return { content: [{ type: "text", text: JSON.stringify(profile) }] };
  },
};
