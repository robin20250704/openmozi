/**
 * 邮件 MIME 解析单测（P0.6 邮件渠道）
 *
 * 为什么要写：邮件是"客户进来的第一句话"，解析错 = 答非所问或乱码，而这类缺陷
 * 在 IM 侧断言里完全看不见（渠道不同）。用例取真实客户端形态：
 * RFC2047 编码主题（UTF-8/GBK）、quoted-printable 中文软换行、base64 正文、multipart/alternative。
 */

import { describe, it, expect } from "vitest";
import {
  parseEmail,
  parseAddress,
  decodeQuotedPrintable,
  decodeMimeWord,
  replySubject,
  buildThreadHeaders,
  htmlToText,
  parseContentType,
  splitParts,
} from "../src/channels/email/mime.js";
import { buildMessage } from "../src/channels/email/smtp.js";

describe("邮件解析：主题与编码（A28e）", () => {
  it("RFC2047 base64 中文主题不乱码", () => {
    const subject = "=?UTF-8?B?" + Buffer.from("咨询白蚁防治报价", "utf8").toString("base64") + "?=";
    const raw = [
      "From: =?UTF-8?B?" + Buffer.from("张先生", "utf8").toString("base64") + "?= <zhang@example.com>",
      `Subject: ${subject}`,
      "To: cs@junwuyou.com",
      "Message-ID: <abc@example.com>",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "家里有白蚁，麻烦报价",
    ].join("\r\n");
    const parsed = parseEmail(raw);
    expect(parsed.subject).toBe("咨询白蚁防治报价");
    expect(parsed.from.address).toBe("zhang@example.com");
    expect(parsed.from.name).toBe("张先生");
    expect(parsed.text).toBe("家里有白蚁，麻烦报价");
    expect(parsed.messageId).toBe("<abc@example.com>");
  });

  it("RFC2047 Q 编码 + GBK 主题可解", () => {
    // 用真实 GBK 字节构造（「报价」GBK = B1A8 BCDB），避免手抄出错
    const gbk = Buffer.from(require("iconv-lite").encode("报价", "gbk"));
    const q = `=?GBK?Q?${[...gbk].map((b) => "=" + b.toString(16).toUpperCase().padStart(2, "0")).join("")}?=`;
    expect(decodeMimeWord(q)).toBe("报价");
    expect(decodeMimeWord("=?GBK?Q?=B1=A8=BC=DB?=")).toBe("报价");
  });

  it("多段编码字拼接", () => {
    const a = "=?UTF-8?B?" + Buffer.from("你好", "utf8").toString("base64") + "?=";
    const b = "=?UTF-8?B?" + Buffer.from("世界", "utf8").toString("base64") + "?=";
    expect(decodeMimeWord(`${a} ${b}`)).toBe("你好 世界");
  });

  it("quoted-printable 中文按字节还原（含软换行）", () => {
    // 用**真实字节**构造 QP（而不是手抄十六进制——手抄错一个字节，
    // 断言就会去迁就错数据，而解析器其实是好的；本用例第一版正是踩了这个坑：L-052 同族）
    const toQp = (s: string) =>
      [...Buffer.from(s, "utf8")].map((b) => "=" + b.toString(16).toUpperCase().padStart(2, "0")).join("");
    const full = toQp("蟑螂防治");
    const softWrapped = full.slice(0, 18) + "=\r\n" + full.slice(18);
    expect(decodeQuotedPrintable("=E8=9F=91=E8=9E=82=E9=98=B2=E6=B2=BB", "utf-8")).toBe("蟑螂防治");
    expect(decodeQuotedPrintable(softWrapped, "utf-8")).toBe("蟑螂防治");
  });

  it("正文 quoted-printable 不把下划线当空格（与 RFC2047 区分）", () => {
    const raw = [
      "From: a@b.com",
      "Subject: test",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "order_id_123 =E5=B7=B2=E6=94=B6=E5=88=B0", // "已收到"
    ].join("\r\n");
    expect(parseEmail(raw).text).toBe("order_id_123 已收到");
  });
});

