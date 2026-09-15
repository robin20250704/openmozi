/**
 * 最小 SMTP 客户端（P0.6 邮件渠道出站）
 *
 * 为什么自己写：本机外网 npm 受限（L-019/L-051 同族），且只需"登录 + 发一封纯文本邮件"
 * 这一条路径。零新依赖，只用 node:tls / node:net。
 *
 * 支持两种连接形态（真实邮箱两种都有）：
 *   - 隐式 TLS（SMTPS，端口 465，QQ/163 常用）
 *   - 明文 + STARTTLS（端口 587）
 */

import net from "node:net";
import tls from "node:tls";
import type { Socket } from "node:net";

export class SmtpError extends Error {}

export interface SmtpConfig {
  host: string;
  port: number;
  secure?: boolean;
  user: string;
  password: string;
  timeoutMs?: number;
}

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  messageId: string;
  fromName?: string;
  inReplyTo?: string | null;
  references?: string[];
}

export interface SendMailResult {
  ok: boolean;
  messageId: string;
  error?: string;
}

interface Waiter {
  marker: string;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** 读状态行；多行响应（"250-..." 续行，以 "250 " 结束）要读完 */
function createReader(socket: Socket, timeoutMs: number) {
  let buffer = "";
  const waiters: Waiter[] = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    flush();
  });
  socket.on("close", () => {
    for (const w of waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new SmtpError("SMTP 连接已关闭"));
    }
  });
  socket.on("error", (err: Error) => {
    for (const w of waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  });

  /** 找一段"以状态行结尾"的响应（marker 只需是任意非空串，语义由调用方判断） */
  function findEnd(text: string): number {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3}(?: |$)/.test(lines[i] as string)) return i;
    }
    return -1;
  }

  function flush(): void {
    while (waiters.length) {
      const w = waiters[0] as Waiter;
      const end = findEnd(buffer);
      if (end < 0) return;
      const lines = buffer.split(/\r?\n/);
      const consumed = lines.slice(0, end + 1).join("\r\n");
      buffer = lines.slice(end + 1).join("\r\n");
      waiters.shift();
      clearTimeout(w.timer);
      w.resolve(consumed);
    }
  }

  return {
    read(timeout = timeoutMs): Promise<string> {
      const end = findEnd(buffer);
      if (end >= 0) {
        const lines = buffer.split(/\r?\n/);
        const consumed = lines.slice(0, end + 1).join("\r\n");
        buffer = lines.slice(end + 1).join("\r\n");
        return Promise.resolve(consumed);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex((x) => x.timer === timer);
          if (i >= 0) waiters.splice(i, 1);
          reject(new SmtpError(`SMTP 响应超时（${timeout}ms）`));
        }, timeout);
        waiters.push({ marker: "line", resolve, reject, timer });
      });
    },
  };
}

