/**
 * 渠道自适应文本渲染（需求 3：不同接入渠道用不同的强调方式）
 *
 * 为什么需要确定性渲染而不是只写提示词：
 *   提示词里已经写了「禁止 markdown 语法、不要加粗（**）」，但实测 QQ 对话里
 *   依旧出现 `**189元**`、`**今天（5/14）**` —— 提示词只能降低概率，不能保证。
 *   而这是**输出格式**问题，属于可计算层：在出站边界做一次确定性转换，
 *   无论模型怎么写，客户看到的都是该渠道能正确显示的格式。
 *
 * 分渠道策略：
 *   - 支持 markdown 的渠道（webchat 网页版，前端用 markdown 渲染）→ 原样透传；
 *   - 纯文本渠道（QQ / 企业微信 / 钉钉 / 飞书文本消息）→ 转成纯文本，
 *     强调用中文习惯的【】包裹（IM 里最醒目且不依赖渲染）。
 */
import type { ChannelId } from "../../types/index.js";

export interface TextProfile {
  /** 该渠道是否会把 markdown 渲染出来 */
  markdown: boolean;
  /** 强调标记的处理方式 */
  emphasis: "keep" | "bracket" | "plain";
  /**
   * 该渠道是否用富文本（HTML）渲染（如微信小程序 <rich-text> 组件吃 HTML）。
   * true 时 formatForChannel 输出 HTML，而不是纯文本。
   */
  html?: boolean;
}

/**
 * 各渠道的显示能力（新增渠道时在此登记，缺省按"不支持 markdown"处理，安全侧）。
 *
 * miniprogram（D10/D11）：未来小程序页迁到 openmozi pi 时用**富文本**渲染——
 * 微信 <rich-text> 组件接收 HTML，故把 markdown 转成 HTML（保留结构/强调），
 * 而不是像 QQ 那样降级成【】纯文本。
 */
export const CHANNEL_TEXT_PROFILES: Partial<Record<ChannelId, TextProfile>> & { default: TextProfile } = {
  webchat: { markdown: true, emphasis: "keep" },
  qq: { markdown: false, emphasis: "bracket" },
  wecom: { markdown: false, emphasis: "bracket" },
  dingtalk: { markdown: false, emphasis: "bracket" },
  feishu: { markdown: false, emphasis: "bracket" },
  // 邮件：纯文本正文发送（不声明 HTML 部件），因此必须去 markdown；
  // 强调**不用【】**——邮件是正式文体，括号强调显得像 IM（P0.6 正式语气要求）。
  email: { markdown: false, emphasis: "plain" },
  // 小程序：富文本（HTML）渲染，保留结构与强调
  miniprogram: { markdown: true, emphasis: "keep", html: true },
  default: { markdown: false, emphasis: "bracket" },
};

export function profileFor(channelId: string): TextProfile {
  return CHANNEL_TEXT_PROFILES[channelId as ChannelId] ?? CHANNEL_TEXT_PROFILES.default;
}

export interface PlainTextOptions {
  emphasis?: TextProfile["emphasis"];
  /** 列表项符号（默认 "· "，比 "- " 更像中文 IM 的排版） */
  bullet?: string;
}

/**
 * markdown → 纯文本。纯函数，无 IO，便于单测。
 *
 * 处理的语法（只做"去掉/替换标记"，不改写内容）：
 *   **粗体** __粗体__ / *斜体* _斜体_ / ~~删除~~ / `行内代码` / ```代码块```
 *   # 标题 / > 引用 / - * 列表 / | 表格 | / [文字](链接) / --- 分隔线
 */
export function toPlainText(text: string, options: PlainTextOptions = {}): string {
  const emphasis = options.emphasis ?? "bracket";
  const bullet = options.bullet ?? "· ";
  const wrap = (inner: string): string => {
    if (emphasis === "keep") return inner;
    // 中文 IM 习惯用【】做强调；去掉内容两端已有的空白，避免「【 189元 】」
    return emphasis === "bracket" ? `【${inner.trim()}】` : inner.trim();
  };

  let out = text;

  // 代码块：整块降级为缩进文本（内容保留，围栏去掉）
  out = out.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, body: string) => body.replace(/\n+$/, ""));

  // 表格：分隔行整行删除，数据行去掉竖线
  out = out.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, "");
  out = out.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_m, row: string) =>
    row
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.length > 0)
      .join("  ")
  );

  // 粗体（先于斜体，且要求成对，避免误吃单独出现的 *）
  out = out.replace(/\*\*([^\n*]+?)\*\*/g, (_m, inner: string) => wrap(inner));
  out = out.replace(/__([^\n_]+?)__/g, (_m, inner: string) => wrap(inner));

  // 斜体 / 删除线：只去标记，不加【】（否则一行里到处都是括号，反而看不清重点）
  out = out.replace(/\*([^\n*]+?)\*/g, "$1");
  out = out.replace(/(^|[\s（(])_([^\n_]+?)_(?=$|[\s）)，。！？、])/g, "$1$2");
  out = out.replace(/~~([^\n~]+?)~~/g, "$1");

  // 行内代码
  out = out.replace(/`([^`\n]+?)`/g, "$1");

  // 标题
  out = out.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  // 引用
  out = out.replace(/^[ \t]*>[ \t]?/gm, "");
  // 列表符号
  out = out.replace(/^([ \t]*)[-*+][ \t]+/gm, `$1${bullet}`);
  // 分隔线
  out = out.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, "");
  // 链接：保留文字 + 链接
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1（$2）");

  // 收尾整理：去掉行尾空白、压缩连续空行
  out = out
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return out;
}

/**
 * markdown → HTML（富文本渠道，如微信小程序 <rich-text>）。
 * 保留结构与强调；先做 HTML 转义防注入，再替换 markdown 标记。
 * 只覆盖客服输出常见语法（粗斜体/删除线/行内代码/标题/列表/链接/换行），不做完整 markdown 引擎。
 */
export function toRichTextHtml(text: string): string {
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // 先转义全文，再在转义后的文本上替换 markdown 标记（标记本身不含需转义的字符）
  let out = esc(text);
  out = out.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+?)\*/g, "<em>$1</em>");
  out = out.replace(/~~([^~]+?)~~/g, "<del>$1</del>");
  out = out.replace(/`([^`]+?)`/g, "<code>$1</code>");
  out = out.replace(/^#{1,6}[ \t]+([^\n]+)$/gm, "<strong>$1</strong>");
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  // 列表：-/*/+ 行 → <br>•（客服输出多为短列表，用换行符表达即可）
  out = out.replace(/^[-*+][ \t]+([^\n]+)$/gm, "• $1<br>");
  // 段落换行 → <br>（微信 rich-text 用 <br> 换行）
  out = out.replace(/\n/g, "<br>");
  return out;
}

/** 出站边界调用：把回复文本转成目标渠道能正确显示的格式 */
export function formatForChannel(channelId: string, text: string): string {
  const profile = profileFor(channelId);
  if (profile.html) return toRichTextHtml(text);
  if (profile.markdown) return text;
  return toPlainText(text, { emphasis: profile.emphasis });
}
