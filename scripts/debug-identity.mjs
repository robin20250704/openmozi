// scripts/debug-identity.mjs — 实测 agent 自称（公司名/助手名），确认提示词是否生效
import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:33000/ws");
let text = "";
ws.on("open", () => {
  ws.send(JSON.stringify({ type: "req", id: "1", method: "chat.send", params: { message: "你们是什么公司？你叫什么名字？" } }));
});
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.event === "chat.delta") {
    if (m.payload?.delta) text += m.payload.delta;
    if (m.payload?.done) {
      console.log("自称回复:", text.replace(/\n/g, " "));
      const okCompany = /君无忧/.test(text);
      const okName = /小君/.test(text);
      console.log(`  含「君无忧」: ${okCompany ? "✅" : "❌"}`);
      console.log(`  含「小君」: ${okName ? "✅" : "❌"}`);
      const other = text.match(/[\u4e00-\u9fa5]{2,6}(科技|生物|服务|虫控|环保)[\u4e00-\u9fa5]{0,6}/g) || [];
      console.log(`  出现的机构名片段: ${other.join(" / ") || "(无)"}`);
      process.exit(0);
    }
  }
});
setTimeout(() => { console.log("超时"); process.exit(1); }, 90000);
