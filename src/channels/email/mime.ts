/**
 * 邮件 MIME 解析（P0.6 邮件渠道；纯函数，便于单测）
 *
 * 为什么自己写而不是引入依赖：本机外网 npm 受限（L-019/L-051 同族），
 * 且邮件渠道只需处理"客户来信"这一类：文本正文 + 常见编码 + 主题线程。
 * 拆成纯函数是为了**可断言**——编码/线程这些坑不靠"看起来对"来保证。
 *
 * 覆盖的真实情形（都会出现在中文客户邮件里）：
 *   - 主题/发件人名用 RFC2047 编码字（`=?UTF-8?B?...?=` / `=?GBK?Q?...?=`）
 *   - 正文 quoted-printable（中文按字节软换行 `=` 断行）
 *   - 正文 base64
 *   - multipart/alternative（取 text/plain；没有纯文本才退回 html 剥标签）
 *   - charset 为 GBK/GB2312（老客户端）
 */

import iconv from "iconv-lite";

export interface Address {
  address: string;
  name: string;
}

export interface ParsedEmail {
  headers: Map<string, string>;
  from: Address;
  to: string[];
  subject: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  text: string;
  date: string | null;
  autoSubmitted: boolean;
}

/** 按 charset 解码字节（未知 charset 退回 utf-8，并保留可读性） */
export function decodeBytes(buf: Buffer | Uint8Array, charset?: string): string {
  const cs = String(charset || "utf-8").trim().toLowerCase().replace(/^["']|["']$/g, "");
  const aliases: Record<string, string> = {
    utf8: "utf-8",
    gb2312: "gbk",
    gb_2312: "gbk",
    cp936: "gbk",
    ansi: "gbk",
    latin1: "iso-8859-1",
    "us-ascii": "iso-8859-1",
  };
  const target = aliases[cs] ?? cs;
  try {
    if (iconv.encodingExists(target)) return iconv.decode(Buffer.from(buf), target);
  } catch {
    /* 落到 utf-8 */
  }
  return Buffer.from(buf).toString("utf8");
}

/** `=XX` 字节还原（Q 编码与正文共用）；underscoreIsSpace 仅 RFC2047 的 Q 编码为真 */
function decodeQpBytes(text: string, charset: string, underscoreIsSpace: boolean): string {
  let cleaned = String(text ?? "").replace(/=\r?\n/g, ""); // 软换行
  if (underscoreIsSpace) cleaned = cleaned.replace(/_/g, " ");
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i] as string;
    const pair = cleaned.slice(i + 1, i + 3);
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(pair)) {
      bytes.push(parseInt(pair, 16));
      i += 2;
    } else {
      for (const b of Buffer.from(c, "utf8")) bytes.push(b);
    }
  }
  return decodeBytes(Buffer.from(bytes), charset);
}

/** RFC2047 Q 编码解码（`_` = 空格） */
export function decodeQuotedPrintable(text: string, charset = "utf-8"): string {
  return decodeQpBytes(text, charset, true);
}

/** 正文 quoted-printable 解码（`_` **不**当空格——那是 RFC2047 的规则，不是正文的） */
export function decodeBodyQuotedPrintable(text: string, charset = "utf-8"): string {
  return decodeQpBytes(text, charset, false);
}

/** 解码一个 RFC2047 编码字（也接受多段拼接：`=?a?B?x?= =?b?B?y?=`） */
export function decodeMimeWord(word: string): string {
  return String(word ?? "").replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, enc: string, data: string) => {
    if (enc.toUpperCase() === "B") {
      return decodeBytes(Buffer.from(data, "base64"), charset);
    }
    return decodeQuotedPrintable(data, charset);
  });
}

/** 解出头部的一个"折叠"后续行（RFC5322 允许多行续行） */
export function unfoldHeaderBlock(raw: string): string {
  return String(raw ?? "").replace(/\r?\n[ \t]+/g, " ");
}

/** 解析头部为 Map（key 小写；重复头保留**第一条**，线程头需要第一条） */
export function parseHeaders(headerText: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of unfoldHeaderBlock(headerText).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (!out.has(k)) out.set(k, v);
  }
  return out;
}

export interface ContentTypeInfo {
  type: string;
  charset: string;
  boundary: string;
}

/** 从 Content-Type 头解出 `{type, charset, boundary}` */
export function parseContentType(value?: string): ContentTypeInfo {
  const raw = String(value ?? "");
  const typePart = raw.split(";")[0] ?? "";
  const param = (name: string): string => {
    const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, "i").exec(raw);
    if (!m) return "";
    return String(m[1] ?? m[2] ?? "").trim();
  };
  return {
    type: (typePart || "text/plain").trim().toLowerCase(),
    charset: param("charset") || "utf-8",
    boundary: param("boundary"),
  };
}

/** 按 boundary 切分子部分（返回原始块数组，不递归） */
export function splitParts(body: string, boundary: string): string[] {
  if (!boundary) return [];
  const delim = `--${boundary}`;
  const end = `--${boundary}--`;
  let rest = String(body ?? "");
  const endIdx = rest.indexOf(end);
  if (endIdx >= 0) rest = rest.slice(0, endIdx);
  const chunks = rest.split(delim);
  const parts: string[] = [];
  for (const c of chunks.slice(1)) {
    parts.push(c.replace(/^\r?\n/, ""));
  }
  return parts;
}