function connect({ host, port, secure, timeoutMs }: { host: string; port: number; secure: boolean; timeoutMs: number }): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SmtpError(`SMTP 连接超时：${host}:${port}`));
    }, timeoutMs);
    socket.once(secure ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      resolve(socket as unknown as Socket);
    });
    socket.once("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function upgradeToTls(socket: Socket, host: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername: host, rejectUnauthorized: false });
    const timer = setTimeout(() => {
      tlsSocket.destroy();
      reject(new SmtpError("STARTTLS 升级超时"));
    }, timeoutMs);
    tlsSocket.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(tlsSocket as unknown as Socket);
    });
    tlsSocket.once("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** 发送一封纯文本邮件 */
export async function sendMail(cfg: SmtpConfig, mail: MailInput): Promise<SendMailResult> {
  const timeoutMs = cfg.timeoutMs ?? 20000;
  const secure = cfg.secure !== false;
  let socket: Socket | undefined;
  try {
    socket = await connect({ host: cfg.host, port: cfg.port, secure, timeoutMs });
    let reader = createReader(socket, timeoutMs);
    const say = (line: string) => socket?.write(`${line}\r\n`);
    const expect = async (matcher: (code: number) => boolean, label: string): Promise<string> => {
      const res = await reader.read(timeoutMs);
      const code = Number(res.slice(0, 3));
      if (!matcher(code)) throw new SmtpError(`${label} 失败：${res.replace(/\r?\n/g, " | ")}`);
      return res;
    };

    await expect((c) => c === 220, "服务端问候");

    say("EHLO junwuyou.local");
    let caps = await reader.read(timeoutMs);
    if (Number(caps.slice(0, 3)) !== 250) throw new SmtpError(`EHLO 失败：${caps}`);

    // 明文 + STARTTLS（端口 587 的常见形态）。未声明 STARTTLS 时保持明文——
    // 真实邮箱都会声明；这也让"无 STARTTLS 的本地 stub / 内网中继"可用。
    if (!secure && /STARTTLS/i.test(caps)) {
      say("STARTTLS");
      await expect((c) => c === 220, "STARTTLS");
      socket = await upgradeToTls(socket, cfg.host, timeoutMs);
      reader = createReader(socket, timeoutMs);
      say("EHLO junwuyou.local");
      caps = await reader.read(timeoutMs);
      if (Number(caps.slice(0, 3)) !== 250) throw new SmtpError(`STARTTLS 后 EHLO 失败：${caps}`);
    }

    // AUTH LOGIN 最通用（QQ/163/企业邮箱都支持）；PLAIN 兜底
    if (/AUTH[^\n]*\bLOGIN\b/i.test(caps)) {
      say("AUTH LOGIN");
      await expect((c) => c === 334, "AUTH LOGIN");
      say(Buffer.from(cfg.user, "utf8").toString("base64"));
      await expect((c) => c === 334, "AUTH 用户名");
      say(Buffer.from(cfg.password, "utf8").toString("base64"));
      await expect((c) => c === 235, "AUTH 密码");
    } else if (/AUTH[^\n]*\bPLAIN\b/i.test(caps)) {
      say(`AUTH PLAIN ${Buffer.from(`\u0000${cfg.user}\u0000${cfg.password}`, "utf8").toString("base64")}`);
      await expect((c) => c === 235, "AUTH PLAIN");
    } else {
      throw new SmtpError("服务端未声明 AUTH LOGIN/PLAIN，无法认证");
    }

    say(`MAIL FROM:<${cfg.user}>`);
    await expect((c) => c === 250, "MAIL FROM");
    say(`RCPT TO:<${mail.to}>`);
    await expect((c) => c === 250 || c === 251, "RCPT TO");
    say("DATA");
    await expect((c) => c === 354, "DATA");
    socket.write(`${buildMessage(cfg, mail)}\r\n.\r\n`);
    await expect((c) => c === 250, "邮件投递");

    say("QUIT");
    socket.end();
    return { ok: true, messageId: mail.messageId };
  } catch (err) {
    try {
      socket?.destroy();
    } catch {
      /* ignore */
    }
    return { ok: false, messageId: mail.messageId, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 组装 RFC5322 报文；正文用 base64（中文最稳，不依赖服务端的 8BITMIME） */
export function buildMessage(cfg: SmtpConfig, mail: MailInput): string {
  const fromHeader = mail.fromName ? `${encodeHeaderValue(mail.fromName)} <${cfg.user}>` : cfg.user;
  const body = Buffer.from(String(mail.text ?? ""), "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
  const headers = [
    `From: ${fromHeader}`,
    `To: <${mail.to}>`,
    `Subject: ${encodeHeaderValue(mail.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${mail.messageId}`,
    mail.inReplyTo ? `In-Reply-To: ${mail.inReplyTo}` : null,
    mail.references && mail.references.length ? `References: ${mail.references.join(" ")}` : null,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "X-Mailer: junwuyou-cs/1.0",
  ].filter((h): h is string => !!h);
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

/** 头部值编码（纯 ASCII 原样；含中文用 RFC2047 编码字） */
function encodeHeaderValue(value: string): string {
  const s = String(value ?? "");
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}
