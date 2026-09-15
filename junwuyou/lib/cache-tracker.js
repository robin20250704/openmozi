// junwuyou/lib/cache-tracker.js
// 前缀不变式追踪器 —— 仿 jcode `crates/jcode-base/src/cache_tracker.rs`
//
// 原理（jcode 原注释）："Client-side cache tracking for append-only validation.
//   If the prefix changes between requests, we know the cache was invalidated."
//
// 提示词缓存只对**前缀**生效：只要"系统提示 + 工具 + 历史消息"这一段逐字节不变、
// 且新请求只是在其后追加，缓存就能命中。任何对已发送前缀的修改（改系统提示、
// 重排历史、插入消息）都会让缓存从改动点起全部失效。
//
// 本模块用**增量前缀哈希**检测这种破坏：
//   prefix_hash[i] = H(prefix_hash[i-1], hash(message[i]))
// 若上一轮请求的 prefix_hashes 不是本轮 prefix_hashes 的纯前缀 → append-only 被破坏。
//
// 注意：压缩（compaction）是**合法的**前缀替换，必须显式 reset，否则会误报。
import { createHash } from "node:crypto";

/** 每个会话保留的历史前缀哈希数（用于诊断间歇性违反） */
const MAX_HISTORY = 10;

function hashMessage(msg) {
  const content = typeof msg?.content === "string" ? msg.content : JSON.stringify(msg?.content ?? "");
  return createHash("sha1").update(`${msg?.role ?? "?"}\u0000${content}`).digest("hex");
}

function extend(prev, cur) {
  return createHash("sha1").update(`${prev}\u0000${cur}`).digest("hex");
}

/** 计算整条消息序列的增量前缀哈希 */
export function prefixHashes(messages) {
  const out = [];
  let prev = null;
  for (const m of messages) {
    const h = hashMessage(m);
    prev = prev === null ? h : extend(prev, h);
    out.push(prev);
  }
  return out;
}

class SessionCacheState {
  constructor() {
    this.prefixHashes = null;
    this.messageCount = 0;
    this.turns = 0;
    this.violations = [];
    this.hashHistory = [];
    this.inputTokens = 0;
    this.cacheRead = 0;
    this.cacheWrite = 0;
  }
}

const sessions = new Map();
const global = { requests: 0, violations: 0, cacheRead: 0, cacheWrite: 0, inputTokens: 0 };

function stateFor(sessionKey) {
  let s = sessions.get(sessionKey);
  if (!s) {
    s = new SessionCacheState();
    sessions.set(sessionKey, s);
  }
  return s;
}

/**
 * 记录一次发往 LLM 的请求，检测前缀不变式是否被破坏。
 * @param {string} sessionKey 会话键（按会话隔离追踪）
 * @param {Array}   messages   **不含**本次请求级后缀的历史消息（后缀对追踪器不可见，同 jcode）
 * @returns {{ok:boolean, violation?:object, kept?:number, total?:number}}
 */
export function recordRequest(sessionKey, messages) {
  const s = stateFor(sessionKey);
  const hashes = prefixHashes(messages);
  global.requests++;
  s.turns++;
  s.hashHistory.push(hashes[hashes.length - 1] ?? "empty");
  if (s.hashHistory.length > MAX_HISTORY) s.hashHistory.shift();

  const prev = s.prefixHashes;
  let result = { ok: true, total: hashes.length, kept: 0 };

  if (prev && prev.length > 0) {
    // 上一轮的每个前缀哈希都必须能在本轮相同位置上找到
    let recomputed = null;
    for (let i = 0; i < prev.length; i++) {
      if (i >= hashes.length) {
        recomputed = { at: i, reason: "本轮消息数少于上一轮（历史被截断）" };
        break;
      }
      if (prev[i] !== hashes[i]) {
        recomputed = { at: i, reason: "前缀在第 " + i + " 条消息处发生变化（系统提示/工具定义/历史被改写）" };
        break;
      }
    }
    if (recomputed) {
      const v = { turn: s.turns, at: recomputed.at, reason: recomputed.reason, messageCount: hashes.length };
      s.violations.push(v);
      if (s.violations.length > MAX_HISTORY) s.violations.shift();
      global.violations++;
      result = { ok: false, violation: v, total: hashes.length, kept: recomputed.at };
    } else {
      result.kept = prev.length;
    }
  }

  s.prefixHashes = hashes;
  s.messageCount = hashes.length;
  return result;
}

/** 记录 provider 返回的 usage（用于算缓存命中率） */
export function recordUsage(sessionKey, usage) {
  if (!usage) return;
  const read = Number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0) || 0;
  const write = Number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0) || 0;
  const input = Number(usage.input_tokens ?? usage.inputTokens ?? usage.promptTokens ?? 0) || 0;
  const s = stateFor(sessionKey);
  s.cacheRead += read;
  s.cacheWrite += write;
  s.inputTokens += input;
  global.cacheRead += read;
  global.cacheWrite += write;
  global.inputTokens += input;
}

/** 压缩/历史重建后调用，避免把合法的前缀替换误报为违反 */
export function reset(sessionKey, reason = "") {
  const s = stateFor(sessionKey);
  s.prefixHashes = null;
  s.messageCount = 0;
  s.violations = [];
  if (reason) s.lastResetReason = reason;
}

/** 导出统计（供验收 harness 断言） */
export function stats(sessionKey) {
  const s = sessions.get(sessionKey);
  const cacheable = (st) => st.inputTokens + st.cacheRead + st.cacheWrite;
  const rate = (st) => {
    const total = cacheable(st);
    return total > 0 ? +(st.cacheRead / total).toFixed(4) : null;
  };
  return {
    global: { ...global, cacheHitRate: rate(global) },
    session: s
      ? {
          turns: s.turns,
          messageCount: s.messageCount,
          violations: s.violations.length,
          lastViolation: s.violations[s.violations.length - 1] ?? null,
          cacheRead: s.cacheRead,
          cacheWrite: s.cacheWrite,
          inputTokens: s.inputTokens,
          cacheHitRate: rate(s),
          lastResetReason: s.lastResetReason ?? null,
        }
      : null,
    sessions: sessions.size,
  };
}

/** 会话结束时清理 */
export function forget(sessionKey) {
  sessions.delete(sessionKey);
}
