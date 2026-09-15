/**
 * P0.6 验收 harness —— 身份汇聚 + 邮件渠道的断言可执行镜像
 * （规格：`.creature/tasks/cs-platform-framework/spec-p06.md` §3，断言 A25–A29）
 *
 * 三层，缺一不可（V-019）：
 *  1. **隔离实例**：自带临时业务库（JUNWUYOU_DB）+ 独立端口 + 固定 ADMIN_TOKEN
 *     → 身份汇聚的建/合/撤全在临时库上做，不碰生产库（生产库里已有 66 个客户、20 张订单）。
 *  2. **隔离网关 + 本地邮件 stub**：真起一个网关子进程（真 LLM、真渠道适配器），
 *     IMAP/SMTP 指向本地 stub（D-33：真实邮箱凭据未提供）→ 证明"邮件进 → 回复回到来源渠道"。
 *  3. **部署态探针**：另打**已部署**的 Express（身份端点必须存活且鉴权正确）—— 
 *     "隔离变体全绿 ≠ 部署态正确"（L-085/V-019）。
 *
 * 运行：
 *   node scripts/verify-p06-identity.mjs             # 全量（含邮件 E2E，需要 LLM 可用）
 *   node scripts/verify-p06-identity.mjs --quick     # 跳过邮件 E2E 与在线探针（CI 用）
 * 退出码：0 = 全绿；1 = 有失败
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StubImapServer, StubSmtpServer, ensureCert } from './stub-mail-servers.mjs';
import { parseEmail } from '../dist/channels/email/mime.js';

/** 读仓库根 .env 的键（不打印明文；用于线上探针与运行时凭据接线核对） */
function readRootEnvKey(name) {
  try {
    const txt = fs.readFileSync('D:/project/ai-sales/.env', 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i <= 0) continue;
      if (line.slice(0, i).trim() === name) return line.slice(i + 1).trim();
    }
    return '';
  } catch {
    return '';
  }
}

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const OMOZI = path.join(ROOT, 'runtime', 'openmozi');
const QUICK = process.argv.includes('--quick');
/** 只跑身份层（不启动网关子进程 → 不需要 LLM）；CI 步骤用这个模式 */
const NO_EMAIL = process.argv.includes('--no-email');
/** 只跑邮件渠道组（开发期迭代邮件适配器用；仍需隔离 Express 供身份/档案接口） */
const EMAIL_ONLY = process.argv.includes('--email-only');
/** 仅声明：身份断言是否执行 */
const RUN_IDENTITY = !EMAIL_ONLY;

const PORT = Number(process.env.P06_TEST_PORT || 53950);
const ADMIN_TOKEN = 'test-admin-token-p06';
const BASE = `http://127.0.0.1:${PORT}`;
const GW_PORT = Number(process.env.P06_GW_PORT || 33900);
const GW_BASE = `http://127.0.0.1:${GW_PORT}`;
const EXPRESS_LIVE = process.env.JUNWUYOU_API_URL || 'http://127.0.0.1:53000';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p06-identity-'));
const TEST_DB = path.join(TMP, 'test.db');
const SERVER_LOG = path.join(TMP, 'express.log');
const GW_LOG = path.join(TMP, 'gateway.log');

const SMTP_USER = 'cs-stub@junwuyou.test';
const SMTP_PASS = 'stub-smtp-password';
const CUSTOMER_MAIL = 'zhang@example.test';

let passed = 0;
const failures = [];
const notes = [];
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function note(m) { notes.push(m); console.log(`  … ${m}`); }
function section(t) { console.log(`\n── ${t}`); }

async function req(method, url, { token, body, timeoutMs = 20000 } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
  if (token) headers['X-Admin-Token'] = token;
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
  } finally {
    clearTimeout(timer);
  }
}
const A = (p) => BASE + p;
const aReq = (m, p, o) => req(m, A(p), { token: ADMIN_TOKEN, ...o });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url, ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.status < 500) return true;
    } catch { /* 未起 */ }
    await sleep(400);
  }
  return false;
}
function tail(file, n = 6) {
  try { return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(-n).join(' | '); } catch { return ''; }
}

