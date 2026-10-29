// Idea board for the Tech for Palestine x Thaura hackathon.
// Zero-dependency Node server: serves index.html and a small JSON-backed notes API.
//
// Every browser sends its client id (20 chars a-z0-9) as the X-Board-Client header,
// and as ?voter=<id> on the two GET endpoints. Voter ids are never sent back out.
//
//   GET    /api/notes?voter=ID          -> snapshot { notes, removed, cap }
//   GET    /api/stream?voter=ID         -> Server-Sent Events, a fresh snapshot after every change
//   POST   /api/notes                   { x, w, c, hp } -> { note }   (15/hour per client, 200/hour per IP)
//   PATCH  /api/notes/<id>              { x } -> { note }             (edit, keeps the original in `o`)
//   POST   /api/notes/<id>/revert       -> { note }                   (back to the original text)
//   DELETE /api/notes/<id>              -> { ok: true }               (soft remove)
//   POST   /api/notes/<id>/restore      -> { note }
//   POST   /api/notes/<id>/vote         { voter, on } -> { votes, mine }
//   GET    /api/admin/check             -> { ok: true }               (all admin calls need X-Admin-Key)
//   POST   /api/admin/remove            { ids: [...] } -> { ok: true, removed: n }
//   DELETE /api/admin/notes/<id>        -> { ok: true }               (permanent delete)
//
// Notes live in DATA_DIR/notes.json (DATA_DIR is /data on build.happyoperators.com,
// a folder that survives redeploys). On first start it copies seed-notes.json in.
// Admin key: ADMIN_KEY env var, else DATA_DIR/admin-key.txt (generated on first start).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'notes.json');
const SEED_FILE = path.join(ROOT, 'seed-notes.json');
const KEY_FILE = path.join(DATA_DIR, 'admin-key.txt');

const LIVE_CAP = 100;
const MAX_REMOVED = 300;
const MAX_BODY = 10000;
const HOUR = 60 * 60 * 1000;
const MAX_STREAMS = 400;

const ID_RE = /^[a-z0-9]+$/;
const VOTER_RE = /^[a-z0-9]{8,40}$/;
const COLOURS = ['1', '2', '3', '4'];

const MSG_FULL = 'The board is full (100 ideas). Ask the organisers to clear some space.';

// ---------- storage ----------
// Internal note: { id, x, w, c, t, v: [voter ids], o?, e?, r? }
let notes = [];

function normalise(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  if (!ID_RE.test(id)) return null;
  const x = clean(raw.x, 280);
  if (!x) return null;
  const n = {
    id: id,
    x: x,
    w: clean(raw.w, 60),
    c: COLOURS.includes(String(raw.c)) ? String(raw.c) : '1',
    t: Number.isFinite(raw.t) ? raw.t : Date.now(),
    v: Array.isArray(raw.v) ? Array.from(new Set(raw.v.filter((s) => typeof s === 'string' && VOTER_RE.test(s)))) : []
  };
  if (typeof raw.o === 'string' && clean(raw.o, 280)) n.o = clean(raw.o, 280); // an empty original would revert to a blank note
  if (Number.isFinite(raw.e) && n.o !== undefined && n.x !== n.o) n.e = raw.e;
  if (Number.isFinite(raw.r)) n.r = raw.r;
  return n;
}

function loadNotes() {
  try {
    if (!fs.existsSync(DATA_FILE) && fs.existsSync(SEED_FILE)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.copyFileSync(SEED_FILE, DATA_FILE);
    }
    if (!fs.existsSync(DATA_FILE)) { notes = []; return; }
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const seen = new Set();
    notes = [];
    (Array.isArray(parsed) ? parsed : []).forEach((raw) => {
      const n = normalise(raw);
      if (n && !seen.has(n.id)) { seen.add(n.id); notes.push(n); }
    });
  } catch (e) {
    // Never silently overwrite a file we could not read: keep a copy first.
    const backup = DATA_FILE + '.corrupt-' + Date.now();
    try { fs.renameSync(DATA_FILE, backup); } catch (e2) { /* nothing to keep */ }
    console.error('COULD NOT READ ' + DATA_FILE + ' (' + e.message + '). Kept it as ' + backup + ' and started empty.');
    notes = [];
  }
}

