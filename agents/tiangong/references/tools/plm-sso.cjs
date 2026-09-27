#!/usr/bin/env node
'use strict';
/**
 * plm-sso.cjs · PLM 客服 creature 的**登录器官**（.env 凭据 → 真浏览器 SSO → access/refresh token）
 *
 * <h3>为什么必须走真浏览器（不是"偷懒"，是环境的硬约束）</h3>
 * UAT（`https://120.25.103.162:8722`）已按 SF-U07 **关闭 `plm-web` 的 direct access grant**：
 *   `POST /realms/plm/protocol/openid-connect/token` 带 `grant_type=password` → `400 unauthorized_client
 *    "Client not allowed for direct access grants"`（本仓 2026-09-27 实测复现）。
 * 剩下的合法路径只有**授权码流（Authorization Code + PKCE）**，而授权码流必经 Keycloak 登录页表单
 * —— 于是"脚本直连不可用"不是文档口径，是实测事实。因此本模块用 CDP 驱动 headless Chrome
 * 完成一次**真表单登录**，从 Keycloak 的 `/token` 响应体里取 token（不看平台内部存储，跨刷新稳定）。
 *
 * <h3>三条纪律（每条都由一次真实故障换来）</h3>
 *   ① **复用优先、绝不杀别人的浏览器**：:9222 上可能已有其他走查脚本的 headless Chrome
 *      （plm-harness 用同一端口）。端口被占 → 附着并在**自己的新标签页**上工作（按 sessionId 过滤
 *      CDP 事件），用完只关自己创建的 target；端口空闲 → 自己起一个（自己起的才由自己 kill）。
 *   ② **CDP 调用一律带超时**：不设超时的 CDP 调用在浏览器卡死时会**永久挂住**，而且"挂住"会被
 *      上层误读成"还在跑"（比报错更贵）。超时即抛，由调用方判红。
 *   ③ **口令零回显、零落盘**：口令只从 `.env` 读进内存、只经 CDP 的 DOM 赋值写入页面；
 *      token 缓存只在工作区 `.creature/.cache/`（gitignored）且只含 token，不含口令。
 *
 * <h3>对外接口</h3>
 *   loadConfig(cwd)            读 .env + 环境变量 → 配置对象（口令不回显）
 *   getToken(cfg, opts)        取 access token（缓存 → refresh_token 续期 → 完整 SSO 登录）
 *   probeLogin(cfg)            只做一次完整 SSO 登录并返回身份声明（自检用）
 *   plmFetch(cfg, path, opts)  带 Bearer 调 /api/v1（401 时自动重新取一次 token 重试一次）
 */

const http = require('node:http');
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 本进程启动过的浏览器端口——只有这些才允许复用，也只有这些才由我们回收。 */
const ownedBrowsers = new Set();
const CHROME_CANDIDATES = [
  process.env.PLM_CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

// ============================================================ 配置

/** 向上找工作区根：含 `.env` 或 `.creature/` 的最近祖先；找不到就用 cwd。 */
function findWorkspaceRoot(start = process.cwd()) {
  let d = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, '.env')) || fs.existsSync(path.join(d, '.creature'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return path.resolve(start);
}

/** 解析 .env（不引依赖；`#` 注释、`KEY=VALUE`、容忍引号）。 */
function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

/**
 * 读配置。优先级：显式 env（进程环境变量）> `.env` > 默认值。
 * **口令不进返回值以外的任何地方**（不回显、不写日志、不进缓存）。
 */
function loadConfig(cwd = process.cwd()) {
  const root = findWorkspaceRoot(cwd);
  const envFile = path.join(root, '.env');
  const fileEnv = parseEnvFile(envFile);
  const pick = (k, dflt) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : (fileEnv[k] !== undefined && fileEnv[k] !== '' ? fileEnv[k] : dflt));
  const cacheRel = pick('PLM_SESSION_CACHE', '.creature/.cache/plm-session.json');
  return {
    root,
    envFile,
    envFileExists: fs.existsSync(envFile),
    base: String(pick('PLM_WEB_BASE', 'https://120.25.103.162:8722')).replace(/\/+$/, ''),
    realm: pick('PLM_REALM', 'plm'),
    clientId: pick('PLM_CLIENT_ID', 'plm-web'),
    user: pick('PLM_USER', 'robinzeng'),
    password: pick('PLM_PASSWORD', ''),                 // ⚠ 只在内存
    defaultProjectId: Number(pick('PLM_DEFAULT_PROJECT_ID', '0')) || null,
    sourceChannel: pick('PLM_SOURCE_CHANNEL', 'CUSTOMER'),
    chromePath: pick('PLM_CHROME_PATH', ''),
    headless: pick('PLM_HEADLESS', '1') !== '0',
    cdpPort: Number(pick('PLM_CDP_PORT', '9222')),
    cdpDedicatedPort: Number(pick('PLM_CDP_DEDICATED_PORT', '9334')),
    sessionCache: cacheRel === '0' ? null : path.resolve(root, cacheRel),
    tokenSkew: Number(pick('PLM_TOKEN_SKEW', '120')),
    apiPrefix: '/api/v1',
  };
}

