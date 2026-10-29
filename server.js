// Idea board for the Tech for Palestine x Thaura hackathon.
// Zero-dependency Node server: serves index.html and a small JSON-backed notes API.
//
//   GET    /api/notes          -> { notes: [...] }
//   POST   /api/notes          { x, w, c } -> { note }   (max 30 pins/hour per IP)
//   DELETE /api/notes/<id>     -> { ok: true }
//
// Notes live in DATA_DIR/notes.json (DATA_DIR is /data on build.happyoperators.com,
// a folder that survives redeploys). On first start it copies seed-notes.json in.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'notes.json');
const SEED_FILE = path.join(ROOT, 'seed-notes.json');
const MAX_NOTES = 300;

// ---------- storage ----------
let notes = [];
function loadNotes() {
  try {
    if (!fs.existsSync(DATA_FILE) && fs.existsSync(SEED_FILE)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.copyFileSync(SEED_FILE, DATA_FILE);
    }
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    notes = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    notes = [];
  }
}
let saveTimer = null;
function saveNotes() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdir(DATA_DIR, { recursive: true }, () => {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFile(tmp, JSON.stringify(notes), (err) => {
        if (err) return console.error('save failed:', err.message);
        fs.rename(tmp, DATA_FILE, () => {});
      });
    });
  }, 200);
}
loadNotes();

// ---------- helpers ----------
function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 10000) { reject(new Error('too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clean(s, max) {
  return String(s || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, max);
}

// rate limit: max 30 pins per IP per hour
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 30;
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  let p;
  try { p = new URL(req.url, 'http://localhost').pathname; }
  catch (e) { return send(res, 400, 'Bad request', 'text/plain'); }

  if (p === '/api/notes' && req.method === 'GET') {
    return send(res, 200, JSON.stringify({ notes: notes }));
  }

  if (p === '/api/notes' && req.method === 'POST') {
    const ip = ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
    if (limited(ip)) return send(res, 429, JSON.stringify({ error: 'Too many pins from one address. Try again later.' }));
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    const x = clean(body.x, 280);
    if (!x) return send(res, 400, JSON.stringify({ error: 'Empty idea' }));
    const note = {
      id: 'n' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
      x: x,
      w: clean(body.w, 60),
      c: ['1', '2', '3', '4'].includes(String(body.c)) ? String(body.c) : '1',
      t: Date.now()
    };
    notes.unshift(note);
    if (notes.length > MAX_NOTES) notes.length = MAX_NOTES;
    saveNotes();
    return send(res, 200, JSON.stringify({ note: note }));
  }

  const del = p.match(/^\/api\/notes\/([a-z0-9]+)$/);
  if (del && req.method === 'DELETE') {
    const i = notes.findIndex((n) => n.id === del[1]);
    if (i === -1) return send(res, 404, JSON.stringify({ error: 'No such note' }));
    notes.splice(i, 1);
    saveNotes();
    return send(res, 200, JSON.stringify({ ok: true }));
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
  if (p !== '/' && p !== '/index.html') return send(res, 404, 'Not found', 'text/plain');
  fs.readFile(path.join(ROOT, 'index.html'), (err, data) => {
    if (err) return send(res, 500, 'Missing index.html', 'text/plain');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log('idea board listening on port ' + PORT));
