"use strict";
/**
 * My Little Diary - backend (tanpa dependensi, Node.js >= 18)
 *
 * Prinsip keamanan:
 *  - Identitas pengguna HANYA berasal dari sesi di server (cookie HttpOnly), tidak pernah dari body/URL/parameter.
 *  - Setiap baris data punya user_id pemilik. Semua baca/ubah/hapus lewat fungsi repository yang
 *    WAJIB menerima user_id sesi dan memfilter dengan user_id tersebut.
 *  - Data milik orang lain selalu menghasilkan 404 (bukan 403) supaya keberadaannya tidak bocor.
 *  - Password & PIN di-hash dengan scrypt + salt acak. Token sesi disimpan dalam bentuk hash SHA-256.
 *  - Proteksi CSRF (SameSite=Strict + header khusus + cek Origin/Sec-Fetch-Site), rate limit login/PIN,
 *    validasi input ketat (whitelist field), batas ukuran body, header keamanan + CSP.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/* ---------------------------- Konfigurasi ---------------------------- */
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const SECURE = process.env.SECURE_COOKIES === "1";   // set 1 jika diakses lewat HTTPS
const TRUST_PROXY = process.env.TRUST_PROXY === "1"; // set 1 jika di belakang reverse proxy tepercaya
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const COOKIE = SECURE ? "__Host-mld_sid" : "mld_sid";
const MOODS = ["Happy", "Calm", "Tired", "Sad", "Anxious"];
const MAX_ENTRIES = 20000, MAX_MEMORIES = 20000;
const REGISTER_LIMIT = parseInt(process.env.REGISTER_LIMIT_PER_HOUR || "10", 10); // pendaftaran per IP per jam

