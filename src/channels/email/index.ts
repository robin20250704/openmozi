/**
 * 邮件渠道（P0.6 / D-17/D-21/D-33）
 *
 * OpenMozi 5 个渠道里"需自研"的一个：IMAP 轮询收信 + SMTP 回信。
 *
 * 与 IM 渠道的三个本质差异（决定了本文件不是照抄 qq/wecom 的写法）：
 *  1. **主题线程**：回复必须挂在同一主题上（`Re:` + In-Reply-To/References），
 *     否则客户邮箱里会散成互不相关的邮件；
 *  2. **独立 SLA**：客户对邮件的响应预期是小时/天级，不是 IM 的分钟级——
 *     用 EMAIL_SLA_MINUTES 单列，不得沿用 IM 的 SLA 口径；
 *  3. **正式语气**：邮件里"哈哈～"不合适；渠道维度切换提示词尾部后缀。
 *
 * 安全性/正确性要点：
 *  - **先处理、后标已读**（标 \Seen 前必须确认本轮已交给 agent）——否则出错即丢客户来信；
 *  - **幂等**：以 Message-ID 去重（内存 + 可选持久化），标 \Seen 只是第二道保险；
 *  - **防自回环**：忽略自己发件地址、自动回复头（Auto-Submitted / Precedence: bulk）；
 *  - 轮询失败不抛出（打日志后下轮重试），**绝不因为收信失败而让进程退出**。
 */

import type { InboundMessageContext, SendResult, OutboundMessage, EmailConfig, ChannelMeta } from "../../types/index.js";
import { BaseChannelAdapter } from "../common/base.js";
import { fetchUnseen, markSeen } from "./imap.js";
import { sendMail } from "./smtp.js";
import { parseEmail, buildThreadHeaders, replySubject, makeMessageId } from "./mime.js";

/** 邮件渠道的独立 SLA（分钟）：客户对邮件的预期是小时级，与 IM 的分钟级口径不同（D-17） */
export const DEFAULT_EMAIL_SLA_MINUTES = 240;

/**
 * 交给 agent 的对话内容：带主题。
 * 邮件正文常常只有一句"请问这个多少钱？"，**主题才是客户真正在说的事**
 * （客户写"咨询白蚁防治报价" + 正文"家里刚发现，麻烦看下"）——不带主题 agent 会答非所问。
 */
export function buildAgentContent(subject: string, text: string): string {
  const s = String(subject ?? "").trim();
  const t = String(text ?? "").trim();
  if (s && t) return `【邮件主题】${s}\n\n${t}`;
  if (t) return t;
  if (s) return `【邮件主题】${s}\n\n（正文为空）`;
  return "(空邮件)";
}

interface ThreadInfo {
  subject: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
}

export class EmailChannel extends BaseChannelAdapter {
  id = "email" as const;
  meta: ChannelMeta = {
    id: "email",
    name: "邮件",
    description: "IMAP 轮询收信 + SMTP 回信；主题线程、正式语气、独立 SLA（P0.6 自研渠道）",
    capabilities: {
      chatTypes: ["direct"],
      supportsMedia: false,
      supportsReply: true,
      supportsMention: false,
      supportsReaction: false,
      supportsThread: true,
      supportsEdit: false,
      maxMessageLength: 30000,
    },
  };

  private config: EmailConfig;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  /** Message-ID 去重（幂等第一道保险） */
  private seenIds = new Set<string>();
  /** 发件人邮箱 → 主题线程（回信时用；进程内缓存，重启后退化为不引用 References 但仍带 Re:） */
  private threads = new Map<string, ThreadInfo>();
  private pollCount = 0;

  constructor(config: EmailConfig) {
    super();
    this.config = config;
  }

  get slaMinutes(): number {
    return this.config.slaMinutes ?? DEFAULT_EMAIL_SLA_MINUTES;
  }