/** 供日志/诊断使用：不含口令的配置摘要。 */
function describeConfig(cfg) {
  return {
    root: cfg.root,
    envFile: cfg.envFile,
    envFileExists: cfg.envFileExists,
    base: cfg.base,
    realm: cfg.realm,
    clientId: cfg.clientId,
    user: cfg.user,
    passwordSet: Boolean(cfg.password),
    passwordLength: cfg.password ? cfg.password.length : 0,
    defaultProjectId: cfg.defaultProjectId,
    cdpPort: cfg.cdpPort,
    headless: cfg.headless,
    sessionCache: cfg.sessionCache,
  };
}

// ============================================================ 极简 CDP 客户端

function getJson(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('devtools http timeout')));
  });
}

async function browserUp(port) {
  try { await getJson(`http://127.0.0.1:${port}/json/version`, 1500); return true; } catch { return false; }
}

/**
 * 极简 CDP 客户端（扁平会话：所有命令带 `sessionId`）。
 * `send` **必须带超时**——见文件头纪律②。
 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Set();
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(`CDP ${p.method} 失败: ${JSON.stringify(m.error)}`));
        else p.resolve(m.result);
      } else if (m.method) {
        for (const h of this.handlers) { try { h(m); } catch { /* 单个订阅者异常不影响其他 */ } }
      }
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 20000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时（${timeoutMs}ms）：${method}（浏览器可能已卡死）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
}

/** 在某个 target 上的会话包装（事件按 sessionId 过滤，避免串台）。 */
class Session {
  constructor(cdp, sessionId) { this.cdp = cdp; this.sessionId = sessionId; }
  send(m, p, t) { return this.cdp.send(m, p, this.sessionId, t); }
  on(fn) { return this.cdp.on((msg) => { if (msg.sessionId === this.sessionId) fn(msg); }); }
  waitEvent(method, pred, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`等待 CDP 事件超时：${method}`)); }, timeoutMs);
      const off = this.on((msg) => {
        if (msg.method === method && (!pred || pred(msg.params))) { clearTimeout(timer); off(); resolve(msg.params); }
      });
    });
  }
  async eval(expression, timeoutMs = 15000) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (r && r.exceptionDetails) throw new Error(`页面求值异常：${r.exceptionDetails.text || JSON.stringify(r.exceptionDetails).slice(0, 200)}`);
    return r && r.result ? r.result.value : undefined;
  }
  async until(expression, timeoutMs = 20000, pollMs = 400) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try { if (await this.eval(expression)) return true; } catch { /* 求值失败按未就绪处理 */ }
      if (Date.now() > end) return false;
      await sleep(pollMs);
    }
  }
}

function wsConnect(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP WebSocket 连接超时')); }, timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error(`CDP WebSocket 连接失败：${e && e.message || 'unknown'}`)); });
  });
}

// ============================================================ 浏览器生命周期（复用优先）

/**
 * 复用前先验"**能不能用**"，而不是只看"在不在"。
 *
 * <h3>为什么（一次真实故障）</h3>
 * `:9222` 上常驻着另一个走查 harness 起的 headless Chrome（`plm-harness` 用同一端口），
 * 它**没带 `--ignore-certificate-errors`**。UAT 是**自签证书** ⇒ 复用它打开
 * `https://120.25.103.162:8722/` 会停在证书拦截页（headless 下**无人可点"继续"**），
 * 于是"等登录表单"永久等待——**表现为静默挂死**（实测 2026-09-27：login 卡在
 * "打开 … 触发 SSO…" 之后无任何输出）。
 * 早先的 9222 探测脚本带了 `--ignore-certificate-errors` 所以能跑通 ⇒ **"端口在"不等于"能用"**，
 * 这是一个典型的"假可用"陷阱：复用省下的几秒钟，代价是整轮任务挂死。
 *
 * 判据：`/json/version` 的 `Browser` 字段含 `Headless` 却由**外部**启动时，无法证明它带了我们的
 * 证书参数 ⇒ 视为不可用，改在**专用端口**起自己的实例（自己的实例参数由我们说了算，且用完能回收）。
 */
