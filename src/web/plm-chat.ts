/**
 * plm-chat.ts — 天工 PLM 客服的 Web UI 页面（需求 1 / 2 / 4）
 *
 * 为什么单独一个模块而不是塞进 `static.ts`：`static.ts` 是通用 WebChat/控制台的
 * 单体（2300+ 行、单页内嵌 HTML），本页是**面向另一个产品（PLM）的独立入口**，
 * 有自己的视觉令牌与身份协议。混进去会让"改 PLM 主题"和"改通用聊天"互相牵动
 * （§一 设计原则：能靠结构表达的不用消息）。
 *
 * 视觉依据：`D:\project\jcode\docs\plm-tech\08-前端实现规格.md` §1（设计令牌）、
 * §2（应用骨架：56px 深色顶栏 + 220px 深色侧栏 + content 唯一滚动容器）、
 * §3.4（卡片）、§1.4（状态 Pill）。**令牌值逐值照抄**，便于用断言核对比对
 * （A11：`--primary:#2563eb` / `--sidebar:#0f172a` / `--ai:#8b5cf6` 必须命中）。
 *
 * 身份协议（需求 4）：本页把身份随**升级请求**带给网关——
 *   ① 优先读页面自己的初始身份（由网关侧头渲染进来，见 resolveInitialIdentity）；
 *   ② 浏览器 `WebSocket` API 不能设自定义头，故回落查询参数 `?user=&name=`；
 *   ③ 网关侧若配置 `PLM_REQUIRE_HEADER_IDENTITY=1`，则**忽略查询参数**（生产口径），
 *      此时本页会把"被忽略"明确显示出来，而不是假装身份生效（假绿比红更危险）。
 */
import type { MoziConfig } from "../types/index.js";

/** 本页的固定路由（网关按它挂载；harness 与文档都引用同一常量，避免两处各写一份） */
export const PLM_CHAT_ROUTE = "/tiangong";

export interface PlmChatHtmlOptions {
  agentId: string;
  config: MoziConfig;
  /** 原始请求（用于读网关侧注入的身份头，作为首屏身份） */
  req?: { headers?: Record<string, unknown> };
}

/**
 * 从请求头取首屏身份（与 WS 层同一套头名与同一套编码规则）。
 *
 * ⚠️ 头值必须是 latin-1/ASCII：中文显示名由网关按 RFC 3986 百分号编码传
 * （如 `X-PLM-User-Name: %E5%BC%A0%E5%B7%A5`），此处解码；ASCII 名称解码后与原文相同（幂等）。
 */
export function resolveInitialIdentity(req?: { headers?: Record<string, unknown> }): { id: string; name: string; fromHeader: boolean } {
  const h = req?.headers ?? {};
  const pick = (v: unknown): string => {
    const s = Array.isArray(v) ? String(v[0]) : v == null ? "" : String(v);
    let t = s.trim();
    if (/%[0-9a-fA-F]{2}/.test(t)) {
      try { t = decodeURIComponent(t); } catch { /* 保留原样 */ }
    }
    return t.trim().slice(0, 64);
  };
  const id = pick(h["x-plm-user"]);
  const name = pick(h["x-plm-user-name"]);
  return { id, name, fromHeader: Boolean(id || name) };
}

/** 身份值 → 可安全放进 URL 查询参数/头的形态（中文必须编码，见 resolveInitialIdentity 的注释） */
export function encodeIdentityValue(v: string): string {
  return encodeURIComponent(v || "");
}

