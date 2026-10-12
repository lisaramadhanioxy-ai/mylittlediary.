"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PORT = 3900 + Math.floor(Math.random() * 90);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mld-"));
let proc;

function call(method, url, { cookie, body, headers = {}, raw, csrf = true } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
    const h = Object.assign({}, headers);
    if (csrf) h["X-Requested-With"] = "mld";
    if (data !== undefined || method !== "GET") h["Content-Type"] = h["Content-Type"] || "application/json";
    if (cookie) h.Cookie = cookie;
    if (data !== undefined) h["Content-Length"] = Buffer.byteLength(data);
    const r = http.request({ host: "127.0.0.1", port: PORT, path: url, method, headers: h }, res => {
      let b = ""; res.on("data", c => b += c);
      res.on("end", () => { let json = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode, headers: res.headers, json, text: b }); });
    });
    r.on("error", reject);
    if (data !== undefined) r.write(data);
    r.end();
  });
}
const cookieOf = r => (r.headers["set-cookie"] || [""])[0].split(";")[0];
async function register(username, password = "Passw0rd-secret") {
  const r = await call("POST", "/api/register", { body: { username, password, name: username } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return cookieOf(r);
}
const entry = (date, title = "Judul") => ({ date, title, mood: "Happy", body: "isi rahasia", gratitude: "syukur", song: "lagu" });

before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT, DATA_DIR, HOST: "127.0.0.1", REGISTER_LIMIT_PER_HOUR: "1000" } });
  await new Promise((res, rej) => { proc.stdout.on("data", d => String(d).includes("berjalan") && res()); proc.on("error", rej); setTimeout(() => rej(new Error("server tidak start")), 5000); });
});
after(() => { proc.kill(); });

test("tanpa login: semua endpoint data ditolak 401", async () => {
  for (const [m, u] of [["GET", "/api/data"], ["POST", "/api/entries"], ["GET", "/api/export"], ["POST", "/api/import"], ["PUT", "/api/settings"], ["POST", "/api/memories"], ["GET", "/api/entries/abc"]]) {
    const r = await call(m, u, { body: m === "GET" ? undefined : {} });
    assert.equal(r.status, 401, `${m} ${u}`);
  }
});

test("registrasi: validasi, cookie aman, password tidak disimpan polos", async () => {
  assert.equal((await call("POST", "/api/register", { body: { username: "ab", password: "Passw0rd-secret" } })).status, 400);
  assert.equal((await call("POST", "/api/register", { body: { username: "okuser", password: "short" } })).status, 400);
  const r = await call("POST", "/api/register", { body: { username: "Alice", password: "Passw0rd-secret", name: "Alice" } });
  assert.equal(r.status, 201);
  const sc = r.headers["set-cookie"][0];
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  assert.equal((await call("POST", "/api/register", { body: { username: "alice", password: "Passw0rd-secret" } })).status, 409, "username unik (case-insensitive)");
  await new Promise(r => setTimeout(r, 150));
  const dbText = fs.readFileSync(path.join(DATA_DIR, "db.json"), "utf8");
  assert.ok(!dbText.includes("Passw0rd-secret"), "password tidak boleh tersimpan polos");
  assert.ok(!dbText.includes(sc.split(";")[0].split("=")[1]), "token sesi tidak boleh tersimpan polos");
});