async function browserUsable(port, ownInfo) {
  try {
    const ver = await getJson(`http://127.0.0.1:${port}/json/version`, 2000);
    if (!ownInfo) {
      // 外部浏览器：无法确认启动参数（尤其证书忽略）。用 DevTools 的 UA 做弱判据 + 直接试一次导航。
      return { usable: false, reason: `:${port} 上是外部启动的浏览器（${ver.Browser || 'unknown'}），无法确认它带 --ignore-certificate-errors（UAT 自签证书会卡在拦截页）` };
    }
    return { usable: true, version: ver };
  } catch (e) {
    return { usable: false, reason: `:${port} 不可达（${e.message}）` };
  }
}

/**
 * 拿到一个可用的浏览器句柄。
 * 返回 `{ cdp, port, ownBrowser:boolean, child|null, profile|null }`。
 * **复用已有 :port 时绝不 kill**；只有自己起的才回收。
 *
 * 策略（两级）：① `PLM_CDP_PORT`（默认 9222）上若有**本工具自己**留下的实例 → 复用；
 * ② 否则在 `PLM_CDP_DEDICATED_PORT`（默认 9334）起一个专用 headless 实例（带证书忽略参数）。
 * 为什么不用"先起再撞"：外部实例无法证明其启动参数，**宁可多一个自己的实例，也不要一次静默挂死**。
 */
