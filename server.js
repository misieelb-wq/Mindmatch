// MindMatch - Production-ready 1-to-1 anonymous chat server
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const srv = http.createServer(app);
const io = new Server(srv, {
  maxHttpBufferSize: 2048,
  perMessageDeflate: false,
  pingInterval: 25000,
  pingTimeout: 20000
});

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const DB_FILE = path.join(__dirname, 'db.json');
const DB_TMP = path.join(__dirname, 'db.json.tmp');
const REPORTS_LOG = path.join(__dirname, 'reports.log');

if (!ADMIN_KEY) {
  console.warn('[WARN] ADMIN_KEY тохируулаагүй байна. Админ API-ууд идэвхгүй байна.');
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
  if (fs.existsSync(DB_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.users = parsed.users || {};
    db.orders = parsed.orders || {};
  }
} catch (err) {
  console.error('[DB] db.json уншихад алдаа гарлаа:', err.message);
}

let dirty = false;
let saving = false;
function saveDbAtomic() {
  if (!dirty || saving) return;
  saving = true;
  dirty = false;
  const payload = JSON.stringify(db);
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
setInterval(saveDbAtomic, 3000);
process.on('SIGINT', () => {
  if (dirty) fs.writeFileSync(DB_FILE, JSON.stringify(db), 'utf8');
  process.exit(0);
});
process.on('SIGTERM', () => {
  if (dirty) fs.writeFileSync(DB_FILE, JSON.stringify(db), 'utf8');
  process.exit(0);
});

const getUser = token => (typeof token === 'string' ? db.users[token] : null);
const isBanned = u => Boolean(u && (u.banned || (u.banUntil && u.banUntil > Date.now())));
const isPremium = token => {
  const u = getUser(token);
  return Boolean(u && (u.until || 0) > Date.now());
};

function activatePlan(token, planKey) {
  const u = getUser(token);
  const plan = PLANS[planKey];
  if (!u || !plan) return false;
  u.until = Math.max(Date.now(), u.until || 0) + plan.days * 86400000;
  dirty = true;
  return true;
}

function checkAdmin(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ err: 'ADMIN_KEY тохируулаагүй байна' });
  const provided = req.headers['x-admin-key'] || (req.body && req.body.key) || req.query.key || '';
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(ADMIN_KEY));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.sendStatus(403);
  }
  next();
}

// Admin endpoints
app.post('/admin/activate', checkAdmin, (req, res) => {
  const { token, plan } = req.body || {};
  res.json({ ok: activatePlan(token, plan) });
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

app.get('/plans', (_, res) => res.json(PLANS));

// ---- QPay v2 Integration ----
const QP = {
  base: process.env.QPAY_URL || 'https://merchant.qpay.mn/v2',
  user: process.env.QPAY_USER || '',
  pass: process.env.QPAY_PASS || '',
  code: process.env.QPAY_INVOICE_CODE || '',
  cb: PUBLIC_URL
};
let qtok = { v: null, exp: 0 };

async function qpay(endpoint, body) {
  if (!QP.user || !QP.pass || !QP.code) {
    throw new Error('QPay тохиргоо дутуу байна');
  }
  if (!qtok.v || Date.now() > qtok.exp) {
    const authRes = await fetch(QP.base + '/auth/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${QP.user}:${QP.pass}`).toString('base64')
      }
    });
    const authData = await authRes.json();
    if (!authRes.ok || !authData.access_token) {
      throw new Error('QPay нэвтрэлт амжилтгүй боллоо');
    }
    qtok = {
      v: authData.access_token,
      exp: Date.now() + Math.max(60, (authData.expires_in || 1200) - 60) * 1000
    };
  }
  const r = await fetch(QP.base + endpoint, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + qtok.v,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return r.json();
}

const invoiceCooldown = new Map();
app.post('/pay/invoice', async (req, res) => {
  try {
    const { token, plan } = req.body || {};
    const u = getUser(token);
    const p = PLANS[plan];
    if (!u || !p) return res.status(400).json({ err: 'Хүсэлт буруу байна' });
    if (isBanned(u)) return res.status(403).json({ err: 'Таны хандалт хаагдсан байна' });

    const now = Date.now();
    if (now - (invoiceCooldown.get(token) || 0) < 3000) {
      return res.status(429).json({ err: 'Түр хүлээгээд дахин оролдоно уу' });
    }
    invoiceCooldown.set(token, now);

    const sid = crypto.randomUUID().replace(/-/g, '');
    const callbackUrl = QP.cb ? `${QP.cb}/qpay/callback?sid=${sid}` : undefined;
    const inv = await qpay('/invoice', {
      invoice_code: QP.code,
      sender_invoice_no: sid,
      invoice_receiver_code: 'terminal',
      invoice_description: `MindMatch ${p.label}`,
      amount: p.price,
      ...(callbackUrl ? { callback_url: callbackUrl } : {})
    });

    if (!inv || !inv.invoice_id) {
      return res.status(502).json({ err: 'QPay нэхэмжлэх үүсгэхэд алдаа гарлаа' });
    }

    db.orders[sid] = {
      token,
      plan,
      amount: p.price,
      inv: inv.invoice_id,
      done: false,
      createdAt: now
    };
    dirty = true;
    res.json({ sid, qr: inv.qr_image, urls: inv.urls || [] });
  } catch (e) {
    res.status(500).json({ err: e.message || 'Серверийн алдаа' });
  }
});

async function settleOrder(sid) {
  if (typeof sid !== 'string' || !db.orders[sid]) return false;
  const order = db.orders[sid];
  if (order.done) return true;

  const r = await qpay('/payment/check', {
    object_type: 'INVOICE',
    object_id: order.inv,
    offset: { page_number: 1, page_size: 100 }
  });

  const paidRow = (r.rows || []).find(
    x => x.payment_status === 'PAID' && Number(x.payment_amount || order.amount) >= order.amount
  );

  if (paidRow && !order.done) {
    order.done = true;
    order.paidAt = Date.now();
    activatePlan(order.token, order.plan);
    dirty = true;
  }
  return order.done;
}

app.all('/qpay/callback', async (req, res) => {
  try {
    await settleOrder(req.query.sid);
  } catch {}
  res.status(200).send('SUCCESS');
});

app.get('/pay/status', async (req, res) => {
  try {
    const sid = req.query.sid;
    const paid = await settleOrder(sid);
    const order = db.orders[sid];
    const until = paid && order && getUser(order.token) ? getUser(order.token).until : 0;
    res.json({ paid, until });
  } catch {
    res.json({ paid: false, until: 0 });
  }
});

// ---- Matchmaking & Real-time Chat ----
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
      return cb({ err: 'Таны хандалт түр эсвэл бүрмөсөн хаагдсан байна.' });
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

    cb({
      token: userToken,
      premium: isPremium(userToken),
      until: u.until || 0
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
    s.emit('matched');
    partner.emit('matched');
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