let saveTimer = null;
let saving = false;
let savePending = false;
// Save at most 200ms after the first unsaved change. Not a sliding debounce: under a
// steady stream of votes a sliding timer would never fire and nothing would reach disk.
function saveNotes() {
  if (!saveTimer) saveTimer = setTimeout(writeNotes, 200);
}
function writeNotes() {
  saveTimer = null;
  if (saving) { savePending = true; return; }
  saving = true;
  const done = () => {
    saving = false;
    if (savePending) { savePending = false; writeNotes(); }
  };
  fs.mkdir(DATA_DIR, { recursive: true }, () => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(notes), (err) => {
      if (err) { console.error('save failed:', err.message); return done(); }
      fs.rename(tmp, DATA_FILE, (err2) => {
        if (err2) console.error('save rename failed:', err2.message);
        done();
      });
    });
  });
}
function saveNotesSync() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp-exit';
    fs.writeFileSync(tmp, JSON.stringify(notes));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('final save failed:', e.message);
  }
}

loadNotes();
purgeRemoved();

// ---------- admin key ----------
function randomId(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}

function loadAdminKey() {
  const env = String(process.env.ADMIN_KEY || '').trim();
  if (env) return env;
  try {
    const saved = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch (e) { /* no key yet */ }
  const key = randomId(24);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, key + '\n', { mode: 0o600 });
  } catch (e) {
    console.error('could not save admin key (it will change on restart):', e.message);
  }
  console.log('admin link: /?admin=' + key);
  return key;
}
const ADMIN_KEY = loadAdminKey();

function isAdmin(req) {
  const given = Buffer.from(String(req.headers['x-admin-key'] || ''), 'utf8');
  const want = Buffer.from(ADMIN_KEY, 'utf8');
  if (given.length !== want.length) return false;
  return crypto.timingSafeEqual(given, want);
}

// ---------- notes helpers ----------
function findNote(id) {
  return notes.find((n) => n.id === id);
}
function liveCount() {
  let k = 0;
  for (const n of notes) if (!n.r) k++;
  return k;
}
function newNoteId() {
  let id;
  do { id = 'n' + Date.now().toString(36) + randomId(6); } while (findNote(id));
  return id;
}
// Keep at most MAX_REMOVED removed notes: drop the ones removed longest ago.
function purgeRemoved() {
  const removed = notes.filter((n) => n.r);
  if (removed.length <= MAX_REMOVED) return;
  removed.sort((a, b) => a.r - b.r);
  const drop = new Set(removed.slice(0, removed.length - MAX_REMOVED).map((n) => n.id));
  notes = notes.filter((n) => !drop.has(n.id));
}

// Public shape. `mine` only when we have a valid voter id. Voter ids never leave.
function pub(n, voter) {
  const out = { id: n.id, x: n.x, w: n.w, c: n.c, t: n.t, votes: n.v.length };
  if (n.o !== undefined) out.o = n.o;
  if (n.e !== undefined) out.e = n.e;
  if (n.r !== undefined) out.r = n.r;
  if (voter) out.mine = n.v.includes(voter);
  return out;
}

function snapshot(voter) {
  const live = notes.filter((n) => !n.r).sort((a, b) => b.t - a.t);
  const removed = notes.filter((n) => n.r).sort((a, b) => b.r - a.r);
  return {
    notes: live.map((n) => pub(n, voter)),
    removed: removed.map((n) => pub(n, voter)),
    cap: LIVE_CAP
  };
}

// ---------- helpers ----------
function send(res, code, body, type, extra) {
  const headers = {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
  if (extra) Object.assign(headers, extra);
  res.writeHead(code, headers);
  res.end(body);
}
function json(res, code, obj, extra) {
  send(res, code, JSON.stringify(obj), null, extra);
}
function fail(res, code, msg) {
  json(res, code, { error: msg });
}

class BodyError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_BODY) return reject(new BodyError(413, 'That request is too large.'));
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) { over = true; chunks.length = 0; reject(new BodyError(413, 'That request is too large.')); }
      else chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  let body;
  try { body = JSON.parse(text); }
  catch (e) { throw new BodyError(400, 'That request could not be read.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BodyError(400, 'That request could not be read.');
  return body;
}

function clean(s, max) {
  return String(s || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, max);
}

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '');
  const last = xff ? xff.split(',').pop().trim() : '';
  return last || req.socket.remoteAddress || '';
}
function clientId(req) {
  const id = String(req.headers['x-board-client'] || '');
  return VOTER_RE.test(id) ? id : '';
}
function queryVoter(u, req) {
  const q = String(u.searchParams.get('voter') || '');
  if (VOTER_RE.test(q)) return q;
  return clientId(req);
}