const ALLOWED_HOSTS = process.env.ALLOWED_HOSTS
  ? process.env.ALLOWED_HOSTS.split(",").map(s => s.trim().toLowerCase())
  : (HOST === "0.0.0.0" || HOST === "::") ? null
  : [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`];

/* ------------------------------ Database ----------------------------- */
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
let db = { users: {}, entries: {}, memories: {}, settings: {}, sessions: {} };
if (fs.existsSync(DB_FILE)) {
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, "utf8"))); }
  catch (e) { console.error("db.json rusak. Perbaiki/pindahkan file ini dulu agar data tidak tertimpa."); process.exit(1); }
}
let saveTimer = null;
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
}
function save() { if (!saveTimer) saveTimer = setTimeout(flush, 30); }
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { flush(); } catch {} process.exit(0); });

const uuid = () => crypto.randomUUID();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const nowISO = () => new Date().toISOString();

/* Repository: SEMUA akses data lewat sini dan SELALU membutuhkan uid (user_id dari sesi). */
const Repo = {
  entries: {
    list: uid => Object.values(db.entries).filter(e => e.user_id === uid).sort((a, b) => b.date.localeCompare(a.date)),
    get: (uid, id) => { const e = UUID_RE.test(id) ? db.entries[id] : null; return e && e.user_id === uid ? e : null; },
    byDate: (uid, date) => Object.values(db.entries).find(e => e.user_id === uid && e.date === date) || null,
    count: uid => Object.values(db.entries).filter(e => e.user_id === uid).length,
    create: (uid, data) => { const id = uuid(); const t = nowISO(); db.entries[id] = { id, user_id: uid, ...data, created_at: t, updated_at: t }; save(); return db.entries[id]; },
    update: (uid, id, data) => { const e = Repo.entries.get(uid, id); if (!e) return null; Object.assign(e, data, { updated_at: nowISO() }); save(); return e; },
    remove: (uid, id) => { const e = Repo.entries.get(uid, id); if (!e) return false; delete db.entries[id]; save(); return true; },
    removeAll: uid => { for (const e of Repo.entries.list(uid)) delete db.entries[e.id]; }
  },
  memories: {
    list: uid => Object.values(db.memories).filter(m => m.user_id === uid).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    get: (uid, id) => { const m = UUID_RE.test(id) ? db.memories[id] : null; return m && m.user_id === uid ? m : null; },
    count: uid => Object.values(db.memories).filter(m => m.user_id === uid).length,
    create: (uid, data) => { const id = uuid(); db.memories[id] = { id, user_id: uid, ...data, created_at: nowISO() }; save(); return db.memories[id]; },
    remove: (uid, id) => { const m = Repo.memories.get(uid, id); if (!m) return false; delete db.memories[id]; save(); return true; },
    removeAll: uid => { for (const m of Repo.memories.list(uid)) delete db.memories[m.id]; }
  },
  settings: {
    get: uid => { if (!db.settings[uid]) db.settings[uid] = { user_id: uid, letter: "", lastMood: "Calm", recapSeen: {} }; return db.settings[uid]; },
    update: (uid, patch) => { Object.assign(Repo.settings.get(uid), patch); save(); }
  }
};
const pubEntry = e => ({ id: e.id, date: e.date, title: e.title, mood: e.mood, body: e.body, gratitude: e.gratitude, song: e.song, updated_at: e.updated_at });
const pubMemory = m => ({ id: m.id, text: m.text, date: m.date });

/* ------------------------------ Kripto ------------------------------- */
const scrypt = (secret, salt) => new Promise((res, rej) =>
  crypto.scrypt(secret, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? rej(e) : res(k)));
async function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString("hex"), hash: (await scrypt(secret, salt)).toString("hex") };
}
async function verifySecret(secret, rec) {
  const key = await scrypt(secret, Buffer.from(rec.salt, "hex"));
  const exp = Buffer.from(rec.hash, "hex");
  return exp.length === key.length && crypto.timingSafeEqual(exp, key);
}
const DUMMY = { salt: crypto.randomBytes(16).toString("hex"), hash: crypto.randomBytes(64).toString("hex") };
const sha = t => crypto.createHash("sha256").update(t).digest("hex");

/* ------------------------------- Sesi -------------------------------- */
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("="); if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function setCookie(res, value, maxAge) {
  res.setHeader("Set-Cookie", `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${SECURE ? "; Secure" : ""}`);
}
function createSession(uid) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.sessions[sha(token)] = { user_id: uid, created: Date.now(), expires: Date.now() + SESSION_TTL, locked: false };
  save();
  return token;
}
function getSession(req) {
  const raw = parseCookies(req)[COOKIE];
  if (!raw || raw.length > 128) return null;
  const key = sha(raw), s = db.sessions[key];
  if (!s) return null;
  const user = db.users[s.user_id];
  if (s.expires < Date.now() || !user) { delete db.sessions[key]; save(); return null; }
  if (s.expires - Date.now() < SESSION_TTL - 3600 * 1000) { s.expires = Date.now() + SESSION_TTL; save(); }
  return { key, s, user, uid: user.id };
}
function purgeSessions() {
  let ch = false;
  for (const [k, s] of Object.entries(db.sessions)) if (s.expires < Date.now() || !db.users[s.user_id]) { delete db.sessions[k]; ch = true; }
  if (ch) save();
}
purgeSessions(); setInterval(purgeSessions, 3600 * 1000).unref();

/* ---------------------------- Rate limiting -------------------------- */
const hits = new Map();
const blocked = (key, max) => { const h = hits.get(key); return !!h && h.reset > Date.now() && h.n >= max; };
const bump = (key, windowMs) => {
  let h = hits.get(key);
  if (!h || h.reset < Date.now()) { h = { n: 0, reset: Date.now() + windowMs }; hits.set(key, h); }
  h.n++;
};
setInterval(() => { for (const [k, h] of hits) if (h.reset < Date.now()) hits.delete(k); }, 600 * 1000).unref();

/* ------------------------------ Validasi ----------------------------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => new HttpError(400, msg);
function str(v, { name, min = 0, max, trim = true }) {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw bad(`${name} tidak valid`);
  v = v.replace(/\u0000/g, ""); if (trim) v = v.trim();
  if (v.length < min) throw bad(`${name} wajib diisi`);
  if (v.length > max) throw bad(`${name} terlalu panjang (maks ${max} karakter)`);
  return v;
}
function validDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number), dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 1970 && y <= 2100 && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function cleanEntry(i) {
  if (!i || typeof i !== "object") throw bad("Data tidak valid");
  if (!validDate(i.date)) throw bad("Tanggal tidak valid");
  if (!MOODS.includes(i.mood)) throw bad("Mood tidak valid");
  return {
    date: i.date,
    title: str(i.title, { name: "Judul", min: 1, max: 100 }),
    mood: i.mood,
    body: str(i.body, { name: "Cerita", min: 1, max: 20000 }),
    gratitude: str(i.gratitude, { name: "Syukur", max: 300 }),
    song: str(i.song, { name: "Lagu", max: 200 })
  };
}
function cleanMemory(i) {
  if (!i || typeof i !== "object") throw bad("Data tidak valid");
  return { text: str(i.text, { name: "Kenangan", min: 1, max: 2000 }), date: validDate(i.date) ? i.date : new Date().toISOString().slice(0, 10) };
}
const cleanUsername = v => {
  const u = typeof v === "string" ? v.trim() : "";
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(u)) throw bad("Username 3-30 karakter: huruf, angka, titik, strip, atau garis bawah");
  return u;
};
const cleanPassword = v => {
  if (typeof v !== "string" || v.length < 8 || v.length > 128) throw bad("Password harus 8-128 karakter");
  return v;
};
const cleanPin = v => {
  if (typeof v !== "string" || !/^\d{4,8}$/.test(v)) throw bad("PIN harus 4-8 digit angka");
  return v;
};

/* ------------------------------ HTTP util ---------------------------- */
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
function secHeaders(res) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (SECURE) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}
function send(res, status, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) }, extra));
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (over) return;
      if (size > limit) { over = true; chunks.length = 0; reject(new HttpError(413, "Data terlalu besar")); }
      else chunks.push(c);
    });
    req.on("end", () => {
      if (over) return;
      if (!size) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (v === null || typeof v !== "object" || Array.isArray(v)) throw 0;
        resolve(v);
      } catch { reject(bad("JSON tidak valid")); }
    });
    req.on("error", reject);
  });
}
const clientIP = req => (TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
function csrfCheck(req) {
  if (req.headers["x-requested-with"] !== "mld") throw new HttpError(403, "Permintaan ditolak");
  const sfs = req.headers["sec-fetch-site"];
  if (sfs && sfs !== "same-origin" && sfs !== "none") throw new HttpError(403, "Permintaan ditolak");
  const origin = req.headers.origin;
  if (origin) { let h; try { h = new URL(origin).host; } catch { throw new HttpError(403, "Permintaan ditolak"); } if (h !== req.headers.host) throw new HttpError(403, "Permintaan ditolak"); }
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "Content-Type harus application/json");
}
function requireAuth(req) { const a = getSession(req); if (!a) throw new HttpError(401, "Belum masuk"); return a; }
function requireOpen(req) { const a = requireAuth(req); if (a.s.locked) throw new HttpError(423, "Diary terkunci"); return a; }

/* ------------------------------- Handlers ---------------------------- */
const publicUser = u => ({ username: u.username, name: u.name });
const meOf = a => ({ authenticated: true, user: publicUser(a.user), hasPin: !!a.user.pin, locked: !!a.s.locked });

async function api(req, res, pathname, query) {
  const method = req.method;
  if (method !== "GET" && method !== "HEAD") csrfCheck(req);
  const ip = clientIP(req);
  let m;

  /* ---- Auth publik ---- */
  if (pathname === "/api/register" && method === "POST") {
    if (blocked("reg:" + ip, REGISTER_LIMIT)) throw new HttpError(429, "Terlalu banyak percobaan. Coba lagi nanti.");
    bump("reg:" + ip, 3600 * 1000);
    const b = await readBody(req, 8 * 1024);
    const username = cleanUsername(b.username), password = cleanPassword(b.password);
    const name = str(b.name, { name: "Nama", max: 40 }) || username;
    if (Object.values(db.users).some(u => u.username_lc === username.toLowerCase())) throw new HttpError(409, "Username sudah dipakai");
    const id = uuid();
    db.users[id] = { id, username, username_lc: username.toLowerCase(), name, pass: await hashSecret(password), pin: null, created_at: nowISO() };
    Repo.settings.get(id);
    const token = createSession(id);
    setCookie(res, token, SESSION_TTL / 1000);
    save();
    return send(res, 201, meOf(getSessionFromToken(token)));
  }
  if (pathname === "/api/login" && method === "POST") {
    const b = await readBody(req, 8 * 1024);
    const uname = typeof b.username === "string" ? b.username.trim().toLowerCase().slice(0, 40) : "";
    const k1 = `login:${ip}:${uname}`, k2 = `login:${ip}`;
    if (blocked(k1, 5) || blocked(k2, 40)) throw new HttpError(429, "Terlalu banyak percobaan. Coba lagi dalam 15 menit.");
    const user = Object.values(db.users).find(u => u.username_lc === uname);
    const ok = await verifySecret(typeof b.password === "string" ? b.password.slice(0, 128) : "", user ? user.pass : DUMMY);
    if (!user || !ok) { bump(k1, 900 * 1000); bump(k2, 900 * 1000); throw new HttpError(401, "Username atau password salah"); }
    hits.delete(k1);
    const old = parseCookies(req)[COOKIE]; if (old) delete db.sessions[sha(old)]; // cegah session fixation
    const token = createSession(user.id);
    setCookie(res, token, SESSION_TTL / 1000);
    return send(res, 200, meOf(getSessionFromToken(token)));
  }
  if (pathname === "/api/me" && (method === "GET" || method === "HEAD")) {
    const a = getSession(req);
    return send(res, 200, a ? meOf(a) : { authenticated: false });
  }
  if (pathname === "/api/logout" && method === "POST") {
    const raw = parseCookies(req)[COOKIE];
    if (raw) { delete db.sessions[sha(raw)]; save(); }
    setCookie(res, "", 0);
    return send(res, 200, { ok: true });
  }

  /* ---- Kunci PIN (diverifikasi di server) ---- */
  if (pathname === "/api/lock" && method === "POST") {
    const a = requireAuth(req);
    if (!a.user.pin) throw bad("Buat PIN dulu sebelum mengunci diary");
    a.s.locked = true; save();
    return send(res, 200, { locked: true });
  }
  if (pathname === "/api/unlock" && method === "POST") {
    const a = requireAuth(req);
    const b = await readBody(req, 2 * 1024);
    if (!a.user.pin) throw bad("PIN belum dibuat");
    const k = "pin:" + a.uid;
    if (blocked(k, 5)) throw new HttpError(429, "Terlalu banyak PIN salah. Coba lagi dalam 10 menit.");
    if (typeof b.pin !== "string" || !(await verifySecret(b.pin.slice(0, 16), a.user.pin))) { bump(k, 600 * 1000); throw new HttpError(403, "PIN salah"); }
    hits.delete(k); a.s.locked = false; save();
    return send(res, 200, { locked: false });
  }
  if (pathname === "/api/pin" && method === "POST") {
    const a = requireOpen(req);
    const b = await readBody(req, 2 * 1024);
    const k = "pin:" + a.uid;
    if (a.user.pin) {
      if (blocked(k, 5)) throw new HttpError(429, "Terlalu banyak PIN salah. Coba lagi dalam 10 menit.");
      if (typeof b.current !== "string" || !(await verifySecret(b.current.slice(0, 16), a.user.pin))) { bump(k, 600 * 1000); throw new HttpError(403, "PIN lama salah"); }
      hits.delete(k);
    }
    a.user.pin = await hashSecret(cleanPin(b.pin)); save();
    return send(res, 200, { hasPin: true });
  }

  /* ---- Data pribadi (wajib login & tidak terkunci; selalu terikat uid sesi) ---- */
  if (pathname === "/api/data" && method === "GET") {
    const a = requireOpen(req), st = Repo.settings.get(a.uid);
    return send(res, 200, {
      entries: Repo.entries.list(a.uid).map(pubEntry),
      memories: Repo.memories.list(a.uid).map(pubMemory),
      letter: st.letter, lastMood: st.lastMood, recapSeen: st.recapSeen
    });
  }
  if (pathname === "/api/entries" && method === "POST") {
    const a = requireOpen(req);
    const data = cleanEntry(await readBody(req, 64 * 1024));
    const existing = Repo.entries.byDate(a.uid, data.date);
    if (existing) { Repo.settings.update(a.uid, { lastMood: data.mood }); return send(res, 200, { entry: pubEntry(Repo.entries.update(a.uid, existing.id, data)), updated: true }); }
    if (Repo.entries.count(a.uid) >= MAX_ENTRIES) throw bad("Batas jumlah diary tercapai");
    Repo.settings.update(a.uid, { lastMood: data.mood });
    return send(res, 201, { entry: pubEntry(Repo.entries.create(a.uid, data)), updated: false });
  }
  if ((m = pathname.match(/^\/api\/entries\/([^/]+)$/))) {
    const a = requireOpen(req), id = m[1];
    const e = Repo.entries.get(a.uid, id);               // validasi kepemilikan
    if (!e) throw new HttpError(404, "Data tidak ditemukan");
    if (method === "GET") return send(res, 200, { entry: pubEntry(e) });
    if (method === "PUT") {
      const data = cleanEntry(await readBody(req, 64 * 1024));
      const clash = Repo.entries.byDate(a.uid, data.date);
      if (clash && clash.id !== id) throw new HttpError(409, "Sudah ada diary pada tanggal itu");
      return send(res, 200, { entry: pubEntry(Repo.entries.update(a.uid, id, data)) });
    }
    if (method === "DELETE") { Repo.entries.remove(a.uid, id); return send(res, 200, { ok: true }); }
    throw new HttpError(405, "Metode tidak diizinkan");
  }
  if (pathname === "/api/memories" && method === "POST") {
    const a = requireOpen(req);
    const data = cleanMemory(await readBody(req, 16 * 1024));
    if (Repo.memories.count(a.uid) >= MAX_MEMORIES) throw bad("Batas jumlah kenangan tercapai");
    return send(res, 201, { memory: pubMemory(Repo.memories.create(a.uid, data)) });
  }
  if ((m = pathname.match(/^\/api\/memories\/([^/]+)$/)) && method === "DELETE") {
    const a = requireOpen(req);
    if (!Repo.memories.remove(a.uid, m[1])) throw new HttpError(404, "Data tidak ditemukan");
    return send(res, 200, { ok: true });
  }
  if (pathname === "/api/settings" && method === "PUT") {
    const a = requireOpen(req), b = await readBody(req, 64 * 1024), patch = {};
    if (b.letter !== undefined) patch.letter = str(b.letter, { name: "Surat", max: 20000, trim: false });
    if (b.lastMood !== undefined) { if (!MOODS.includes(b.lastMood)) throw bad("Mood tidak valid"); patch.lastMood = b.lastMood; }
    Repo.settings.update(a.uid, patch);
    return send(res, 200, { ok: true });
  }
  if (pathname === "/api/recap-seen" && method === "POST") {
    const a = requireOpen(req), b = await readBody(req, 1024);
    if (typeof b.key !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(b.key)) throw bad("Bulan tidak valid");
    const st = Repo.settings.get(a.uid); st.recapSeen[b.key] = true; save();
    return send(res, 200, { ok: true });
  }
  if (pathname === "/api/export" && method === "GET") {
    const a = requireOpen(req), st = Repo.settings.get(a.uid);
    const body = JSON.stringify({
      app: "my-little-diary", version: 2, exported_at: nowISO(),
      entries: Repo.entries.list(a.uid).map(e => ({ date: e.date, title: e.title, mood: e.mood, body: e.body, gratitude: e.gratitude, song: e.song })),
      memories: Repo.memories.list(a.uid).map(x => ({ text: x.text, date: x.date })),
      letter: st.letter, lastMood: st.lastMood, recapSeen: st.recapSeen
    }, null, 2);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": 'attachment; filename="my-little-diary-backup.json"', "Cache-Control": "no-store" });
    return res.end(body);
  }
  if (pathname === "/api/import" && method === "POST") {
    const a = requireOpen(req), b = await readBody(req, 3 * 1024 * 1024);
    if (!Array.isArray(b.entries) || !Array.isArray(b.memories)) throw bad("Format backup tidak sesuai");
    if (b.entries.length > 5000 || b.memories.length > 5000) throw bad("Backup terlalu besar");
    const entries = new Map(), memories = []; let skipped = 0;
    for (const e of b.entries) { try { const c = cleanEntry(e); entries.set(c.date, c); } catch { skipped++; } }
    for (const x of b.memories) { try { memories.push(cleanMemory(x)); } catch { skipped++; } }
    const st = {};
    if (typeof b.letter === "string") st.letter = b.letter.replace(/\u0000/g, "").slice(0, 20000);
    if (MOODS.includes(b.lastMood)) st.lastMood = b.lastMood;
    const seen = {};
    if (b.recapSeen && typeof b.recapSeen === "object") for (const k of Object.keys(b.recapSeen)) if (/^\d{4}-(0[1-9]|1[0-2])$/.test(k)) seen[k] = true;
    // user_id selalu dipaksa = uid sesi; id/user_id dari file backup diabaikan sepenuhnya
    Repo.entries.removeAll(a.uid); Repo.memories.removeAll(a.uid);
    for (const c of entries.values()) Repo.entries.create(a.uid, c);
    for (const c of memories) Repo.memories.create(a.uid, c);
    Repo.settings.update(a.uid, Object.assign(st, { recapSeen: seen }));
    return send(res, 200, { ok: true, imported: { entries: entries.size, memories: memories.length }, skipped });
  }
  throw new HttpError(404, "Tidak ditemukan");
}
function getSessionFromToken(token) {
  const s = db.sessions[sha(token)];
  return { key: sha(token), s, user: db.users[s.user_id], uid: s.user_id };
}

/* ------------------------------ Static ------------------------------- */
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"]
};
function serveStatic(req, res, pathname) {
  const f = Object.prototype.hasOwnProperty.call(STATIC, pathname) ? STATIC[pathname] : null;
  if (!f || (req.method !== "GET" && req.method !== "HEAD")) return send(res, 404, { error: "Tidak ditemukan" });
  fs.readFile(path.join(PUBLIC_DIR, f[0]), (err, buf) => {
    if (err) return send(res, 404, { error: "Tidak ditemukan" });
    res.writeHead(200, { "Content-Type": f[1], "Cache-Control": "no-cache", "Content-Length": buf.length });
    res.end(req.method === "HEAD" ? undefined : buf);
  });
}

/* ------------------------------- Server ------------------------------ */
const server = http.createServer(async (req, res) => {
  secHeaders(res);
  try {
    if (ALLOWED_HOSTS && !ALLOWED_HOSTS.includes(String(req.headers.host || "").toLowerCase())) throw new HttpError(400, "Host tidak diizinkan");
    const u = new URL(req.url, "http://localhost");
    if (u.pathname.startsWith("/api/")) await api(req, res, u.pathname, u.searchParams);
    else serveStatic(req, res, u.pathname);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) {
      if (e.status === 413) { res.setHeader("Connection", "close"); res.on("finish", () => req.destroy()); }
      return send(res, e.status, { error: e.message });
    }
    console.error("Error:", e && e.message);
    send(res, 500, { error: "Terjadi kesalahan di server" });
  }
});
server.requestTimeout = 20000;
server.headersTimeout = 10000;
server.listen(PORT, HOST, () => {
  console.log(`My Little Diary berjalan di http://${HOST}:${PORT}`);
  if (!ALLOWED_HOSTS) console.log("PERINGATAN: server terbuka ke jaringan. Gunakan HTTPS (reverse proxy) dan set SECURE_COOKIES=1.");
});
