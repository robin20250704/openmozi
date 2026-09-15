/**
 * P0.5 作业层验收 harness（规格 spec-p0.5.md §8，断言 A17–A24）
 *
 * 设计原则（关键）：
 * 1. **隔离**：自带临时业务库（JUNWUYOU_DB）+ 独立端口（PORT），不碰生产库
 *    —— 原因：生产库已被测试数据污染 33/36 行（附录 D8/D9），本 harness 不再加剧；
 * 2. **真实路径**：真实 HTTP 调用 + 真实 SQLite + 真实 server.js，不用 mock 替身；
 * 3. **高德依赖注入**：起本地 stub 并注入 AMAP_API_BASE，使地理编码可测且不出网；
 * 4. **子进程输出落文件**（不用管道）：避免受限沙箱下 pipe 的 EPERM，且失败可回看日志。
 *
 * 运行：node scripts/verify-worker-p05.mjs
 * 退出码：0 = 全绿；1 = 有失败
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');       // 仓库根 D:\project\ai-sales
const SERVER_DIR = path.join(ROOT, 'junwuyou', 'server');
const SERVER_ENTRY = path.join(SERVER_DIR, 'server.js');

const PORT = Number(process.env.WORKER_TEST_PORT || 53900);
const AMAP_STUB_PORT = Number(process.env.AMAP_STUB_PORT || 53901);
const ADMIN_TOKEN = 'test-admin-token';
const BASE = `http://127.0.0.1:${PORT}`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'junwuyou-p05-'));
const TEST_DB = path.join(TMP, 'test.db');
const SERVER_LOG = path.join(TMP, 'server.log');

// ---------------- 断言框架 ----------------
let passed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n── ${t}`); }

async function req(method, url, { token, admin, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  // 注意：既有的 adminAuth 读的是 x-admin-token / ?token=（不是 Bearer），
  // 这里按产品现状发 header，不为测试去改产品鉴权行为
  if (admin) headers['x-admin-token'] = admin;
  const r = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  const text = await r.text();
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: r.status, json, text };
}

// ---------------- 高德 stub（依赖注入，使地理编码可测） ----------------
const stubState = { calls: 0, mode: 'ok' };
function startAmapStub() {
  const srv = createServer((r, q) => {
    stubState.calls++;
    const u = new URL(r.url, 'http://x');
    const addr = u.searchParams.get('address') || '';
    q.setHeader('Content-Type', 'application/json');
    if (stubState.mode === 'fail' || addr.includes('无法解析')) {
      return q.end(JSON.stringify({ status: '1', count: '0', geocodes: [] }));
    }
    if (stubState.mode === 'quota') {
      return q.end(JSON.stringify({ status: '0', info: 'DAILY_QUERY_OVER_LIMIT', infocode: '10003' }));
    }
    q.end(JSON.stringify({
      status: '1', count: '1',
      geocodes: [{ formatted_address: addr, location: '113.934184,22.502255', level: '兴趣点' }],
    }));
  });
  return new Promise((res) => srv.listen(AMAP_STUB_PORT, '127.0.0.1', () => res(srv)));
}

// ---------------- 服务生命周期 ----------------
let child = null;
let stubSrv = null;
function shutdown() {
  stopServer();
  // 必须关掉 stub，否则事件循环不退出 → harness 挂住（本次实测踩到）
  if (stubSrv) { try { stubSrv.close(); } catch {} stubSrv = null; }
}
async function startServer() {
  const out = fs.openSync(SERVER_LOG, 'a');
  child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    stdio: ['ignore', out, out],           // 落文件，不用 pipe
    env: {
      ...process.env,
      PORT: String(PORT),
      JUNWUYOU_DB: TEST_DB,
      ADMIN_TOKEN: 'test-admin-token',
      AMAP_API_BASE: `http://127.0.0.1:${AMAP_STUB_PORT}`,
      GD_GIS_KEY: 'test-amap-key',
      WORKER_INIT_PASSWORD: 'junwuyou',
      WORKER_FORCE_PASSWORD_CHANGE: 'true',
      WORKER_LOCATION_RETENTION_DAYS: '30',
    },
  });
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch { /* 未就绪 */ }
  }
  return false;
}
function stopServer() {
  if (child && !child.killed) { try { child.kill(); } catch {} }
  child = null;
}

