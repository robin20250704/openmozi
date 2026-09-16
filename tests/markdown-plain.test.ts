/**
 * 渠道自适应渲染层测试（markdown-plain）
 *
 * 覆盖（D11）：
 *   - QQ/企微/钉钉/飞书：markdown 加粗 **X** → 【X】（纯文本渠道的中文强调习惯）
 *   - email：去 markdown 但强调不加【】（正式文体）
 *   - webchat：原样保留 markdown（前端渲染）
 *   - miniprogram：markdown → HTML 富文本（微信 <rich-text>）
 */

import { describe, it, expect } from "vitest";
import {
  formatForChannel,
  toPlainText,
  toRichTextHtml,
  profileFor,
  CHANNEL_TEXT_PROFILES,
} from "../src/channels/common/markdown-plain.js";

describe("markdown-plain 渲染层", () => {
  describe("toPlainText", () => {
    it("粗体 **X** → 【X】（默认 bracket）", () => {
      expect(toPlainText("报价 **189元** 无加收")).toBe("报价 【189元】 无加收");
    });

    it("粗体 __X__ → 【X】", () => {
      expect(toPlainText("共 __200元__")).toBe("共 【200元】");
    });

    it("emphasis=plain 时去掉 ** 不加【】（邮件正式文体）", () => {
      expect(toPlainText("报价 **189元**", { emphasis: "plain" })).toBe("报价 189元");
    });

    it("emphasis=keep 时去掉 ** 标记、保留内容不加【】", () => {
      // 注：keep 仅"不加【】"，仍去标记；webchat/miniprogram 走 markdown:true 原样透传，不经此路径
      expect(toPlainText("报价 **189元**", { emphasis: "keep" })).toBe("报价 189元");
    });

    it("斜体/删除线/行内代码只去标记不加【】", () => {
      expect(toPlainText("这是 *重点* 和 ~~旧价~~ 和 `code`")).toBe("这是 重点 和 旧价 和 code");
    });

    it("标题/引用/列表符号/分隔线清理", () => {
      const md = "# 标题\n> 引用\n- 第一项\n---";
      const out = toPlainText(md);
      expect(out).toContain("标题");
      expect(out).toContain("引用");
      expect(out).toContain("· 第一项");
      expect(out).not.toContain("#");
      expect(out).not.toContain(">");
      expect(out).not.toContain("---");
    });

    it("链接保留文字+链接", () => {
      expect(toPlainText("[加好友](https://bot.q.qq.com/s/xxx)")).toBe("加好友（https://bot.q.qq.com/s/xxx）");
    });
  });

  describe("formatForChannel 分渠道", () => {
    it("qq：**X** → 【X】", () => {
      expect(formatForChannel("qq", "报价 **189元**")).toBe("报价 【189元】");
    });

    it("wecom/dingtalk/feishu 同 qq（bracket）", () => {
      for (const ch of ["wecom", "dingtalk", "feishu"]) {
        expect(formatForChannel(ch, "**重点**")).toBe("【重点】");
      }
    });

    it("email：去 markdown、强调不加【】", () => {
      expect(formatForChannel("email", "报价 **189元**")).toBe("报价 189元");
    });

    it("webchat：原样保留 markdown", () => {
      expect(formatForChannel("webchat", "报价 **189元**")).toBe("报价 **189元**");
    });

    it("未知渠道按 default（安全侧：去 markdown + bracket）", () => {
      expect(formatForChannel("some_future_channel", "**重点**")).toBe("【重点】");
    });
  });

  describe("miniprogram 富文本（D10/D11）", () => {
    it("profile 登记为 html 渲染", () => {
      expect(profileFor("miniprogram").html).toBe(true);
    });

    it("粗体 → <strong>", () => {
      expect(toRichTextHtml("报价 **189元**")).toBe("报价 <strong>189元</strong>");
    });

    it("斜体/删除行/行内代码 → 对应 HTML 标签", () => {
      expect(toRichTextHtml("*重点*")).toBe("<em>重点</em>");
      expect(toRichTextHtml("~~旧~~")).toBe("<del>旧</del>");
      expect(toRichTextHtml("`x`")).toBe("<code>x</code>");
    });

    it("换行 → <br>", () => {
      expect(toRichTextHtml("第一行\n第二行")).toBe("第一行<br>第二行");
    });

    it("HTML 特殊字符转义防注入", () => {
      expect(toRichTextHtml("a<b & c")).toBe("a&lt;b &amp; c");
    });

    it("formatForChannel('miniprogram') 输出 HTML", () => {
      const out = formatForChannel("miniprogram", "报价 **189元**\n无加收");
      expect(out).toContain("<strong>189元</strong>");
      expect(out).toContain("<br>");
    });
  });

  describe("CHANNEL_TEXT_PROFILES 完整性", () => {
    it("default 存在且为安全侧（去 markdown）", () => {
      expect(CHANNEL_TEXT_PROFILES.default.markdown).toBe(false);
    });
  });
});