// ---------- rate limits ----------
// Each map: key -> array of hit times in the last hour. Only successful actions are recorded,
// so an array never grows past its limit. Old keys are pruned every 10 minutes.
const limits = {
  pinClient: { map: new Map(), max: 15 },
  pinIp: { map: new Map(), max: 200 },
  change: { map: new Map(), max: 60 },
  vote: { map: new Map(), max: 300 }
};
function recent(bucket, key) {
  const now = Date.now();
  const arr = (bucket.map.get(key) || []).filter((t) => now - t < HOUR);
  if (arr.length) bucket.map.set(key, arr); else bucket.map.delete(key);
  return arr;
}
function allowed(bucket, key) {
  return recent(bucket, key).length < bucket.max;
}
function record(bucket, key) {
  const arr = recent(bucket, key);
  arr.push(Date.now());
  bucket.map.set(key, arr);
  if (bucket.map.size > 20000) pruneBucket(bucket);
  if (bucket.map.size > 20000) bucket.map.clear();
}
function pruneBucket(bucket) {
  const now = Date.now();
  for (const [key, arr] of bucket.map) {
    const keep = arr.filter((t) => now - t < HOUR);
    if (keep.length) bucket.map.set(key, keep); else bucket.map.delete(key);
  }
}
setInterval(() => { Object.values(limits).forEach(pruneBucket); }, 10 * 60 * 1000).unref();

// ---------- live updates (SSE) ----------
const streams = new Set(); // { res, voter }

// A browser that stops reading (phone asleep, bad wifi) must not make us buffer every
// snapshot for it, or memory runs out. While an earlier write is still draining, keep only
// the newest snapshot and send it on 'drain'. A connection stuck for a minute is dropped
// by the ping timer; EventSource reconnects and gets a fresh snapshot.
function sseWrite(s, chunk) {
  try {
    if (s.res.destroyed || s.res.writableEnded) { streams.delete(s); return; }
    if (s.res.writableNeedDrain) {
      if (chunk.startsWith('data: ')) s.pending = chunk;
      if (!s.stuck) s.stuck = Date.now();
      return;
    }
    s.res.write(chunk);
  } catch (e) {
    streams.delete(s);
  }
}

let broadcastTimer = null;
function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    if (!streams.size) return;
    // Build the shared parts once, then only vary `mine` per connection. Each note is
    // stringified once (minus its closing brace) and `mine` is appended per voter, so a
    // change costs one JSON.stringify of the board, not one per connected browser.
    const live = notes.filter((n) => !n.r).sort((a, b) => b.t - a.t);
    const removed = notes.filter((n) => n.r).sort((a, b) => b.r - a.r);
    const liveJson = live.map((n) => JSON.stringify(pub(n)));
    const removedJson = removed.map((n) => JSON.stringify(pub(n)));
    const tail = '],"cap":' + LIVE_CAP + '}\n\n';
    const anon = 'data: {"notes":[' + liveJson.join(',') + '],"removed":[' + removedJson.join(',') + tail;
    const withMine = (list, parts, v) => parts.map((j, i) => j.slice(0, -1) + ',"mine":' + list[i].v.includes(v) + '}').join(',');
    const cache = new Map();
    for (const s of streams) {
      if (!s.voter) { sseWrite(s, anon); continue; }
      let msg = cache.get(s.voter);
      if (!msg) {
        const v = s.voter;
        msg = 'data: {"notes":[' + withMine(live, liveJson, v) + '],"removed":[' + withMine(removed, removedJson, v) + tail;
        cache.set(v, msg);
      }
      sseWrite(s, msg);
    }
  }, 50);
}

setInterval(() => {
  const now = Date.now();
  for (const s of streams) {
    if (s.stuck && now - s.stuck > 60000) { streams.delete(s); s.res.destroy(); continue; }
    sseWrite(s, ': ping\n\n');
  }
}, 20000);

function openStream(req, res, voter) {
  if (streams.size >= MAX_STREAMS) return fail(res, 503, 'Too many people are connected right now. Try again in a minute.');
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const s = { res: res, voter: voter, pending: null, stuck: 0 };
  streams.add(s);
  const drop = () => { streams.delete(s); };
  res.on('close', drop);
  res.on('error', drop);
  res.on('drain', () => {
    s.stuck = 0;
    if (s.pending) { const chunk = s.pending; s.pending = null; sseWrite(s, chunk); }
  });
  sseWrite(s, 'retry: 3000\n\n');
  sseWrite(s, 'data: ' + JSON.stringify(snapshot(voter)) + '\n\n');
}

