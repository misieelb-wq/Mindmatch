const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const srv = http.createServer(app);
const io = new Server(srv, {
  maxHttpBufferSize: 2048,
  perMessageDeflate: false,
  pingInterval: 25000,
  pingTimeout: 20000
});

const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'db.json');
const DB_TMP = `${DB_FILE}.tmp`;
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), 'backups');
const REPORTS_LOG = process.env.REPORTS_LOG_PATH || path.join(path.dirname(DB_FILE), 'reports.log');

if (!ADMIN_KEY || ADMIN_KEY.length < 12) {
  console.warn('[WARN] ADMIN_KEY тохируулаагүй эсвэл 12 тэмдэгтээс богино байна. Хүчтэй түлхүүр тавина уу.');
}

const PLANS = {
  d1: { days: 1, price: 1990, label: '1 өдөр' },
  d3: { days: 3, price: 3990, label: '3 өдөр' },
  d5: { days: 5, price: 5490, label: '5 өдөр' },
  d7: { days: 7, price: 6990, label: '7 өдөр' },
  m1: { days: 30, price: 14900, label: '1 сар' },
  m3: { days: 90, price: 34900, label: '3 сар' },
  y1: { days: 365, price: 99000, label: '1 жил' }
};

let db = { users: {}, orders: {} };
try {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.users = parsed.users && typeof parsed.users === 'object' ? parsed.users : {};
    db.orders = parsed.orders && typeof parsed.orders === 'object' ? parsed.orders : {};
  }
} catch (err) {
  console.error('[DB] db.json уншихад алдаа гарлаа:', err.message);
}

let dirty = false;
let saving = false;

function saveDbSync() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_TMP, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(DB_TMP, DB_FILE);
  dirty = false;
}

function saveDbAtomic() {
  if (!dirty || saving) return;
  saving = true;
  dirty = false;
  const payload = JSON.stringify(db, null, 2);
  fs.writeFile(DB_TMP, payload, 'utf8', err => {
    if (err) {
      dirty = true;
      saving = false;
      console.error('[DB] Түр файл бичихэд алдаа:', err.message);
      return;
    }
    fs.rename(DB_TMP, DB_FILE, renameErr => {
      saving = false;
      if (renameErr) {
        dirty = true;
        console.error('[DB] db.json шинэчлэхэд алдаа:', renameErr.message);
      }
    });
  });
}

function runBackup() {
  try {
    if (!fs.existsSync(DB_FILE)) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, `db-${stamp}.json`));
  } catch (err) {
    console.error('[BACKUP] Нөөцлөхөд алдаа:', err.message);
  }
}

setInterval(saveDbAtomic, 2000);
setInterval(runBackup, 6 * 3600 * 1000);
runBackup();

process.on('SIGINT', () => {
  try { if (dirty) saveDbSync(); } catch {}
  process.exit(0);
});
process.on('SIGTERM', () => {
  try { if (dirty) saveDbSync(); } catch {}
  process.exit(0);
});

const rateBuckets = new Map();
function allowRate(key, limit, windowMs) {
  const now = Date.now();
  const entry = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count += 1;
  rateBuckets.set(key, entry);
  return entry.count <= limit;
}

const getUser = token =>
  typeof token === 'string' && Object.prototype.hasOwnProperty.call(db.users, token) ? db.users[token] : null;
const isBanned = u => Boolean(u && (u.banned || (u.banUntil && Number(u.banUntil) > Date.now())));
const isPremium = token => {
  const u = getUser(token);
  return Boolean(u && Number(u.until || 0) > Date.now());
};

function activatePlan(token, planKey, customDays = null) {
  const u = getUser(token);
  if (!u) return null;
  let days = null;
  if (typeof customDays === 'number' && Number.isFinite(customDays) && customDays >= 1 && customDays <= 365) {
    days = Math.floor(customDays);
  } else if (PLANS[planKey]) {
    days = PLANS[planKey].days;
  }
  if (!days) return null;

  const baseTime = Math.max(Date.now(), Number(u.until || 0));
  u.until = baseTime + days * 86400000;
  dirty = true;
  return u.until;
}

const adminFailMap = new Map();
function checkAdmin(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ err: 'ADMIN_KEY тохируулаагүй байна' });
  const ip = req.ip || 'unknown';
  const fail = adminFailMap.get(ip);
  if (fail && fail.lockedUntil > Date.now()) {
    return res.status(429).json({ err: 'Хэт олон буруу оролдлого. Түр хүлээнэ үү.' });
  }

  const provided = req.headers['x-admin-key'] || (req.body && req.body.key) || req.query.key || '';
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(ADMIN_KEY));
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) {
    const nextCount = (fail ? fail.count : 0) + 1;
    adminFailMap.set(ip, {
      count: nextCount,
      lockedUntil: nextCount >= 5 ? Date.now() + 15 * 60 * 1000 : 0
    });
    return res.sendStatus(403);
  }

  adminFailMap.delete(ip);
  next();
}

