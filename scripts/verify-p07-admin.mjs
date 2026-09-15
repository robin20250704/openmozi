/**
 * P0.7 验收 harness —— 残留收尾批次的断言可执行镜像
 * （规格：`.creature/tasks/cs-platform-framework/spec-p07.md` §3，断言 A30–A34）
 *
 * 设计：
 * 1. **隔离实例**：自带临时业务库（JUNWUYOU_DB）+ 独立端口 + 固定的测试 ADMIN_TOKEN，
 *    不碰生产库、不产生真实订单 —— 断言里要"录单/指派/改派"，只能在临时库上做。
 * 2. **线上态探针**：另有一组针对**已部署**服务的断言（监听面收敛、Rust `/dashboard/*`），
 *    因为"隔离变体全绿 ≠ 部署态正确"（教训 L-085，约定 V-019）。
 * 3. 子进程输出落文件（不用管道）。
 *
 * 运行：
 *   node scripts/verify-p07-admin.mjs          # 全量（含 E2E 回归 + L-083 连跑 2 次）
 *   node scripts/verify-p07-admin.mjs --quick  # 跳过重套件（CI 用）
 * 退出码：0 = 全绿；1 = 有失败
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { resolveApiToken } from '../junwuyou/lib/root-env.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const QUICK = process.argv.includes('--quick');

const GW = process.env.SCHEDULER_API_URL || 'http://127.0.0.1:35801';
const EXPRESS_LIVE = process.env.JUNWUYOU_API_URL || 'http://127.0.0.1:53000';
const PORT = Number(process.env.P07_TEST_PORT || 53940);
const ADMIN_TOKEN = 'test-admin-token-p07';
const BASE = `http://127.0.0.1:${PORT}`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p07-admin-'));
const TEST_DB = path.join(TMP, 'test.db');
const SERVER_LOG = path.join(TMP, 'express.log');

const ADMIN = resolveApiToken('ADMIN_API_TOKEN');

let passed = 0;
const failures = [];
const notes = [];
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function note(m) { notes.push(m); console.log(`  … ${m}`); }
function section(t) { console.log(`\n── ${t}`); }

async function req(method, url, { token, bearer, body, timeoutMs = 20000 } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
  if (token) headers['X-Admin-Token'] = token;      // Express 主管后台的形态（其 adminAuth 认三种）
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;   // 网关形态
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, text, json };
  } catch (e) { return { status: 'ERR', text: e.message, json: null }; }
  finally { clearTimeout(timer); }
}
const A = (p) => BASE + p;                        // 隔离实例
const aReq = (m, p, o) => req(m, A(p), { token: ADMIN_TOKEN, ...o });

/**
 * 网关（Rust）请求：凭据形态是 `Authorization: Bearer`（P0 定的契约；兼容形态为 `X-API-Token`）。
 * ⚠️ 不要复用 Express 的 `X-Admin-Token` —— 网关不认那个头，会得到 401
 * （本 harness 首轮就在这上面假红过一次：明明是 harness 发错头，却报"端点未部署"）。
 */
const gwReq = (m, p) => req(m, GW + p, { bearer: resolveApiToken('ADMIN_API_TOKEN').token });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHttp(url, ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch { /* 未起 */ }
    await sleep(400);
  }
  return false;
}
function readLog() { try { return fs.readFileSync(SERVER_LOG, 'utf8'); } catch { return ''; } }

function todayShanghai() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// ---------------------------------------------------------------- 启动隔离实例
console.log('P0.7 验收（残留收尾：主管工作台 / 看板 / R1 / 监听面）');
console.log(`隔离实例 ${BASE}   线上 Express ${EXPRESS_LIVE}   网关 ${GW}`);
console.log(`隔离工作目录：${TMP}\n`);

