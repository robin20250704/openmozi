/**
 * P0 安全专项验收 harness —— 断言 A16a–A16j 的可执行镜像
 * （规格：`.creature/tasks/cs-platform-framework/spec-p0.md` §4）
 *
 * 设计原则：
 * 1. **真实路径**：全部走真实 HTTP + 真实进程，不用 mock 替身；
 *    只有"fail-closed 启动"与"ALLOW_INSECURE 放行"必须起**隔离实例**（否则等于停线上服务做实验）。
 * 2. **隔离实验**：隔离实例自带临时 cwd（只放一份 config.toml 副本）+ 临时 SQLite + 独立端口，
 *    不碰生产库、不碰线上进程。
 * 3. **凭据从根 `.env` 读**（唯一配置处），harness 内不出现任何 token 字面量；
 *    `A16i` 反过来断言 token **不**出现在响应体、日志、/health 里。
 * 4. 子进程输出**落文件**（不用管道，避免受限沙箱下的 EPERM，且失败可回看）。
 *
 * 运行：
 *   node scripts/verify-p0-auth.mjs            # 全量（含 E2E 回归，耗时数分钟）
 *   node scripts/verify-p0-auth.mjs --quick    # 跳过 A16h 的 E2E 回归子套件
 * 退出码：0 = 全绿；1 = 有失败
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { resolveApiToken, ROOT_ENV_PATH } from '../junwuyou/lib/root-env.js';

// scripts/ → openmozi → runtime → 仓库根
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const GW = process.env.SCHEDULER_API_URL || 'http://127.0.0.1:35801';
const EXPRESS = process.env.JUNWUYOU_API_URL || 'http://127.0.0.1:53000';
const GATEWAY_BIN = path.join(ROOT, 'target', 'release', 'wecom-gateway.exe');
const QUICK = process.argv.includes('--quick');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-auth-'));
// 隔离实例的 cwd：只放一份 config.toml 副本（无 .env → 凭据只能来自我们显式注入的 env）
const ISOLATED_CWD = path.join(TMP, 'gw');
fs.mkdirSync(ISOLATED_CWD, { recursive: true });
const GW_TEST_PORT = Number(process.env.P0_GW_TEST_PORT || 53930);
// 端口必须改在**副本**上：直接依赖 env 覆盖依赖 config 库的 prefix 映射是否如预期，
// 而"端口没被覆盖→撞上线上 35801→进程照样非零退出"会让 A16f 因错误的原因通过。
const cfgCopy = fs.readFileSync(path.join(ROOT, 'config.toml'), 'utf8')
  .replace(/^port\s*=\s*\d+/m, `port = ${GW_TEST_PORT}`);
fs.writeFileSync(path.join(ISOLATED_CWD, 'config.toml'), cfgCopy, 'utf8');

const SCHED = resolveApiToken('SCHEDULER_API_TOKEN', ['SCHEDULER_API_KEY']);
const ADMIN = resolveApiToken('ADMIN_API_TOKEN');
const CHAT = resolveApiToken('CHAT_API_TOKEN');
const SECRETS = [SCHED.token, ADMIN.token, CHAT.token].filter((t) => t && t.length >= 8);

// ---------------- 断言框架 ----------------
let passed = 0;
const failures = [];
const notes = [];
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function note(msg) { notes.push(msg); console.log(`  … ${msg}`); }
function section(t) { console.log(`\n── ${t}`); }

async function req(method, url, { token, header = 'bearer', body, timeoutMs = 30000 } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
  if (token) {
    if (header === 'bearer') headers.Authorization = `Bearer ${token}`;
    else if (header === 'x-api-token') headers['X-API-Token'] = token;
    else if (header === 'x-admin-token') headers['X-Admin-Token'] = token;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, text, json };
  } catch (e) {
    return { status: 'ERR', text: e.message, json: null };
  } finally { clearTimeout(timer); }
}

function containsSecret(text) {
  if (!text) return false;
  return SECRETS.some((s) => text.includes(s));
}

// ---------------- 隔离实例的起停 ----------------
function spawnLogged(cmd, args, opts, logName) {
  const out = fs.openSync(path.join(TMP, logName), 'a');
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', out, out] });
  return child;
}
function waitExit(child, ms = 30000) {
  return new Promise((res) => {
    const t = setTimeout(() => res({ timedOut: true }), ms);
    child.on('exit', (code) => { clearTimeout(t); res({ code, timedOut: false }); });
  });
}
async function waitHttp(url, ms = 25000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.status < 500) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readLog(name) {
  try { return fs.readFileSync(path.join(TMP, name), 'utf8'); } catch { return ''; }
}

// =====================================================================
console.log('P0 安全专项验收（A16a–A16j）');
console.log(`网关 ${GW}   Express ${EXPRESS}`);
console.log(`凭据来源：SCHEDULER=${SCHED.source}  ADMIN=${ADMIN.source}  CHAT=${CHAT.source}`);
console.log(`根 .env：${ROOT_ENV_PATH}`);
console.log(`隔离实例工作目录：${TMP}`);

// ---------------------------------------------------------------- A. 分组鉴权
section('A16a/A16b — /schedule/* 分组鉴权（5 条路由）');
{
  const routes = [
    ['/schedule/propose', { preferred_date: '2026-09-20', community_name: '百花南天二花园', service_slots: 2, top_k: 3 }],
    ['/schedule/appointments', { customer_id: 0, technician_id: 'x', scheduled_date: '2026-09-20', start_slot: 18, end_slot: 20, address: 'x', community_name: 'x', area_sqm: 1, pest_type: '蟑螂', price: 1 }],
    ['/schedule/pricing', { area_sqm: 100, pest_type: '蟑螂', customer_type: '住宅' }],
    ['/schedule/evaluate', { date: '2026-09-20', time: '10:00', address: '百花南天二花园' }],
    ['/schedule/cache/warmup', {}],
  ];
  for (const [p, body] of routes) {
    const r = await req('POST', GW + p, { body });
    ok(`A16a ${p} 无 token → 401`, r.status === 401, `status=${r.status}`);
  }

  // 正确 token → 正常（只验只读两条：pricing / propose；appointments 会真写库，不在此打）
  const pr = await req('POST', GW + '/schedule/pricing', {
    token: SCHED.token, body: { area_sqm: 100, pest_type: '蟑螂', customer_type: '住宅' },
  });
  const prShapeOk = pr.status === 200 && pr.json
    && typeof pr.json.price === 'number' && typeof pr.json.base_price === 'number'
    && typeof pr.json.area_surcharge === 'number' && typeof pr.json.package_name === 'string'
    && typeof pr.json.description === 'string' && typeof pr.json.customer_type === 'string';
  ok('A16b /schedule/pricing 带 scheduler token → 200 且结构不变（6 字段）', prShapeOk,
    `status=${pr.status} keys=${pr.json ? Object.keys(pr.json).sort().join(',') : '-'}`);

  const pp = await req('POST', GW + '/schedule/propose', {
    token: SCHED.token,
    body: { preferred_date: '2026-09-20', community_name: '百花南天二花园', service_slots: 2, top_k: 3 },
  });
  const first = Array.isArray(pp.json) ? pp.json[0] : null;
  const ppShapeOk = pp.status === 200 && Array.isArray(pp.json) && (!first
    || (typeof first.technician_id === 'string' && typeof first.technician_name === 'string'
      && typeof first.start_slot === 'number' && typeof first.end_slot === 'number'
      && typeof first.score === 'number'));
  ok('A16b /schedule/propose 带 scheduler token → 200 且候选结构不变', ppShapeOk,
    `status=${pp.status} 候选数=${Array.isArray(pp.json) ? pp.json.length : '-'}`);

  // X-API-Token 兼容头
  const xr = await req('POST', GW + '/schedule/pricing', {
    token: SCHED.token, header: 'x-api-token', body: { area_sqm: 100, pest_type: '蟑螂', customer_type: '住宅' },
  });
  ok('A16b 兼容头 X-API-Token 亦可用（便于 curl/旧客户端）', xr.status === 200, `status=${xr.status}`);
}

section('A16c — /customer/* 与 /dashboard/* 分组鉴权（9 条路由）');
{
  const customerRoutes = [
    ['GET', '/customer/mini_p0_auth_probe/appointments'],
    ['GET', '/customer/appointments/999999999'],
    ['POST', '/customer/reschedule'],
    ['POST', '/customer/cancel'],
  ];
  const dashRoutes = [
    ['GET', '/dashboard/summary'],
    ['GET', '/dashboard/customers'],
    ['GET', '/dashboard/technicians'],
    ['GET', '/dashboard/alerts'],
    ['GET', '/dashboard/templates'],
  ];

  for (const [m, p] of [...customerRoutes, ...dashRoutes]) {
    const r = await req(m, GW + p, { body: m === 'POST' ? {} : undefined });
    ok(`A16c ${m} ${p} 无 token → 401`, r.status === 401, `status=${r.status}`);
  }

  // 带 admin token：/dashboard/* 期望 200（若返回 500 则记为"改前已存在的缺陷"，见基线）
  let dash200 = 0;
  const dashNon200 = [];
  for (const [m, p] of dashRoutes) {
    const r = await req(m, GW + p, { token: ADMIN.token });
    if (r.status === 200) dash200++;
    else dashNon200.push(`${p}→${r.status}`);
  }
  ok('A16c 带 admin token：/dashboard/* 鉴权放行（无 401）', dash200 + dashNon200.length === dashRoutes.length
    && !dashNon200.some((s) => s.endsWith('→401')), `200×${dash200}${dashNon200.length ? ' 非 200: ' + dashNon200.join(', ') : ''}`);
  if (dashNon200.length) note(`/dashboard/* 非 200（改前基线即如此，非本专项引入）：${dashNon200.join(', ')}`);

  let cust401 = 0;
  for (const [m, p] of customerRoutes) {
    const r = await req(m, GW + p, { token: ADMIN.token, body: m === 'POST' ? {} : undefined });
    if (r.status === 401) cust401++;
  }
  ok('A16c 带 admin token：/customer/* 鉴权放行（无 401）', cust401 === 0, `仍 401 条数=${cust401}`);
}

section('A16d — /api/chat/send 单列 token');
{
  const noTok = await req('POST', GW + '/api/chat/send', { body: { customer_id: 'p0_auth_probe', message: '你好' } });
  ok('A16d /api/chat/send 无 token → 401', noTok.status === 401, `status=${noTok.status}`);

  const withTok = await req('POST', GW + '/api/chat/send', {
    token: CHAT.token, timeoutMs: 180000,
    body: { customer_id: 'p0_auth_probe_' + Date.now(), message: '你好' },
  });
  ok('A16d /api/chat/send 带 chat token → 200 且响应体为聊天结构',
    withTok.status === 200 && withTok.json !== null && ('reply' in withTok.json || 'success' in withTok.json),
    `status=${withTok.status} keys=${withTok.json ? Object.keys(withTok.json).join(',') : '-'}`);

  // 内置 chat UI（`/` 保持开放）必须自己拿得到凭据，否则页面会 401 —— 这条断言覆盖"页面注入"这一环，
  // 否则"注入占位符替换失败"这类缺陷在接口断言下完全不可见（页面坏、API 全绿）。
  const page = await req('GET', GW + '/');
  const hasPlaceholder = page.text.includes('__CHAT_API_TOKEN__');
  ok('A16d chat UI 页已把 token 占位符替换为真实值', page.status === 200 && !hasPlaceholder && page.text.includes(CHAT.token.slice(0, 12)),
    `status=${page.status} 残留占位符=${hasPlaceholder}`);
  const m = page.text.match(/const API_TOKEN = "([0-9a-f]{16,})"/);
  if (m) {
    const uiCall = await req('POST', GW + '/api/chat/send', {
      token: m[1], timeoutMs: 180000,
      body: { customer_id: 'p0_ui_probe_' + Date.now(), message: '你好' },
    });
    ok('A16d 从页面里取到的 token 能真正调通（页面路径端到端可用）', uiCall.status === 200, `status=${uiCall.status}`);
  } else {
    ok('A16d 从页面里取到的 token 能真正调通（页面路径端到端可用）', false, '页面里未找到 API_TOKEN 注入点');
  }
}

section('A16e — cross-token 隔离（分组的意义）');
{
  const cases = [
    ['scheduler token → /dashboard/summary', 'GET', '/dashboard/summary', SCHED.token],
    ['scheduler token → /customer/appointments/1', 'GET', '/customer/appointments/1', SCHED.token],
    ['scheduler token → /api/chat/send', 'POST', '/api/chat/send', SCHED.token],
    ['admin token → /schedule/pricing', 'POST', '/schedule/pricing', ADMIN.token],
    ['chat token → /schedule/pricing', 'POST', '/schedule/pricing', CHAT.token],
    ['chat token → /dashboard/summary', 'GET', '/dashboard/summary', CHAT.token],
    ['admin token → /api/chat/send', 'POST', '/api/chat/send', ADMIN.token],
  ];
  for (const [label, m, p, tok] of cases) {
    const r = await req(m, GW + p, { token: tok, body: m === 'POST' ? { area_sqm: 100, pest_type: '蟑螂', customer_type: '住宅', customer_id: 'x', message: 'x' } : undefined });
    ok(`A16e ${label} → 401`, r.status === 401, `status=${r.status}`);
  }
}

// ---------------------------------------------------------------- B. fail-closed
section('A16f — 网关 fail-closed 启动');
{
  const port = Number(process.env.P0_GW_TEST_PORT || 53930);
  const baseEnv = {
    ...process.env,
    WECOM_GATEWAY_SERVER_PORT: String(port),
    WECOM_GATEWAY_DATABASE_URL: `sqlite:${path.join(TMP, 'gw-test.db')}`,
    RUST_LOG: 'info',
    // 显式置空：dotenvy 不覆盖"已存在（即使为空）"的变量，故根 .env 不会把凭据带进来
    SCHEDULER_API_TOKEN: '',
    ADMIN_API_TOKEN: '',
    CHAT_API_TOKEN: '',
    ALLOW_INSECURE_API: '',
  };

  // 1) 缺 SCHEDULER_API_TOKEN → 退出且指出缺哪个键
  const c1 = spawnLogged(GATEWAY_BIN, [], { cwd: ISOLATED_CWD, env: baseEnv }, 'gw-failclosed.log');
  const e1 = await waitExit(c1, 40000);
  const log1 = readLog('gw-failclosed.log');
  if (!e1.timedOut) { try { c1.kill(); } catch { /* 已退出 */ } }
  ok('A16f 缺 token 时进程退出（不是安静地放行启动）', !e1.timedOut && e1.code !== 0, `timedOut=${e1.timedOut} code=${e1.code}`);
  ok('A16f 日志明确指出缺少哪些键', log1.includes('SCHEDULER_API_TOKEN') && log1.includes('ADMIN_API_TOKEN') && log1.includes('CHAT_API_TOKEN'),
    `日志片段=${(log1.match(/安全配置缺失[^\n]*/) || ['(未找到)'])[0].slice(0, 120)}`);
  ok('A16f 失败信息里不含 token 值', !containsSecret(log1));

  // 2) ALLOW_INSECURE_API=true → 可启动，且打显著警告；此时 API 无鉴权
  const insecureEnv = { ...baseEnv, ALLOW_INSECURE_API: 'true' };
  const c2 = spawnLogged(GATEWAY_BIN, [], { cwd: ISOLATED_CWD, env: insecureEnv }, 'gw-insecure.log');
  const up = await waitHttp(`http://127.0.0.1:${port}/health`, 30000);
  const log2 = readLog('gw-insecure.log');
  ok('A16f ALLOW_INSECURE_API=true → 显式放行启动并打警告', up && /ALLOW_INSECURE_API/.test(log2),
    `health=${up} warn=${/ALLOW_INSECURE_API/.test(log2)}`);
  if (up) {
    const r = await req('GET', `http://127.0.0.1:${port}/dashboard/summary`);
    ok('A16f 不安全模式下确无鉴权（未带 token 亦非 401）', r.status !== 401, `status=${r.status}`);
  }
  try { c2.kill(); } catch { /* noop */ }
  await sleep(500);
  try { spawnSync('taskkill', ['/PID', String(c2.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* noop */ }
}

section('A16g — 管理后台（Express）fail-closed');
{
  const port = Number(process.env.P0_EXPRESS_TEST_PORT || 53931);
  const emptyEnv = path.join(TMP, '.env-empty');
  fs.writeFileSync(emptyEnv, '# 故意留空：验证 fail-closed\n', 'utf8');
  const baseEnv = {
    ...process.env,
    PORT: String(port),
    JUNWUYOU_DB: path.join(TMP, 'express-test.db'),
    SERVICE_ENV_FILE: emptyEnv,
    ADMIN_TOKEN: '',
    CHAT_API_TOKEN: '',
    ALLOW_INSECURE_ADMIN: '',
  };

  const serverEntry = path.join(ROOT, 'junwuyou', 'server', 'server.js');
  const c1 = spawnLogged(process.execPath, [serverEntry], { cwd: path.join(ROOT, 'junwuyou', 'server'), env: baseEnv }, 'express-failclosed.log');
  const e1 = await waitExit(c1, 30000);
  const log1 = readLog('express-failclosed.log');
  if (!e1.timedOut) { try { c1.kill(); } catch { /* 已退出 */ } }
  ok('A16g ADMIN_TOKEN 为空 → Express 退出（不再放行一切）', !e1.timedOut && e1.code !== 0, `timedOut=${e1.timedOut} code=${e1.code}`);
  ok('A16g 退出信息点名 ADMIN_TOKEN 与 CHAT_API_TOKEN', log1.includes('ADMIN_TOKEN') && log1.includes('CHAT_API_TOKEN'));

  const c2 = spawnLogged(process.execPath, [serverEntry], { cwd: path.join(ROOT, 'junwuyou', 'server'), env: { ...baseEnv, ALLOW_INSECURE_ADMIN: 'true' } }, 'express-insecure.log');
  const up = await waitHttp(`http://127.0.0.1:${port}/api/health`, 25000);
  const log2 = readLog('express-insecure.log');
  ok('A16g ALLOW_INSECURE_ADMIN=true → 启动但打显著警告', up && /不安全模式/.test(log2),
    `health=${up} warn=${/不安全模式/.test(log2)}`);
  try { c2.kill(); } catch { /* noop */ }
  await sleep(500);
  try { spawnSync('taskkill', ['/PID', String(c2.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* noop */ }
}

// ---------------------------------------------------------------- C. 不泄露
section('A16g-live — 线上 Express 凭据配置与鉴权（隔离变体之外的"真实部署态"）');
{
  // 为什么必须有这一节：隔离变体只证明"缺凭据会拒绝启动"，
  // 证明不了"线上真的配好了凭据"——本轮实测踩到过：ADMIN_TOKEN 漏配 → Express 起不来，
  // 而隔离变体全绿。**断言必须覆盖部署态，而不只是设计意图。**
  const h = await req('GET', EXPRESS + '/api/health');
  ok('A16g-live 线上 Express /api/health → 200（凭据齐备，未因 fail-closed 退出）', h.status === 200, `status=${h.status}`);

  const admin = resolveApiToken('ADMIN_TOKEN');
  const anon = await req('GET', EXPRESS + '/api/admin/workers');
  ok('A16g-live 管理接口无凭据 → 401', anon.status === 401, `status=${anon.status}`);
  const withTok = await req('GET', EXPRESS + '/api/admin/workers', { token: admin.token });
  ok('A16g-live 管理接口带 ADMIN_TOKEN（Bearer）→ 200', withTok.status === 200, `status=${withTok.status} source=${admin.source}`);
  const qsTok = await req('GET', `${EXPRESS}/api/admin/workers?token=${encodeURIComponent(admin.token)}`);
  ok('A16g-live 兼容查询参数 ?token=（后台页历史用法）', qsTok.status === 200, `status=${qsTok.status}`);
  const staticAnon = await req('GET', EXPRESS + '/admin');
  ok('A16g-live /admin 静态页无凭据 → 401', staticAnon.status === 401, `status=${staticAnon.status}`);
}

section('A16i — token 不泄露');
{
  const r401 = await req('POST', GW + '/schedule/pricing', { body: { area_sqm: 100, pest_type: '蟑螂', customer_type: '住宅' } });
  ok('A16i 401 响应体不含任何 token 值', r401.status === 401 && !containsSecret(r401.text), `${String(r401.text).slice(0, 60)}`);

  const h = await req('GET', GW + '/health');
  ok('A16i /health 不含任何 token 值', h.status === 200 && !containsSecret(h.text));

  const cands = [
    path.join(ROOT, 'wecom-gateway.log'),
    path.join(ROOT, 'wecom-gateway-err.log'),
    path.join(TMP, 'gw-failclosed.log'),
    path.join(TMP, 'gw-insecure.log'),
    path.join(TMP, 'express-insecure.log'),
  ];
  const leaked = [];
  for (const f of cands) {
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (containsSecret(txt)) leaked.push(path.basename(f));
  }
  ok('A16i 服务日志中不含任何 token 值', leaked.length === 0, leaked.join(', '));

  const ei = await req('GET', EXPRESS + '/api/health');
  ok('A16i Express /api/health 不含任何 token 值', !containsSecret(ei.text));
}

// ---------------------------------------------------------------- D. 监听面
section('A16j — 监听面收敛到回环');
{
  let netstatOut = '';
  try {
    netstatOut = spawnSync('netstat', ['-ano'], { encoding: 'utf8', shell: false }).stdout || '';
  } catch { /* 取不到就靠连接探测 */ }
  const lines = netstatOut.split(/\r?\n/).filter((l) => /LISTENING/.test(l) && /:35801\b/.test(l));
  if (lines.length) {
    const nonLoop = lines.filter((l) => !/127\.0\.0\.1:35801|\[::1\]:35801/.test(l));
    ok('A16j 35801 仅回环监听（netstat）', nonLoop.length === 0, nonLoop.join(' | ').slice(0, 120));
  } else {
    note('netstat 不可用，改用连接探测判定监听面');
  }

  const lanIp = Object.values(os.networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  const loopOk = await new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port: 35801 }, () => { s.destroy(); res(true); });
    s.on('error', () => res(false)); s.setTimeout(2000, () => { s.destroy(); res(false); });
  });
  ok('A16j 回环地址可连（服务确实在跑）', loopOk);
  if (lanIp) {
    const lanOk = await new Promise((res) => {
      const s = net.connect({ host: lanIp, port: 35801 }, () => { s.destroy(); res(true); });
      s.on('error', () => res(false)); s.setTimeout(2500, () => { s.destroy(); res(false); });
    });
    ok(`A16j 非回环地址（${lanIp}）不可连 → 外部不可达`, !lanOk, `connectable=${lanOk}`);
  } else {
    note('未找到非回环 IPv4，跳过外部可达性探测');
  }
}

// ---------------------------------------------------------------- E. 回归
section('A16h — 客户链路零回归');
if (QUICK) {
  note('--quick：跳过 E2E 回归子套件（仅验 /api/chat 通路）');
}
{
  // Express → 网关 /api/chat（这是小程序/预览页的真实入口）
  const r = await req('POST', EXPRESS + '/api/chat', {
    timeoutMs: 180000, body: { sessionId: 'p0auth' + Date.now(), message: '你好' },
  });
  ok('A16h Express /api/chat → 200（转发带 CHAT_API_TOKEN 生效）',
    r.status === 200 && r.json && r.json.ok === true, `status=${r.status} body=${String(r.text).slice(0, 120)}`);

  if (!QUICK) {
    const suites = [
      ['verify-qq-conversation-fixes.mjs', 'QQ 会话缺陷回归（含 D 组报价规则走真实 HTTP）'],
      ['test-e2e-order-flow.mjs', '完整下单链路（报价/时段/下单走 /schedule/*）'],
      ['scripts/verify-worker-p05.mjs', '作业层 P0.5 断言（Express adminAuth 改造的回归面）'],
    ];
    for (const [script, label] of suites) {
      const logName = `suite-${path.basename(script)}.log`;
      const out = fs.openSync(path.join(TMP, logName), 'a');
      const started = Date.now();
      const res = spawnSync(process.execPath, [path.join(ROOT, 'runtime', 'openmozi', script)], {
        cwd: path.join(ROOT, 'runtime', 'openmozi'), stdio: ['ignore', out, out], env: process.env, timeout: 900000,
      });
      const secs = Math.round((Date.now() - started) / 1000);
      const log = readLog(logName);
      const m = log.match(/合计\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/) || log.match(/BATCH_\w+_ACCEPT PASS=(\d+) FAIL=(\d+)/);
      const detail = m ? `${m[0]} (${secs}s)` : `exit=${res.status} (${secs}s)`;
      ok(`A16h ${label}`, res.status === 0, detail);
      if (res.status !== 0) {
        const tail = log.split(/\r?\n/).filter((l) => l.includes('✗') || l.includes('失败项')).slice(-8).join(' | ');
        if (tail) note(`  ${script} 失败摘录：${tail.slice(0, 400)}`);
      }
    }
  }

  // L-083 已知 flaky：单独跑、单独记，不计入 A16h 判定（是否收窄判据待用户裁决）
  if (!QUICK) {
    const name = 'test-e2e-memory.mjs';
    const out = fs.openSync(path.join(TMP, `suite-${name}.log`), 'a');
    const res = spawnSync(process.execPath, [path.join(ROOT, 'runtime', 'openmozi', name)], {
      cwd: path.join(ROOT, 'runtime', 'openmozi'), stdio: ['ignore', out, out], env: process.env, timeout: 600000,
    });
    const log = readLog(`suite-${name}.log`);
    const m = log.match(/合计\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/);
    if (res.status === 0) ok(`A16h 多轮记忆（${m ? m[0] : 'exit=0'}）`, true);
    else note(`多轮记忆存在失败（${m ? m[0] : 'exit=' + res.status}）——**已知 flaky（L-083，6 次运行 3 红 3 绿，断言与人设冲突，判据收窄待用户裁决）**，不计入 A16h 判定`);
  }
}

// ---------------------------------------------------------------- 汇总
console.log(`\n${'='.repeat(66)}`);
console.log(`BATCH_P0_AUTH_ACCEPT PASS=${passed} FAIL=${failures.length}`);
if (failures.length) console.log(`失败项：\n - ${failures.join('\n - ')}`);
if (notes.length) console.log(`备注：\n - ${notes.join('\n - ')}`);
console.log(`隔离实例日志目录：${TMP}`);
console.log('='.repeat(66));
process.exitCode = failures.length === 0 ? 0 : 1;
