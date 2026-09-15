/**
 * 最小 IMAP 客户端（P0.6 邮件渠道入站）
 *
 * 只做"客户来信"这一条路径，够用且可断言：
 *   LOGIN → SELECT INBOX → UID SEARCH UNSEEN SINCE <date> → 逐封 UID FETCH BODY.PEEK[] → 读完标 \Seen
 *
 * 关键设计（都是踩过的坑的同族）：
 *   - **幂等**：以 `Message-ID` 为去重键（调用方持有），`\Seen` 只是第二道保险；
 *   - **先处理、后标记**：标 \Seen 之前必须确认本轮已交给 agent ——
 *     标了已读但处理失败 = 客户来信永久丢失；
 *   - **BODY.PEEK[]** 而非 BODY[]：避免服务端"拉取即已读"；
 *   - 只查 UNSEEN，不扫整个收件箱。
 */

import net from "node:net";
import tls from "node:tls";
import type { Socket } from "node:net";

export class ImapError extends Error {}

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** 隐式 TLS（993，QQ/163 等常用）；false = 明文。默认 true */
  secure?: boolean;
  timeoutMs?: number;
  /** 只处理该时间之后到达的邮件（避免首次启动把整个收件箱当新消息） */
  sinceIso?: string;
  maxMessages?: number;
}

export interface FetchedMail {
  uid: number;
  raw: string;
}

interface Waiter {
  marker: string;
  ready?: (buffer: string) => number;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

function createReader(socket: Socket, timeoutMs: number) {
  let buffer = "";
  const waiters: Waiter[] = [];
  let closed = false;
  socket.setEncoding("utf8");

  /** 找第一个满足 ready 的位置（默认：marker 本身）——**必须整段 buffer 判定**，
   *  否则"命令回显 A001 …"会被当成响应行而提前消费（见 waitFor 的注释）。 */
  const locate = (w: Waiter): number => {
    if (w.ready) return w.ready(buffer);
    return buffer.indexOf(w.marker);
  };

  const flush = (): void => {
    while (waiters.length) {
      const w = waiters[0] as Waiter;
      const end = locate(w);
      if (end < 0) return;
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end);
      waiters.shift();
      clearTimeout(w.timer);
      w.resolve(chunk);
    }
  };
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    flush();
  });
  socket.on("close", () => {
    closed = true;
    for (const w of waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new ImapError("IMAP 连接已关闭"));
    }
  });
  socket.on("error", (err: Error) => {
    for (const w of waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  });

  return {
    /**
     * 等到"一段完整响应"出现并返回它。
     *
     * `ready(buffer)` 返回**消费终点**（-1 = 还没到）。为什么要用整段 buffer 判定：
     * 客户端发的是 `A001 LOGIN "u" "p"`，而响应是 `A001 OK ...`——两者前缀相同。
     * 若只匹配 `A001 ` 前缀，会把**命令回显**当成响应行提前截断：
     * 于是"命令成功"被判成失败，报错里还只有 `A001`（本轮实测踩到，排查被彻底带偏）。
     */
    waitFor(marker: string, timeout = timeoutMs, ready?: (buffer: string) => number): Promise<string> {
      const w: Waiter = {
        marker,
        ready,
        resolve: () => { /* 占位，下面覆盖 */ },
        reject: () => { /* 占位 */ },
        timer: setTimeout(() => { /* 占位 */ }, 0),
      };
      clearTimeout(w.timer);
      const end = locate(w);
      if (end >= 0) {
        const chunk = buffer.slice(0, end);
        buffer = buffer.slice(end);
        return Promise.resolve(chunk);
      }
      if (closed) return Promise.reject(new ImapError("IMAP 连接已关闭"));
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex((x) => x.timer === timer);
          if (i >= 0) waiters.splice(i, 1);
          reject(new ImapError(`IMAP 等待 ${marker} 超时（${timeout}ms）`));
        }, timeout);
        waiters.push({ marker, ready, resolve, reject, timer });
      });
    },
  };
}

/**
 * 标记响应行的消费终点：找到**行首** `TAG OK|NO|BAD` 并消费到该行末。
 * 返回 -1 表示整行还没到齐（不能提前消费）。
 */
function waitTagged(tag: string) {
  return (buffer: string): number => {
    const re = new RegExp(`(?:^|\\r?\\n)${tag} (?:OK|NO|BAD)`, "i");
    const m = re.exec(buffer);
    if (!m) return -1;
    const lineEnd = buffer.indexOf("\n", m.index + m[0].length);
    if (lineEnd < 0) return -1;
    return lineEnd + 1;
  };
}