async function ensureBrowser(cfg, { port = cfg.cdpPort, log = () => {} } = {}) {
  const probe = await browserUsable(port, ownedBrowsers.has(port));
  if (probe.usable) {
    log(`复用本工具已在运行的浏览器 :${port}（${probe.version.Browser || 'unknown'}）——不会关闭它`);
    const ws = await wsConnect(probe.version.webSocketDebuggerUrl);
    return { cdp: new CDP(ws), port, ownBrowser: false, child: null, profile: null };
  }
  if (await browserUp(port)) {
    const dedicated = Number(cfg.cdpDedicatedPort || 9334);
    log(`:${port} 上的浏览器不可复用：${probe.reason}`);
    log(`改在专用端口 :${dedicated} 启动独立实例（证书忽略参数由本工具保证）`);
    return ensureBrowser(cfg, { port: dedicated, log });
  }
  const exe = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!exe) throw new Error(`未找到可用的 Chrome/Edge。候选：${CHROME_CANDIDATES.join(' , ')}（可用 PLM_CHROME_PATH 指定）`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'plm-cs-chrome-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--ignore-certificate-errors',            // UAT 是自签证书
    '--window-size=1400,900',
  ];
  if (cfg.headless) args.unshift('--headless=new');
  args.push('about:blank');
  const child = spawn(exe, args, { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { await sleep(500); if (await browserUp(port)) break; }
  if (!(await browserUp(port))) { try { child.kill(); } catch {} throw new Error(`Chrome DevTools 端口 ${port} 未就绪（20s 轮询超时）`); }
  ownedBrowsers.add(port);                    // 只有到这里才承认"是我们起的"
  const ver = await getJson(`http://127.0.0.1:${port}/json/version`);
  const ws = await wsConnect(ver.webSocketDebuggerUrl);
  log(`已启动独立 headless 浏览器 :${port}（profile=${profile}）`);
  return { cdp: new CDP(ws), port, ownBrowser: true, child, profile };
}

/** 用完回收：只关自己创建的 target；只有自己起的浏览器才 kill（并清理临时 profile）。 */
async function closeBrowser(bh, { targetId = null, log = () => {} } = {}) {
  try {
    if (bh.cdp && targetId) await bh.cdp.send('Target.closeTarget', { targetId }, undefined, 5000);
  } catch { /* 关标签页失败不致命 */ }
  try { if (bh.cdp) bh.cdp.ws.close(); } catch {}
  if (bh.ownBrowser) {
    try { if (bh.child) bh.child.kill(); } catch {}
    try { if (bh.profile) fs.rmSync(bh.profile, { recursive: true, force: true }); } catch {}
    log(`已关闭自建浏览器 :${bh.port}`);
  } else {
    log(`保留复用的浏览器 :${bh.port}（不是本进程启动的）`);
  }
}

/** 杀掉占用 :port 的**孤儿**浏览器（上游任务崩了留下的陈旧 headless Chrome）。 */
function killOrphanBrowser(port) {
  const killed = [];
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano -p TCP | findstr LISTENING | findstr :${port}`, { encoding: 'utf8', timeout: 6000 });
      const pids = new Set(out.split(/\r?\n/).map((l) => (l.trim().split(/\s+/).pop() || '')).filter((x) => /^\d+$/.test(x) && x !== '0'));
      for (const pid of pids) {
        try {
          execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore', timeout: 8000 });
          killed.push(pid);
        } catch { /* 权限不足或已退出 */ }
      }
    } else {
      const out = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8', timeout: 6000 });
      for (const pid of out.split(/\s+/).filter(Boolean)) {
        try { process.kill(Number(pid), 'SIGKILL'); killed.push(pid); } catch {}
      }
    }
  } catch { /* 没占用就是好事 */ }
  return killed;
}

// ============================================================ SSO 登录（真表单 + 捕获 /token 响应体）

const KC_LOGIN_FORM = `document.querySelector('input[name=username],#username')`;
const KC_PASS_FORM = `document.querySelector('input[name=password],#password')`;

/**
 * 走一次完整 SSO 授权码流：打开应用 → Keycloak 登录页 → 填表提交 → 捕获 `/token` 响应体。
 * 返回 `{ access_token, refresh_token, expires_in, refresh_expires_in, id_token, claims, capturedAt }`。
 * **任何一步失败即抛**（不返回半成品 token）。
 */
async function ssoLogin(cfg, { log = () => {}, timeoutMs = 60000 } = {}) {
  if (!cfg.password) {
    throw new Error(`未配置口令：请在工作区 ${cfg.envFile} 写入 PLM_PASSWORD=…（当前 PLM_USER=${cfg.user}）`);
  }
  const bh = await ensureBrowser(cfg, { log });
  let targetId = null;
  let session = null;
  try {
    // 只在自己的新标签页上工作——即使复用的是别人的浏览器，也不污染它的页面
    const created = await bh.cdp.send('Target.createTarget', { url: 'about:blank' }, undefined, 15000);
    targetId = created.targetId;
    const attached = await bh.cdp.send('Target.attachToTarget', { targetId, flatten: true }, undefined, 15000);
    session = new Session(bh.cdp, attached.sessionId);

    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Network.enable');

    // 捕获 Keycloak /token 响应体（跨 Keycloak 版本稳定：不看平台内部存储）
    let token = null;
    let tokenBodyError = null;
    session.on((msg) => {
      if (msg.method !== 'Network.responseReceived') return;
      const url = msg.params.response.url || '';
      if (!/\/protocol\/openid-connect\/token/.test(url)) return;
      session.send('Network.getResponseBody', { requestId: msg.params.requestId }, 10000)
        .then((r) => { try { token = JSON.parse(r.body); } catch (e) { tokenBodyError = `token 响应体不是 JSON：${e.message}`; } })
        .catch((e) => { tokenBodyError = `取 token 响应体失败：${e.message}`; });
    });

    log(`打开 ${cfg.base}/ 触发 SSO…`);
    await session.send('Page.navigate', { url: `${cfg.base}/` }, undefined, 20000);

    /**
     * 点位判定必须在**登录表单真的存在**时做，不能在导航刚 commit 时做。
     * 实测坑（2026-09-27，一次静默挂死）：`Page.navigate` 在 nginx 返回首页时就已 resolve，
     * 而首页 JS 稍后才 302 到 Keycloak。若此时读 `location.href`，会看到"还在应用站点"⇒ 误判
     * "已是登录态"⇒ 跳过填表 ⇒ 外层白等到超时，报出一句与真因无关的话。
     * 对策：**先等站点切走（进入 /realms/）或表单出现**，再决定要不要填表。
     */
    const loginStarted = await session.until(
      `location.href.includes('/realms/') || !!${KC_LOGIN_FORM}`,
      Math.min(timeoutMs, 45000), 400);

    let href = await session.eval('location.href');
    let didFill = false;
    if (loginStarted) {
      if (!(await session.until(`!!${KC_LOGIN_FORM}`, 20000))) {
        const diag = await session.eval(`JSON.stringify({
          href: location.href,
          inputs: [...document.querySelectorAll('input')].map((e)=>({name:e.name,id:e.id,type:e.type})),
          forms: [...document.querySelectorAll('form')].map((f)=>f.id||'(no-id)'),
          readyState: document.readyState,
        })`).catch((e) => `诊断取值失败：${e.message}`);
        throw new Error(`Keycloak 登录页未渲染出用户名输入框（URL=${href}）诊断=${diag}`);
      }
      const filled = await session.eval(`(()=>{
        const u=${KC_LOGIN_FORM}; const p=${KC_PASS_FORM};
        if(!u||!p) return 'missing-field';
        const set=(el,v)=>{ el.focus(); el.value=v;
          el.dispatchEvent(new Event('input',{bubbles:true}));
          el.dispatchEvent(new Event('change',{bubbles:true})); };
        set(u, ${JSON.stringify(cfg.user)});
        set(p, ${JSON.stringify(cfg.password)});
        return 'filled';
      })()`);
      if (filled !== 'filled') throw new Error(`登录表单填充失败：${filled}`);
      log(`提交登录表单（用户 ${cfg.user}）…`);
      const submitted = await session.eval(`(()=>{
        const f=document.querySelector('#kc-form-login')||document.querySelector('form');
        if(!f) return 'no-form';
        if(f.requestSubmit) f.requestSubmit(); else f.submit();
        return 'submitted';
      })()`);
      if (submitted === 'no-form') throw new Error('Keycloak 登录页找不到 form，无法提交');
      didFill = true;
    } else {
      // 45s 内既没进 /realms/ 也没出现表单：要么已登录，要么站点根本不可达——超时信息里必须能区分
      const body = await session.eval('(document.body&&document.body.innerText||"").slice(0,200)').catch(() => '');
      log(`未观察到 SSO 跳转（当前 URL=${href}，页面片段=${String(body).replace(/\s+/g, ' ').slice(0, 120)}）——按"已登录态"继续尝试捕获 token`);
    }

    // 等 token 或明确的失败页
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (token && token.access_token) break;
      const err = await session.eval(`(()=>{const e=document.querySelector('.alert-error,#input-error,.pf-c-alert__title,.kc-feedback-text'); return e?(e.innerText||'').trim().slice(0,200):'';})()`).catch(() => '');
      if (err) throw new Error(`Keycloak 登录被拒：${err}`);
      href = await session.eval('location.href').catch(() => href);
      if (tokenBodyError && !token) throw new Error(tokenBodyError);
      if (Date.now() > deadline) {
        const body = await session.eval('(document.body&&document.body.innerText||"").slice(0,300)').catch(() => '');
        throw new Error(`等待 SSO token 超时（>${Math.round(timeoutMs / 1000)}s，${didFill ? '已提交登录表单' : '未观察到登录表单'}）。当前 URL=${href} 页面片段=${String(body).replace(/\s+/g, ' ')}`);
      }
      await sleep(500);
    }
    if (!token.access_token) throw new Error('token 响应里没有 access_token');

    const claims = decodeJwt(token.access_token);
    log(`登录成功：sub=${claims.sub} user=${claims.preferred_username} 角色=${(claims.realm_access && claims.realm_access.roles || []).join(',') || '(无 realm_access)'}`);
    return { ...token, claims, capturedAt: Date.now() };
  } finally {
    await closeBrowser(bh, { targetId, log: () => {} });
  }
}

/** 解 JWT 载荷（不验签：只用于读身份与过期时间；验签由服务端做）。 */
function decodeJwt(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length < 2) return {};
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return {}; }
}

// ============================================================ 会话缓存与令牌续期

function readSession(cfg) {
  if (!cfg.sessionCache || !fs.existsSync(cfg.sessionCache)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(cfg.sessionCache, 'utf8'));
    if (!s || !s.access_token) return null;
    if (s.user && s.user !== cfg.user) return null;   // 身份换过 ⇒ 缓存作废（防"以别人的身份登记"）
    if (s.base && s.base !== cfg.base) return null;   // 环境换过 ⇒ 缓存作废
    return s;
  } catch { return null; }
}

function writeSession(cfg, tok) {
  if (!cfg.sessionCache) return;
  try {
    fs.mkdirSync(path.dirname(cfg.sessionCache), { recursive: true });
    const payload = {
      user: cfg.user, base: cfg.base, clientId: cfg.clientId,
      access_token: tok.access_token, refresh_token: tok.refresh_token || null,
      expires_in: tok.expires_in || null, capturedAt: tok.capturedAt || Date.now(),
      claims: tok.claims ? { sub: tok.claims.sub, preferred_username: tok.claims.preferred_username, roles: (tok.claims.realm_access || {}).roles || [] } : undefined,
    };
    fs.writeFileSync(cfg.sessionCache, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (e) { /* 缓存写失败不影响主流程 */ }
}

function tokenExpiryMs(tok) {
  const claims = tok.claims || decodeJwt(tok.access_token);
  if (claims && claims.exp) return claims.exp * 1000;
  if (tok.capturedAt && tok.expires_in) return tok.capturedAt + tok.expires_in * 1000;
  return 0;
}

async function tokenEndpoint(cfg, form) {
  const res = await fetch(`${cfg.base}/realms/${cfg.realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

/**
 * 取 access token。三级策略（越靠前越便宜）：
 *   ① 缓存且未过期 → 直接用（召回≈0，对应电容器 L1）；
 *   ② 有 refresh_token → 走 refresh grant 续期（不弹浏览器、不碰口令）；
 *   ③ 兜底 → 完整 SSO 真表单登录（最贵，但必然可用）。
 * `force=true` 跳过 ①②（自检/排障用）。
 */
async function getToken(cfg, { force = false, log = () => {} } = {}) {
  const cached = readSession(cfg);
  const skewMs = (cfg.tokenSkew || 120) * 1000;

  if (!force && cached) {
    const exp = tokenExpiryMs(cached);
    if (exp && Date.now() + skewMs < exp) {
      log(`使用缓存的 access token（剩余 ${Math.round((exp - Date.now()) / 1000)}s）`);
      return { access_token: cached.access_token, source: 'cache', claims: decodeJwt(cached.access_token) };
    }
    if (cached.refresh_token) {
      log('缓存 token 已过期，尝试 refresh grant 续期…');
      const r = await tokenEndpoint(cfg, {
        grant_type: 'refresh_token', refresh_token: cached.refresh_token, client_id: cfg.clientId,
      });
      if (r.status === 200 && r.json && r.json.access_token) {
        log('refresh 成功（未弹浏览器）');
        const tok = { ...r.json, capturedAt: Date.now() };
        writeSession(cfg, tok);
        return { access_token: tok.access_token, source: 'refresh', claims: decodeJwt(tok.access_token) };
      }
      log(`refresh 失败（http=${r.status} ${String(r.json && r.json.error || r.text).slice(0, 80)}），转完整 SSO 登录`);
    }
  }

  const tok = await ssoLogin(cfg, { log });
  writeSession(cfg, tok);
  return { access_token: tok.access_token, source: 'sso', claims: tok.claims, raw: tok };
}

/** 只做一次完整 SSO 登录（自检用：验证凭据与环境仍然可用，且返回身份声明）。 */
async function probeLogin(cfg, { log = () => {} } = {}) {
  const tok = await ssoLogin(cfg, { log });
  const claims = tok.claims || {};
  return {
    ok: true,
    user: claims.preferred_username,
    sub: claims.sub,
    realmRoles: (claims.realm_access || {}).roles || [],
    expiresInSec: tok.expires_in,
    issuer: claims.iss,
  };
}

/** 带 Bearer 调 PLM API。401 时**重新取一次** token 并重试一次（token 过期是最常见的瞬时失败）。 */
async function plmFetch(cfg, apiPath, { method = 'GET', body = null, token = null, retryOn401 = true, timeoutMs = 30000, headers = {}, log = () => {} } = {}) {
  let tk = token;
  if (!tk) tk = (await getToken(cfg, { log })).access_token;
  const url = apiPath.startsWith('http') ? apiPath : `${cfg.base}${cfg.apiPrefix}${apiPath}`;
  const doCall = () => fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${tk}`,
      Accept: 'application/json',
      ...(body !== null ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      ...headers,
    },
    ...(body !== null ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let res = await doCall();
  if (res.status === 401 && retryOn401) {
    log('API 返回 401，重新取 token 后重试一次…');
    tk = (await getToken(cfg, { force: true, log })).access_token;
    res = await doCall();
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（如 CSV 导出） */ }
  return { ok: res.ok, status: res.status, json, text, url, headers: res.headers };
}

module.exports = {
  loadConfig, describeConfig, findWorkspaceRoot, parseEnvFile,
  ensureBrowser, closeBrowser, killOrphanBrowser, CDP, Session,
  ssoLogin, getToken, probeLogin, plmFetch, decodeJwt, tokenExpiryMs, tokenEndpoint,
  readSession, writeSession, browserUp,
};