const out = fs.openSync(SERVER_LOG, 'a');
const child = spawn(process.execPath, ['server.js'], {
  cwd: path.join(ROOT, 'junwuyou', 'server'),
  stdio: ['ignore', out, out],
  env: {
    ...process.env,
    PORT: String(PORT),
    JUNWUYOU_DB: TEST_DB,
    ADMIN_TOKEN,
    CHAT_API_TOKEN: 'test-chat-token',
    WORKER_INIT_PASSWORD: 'junwuyou',
    LISTEN_HOST: '127.0.0.1',
  },
});
await waitHttp(A('/api/health'), 30000);

// ---------------------------------------------------------------- A32 工作台鉴权与形态
section('A32a — 工作台端点鉴权（全部 adminAuth）');
{
  const routes = [
    ['GET', '/api/admin/board'],
    ['GET', '/api/admin/customers?q=x'],
    ['POST', '/api/admin/customers'],
    ['GET', '/api/admin/slots'],
    ['POST', '/api/admin/orders'],
  ];
  for (const [m, p] of routes) {
    const r = await req(m, A(p), { body: m === 'POST' ? {} : undefined });
    ok(`A32a ${m} ${p} 无凭据 → 401`, r.status === 401, `status=${r.status}`);
  }
  const withTok = await aReq('GET', '/api/admin/board');
  ok('A32a 带 ADMIN_TOKEN → 放行（非 401）', withTok.status === 200, `status=${withTok.status}`);
  const bearer = await req('GET', A('/api/admin/board'), { token: undefined });
  ok('A32a 无凭据对照（同一端点）→ 401', bearer.status === 401);
  const bearerOk = await fetch(A('/api/admin/board'), { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
  ok('A32a Bearer 形态亦可用', bearerOk.status === 200, `status=${bearerOk.status}`);
}

section('A32g — 时段选项由服务端给出（V-010/V-014，前端不做换算）');
{
  const d = await aReq('GET', '/api/admin/slots');
  const opts = d.json?.options || [];
  const has18 = opts.find((o) => o.start_slot === 18 && o.end_slot === 20);
  ok('A32g /api/admin/slots 返回带 label 的时段选项', d.status === 200 && opts.length > 0, `count=${opts.length}`);
  ok('A32g slot 18-20 → label「09:00-10:00」（与内核 slot 语义对齐）', has18?.label === '09:00-10:00', `label=${has18?.label}`);
  const last = opts[opts.length - 1];
  ok('A32g 时段覆盖到 21:00（42=21:00 口径）', last && last.end_slot === 42, `last=${last?.start_slot}-${last?.end_slot}`);
}

section('A32f — 离线客户按电话幂等复用（V-017：不为每个新身份新建客户）');
let custA, custB;
{
  const phone = '13800000007';
  const first = await aReq('POST', '/api/admin/customers', { body: { name: '测试客户甲', phone, address: '南山区科技园3栋201' } });
  const second = await aReq('POST', '/api/admin/customers', { body: { name: '测试客户甲', phone, address: '南山区科技园3栋201' } });
  custA = first.json?.customer?.id;
  ok('A32f 首次新建客户成功', first.status === 200 && !!custA, `status=${first.status} id=${custA}`);
  ok('A32f 同电话第二次 → 复用同一 customer_id（不制造重复客户）',
    second.status === 200 && second.json?.customer?.id === custA && second.json?.reused === true,
    `id=${second.json?.customer?.id} reused=${second.json?.reused}`);
  const other = await aReq('POST', '/api/admin/customers', { body: { name: '测试客户乙', phone: '13800000008' } });
  custB = other.json?.customer?.id;
  ok('A32f 不同电话 → 不同客户', !!custB && custB !== custA, `${custA} vs ${custB}`);
  const bad = await aReq('POST', '/api/admin/customers', { body: { name: 'x', phone: 'abc' } });
  ok('A32f 电话不合法 → 400', bad.status === 400, `status=${bad.status}`);
  const search = await aReq('GET', '/api/admin/customers?q=13800000007');
  ok('A32f 客户搜索可命中（录单页选客户用）', search.status === 200 && (search.json?.customers || []).some((c) => c.id === custA));
}

section('A32b — 看板结构完整');
{
  const d = await aReq('GET', `/api/admin/board?date=${todayShanghai()}`);
  const j = d.json || {};
  ok('A32b board 返回 on_duty / by_technician / unassigned / summary',
    d.status === 200 && Array.isArray(j.on_duty) && Array.isArray(j.by_technician) && Array.isArray(j.unassigned) && !!j.summary,
    `status=${d.status} keys=${j ? Object.keys(j).join(',') : '-'}`);
  const w = (j.on_duty || [])[0];
  ok('A32b 在岗项含 status / checked_in_at / today{total,done,pending} / last_location',
    !!w && 'status' in w && 'checked_in_at' in w && w.today && 'total' in w.today && 'done' in w.today && 'pending' in w.today && 'last_location' in w,
    JSON.stringify(w && { status: w.status, today: w.today }));
  ok('A32b 汇总口径齐全（roster/on_duty/orders_today/done/pending/unassigned）',
    ['roster', 'on_duty', 'busy', 'idle', 'orders_today', 'done', 'pending', 'unassigned'].every((k) => k in (j.summary || {})),
    JSON.stringify(j.summary));
  const bad = await aReq('GET', '/api/admin/board?date=not-a-date');
  ok('A32b 非法日期 → 回落到今天（不报错）', bad.status === 200 && bad.json?.date === todayShanghai(), `date=${bad.json?.date}`);
}

section('A32c/A32d — 录单（带师傅 / 不带师傅）+ 指派两步');
let orderAssigned, orderUnassigned;
{
  const date = todayShanghai();
  const before = (await aReq('GET', `/api/admin/board?date=${date}`)).json;

  // 带师傅
  const r1 = await aReq('POST', '/api/admin/orders', {
    body: { customer_id: custA, technician_id: 'tech_001', scheduled_date: date, start_slot: 18, end_slot: 20, address: '南山区科技园3栋201', community_name: '科技园', area_sqm: 100, pest_type: '蟑螂', price: 189 },
  });
  orderAssigned = r1.json?.order?.id;
  ok('A32c 录单（带师傅）→ 200 且返回 time_label（服务端换算）',
    r1.status === 200 && !!orderAssigned && r1.json?.time_label === '09:00-10:00',
    `status=${r1.status} label=${r1.json?.time_label}`);

  const after = (await aReq('GET', `/api/admin/board?date=${date}`)).json;
  const tech = (after.by_technician || []).find((t) => t.technician_id === 'tech_001');
  ok('A32c 订单出现在该师傅名下（作业端"有单可看"的前提）',
    !!tech && tech.orders.some((o) => o.id === orderAssigned), `orders=${(tech?.orders || []).map((o) => o.id).join(',')}`);
  ok('A32c summary.orders_today +1', (after.summary?.orders_today || 0) === (before.summary?.orders_today || 0) + 1,
    `${before.summary?.orders_today} → ${after.summary?.orders_today}`);

  // 不带师傅 → 待指派
  const r2 = await aReq('POST', '/api/admin/orders', {
    body: { customer_id: custB, technician_id: null, scheduled_date: date, start_slot: 26, end_slot: 28, address: '南山区海月花园2栋', community_name: '海月花园', area_sqm: 80, pest_type: '老鼠', price: 159 },
  });
  orderUnassigned = r2.json?.order?.id;
  ok('A32d 录单（不带师傅）→ 200（先录后派）', r2.status === 200 && !!orderUnassigned, `status=${r2.status}`);
  const mid = (await aReq('GET', `/api/admin/board?date=${date}`)).json;
  ok('A32d 该单出现在「待指派」列表', (mid.unassigned || []).some((o) => o.id === orderUnassigned), `unassigned=${(mid.unassigned || []).map((o) => o.id).join(',')}`);
  ok('A32d 待指派列表带 time_label（前端不换算）', !!(mid.unassigned || []).find((o) => o.id === orderUnassigned)?.time_label);

  const asg = await aReq('POST', `/api/admin/orders/${orderUnassigned}/assign`, { body: { technician_id: 'tech_002' } });
  ok('A32d 指派成功', asg.status === 200 && asg.json?.technician_id === 'tech_002', `status=${asg.status}`);
  const end = (await aReq('GET', `/api/admin/board?date=${date}`)).json;
  ok('A32d 指派后从「待指派」消失', !(end.unassigned || []).some((o) => o.id === orderUnassigned));
  const t2 = (end.by_technician || []).find((t) => t.technician_id === 'tech_002');
  ok('A32d 指派后出现在该师傅名下', !!t2 && t2.orders.some((o) => o.id === orderUnassigned));
}

section('A32e — 改派必须查时段冲突（不再产生"同一师傅双订"）');
{
  const date = todayShanghai();
  // 造一个**与订单 A 同时段（18-20）且未指派**的单：无师傅 → 录单时不查"师傅级冲突"（设计如此）
  const dup = await aReq('POST', '/api/admin/orders', {
    body: { customer_id: custB, technician_id: null, scheduled_date: date, start_slot: 18, end_slot: 20, address: '南山区海月花园2栋' },
  });
  const dupId = dup.json?.order?.id;
  ok('A32e 未指派单可落在"已被他人占用"的时段（无师傅即无师傅级冲突）', dup.status === 200 && !!dupId, `status=${dup.status}`);

  const r = await aReq('POST', `/api/admin/orders/${dupId}/assign`, { body: { technician_id: 'tech_001' } });
  ok('A32e 指派到「同师傅同时段已有单」→ 409（原先会静默双订）', r.status === 409,
    `status=${r.status} error=${(r.json?.error || '').slice(0, 60)}`);
  ok('A32e 响应指明冲突订单号（指向 A 单）', r.json?.conflict_order_id === orderAssigned,
    `conflict=${r.json?.conflict_order_id} 期望=${orderAssigned}`);

  const board = (await aReq('GET', `/api/admin/board?date=${date}`)).json;
  const t1 = (board.by_technician || []).find((t) => t.technician_id === 'tech_001');
  const sameSlot = (t1?.orders || []).filter((o) => o.start_slot === 18);
  ok('A32e 库中该师傅该时段仍只有 1 单（拒绝生效、未写入）', sameSlot.length === 1, `count=${sameSlot.length}`);

  // 负向对照：换个空闲师傅应能成功 —— 证明 409 是"定位到冲突"，而非"一律拒绝指派"
  const free = await aReq('POST', `/api/admin/orders/${dupId}/assign`, { body: { technician_id: 'tech_002' } });
  ok('A32e 对照：指派给不同师傅的空闲时段仍成功（409 不是一律拒绝）', free.status === 200, `status=${free.status}`);

  const badTech = await aReq('POST', `/api/admin/orders/${dupId}/assign`, { body: { technician_id: 'tech_999' } });
  ok('A32e 指派给不存在的师傅 → 400', badTech.status === 400, `status=${badTech.status}`);
}

section('A32h — 录单拒绝过去日期（复用 validateSchedule）');
{
  const r = await aReq('POST', '/api/admin/orders', {
    body: { customer_id: custA, scheduled_date: '2020-01-01', start_slot: 18, end_slot: 20, address: 'x' },
  });
  ok('A32h 过去日期 → 400', r.status === 400, `status=${r.status} error=${(r.json?.error || '').slice(0, 60)}`);
  const missing = await aReq('POST', '/api/admin/orders', { body: { scheduled_date: todayShanghai(), start_slot: 18, end_slot: 20 } });
  ok('A32h 缺 customer_id → 400', missing.status === 400, `status=${missing.status}`);
}

// ---------------------------------------------------------------- A30 监听面（线上态）
section('A30 — 监听面收敛（线上 Express，D-28）');
{
  let netstatOut = '';
  try { netstatOut = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || ''; } catch { /* 忽略 */ }
  const port = new URL(EXPRESS_LIVE).port || '53000';
  const lines = netstatOut.split(/\r?\n/).filter((l) => /LISTENING/.test(l) && l.includes(`:${port}`));
  if (lines.length) {
    const nonLoop = lines.filter((l) => !/127\.0\.0\.1:/.test(l));
    ok('A30a 线上 Express 仅回环监听（netstat）', nonLoop.length === 0, nonLoop.join(' | ').slice(0, 120));
  } else {
    note('netstat 不可用，改用连接探测判定');
  }
  const loop = await new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port: Number(port) }, () => { s.destroy(); res(true); });
    s.on('error', () => res(false)); s.setTimeout(2000, () => { s.destroy(); res(false); });
  });
  ok('A30c 回环可连且 /api/health 200', loop && (await req('GET', EXPRESS_LIVE + '/api/health')).status === 200);

  const lanIp = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (lanIp) {
    const lanOk = await new Promise((res) => {
      const s = net.connect({ host: lanIp, port: Number(port) }, () => { s.destroy(); res(true); });
      s.on('error', () => res(false)); s.setTimeout(2500, () => { s.destroy(); res(false); });
    });
    ok(`A30b 局域网地址（${lanIp}）不可连 → 业务 API 不再对外裸奔`, !lanOk, `connectable=${lanOk}`);
  } else { note('未找到非回环 IPv4，跳过外网可达性探测'); }

  const live401 = await req('GET', EXPRESS_LIVE + '/api/admin/workers');
  const liveOk = await req('GET', EXPRESS_LIVE + '/api/admin/workers', { token: resolveApiToken('ADMIN_TOKEN').token });
  ok('A30c 线上管理面鉴权仍生效（无凭据 401 / 带凭据 200）', live401.status === 401 && liveOk.status === 200,
    `401→${live401.status} withTok→${liveOk.status}`);

  // A30d — **部署态**探针（V-019 的正题）：本批新增的页面与端点在**线上实例**上真的可用。
  // 不能只有隔离实例断言：那只能证明"代码在隔离环境里能跑"，证明不了"线上部署的是这批代码"
  // （L-085 漏配凭据、L-090 旧二进制上线，两次都是隔离全绿而线上不对）。
  const tok = resolveApiToken('ADMIN_TOKEN').token;
  const pageNoTok = await req('GET', EXPRESS_LIVE + '/admin/workbench.html');
  const page = await req('GET', EXPRESS_LIVE + '/admin/workbench.html', { token: tok });
  ok('A30d 线上主管工作台：无凭据 401 / 带凭据 200', pageNoTok.status === 401 && page.status === 200,
    `noTok→${pageNoTok.status} withTok→${page.status}`);
  ok('A30d 线上页面就是本批交付的页面（含录单与看板锚点）',
    page.status === 200 && page.text.includes('主管工作台') && page.text.includes('录入订单') && page.text.includes('/api/admin/board'));
  const liveBoard = await req('GET', EXPRESS_LIVE + '/api/admin/board', { token: tok });
  ok('A30d 线上 /api/admin/board → 200 且结构完整（部署态）',
    liveBoard.status === 200 && !!liveBoard.json?.summary && Array.isArray(liveBoard.json?.unassigned),
    `status=${liveBoard.status} summary=${JSON.stringify(liveBoard.json?.summary || {}).slice(0, 80)}`);
  const liveSlots = await req('GET', EXPRESS_LIVE + '/api/admin/slots', { token: tok });
  ok('A30d 线上 /api/admin/slots → 200 且含 label（部署态）',
    liveSlots.status === 200 && (liveSlots.json?.options || []).some((o) => o.label === '09:00-10:00'),
    `status=${liveSlots.status}`);
  const liveBoardNoTok = await req('GET', EXPRESS_LIVE + '/api/admin/board');
  ok('A30d 线上看板端点无凭据仍是 401（新端点没有绕过鉴权）', liveBoardNoTok.status === 401, `status=${liveBoardNoTok.status}`);

  // A30e — **agent 33000 也必须只监听回环**（C-045：三面全覆盖）。
  // 这一条是收尾时核对监听面才发现的：agent 原先由 .env 的 `OPENMOZI_HOST=0.0.0.0` 绑全网卡，
  // 而它的 HTTP/WS **没有鉴权**、手里还有 `query_customer_profile` 等工具 —— 同网段任何人可直连
  // 客服 agent 读客户档案。修法：`.env` 与代码默认都改 `127.0.0.1`（D-28）。
  {
    const agentPort = Number(new URL(process.env.OPENMOZI_URL || 'http://127.0.0.1:33000').port || 33000);
    const agentLines = (netstatOut || '').split(/\r?\n/).filter((l) => /LISTENING/.test(l) && l.includes(`:${agentPort}`));
    if (agentLines.length) {
      const nonLoop = agentLines.filter((l) => !/127\.0\.0\.1:/.test(l));
      ok('A30e agent 33000 仅回环监听（netstat）', nonLoop.length === 0, nonLoop.join(' | ').slice(0, 120));
    } else { note('netstat 无 agent 行，跳过 A30e 的 netstat 部分'); }
    const agentLoop = await new Promise((res) => {
      const s = net.connect({ host: '127.0.0.1', port: agentPort }, () => { s.destroy(); res(true); });
      s.on('error', () => res(false)); s.setTimeout(2000, () => { s.destroy(); res(false); });
    });
    ok('A30e agent 回环可用（服务没被改坏）', agentLoop && (await req('GET', `http://127.0.0.1:${agentPort}/`)).status === 200);
    if (lanIp) {
      const agentLan = await new Promise((res) => {
        const s = net.connect({ host: lanIp, port: agentPort }, () => { s.destroy(); res(true); });
        s.on('error', () => res(false)); s.setTimeout(2500, () => { s.destroy(); res(false); });
      });
      ok(`A30e agent 局域网地址（${lanIp}）不可连`, !agentLan, `connectable=${agentLan}`);
    }
  }
}