  /** 启动轮询（initialize 只做一次，失败不阻塞进程启动） */
  async initialize(): Promise<void> {
    if (!this.config.imapHost || !this.config.imapUser || !this.config.imapPassword) {
      this.logger.warn("邮件渠道缺少 IMAP 配置（host/user/password），通道已注册但不会收信");
      return;
    }
    const intervalSec = this.config.pollIntervalSec ?? 30;
    this.logger.info(
      { host: this.config.imapHost, port: this.config.imapPort, intervalSec, slaMinutes: this.slaMinutes },
      "邮件渠道启动（IMAP 轮询）"
    );
    // 立即跑一轮，之后按间隔轮询（setTimeout 链而非 setInterval：避免上一轮没跑完就叠加）
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    if (this.stopped) return;
    await this.pollOnce();
    if (this.stopped) return;
    const intervalSec = this.config.pollIntervalSec ?? 30;
    this.timer = setTimeout(() => void this.pollLoop(), Math.max(5, intervalSec) * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  /** 拉一轮未读邮件（可被 harness 直接调用，不必等轮询周期） */
  async pollOnce(): Promise<{ fetched: number; handled: number; skipped: number }> {
    if (this.running) return { fetched: 0, handled: 0, skipped: 0 };
    this.running = true;
    let fetched = 0;
    let handled = 0;
    let skipped = 0;
    try {
      const mails = await fetchUnseen({
        host: this.config.imapHost,
        port: this.config.imapPort,
        user: this.config.imapUser,
        password: this.config.imapPassword,
        secure: this.config.imapSecure !== false,
        sinceIso: this.config.sinceIso,
      });
      fetched = mails.length;
      const toMark: number[] = [];
      for (const m of mails) {
        const parsed = parseEmail(m.raw);
        if (this.shouldIgnore(parsed)) {
          skipped++;
          toMark.push(m.uid); // 忽略的邮件也要标已读，否则每轮都重复拉
          continue;
        }
        const key = parsed.messageId || `uid:${m.uid}`;
        if (this.seenIds.has(key)) {
          skipped++;
          toMark.push(m.uid);
          continue;
        }
        this.seenIds.add(key);
        this.threads.set(parsed.from.address, {
          subject: parsed.subject,
          messageId: parsed.messageId,
          inReplyTo: parsed.inReplyTo,
          references: parsed.references,
        });
        const context: InboundMessageContext = {
          channelId: "email",
          // 邮件的"身份"就是发件地址（C-041：邮箱是连接键，可自动关联到同一客户）
          senderId: parsed.from.address,
          chatId: parsed.from.address,
          senderName: parsed.from.name || undefined,
          messageId: key,
          chatType: "direct",
          // 主题要带进对话内容：邮件正文常常只有一句"请问这个多少钱？"，
          // 主题才是客户真正在说的事；不带主题 agent 会答非所问。
          content: buildAgentContent(parsed.subject, parsed.text),
          timestamp: parsed.date ? Date.parse(parsed.date) || Date.now() : Date.now(),
          replyToId: parsed.messageId || undefined,
          raw: {
            subject: parsed.subject,
            messageId: parsed.messageId,
            references: parsed.references,
            uid: m.uid,
            from: parsed.from.address,
            slaMinutes: this.slaMinutes,
          },
        };
        try {
          await this.handleInboundMessage(context);
          handled++;
          toMark.push(m.uid); // ✅ 交给 agent 之后才标已读（先处理、后标记）
        } catch (err) {
          // 处理失败：**不标已读**，下一轮重试（宁重复处理，也不丢客户来信）
          this.logger.error({ error: (err as Error).message, from: parsed.from.address }, "邮件处理失败，保留未读以便重试");
          this.seenIds.delete(key);
        }
      }
      if (toMark.length) {
        await markSeen(
          {
            host: this.config.imapHost,
            port: this.config.imapPort,
            user: this.config.imapUser,
            password: this.config.imapPassword,
            secure: this.config.imapSecure !== false,
          },
          toMark
        );
      }
      this.pollCount++;
    } catch (err) {
      // 收信失败不抛出：下轮重试（通道不许把网关拖挂）
      this.logger.warn({ error: (err as Error).message }, "IMAP 轮询失败，将在下个周期重试");
    } finally {
      this.running = false;
    }
    return { fetched, handled, skipped };
  }

  /** 是否忽略这封信（自身地址 / 自动回复 / 非允许域） */
  private shouldIgnore(parsed: ReturnType<typeof parseEmail>): boolean {
    const from = parsed.from.address;
    if (!from) return true;
    if (from.toLowerCase() === String(this.config.smtpUser || "").toLowerCase()) return true;
    if (parsed.autoSubmitted) return true;
    const allow = this.config.allowedSenderDomains;
    if (allow && allow.length) {
      const domain = from.split("@")[1] || "";
      if (!allow.some((d) => domain.toLowerCase() === String(d).toLowerCase())) return true;
    }
    return false;
  }

  /** 出站：回信（同主题线程） */
  async sendMessage(message: OutboundMessage): Promise<SendResult> {
    const to = String(message.chatId || "").trim();
    if (!to) return { success: false, error: "缺少收件地址" };
    const thread = this.threads.get(to);
    const subject = replySubject(thread?.subject ?? "");
    const threadHeaders = buildThreadHeaders(
      thread
        ? { messageId: thread.messageId, inReplyTo: thread.inReplyTo, references: thread.references }
        : { references: [] }
    );
    const messageId = makeMessageId(this.config.smtpUser);
    const result = await sendMail(
      {
        host: this.config.smtpHost,
        port: this.config.smtpPort,
        secure: this.config.smtpSecure !== false,
        user: this.config.smtpUser,
        password: this.config.smtpPassword,
      },
      {
        fromName: this.config.fromName || "君无忧客服",
        to,
        subject,
        text: message.content,
        messageId,
        inReplyTo: threadHeaders.inReplyTo,
        references: threadHeaders.references,
      }
    );
    if (result.ok) {
      // 记下自己发出的 Message-ID：客户直接回复它时，线程还能接上
      this.threads.set(to, {
        subject,
        messageId,
        inReplyTo: thread?.messageId ?? null,
        references: threadHeaders.references,
      });
      return { success: true, messageId };
    }
    return { success: false, error: result.error };
  }

  async sendText(chatId: string, text: string): Promise<SendResult> {
    return this.sendMessage({ chatId, content: text });
  }

  /** 回信默认走主题线程（replyToContext 的标准形态） */
  async replyToContext(context: InboundMessageContext, text: string): Promise<SendResult> {
    const raw = (context.raw || {}) as Record<string, unknown>;
    const to = context.senderId || context.chatId;
    const subject = replySubject(String(raw.subject ?? ""));
    const threadHeaders = buildThreadHeaders({
      messageId: (raw.messageId as string) ?? null,
      inReplyTo: null,
      references: (raw.references as string[]) ?? [],
    });
    const messageId = makeMessageId(this.config.smtpUser);
    const result = await sendMail(
      {
        host: this.config.smtpHost,
        port: this.config.smtpPort,
        secure: this.config.smtpSecure !== false,
        user: this.config.smtpUser,
        password: this.config.smtpPassword,
      },
      {
        fromName: this.config.fromName || "君无忧客服",
        to,
        subject,
        text,
        messageId,
        inReplyTo: threadHeaders.inReplyTo,
        references: threadHeaders.references,
      }
    );
    if (result.ok) {
      this.threads.set(to, {
        subject,
        messageId,
        inReplyTo: (raw.messageId as string) ?? null,
        references: threadHeaders.references,
      });
      return { success: true, messageId };
    }
    return { success: false, error: result.error };
  }

  async isHealthy(): Promise<boolean> {
    // 健康判据：配置齐全 + 最近一次轮询没有连续失败（这里只验配置与"是否在跑"）
    const configured = !!(this.config.imapHost && this.config.imapUser && this.config.imapPassword);
    return configured && !this.stopped;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 供 harness/诊断读取（不动行为） */
  stats(): { polls: number; seenIds: number; threads: number } {
    return { polls: this.pollCount, seenIds: this.seenIds.size, threads: this.threads.size };
  }
}

export function createEmailChannel(config: EmailConfig): EmailChannel {
  return new EmailChannel(config);
}
