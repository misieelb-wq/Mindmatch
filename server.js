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
const DB_FILE = path.join(__dirname, 'db.json');
const DB_TMP = path.join(__dirname, 'db.json.tmp');
const REPORTS_LOG = path.join(__dirname, 'reports.log');

// Энд өөрийн дансуудын IBAN дугаарыг ард ардаас нь нэмж оруулна
const PAY_ACCOUNTS = [
  { id: 'acc1', bank: 'Данс 1', holder: 'Б. Мишээл', iban: 'MN58000500 5325110588' }
];

const PLANS = {
  d1: { days: 1, price: 1990, label: '1 өдөр' },
  d3: { days: 3, price: 3990, label: '3 өдөр' },
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
      return;
    }
    fs.rename(DB_TMP, DB_FILE, renameErr => {
      saving = false;
      if (renameErr) dirty = true;
    });
  });
}
setInterval(saveDbAtomic, 3000);
process.on('SIGINT', () => {
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
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(403);
  next();
}

app.get('/health', (_, res) => {
  res.json({ ok: true, online: io.engine.clientsCount });
});

app.get('/admin/orders', checkAdmin, (_, res) => {
  const list = Object.entries(db.orders)
    .map(([sid, o]) => ({ sid, ...o }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({ orders: list });
});

app.post('/admin/approve', checkAdmin, (req, res) => {
  const sid = req.body && req.body.sid;
  const order = sid && db.orders[sid];
  if (!order) return res.status(404).json({ err: 'Захиалга олдсонгүй' });
  if (!order.done) {
    order.done = true;
    order.status = 'paid';
    order.paidAt = Date.now();
    activatePlan(order.token, order.plan);
    saveDbAtomic();
  }
  const u = getUser(order.token);
  res.json({ ok: true, until: u ? u.until : 0 });
});

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

app.post('/pay/request', (req, res) => {
  const { token, plan, accountId } = req.body || {};
  const u = getUser(token);
  const p = PLANS[plan];
  if (!u || !p) return res.status(400).json({ err: 'Хүсэлт буруу байна' });
  if (isBanned(u)) return res.status(403).json({ err: 'Таны хандалт хаагдсан байна' });

  const acc = PAY_ACCOUNTS.find(a => a.id === accountId) || PAY_ACCOUNTS[0];
  const sid = 'MM' + crypto.randomInt(100000, 999999);

  db.orders[sid] = {
    token,
    plan,
    label: p.label,
    amount: p.price,
    accountId: acc.id,
    iban: acc.iban,
    status: 'pending',
    done: false,
    createdAt: Date.now()
  };
  dirty = true;

  res.json({
    sid,
    amount: p.price,
    label: p.label,
    accounts: PAY_ACCOUNTS,
    selectedAccount: acc
  });
});

app.post('/pay/submitted', (req, res) => {
  const { sid } = req.body || {};
  const order = typeof sid === 'string' && db.orders[sid];
  if (!order) return res.status(404).json({ err: 'Захиалга олдсонгүй' });
  if (!order.done && order.status === 'pending') {
    order.status = 'submitted';
    order.submittedAt = Date.now();
    dirty = true;
  }
  res.json({ ok: true, status: order.status });
});

app.get('/pay/status', (req, res) => {
  const sid = req.query.sid;
  const order = typeof sid === 'string' && db.orders[sid];
  if (!order) return res.json({ paid: false, status: 'none', until: 0 });
  const u = getUser(order.token);
  res.json({
    paid: Boolean(order.done),
    status: order.done ? 'paid' : order.status,
    until: order.done && u ? u.until : 0
  });
});

const waiting = [];
const isCompatible = (a, b) =>
  a.id !== b.id && (!a.want || a.want === b.gender);

function emitOnlineCount() {
  io.emit('online', io.engine.clientsCount);
}

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
  s.emit('online', io.engine.clientsCount);
  emitOnlineCount();

  s.on('hello', ({ token, gender, adult } = {}, cb) => {
    if (typeof cb !== 'function') return;
    if (adult !== true) return cb({ err: 'Зөвхөн 18+ насны хүмүүс нэвтэрнэ.' });
    if (!['m', 'f'].includes(gender)) return cb({ err: 'Эрэгтэй эсвэл Эмэгтэйг сонгоно уу.' });

    let userToken = typeof token === 'string' && getUser(token) ? token : null;
    if (!userToken) {
      userToken = crypto.randomUUID();
      db.users[userToken] = { createdAt: Date.now(), blocked: [], reports: [] };
      dirty = true;
    }

    const u = getUser(userToken);
    if (isBanned(u)) return cb({ err: 'Таны хандалт түр эсвэл бүрмөсөн хаагдсан байна.' });

    s.token = userToken;
    s.gender = gender;
    u.gender = s.gender;
    dirty = true;

    cb({ token: userToken, premium: isPremium(userToken), until: u.until || 0 });
  });

  s.on('find', want => {
    if (!s.token) return;
    const u = getUser(s.token);
    if (!u || isBanned(u)) return s.emit('err_msg', 'Таны хандалт хаагдсан байна.');

    leaveChat(s);
    const prem = isPremium(s.token);
    if (['m', 'f'].includes(want) && !prem) return s.emit('need_premium');

    s.want = ['m', 'f'].includes(want) && prem ? want : null;
    const idx = waiting.findIndex(other => other.token && isCompatible(s, other) && isCompatible(other, s));
    if (idx < 0) {
      waiting.push(s);
      return s.emit('waiting');
    }

    const partner = waiting.splice(idx, 1)[0];
    s.peer = partner;
    partner.peer = s;
    const roomId = crypto.randomBytes(4).toString('hex');
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

  s.on('report', reason => {
    if (!s.peer || !s.token) return;
    const targetToken = s.peer.token;
    const target = getUser(targetToken);
    if (!target) return;
    const cleanReason = String(reason || 'Шалтгаан бичээгүй').trim().slice(0, 200);
    fs.appendFile(
      REPORTS_LOG,
      JSON.stringify({ t: new Date().toISOString(), from: s.token, against: targetToken, reason: cleanReason }) + '\n',
      () => {}
    );
    target.reports = [...new Set([...(target.reports || []), s.token])];
    if (target.reports.length >= 5) target.banned = true;
    else if (target.reports.length >= 3) target.banUntil = Math.max(target.banUntil || 0, Date.now() + 24 * 3600000);
    dirty = true;
  });

  s.on('disconnect', () => {
    leaveChat(s);
    emitOnlineCount();
  });
});

srv.listen(PORT, () => {
  console.log(`MindMatch сервер http://localhost:${PORT} дээр ажиллаж байна`);
});