app.get('/plans', (_, res) => res.json(PLANS));

app.post('/pay/claim', (req, res) => {
  const ip = req.ip || 'unknown';
  if (!allowRate(`claim:${ip}`, 12, 60 * 1000)) {
    return res.status(429).json({ err: 'Хэт олон хүсэлт илгээлээ. Түр хүлээнэ үү.' });
  }

  const { token, plan, refCode } = req.body || {};
  const u = getUser(token);
  const p = PLANS[plan];
  if (!u || !p) return res.status(400).json({ err: 'Багц эсвэл хэрэглэгчийн мэдээлэл буруу байна.' });
  if (isBanned(u)) return res.status(403).json({ err: 'Таны хандалт хаагдсан байна.' });

  const cleanRef = String(refCode || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || `MM${crypto.randomInt(100000, 999999)}`;
  const sid = cleanRef;

  if (!db.orders[sid]) {
    db.orders[sid] = {
      sid,
      token,
      plan,
      label: p.label,
      days: p.days,
      amount: p.price,
      status: 'submitted',
      done: false,
      createdAt: Date.now(),
      submittedAt: Date.now()
    };
  } else if (db.orders[sid].token === token && !db.orders[sid].done) {
    db.orders[sid].status = 'submitted';
    db.orders[sid].submittedAt = Date.now();
  }
  dirty = true;
  saveDbAtomic();
  res.json({ ok: true, sid, status: db.orders[sid].status });
});

app.get('/pay/status', (req, res) => {
  const sid = String(req.query.sid || '');
  const order = db.orders[sid];
  if (!order) return res.json({ paid: false, until: 0, status: 'unknown' });
  const prem = isPremium(order.token);
  const until = prem ? Number(db.users[order.token]?.until || 0) : 0;
  res.json({ paid: Boolean(order.done && prem), until, status: order.status });
});

app.get('/admin/orders', checkAdmin, (req, res) => {
  const list = Object.values(db.orders)
    .filter(o => o && o.sid && o.token)
    .sort((a, b) => (b.submittedAt || b.createdAt || 0) - (a.submittedAt || a.createdAt || 0))
    .slice(0, 200)
    .map(o => ({
      ...o,
      userPremium: isPremium(o.token),
      userUntil: Number(db.users[o.token]?.until || 0)
    }));
  res.json({ orders: list });
});

app.post('/admin/approve', checkAdmin, (req, res) => {
  const { sid, days } = req.body || {};
  const order = db.orders[sid];
  if (!order) return res.status(404).json({ err: 'Захиалга олдсонгүй.' });
  if (order.done && order.approvedAt && Date.now() - order.approvedAt < 5000) {
    return res.json({ ok: true, sid, until: Number(db.users[order.token]?.until || 0) });
  }

  const until = activatePlan(order.token, order.plan, days !== undefined ? Number(days) : null);
  if (!until) return res.status(400).json({ err: 'Хэрэглэгч эсвэл багц буруу байна.' });

  order.done = true;
  order.status = 'approved';
  order.approvedAt = Date.now();
  dirty = true;
  saveDbSync();
  res.json({ ok: true, sid, until });
});

app.post('/admin/activate', checkAdmin, (req, res) => {
  const { token, plan, days } = req.body || {};
  const until = activatePlan(token, plan, days !== undefined ? Number(days) : null);
  res.json({ ok: Boolean(until), until: until || 0 });
});

app.get('/admin/reports', checkAdmin, (req, res) => {
  const flagged = Object.entries(db.users)
    .filter(([, u]) => (u.reports && u.reports.length > 0) || isBanned(u))
    .map(([token, u]) => ({
      token,
      reportsCount: (u.reports || []).length,
      banned: Boolean(u.banned),
      banUntil: u.banUntil || 0
    }));
  res.json({ total: flagged.length, users: flagged });
});

app.post('/admin/unban', checkAdmin, (req, res) => {
  const u = getUser(req.body && req.body.token);
  if (!u) return res.sendStatus(404);
  u.banned = false;
  u.banUntil = 0;
  u.reports = [];
  dirty = true;
  res.json({ ok: true });
});

const waiting = [];
const activeTokens = new Map();

const isBlocked = (a, b) => (getUser(a.token)?.blocked || []).includes(b.token);
const isCompatible = (a, b) =>
  a.token !== b.token &&
  (!a.want || a.want === b.gender) &&
  !isBlocked(a, b) &&
  !isBlocked(b, a);

function removeFromWaiting(s) {
  const idx = waiting.indexOf(s);
  if (idx >= 0) waiting.splice(idx, 1);
}

function leaveChat(s, notifySelf = false) {
  removeFromWaiting(s);
  if (s.peer) {
    const partner = s.peer;
    partner.peer = null;
    s.peer = null;
    partner.emit('partner_left');
    if (notifySelf) s.emit('left_chat');
  }
}

io.on('connection', s => {
  s.on('hello', ({ token, gender, adult } = {}, cb) => {
    if (typeof cb !== 'function') return;
    if (adult !== true) return cb({ err: 'Зөвхөн 18+ насны хүмүүс нэвтэрнэ.' });

    let userToken = typeof token === 'string' && getUser(token) ? token : null;
    if (!userToken) {
      userToken = crypto.randomUUID();
      db.users[userToken] = { createdAt: Date.now(), blocked: [], reports: [] };
      dirty = true;
    }

    const u = getUser(userToken);
    if (isBanned(u)) {
      return cb({ err: 'Таны хандалт хаагдсан байна.' });
    }

    const prevSocket = activeTokens.get(userToken);
    if (prevSocket && prevSocket.id !== s.id) {
      leaveChat(prevSocket);
      prevSocket.emit('session_replaced');
      prevSocket.disconnect(true);
    }
    activeTokens.set(userToken, s);

    s.token = userToken;
    s.gender = ['m', 'f'].includes(gender) ? gender : null;
    u.gender = s.gender;
    dirty = true;

    const prem = isPremium(userToken);
    cb({
      token: userToken,
      premium: prem,
      until: prem ? Number(u.until || 0) : 0
    });
  });

  s.on('find', want => {
    if (!s.token) return;
    const u = getUser(s.token);
    if (!u || isBanned(u)) return s.emit('err_msg', 'Таны хандалт хаагдсан байна.');

    leaveChat(s);
    const prem = isPremium(s.token);
    if (['m', 'f'].includes(want) && !prem) {
      return s.emit('need_premium');
    }

    // Хугацаа дууссан бол автоматаар санамсаргүй хайлт (null) болно
    s.want = ['m', 'f'].includes(want) && prem ? want : null;
    s.waitSince = Date.now();

    const idx = waiting.findIndex(other => isCompatible(s, other) && isCompatible(other, s));
    if (idx < 0) {
      waiting.push(s);
      return s.emit('waiting');
    }

    const partner = waiting.splice(idx, 1)[0];
    s.peer = partner;
    partner.peer = s;
    const roomId = crypto.randomBytes(3).toString('hex').toUpperCase();
    s.emit('matched', { roomId });
    partner.emit('matched', { roomId });
  });

  s.on('cancel_find', () => {
    removeFromWaiting(s);
    s.emit('search_cancelled');
  });

  s.on('leave', () => leaveChat(s, true));

  s.on('msg', raw => {
    if (!s.peer || typeof raw !== 'string') return;
    const text = raw.trim();
    if (!text) return;

    const now = Date.now();
    if (now - (s.lastMsg || 0) < 350) return;
    s.lastMsg = now;

    s.peer.emit('msg', text.slice(0, 500));
  });

  s.on('typing', () => {
    if (s.peer) s.peer.emit('typing');
  });

  s.on('block', () => {
    if (!s.peer || !s.token) return;
    const u = getUser(s.token);
    if (u) {
      u.blocked ||= [];
      if (!u.blocked.includes(s.peer.token)) {
        u.blocked.push(s.peer.token);
        if (u.blocked.length > 500) u.blocked.shift();
      }
      dirty = true;
    }
    leaveChat(s, true);
  });

  s.on('report', reason => {
    if (!s.peer || !s.token) return;
    const targetToken = s.peer.token;
    const target = getUser(targetToken);
    if (!target) return;

    const cleanReason = String(reason || 'Шалтгаан бичээгүй').trim().slice(0, 200);
    fs.appendFile(
      REPORTS_LOG,
      JSON.stringify({
        t: new Date().toISOString(),
        from: s.token,
        against: targetToken,
        reason: cleanReason
      }) + '\n',
      () => {}
    );

    target.reports = [...new Set([...(target.reports || []), s.token])];
    if (target.reports.length >= 5) {
      target.banned = true;
    } else if (target.reports.length >= 3) {
      target.banUntil = Math.max(target.banUntil || 0, Date.now() + 24 * 3600000);
    }
    dirty = true;
  });

  s.on('disconnect', () => {
    leaveChat(s);
    if (s.token && activeTokens.get(s.token) === s) {
      activeTokens.delete(s.token);
    }
  });
});

setInterval(() => {
  io.emit('online', io.engine.clientsCount);
}, 5000);

srv.listen(PORT, () => {
  console.log(`MindMatch сервер http://localhost:${PORT} дээр ажиллаж байна`);
});
