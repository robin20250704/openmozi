/**
 * 本地 IMAP / SMTP stub（P0.6 邮件渠道验收用；D-33）
 *
 * 为什么需要：真实邮箱凭据尚未提供（用户裁定 D-33：先用本地 stub 验收）。
 * 但"用假服务器验收"不等于"降低标准"——stub 必须**说真实协议**：
 *   - IMAP 侧支持 LOGIN / SELECT / UID SEARCH UNSEEN / UID FETCH BODY.PEEK[] / UID STORE / LOGOUT
 *   - SMTP 侧支持 EHLO / AUTH LOGIN / MAIL FROM / RCPT TO / DATA / QUIT
 * 这样被测的是**产品代码里那套 hand-written 协议实现**（IMAP 轮询与 SMTP 发信都是本项目自己写的），
 * 而不是"被 stub 宠坏的简化路径"。TLS 用自签证书 + 客户端未开严格校验（与真实邮箱一致的口径）。
 *
 * ⚠️ 已知边界（写进验收报告 §残留）：本 stub 不校验协议细节的严格性
 * （如 IMAP 字面量的边界情形、SMTP 扩展回落），真实邮箱互通仍属"未验证"。
 */
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 生成自签证书（一次性；用系统 openssl，失败则退回 node 自签） */
export function ensureCert(dir) {
  const keyFile = path.join(dir, 'stub-key.pem');
  const crtFile = path.join(dir, 'stub-crt.pem');
  if (fs.existsSync(keyFile) && fs.existsSync(crtFile)) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(crtFile) };
  }
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout', keyFile, '-out', crtFile,
    ], { stdio: 'ignore' });
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(crtFile) };
  } catch (e) {
    throw new Error(`生成自签证书失败（需要 openssl）：${e.message}`);
  }
}

// ---------------------------------------------------------------- IMAP stub

/**
 * 极简 IMAP 服务端。
 *   - 邮箱内容由 `push(mail)` 注入（status 为 'unread' | 'read'）
 *   - 记录客户端发出的每条命令（供断言"客户端真的登录/搜索/取信了"）
 */
export class StubImapServer {
  constructor({ cert = null, user, password, secure = false }) {
    this.cert = cert;
    this.secure = secure && !!cert;
    this.user = user;
    this.password = password;
    this.messages = [];      // { uid, raw, status }
    this.commands = [];      // 收到过的命令（原始行）
    this.loginCount = 0;
    this.logins = [];        // { user, password }
    this.server = null;
    this.port = 0;
    this.nextUid = 100;
  }

  push(rawMailText) {
    this.nextUid += 1;
    const uid = this.nextUid;
    this.messages.push({ uid, raw: rawMailText, status: 'unread' });
    return uid;
  }

  unread() { return this.messages.filter((m) => m.status === 'unread'); }