/** HTML → 纯文本（邮件渠道只发/收纯文本，HTML 仅作最后兜底） */
export function htmlToText(html: string): string {
  return String(html ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 解析 `名字 <addr@host>` / `<addr@host>` / `addr@host` */
export function parseAddress(value: string): Address {
  const raw = decodeMimeWord(String(value ?? "")).trim();
  const m = /<([^>]+)>/.exec(raw);
  const address = (m?.[1] ?? raw).trim().toLowerCase();
  const name = m ? raw.slice(0, m.index).replace(/^"|"$/g, "").trim() : "";
  return { address, name };
}

export interface ExtractedText {
  text: string;
  kind: "plain" | "html" | "none";
}

/** 递归取正文文本：优先 text/plain，其次 text/html（剥标签） */
export function extractText(headers: Map<string, string>, body: string): ExtractedText {
  const ct = parseContentType(headers.get("content-type"));
  const enc = (headers.get("content-transfer-encoding") ?? "7bit").trim().toLowerCase();

  if (ct.type.startsWith("multipart/")) {
    const parts = splitParts(body, ct.boundary);
    let htmlFallback: ExtractedText | null = null;
    for (const p of parts) {
      const sep = p.search(/\r?\n\r?\n/);
      const ph = parseHeaders(sep >= 0 ? p.slice(0, sep) : p);
      const pb = sep >= 0 ? p.slice(sep).replace(/^\r?\n\r?\n/, "") : "";
      const sub = extractText(ph, pb);
      if (sub.kind === "plain" && sub.text.trim()) return sub;
      if (sub.kind === "html" && !htmlFallback) htmlFallback = sub;
    }
    if (htmlFallback) return htmlFallback;
    return { text: "", kind: "none" };
  }

  let decoded: string;
  if (enc === "base64") decoded = decodeBytes(Buffer.from(body.replace(/\s+/g, ""), "base64"), ct.charset);
  else if (enc === "quoted-printable") decoded = decodeBodyQuotedPrintable(body, ct.charset);
  else decoded = decodeBytes(Buffer.from(body, "utf8"), ct.charset);

  if (ct.type === "text/html") return { text: htmlToText(decoded), kind: "html" };
  return { text: decoded.trim(), kind: "plain" };
}

/**
 * 解析一封完整邮件（`BODY.PEEK[]` 返回的原始报文）
 */
export function parseEmail(rawText: string): ParsedEmail {
  const raw = String(rawText ?? "");
  const sepIdx = raw.search(/\r?\n\r?\n/);
  const headerText = sepIdx >= 0 ? raw.slice(0, sepIdx) : raw;
  const body = sepIdx >= 0 ? raw.slice(sepIdx).replace(/^\r?\n\r?\n/, "") : "";
  const h = parseHeaders(headerText);

  const from = parseAddress(h.get("from") ?? "");
  const toList = (h.get("to") ?? "")
    .split(",")
    .map((s) => parseAddress(s).address)
    .filter(Boolean);

  const extracted = extractText(h, body);
  const refs = decodeMimeWord(h.get("references") ?? "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    headers: h,
    from,
    to: toList,
    subject: decodeMimeWord(h.get("subject") ?? "").trim(),
    messageId: (h.get("message-id") ?? "").trim() || null,
    inReplyTo: (h.get("in-reply-to") ?? "").trim() || null,
    references: refs,
    text: extracted.text,
    date: h.get("date") ?? null,
    autoSubmitted:
      /auto-(replied|generated)/i.test(h.get("auto-submitted") ?? "") ||
      /bulk|junk|list/i.test(h.get("precedence") ?? ""),
  };
}

// ---------------------------------------------------------------- 出站（构造邮件）

/** RFC2047 编码（中文必需；纯 ASCII 原样返回，可读性与兼容性更好） */
export function encodeMimeWord(text: string, charset = "utf-8"): string {
  const s = String(text ?? "");
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?${charset}?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

/** "Re: 主题"（避免 `Re: Re: Re:` 无限叠加；已含 Re:/回复: 前缀则不再加） */
export function replySubject(subject: string): string {
  const s = String(subject ?? "").trim();
  if (!s) return "Re: （无主题）";
  if (/^(re|回复|答复|回覆)\s*[:：]/i.test(s)) return s;
  return `Re: ${s}`;
}

/** References/In-Reply-To 累积（保持主题线程） */
export function buildThreadHeaders(parsed: {
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
}): { inReplyTo: string | null; references: string[] } {
  const refs = [...(parsed.references ?? [])];
  if (parsed.messageId && !refs.includes(parsed.messageId)) refs.push(parsed.messageId);
  return {
    inReplyTo: parsed.messageId ?? parsed.inReplyTo ?? null,
    references: refs.slice(-10),
  };
}

/** 生成 Message-ID（发信方自己生成，便于二次回复时引用） */
export function makeMessageId(fromAddress: string, domain = "junwuyou.local"): string {
  const addr = String(fromAddress || "");
  const local = addr.split("@")[0]?.replace(/[^\w.-]/g, "") || "cs";
  const host = addr.includes("@") ? String(addr.split("@")[1]) : domain;
  const rnd = Math.random().toString(36).slice(2, 12);
  return `<${local}.${Date.now().toString(36)}.${rnd}@${host}>`;
}
