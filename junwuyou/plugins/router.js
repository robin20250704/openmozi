// plugins/router.js — 转人工路由 Plugin
// D7 红线场景检测 + 强制转人工 + 通知主管
//
// 红线触发条件（关键词兜底，AI 自身判断更准）：
// 1. 退款/退钱/少找我钱/收错钱 → 强红线
// 2. 投诉/态度差/服务差/师傅差 → 强红线
// 3. 野生动物/法律/起诉/报警 → 弱红线（可答事实但建议转人工）
// 4. 用户明确说"+人工"/"找人工"/"人工客服" → 强制转人工

const REDLINE_KEYWORDS_STRONG = [
  "退款", "退钱", "退掉", "退订", "退单", "退服务",
  "少找", "多收", "收错", "少收", "没收到钱",
  "投诉", "态度差", "态度不好", "服务差", "服务不好", "师傅差", "师傅不好",
  "差评", "曝光", "315", "起诉", "报警", "12315", "消协", "工商局",
];

const REDLINE_KEYWORDS_HUMAN = [
  "+人工", "+ 人工", "找人工", "人工客服", "转人工", "真人", "要人", "找人",
];

export function detectRedline(text) {
  if (!text) return null;
  const t = String(text);
  for (const k of REDLINE_KEYWORDS_HUMAN) {
    if (t.includes(k)) return { type: "human_request", reason: `用户请求人工: ${k}` };
  }
  for (const k of REDLINE_KEYWORDS_STRONG) {
    if (t.includes(k)) return { type: "redline_strong", reason: `红线: ${k}` };
  }
  // 野生动物/法律弱红线
  if (/黄鼠狼|蛇|蝙蝠|野生动物|起诉|报警|法律/.test(t)) {
    return { type: "redline_soft", reason: "弱红线（事实可答，建议转人工）" };
  }
  return null;
}

export function registerRouter(api) {
  api.registerHook("message_received", async (context) => {
    try {
      const text = context?.message?.content || context?.content || "";
      const redline = detectRedline(text);
      if (!redline) return;
      const sessionId = context?.session_id || "unknown";
      const channel = context?.channel || "unknown";
      const externalUserId = context?.external_user_id || "unknown";
      // 写 handoff_tickets
      const { query } = await import("../lib/pg-client.js");
      await query(
        `INSERT INTO handoff_tickets (session_id, channel, external_user_id, status, priority, summary)
         VALUES ($1, $2, $3, 'pending', $4, $5)
         ON CONFLICT (session_id) DO UPDATE
         SET status = 'pending', priority = EXCLUDED.priority, summary = EXCLUDED.summary`,
        [
          sessionId,
          channel,
          externalUserId,
          redline.type === "redline_strong" ? "high" : "normal",
          `[自动转人工] ${redline.reason}`,
        ]
      );
      console.log(`[router] handoff: ${redline.type} session=${sessionId} reason=${redline.reason}`);
    } catch (e) {
      console.error("[router] hook error:", e.message);
    }
  });
}