  listen(port = 0) {
    return new Promise((resolve, reject) => {
      const onConn = (sock) => this.handle(sock);
      this.server = this.secure
        ? tls.createServer({ key: this.cert.key, cert: this.cert.cert }, onConn)
        : net.createServer(onConn);
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  handle(sock) {
    sock.setEncoding('utf8');
    let buf = '';
    sock.write('* OK [CAPABILITY IMAP4rev1] stub ready\r\n');
    sock.on('data', (chunk) => {
      buf += chunk;
      // 一行一条命令（真实 IMAP 有字面量，但客户端侧发的都是简单命令）
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        this.command(line.trim(), sock);
      }
    });
    sock.on('error', () => { /* 客户端断开 */ });
  }

  command(line, sock) {
    this.commands.push(line);
    const m = /^(\S+)\s+(.*)$/.exec(line);
    if (!m) return;
    const tag = m[1];
    const cmd = m[2];
    const upper = cmd.toUpperCase();

    if (upper.startsWith('LOGIN')) {
      const parts = /LOGIN\s+"([^"]*)"\s+"([^"]*)"/i.exec(cmd);
      this.loginCount += 1;
      const cred = { user: parts?.[1], password: parts?.[2] };
      this.logins.push(cred);
      if (parts && parts[1] === this.user && parts[2] === this.password) sock.write(`${tag} OK LOGIN completed\r\n`);
      else sock.write(`${tag} NO LOGIN failed\r\n`);
      return;
    }
    if (upper.startsWith('SELECT')) {
      const exists = this.messages.length;
      sock.write(`* ${exists} EXISTS\r\n* OK [UIDVALIDITY 1] UIDs valid\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`);
      return;
    }
    if (upper.startsWith('UID SEARCH')) {
      const uids = this.unread().map((x) => x.uid);
      sock.write(`* SEARCH${uids.length ? ' ' + uids.join(' ') : ''}\r\n${tag} OK SEARCH completed\r\n`);
      return;
    }
    if (upper.startsWith('UID FETCH')) {
      const uid = Number((/UID FETCH (\d+)/i.exec(cmd) || [])[1]);
      const msg = this.messages.find((x) => x.uid === uid);
      if (!msg) { sock.write(`${tag} OK FETCH completed\r\n`); return; }
      const bytes = Buffer.from(msg.raw, 'utf8');
      sock.write(`* ${uid} FETCH (UID ${uid} BODY[] {${bytes.length}}\r\n`);
      sock.write(msg.raw);
      sock.write(`\r\n)\r\n${tag} OK FETCH completed\r\n`);
      return;
    }
    if (upper.startsWith('UID STORE')) {
      const ids = ((/UID STORE ([0-9,]+)/i.exec(cmd) || [])[1] || '').split(',').filter(Boolean).map(Number);
      for (const id of ids) {
        const msg = this.messages.find((x) => x.uid === id);
        if (msg) msg.status = 'read';
      }
      this.markedUids = (this.markedUids || []).concat(ids);
      sock.write(`${tag} OK STORE completed\r\n`);
      return;
    }
    if (upper.startsWith('LOGOUT')) {
      sock.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
      sock.end();
      return;
    }
    if (upper.startsWith('CAPABILITY')) {
      sock.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK\r\n`);
      return;
    }
    sock.write(`${tag} OK ${cmd.split(' ')[0]} completed\r\n`);
  }

  close() { try { this.server?.close(); } catch { /* noop */ } }
}

// ---------------------------------------------------------------- SMTP stub

/** 极简 SMTP 服务端：记录收到的报文（供断言"回信内容/线程头"） */
export class StubSmtpServer {
  constructor({ cert = null, user, password, secure = false }) {
    this.cert = cert;
    this.secure = secure && !!cert;
    this.user = user;
    this.password = password;
    this.messages = [];   // { from, to, data }
    this.commands = [];
    this.server = null;
    this.port = 0;
  }

  listen(port = 0) {
    return new Promise((resolve, reject) => {
      const onConn = (sock) => this.handle(sock);
      this.server = this.secure
        ? tls.createServer({ key: this.cert.key, cert: this.cert.cert }, onConn)
        : net.createServer(onConn);
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  handle(sock) {
    sock.setEncoding('utf8');
    let buf = '';
    let inData = false;
    let data = '';
    let from = '';
    let to = '';
    sock.write('220 stub SMTP ready\r\n');
    sock.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            this.messages.push({ from, to, data });
            sock.write('250 2.0.0 Ok: queued\r\n');
          } else {
            data += line + '\r\n';
          }
          continue;
        }
        this.commands.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          sock.write('250-stub\r\n250-AUTH LOGIN PLAIN\r\n250 OK\r\n');
        } else if (upper.startsWith('AUTH LOGIN')) {
          sock.write('334 VXNlcm5hbWU6\r\n');
          this._authStage = 'user';
        } else if (this._authStage === 'user') {
          this._authUser = Buffer.from(line, 'base64').toString('utf8');
          this._authStage = 'pass';
          sock.write('334 UGFzc3dvcmQ6\r\n');
        } else if (this._authStage === 'pass') {
          this._authPass = Buffer.from(line, 'base64').toString('utf8');
          this._authStage = null;
          if (this._authUser === this.user && this._authPass === this.password) sock.write('235 2.7.0 Authentication successful\r\n');
          else sock.write('535 5.7.8 Authentication failed\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          from = (/<([^>]*)>/.exec(line) || [])[1] || '';
          sock.write('250 OK\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          to = (/<([^>]*)>/.exec(line) || [])[1] || '';
          sock.write('250 OK\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          data = '';
          sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (upper === 'QUIT') {
          sock.write('221 Bye\r\n');
          sock.end();
        } else {
          sock.write('250 OK\r\n');
        }
      }
    });
    sock.on('error', () => { /* 客户端断开 */ });
  }

  close() { try { this.server?.close(); } catch { /* noop */ } }
}