// ---------------- 库查询助手（只读核验落库真相） ----------------
function db() { return new DatabaseSync(TEST_DB, { readOnly: true }); }
// undefined 不能绑定为 SQLite 参数（会抛 ERR_INVALID_ARG_TYPE）→ 统一归一为 null
const bind = (args) => args.map((a) => (a === undefined ? null : a));
function q1(sql, ...args) { const d = db(); try { return d.prepare(sql).get(...bind(args)); } finally { d.close(); } }
function qa(sql, ...args) { const d = db(); try { return d.prepare(sql).all(...bind(args)); } finally { d.close(); } }

// ---------------- 测试数据 ----------------
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function main() {
  const stub = await startAmapStub();
  stubSrv = stub;
  const up = await startServer();
  if (!up) {
    console.error('✗ 服务未能启动，日志：');
    console.error(fs.readFileSync(SERVER_LOG, 'utf8').split('\n').slice(-30).join('\n'));
    shutdown();
    process.exit(1);
  }

  // 造真实业务数据：客户 + 两张分派给不同师傅的单
  const cust = await req('POST', '/api/customers/upsert', { body: { wecom_user_id: 'p05:test-customer', name: '测试客户', phone: '13900000000', address: '深圳市南山区科技园3栋201' } });
  const customerId = cust.json?.customer?.id;
  const o1 = await req('POST', '/api/orders', { body: { customer_id: customerId, technician_id: 'tech_001', scheduled_date: TODAY, start_slot: 20, end_slot: 22, pest_type: '蟑螂', area_sqm: 100, price: 189, address: '深圳市南山区科技园3栋201', community_name: '科技园' } });
  const o2 = await req('POST', '/api/orders', { body: { customer_id: customerId, technician_id: 'tech_002', scheduled_date: TODAY, start_slot: 24, end_slot: 26, pest_type: '白蚁', area_sqm: 80, price: 129, address: '深圳市南山区科技园3栋201', community_name: '科技园' } });
  const orderZhang = o1.json?.order?.id;
  const orderLi = o2.json?.order?.id;

  // 主管建账号：张 / 李（口令 = 统一初始口令）
  for (const [tid, uname] of [['tech_001', 'zhang'], ['tech_002', 'li']]) {
    await req('POST', '/api/admin/workers', { admin: ADMIN_TOKEN, body: { technician_id: tid, username: uname, initial_password: 'junwuyou' } });
  }
  const rosterResp = await req('GET', '/api/admin/workers', { admin: ADMIN_TOKEN });
  ok('前置：主管可建账号且名册可见（≥4 人）', rosterResp.status === 200 && (rosterResp.json?.workers ?? []).length >= 4, `status=${rosterResp.status}`);

  // ================= A17 师傅身份与越权 =================
  section('A17 师傅身份与越权');
  const noTok = await req('GET', '/api/worker/tasks');
  ok('A17a 无 token 访问作业接口 → 401', noTok.status === 401, `实际 ${noTok.status}`);

  const badLogin = await req('POST', '/api/worker/login', { body: { username: 'zhang', password: 'wrong-password' } });
  ok('A17b 错误口令 → 401', badLogin.status === 401, `实际 ${badLogin.status}`);

  const login = await req('POST', '/api/worker/login', { body: { username: 'zhang', password: 'junwuyou' } });
  ok('A17c 正确口令登录 → 200 且返回 token', login.status === 200 && !!login.json?.token, `实际 ${login.status}`);
  ok('A17c2 首登标记 must_change_password=true（统一口令风险处置）', login.json?.worker?.must_change_password === true || login.json?.must_change_password === true, JSON.stringify(login.json?.worker ?? {}));
  const tokZhang = login.json?.token;

  const loginLi = await req('POST', '/api/worker/login', { body: { username: 'li', password: 'junwuyou' } });
  const tokLi = loginLi.json?.token;

  // 首登强制改密 → 改密前业务接口被拒（安全默认；可用开关关闭）
  const beforeChange = await req('GET', '/api/worker/tasks', { token: tokZhang });
  ok('A17d 强制改密生效：改密前访问业务接口 → 403', beforeChange.status === 403, `实际 ${beforeChange.status} ${beforeChange.text.slice(0, 80)}`);

  const chg = await req('POST', '/api/worker/change-password', { token: tokZhang, body: { old_password: 'junwuyou', new_password: 'zhang-real-pass-1' } });
  ok('A17e 改密成功 → 200', chg.status === 200, `实际 ${chg.status} ${chg.text.slice(0, 80)}`);
  await req('POST', '/api/worker/change-password', { token: tokLi, body: { old_password: 'junwuyou', new_password: 'li-real-pass-1' } });

  // 改密后旧 token 应失效（token_version 递增）→ 重新登录
  const relogin = await req('POST', '/api/worker/login', { body: { username: 'zhang', password: 'zhang-real-pass-1' } });
  const tz = relogin.json?.token;
  const reloginLi = await req('POST', '/api/worker/login', { body: { username: 'li', password: 'li-real-pass-1' } });
  const tl = reloginLi.json?.token;
  ok('A17f 改密后可用新口令登录', relogin.status === 200 && !!tz, `实际 ${relogin.status}`);

  // 越权：张只看得到自己的单
  const tasksZhang = await req('GET', '/api/worker/tasks', { token: tz });
  const ids = (tasksZhang.json?.tasks ?? []).map((t) => t.id);
  ok('A17g 张可见自己的单', ids.includes(orderZhang), `tasks=${JSON.stringify(ids)}`);
  ok('A17h 张看不到李的单（越权隔离）', !ids.includes(orderLi), `tasks=${JSON.stringify(ids)}`);

  // 越权：请求他人工单详情 → 403/404
  const otherOrder = await req('GET', `/api/worker/tasks/${orderLi}`, { token: tz });
  ok('A17i 访问他人工单详情被拒', otherOrder.status === 403 || otherOrder.status === 404, `实际 ${otherOrder.status}`);

  // 登出后失效
  const logout = await req('POST', '/api/worker/logout', { token: tz });
  const afterLogout = await req('GET', '/api/worker/tasks', { token: tz });
  ok('A17j 登出后 token 失效 → 401', logout.status === 200 && afterLogout.status === 401, `logout=${logout.status} after=${afterLogout.status}`);
  const tz2 = (await req('POST', '/api/worker/login', { body: { username: 'zhang', password: 'zhang-real-pass-1' } })).json?.token;

  // 重置口令后旧 token 失效
  await req('POST', '/api/admin/workers/tech_001/reset-password', { admin: ADMIN_TOKEN, body: { initial_password: 'junwuyou' } });
  const afterReset = await req('GET', '/api/worker/tasks', { token: tz2 });
  ok('A17k 主管重置口令后旧 token 立即失效', afterReset.status === 401, `实际 ${afterReset.status}`);
  const tz3 = (await req('POST', '/api/worker/login', { body: { username: 'zhang', password: 'junwuyou' } })).json?.token;
  await req('POST', '/api/worker/change-password', { token: tz3, body: { old_password: 'junwuyou', new_password: 'zhang-real-pass-2' } });
  const tz4 = (await req('POST', '/api/worker/login', { body: { username: 'zhang', password: 'zhang-real-pass-2' } })).json?.token;

  // ================= A22 位置合规（先测"未打卡禁止"，再打卡） =================
  section('A22 位置合规');
  const before = q1('SELECT COUNT(*) AS n FROM worker_locations')?.n ?? 0;
  const noShift = await req('POST', '/api/worker/locations', { token: tz4, body: { points: [{ lat: 22.5, lng: 113.9, accuracy: 20, source: 'gps' }] } });
  const after = q1('SELECT COUNT(*) AS n FROM worker_locations')?.n ?? 0;
  ok('A22a 未打卡上报位置 → 403', noShift.status === 403, `实际 ${noShift.status}`);
  ok('A22b 未打卡时库中无新增位置', after === before, `before=${before} after=${after}`);

  // ================= A18 打卡与状态 =================
  section('A18 打卡与状态流转');
  const ci = await req('POST', '/api/worker/check-in', { token: tz4, body: { location: { lat: 22.5023, lng: 113.9342, accuracy: 25, source: 'gps' } } });
  ok('A18a 打卡成功 → 返回 shift 与 idle', ci.status === 200 && ci.json?.status === 'idle' && !!ci.json?.shift_id, JSON.stringify(ci.json).slice(0, 120));
  const shiftRows = qa('SELECT id FROM worker_shifts WHERE technician_id = ? AND check_out_at IS NULL', 'tech_001');
  ok('A18b 打卡生成唯一未结束 shift', shiftRows.length === 1, `实际 ${shiftRows.length} 条`);

  const ciAgain = await req('POST', '/api/worker/check-in', { token: tz4, body: { location: { lat: 22.5, lng: 113.9, accuracy: 25, source: 'gps' } } });
  const shiftRows2 = qa('SELECT id FROM worker_shifts WHERE technician_id = ? AND check_out_at IS NULL', 'tech_001');
  ok('A18c 同日重复打卡被拒', ciAgain.status >= 400 && ciAgain.status < 500, `实际 ${ciAgain.status}`);
  ok('A18d 重复打卡未产生第二条 shift', shiftRows2.length === 1, `实际 ${shiftRows2.length} 条`);

  ok('A18e 打卡位置落库且 source=gps', (q1('SELECT check_in_source AS s, check_in_accuracy AS a FROM worker_shifts WHERE id = ?', ci.json?.shift_id)?.s) === 'gps');

  // 状态手动切换
  const busy = await req('POST', '/api/worker/status', { token: tz4, body: { status: 'busy', reason: '出发去客户处' } });
  ok('A18f 状态切换为 busy', busy.status === 200 && busy.json?.status === 'busy', JSON.stringify(busy.json).slice(0, 100));
  ok('A18g 状态变更留痕', (q1('SELECT COUNT(*) AS n FROM worker_status_log WHERE technician_id = ?', 'tech_001')?.n ?? 0) >= 2);

  // ================= A21 位置三级兜底 =================
  section('A21 位置三级兜底');
  const gps = await req('POST', '/api/worker/locations', { token: tz4, body: { points: [{ lat: 22.6001, lng: 113.8001, accuracy: 18, source: 'gps' }] } });
  const gpsRow = q1('SELECT lat, lng, source, accuracy FROM worker_locations WHERE technician_id = ? ORDER BY id DESC LIMIT 1', 'tech_001');
  ok('A21a GPS 路径落库 source=gps 且坐标一致', gps.status === 200 && gpsRow?.source === 'gps' && Math.abs(gpsRow.lat - 22.6001) < 1e-9 && Math.abs(gpsRow.lng - 113.8001) < 1e-9, JSON.stringify(gpsRow));

  stubState.mode = 'ok';
  const manual = await req('POST', '/api/worker/locations', { token: tz4, body: { points: [{ address: '深圳市南山区招商海月花园', occurred_at: new Date().toISOString() }] } });
  const manualRow = q1("SELECT lat, lng, source, accuracy FROM worker_locations WHERE technician_id = ? AND source = 'manual_geocoded' ORDER BY id DESC LIMIT 1", 'tech_001');
  ok('A21b 手工地址 → 服务端地理编码 → source=manual_geocoded', manual.status === 200 && !!manualRow, `status=${manual.status} row=${JSON.stringify(manualRow)}`);
  ok('A21c 地理编码结果 accuracy=community（精度降级标注）', manualRow?.accuracy === 'community', `实际 ${manualRow?.accuracy}`);
  ok('A21d 地理编码确实由服务端调用高德（stub 被调用）', stubState.calls > 0, `calls=${stubState.calls}`);

  const unresolvable = await req('POST', '/api/worker/locations', { token: tz4, body: { points: [{ address: '这个地址无法解析xyz' }] } });
  const fbRow = q1("SELECT source, accuracy FROM worker_locations WHERE technician_id = ? AND source = 'fallback' ORDER BY id DESC LIMIT 1", 'tech_001');
  ok('A21e 地址不可解析 → 回退历史位置 source=fallback', unresolvable.status === 200 && !!fbRow, `status=${unresolvable.status} row=${JSON.stringify(fbRow)}`);

  // 无 GPS 无地址 → 明确报错，不写空坐标
  const emptyBefore = q1('SELECT COUNT(*) AS n FROM worker_locations')?.n ?? 0;
  const empty = await req('POST', '/api/worker/locations', { token: tz4, body: { points: [{}] } });
  const emptyAfter = q1('SELECT COUNT(*) AS n FROM worker_locations')?.n ?? 0;
  ok('A21f 无 GPS 无地址 → 明确报错且不落库', empty.status >= 400 && emptyAfter === emptyBefore, `status=${empty.status}`);

  // 幂等：同 dedup_key 补传两次只落一条
  const dk = 'p05-dedup-' + Date.now();
  const p1 = await req('POST', '/api/worker/locations', { token: tz4, body: { points: [{ lat: 22.51, lng: 113.91, accuracy: 30, source: 'gps', dedup_key: dk }] } });
  const p2 = await req('POST', '/api/worker/locations', { token: tz4, body: { points: [{ lat: 22.51, lng: 113.91, accuracy: 30, source: 'gps', dedup_key: dk }] } });
  const dup = q1('SELECT COUNT(*) AS n FROM worker_locations WHERE dedup_key = ?', dk)?.n ?? 0;
  ok('A21g 弱网补传同一 dedup_key → 只落一条（幂等）', dup === 1, `实际 ${dup} 条；p1=${p1.status} p2=${p2.status}`);

  // ================= A23 精度分级 =================
  section('A23 精度分级生效');
  const nul = q1("SELECT COUNT(*) AS n FROM worker_locations WHERE source IS NULL OR accuracy IS NULL OR accuracy = ''")?.n ?? 0;
  ok('A23a 所有位置 source/accuracy 必填非空', nul === 0, `空值 ${nul} 条`);
  const coar = await req('GET', '/api/worker/me/locations?from=2000-01-01&to=2100-01-01', { token: tz4 });
  const pts = coar.json?.points ?? [];
  const geo = pts.find((p) => p.source === 'manual_geocoded');
  ok('A23b 低精度点被标注 precision_level=coarse', geo?.precision_level === 'coarse', `geo=${JSON.stringify(geo)}`);
  const gpsP = pts.find((p) => p.source === 'gps');
  ok('A23c GPS 点标注 precision_level=fine', gpsP?.precision_level === 'fine', `gps=${JSON.stringify(gpsP)}`);

  // ================= A22c/A22d 保留期限与同意留痕 =================
  section('A22（续）保留期限与知情同意');
  ok('A22d 首次登录产生知情同意留痕', (q1("SELECT COUNT(*) AS n FROM consent_records WHERE kind = 'privacy_location'")?.n ?? 0) >= 1);
  // 保留期限按**真实口径**验证：把历史点回拨 40 天，再按 30 天保留期清理。
  // 不用 retention_days=0 这种退化情形 —— 那证不了生产语义，也验不出"误删近期数据"。
  const writable = new DatabaseSync(TEST_DB);
  try {
    writable.exec("UPDATE worker_locations SET at = datetime('now', '-40 days')");
    // 留一条"今天的点"作边界样本：清理**不得**误删保留期内的数据
    writable.prepare(
      "INSERT INTO worker_locations (technician_id, at, lat, lng, accuracy, source) VALUES ('tech_001', datetime('now'), 22.5, 113.9, '20', 'gps')"
    ).run();
  } finally { writable.close(); }
  const beforeCleanup = q1('SELECT COUNT(*) AS n FROM worker_locations')?.n ?? 0;
  const cleanup = await req('POST', '/api/admin/worker-locations/cleanup', { admin: ADMIN_TOKEN, body: { retention_days: 30 } });
  const remain = q1('SELECT COUNT(*) AS n FROM worker_locations')?.n ?? 0;
  ok('A22c 超过保留期限（30 天）的位置被清理', cleanup.status === 200 && remain === 1, `清理前=${beforeCleanup} 清理后=${remain}（应剩 1 条今天的）`);
  ok('A22c2 保留期内（今天）的位置不被误删', remain === 1 && (q1("SELECT COUNT(*) AS n FROM worker_locations WHERE date(at) = date('now')")?.n ?? 0) === 1, `剩余=${remain}`);

  // ================= A18 完工上报 =================
  section('A18（续）完工上报与订单闭环');
  const complete = await req('POST', `/api/worker/tasks/${orderZhang}/complete`, { token: tz4, body: { location: { lat: 22.5023, lng: 113.9342, accuracy: 22, source: 'gps' }, note: '已消杀完成' } });
  const ord = q1('SELECT status, completed_at FROM orders WHERE id = ?', orderZhang);
  ok('A18h 完工上报 → 订单 completed', complete.status === 200 && ord?.status === 'completed', `status=${complete.status} order=${JSON.stringify(ord)}`);
  ok('A18i completed_at 已写入（补附录 D2 缺失路径）', !!ord?.completed_at, JSON.stringify(ord));
  const completeAgain = await req('POST', `/api/worker/tasks/${orderZhang}/complete`, { token: tz4, body: {} });
  ok('A18j 重复完工上报 → 明确拒绝（不重复副作用）', completeAgain.status >= 400 && completeAgain.status < 500, `实际 ${completeAgain.status}`);
  const completeOther = await req('POST', `/api/worker/tasks/${orderLi}/complete`, { token: tz4, body: {} });
  ok('A18k 完成他人工单被拒', completeOther.status === 403 || completeOther.status === 404, `实际 ${completeOther.status}`);

  // 下班打卡 → offline
  const co = await req('POST', '/api/worker/check-out', { token: tz4, body: { location: { lat: 22.5023, lng: 113.9342, accuracy: 22, source: 'gps' } } });
  const tech = q1('SELECT status FROM technicians WHERE id = ?', 'tech_001');
  ok('A18l 下班打卡 → offline', co.status === 200 && co.json?.status === 'offline' && tech?.status === 'offline', JSON.stringify(co.json).slice(0, 100));

  // ================= A22 下班后 0 采集 =================
  section('A22 下班后 0 采集（合规硬断言）');
  const cntBefore = q1('SELECT COUNT(*) AS n FROM worker_locations')?.n ?? 0;
  const afterCheckout = await req('POST', '/api/worker/locations', { token: tz4, body: { points: [{ lat: 22.5, lng: 113.9, accuracy: 20, source: 'gps' }] } });
  const cntAfter = q1('SELECT COUNT(*) AS n FROM worker_locations')?.n ?? 0;
  ok('A22e 下班打卡后上报位置 → 403', afterCheckout.status === 403, `实际 ${afterCheckout.status}`);
  ok('A22f 下班打卡后库中 0 新增（"下班后不采集"）', cntAfter === cntBefore, `before=${cntBefore} after=${cntAfter}`);

  // ================= A24 密码安全 =================
  section('A24 密码安全');
  const acct = q1('SELECT password_hash, hash_algo FROM worker_accounts WHERE technician_id = ?', 'tech_001');
  ok('A24a 口令以哈希存储（库中无明文口令）', !!acct?.password_hash && !String(acct.password_hash).includes('junwuyou') && !String(acct.password_hash).includes('zhang-real-pass'), `hash 片段=${String(acct?.password_hash).slice(0, 24)}...`);
  ok('A24b 记录哈希算法（可审计/可升级）', !!acct?.hash_algo, JSON.stringify(acct));

  // 连续错误 → 锁定（用李的账号避免影响后续）
  let lockStatus = null;
  for (let i = 0; i < 6; i++) {
    const r = await req('POST', '/api/worker/login', { body: { username: 'li', password: 'definitely-wrong' } });
    lockStatus = r.status;
  }
  ok('A24c 连续错误口令触发限流/锁定（返回 423 或 429）', lockStatus === 423 || lockStatus === 429, `最后状态 ${lockStatus}`);
  const lockedRight = await req('POST', '/api/worker/login', { body: { username: 'li', password: 'li-real-pass-1' } });
  ok('A24d 锁定期间正确口令也被拒', lockedRight.status === 423 || lockedRight.status === 429 || lockedRight.status === 401, `实际 ${lockedRight.status}`);

  const errText = JSON.stringify(badLogin.json) + JSON.stringify(lockedRight.json);
  ok('A24e 错误响应不回显口令', !errText.includes('definitely-wrong') && !errText.includes('junwuyou'), errText.slice(0, 120));

  // ================= A20 迁移友好（结构一致性） =================
  section('A20 迁移友好（表结构与规格逐字段比对）');
  const expectTechCols = ['skills', 'status', 'last_seen_at', 'openid', 'unionid'];
  const techCols = qa('PRAGMA table_info(technicians)').map((c) => c.name);
  for (const c of expectTechCols) ok(`A20a technicians.${c} 存在`, techCols.includes(c), `实际列=${techCols.join(',')}`);

  const tables = qa("SELECT name FROM sqlite_master WHERE type='table'").map((t) => t.name);
  for (const t of ['worker_accounts', 'worker_shifts', 'worker_locations', 'worker_status_log', 'worker_tokens', 'consent_records']) {
    ok(`A20b 表 ${t} 存在`, tables.includes(t));
  }
  const orderCols = qa('PRAGMA table_info(orders)').map((c) => c.name);
  const extra = orderCols.filter((c) => !['id', 'customer_id', 'technician_id', 'status', 'pest_type', 'area_sqm', 'price', 'address', 'community_name', 'scheduled_date', 'start_slot', 'end_slot', 'created_at', 'cancelled_at', 'completed_at'].includes(c));
  ok('A20c orders 未新增临时字段（仅补 completed_at）', extra.length === 0, `意外字段=${extra.join(',')}`);

  // 真实名册（D-16/Q31：张/李/刘/孙）
  const roster = qa('SELECT id, name FROM technicians ORDER BY id').map((r) => `${r.id}:${r.name}`);
  ok('A20d 真实名册就位（张/李/刘/孙，替换种子）', roster.length >= 4 && roster.some((r) => r.includes('刘')) && roster.some((r) => r.includes('孙')), roster.join(' '));

  // ================= V-014 跨实现对齐（slot ⇄ 时钟时间） =================
  section('V-014 对齐断言：作业层 slot 换算 ⇄ 客服侧唯一实现（逐点比对）');
  const agentSlotMod = await import(pathToFileURL(path.join(ROOT, 'runtime', 'openmozi', 'junwuyou', 'lib', 'slot-time.js')).href);
  const workerSlotMod = (await import(pathToFileURL(path.join(ROOT, 'junwuyou', 'server', 'worker', 'slot-time.js')).href)).default;
  const mismatches = [];
  for (let s = 0; s <= 48; s++) {
    const a = agentSlotMod.slotToTime(s);
    const b = workerSlotMod.slotToTime(s);
    if (a !== b) mismatches.push(`slot ${s}: 客服侧=${a} 作业层=${b}`);
  }
  ok('A20e slot→时钟换算逐点一致（0..48 共 49 点）', mismatches.length === 0, mismatches.slice(0, 5).join('; '));
  ok('A20f 工作窗端点一致（18=09:00 / 42=21:00）', workerSlotMod.slotToTime(18) === '09:00' && workerSlotMod.slotToTime(42) === '21:00');

  const tasksForLabel = await req('GET', '/api/worker/tasks', { token: tz4 });
  const t0 = (tasksForLabel.json?.tasks ?? []).find((t) => t.id === orderZhang);
  ok('A20g 任务接口由服务端给出 time_label（前端不做换算）', t0?.time_label === workerSlotMod.slotRangeLabel(20, 22), `实际 ${t0?.time_label}`);

  // ---------------- 汇总 ----------------
  console.log('\n' + '='.repeat(60));
  console.log(`P0.5 作业层验收：${passed} 通过 / ${failures.length} 失败`);
  if (failures.length) {
    console.log('\n失败清单：');
    for (const f of failures) console.log('  - ' + f);
  }
  console.log('='.repeat(60));

  shutdown();
  process.exit(failures.length ? 1 : 0);
}

process.on('SIGINT', () => { shutdown(); process.exit(1); });
main().catch((e) => {
  console.error('harness 异常：', e);
  console.error('服务日志尾部：\n' + (fs.existsSync(SERVER_LOG) ? fs.readFileSync(SERVER_LOG, 'utf8').split('\n').slice(-20).join('\n') : '(无)'));
  shutdown();
  process.exit(1);
});
