// config-adapter.mjs — 把 .env 适配到 OpenMozi config + 我们的 plugin lib
//
// 设计原则（L-029）：所有 env 注入必须在 import plugin 之前完成
//
// 适配目标：
// 1. OpenMozi config (loadConfig): providers.{minimax,deepseek,openai} + channels.{wecom,feishu,...} + server.port
// 2. 我们的 plugin lib: PG_* / SCHEDULER_* / JUNWUYOU_* / BGE_*

import fs from "node:fs";
import path from "node:path";

import { readRootEnvKey } from "./agents/junwuyou/lib/root-env.js";

/**
 * 读仓库根 `.env` 的键（P0 安全专项：token 的**唯一配置处**是根 `.env`，
 * 避免同一 token 在 openmozi/.env 与根 .env 两处各存一份而漂移）。
 * 复用共享实现（junwuyou/lib/root-env.js），不在此重复一份读文件逻辑（V-014）。
 */
function readRootEnvToken(name) {
  try { return readRootEnvKey(name) || ""; } catch { return ""; }
}

const ENV_PATH = process.env.OPENMOZI_ENV_PATH || path.join(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), ".env");

function loadEnv(envPath = ENV_PATH) {
  if (!fs.existsSync(envPath)) {
    console.warn(`[config-adapter] .env not found at ${envPath}`);
    return {};
  }
  const content = fs.readFileSync(envPath, "utf8");
  const env = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // 找第一个 =，前面是 key
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;

    // value 部分：按引号状态决定在哪里截断 + 是否剥行内 # 注释
    let value = line.slice(eq + 1);
    let inDouble = false, inSingle = false;
    let cutAt = value.length;
    for (let i = 0; i < value.length; i++) {
      const c = value[i];
      if (c === '"' && !inSingle) inDouble = !inDouble;
      else if (c === "'" && !inDouble) inSingle = !inSingle;
      else if (c === "#" && !inDouble && !inSingle && (i === 0 || /\s/.test(value[i - 1]))) {
        cutAt = i;
        break;
      }
    }
    value = value.slice(0, cutAt).trim();
    // 剥引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  console.log(`[config-adapter] Loaded ${Object.keys(env).length} vars from ${envPath}`);
  return env;
}