// ---------------------------------------------------------------- A31 Rust dashboard（线上态）
section('A31 — /dashboard/* 空集不再 500（线上网关，R1）');
{
  const s = await gwReq('GET', '/dashboard/summary');
  ok('A31a /dashboard/summary 带凭据 → 200（原先 500）', s.status === 200, `status=${s.status}`);
  if (s.status === 200) {
    const sum = s.json?.summary || {};
    ok('A31a 空库时计数为 0 且非 null（原崩溃点）',
      sum.total_appointments === 0 && sum.completed_appointments === 0 && sum.pending_appointments === 0 && sum.cancelled_appointments === 0,
      JSON.stringify(sum));
    ok('A31d 响应自述数据来源（避免 200 全 0 被误读）', !!s.json?.data_source && !!s.json?.notice,
      `data_source=${(s.json?.data_source || '').slice(0, 30)}`);
  } else {
    note(`/dashboard/summary 仍非 200（${s.status}）：可能网关尚未部署本批二进制`);
  }
  const t = await gwReq('GET', '/dashboard/technicians');
  ok('A31b /dashboard/technicians 带凭据 → 200（原先 500）', t.status === 200, `status=${t.status}`);
  if (t.status === 200) {
    const rows = t.json?.technicians || [];
    ok('A31b 技师行的 completed_appointments 是数字（原 null → 解码失败）',
      rows.length > 0 && rows.every((r) => typeof r.completed_appointments === 'number'), JSON.stringify(rows[0] || {}));
  }
  // 交差隔离仍然成立（P0 定的分组凭据：scheduler 凭据不得读 dashboard）
  const cross = await req('GET', GW + '/dashboard/summary', { bearer: resolveApiToken('SCHEDULER_API_TOKEN', ['SCHEDULER_API_KEY']).token });
  ok('A31c dashboard 仍拒绝 scheduler 凭据（交差隔离未因修复而放宽）', cross.status === 401, `status=${cross.status}`);
}