function connect({ host, port, secure, timeoutMs }: { host: string; port: number; secure: boolean; timeoutMs: number }): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ImapError(`IMAP 连接超时：${host}:${port}`));
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

/** 从 FETCH 响应里按 literal 长度取出报文原文（`BODY[] {1234}\r\n<1234 字节>`） */
export function extractLiteral(chunk: string): string | null {
  const m = /BODY(?:\[[^\]]*\])?\s*\{(\d+)\}\r?\n/.exec(chunk);
  if (!m) return null;
  const start = m.index + m[0].length;
  return chunk.slice(start, start + Number(m[1]));
}

function quote(s: string): string {
  return `"${String(s ?? "").replace(/(["\\])/g, "\\$1")}"`;
}

/** 打开连接并登录（收信/标记共用） */
async function openSession(cfg: ImapConfig, tagPrefix: string) {
  const timeoutMs = cfg.timeoutMs ?? 25000;
  const socket = await connect({ host: cfg.host, port: cfg.port, secure: cfg.secure !== false, timeoutMs });
  const reader = createReader(socket, timeoutMs);
  let tag = 0;
  const send = async (command: string): Promise<{ tag: string; res: string }> => {
    tag += 1;
    const t = `${tagPrefix}${String(tag).padStart(3, "0")}`;
    socket.write(`${t} ${command}\r\n`);
    const res = await reader.waitFor(`${t} `, timeoutMs, waitTagged(t));
    if (!new RegExp(`${t} OK`, "i").test(res)) {
      const line = res.split(/\r?\n/).find((l) => l.startsWith(t)) ?? res.split(/\r?\n/).pop() ?? res;
      throw new ImapError(`IMAP 命令失败：${command} → ${line.trim()}`);
    }
    return { tag: t, res };
  };
  // 问候语（* OK / * PREAUTH）
  await reader.waitFor("* OK");
  await send(`LOGIN ${quote(cfg.user)} ${quote(cfg.password)}`);
  const sel = await send("SELECT INBOX");
  if (!/\[READ-WRITE\]|\bEXISTS\b/i.test(sel.res)) {
    throw new ImapError(`SELECT INBOX 异常：${sel.res.split(/\r?\n/)[0] ?? ""}`);
  }
  return { socket, reader, send };
}

/** 拉取未读邮件（返回原始报文，解析交给 mime.ts） */
export async function fetchUnseen(cfg: ImapConfig): Promise<FetchedMail[]> {
  const timeoutMs = cfg.timeoutMs ?? 25000;
  const maxMessages = cfg.maxMessages ?? 10;
  let socket: Socket | undefined;
  try {
    const session = await openSession(cfg, "A");
    socket = session.socket;
    const since = cfg.sinceIso ? new Date(cfg.sinceIso) : null;
    const sinceStr = since
      ? since.toUTCString().replace(/^\w+, /, "").replace(/ \d{2}:\d{2}:\d{2}/, "")
      : null;
    const search = await session.send(`UID SEARCH UNSEEN${sinceStr ? ` SINCE ${sinceStr}` : ""}`);
    const uids = (/(?:^|\r?\n)\* SEARCH ?([^\r\n]*)/i.exec(search.res)?.[1] ?? "")
      .trim()
      .split(/\s+/)
      .filter((s) => /^\d+$/.test(s))
      .map(Number)
      .slice(0, maxMessages);

    const out: FetchedMail[] = [];
    let tag = 100;
    for (const uid of uids) {
      tag += 1;
      const t = `A${String(tag).padStart(3, "0")}`;
      session.socket.write(`${t} UID FETCH ${uid} (BODY.PEEK[])\r\n`);
      const res = await session.reader.waitFor(`${t} `, timeoutMs, waitTagged(t));
      const raw = extractLiteral(res);
      if (raw) out.push({ uid, raw });
    }
    session.socket.write("A999 LOGOUT\r\n");
    session.socket.end();
    return out;
  } catch (err) {
    try {
      socket?.destroy();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** 标记 UID 为已读（**处理成功之后**才调用：先处理、后标记，避免失败即丢信） */
export async function markSeen(cfg: ImapConfig, uids: number[]): Promise<boolean> {
  if (!uids.length) return true;
  let socket: Socket | undefined;
  try {
    const session = await openSession(cfg, "B");
    socket = session.socket;
    await session.send(`UID STORE ${uids.join(",")} +FLAGS (\\Seen)`);
    session.socket.write("B999 LOGOUT\r\n");
    session.socket.end();
    return true;
  } catch {
    return false;
  }
}