/** HTML 转义（身份可能来自请求头，属不可信输入：直接拼进 HTML 就是 XSS） */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderPlmChatHtml(options: PlmChatHtmlOptions): string {
  const { agentId, config, req } = options;
  const initial = resolveInitialIdentity(req);
  const requireHeader = process.env.PLM_REQUIRE_HEADER_IDENTITY === "1";
  const title = "天工 PLM 客服";
  const model = config?.agent?.defaultModel ?? "-";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>
/* ===== §1 设计令牌（值逐字取自 PLM 前端实现规格） ===== */
:root {
  --primary: #2563eb;
  --primary-dark: #1d4ed8;
  --ai: #8b5cf6;
  --ai-dark: #7c3aed;
  --med: #0d9488;
  --bg: #f1f5f9;
  --sidebar: #0f172a;
  --sidebar-hover: #1e293b;
  --border: #e2e8f0;
  --border-dark: #334155;
  --text: #1e293b;
  --text-muted: #64748b;
  --text-faint: #94a3b8;
  --ok: #16a34a;
  --warn: #d97706;
  --err: #dc2626;
  --info: #0ea5e9;
  --mono: ui-monospace, Consolas, monospace;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
:focus { outline: 2px dashed #0ea5e9; outline-offset: 2px; border-radius: 3px; }
html, body { height: 100%; }
body {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  color: var(--text);
  background: var(--bg);
  display: flex;
  flex-direction: column;
}
/* ===== §2 应用骨架：topbar 56px / sidebar 220px / content 唯一滚动容器 ===== */
.topbar {
  height: 56px; flex-shrink: 0;
  background: var(--sidebar); color: #fff;
  padding: 0 20px;
  display: flex; align-items: center; gap: 16px;
}
.brand { font-size: 18px; font-weight: 700; letter-spacing: .5px; white-space: nowrap; }
.brand .mark { color: var(--info); }
.topbar-search {
  width: 360px; max-width: 40vw;
  background: var(--sidebar-hover); border: 1px solid var(--border-dark);
  color: #e2e8f0; border-radius: 6px; padding: 6px 10px; font-size: 12.5px;
}
.topbar-search::placeholder { color: var(--text-faint); }
.ai-badge {
  background: var(--ai); color: #fff;
  padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;
  white-space: nowrap;
}
.spacer { flex: 1; }
/* 身份胶囊：需求 4 的可视化落点（用户必须能看见"agent 认为我是谁"） */
.identity {
  display: flex; align-items: center; gap: 8px;
  background: var(--sidebar-hover); border: 1px solid var(--border-dark);
  border-radius: 999px; padding: 4px 12px 4px 4px; cursor: pointer;
  color: #e2e8f0; font-size: 12.5px;
}
.identity .avatar {
  width: 28px; height: 28px; border-radius: 50%;
  background: var(--primary); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 12px;
}
.identity .who { display: flex; flex-direction: column; line-height: 1.25; }
.identity .who b { font-weight: 600; }
.identity .who span { color: var(--text-faint); font-size: 11px; }
.layout { flex: 1; display: flex; min-height: 0; }
.sidebar {
  width: 220px; flex-shrink: 0;
  background: var(--sidebar); color: #cbd5e1;
  display: flex; flex-direction: column; padding: 12px 0;
}
.nav-group { font-size: 10px; font-weight: 600; letter-spacing: 2px; color: var(--text-faint); padding: 12px 18px 6px; }
.nav-item {
  font-size: 13px; padding: 8px 18px; cursor: pointer;
  display: flex; align-items: center; gap: 8px; color: #cbd5e1; text-decoration: none;
}
.nav-item:hover { background: var(--sidebar-hover); }
.nav-item.active { background: var(--primary); color: #fff; }
.side-foot { margin-top: auto; padding: 12px 18px; font-size: 11px; color: var(--text-faint); line-height: 1.6; }
.side-foot code { font-family: var(--mono); color: #cbd5e1; }
.content { flex: 1; min-width: 0; padding: 18px 22px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.breadcrumb { font-size: 12px; color: var(--text-faint); }
.breadcrumb a { color: var(--primary); text-decoration: none; }
.page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.page-head h1 { font-size: 20px; font-weight: 700; }
.page-head .sub { color: var(--text-muted); font-size: 12.5px; margin-top: 4px; }
.btn {
  padding: 7px 14px; border-radius: 6px; border: 1px solid var(--border);
  background: #fff; color: var(--text); font-size: 13px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
}
.btn:hover { border-color: var(--primary); color: var(--primary); }
.btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.btn.primary:hover { background: var(--primary-dark); color: #fff; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.ctx-bar {
  background: var(--sidebar); color: #fff; border-radius: 8px;
  padding: 10px 16px; font-size: 12.5px;
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
}
.ctx-bar .kv { display: flex; gap: 6px; align-items: center; }
.ctx-bar .kv span { color: var(--text-faint); }
.pill { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.pill.ok { background: #dcfce7; color: var(--ok); }
.pill.warn { background: #fef3c7; color: var(--warn); }
.pill.err { background: #fee2e2; color: var(--err); }
.pill.info { background: #dbeafe; color: var(--primary); }
.pill.muted { background: var(--border); color: var(--text-muted); }
.card {
  background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 14px;
  box-shadow: 0 1px 3px rgba(0,0,0,.06);
}
/* ===== 对话区（PLM 卡片语言：白底卡片 + 细边框，不用气泡圆角堆叠） ===== */
.chat-card { display: flex; flex-direction: column; flex: 1; min-height: 420px; padding: 0; overflow: hidden; }
.chat-head {
  padding: 10px 14px; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 10px; font-size: 12.5px; color: var(--text-muted);
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); }
.dot.off { background: var(--err); }
.messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.msg { display: flex; gap: 10px; max-width: 92%; }
.msg .who { flex-shrink: 0; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; }
.msg.assistant .who { background: #ede9fe; color: var(--ai-dark); }
.msg.user { align-self: flex-end; flex-direction: row-reverse; }
.msg.user .who { background: var(--primary); color: #fff; }
.bubble { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; background: #fff; }
.msg.user .bubble { background: #eff6ff; border-color: #bfdbfe; }
.bubble .src { display: block; margin-top: 6px; font-size: 11.5px; color: var(--text-faint); }
.bubble code { font-family: var(--mono); background: #f1f5f9; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
.bubble pre { background: #0f172a; color: #e2e8f0; padding: 10px; border-radius: 6px; overflow-x: auto; margin: 6px 0; font-family: var(--mono); font-size: 12px; }
.bubble ul, .bubble ol { margin: 4px 0 4px 18px; }
.welcome { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--text-muted); text-align: center; padding: 20px; }
.welcome h2 { font-size: 16px; color: var(--text); }
.chips { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 6px; }
.chip { border: 1px solid var(--border); background: #fff; border-radius: 14px; padding: 5px 12px; font-size: 12.5px; cursor: pointer; color: var(--text-muted); }
.chip:hover { border-color: var(--primary); color: var(--primary); }
.typing { display: inline-flex; gap: 4px; padding: 4px 0; }
.typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); animation: tp 1.2s infinite; }
.typing i:nth-child(2) { animation-delay: .15s; }
.typing i:nth-child(3) { animation-delay: .3s; }
@keyframes tp { 0%,60%,100% { transform: translateY(0); opacity: .6 } 30% { transform: translateY(-3px); opacity: 1 } }
.composer { border-top: 1px solid var(--border); padding: 10px 12px; display: flex; gap: 10px; align-items: flex-end; background: #f8fafc; }
.composer textarea {
  flex: 1; border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px;
  font-family: inherit; font-size: 13px; line-height: 1.5; resize: none; max-height: 140px; background: #fff; color: var(--text);
}
.composer textarea:focus { border-color: var(--primary); outline: 2px dashed var(--info); outline-offset: 1px; }
.hint { font-size: 11.5px; color: var(--text-faint); padding: 0 12px 10px; background: #f8fafc; }
.banner { border-radius: 6px; padding: 8px 12px; font-size: 12.5px; display: none; }
.banner.show { display: block; }
.banner.warn { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; }
.banner.err { background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; }
/* 身份面板（无弹窗录入：与 PLM §6.1 一致，用右侧常驻卡而不是 modal） */
.id-panel { display: none; }
.id-panel.show { display: block; }
.id-panel .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; margin-top: 8px; }
.id-panel label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); }
.id-panel input { border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; min-width: 200px; }
.foot { font-size: 11.5px; color: var(--text-faint); }
@media (max-width: 900px) {
  .sidebar { display: none; }
  .topbar-search { display: none; }
}
</style>
</head>
<body>
<div class="topbar">
  <div class="brand"><span class="mark">◆</span> 天工 PLM</div>
  <input class="topbar-search" placeholder="全局搜索（本页为客服入口，搜索在 PLM 主界面使用）" disabled>
  <span class="ai-badge">AI 客服</span>
  <div class="spacer"></div>
  <div class="identity" id="identity" title="点击设置/查看当前身份">
    <div class="avatar" id="id-avatar">匿</div>
    <div class="who">
      <b id="id-name">未提供身份</b>
      <span id="id-code">匿名访客</span>
    </div>
  </div>
</div>

<div class="layout">
  <aside class="sidebar">
    <div class="nav-group">客服</div>
    <a class="nav-item active" href="${PLM_CHAT_ROUTE}"><span>💬</span><span>天工客服对话</span></a>
    <a class="nav-item" href="#" id="nav-new"><span>＋</span><span>新建对话</span></a>
    <div class="nav-group">快捷提问</div>
    <a class="nav-item" href="#" data-q="新增料号在哪里操作？"><span>◇</span><span>怎么新增料号</span></a>
    <a class="nav-item" href="#" data-q="为什么我看不到某个按钮？"><span>◇</span><span>按钮为什么不见</span></a>
    <a class="nav-item" href="#" data-q="ECR 和 ECO 有什么区别？"><span>◇</span><span>ECR/ECO 区别</span></a>
    <a class="nav-item" href="#" data-q="权限和角色在哪里改？"><span>◇</span><span>权限在哪里改</span></a>
    <div class="side-foot">
      <div>客服：<code>${esc(agentId)}</code></div>
      <div>模型：<code>${esc(model)}</code></div>
      <div id="side-conn">连接中…</div>
    </div>
  </aside>

  <main class="content">
    <div class="breadcrumb"><a href="${PLM_CHAT_ROUTE}">客服中心</a> / 天工 PLM 客服</div>
    <div class="page-head">
      <div>
        <h1>天工 PLM 客服</h1>
        <div class="sub">问 PLM 的流程、字段、单据、权限与快捷键。答不了会明确说没收录，不编。</div>
      </div>
      <div>
        <button class="btn" id="btn-identity">设置身份</button>
        <button class="btn" id="btn-new2">新建对话</button>
      </div>
    </div>

    <div class="ctx-bar">
      <div class="kv"><span>提问者</span><b id="ctx-user">匿名访客</b></div>
      <div class="kv"><span>身份来源</span><b id="ctx-source">未提供</b></div>
      <div class="kv"><span>客服</span><b>${esc(agentId)}</b></div>
      <div class="kv"><span>连接</span><span class="pill muted" id="ctx-conn">连接中</span></div>
    </div>

    <div class="banner warn" id="banner"></div>

    <div class="card id-panel" id="id-panel">
      <b>身份（对应 HTTP 头 X-PLM-User / X-PLM-User-Name）</b>
      <div class="sub" style="color:var(--text-muted);font-size:12.5px;margin-top:4px">
        生产环境下身份由**前端网关**填充请求头；本机自测可用下面的入口随连接一起带上（浏览器 WebSocket 无法自定义头）。
        若服务端配置为只认请求头（PLM_REQUIRE_HEADER_IDENTITY=1），这里填的会被忽略，页面会明确提示。
      </div>
      <div class="row">
        <label>用户 ID<input id="in-id" placeholder="如 plm.zhang" value="${esc(initial.id)}"></label>
        <label>显示名<input id="in-name" placeholder="如 张工" value="${esc(initial.name)}"></label>
        <button class="btn primary" id="btn-apply-id">应用并重连</button>
        <button class="btn" id="btn-clear-id">清除（匿名）</button>
      </div>
    </div>

    <div class="card chat-card">
      <div class="chat-head">
        <span class="dot" id="conn-dot"></span>
        <span id="conn-text">正在连接客服…</span>
        <div class="spacer"></div>
        <span id="session-text"></span>
      </div>
      <div class="messages" id="messages">
        <div class="welcome" id="welcome">
          <h2>我是天工 PLM 的客服小天</h2>
          <div>问流程、问字段、问单据、问权限都可以；有改进建议也可以直接说，我帮你整理成需求提给 PLM。举例：</div>
          <div class="chips">
            <span class="chip" data-q="新增料号在哪里操作？">新增料号在哪</span>
            <span class="chip" data-q="为什么我看不到某个按钮？">为什么看不到按钮</span>
            <span class="chip" data-q="ECR 和 ECO 有什么区别？">ECR/ECO 区别</span>
            <span class="chip" data-q="导出数据什么时候会走异步？">导出怎么走异步</span>
            <span class="chip" data-q="我想提一个改进建议：BOM 界面每次都要重新筛选，很费时间。">提个改进建议</span>
            <span class="chip" data-q="你知道我是谁吗？">你知道我是谁吗</span>
          </div>
        </div>
      </div>
      <div class="composer">
        <textarea id="input" rows="1" placeholder="输入问题，回车发送（Shift+回车换行）"></textarea>
        <button class="btn primary" id="send">发送</button>
        <button class="btn" id="cancel" style="display:none">停止</button>
      </div>
      <div class="hint" id="hint">Enter 发送 · Shift+Enter 换行 · 回答来自 PLM 知识库，未收录会明确说明</div>
    </div>
    <div class="foot">天工 PLM 客服 · Web 入口（本机）· 同一份知识库也服务 QQ 渠道</div>
  </main>
</div>

<script>
(function () {
  "use strict";
  var AGENT = ${JSON.stringify(agentId)};
  var REQUIRE_HEADER = ${requireHeader ? "true" : "false"};
  var INITIAL = ${JSON.stringify({ id: initial.id, name: initial.name, fromHeader: initial.fromHeader })};
  var NEEDS_ESCAPE = /%[0-9a-f]{2}/i;

  var $ = function (id) { return document.getElementById(id); };
  var messagesEl = $("messages"), welcomeEl = $("welcome"), inputEl = $("input");
  var sendBtn = $("send"), cancelBtn = $("cancel");

  var ws = null, requestId = 0, pending = new Map(), streaming = false, streamBuf = "";
  var connected = false, agentEcho = null, serverUser = null;
  var identity = { id: "", name: "" };

  /** 身份取值顺序：URL 参数（?user=&name=）> localStorage > 网关渲染进来的头身份 */
  function decodeMaybe(v) {
    if (!v) return "";
    return NEEDS_ESCAPE.test(v) ? decodeURIComponent(v) : v;
  }
  function readIdentity() {
    var q = new URLSearchParams(location.search);
    var qid = decodeMaybe((q.get("user") || "").trim()), qname = decodeMaybe((q.get("name") || "").trim());
    var ls = null;
    try { ls = JSON.parse(localStorage.getItem("plm_chat_identity") || "null"); } catch (e) { ls = null; }
    var id = qid || (ls && ls.id) || INITIAL.id || "";
    var name = qname || (ls && ls.name) || INITIAL.name || "";
    return { id: id, name: name };
  }

  function saveIdentity(id, name) {
    try { localStorage.setItem("plm_chat_identity", JSON.stringify({ id: id, name: name })); } catch (e) {}
  }

  function sessionStorageKey() {
    return "plm_chat_session:" + AGENT + ":" + (identity.id || "anon");
  }

  function renderIdentity() {
    var hasId = !!identity.id, hasName = !!identity.name;
    var label = hasName ? identity.name : (hasId ? identity.id : "未提供身份");
    var code = hasId ? identity.id : "匿名访客";
    $("id-name").textContent = label;
    $("id-code").textContent = code;
    $("id-avatar").textContent = (hasName || hasId) ? (label.slice(0, 1) || "?") : "匿";
    $("ctx-user").textContent = hasName && hasId ? (identity.name + "（" + identity.id + "）") : (hasId || hasName ? (identity.name || identity.id) : "匿名访客");
    $("ctx-source").textContent = serverUser
      ? ({ header: "HTTP 头（网关注入）", query: "查询参数（本机自测回落）", none: "未提供" }[serverUser.source] || serverUser.source)
      : "未提供";
  }

  function showBanner(kind, text) {
    var b = $("banner");
    b.className = "banner " + kind + " show";
    b.textContent = text;
  }
  function hideBanner() { $("banner").className = "banner"; }

  function setConn(ok, text) {
    connected = ok;
    $("conn-dot").className = "dot" + (ok ? "" : " off");
    $("conn-text").textContent = text;
    $("ctx-conn").className = "pill " + (ok ? "ok" : "err");
    $("ctx-conn").textContent = ok ? "已连接" : "未连接";
    $("side-conn").textContent = ok ? "已连接" : "未连接";
  }

  function connect() {
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var q = new URLSearchParams();
    q.set("agent", AGENT);
    if (!REQUIRE_HEADER) {
      // 头优先、参数回落：网关若已注入头，参数会被忽略（服务端以头为准）
      // URLSearchParams 会自己做百分号编码，中文名在这里是安全的
      if (identity.id) q.set("user", identity.id);
      if (identity.name) q.set("name", identity.name);
    }
    var url = proto + "//" + location.host + "/ws?" + q.toString();
    setConn(false, "正在连接客服…");
    try { ws = new WebSocket(url); } catch (e) { setConn(false, "连接失败"); showBanner("err", "无法建立连接：" + e.message); return; }

    ws.onopen = function () { setConn(true, "已连接客服 " + AGENT); };
    ws.onclose = function () { setConn(false, "连接已断开，正在重试…"); setTimeout(connect, 2000); };
    ws.onerror = function () { setConn(false, "连接出错"); };
    ws.onmessage = function (ev) {
      var frame;
      try { frame = JSON.parse(ev.data); } catch (e) { return; }
      if (frame.type === "res") {
        var p = pending.get(frame.id);
        if (p) { pending.delete(frame.id); frame.ok ? p.resolve(frame.payload) : p.reject(new Error((frame.error && frame.error.message) || "unknown")); }
      } else if (frame.type === "event") {
        onEvent(frame.event, frame.payload || {});
      }
    };
  }

  function request(method, params) {
    return new Promise(function (resolve, reject) {
      if (!ws || ws.readyState !== 1) { reject(new Error("尚未连接客服")); return; }
      var id = String(++requestId);
      pending.set(id, { resolve: resolve, reject: reject });
      ws.send(JSON.stringify({ type: "req", id: id, method: method, params: params || {} }));
    });
  }

  function onEvent(event, payload) {
    if (event === "connected") {
      agentEcho = payload.agent;
      serverUser = payload.user || null;
      $("session-text").textContent = payload.sessionKey ? ("会话 " + payload.sessionKey) : "";
      renderIdentity();
      // 三种"身份没按预期生效"的情形，都必须**显式告知**（静默是禁止项）
      if (payload.agentRequested && payload.agentMatched === false) {
        showBanner("warn", "客服 " + payload.agentRequested + " 不存在，已切到默认客服 " + payload.agent + "。");
      } else if (identity.id && serverUser && !serverUser.id) {
        showBanner("warn", "服务端未收到你设置的身份（它只接受由前端网关注入的请求头 X-PLM-User）。本次按匿名处理，回答不会按你的身份给出。");
      } else if (identity.id && serverUser && serverUser.id && serverUser.id !== identity.id && serverUser.source === "header") {
        showBanner("warn", "服务端收到的身份是 " + serverUser.id + "（来自网关请求头），与你本地填的 " + identity.id + " 不同——以服务端为准。");
      } else if (identity.id && serverUser && serverUser.id) {
        hideBanner();
      }
      restoreOrInit();
      return;
    }
    if (event === "chat.delta") {
      if (!streaming) {
        streaming = true; streamBuf = "";
        addMessage("assistant", "", true);
        sendBtn.style.display = "none"; cancelBtn.style.display = "";
      }
      if (payload.delta) { streamBuf += payload.delta; updateStream(streamBuf); }
      if (payload.done) {
        streaming = false; sendBtn.style.display = ""; cancelBtn.style.display = "none";
        finalizeStream(payload.cancelled);
      }
      return;
    }
    if (event === "chat.error") {
      streaming = false; sendBtn.style.display = ""; cancelBtn.style.display = "none";
      // 出错必须可见，且**保留用户已输入内容**（体验预演里的"出错有提示"）。
      // 上游模型的错误原文（如鉴权/额度/限流）要照实显示——它决定了该找谁修。
      finalizeStream(true);
      addMessage("assistant", "服务端返回错误：" + payload.error + "\\n先把这句话原样反馈给系统管理员；如果是模型服务的问题，运维在服务端日志里能看到同一句。", false);
      showBanner("err", "客服暂时无法回答：" + String(payload.error).slice(0, 160));
    }
  }

  function restoreOrInit() {
    var key = null;
    try { key = localStorage.getItem(sessionStorageKey()); } catch (e) {}
    if (!key) return;
    request("sessions.restore", { sessionKey: key }).then(function (r) {
      if (r && r.messages && r.messages.length) {
        if (welcomeEl) welcomeEl.style.display = "none";
        r.messages.forEach(function (m) {
          if (m.role === "user" || m.role === "assistant") addMessage(m.role, typeof m.content === "string" ? m.content : JSON.stringify(m.content), false);
        });
      }
    }).catch(function () { /* 会话已不存在：按新会话处理，不打扰用户 */ });
  }

  function clearMessages() {
    Array.prototype.slice.call(messagesEl.querySelectorAll(".msg")).forEach(function (n) { n.remove(); });
    if (welcomeEl) welcomeEl.style.display = "flex";
  }

  function addMessage(role, text, isStream) {
    if (welcomeEl) welcomeEl.style.display = "none";
    var wrap = document.createElement("div");
    wrap.className = "msg " + role + (isStream ? " streaming" : "");
    if (isStream) wrap.id = "streaming";
    var who = document.createElement("div");
    who.className = "who";
    who.textContent = role === "user" ? ((identity.name || identity.id || "我").slice(0, 1)) : "工";
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    if (isStream) { bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>'; }
    else { bubble.textContent = text; }
    wrap.appendChild(who); wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return wrap;
  }

  function updateStream(text) {
    var el = $("streaming");
    if (!el) return;
    var b = el.querySelector(".bubble");
    b.textContent = text;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function finalizeStream(cancelled) {
    var el = $("streaming");
    if (!el) return;
    el.removeAttribute("id");
    el.classList.remove("streaming");
    var b = el.querySelector(".bubble");
    if (!streamBuf.trim()) {
      // 空回答比报错更容易被忽略：显式写出原因，不留白。
      // （真实原因由服务端通过 chat.error 事件另行显示，这里只兜底"没有任何错误事件"的情况）
      b.textContent = cancelled ? "（本轮已取消）" : "（客服这一轮没有返回内容。可能原因：模型服务不可用或额度用尽、网关重启中。请稍后重试；持续如此请把这句话反馈给系统管理员。）";
    } else if (cancelled) {
      b.textContent = streamBuf + "\\n（本轮已取消，以上为已生成部分）";
    }
    streamBuf = "";
  }

  function send(text) {
    var msg = (text != null ? text : inputEl.value).trim();
    if (!msg) return;
    if (streaming) return;
    addMessage("user", msg, false);
    inputEl.value = ""; inputEl.style.height = "auto";
    // 立即给出等待反馈（A25：发送后 ≤200ms 内可见"正在思考"）
    addMessage("assistant", "", true);
    streaming = true;
    sendBtn.style.display = "none"; cancelBtn.style.display = "";
    streamBuf = "";
    request("chat.send", { message: msg }).then(function (r) {
      // 真实会话键存下来，刷新后能恢复
      if (r && r.messageId && $("session-text").textContent) {
        var sk = $("session-text").textContent.replace(/^会话\\s*/, "");
        try { localStorage.setItem(sessionStorageKey(), sk); } catch (e) {}
      }
    }).catch(function (e) {
      streaming = false; sendBtn.style.display = ""; cancelBtn.style.display = "none";
      finalizeStream(true);
      addMessage("assistant", "发送失败：" + e.message, false);
      showBanner("err", "与客服的连接有问题：" + e.message);
    });
  }

  // ===== 事件绑定 =====
  sendBtn.addEventListener("click", function () { send(); });
  cancelBtn.addEventListener("click", function () { request("chat.cancel", {}).catch(function () {}); });
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener("input", function () {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px";
  });
  Array.prototype.slice.call(document.querySelectorAll("[data-q]")).forEach(function (n) {
    n.addEventListener("click", function (e) { e.preventDefault(); send(n.getAttribute("data-q")); });
  });
  function newChat() {
    request("chat.clear", {}).then(function (r) {
      if (r && r.sessionKey) { try { localStorage.setItem(sessionStorageKey(), r.sessionKey); } catch (e) {} }
      clearMessages();
      $("session-text").textContent = r && r.sessionKey ? ("会话 " + r.sessionKey) : "";
    }).catch(function () { clearMessages(); });
  }
  $("nav-new").addEventListener("click", function (e) { e.preventDefault(); newChat(); });
  $("btn-new2").addEventListener("click", newChat);
  $("identity").addEventListener("click", function () { $("id-panel").classList.toggle("show"); });
  $("btn-identity").addEventListener("click", function () { $("id-panel").classList.toggle("show"); });
  $("btn-apply-id").addEventListener("click", function () {
    identity = { id: $("in-id").value.trim(), name: $("in-name").value.trim() };
    saveIdentity(identity.id, identity.name);
    renderIdentity();
    confirmRebind();
  });
  $("btn-clear-id").addEventListener("click", function () {
    identity = { id: "", name: "" }; saveIdentity("", "");
    $("in-id").value = ""; $("in-name").value = "";
    renderIdentity(); confirmRebind();
  });
  function confirmRebind() {
    if (streaming) { showBanner("warn", "正在回答中，等这轮结束后会按新身份重连。"); return; }
    connect();
  }

  // ===== 启动 =====
  identity = readIdentity();
  renderIdentity();
  if (REQUIRE_HEADER && !INITIAL.fromHeader) {
    showBanner("warn", "本入口配置为**只接受请求头身份**（PLM_REQUIRE_HEADER_IDENTITY=1）：请让前端网关注入 X-PLM-User / X-PLM-User-Name。当前连接按匿名处理。");
  }
  connect();
  inputEl.focus();
})();
</script>
</body>
</html>`;
}