describe("邮件解析：正文结构", () => {
  it("multipart/alternative 取 text/plain（不剥 HTML 标签）", () => {
    const raw = [
      "From: a@b.com",
      "Subject: hi",
      'Content-Type: multipart/alternative; boundary="BOUND"',
      "",
      "--BOUND",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "纯文本正文",
      "--BOUND",
      "Content-Type: text/html; charset=UTF-8",
      "",
      "<p>HTML 正文</p>",
      "--BOUND--",
    ].join("\r\n");
    expect(parseEmail(raw).text).toBe("纯文本正文");
  });

  it("只有 HTML 时剥标签兜底", () => {
    const raw = [
      "From: a@b.com",
      "Subject: hi",
      "Content-Type: text/html; charset=UTF-8",
      "",
      "<div>需要<b>消杀</b>服务<br>谢谢</div>",
    ].join("\r\n");
    expect(parseEmail(raw).text).toBe("需要消杀服务\n谢谢");
  });

  it("base64 正文可解（含中文）", () => {
    const body = Buffer.from("请问能上门吗", "utf8").toString("base64");
    const raw = [
      "From: a@b.com",
      "Subject: hi",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      body,
    ].join("\r\n");
    expect(parseEmail(raw).text).toBe("请问能上门吗");
  });

  it("自动回复头被识别（防回环用）", () => {
    const raw = [
      "From: a@b.com",
      "Subject: 自动回复",
      "Auto-Submitted: auto-replied",
      "Content-Type: text/plain",
      "",
      "thanks",
    ].join("\r\n");
    expect(parseEmail(raw).autoSubmitted).toBe(true);
  });

  it("References 多值解析（主题线程）", () => {
    const raw = [
      "From: a@b.com",
      "Subject: Re: hi",
      "Message-ID: <m3@x>",
      "In-Reply-To: <m2@x>",
      "References: <m1@x>\r\n <m2@x>",
      "Content-Type: text/plain",
      "",
      "body",
    ].join("\r\n");
    const p = parseEmail(raw);
    expect(p.references).toEqual(["<m1@x>", "<m2@x>"]);
    expect(p.inReplyTo).toBe("<m2@x>");
  });

  it("工具函数：地址/主题/线程/HTML/Content-Type/切块", () => {
    expect(parseAddress("张三 <A@B.com>")).toEqual({ address: "a@b.com", name: "张三" });
    expect(parseAddress("<a@b.com>")).toEqual({ address: "a@b.com", name: "" });
    expect(replySubject("报价咨询")).toBe("Re: 报价咨询");
    expect(replySubject("Re: 报价咨询")).toBe("Re: 报价咨询");
    expect(replySubject("回复：报价")).toBe("回复：报价");
    expect(buildThreadHeaders({ messageId: "<m2@x>", references: ["<m1@x>"] })).toEqual({
      inReplyTo: "<m2@x>",
      references: ["<m1@x>", "<m2@x>"],
    });
    expect(htmlToText("<p>a</p><br>b")).toBe("a\n\nb");
    expect(parseContentType('text/plain; charset="GBK"; boundary=x')).toEqual({
      type: "text/plain",
      charset: "GBK",
      boundary: "x",
    });
    expect(splitParts("--X\r\na\r\n--X\r\nb\r\n--X--", "X")).toEqual(["a\r\n", "b\r\n"]);
  });
});

describe("出站报文构造（A28b/A28g）", () => {
  it("中文主题编码、正文 base64、线程头齐备", () => {
    const msg = buildMessage(
      { host: "smtp.qq.com", port: 465, user: "cs@junwuyou.com", password: "x" },
      {
        to: "zhang@example.com",
        subject: "Re: 咨询白蚁防治报价",
        text: "您好，\n白蚁防治报价已为您整理。",
        messageId: "<out1@junwuyou.com>",
        fromName: "君无忧客服",
        inReplyTo: "<in1@example.com>",
        references: ["<in1@example.com>"],
      }
    );
    expect(msg).toContain("Subject: =?UTF-8?B?");
    expect(msg).toContain("In-Reply-To: <in1@example.com>");
    expect(msg).toContain("References: <in1@example.com>");
    expect(msg).toContain("Content-Type: text/plain");
    // 正文 base64 解码后应是原文（不泄漏 markdown 语法由出站边界负责）
    const body = msg.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("您好，\n白蚁防治报价已为您整理。");
    // 多行正文每行折到 76 列以内（SMTP 行长度限制）
    for (const line of msg.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
  });
});
