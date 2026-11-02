'use strict';
/*
 * 云进销存 —— 生产版服务端（零依赖，只用 Node 自带模块）
 *
 * 相比"NAS 自建版"多出来的东西：
 *   1. 登录页 + 会话 Cookie（30 天免登录），公网暴露时不至于裸奔
 *   2. 同一 IP 连续输错密码会限速，防暴力破解
 *   3. PWA：可"添加到主屏幕"，离线也能打开（数据仍走同步队列补传）
 *   4. 数据原子落盘 + 每日备份，断电不会留下半个 JSON
 *
 * 接口：
 *   GET  /login            登录页
 *   POST /api/login        提交密码 {pass}
 *   GET  /api/logout       退出
 *   GET  /api/health       探活（免登录）
 *   GET  /api/db           取整库 {ver, db}
 *   POST /api/db           提交整库 {ver, db}，版本对不上返回 409 + 服务器那份
 *   GET  /api/backups      列出每日备份
 *   其余                   静态文件（web/ 目录）
 *
 * 环境变量：
 *   PORT / ERP_PASS / DATA_DIR / WEB_DIR / MAX_MB / KEEP_DAYS
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = +(process.env.PORT || 8080);
const PASS = process.env.ERP_PASS || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const WEB_DIR = process.env.WEB_DIR || path.join(__dirname, 'web');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BK_DIR = path.join(DATA_DIR, 'bk');
const LOG_FILE = path.join(DATA_DIR, 'server.log');
const MAX_BODY = +(process.env.MAX_MB || 64) * 1024 * 1024;
const KEEP_DAYS = +(process.env.KEEP_DAYS || 14);
const SESSION_DAYS = +(process.env.SESSION_DAYS || 30);
const COOKIE = 'erp_sess';

/* ---------- 目录准备 ---------- */
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BK_DIR, { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch (e) {
  console.error(`[致命] 数据目录不可写：${DATA_DIR}（${e.message}）`);
  process.exit(1);
}
if (!PASS) {
  console.warn('[警告] 没有设置 ERP_PASS。放到公网上等于把账本挂在门口，务必先设置密码。');
}

/* ---------- 日志 ---------- */
function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) { /* 日志写不进不影响主流程 */ }
}

/* ---------- 数据 ---------- */
let ST = { ver: 0, db: null, savedAt: '' };
function load() {
  try {
    const s = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    ST = { ver: +s.ver || 0, db: s.db || null, savedAt: s.savedAt || '' };
  } catch (e) {
    ST = { ver: 0, db: null, savedAt: '' };
  }
}
load();

function saveNow() {
  const tmp = DB_FILE + '.tmp';
  const body = JSON.stringify(ST);
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, DB_FILE);
  return body.length;
}

function dailyBackup() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const f = path.join(BK_DIR, day + '.json');
  try {
    if (!fs.existsSync(f) && fs.existsSync(DB_FILE)) {
      fs.copyFileSync(DB_FILE, f);
      log('已保留今日备份 ' + day + '.json');
    }
    const files = fs.readdirSync(BK_DIR).filter(x => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort();
    while (files.length > KEEP_DAYS) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(BK_DIR, old)); } catch (e) {}
    }
  } catch (e) { log('备份失败：' + e.message); }
}

/* ---------- 会话 ---------- */
const SESS = new Map();              // token -> 过期时间戳
const FAILS = new Map();             // ip -> {n, ts}
const MAX_FAIL = 8, FAIL_WINDOW = 10 * 60 * 1000;

