'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const ADMIN = process.env.ADMIN_PASSWORD || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'game.json');
const INDEX = path.join(__dirname, 'public', 'index.html');

// ---- storage: Postgres when DATABASE_URL is set, otherwise a local JSON file (dev) ----
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  pool = new Pool({ connectionString: url, ssl: /\.render\.com/.test(url) ? { rejectUnauthorized: false } : false });
}
let chain = Promise.resolve();
// fn(state) -> [newState | undefined (unchanged), result]; runs under a lock so draws never collide
async function withState(fn) {
  if (pool) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("INSERT INTO kv(key,value) VALUES('game','null') ON CONFLICT DO NOTHING");
      const r = await c.query("SELECT value FROM kv WHERE key='game' FOR UPDATE");
      const [ns, res] = fn(r.rows[0].value);
      if (ns !== undefined) await c.query("UPDATE kv SET value=$1 WHERE key='game'", [JSON.stringify(ns)]);
      await c.query('COMMIT');
      return res;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  }
  const run = chain.then(() => {
    let s = null;
    try { s = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
    const [ns, res] = fn(s);
    if (ns !== undefined) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(ns)); }
    return res;
  });
  chain = run.catch(() => {});
  return run;
}

// ---- helpers ----
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const hashPin = (pin, name) => crypto.scryptSync(String(pin), name + '|santa-salt', 32).toString('hex');
const fails = new Map();

function checkAdmin(pw) {
  if (!ADMIN) throw new HttpError(503, 'ADMIN_PASSWORD is not set on the server.');
  if (typeof pw !== 'string' || !same(pw, ADMIN)) throw new HttpError(403, 'Wrong organizer password.');
}
// returns true if this call set the PIN for the first time (caller must then save state)
function auth(s, name, pin) {
  if (!s) throw new HttpError(404, 'There is no game yet.');
  if (!s.names.includes(name)) throw new HttpError(400, 'Unknown name.');
  if (!/^\d{4,8}$/.test(String(pin || ''))) throw new HttpError(400, 'PIN must be 4 to 8 digits.');
  const f = fails.get(name) || { n: 0, until: 0 };
  if (Date.now() < f.until) throw new HttpError(429, 'Too many wrong PINs. Try again in a minute.');
  s.pins = s.pins || {};
  const h = hashPin(pin, name);
  if (!s.pins[name]) { s.pins[name] = h; return true; }
  if (!same(h, s.pins[name])) {
    f.n++; if (f.n >= 5) { f.n = 0; f.until = Date.now() + 60000; }
    fails.set(name, f);
    throw new HttpError(403, 'Wrong PIN.');
  }
  fails.delete(name);
  return false;
}
const pickOf = (s, n) => { const p = s.picks.find((x) => x.from === n); return p ? p.to : null; };
function deadlock(from, to, s) {
  const froms = s.picks.map((p) => p.from).concat(from), tos = s.picks.map((p) => p.to).concat(to);
  const rf = s.names.filter((n) => !froms.includes(n)), rt = s.names.filter((n) => !tos.includes(n));
  return rf.length === 1 && rt.length === 1 && rf[0] === rt[0];
}

// ---- API ----
const routes = {
  'GET /api/status': () => withState((s) => [undefined, s ? {
    names: s.names,
    drawn: Object.fromEntries(s.names.map((n) => [n, !!pickOf(s, n)])),
    claimed: Object.fromEntries(s.names.map((n) => [n, !!(s.pins && s.pins[n])]))
  } : { names: null }]),

  'POST /api/enter': (b) => withState((s) => {
    const first = auth(s, b.name, b.pin);
    return [first ? s : undefined, { first, target: pickOf(s, b.name) }];
  }),

  'POST /api/draw': (b) => withState((s) => {
    const first = auth(s, b.name, b.pin);
    const have = pickOf(s, b.name);
    if (have) return [first ? s : undefined, { target: have }];
    const ok = s.names.filter((n) => n !== b.name && !s.picks.some((p) => p.to === n) && !deadlock(b.name, n, s));
    if (!ok.length) throw new HttpError(409, 'No names available to draw.');
    const target = ok[crypto.randomInt(ok.length)];
    s.picks.push({ from: b.name, to: target });
    return [s, { target }];
  }),

  'POST /api/admin/setup': (b) => {
    checkAdmin(b.password);
    const seen = new Set(), names = [];
    String(Array.isArray(b.names) ? b.names.join('\n') : b.names || '').split('\n').forEach((l) => {
      const n = l.trim().slice(0, 40);
      if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); names.push(n); }
    });
    if (names.length < 3) throw new HttpError(400, 'Add at least 3 different names.');
    if (names.length > 100) throw new HttpError(400, 'Max 100 names.');
    return withState((s) => {
      if (s) throw new HttpError(409, 'A game already exists. Reset it first.');
      return [{ names, picks: [], pins: {} }, { ok: true }];
    });
  },

  'POST /api/admin/reset': (b) => { checkAdmin(b.password); return withState(() => [null, { ok: true }]); }
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 100000) { reject(new HttpError(413, 'Too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(new HttpError(400, 'Bad JSON')); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const send = (code, body, type) => {
    res.writeHead(code, { 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  try {
    if (req.method === 'GET' && url === '/healthz') return send(200, 'ok', 'text/plain');
    if (req.method === 'GET' && (url === '/' || url === '/index.html'))
      return send(200, fs.readFileSync(INDEX), 'text/html; charset=utf-8');
    const h = routes[req.method + ' ' + url];
    if (!h) return send(404, { error: 'Not found' });
    const body = req.method === 'POST' ? await readBody(req) : {};
    send(200, await h(body));
  } catch (e) {
    if (e instanceof HttpError) return send(e.code, { error: e.message });
    console.error(e); send(500, { error: 'Server error' });
  }
});

(async () => {
  if (pool) await pool.query('CREATE TABLE IF NOT EXISTS kv(key text PRIMARY KEY, value jsonb)');
  server.listen(PORT, () => console.log('Secret Santa listening on ' + PORT + (pool ? ' (Postgres)' : ' (file storage)')));
})().catch((e) => { console.error(e); process.exit(1); });