// 过滤占位符——必须是"明显是占位符"的值
// 之前的 /^sk-/ 会误判真实 sk- 开头 key（用户反馈：实际 key 可能是 sk-cp-Uhxxx 等）
// 现在改为"长度 + 内容明显是样例"的判定
function isPlaceholder(value) {
  if (!value || value.trim() === "") return true;
  // 显式的占位符关键字串
  if (/^(your_|MY_|PLACEHOLDER)/i.test(value)) return true;
  if (/^eyJ-your-/i.test(value)) return true;        // eyJ-your-xxxx（明显）
  if (value === "sk-your-openai-key-here") return true;
  if (value === "sk-your-deepseek-key-here") return true;
  // 包含 "your-" 或 "-here" 或 "your_"
  if (value.includes("your-") || value.includes("your_")) return true;
  if (value.includes("-here") || value.endsWith("_here")) return true;
  // 长度<20 判定：只针对明显是 token 的场景（用十六进制/字母数字密度判断）
  // L-033: 端口号、URL、简单字符串会被误判为占位符
  if (value.length < 20 && /^[a-z]+$/i.test(value)) return true;  // 纯短字母（无数字无特殊字符）→ 占位符
  // 含 URL 特征、IP、端口、@ 等业务形态的，<20 也不算占位符
  if (value.length < 20 && /^https?:\/\//i.test(value)) return false;
  if (value.length < 20 && /^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(value)) return false;
  if (value.length < 20 && /^\d+$/.test(value)) return false;     // 纯数字端口
  // 其他 <20 的、含数字/特殊字符的 → 不是占位符（避免误伤）
  if (value.length < 20) return false;
  return false;
}

function applyEnvToProcess(env) {
  // 只设置未设置的 env（避免覆盖用户已经在 shell 里设的）
  // L-033: 但 launcher 主动清掉的 placeholder（如 QQ_*），不应该被重新 apply
  // 通过 "loadEnv 重新读 .env 后，但 launcher 之前主动 delete 了"——这里 process.env[k] === undefined
  // 但应用会触发 channel 重新启用。
  // 解法：applyEnvToProcess 不再 apply QQ/WECOM/FEISHU/DINGTALK/EMAIL 这五个 channel 的 env
  // （launcher 的 disableChannelIfPlaceholder 才是唯一决定者）
  let applied = 0;
  const appliedKeys = [];
  const skipChannelPrefixes = ["QQ_", "WECOM_", "FEISHU_", "DINGTALK_", "EMAIL_"];
  for (const [k, v] of Object.entries(env)) {
    const isChannelEnv = skipChannelPrefixes.some((p) => k.startsWith(p));
    if (isChannelEnv) continue;  // 跳过 channel env（launcher 决定）
    if (process.env[k] === undefined && !isPlaceholder(v)) {
      process.env[k] = v;
      applied++;
      appliedKeys.push(k);
    }
  }
  console.log(`[config-adapter] Applied ${applied} vars to process.env (filtered ${Object.keys(env).length - applied - skipChannelPrefixes.reduce((acc, p) => acc + Object.keys(env).filter((k) => k.startsWith(p)).length, 0)} placeholders/empty + ${skipChannelPrefixes.length} channel-skipped)`);
  if (appliedKeys.length) console.log(`[config-adapter]   → ${appliedKeys.join(", ")}`);
}

/**
 * 把 .env 映射到 OpenMozi 的 config 形状
 * OpenMozi config 在 json5 中读 providers[providerId].apiKey / channels[channelId].* / server.port
 */
function envToMoziConfig(env) {
  const config = {
    providers: {},
    channels: {},
    server: {
      port: parseInt(env.OPENMOZI_PORT || "33000", 10),
      // P0.7（用户裁定 D-28「只在这台机器上开」）：**默认只监听回环**。
      // 原先默认 `0.0.0.0`，而本服务的 HTTP/WS（`/ws` 的 `chat.send`）**没有鉴权**，
      // 且 agent 手里有 `query_customer_profile`/`get_customer_appointments` 等工具 ——
      // 对全网卡开放等于同网段任何人可直连客服 agent 并读取客户档案。
      // 已全仓核查：所有调用方（网关、Express、各 harness/探针）走的都是 `127.0.0.1:33000`，
      // 无外部调用方。确需局域网访问时显式设 `OPENMOZI_HOST=0.0.0.0`（须先给该服务加鉴权）。
      host: env.OPENMOZI_HOST || "127.0.0.1",
    },
    agent: {
      defaultProvider: env.AGENT_DEFAULT_PROVIDER || "minimax",
      defaultModel: env.AGENT_DEFAULT_MODEL || "MiniMax-M3",
      temperature: parseFloat(env.AGENT_TEMPERATURE || "0.3"),
      maxTokens: parseInt(env.AGENT_MAX_TOKENS || "2048", 10),
      // 128K：配合 .pi/settings.json 的 reserveTokens=25600 → 压缩触发点 = 102400 = 80%
      contextWindow: parseInt(env.AGENT_CONTEXT_WINDOW || "128000", 10),
    },
    logging: { level: env.LOG_LEVEL || "info" },
    skills: {
      enabled: true,
      userDir: env.MOZI_SKILLS_USER_DIR || "C:/Users/Administrator/.mozi/skills",
    },
    plugins: {
      enabled: true,
      paths: env.MOZI_PLUGINS_PATH ? [env.MOZI_PLUGINS_PATH] : ["C:/Users/Administrator/.mozi/plugins"],
    },
  };

  // ===== LLM Providers =====
  // 主力：minimax（M3）
  if (!isPlaceholder(env.MINIMAX_API_KEY)) {
    // 如果用户指定的 model 不在 OpenMozi 内置列表（minimax: M2.1/M1/abab6.5s），用 custom-openai 通道
    // 否则用 OpenMozi 内置的 minimax provider（自动用预设 baseUrl）
    const builtinModels = ["MiniMax-M2.1", "MiniMax-M1", "abab6.5s-chat"];
    const requestedModel = env.MINIMAX_MODEL || "MiniMax-M3";
    const contextWindow = parseInt(env.AGENT_CONTEXT_WINDOW || "128000", 10);  // 与 agent.contextWindow 保持一致（128K）

    // M3 / 其他 reasoning 模型 → 用 custom-anthropic 通道（thinking/content 分离更干净）
    // 因为 OpenMozi 内置的 minimax 通道用 legacy "openai-completions" API，MiniMax 已 404
    const useAnthropicChannel = !builtinModels.includes(requestedModel) || requestedModel.includes("M3") || requestedModel.includes("M2");

    if (useAnthropicChannel) {
      // custom-anthropic：让 OpenMozi 用 Anthropic Messages API
      config.providers["custom-anthropic"] = {
        apiKey: env.MINIMAX_API_KEY,
        baseUrl: env.MINIMAX_ANTHROPIC_BASE_URL || "https://api.minimax.chat/anthropic/v1",
        models: [{ id: requestedModel, name: `MiniMax ${requestedModel}`, supportsTools: true, supportsReasoning: true, contextWindow }],
      };
      config.agent.defaultProvider = "custom-anthropic";
      config.agent.defaultModel = requestedModel;
    } else if (builtinModels.includes(requestedModel)) {
      config.providers.minimax = { apiKey: env.MINIMAX_API_KEY };
    } else {
      config.providers["custom-openai"] = {
        apiKey: env.MINIMAX_API_KEY,
        baseUrl: env.MINIMAX_BASE_URL || "https://api.minimax.chat/v1",
        models: [{ id: requestedModel, name: `MiniMax ${requestedModel}`, supportsTools: true, supportsReasoning: true, contextWindow }],
      };
      config.agent.defaultProvider = "custom-openai";
    }
    if (env.MINIMAX_GROUP_ID && !isPlaceholder(env.MINIMAX_GROUP_ID)) {
      const target = useAnthropicChannel ? "custom-anthropic" : (builtinModels.includes(requestedModel) ? "minimax" : "custom-openai");
      config.providers[target] = config.providers[target] || {};
      config.providers[target].headers = { "X-Group-Id": env.MINIMAX_GROUP_ID };
    }
  }

  // 兜底：deepseek
  if (!isPlaceholder(env.DEEPSEEK_API_KEY)) {
    config.providers.deepseek = {
      apiKey: env.DEEPSEEK_API_KEY,
      baseUrl: env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
      models: [{ id: env.DEEPSEEK_MODEL || "deepseek-chat" }],
    };
  }

  // 备用：openai
  if (!isPlaceholder(env.OPENAI_API_KEY)) {
    config.providers.openai = {
      apiKey: env.OPENAI_API_KEY,
      baseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      models: [{ id: env.OPENAI_MODEL || "gpt-4o-mini" }],
    };
  }

  // ===== IM Channels =====
  // 只有当 WECOM_ENABLED=true + 至少 CorpID 不是占位符时，才注入 channels.wecom
  // （OpenMozi schema 对 agentId 等字段强类型校验，字符串占位符会导致 NaN）
  if (env.WECOM_ENABLED === "true" && !isPlaceholder(env.WECOM_CORP_ID)) {
    config.channels.wecom = {
      corpId: env.WECOM_CORP_ID,
      corpSecret: env.WECOM_CORP_SECRET,
      agentId: parseInt(env.WECOM_AGENT_ID, 10),
      token: env.WECOM_TOKEN,
      encodingAESKey: env.WECOM_ENCODING_AES_KEY,
      callbackUrl: env.WECOM_CALLBACK_URL,
      welcomeMsg: env.WECOM_WELCOME_MSG,
    };
  }

  // ===== QQ 机器人（官方 API，WebSocket 长连接，无需公网部署）=====
  // QQConfig: { appId, clientSecret, enabled?, sandbox?, account? }
  if (env.QQ_ENABLED === "true" && !isPlaceholder(env.QQ_APP_ID)) {
    config.channels.qq = {
      appId: env.QQ_APP_ID,
      clientSecret: env.QQ_CLIENT_SECRET,
      enabled: true,
      sandbox: env.QQ_SANDBOX === "true",
      // P4（D13）：账号标识 → agentRoute = `qq:<account>`。
      // 缺省回退 appId（单账号配置零改动即拿到稳定路由键）。
      account: env.QQ_ACCOUNT || env.QQ_APP_ID,
    };
  }

  // ===== P4：附加渠道账号（多账号 → 多 agent，D13）=====
  // 约定（确定性，不靠约定俗成）：
  //   QQ_ACCOUNT<N>_*（N 从 2 起）＝ 第 N 个 QQ 账号；`_ENABLED=true` 且 appId 非占位符才注入。
  //   account 段（`qq:<account>`）优先用 `QQ_ACCOUNT<N>_ACCOUNT`，缺省用 appId。
  // 未配置任何附加账号时 `accounts` 为空 → 网关不装配额外通道 → 线上零影响（U-4 回滚前提）。
  const accounts = { wecom: [], email: [] };
  const qqAccounts = [];
  for (let n = 2; n <= 9; n++) {
    const idKey = `QQ_ACCOUNT${n}_APP_ID`;
    const secretKey = `QQ_ACCOUNT${n}_CLIENT_SECRET`;
    const enabled = env[`QQ_ACCOUNT${n}_ENABLED`] === "true";
    const appId = env[idKey];
    if (!appId || isPlaceholder(appId)) continue;
    if (!enabled) {
      console.log(`[config-adapter] QQ 附加账号 #${n} 已配置 appId 但 QQ_ACCOUNT${n}_ENABLED≠true → 不注入（避免半配置状态）`);
      continue;
    }
    qqAccounts.push({
      appId,
      clientSecret: env[secretKey],
      enabled: true,
      sandbox: env[`QQ_ACCOUNT${n}_SANDBOX`] === "true",
      account: env[`QQ_ACCOUNT${n}_ACCOUNT`] || appId,
    });
    console.log(`[config-adapter] QQ 附加账号 #${n} → route qq:${env[`QQ_ACCOUNT${n}_ACCOUNT`] || appId}`);
  }
  if (qqAccounts.length) accounts.qq = qqAccounts;
  config.channels.accounts = accounts;

  // ===== 邮件渠道（P0.6 自研；D-17/D-21/D-33）=====
  // 与 QQ/企微同一开关语义：只有 EMAIL_ENABLED=true 且账号不是占位符才注入。
  // 邮件交互范式与 IM 不同 → **独立 SLA**（小时级）与正式语气（见 prompt 后缀）。
  if (env.EMAIL_ENABLED === "true" && !isPlaceholder(env.EMAIL_IMAP_USER) && !isPlaceholder(env.EMAIL_SMTP_USER)) {
    config.channels.email = {
      imapHost: env.EMAIL_IMAP_HOST || "imap.qq.com",
      imapPort: parseInt(env.EMAIL_IMAP_PORT || "993", 10),
      imapUser: env.EMAIL_IMAP_USER,
      imapPassword: env.EMAIL_IMAP_PASSWORD,
      imapSecure: env.EMAIL_IMAP_SECURE !== "false",
      smtpHost: env.EMAIL_SMTP_HOST || "smtp.qq.com",
      smtpPort: parseInt(env.EMAIL_SMTP_PORT || "465", 10),
      smtpUser: env.EMAIL_SMTP_USER,
      smtpPassword: env.EMAIL_SMTP_PASSWORD,
      smtpSecure: env.EMAIL_SMTP_SECURE !== "false",
      pollIntervalSec: parseInt(env.EMAIL_POLL_INTERVAL || "30", 10),
      slaMinutes: parseInt(env.EMAIL_SLA_MINUTES || "240", 10),
      fromName: env.EMAIL_FROM_NAME || "君无忧客服",
      sinceIso: env.EMAIL_SINCE || undefined,
      enabled: true,
    };
  }

  // 飞书 / 钉钉 类似（暂未实施）
  return config;
}

/**
 * 把 .env 注入到 plugin lib 用的 process.env
 * （pg-client.js / embedding.js / scheduler-client.js / junwuyou-client.js）
 */
function envToPluginEnv(env) {
  const mapping = {
    PG_HOST: env.PG_HOST || "127.0.0.1",
    PG_PORT: env.PG_PORT || "35432",
    PG_USER: env.PG_USER || "openmozi",
    PG_PASSWORD: env.PG_PASSWORD,
    PG_DATABASE: env.PG_DATABASE || "openmozi",
    SCHEDULER_API_URL: env.SCHEDULER_API_URL || "http://127.0.0.1:35801",
    // P0（D-24）：分组 token。**规范键名 SCHEDULER_API_TOKEN**（配置契约先于实现迁移，
    // spec-p0.md §6）；兼容旧键 SCHEDULER_API_KEY。取值优先根 .env（唯一配置处），
    // **不设任何默认/占位值**——旧默认 "dev_only_token_replace_in_prod" 是有害的：
    // 环境注入失败时会带着假凭据调用，失败表现为 401 而不是"配置缺失"（L-078 同族）。
    SCHEDULER_API_TOKEN: env.SCHEDULER_API_TOKEN || env.SCHEDULER_API_KEY
      || readRootEnvToken("SCHEDULER_API_TOKEN") || readRootEnvToken("SCHEDULER_API_KEY"),
    JUNWUYOU_API_URL: env.JUNWUYOU_API_URL || "http://127.0.0.1:53000",
    JUNWUYOU_ADMIN_TOKEN: env.JUNWUYOU_ADMIN_TOKEN,
    BGE_EMBED_PATH: env.BGE_EMBED_PATH,
    BGE_RERANK_PATH: env.BGE_RERANK_PATH,
  };
  for (const [k, v] of Object.entries(mapping)) {
    if (v !== undefined && !isPlaceholder(String(v)) && process.env[k] === undefined) {
      process.env[k] = v;
    }
  }
}

export function loadAndApply(envPath) {
  const env = loadEnv(envPath);
  // L-033: 如果 process.env 已经被 launcher 清掉（如 QQ/WECOM 占位符），不要重新 apply
  // applyEnvToProcess 的 "process.env[k] === undefined" 检查已经处理；但需要让 launcher 先清掉再调我们
  applyEnvToProcess(env);
  envToPluginEnv(env);
  return { env, moziConfig: envToMoziConfig(env) };
}

/**
 * P4：解析多 agent 装配计划（`AGENT_IDS` / `AGENT_ROUTES`）。
 *
 * 为什么放在 config-adapter：它属于"配置 → 运行形态"的映射，与渠道账号解析同一层；
 * 启动器只管按计划装配，不再自己解析配置（避免两处各解析一遍，V-014）。
 *
 * - `AGENT_IDS`：装配哪些 agent，**第一个是默认 agent**（缺 route 的消息走它）。
 *   缺省 `junwuyou`（线上现状：单 agent、行为不变）。
 * - `AGENT_ROUTES`：`<route>=<agentId>`，逗号分隔；route 形如 `qq:<appId>`。
 *   缺省只按描述符自己声明的 accountRoutes 走。
 */
export function readAgentAssemblyPlan(env = {}) {
  const idsRaw = String(process.env.AGENT_IDS || env.AGENT_IDS || "junwuyou").trim();
  const agentIds = idsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (agentIds.length === 0) agentIds.push("junwuyou");
  for (const id of agentIds) {
    if (!/^[a-z0-9_-]+$/.test(id)) {
      throw new Error(`AGENT_IDS 含非法 agentId：${JSON.stringify(id)}（只允许 [a-z0-9_-]）`);
    }
  }
  if (new Set(agentIds).size !== agentIds.length) {
    throw new Error(`AGENT_IDS 有重复项：${agentIds.join(",")}`);
  }

  const routesRaw = String(process.env.AGENT_ROUTES || env.AGENT_ROUTES || "").trim();
  const routes = {};
  for (const pair of routesRaw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf("=");
    if (i <= 0) throw new Error(`AGENT_ROUTES 条目形态应为 <route>=<agentId>，收到 ${JSON.stringify(pair)}`);
    const route = pair.slice(0, i).trim();
    const agentId = pair.slice(i + 1).trim();
    if (!route.includes(":")) throw new Error(`AGENT_ROUTES 的 route 应形如 <channelId>:<accountId>，收到 ${JSON.stringify(route)}`);
    routes[route] = agentId;
  }
  return { agentIds, routes };
}

export { loadEnv, applyEnvToProcess, envToMoziConfig, envToPluginEnv };
