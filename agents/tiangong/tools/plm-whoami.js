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
    const payload = {
      ok: true,
      user_id: getSenderId(),
      user_name: getSenderName(),
      display: getSenderLabel(),
      session_key: getSessionKey(),
      note: "身份由前端网关通过 HTTP 头 X-PLM-User / X-PLM-User-Name 提供；未提供时为匿名访客。",
    };
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  },
};