test("isolasi data: user B tidak bisa lihat/ubah/hapus data user A", async () => {
  const A = await register("userA"), B = await register("userB");
  const ea = (await call("POST", "/api/entries", { cookie: A, body: entry("2026-01-05", "Rahasia A") })).json.entry;
  const ma = (await call("POST", "/api/memories", { cookie: A, body: { text: "kenangan A", date: "2026-01-05" } })).json.memory;
  await call("PUT", "/api/settings", { cookie: A, body: { letter: "surat rahasia A" } });

  const dataB = (await call("GET", "/api/data", { cookie: B })).json;
  assert.equal(dataB.entries.length, 0); assert.equal(dataB.memories.length, 0); assert.equal(dataB.letter, "");
  assert.ok(!JSON.stringify(dataB).includes("Rahasia A"));

  // akses langsung via ID (manipulasi URL)
  assert.equal((await call("GET", `/api/entries/${ea.id}`, { cookie: B })).status, 404);
  assert.equal((await call("PUT", `/api/entries/${ea.id}`, { cookie: B, body: entry("2026-01-05", "DIRETAS") })).status, 404);
  assert.equal((await call("DELETE", `/api/entries/${ea.id}`, { cookie: B })).status, 404);
  assert.equal((await call("DELETE", `/api/memories/${ma.id}`, { cookie: B })).status, 404);

  // manipulasi body: mass-assignment id & user_id diabaikan
  const forged = await call("POST", "/api/entries", { cookie: B, body: { ...entry("2026-01-05", "Milik B"), id: ea.id, user_id: "apapun", userId: "apapun" } });
  assert.equal(forged.status, 201);
  assert.notEqual(forged.json.entry.id, ea.id);

  // import yang memuat id/user_id data A tidak boleh menyentuh A
  const imp = await call("POST", "/api/import", { cookie: B, body: { entries: [{ ...entry("2026-02-01", "impor B"), id: ea.id, user_id: "x" }], memories: [{ text: "m", id: ma.id }] } });
  assert.equal(imp.status, 200);

  const dataA = (await call("GET", "/api/data", { cookie: A })).json;
  assert.equal(dataA.entries.length, 1); assert.equal(dataA.entries[0].title, "Rahasia A");
  assert.equal(dataA.memories.length, 1); assert.equal(dataA.letter, "surat rahasia A");
  const exportB = (await call("GET", "/api/export", { cookie: B })).text;
  assert.ok(!exportB.includes("Rahasia A") && !exportB.includes("kenangan A") && !exportB.includes("surat rahasia A"));
  const dataB2 = (await call("GET", "/api/data", { cookie: B })).json;
  assert.deepEqual(dataB2.entries.map(e => e.title), ["impor B"]);
});

test("ID aneh/injeksi path menghasilkan 404, bukan error server", async () => {
  const A = await register("userC");
  for (const id of ["..%2f..%2fdb.json", "__proto__", "constructor", "%00", "x".repeat(300), "1"]) {
    const r = await call("GET", `/api/entries/${id}`, { cookie: A });
    assert.equal(r.status, 404, id);
  }
});