// Call after every successful change.
function changed() {
  saveNotes();
  broadcast();
}

// ---------- API ----------
async function handleApi(req, res, u, p) {
  const m = req.method;

  if (p === '/api/notes' && m === 'GET') return json(res, 200, snapshot(queryVoter(u, req)));
  if (p === '/api/stream' && m === 'GET') return openStream(req, res, queryVoter(u, req));

  // ----- admin -----
  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return fail(res, 401, 'Admin key needed.');
    if (p === '/api/admin/check' && m === 'GET') return json(res, 200, { ok: true });
    if (p === '/api/admin/remove' && m === 'POST') {
      const body = await readJson(req);
      if (!Array.isArray(body.ids)) return fail(res, 400, 'Send a list of idea ids.');
      const ids = new Set(body.ids.slice(0, 1000).map(String).filter((s) => ID_RE.test(s)));
      const now = Date.now();
      let removed = 0;
      for (const n of notes) {
        if (ids.has(n.id) && !n.r) { n.r = now; removed++; }
      }
      if (removed) { purgeRemoved(); changed(); }
      return json(res, 200, { ok: true, removed: removed });
    }
    const adm = p.match(/^\/api\/admin\/notes\/([a-z0-9]+)$/);
    if (adm && m === 'DELETE') {
      const i = notes.findIndex((n) => n.id === adm[1]);
      if (i === -1) return fail(res, 404, 'That idea no longer exists.');
      notes.splice(i, 1);
      changed();
      return json(res, 200, { ok: true });
    }
    return fail(res, 404, 'Not found.');
  }

  // ----- pin a new idea -----
  if (p === '/api/notes' && m === 'POST') {
    const body = await readJson(req);
    // Honeypot first: a bot gets a convincing fake and nothing else happens.
    if (clean(body.hp, 200)) {
      const fake = { id: newNoteId(), x: clean(body.x, 280), w: clean(body.w, 60), c: COLOURS.includes(String(body.c)) ? String(body.c) : '1', t: Date.now(), votes: 0, mine: false };
      return json(res, 200, { note: fake });
    }
    const client = clientId(req);
    if (!client) return fail(res, 400, 'Your browser id is missing. Reload the page and try again.');
    const ip = clientIp(req);
    if (!allowed(limits.pinClient, client) || !allowed(limits.pinIp, ip)) {
      return fail(res, 429, 'Too many ideas from you in the last hour. Try again later.');
    }
    const x = clean(body.x, 280);
    if (!x) return fail(res, 400, 'Write an idea first.');
    if (liveCount() >= LIVE_CAP) return fail(res, 409, MSG_FULL);
    const note = {
      id: newNoteId(),
      x: x,
      w: clean(body.w, 60),
      c: COLOURS.includes(String(body.c)) ? String(body.c) : '1',
      t: Date.now(),
      v: []
    };
    notes.unshift(note);
    record(limits.pinClient, client);
    record(limits.pinIp, ip);
    changed();
    return json(res, 200, { note: pub(note, client) });
  }

  // ----- actions on one idea -----
  const one = p.match(/^\/api\/notes\/([a-z0-9]+)(?:\/(revert|restore|vote))?$/);
  if (!one) return fail(res, 404, 'Not found.');
  const id = one[1];
  const action = one[2] || '';
  const known = (action === '' && (m === 'PATCH' || m === 'DELETE')) || (action && m === 'POST');
  if (!known) return fail(res, 405, 'That action is not allowed here.');

  const client = clientId(req);
  if (!client) return fail(res, 400, 'Your browser id is missing. Reload the page and try again.');

  if (action === 'vote') {
    if (!allowed(limits.vote, client)) return fail(res, 429, 'Too many votes from you in the last hour. Try again later.');
    const body = await readJson(req);
    const voter = String(body.voter || '');
    // The browser id is the voter id: one browser can't vote under many names.
    if (voter !== client) return fail(res, 400, 'Your browser id is missing. Reload the page and try again.');
    if (typeof body.on !== 'boolean') return fail(res, 400, 'That request could not be read.');
    const n = findNote(id);
    if (!n) return fail(res, 404, 'That idea no longer exists.');
    if (n.r) return fail(res, 409, 'Restore this idea before voting on it.');
    const has = n.v.includes(voter);
    record(limits.vote, client);
    if (body.on && !has) { n.v.push(voter); changed(); }
    else if (!body.on && has) { n.v = n.v.filter((s) => s !== voter); changed(); }
    return json(res, 200, { votes: n.v.length, mine: body.on });
  }

  // Edits, reverts, removes and restores share one limit.
  if (!allowed(limits.change, client)) return fail(res, 429, 'Too many changes from you in the last hour. Try again later.');

  if (action === '' && m === 'PATCH') {
    const body = await readJson(req);
    const n = findNote(id);
    if (!n) return fail(res, 404, 'That idea no longer exists.');
    if (n.r) return fail(res, 409, 'Restore this idea before editing it.');
    const x = clean(body.x, 280);
    if (!x) return fail(res, 400, 'Write an idea first.');
    if (x === n.x) return json(res, 200, { note: pub(n, client) });
    if (n.o === undefined) n.o = n.x;
    n.x = x;
    if (n.x === n.o) delete n.e; else n.e = Date.now();
    record(limits.change, client);
    changed();
    return json(res, 200, { note: pub(n, client) });
  }

  if (action === 'revert') {
    const n = findNote(id);
    if (!n) return fail(res, 404, 'That idea no longer exists.');
    if (n.o === undefined) return fail(res, 400, 'This idea has not been edited.');
    if (n.x !== n.o || n.e !== undefined) {
      n.x = n.o;
      delete n.e;
      record(limits.change, client);
      changed();
    }
    return json(res, 200, { note: pub(n, client) });
  }

  if (action === '' && m === 'DELETE') {
    const n = findNote(id);
    if (!n) return fail(res, 404, 'That idea no longer exists.');
    if (!n.r) {
      n.r = Date.now();
      purgeRemoved();
      record(limits.change, client);
      changed();
    }
    return json(res, 200, { ok: true });
  }

  if (action === 'restore') {
    const n = findNote(id);
    if (!n) return fail(res, 404, 'That idea no longer exists.');
    if (!n.r) return json(res, 200, { note: pub(n, client) });
    if (liveCount() >= LIVE_CAP) return fail(res, 409, MSG_FULL);
    delete n.r;
    record(limits.change, client);
    changed();
    return json(res, 200, { note: pub(n, client) });
  }

  return fail(res, 404, 'Not found.');
}