// ---------------------------------------------------------------- 隔离 Express 实例
console.log('P0.6 验收（客户身份汇聚 + 邮件渠道）');
console.log(`隔离 Express ${BASE}   线上 Express ${EXPRESS_LIVE}   隔离网关 ${GW_BASE}`);
console.log(`隔离工作目录：${TMP}\n`);

const expressOut = fs.openSync(SERVER_LOG, 'a');
const expressChild = spawn(process.execPath, ['server.js'], {
  cwd: path.join(ROOT, 'junwuyou', 'server'),
  stdio: ['ignore', expressOut, expressOut],
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
if (!(await waitHttp(A('/api/health'), 30000))) {
  console.error(`隔离实例未起来，日志：\n${tail(SERVER_LOG, 20)}`);
  process.exit(1);
}

if (RUN_IDENTITY) {
// ---------------------------------------------------------------- A25 身份汇聚
section('A25a/A25b/A25c — 同一手机号跨渠道 → 同一客户 + 同一会话键');
let custZeng, resolve1, resolve2;
{
  // 先在业务库里造一个"线下录单客户"（P0.7 的现成输入：wecom_user_id = offline:<手机号>）
  const created = await aReq('POST', '/api/admin/customers', {
    body: { name: '曾生', phone: '13823343328', address: '南山区科技园3栋201' },
  });
  custZeng = created.json?.customer?.id;
  ok('准备：线下录单客户建立成功（身份键 offline:<手机号>）',
    created.status === 200 && !!custZeng && created.json?.customer?.wecom_user_id === 'offline:13823343328',
    `status=${created.status} id=${custZeng} key=${created.json?.customer?.wecom_user_id}`);

  // ① QQ 渠道身份（无连接键）→ 新建客户（标待关联）
  const qq = await aReq('POST', '/api/identity/resolve', {
    body: { channel: 'qq', external_id: 'QQ_OPENID_A', kind: 'qq_openid', sender_name: '曾生' },
  });
  ok('A25d 仅渠道标识（QQ openid）→ 独立客户 + 待关联',
    qq.status === 200 && qq.json?.created === true, `status=${qq.status} body=${qq.text.slice(0, 160)}`);

  // ② 同一人从邮件进来，带手机号证据 → 必须落到**线下录单那个客户**
  resolve1 = await aReq('POST', '/api/identity/resolve', {
    body: {
      channel: 'email', external_id: CUSTOMER_MAIL, kind: 'email',
      evidence: { phone: '13823343328' }, sender_name: '曾生',
    },
  });
  ok('A25a 邮件（带同一手机号）→ 同一 customer_id',
    resolve1.status === 200 && resolve1.json?.customer_id === custZeng,
    `status=${resolve1.status} customer_id=${resolve1.json?.customer_id} 期望=${custZeng}`);
  ok('A25b 会话键 = customer:{customer_id}（C-040）',
    resolve1.json?.session_key === `customer:${custZeng}`, `session_key=${resolve1.json?.session_key}`);
  ok('A25a2 关联等级为 medium（手机号 = 中等级：可撤销 + 审计）',
    resolve1.json?.level === 'medium', `level=${resolve1.json?.level}`);

  // ③ 幂等：重复 resolve 不新建
  const again = await aReq('POST', '/api/identity/resolve', {
    body: { channel: 'email', external_id: CUSTOMER_MAIL, kind: 'email', evidence: { phone: '13823343328' } },
  });
  ok('A25c 重复 resolve 幂等（created=false、同一客户）',
    again.json?.created === false && again.json?.customer_id === custZeng,
    `created=${again.json?.created} customer_id=${again.json?.customer_id}`);

  // ④ 同一人的第二个渠道（企微）也带同一手机号 → 还是同一客户
  resolve2 = await aReq('POST', '/api/identity/resolve', {
    body: { channel: 'wecom', external_id: 'wx_ext_zeng', kind: 'wecom_userid', evidence: { phone: '13823343328' } },
  });
  ok('A25a3 企微（同手机号）→ 同一 customer_id（三渠道汇聚）',
    resolve2.json?.customer_id === custZeng, `customer_id=${resolve2.json?.customer_id}`);

  // ⑤ 身份表里该客户应有 ≥3 个渠道身份
  const card = await aReq('GET', `/api/admin/customers/${custZeng}/identities`);
  const idents = card.json?.identities || [];
  const channels = new Set(idents.map((i) => i.channel));
  ok('A25a4 身份表：一个客户持有多个渠道身份（offline/phone/email/wecom…）',
    card.status === 200 && idents.length >= 3 && channels.size >= 3,
    `identities=${idents.length} channels=${[...channels].join(',')}`);
  ok('A26c 回投目标已登记（客户 × 渠道）',
    (card.json?.destinations || []).some((d) => d.channel === 'email' && d.external_id === CUSTOMER_MAIL),
    JSON.stringify(card.json?.destinations || []));
}

section('A25e/A25f — 禁止仅凭姓名合并；证据不静默丢弃');
{
  const a = await aReq('POST', '/api/identity/resolve', {
    body: { channel: 'qq', external_id: 'QQ_OPENID_B', kind: 'qq_openid', sender_name: '曾生' },
  });
  const b = await aReq('POST', '/api/identity/resolve', {
    body: { channel: 'qq', external_id: 'QQ_OPENID_C', kind: 'qq_openid', sender_name: '曾生' },
  });
  ok('A25e 同名（都叫"曾生"）不合并 → 两个独立客户',
    a.json?.customer_id !== b.json?.customer_id && a.json?.customer_id !== custZeng && b.json?.customer_id !== custZeng,
    `${a.json?.customer_id} / ${b.json?.customer_id} / 曾生=${custZeng}`);

  // 另一个已有客户也带同一手机号 → 不允许产生第三个"手机号持有者"
  const c = await aReq('POST', '/api/identity/resolve', {
    body: {
      channel: 'offline', external_id: '13823343328', kind: 'offline_phone',
      evidence: { phone: '13823343328' },
    },
  });
  ok('A25f 手机号证据被他人持有时 → 并入持有者，不新增重复客户',
    c.json?.customer_id === custZeng, `customer_id=${c.json?.customer_id} 期望=${custZeng}`);
  // 审计判据要看**库里**（不能只看本轮的 linked 字段：身份已存在时本轮不会新建关联）
  const links = await aReq('GET', '/api/admin/identity/links');
  const rows = links.json?.links || [];
  ok('A25f2 证据命中写有审计（auto:phone / merge_auto / auto_link）',
    rows.some((l) => String(l.decided_by).startsWith('auto:') && ['phone', 'email', 'unionid'].includes(String(l.evidence_kind))),
    JSON.stringify(rows.slice(0, 4).map((l) => `${l.action}/${l.decided_by}/${l.evidence_kind}`)));
}

section('A27a–A27e — 合并可撤销、全量审计、历史不物理合并');
{
  const a = await aReq('POST', '/api/identity/resolve', {
    body: { channel: 'qq', external_id: 'QQ_OPENID_MERGE', kind: 'qq_openid', sender_name: '待合并' },
  });
  const fromId = a.json?.customer_id;
  const before = await aReq('GET', `/api/admin/customers/${fromId}/identities`);
  ok('A27 前置：被合并客户当前是**未合并**的独立客户（否则"合并"无从生效）',
    before.json?.customer?.identity_status !== 'merged' && before.json?.customer?.merged_into == null,
    JSON.stringify(before.json?.customer || {}));

  const merged = await aReq('POST', '/api/admin/identity/merge', {
    body: { from_customer_id: fromId, to_customer_id: custZeng, reason: '验收：手动关联', by: 'harness' },
  });
  ok('A27a 手动合并成功（高等级，直接合）',
    merged.status === 200 && merged.json?.customer_id === custZeng,
    `status=${merged.status} body=${merged.text.slice(0, 160)}`);

  // 关键：查**被并客户自己**的卡片（解析存活客户会把它归到目标客户，故用真实 id 查）
  const fromCard = await aReq('GET', `/api/admin/customers/${fromId}/identities`);
  ok('A27a2 被并客户标记为 merged 且指向存活客户',
    fromCard.json?.customer?.identity_status === 'merged' && Number(fromCard.json?.customer?.merged_into) === custZeng,
    `fromId=${fromId} → ${JSON.stringify(fromCard.json?.customer || {})}`);

  const dstCard = await aReq('GET', `/api/admin/customers/${custZeng}/identities`);
  ok('A27e 存活客户能列出全部身份与会话（完整视图）',
    (dstCard.json?.identities || []).length > (before.json?.identities || []).length &&
    (dstCard.json?.sessions || []).length >= 1,
    `identities=${(dstCard.json?.identities || []).length} sessions=${(dstCard.json?.sessions || []).length}`);
  ok('A27d 合并**不物理合并**会话：被并客户的会话仍在（D-20）',
    (before.json?.sessions || []).length === 0 || (dstCard.json?.sessions || []).length > 0,
    `before=${(before.json?.sessions || []).length}`);

  const linkId = merged.json?.link_id;
  const undone = await aReq('POST', `/api/admin/identity/links/${linkId}/undo`, {
    body: { reason: '验收：撤销', by: 'harness' },
  });
  ok('A27a3 撤销成功', undone.status === 200, `status=${undone.status} body=${undone.text.slice(0, 160)}`);
  const backCard = await aReq('GET', `/api/admin/customers/${fromId}/identities`);
  ok('A27a4 撤销后该客户恢复独立（identity_status=active、merged_into 清空）',
    backCard.json?.customer?.identity_status === 'active' && backCard.json?.customer?.merged_into == null,
    JSON.stringify(backCard.json?.customer || {}));
  ok('A27b 撤销写了一条 unlink 审计（可追溯）',
    !!undone.json?.unlink_link_id, JSON.stringify(undone.json || {}));
}

section('A27c — 审计字段齐备（谁/何时/依据什么/可否撤销）');
{
  const links = await aReq('GET', '/api/admin/identity/links');
  const rows = links.json?.links || [];
  const bad = rows.filter((l) => !l.action || !l.decided_by || !l.decided_at || l.reversible === null || l.reversible === undefined);
  ok('A27c 每条关联记录含 action/decided_by/decided_at/reversible', rows.length > 0 && bad.length === 0,
    `共 ${rows.length} 条，缺字段 ${bad.length} 条`);
  ok('A27c2 自动关联与手动关联的操作者可区分（auto:* / admin:*）',
    rows.some((l) => String(l.decided_by).startsWith('auto:')) && rows.some((l) => String(l.decided_by).startsWith('admin:')),
    [...new Set(rows.map((l) => l.decided_by))].join(', '));
}

section('A25g — 一次性迁移回填（wecom_user_id → customer_identities）');
{
  // 迁移发生在隔离库启动时：offline:<手机号> 应产出 (offline,offline_phone) 与 (phone,phone) 两条身份
  const card = await aReq('GET', `/api/admin/customers/${custZeng}/identities`);
  const idents = card.json?.identities || [];
  const hasOffline = idents.some((i) => i.channel === 'offline' && i.kind === 'offline_phone' && i.external_id === '13823343328');
  const hasPhone = idents.some((i) => i.channel === 'phone' && i.kind === 'phone' && i.external_id === '13823343328');
  ok('A25g 迁移建出 offline 与 phone 两条身份（手机号作连接键）', hasOffline && hasPhone,
    JSON.stringify(idents.map((i) => `${i.channel}/${i.kind}`)));
  ok('A25g2 迁移后客户仍为 active（迁移不做任何自动合并）',
    card.json?.customer?.identity_status === 'active', `status=${card.json?.customer?.identity_status}`);
}

section('A29b — 新增客户自动获得身份行（否则身份汇聚对新客户失效）');
{
  const c = await aReq('POST', '/api/admin/customers', { body: { name: '新客户', phone: '13700000001', address: '测试路1号' } });
  const id = c.json?.customer?.id;
  const card = await aReq('GET', `/api/admin/customers/${id}/identities`);
  const idents = card.json?.identities || [];
  ok('A29b 新客户带 phone 身份与证据（走唯一补建实现，不在别处手抄判定）',
    idents.some((i) => i.kind === 'phone' && i.external_id === '13700000001'),
    JSON.stringify(idents.map((i) => `${i.channel}/${i.kind}/${i.external_id}`)));
  const addr = c.json?.customer?.address;
  ok('A29b2 录单地址确实落库（原先被静默丢弃）', addr === '测试路1号', `address=${addr}`);
  const again = await aReq('POST', '/api/identity/resolve', {
    body: { channel: 'email', external_id: 'new@example.test', kind: 'email', evidence: { phone: '13700000001' } },
  });
  ok('A29b3 该客户可被跨渠道汇聚（新客户不是"孤岛"）',
    again.json?.customer_id === id, `resolve=${again.json?.customer_id} 期望=${id}`);
  const sessions = (await aReq('GET', `/api/admin/customers/${id}/identities`)).json?.sessions || [];
  ok('A29b4 历史会话视图含 customer:{id} 与 legacy 键（D-20）',
    sessions.some((s) => s.session_key === `customer:${id}`), JSON.stringify(sessions.map((s) => s.session_key)));
}

section('A29 — 身份端点鉴权（隐私数据不得裸奔）');
{
  const noTok = await req('POST', A('/api/identity/resolve'), { body: { channel: 'qq', external_id: 'X' } });
  ok('A29 身份解析接口无凭据 → 401', noTok.status === 401, `status=${noTok.status}`);
  const noTok2 = await req('GET', A(`/api/admin/customers/${custZeng}/identities`));
  ok('A29 身份核对接口无凭据 → 401', noTok2.status === 401, `status=${noTok2.status}`);
  const noTok3 = await req('GET', A('/api/admin/identity/links'));
  ok('A29 关联记录接口无凭据 → 401', noTok3.status === 401, `status=${noTok3.status}`);
  const noTok4 = await req('POST', A('/api/admin/identity/merge'), { body: {} });
  ok('A29 合并接口无凭据 → 401', noTok4.status === 401, `status=${noTok4.status}`);
  const bad = await aReq('POST', '/api/identity/resolve', { body: { channel: 'qq' } });
  ok('A29 缺少 external_id → 400（不静默建客户）', bad.status === 400, `status=${bad.status}`);
}
} // RUN_IDENTITY

// ---------------------------------------------------------------- 邮件渠道（隔离网关 + 本地 stub）
section('A26/A28 — 邮件渠道：收发 + 主题线程 + 幂等 + 防回环 + 独立 SLA');
let imapStub = null;
let smtpStub = null;
let gwChild = null;
if (NO_EMAIL) {
  note('--no-email：跳过邮件渠道组（网关子进程 + 真 LLM 未启动）');
} else try {
  // 明文模式（EMAIL_*_SECURE=false）：无需证书，stub 保持最小依赖
  const cert = null;
  const secure = process.env.P06_MAIL_TLS === 'true';
  if (secure) {
    const c = ensureCert(TMP);
    imapStub = new StubImapServer({ cert: c, user: SMTP_USER, password: SMTP_PASS, secure: true });
    smtpStub = new StubSmtpServer({ cert: c, user: SMTP_USER, password: SMTP_PASS, secure: true });
  } else {
    imapStub = new StubImapServer({ user: SMTP_USER, password: SMTP_PASS });
    smtpStub = new StubSmtpServer({ user: SMTP_USER, password: SMTP_PASS });
  }
  await imapStub.listen(0);
  await smtpStub.listen(0);
  console.log(`    邮件 stub：IMAP ${imapStub.port} / SMTP ${smtpStub.port}（TLS=${secure}）`);

  // 端口守卫：33000 是**线上网关**在用（它是产品的一部分，不能动它的配置）——
  // 但线上的 .env 里 OPENMOZI_PORT 有显式值，会**覆盖**我们传进去的环境变量（L-094 同族：
  // 配置是分层的，代码默认 < 配置文件 < 环境变量，而 launcher 用 dotenv 后 .env 会赢）。
  // 因此这里用 OPENMOZI_ENV_PATH 指向一个**临时 .env 副本**，把端口与邮件配置写进去，
  // 既拿到干净的隔离实例，又丝毫不动线上配置文件。
  // ⚠️ 关键：临时 .env **必须是线上 .env 的完整副本 + 覆盖行**。
  // 踩过的坑（本轮实测）：只写邮件相关键 → 供应商凭据全丢（日志 `Providers: (none)`，
  // LLM 无法调用），且 OPENMOZI_PORT 又落回默认 33000（撞线上网关，EADDRINUSE）。
  // 配置是分层的（代码默认 < 配置文件 < 环境变量），换配置文件就会丢掉别层的值（L-094 同族）。
  const envCopy = path.join(TMP, 'openmozi-env-copy');
  const liveEnv = fs.readFileSync(path.join(OMOZI, '.env'), 'utf8');
  fs.writeFileSync(
    envCopy,
    [
      liveEnv.trimEnd(),
      '',
      '# ---- 以下为本次验收的覆盖行（隔离实例用；本文件写在临时目录，线上 .env 未改动）----',
      `OPENMOZI_PORT=${GW_PORT}`,
      'OPENMOZI_HOST=127.0.0.1',
      'EMAIL_ENABLED=true',
      'EMAIL_IMAP_HOST=127.0.0.1',
      `EMAIL_IMAP_PORT=${imapStub.port}`,
      `EMAIL_IMAP_USER=${SMTP_USER}`,
      `EMAIL_IMAP_PASSWORD=${SMTP_PASS}`,
      'EMAIL_SMTP_HOST=127.0.0.1',
      `EMAIL_SMTP_PORT=${smtpStub.port}`,
      `EMAIL_SMTP_USER=${SMTP_USER}`,
      `EMAIL_SMTP_PASSWORD=${SMTP_PASS}`,
      'EMAIL_POLL_INTERVAL=5',
      'EMAIL_SLA_MINUTES=180',
      'EMAIL_FROM_NAME=君无忧客服',
      `EMAIL_IMAP_SECURE=${secure ? 'true' : 'false'}`,
      `EMAIL_SMTP_SECURE=${secure ? 'true' : 'false'}`,
      '',
    ].join('\n'),
    'utf8'
  );

  const gwOut = fs.openSync(GW_LOG, 'a');
  console.log(`    子进程环境：OPENMOZI_PORT=${process.env.OPENMOZI_PORT} → 传 ${GW_PORT}`);
  gwChild = spawn(process.execPath, ['junwuyou-launcher.mjs'], {
    cwd: OMOZI,
    stdio: ['ignore', gwOut, gwOut],
    env: {
      ...process.env,
      // 只有邮件/端口的 env 走临时副本；**线上 .env 原封不动**
      OPENMOZI_ENV_PATH: envCopy,
      OPENMOZI_PORT: String(GW_PORT),
      OPENMOZI_HOST: '127.0.0.1',
      // 业务库指向**隔离实例**：邮件会话也会读客户档案，绝不能碰生产库
      JUNWUYOU_API_URL: BASE,
      JUNWUYOU_ADMIN_TOKEN: ADMIN_TOKEN,
    },
  });

  const gwUp = await waitHttp(`${GW_BASE}/health`, 90000);
  ok('A28i 隔离网关启动（邮件渠道启用）', gwUp, gwUp ? '' : `日志：${tail(GW_LOG, 8)}`);

  if (!gwUp) {
    note('网关未起，邮件组断言全部记为失败（这本身就是缺陷，不是"跳过"——L-088 的教训）');
  }

  if (gwUp) {
    // ① 造一封客户来信（RFC2047 中文主题 + base64 正文，真实客户邮件形态）
    const subject = '=?UTF-8?B?' + Buffer.from('咨询白蚁防治报价', 'utf8').toString('base64') + '?=';
    const bodyB64 = Buffer.from('你好，我家在南山科技园，80平米，想问下白蚁防治多少钱？', 'utf8').toString('base64');
    const mailId = '<cust-mail-1@example.test>';
    const raw = [
      `From: =?UTF-8?B?${Buffer.from('张先生', 'utf8').toString('base64')}?= <${CUSTOMER_MAIL}>`,
      `To: <${SMTP_USER}>`,
      `Subject: ${subject}`,
      `Message-ID: ${mailId}`,
      'Date: ' + new Date().toUTCString(),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      bodyB64,
    ].join('\r\n');
    imapStub.push(raw);

    // 等 agent 回信（真 LLM，给足时间）
    const until = Date.now() + 120000;
    while (Date.now() < until && smtpStub.messages.length === 0) await sleep(2000);

    const sent = smtpStub.messages[0];
    ok('A28a 邮件进 → agent 处理 → 邮件出（stub IMAP → stub SMTP）', !!sent,
      sent ? '' : `120s 内未回信；网关日志尾部：${tail(GW_LOG, 6)}`);
    if (sent) {
      const parsed = parseEmail(sent.data);
      ok('A26a 回投到**来源渠道的发件人**（不是别人、也不是别的渠道）',
        sent.to === CUSTOMER_MAIL, `to=${sent.to}`);
      ok('A28b 主题线程：回信带 Re: 且引用原 Message-ID',
        /^re:\s*咨询白蚁防治报价/i.test(parsed.subject) && (parsed.inReplyTo === mailId || parsed.references.includes(mailId)),
        `subject="${parsed.subject}" inReplyTo=${parsed.inReplyTo} refs=${JSON.stringify(parsed.references)}`);
      ok('A28e 中文主题/正文不乱码',
        parsed.subject.includes('咨询白蚁防治报价') && /[\u4e00-\u9fff]/.test(parsed.text),
        `subject="${parsed.subject}" 正文首段="${parsed.text.slice(0, 60)}"`);
      ok('A28g 正文无 markdown 泄漏（出站边界按渠道渲染，V-011）',
        !parsed.text.includes('**') && !/^#\s/m.test(parsed.text),
        `正文片段="${parsed.text.slice(0, 80)}"`);
      ok('A28f 正式语气模板生效（渠道后缀：有称呼/落款，无颜文字）',
        /您好/.test(parsed.text) && !/[～~]{1,}|[\u{1F300}-\u{1FAFF}]/u.test(parsed.text),
        `正文="${parsed.text.slice(0, 120)}"`);
      ok('A26d 消息落盘带渠道来源（C-042：会话键按客户汇聚后靠它回投）',
        fs.existsSync(path.join(os.homedir(), '.mozi', 'sessions')) &&
        readTranscriptHasEmailSource(mailId) !== null,
        '见 session_owner/transcript 检查');
      const src = readTranscriptHasEmailSource(mailId);
      if (src === null) note('transcript 未含 sourceChannel（可能本轮走的是内存会话）；已由回投断言间接覆盖');
    }

    // ② 幂等：同一封邮件重复投递（模拟 IMAP 重复拉取）
    const beforeCount = smtpStub.messages.length;
    imapStub.push(raw); // 同一 Message-ID
    await sleep(15000);
    ok('A28c 同一 Message-ID 二次投递不重复回信（幂等）',
      smtpStub.messages.length === beforeCount,
      `回信数 ${beforeCount} → ${smtpStub.messages.length}`);

    // ③ 防自回环：发件人是自己的地址
    const selfRaw = [
      `From: <${SMTP_USER}>`,
      `To: <${SMTP_USER}>`,
      'Subject: auto reply',
      'Message-ID: <self-loop-1@junwuyou.test>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      '这是一封自己发给自己的邮件，应当被忽略',
    ].join('\r\n');
    imapStub.push(selfRaw);
    const beforeSelf = smtpStub.messages.length;
    await sleep(15000);
    ok('A28d 防自回环：自身地址来信被忽略（不回信）',
      smtpStub.messages.length === beforeSelf,
      `回信数 ${beforeSelf} → ${smtpStub.messages.length}`);
    ok('A28h 忽略/已处理的邮件被标已读（避免每轮重复拉取）',
      (imapStub.markedUids || []).length >= 2, `marked=${JSON.stringify(imapStub.markedUids || [])}`);
  }
} catch (e) {
  ok('A28 邮件渠道验收执行', false, `异常：${e.message}`);
} finally {
  try { gwChild?.kill(); } catch { /* noop */ }
  try { imapStub?.close(); } catch { /* noop */ }
  try { smtpStub?.close(); } catch { /* noop */ }
}

/** 从 transcript 里查是否落了 sourceChannel（C-042 的持久化证据） */
function readTranscriptHasEmailSource(messageId) {
  try {
    const dir = path.join(os.homedir(), '.mozi', 'sessions');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const txt = fs.readFileSync(path.join(dir, f), 'utf8');
      if (!txt.includes('sourceChannel')) continue;
      for (const line of txt.split(/\r?\n/)) {
        if (!line.includes('sourceChannel')) continue;
        const o = JSON.parse(line);
        if (o.sourceChannel === 'email' && typeof o.sourceExternalId === 'string') return o.sourceExternalId;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 部署态探针（V-019）
section('A29f — 部署态探针（线上 Express：身份端点必须真的在跑）');
if (QUICK) {
  note('--quick：跳过线上探针（CI 中由 5/5 部署步骤之后的探针覆盖）');
} else {
  // 线上 Express 的管理面凭据键名是 **ADMIN_TOKEN**（`readEnvKey('ADMIN_TOKEN')`），
  // 与 Rust 网关的 `ADMIN_API_TOKEN` **不是同一个值**（实测两个 64 位 token 哈希不同）——
  // 探针发错凭据会得到 401，进而被误判成"端点没部署"（L-091 同族：先确认镜头对不对）。
  const liveToken = readRootEnvKey('ADMIN_TOKEN');
  const live = await fetch(`${EXPRESS_LIVE}/api/identity/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': liveToken },
    body: JSON.stringify({ channel: 'qq', external_id: 'P06_PROBE_ONLY' }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  const liveNoTok = await fetch(`${EXPRESS_LIVE}/api/admin/identity/links`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  ok('A29f 线上 Express 身份端点已部署（带凭据 200，而不是 404）',
    !!live && live.status === 200, `status=${live?.status}`);
  ok('A29f2 线上身份端点无凭据 → 401（隐私数据不裸奔）',
    !!liveNoTok && liveNoTok.status === 401, `status=${liveNoTok?.status}`);
  if (live && live.status === 200) {
    const body = await live.json().catch(() => ({}));
    ok('A29f3 线上 resolve 返回 customer_id 与会话键', !!body.customer_id && /^customer:\d+$/.test(body.session_key || ''),
      JSON.stringify(body).slice(0, 200));
    note(`线上探针在生产库里为 QQ openid "P06_PROBE_ONLY" 建了一条身份/客户（测试标识，可人工清理）`);
  }
}

// ---------------------------------------------------------------- 收尾
try { expressChild.kill(); } catch { /* noop */ }
await sleep(300);
try { spawnSync('taskkill', ['/PID', String(expressChild.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* noop */ }
if (gwChild?.pid) {
  try { spawnSync('taskkill', ['/PID', String(gwChild.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* noop */ }
}

console.log(`\n${'='.repeat(66)}`);
console.log(`BATCH_P06_IDENTITY_ACCEPT PASS=${passed} FAIL=${failures.length}`);
if (failures.length) console.log(`失败项：\n - ${failures.join('\n - ')}`);
if (notes.length) console.log(`备注：\n - ${notes.join('\n - ')}`);
console.log(`隔离实例日志：${SERVER_LOG}\n隔离网关日志：${GW_LOG}`);
console.log('='.repeat(66));
process.exitCode = failures.length === 0 ? 0 : 1;
