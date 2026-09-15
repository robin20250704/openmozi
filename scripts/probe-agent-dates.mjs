// scripts/probe-agent-dates.mjs — 诊断（需求 1）：agent 对"今天/星期/节假日"的认知基线
// 目的：在改动前拿到"它到底知不知道日期"的客观证据，而不是推测。
import WebSocket from "ws";

const WS_URL = "ws://127.0.0.1:33000/ws";

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => reject(new Error("连接超时")), 8000);
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.event === "connected") {
        clearTimeout(timer);
        resolve({ ws, clientId: m.payload?.clientId });
      }
    });
    ws.on("error", reject);
  });
}

function chat(ws, message, timeoutMs = 90000) {
  return new Promise((resolve) => {
    let text = "";
    const timer = setTimeout(() => {
      ws.off("message", onMsg);
      resolve(text + "  [TIMEOUT]");
    }, timeoutMs);
    const onMsg = (d) => {
      const m = JSON.parse(d.toString());
      if (m.event === "chat.delta") {
        if (m.payload?.delta) text += m.payload.delta;
        if (m.payload?.done) {
          clearTimeout(timer);
          ws.off("message", onMsg);
          resolve(text);
        }
      }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ type: "req", id: String(Date.now()), method: "chat.send", params: { message } }));
  });
}

const real = new Date();
const wd = ["日", "一", "二", "三", "四", "五", "六"][real.getDay()];
console.log(`真实系统时间：${real.getFullYear()}-${String(real.getMonth() + 1).padStart(2, "0")}-${String(real.getDate()).padStart(2, "0")} 星期${wd}\n`);

const { ws } = await connect();
const questions = [
  "今天几月几号？星期几？",
  "那明天是几号？后天呢？",
  "下个星期一是几号？那天是节假日吗？",
];
for (const q of questions) {
  const a = await chat(ws, q);
  console.log(`Q: ${q}\nA: ${a}\n${"-".repeat(60)}`);
}
ws.close();