test("CSRF: tanpa header khusus / origin asing / cross-site ditolak", async () => {
  const A = await register("userD");
  assert.equal((await call("POST", "/api/entries", { cookie: A, body: entry("2026-03-01"), csrf: false })).status, 403);
  assert.equal((await call("POST", "/api/entries", { cookie: A, body: entry("2026-03-01"), headers: { Origin: "http://evil.example" } })).status, 403);
  assert.equal((await call("POST", "/api/entries", { cookie: A, body: entry("2026-03-01"), headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await call("POST", "/api/entries", { cookie: A, body: entry("2026-03-01"), headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await call("POST", "/api/entries", { cookie: A, body: entry("2026-03-01"), headers: { Origin: `http://127.0.0.1:${PORT}` } })).status, 201);
});

test("logout aman, sesi lama tidak berlaku, data tetap ada setelah login ulang", async () => {
  const A = await register("userE");
  await call("POST", "/api/entries", { cookie: A, body: entry("2026-04-01", "Tetap ada") });
  const out = await call("POST", "/api/logout", { cookie: A, body: {} });
  assert.equal(out.status, 200); assert.match(out.headers["set-cookie"][0], /Max-Age=0/);
  assert.equal((await call("GET", "/api/data", { cookie: A })).status, 401, "cookie lama harus mati di server");
  const bad = await call("POST", "/api/login", { body: { username: "usere", password: "salah-banget" } });
  assert.equal(bad.status, 401); assert.equal(bad.json.error, "Username atau password salah");
  const unknown = await call("POST", "/api/login", { body: { username: "tidak-ada", password: "salah-banget" } });
  assert.equal(unknown.json.error, bad.json.error, "pesan error tidak membocorkan keberadaan akun");
  const login = await call("POST", "/api/login", { body: { username: "UserE", password: "Passw0rd-secret" } });
  assert.equal(login.status, 200);
  const A2 = cookieOf(login);
  assert.notEqual(A2, A);
  assert.equal((await call("GET", "/api/data", { cookie: A2 })).json.entries[0].title, "Tetap ada");
});

test("rate limit login", async () => {
  await register("userF");
  let last;
  for (let i = 0; i < 6; i++) last = await call("POST", "/api/login", { body: { username: "userf", password: "salah-salah" } });
  assert.equal(last.status, 429);
  const ok = await call("POST", "/api/login", { body: { username: "userf", password: "Passw0rd-secret" } });
  assert.equal(ok.status, 429, "akun/IP yang diblokir tetap diblokir walau password benar");
});

test("PIN & kunci diperiksa di server (bukan hanya tampilan)", async () => {
  const A = await register("userG");
  await call("POST", "/api/entries", { cookie: A, body: entry("2026-05-01", "Dikunci") });
  assert.equal((await call("POST", "/api/lock", { cookie: A, body: {} })).status, 400, "tanpa PIN tidak bisa mengunci");
  assert.equal((await call("POST", "/api/pin", { cookie: A, body: { pin: "12" } })).status, 400);
  assert.equal((await call("POST", "/api/pin", { cookie: A, body: { pin: "123456" } })).status, 200);
  assert.equal((await call("POST", "/api/lock", { cookie: A, body: {} })).status, 200);
  for (const [m, u, b] of [["GET", "/api/data"], ["GET", "/api/export"], ["POST", "/api/entries", entry("2026-05-02")], ["PUT", "/api/settings", { letter: "x" }], ["POST", "/api/import", { entries: [], memories: [] }]]) {
    assert.equal((await call(m, u, { cookie: A, body: b })).status, 423, `${m} ${u} harus 423 saat terkunci`);
  }
  assert.equal((await call("POST", "/api/pin", { cookie: A, body: { pin: "999999" } })).status, 423, "tidak bisa ganti PIN saat terkunci");
  assert.equal((await call("POST", "/api/unlock", { cookie: A, body: { pin: "000000" } })).status, 403);
  assert.equal((await call("POST", "/api/unlock", { cookie: A, body: { pin: "123456" } })).status, 200);
  assert.equal((await call("GET", "/api/data", { cookie: A })).json.entries[0].title, "Dikunci");
  assert.equal((await call("POST", "/api/pin", { cookie: A, body: { pin: "654321" } })).status, 403, "ganti PIN wajib PIN lama");
  assert.equal((await call("POST", "/api/pin", { cookie: A, body: { current: "123456", pin: "654321" } })).status, 200);
  // brute force PIN dibatasi
  await call("POST", "/api/lock", { cookie: A, body: {} });
  let r; for (let i = 0; i < 6; i++) r = await call("POST", "/api/unlock", { cookie: A, body: { pin: "111111" } });
  assert.equal(r.status, 429);
});

test("validasi input & batas ukuran", async () => {
  const A = await register("userH");
  assert.equal((await call("POST", "/api/entries", { cookie: A, body: { ...entry("2026-13-40") } })).status, 400);
  assert.equal((await call("POST", "/api/entries", { cookie: A, body: { ...entry("2026-01-01"), mood: "Hacker" } })).status, 400);
  assert.equal((await call("POST", "/api/entries", { cookie: A, body: { ...entry("2026-01-01"), title: 123 } })).status, 400);
  assert.equal((await call("POST", "/api/entries", { cookie: A, raw: "{bukan json" })).status, 400);
  assert.equal((await call("POST", "/api/entries", { cookie: A, raw: JSON.stringify({ ...entry("2026-01-01"), body: "x".repeat(200000) }) })).status, 413);
  const xss = await call("POST", "/api/entries", { cookie: A, body: { ...entry("2026-01-02"), title: "<img src=x onerror=alert(1)>" } });
  assert.equal(xss.status, 201); // disimpan sebagai teks; frontend selalu meng-escape saat render
});

test("file statis dibatasi & header keamanan terpasang", async () => {
  for (const u of ["/server.js", "/data/db.json", "/../server.js", "/%2e%2e/server.js", "/package.json", "/test/isolation.test.js"]) {
    assert.equal((await call("GET", u, { csrf: false })).status, 404, u);
  }
  const page = await call("GET", "/", { csrf: false });
  assert.equal(page.status, 200);
  assert.match(page.headers["content-security-policy"], /script-src 'self'/);
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.ok(!/onclick=|<script>[^<]/.test(page.text), "tidak boleh ada inline script/handler (CSP)");
  const bad = await call("GET", "/", { csrf: false, headers: { Host: "evil.example" } });
  assert.equal(bad.status, 400, "Host asing ditolak (anti DNS rebinding)");
});