function cookieGet(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function isHttps(req) {
  const fwd = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return fwd === 'https' || !!req.socket.encrypted;
}
function newSession(req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  SESS.set(token, Date.now() + SESSION_DAYS * 864e5);
  const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`];
  if (isHttps(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
  return token;
}
function authed(req) {
  if (!PASS) return true;
  const t = cookieGet(req, COOKIE);
  if (t) {
    const exp = SESS.get(t);
    if (exp && exp > Date.now()) return true;
    if (exp) SESS.delete(t);
  }
  return (req.headers['x-erp-pass'] || '') === PASS;
}
function samePass(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(PASS);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket.remoteAddress || 'unknown';
}

/* ---------- 响应工具 ---------- */
function baseHeaders(req) {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Robots-Tag': 'noindex, nofollow'
  };
  if (isHttps(req)) h['Strict-Transport-Security'] = 'max-age=31536000';
  return h;
}
function sendJson(req, res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  const h = Object.assign(baseHeaders(req), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  if (buf.length > 1024 && /gzip/.test(req.headers['accept-encoding'] || '')) {
    const z = zlib.gzipSync(buf);
    h['Content-Encoding'] = 'gzip';
    h['Content-Length'] = z.length;
    res.writeHead(code, h);
    return res.end(z);
  }
  h['Content-Length'] = buf.length;
  res.writeHead(code, h);
  res.end(buf);
}
function sendHtml(req, res, code, html, extra) {
  const buf = Buffer.from(html);
  const h = Object.assign(baseHeaders(req), {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache, must-revalidate'
  }, extra || {});
  h['Content-Length'] = buf.length;
  res.writeHead(code, h);
  res.end(buf);
}
function redirect(res, to, extra) {
  res.writeHead(302, Object.assign({ Location: to, 'Cache-Control': 'no-store' }, extra || {}));
  res.end();
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject({ code: 413 }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject({ code: 400 }); }
    });
    req.on('error', () => reject({ code: 400 }));
  });
}

/* ---------- 静态文件 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
function sendFile(req, res, file, opts) {
  let buf;
  try {
    if (!fs.statSync(file).isFile()) return false;
    buf = fs.readFileSync(file);
  } catch (e) { return false; }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const h = Object.assign(baseHeaders(req), {
    'Content-Type': type,
    'Cache-Control': (opts && opts.immutable) ? 'public, max-age=86400' : 'no-cache'
  });
  if (/^(text|application\/json|application\/manifest|image\/svg|text\/javascript)/.test(type)
      && buf.length > 1024 && /gzip/.test(req.headers['accept-encoding'] || '')) {
    const z = zlib.gzipSync(buf);
    h['Content-Encoding'] = 'gzip';
    h['Content-Length'] = z.length;
    res.writeHead(200, h);
    res.end(z);
    return true;
  }
  h['Content-Length'] = buf.length;
  res.writeHead(200, h);
  res.end(buf);
  return true;
}

/* ---------- 登录页 ---------- */
function loginPage(next, err) {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#3b5bdb"><title>登录 · 云进销存</title>
<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon-192.png">
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;min-height:100svh;display:flex;align-items:center;justify-content:center;padding:24px;
  background:linear-gradient(160deg,#eef2ff 0%,#f7f9fc 42%,#f1f5fb 100%);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#0f172a}
.card{width:100%;max-width:360px;background:#fff;border-radius:22px;padding:30px 24px 24px;
  box-shadow:0 24px 60px -28px rgba(23,43,99,.35),0 2px 8px rgba(23,43,99,.06)}
.logo{width:52px;height:52px;border-radius:15px;background:linear-gradient(140deg,#4c6ef5,#3b5bdb);
  display:flex;align-items:center;justify-content:center;margin-bottom:16px;
  box-shadow:0 10px 22px -10px rgba(59,91,219,.9)}
.logo svg{width:28px;height:28px}
h1{margin:0 0 4px;font-size:20px;letter-spacing:.3px}
p.sub{margin:0 0 22px;color:#697386;font-size:13px}
label{display:block;font-size:12.5px;color:#697386;margin-bottom:7px}
input{width:100%;height:48px;border:1.5px solid #e2e7f0;border-radius:13px;padding:0 14px;font-size:16px;
  background:#fbfcfe;color:#0f172a;outline:none;transition:.18s}
input:focus{border-color:#3b5bdb;background:#fff;box-shadow:0 0 0 4px rgba(59,91,219,.1)}
button{width:100%;height:48px;margin-top:16px;border:0;border-radius:13px;cursor:pointer;
  font-size:15.5px;font-weight:600;color:#fff;background:linear-gradient(140deg,#4c6ef5,#3b5bdb);
  box-shadow:0 12px 24px -12px rgba(59,91,219,.9);transition:.18s}
button:active{transform:translateY(1px)}
button[disabled]{opacity:.6}
.err{margin-top:14px;padding:10px 12px;border-radius:11px;background:#fef3f2;color:#b42318;font-size:13px;display:none}
.err.on{display:block}
.foot{margin-top:20px;text-align:center;font-size:11.5px;color:#9aa3b2}
</style></head><body>
<form class="card" id="f">
  <div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round">
    <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/></svg></div>
  <h1>云进销存</h1>
  <p class="sub">请输入访问密码后继续</p>
  <label for="p">访问密码</label>
  <input id="p" type="password" name="pass" autocomplete="current-password" inputmode="text"
         placeholder="管理员设置的密码" autofocus required>
  <button id="b" type="submit">进入系统</button>
  <div class="err${err ? ' on' : ''}" id="e">${err ? esc(err) : ''}</div>
  <div class="foot">登录一次，30 天内免密码</div>
</form>
<script>
var next=${JSON.stringify(next || '/')};
document.getElementById('f').addEventListener('submit', async function(ev){
  ev.preventDefault();
  var b=document.getElementById('b'), e=document.getElementById('e');
  b.disabled=true; b.textContent='验证中…'; e.className='err';
  try{
    var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({pass:document.getElementById('p').value})});
    var j=await r.json().catch(function(){return {}});
    if(r.ok&&j.ok){ location.replace(next); return; }
    e.textContent = j.error==='rate' ? '密码错误次数过多，请 10 分钟后再试' : '密码不对，再试一次';
    e.className='err on';
  }catch(err){ e.textContent='连不上服务器，检查网络后重试'; e.className='err on'; }
  b.disabled=false; b.textContent='进入系统';
});
</script></body></html>`;
}

/* ---------- 路由 ---------- */
function safeNext(n) {
  const s = String(n || '/');
  return (s.startsWith('/') && !s.startsWith('//')) ? s : '/';
}

const server = http.createServer(async (req, res) => {
  const full = req.url || '/';
  const qs = full.indexOf('?') >= 0 ? full.slice(full.indexOf('?')) : '';
  let p = '/';
  try { p = decodeURIComponent(full.split('?')[0]); } catch (e) { p = full.split('?')[0]; }

  /* --- 登录 --- */
  if (p === '/login' && req.method === 'GET') {
    const next = safeNext(new URLSearchParams(qs).get('next') || '/');
    if (authed(req)) return redirect(res, next);
    return sendHtml(req, res, 200, loginPage(next));
  }
  if (p === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const rec = FAILS.get(ip) || { n: 0, ts: Date.now() };
    if (Date.now() - rec.ts > FAIL_WINDOW) { rec.n = 0; rec.ts = Date.now(); }
    if (rec.n >= MAX_FAIL) {
      log(`登录被限速 ip=${ip}`);
      return sendJson(req, res, 429, { ok: false, error: 'rate' });
    }
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(req, res, 400, { ok: false, error: 'bad' }); }
    if (!PASS || samePass(body.pass)) {
      FAILS.delete(ip);
      newSession(req, res);
      log(`登录成功 ip=${ip}`);
      return sendJson(req, res, 200, { ok: true });
    }
    rec.n++; rec.ts = Date.now(); FAILS.set(ip, rec);
    log(`登录失败 ip=${ip} 第 ${rec.n} 次`);
    return sendJson(req, res, 401, { ok: false, error: 'pass' });
  }
  if (p === '/api/logout') {
    const t = cookieGet(req, COOKIE);
    if (t) SESS.delete(t);
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    return redirect(res, '/login');
  }

  /* --- 探活（免登录） --- */
  if (p === '/api/health') {
    return sendJson(req, res, 200, {
      ok: true, needPass: !!PASS, login: true, ver: ST.ver,
      savedAt: ST.savedAt, hasData: !!ST.db
    });
  }

  /* --- 图标 / manifest / sw：免登录，否则 PWA 装不上 --- */
  if (p === '/manifest.webmanifest' || p === '/sw.js' || p === '/icon-192.png' ||
      p === '/icon-512.png' || p === '/favicon.ico') {
    if (sendFile(req, res, path.join(WEB_DIR, p.slice(1)), { immutable: p !== '/sw.js' })) return;
  }

  /* --- 数据接口 --- */
  if (p === '/api/db') {
    if (!authed(req)) return sendJson(req, res, 401, { error: 'need-pass' });
    if (req.method === 'GET') {
      return sendJson(req, res, 200, { ver: ST.ver, db: ST.db, savedAt: ST.savedAt });
    }
    if (req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { return sendJson(req, res, e.code || 400, { error: 'bad-body' }); }
      const want = +((body && body.ver) || 0);
      if (want !== ST.ver) {
        return sendJson(req, res, 409, { ver: ST.ver, db: ST.db, conflict: true });
      }
      ST.ver = ST.ver + 1;
      ST.db = body.db;
      ST.savedAt = new Date().toISOString();
      let n = 0;
      try { n = saveNow(); }
      catch (e) {
        log('写入失败：' + e.message);
        return sendJson(req, res, 500, { error: 'write-failed' });
      }
      dailyBackup();
      log(`保存成功 ver=${ST.ver} ${(n / 1024).toFixed(1)}KB ip=${clientIp(req)}`);
      return sendJson(req, res, 200, { ver: ST.ver, savedAt: ST.savedAt });
    }
    return sendJson(req, res, 405, { error: 'method' });
  }

  if (p === '/api/backups') {
    if (!authed(req)) return sendJson(req, res, 401, { error: 'need-pass' });
    let list = [];
    try { list = fs.readdirSync(BK_DIR).filter(x => x.endsWith('.json')).sort().reverse(); } catch (e) {}
    return sendJson(req, res, 200, { backups: list });
  }

  /* --- 应用首页：登录后才给 --- */
  if (p === '/' || p === '/index.html') {
    if (PASS && !authed(req)) return redirect(res, '/login?next=' + encodeURIComponent('/'));
    if (sendFile(req, res, path.join(WEB_DIR, '进销存ERP.html'))) return;
    return sendHtml(req, res, 200,
      '<!DOCTYPE html><meta charset="utf-8"><p style="font:15px/2 -apple-system,sans-serif;padding:40px">' +
      '服务已启动，但 web/ 目录里还没有 <b>进销存ERP.html</b>。</p>');
  }

  /* --- 其它静态文件 --- */
  const safe = path.normalize(p).replace(/^[\\/]+/, '');
  if (/\.html?$/i.test(safe) && PASS && !authed(req)) {
    return redirect(res, '/login?next=' + encodeURIComponent(p));
  }
  const root = path.resolve(WEB_DIR);
  const f = path.resolve(root, safe);
  if (safe.indexOf('..') === -1 && f.startsWith(root + path.sep) && sendFile(req, res, f)) return;

  res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, baseHeaders(req)));
  res.end('404');
});

process.on('uncaughtException', e => log('未捕获异常：' + (e && e.stack || e)));

server.listen(PORT, '0.0.0.0', () => {
  log(`云进销存 已启动 · 端口 ${PORT}`);
  log(`数据目录 ${DATA_DIR}`);
  log(`密码 ${PASS ? '已设置（' + PASS.length + ' 位）' : '未设置'}`);
  log(`当前版本 ${ST.ver}${ST.db ? '' : '（空库，第一台打开的设备会上传）'}`);
});