// ---------------------------------------------------------------- A33/A34 回归
section('A33 — L-083 收窄后稳定（连跑 2 次）');
if (QUICK) note('--quick：跳过（重套件）');
else {
  let green = 0;
  for (let i = 1; i <= 2; i++) {
    const log = path.join(TMP, `memory-${i}.log`);
    const o = fs.openSync(log, 'a');
    const r = spawnSync(process.execPath, ['test-e2e-memory.mjs'], {
      cwd: path.join(ROOT, 'runtime', 'openmozi'), stdio: ['ignore', o, o], env: process.env, timeout: 600000,
    });
    const txt = fs.readFileSync(log, 'utf8');
    const m = txt.match(/=====\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败\s*=====/);
    if (r.status === 0) green++;
    console.log(`    第 ${i} 次：${m ? m[0] : 'exit=' + r.status}`);
    if (r.status !== 0) {
      const lines = txt.split(/\r?\n/).filter((l) => l.trim());
      const bad = lines.filter((l) => l.includes('❌'));
      // 崩溃/超时的套件不会有 ❌ 行 —— 那就把日志尾部原样带出来
      // （L-080 同族：长跑脚本的失败必须自带可读证据，否则"exit=1 但看不到原因"）
      note(`memory 第 ${i} 次失败：${(bad.length ? bad.slice(0, 2).join(' | ') : lines.slice(-3).join(' | ')).slice(0, 300)}`);
    }
  }
  ok('A33 test-e2e-memory 连跑 2 次均通过（改前为两轮一过一红）', green === 2, `green=${green}/2`);
}

