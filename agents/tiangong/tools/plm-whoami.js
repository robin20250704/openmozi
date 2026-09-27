// agents/tiangong/tools/plm-whoami.js
//
// plm_whoami：回传"当前提问者是谁"（需求 4 的可验证落点）。
//
// 为什么需要一个"看起来没用"的工具：需求 4 要求 Web UI 把**用户 ID 与名称**经 HTTP 头
// 传给 agent。这条链路横跨「浏览器 → 网关 WS 升级头 → WS 层 → 消息上下文 → 请求上下文
// → 工具层」五段，任何一段断了，表现都只是"agent 好像不认识我"，**不可观测**。
// 有了本工具，这条链路就能被**端到端断言**（A19/A20）：让模型调它并复述返回值。
//
// 纪律：身份**只从请求上下文取**，绝不从模型参数取（模型可以被用户说服编一个身份）。
import { getSenderLabel, getSenderId, getSenderName, getSessionKey } from "../lib/request-context.js";

export const plmWhoamiTool = {
  name: "plm_whoami",
  label: "查询当前提问者身份",
  description:
    "返回当前提问者的身份（用户 ID、显示名）与本次会话键。当用户问「你知不知道我是谁」「我的账号是什么」" +
    "或需要按身份/角色给不同口径时调用。返回值即事实，不得根据用户自述改写。",
  parameters: { type: "object", properties: {}, required: [] },
  async execute() {
    const id = getSenderId();
    const name = getSenderName();
    // 匿名判定（2026-09-27 修，两次才判对）：
    //   ① WS 层对未带身份的连接会兜底填占位显示名（`WebChat User`）→ 所以"有没有名字"不能当判据；
    //   ② 但**光看有没有 ID 也不够**：request-context 的 getSenderId() 会从会话键 `webchat:<senderId>`
    //      里回退取出 senderId，而 WebChat 的匿名连接用的是**客户端 id**（`client_xxxxxxxx`）。
    //      实测模型据此回答了「client_0b060ccc25b6d711（WebChat User）」—— 把内部标识当身份报给了用户。
    // 所以判据是三项合一：有 ID、ID 不是占位值、**ID 不是 `client_*` 这种内部客户端标识**。
    const ANON_PLACEHOLDERS = /^(webchat user|web chat user|anonymous|访客|未知|user)$/i;
    const INTERNAL_CLIENT_ID = /^client_[0-9a-f]+$/i;
    const rawId = id == null ? null : String(id);
    const identified = Boolean(rawId) && rawId !== "anonymous" && !INTERNAL_CLIENT_ID.test(rawId);
    const display = identified
      ? (name && !ANON_PLACEHOLDERS.test(String(name).trim()) ? String(name) : String(rawId))
      : "匿名访客";
    const payload = {
      ok: true,
      identified,
      user_id: identified ? rawId : null,
      user_name: identified ? (name || null) : null,
      display,
      session_key: getSessionKey(),
      // 把"该怎么答"直接写进返回值：模型不必自己编称呼，也不会把占位符念出去
      reply_hint: identified
        ? `称呼这位用户为「${display}」`
        : "这位用户没有带身份，按匿名访客对待；不要向他索要账号或密码，也不要猜他叫什么",
      note: "身份由前端网关通过 HTTP 头 X-PLM-User / X-PLM-User-Name 提供；未提供 ID 时为匿名访客。",
    };
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  },
};