// ---------- server ----------
async function handle(req, res) {
  let u;
  try { u = new URL(req.url, 'http://localhost'); }
  catch (e) { return send(res, 400, 'Bad request', 'text/plain'); }
  const p = u.pathname;

  if (p === '/api' || p.startsWith('/api/')) {
    try {
      return await handleApi(req, res, u, p);
    } catch (e) {
      if (e instanceof BodyError) {
        // Close the connection after a too-large body so we stop reading it.
        return json(res, e.code, { error: e.message }, e.code === 413 ? { Connection: 'close' } : null);
      }
      throw e;
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
  const asset = p.match(/^\/assets\/([a-z0-9._-]+\.(webp|svg|png|jpg))$/i);
  if (asset) {
    const types = { webp: 'image/webp', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg' };
    return fs.readFile(path.join(ROOT, 'assets', asset[1]), (err, data) => {
      if (err) return send(res, 404, 'Not found', 'text/plain');
      res.writeHead(200, { 'Content-Type': types[asset[2].toLowerCase()], 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    });
  }
  if (p !== '/' && p !== '/index.html') return send(res, 404, 'Not found', 'text/plain');
  fs.readFile(path.join(ROOT, 'index.html'), (err, data) => {
    if (err) return send(res, 500, 'Missing index.html', 'text/plain');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('request failed:', req.method, req.url, e && e.stack ? e.stack : e);
    try {
      if (!res.headersSent) fail(res, 500, 'Something went wrong on the server. Try again.');
      else res.destroy();
    } catch (e2) { /* socket already gone */ }
  });
});

server.on('clientError', (err, socket) => {
  try {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  } catch (e) { /* ignore */ }
});

process.on('uncaughtException', (e) => console.error('uncaught error (still running):', e && e.stack ? e.stack : e));
process.on('unhandledRejection', (e) => console.error('unhandled rejection (still running):', e && e.stack ? e.stack : e));

// Docker sends SIGTERM on redeploy: write the latest notes before exiting.
function shutdown(sig) {
  console.log(sig + ' received, saving notes and stopping');
  clearTimeout(saveTimer);
  saveNotesSync();
  for (const s of streams) { try { s.res.end(); } catch (e) { /* ignore */ } }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, () => console.log('idea board listening on port ' + PORT));