section('A34 — 零回归');
if (QUICK) note('--quick：跳过重套件（CI 由 5/5、5c、5d 覆盖）');
else {
  const suites = [
    ['scripts/verify-worker-p05.mjs', '作业层 63 断言'],
    ['verify-qq-conversation-fixes.mjs', 'QQ 会话缺陷回归'],
    ['test-e2e-order-flow.mjs', '完整下单链路'],
  ];
  for (const [script, label] of suites) {
    const log = path.join(TMP, `suite-${path.basename(script)}.log`);
    const o = fs.openSync(log, 'a');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'runtime', 'openmozi', script)], {
      cwd: path.join(ROOT, 'runtime', 'openmozi'), stdio: ['ignore', o, o], env: process.env, timeout: 900000,
    });
    const txt = fs.readFileSync(log, 'utf8');
    const m = txt.match(/合计\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/) || txt.match(/P0\.5 作业层验收：(\d+) 通过 \/ (\d+) 失败/);
    ok(`A34 ${label}`, r.status === 0, m ? m[0] : `exit=${r.status}`);
  }
}

// ---------------------------------------------------------------- 收尾
try { child.kill(); } catch { /* noop */ }
await sleep(400);
try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* noop */ }

console.log(`\n${'='.repeat(66)}`);
console.log(`BATCH_P07_ADMIN_ACCEPT PASS=${passed} FAIL=${failures.length}`);
if (failures.length) console.log(`失败项：\n - ${failures.join('\n - ')}`);
if (notes.length) console.log(`备注：\n - ${notes.join('\n - ')}`);
console.log(`隔离实例日志：${SERVER_LOG}`);
console.log('='.repeat(66));
if (failures.length === 0) {
  const tail = readLog().trim().split(/\r?\n/).slice(-3);
  if (tail.length) console.log('隔离实例启动日志尾部：\n  ' + tail.join('\n  '));
}
process.exitCode = failures.length === 0 ? 0 : 1;
