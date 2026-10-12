"use strict";

const $ = id => document.getElementById(id);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};

const moods = [
 {id:"Happy",label:"Happy",bg:"#ffe78d",skin:"#ffd3b3"},
 {id:"Calm",label:"Calm",bg:"#bde8f6",skin:"#f8cfb0"},
 {id:"Tired",label:"Tired",bg:"#d9c8ff",skin:"#f3cdb5"},
 {id:"Sad",label:"Sad",bg:"#c9e4ff",skin:"#f6d0b8"},
 {id:"Anxious",label:"Anxious",bg:"#ffddbd",skin:"#f3c9aa"}
];
let state = emptyState();
let selectedMood = state.lastMood || "Calm";
let walking = false, sleeping = false, audioCtx = null, musicTimer = null;
let musicOn = false, userMuted = false, musicStepIdx = 0;
let unlocked = true, hasPin = false, authed = false;
let pets = [], snacks = [], snackId = 0, dragPet = null, dragSnack = null;
let lastTime = 0;

function emptyState(){return {entries:[],memories:[],letter:"",lastMood:"Calm",recapSeen:{}};}

/* ---------- SUPABASE ---------- */
const SUPABASE_URL = "https://seidxxrzxjjjhrafscga.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_4YajoLeQeqNMs9zwkXvxQA_fPMfVnfm";

if (!window.supabase) {
  document.addEventListener("DOMContentLoaded", () => {
    const m = document.getElementById("authMsg");
    if (m) m.textContent = "Library Supabase belum dimuat. Cek tag <script> di index.html.";
  });
  throw new Error("Supabase JS belum dimuat sebelum app.js");
}
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let currentUser = null, pinHash = null, diaryLocked = false;

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = error => {
  if (!error) return;
  const m = String(error.message || "");
  if (error.code === "PGRST205" || error.code === "42P01" || /could not find the table|does not exist/i.test(m))
    throw new ApiError(500, "Tabel database belum dibuat. Jalankan supabase-setup.sql di Supabase > SQL Editor.");
  throw new ApiError(500, m || "Terjadi kesalahan.");
};

async function hashPin(pin) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("mld:" + currentUser.id + ":" + pin));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function upsertSettings(patch) {
  const { error } = await sb.from("settings").upsert({ user_id: currentUser.id, ...patch }, { onConflict: "user_id" });
  fail(error);
}

/* api() meniru endpoint lama, tapi memakai Supabase */
async function api(method, url, body) {
  if (!currentUser) throw new ApiError(401, "Sesi berakhir.");
  const uid = currentUser.id;
  if (diaryLocked && url !== "/api/unlock") { applyLock(true); throw new ApiError(423, "Diary terkunci."); }
  const id = decodeURIComponent(url.split("/").pop());

  if (method === "GET" && url === "/api/data") {
    const [e, m, s] = await Promise.all([
      sb.from("entries").select("*").order("date", { ascending: false }),
      sb.from("memories").select("*").order("created_at", { ascending: true }),
      sb.from("settings").select("*").maybeSingle()
    ]);
    fail(e.error); fail(m.error); fail(s.error);
    return { entries: e.data, memories: m.data, letter: s.data?.letter || "",
             lastMood: s.data?.last_mood || "Calm", recapSeen: s.data?.recap_seen || {} };
  }
  if (method === "POST" && url === "/api/entries") {
    const row = { user_id: uid, date: body.date, title: body.title, mood: body.mood,
                  body: body.body, gratitude: body.gratitude || "", song: body.song || "" };
    const { data, error } = await sb.from("entries").upsert(row, { onConflict: "user_id,date" }).select().single();
    fail(error); return { entry: data };
  }
  if (method === "DELETE" && url.startsWith("/api/entries/")) {
    const { error } = await sb.from("entries").delete().eq("id", id); fail(error); return {};
  }
  if (method === "POST" && url === "/api/memories") {
    const { data, error } = await sb.from("memories").insert({ user_id: uid, text: body.text, date: body.date }).select().single();
    fail(error); return { memory: data };
  }
  if (method === "DELETE" && url.startsWith("/api/memories/")) {
    const { error } = await sb.from("memories").delete().eq("id", id); fail(error); return {};
  }
  if (method === "PUT" && url === "/api/settings") {
    const p = {};
    if (body.lastMood !== undefined) p.last_mood = body.lastMood;
    if (body.letter !== undefined) p.letter = body.letter;
    await upsertSettings(p); return {};
  }
  if (method === "POST" && url === "/api/recap-seen") {
    await upsertSettings({ recap_seen: state.recapSeen }); return {};
  }
  if (method === "POST" && url === "/api/pin") {
    if (!/^\d{4,8}$/.test(String(body.pin || ""))) throw new ApiError(400, "PIN harus 4-8 digit angka.");
    if (pinHash && (await hashPin(body.current || "")) !== pinHash) throw new ApiError(403, "PIN lama salah.");
    const h = await hashPin(body.pin);
    await upsertSettings({ pin_hash: h }); pinHash = h; return {};
  }
  if (method === "POST" && url === "/api/lock") { diaryLocked = true; return {}; }
  if (method === "POST" && url === "/api/unlock") {
    if (!pinHash || (await hashPin(String(body.pin || ""))) !== pinHash) throw new ApiError(403, "PIN salah.");
    diaryLocked = false; return {};
  }
  if (method === "GET" && url === "/api/export") {
    const d = await api("GET", "/api/data");
    return { app: "my-little-diary", version: 1, ...d };
  }
  if (method === "POST" && url === "/api/import") {
    const okMood = x => moods.some(m => m.id === x) ? x : "Calm";
    const byDate = new Map();
    (Array.isArray(body.entries) ? body.entries : []).forEach(x => {
      if (x && /^\d{4}-\d{2}-\d{2}$/.test(x.date) && x.title && x.body)
        byDate.set(x.date, { user_id: uid, date: x.date, title: String(x.title).slice(0, 200), mood: okMood(x.mood),
          body: String(x.body), gratitude: String(x.gratitude || ""), song: String(x.song || "") });
    });
    const mems = (Array.isArray(body.memories) ? body.memories : []).filter(x => x && x.text)
      .map(x => ({ user_id: uid, text: String(x.text), date: /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : today() }));
    const ents = [...byDate.values()];
    const skipped = (body.entries?.length || 0) - ents.length + (body.memories?.length || 0) - mems.length;
    let r = await sb.from("entries").delete().eq("user_id", uid); fail(r.error);
    r = await sb.from("memories").delete().eq("user_id", uid); fail(r.error);
    if (ents.length) { r = await sb.from("entries").insert(ents); fail(r.error); }
    if (mems.length) { r = await sb.from("memories").insert(mems); fail(r.error); }
    if (body.letter !== undefined) await upsertSettings({ letter: String(body.letter) });
    return { imported: { entries: ents.length, memories: mems.length }, skipped: Math.max(0, skipped) };
  }
  throw new ApiError(404, "Endpoint tidak dikenal.");
}
function saveSettings(patch) { api("PUT", "/api/settings", patch).catch(() => {}); }

function wipeData() {
  state = emptyState(); selectedMood = "Calm";
  ["entries", "memoryList", "recapPoster", "gardenGrid", "mainFlower"].forEach(id => { $(id).innerHTML = ""; });
  $("diaryForm").reset();
  ["quickThought", "memoryText", "futureLetter", "searchEntries"].forEach(id => { $(id).value = ""; });
  ["saveStatus", "letterStatus", "recapStatus", "memoryStatus"].forEach(id => { $(id).textContent = ""; });
  $("recapPop").classList.remove("show");
}
function showAuth(msg) {
  authed = false; unlocked = true; hasPin = false;
  currentUser = null; pinHash = null; diaryLocked = false;
  document.body.classList.remove("authed");
  $("userbar").classList.add("hidden");
  wipeData();
  ["diary-section", "garden-section", "recap-section", "memoryPrivate"].forEach(id => $(id).classList.remove("hidden"));
  $("privacyStatus").textContent = "";
  setAuthMode("login");
  $("authPass").value = ""; $("authMsg").textContent = msg || "";
}
function sessionEnded() { showAuth("Sesi berakhir. Silakan masuk lagi."); }
async function loadData() {
  const d = await api("GET", "/api/data");
  state = { entries: d.entries, memories: d.memories, letter: d.letter || "", lastMood: d.lastMood || "Calm", recapSeen: d.recapSeen || {} };
  selectedMood = state.lastMood;
  $("futureLetter").value = state.letter; $("entryDate").value = today();
  renderMoods(); renderEntries(); renderGarden(); renderMemories(); fillRecapMonths(); checkMonthlyRecap();
}
function applyLock(locked, silent) {
  unlocked = !locked;
  ["diary-section", "garden-section", "recap-section", "memoryPrivate"].forEach(id => $(id).classList.toggle("hidden", locked));
  if (locked) { wipeData(); renderMoods(); go("memory-section"); }
  if (!silent) $("privacyStatus").textContent = locked
    ? "Diary dikunci. Data dikosongkan dari layar dan tidak akan dikirim server sebelum PIN benar."
    : "Diary dibuka kembali.";
}
async function buildMe(user) {
  currentUser = user;
  let pin = null;
  try {
    const { data, error } = await sb.from("settings").select("pin_hash").maybeSingle();
    if (error) console.warn("Settings belum bisa dibaca:", error.message);
    else pin = data?.pin_hash || null;
  } catch (e) { console.warn(e); }
  pinHash = pin;
  diaryLocked = !!pin;
  return { user: { name: user.user_metadata?.display_name || (user.email || "").split("@")[0] || "Teman" },
           hasPin: !!pin, locked: diaryLocked };
}
async function enterApp(me) {
  authed = true; hasPin = !!me.hasPin;
  $("userName").textContent = me.user.name;
  $("userbar").classList.remove("hidden");
  document.body.classList.add("authed");
  document.querySelectorAll(".page").forEach(s => s.classList.toggle("show", s.id === "home"));
  document.querySelectorAll(".nav button").forEach(b => b.classList.toggle("active", b.dataset.go === "home"));
  if (me.locked) { applyLock(true, true); $("privacyStatus").textContent = "Diary terkunci. Masukkan PIN lewat tombol Unlock diary."; }
  else {
    applyLock(false, true);
    try { await loadData(); }
    catch (err) { alert("Kamu sudah masuk, tapi data gagal dimuat: " + err.message); }
  }
}

/* ---------- LOGIN & DAFTAR ---------- */
let authMode = "login", authBusy = false;

function showAuthMessage(msg, isError = true) {
  $("authMsg").textContent = msg;
  $("authMsg").style.color = isError ? "#c0395b" : "#27845c";
}
function setAuthMode(mode) {
  authMode = mode === "register" ? "register" : "login";
  $("tabLogin").classList.toggle("active", authMode === "login");
  $("tabRegister").classList.toggle("active", authMode === "register");
  $("nameField").classList.toggle("hidden", authMode !== "register");
  $("authTitle").textContent = authMode === "login" ? "Masuk" : "Buat akun";
  $("authSubmit").textContent = authMode === "login" ? "Masuk" : "Daftar & mulai";
  $("authPass").autocomplete = authMode === "login" ? "current-password" : "new-password";
  $("authEmail").autocomplete = "email";
  $("authMsg").textContent = "";
}
function authErrorText(error) {
  const m = String(error?.message || "").toLowerCase();
  if (m.includes("invalid login credentials")) return "Email atau kata sandi salah.";
  if (m.includes("already registered")) return "Email ini sudah terdaftar. Silakan masuk.";
  if (m.includes("email not confirmed")) return "Email belum diverifikasi. Cek inbox/spam kamu dulu.";
  if (m.includes("password should be") || m.includes("weak password")) return "Kata sandi terlalu lemah. Gunakan minimal 8 karakter.";
  if (m.includes("rate limit") || m.includes("too many")) return "Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi.";
  if (m.includes("failed to fetch") || m.includes("network")) return "Koneksi gagal. Periksa internet kamu.";
  return error?.message || "Terjadi kesalahan. Silakan coba lagi.";
}
$("tabLogin").addEventListener("click", () => { if (!authBusy) setAuthMode("login"); });
$("tabRegister").addEventListener("click", () => { if (!authBusy) setAuthMode("register"); });

$("authForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (authBusy) return;
  const email = $("authEmail").value.trim().toLowerCase();
  const password = $("authPass").value;
  const name = $("authName").value.trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showAuthMessage("Masukkan alamat email yang valid.");
  if (password.length < 8 || password.length > 128) return showAuthMessage("Kata sandi harus 8–128 karakter.");
  if (authMode === "register" && name.length > 40) return showAuthMessage("Nama panggilan maksimal 40 karakter.");

  authBusy = true;
  const btn = $("authSubmit"), label = authMode === "login" ? "Masuk" : "Daftar & mulai";
  btn.disabled = true; btn.textContent = "Mohon tunggu...";
  showAuthMessage("", false);
  try {
    let result;
    if (authMode === "register") {
      result = await sb.auth.signUp({ email, password, options: {
        emailRedirectTo: "https://lisaramadhanioxy-ai.github.io/mylittlediary/",
        data: { display_name: name || email.split("@")[0] } } });
      if (result.error) throw result.error;
      if (result.data.user && Array.isArray(result.data.user.identities) && result.data.user.identities.length === 0) {
        showAuthMessage("Email ini sudah terdaftar. Klik tab Masuk lalu login (tidak perlu daftar lagi).");
        return;
      }
      if (!result.data.session) {
        $("authPass").value = "";
        showAuthMessage("Pendaftaran berhasil! Cek email kamu dan klik tautan verifikasi, lalu masuk.", false);
        return;
      }
    } else {
      result = await sb.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
    }
    $("authPass").value = "";
    await enterApp(await buildMe(result.data.user));
  } catch (error) {
    console.error("Auth error:", error);
    showAuthMessage(authErrorText(error));
  } finally {
    authBusy = false; btn.disabled = false; btn.textContent = label;
  }
});

$("logoutBtn").addEventListener("click", async () => {
  try { await sb.auth.signOut(); } catch (e) { console.error(e); }
  showAuth("Kamu berhasil keluar.");
});
sb.auth.onAuthStateChange(event => {
  if (event === "SIGNED_OUT" && authed) showAuth("Sesi berakhir. Silakan masuk lagi.");
});

/* ---------- PIN ---------- */
function askSecret(title, hint) {
  return new Promise(resolve => {
    $("pinTitle").textContent = title;
    $("pinHint").textContent = hint;
    $("pinInput").value = "";
    $("pinPop").classList.add("show");
    $("pinInput").focus();
    const done = value => { $("pinPop").classList.remove("show"); $("pinInput").value = ""; resolve(value); };
    $("pinForm").onsubmit = e => { e.preventDefault(); done($("pinInput").value); };
    $("pinCancel").onclick = () => done(null);
  });
}

/* ---------- NAVIGASI: satu halaman per menu ---------- */
function go(id){
  if(!unlocked && (id==="diary-section"||id==="garden-section"||id==="recap-section")){
    id="memory-section";
    $("privacyStatus").textContent="Diary sedang terkunci. Tekan Unlock diary dulu.";
  }
  document.querySelectorAll(".page").forEach(s=>s.classList.toggle("show",s.id===id));
  document.querySelectorAll(".nav button").forEach(b=>b.classList.toggle("active",b.dataset.go===id));
  window.scrollTo({top:0,behavior:"smooth"});
  if(id==="room-section") requestAnimationFrame(fitRoom);
  if(id==="recap-section"){fillRecapMonths();renderRecap();$("recapStatus").textContent="";}
}
document.querySelectorAll(".nav button").forEach(b=>b.addEventListener("click",()=>go(b.dataset.go)));
$("heroWrite").addEventListener("click",()=>go("diary-section"));
$("continueBtn").addEventListener("click",()=>prepareDiary());

/* ---------- KARAKTER MOOD: wajah saja, ekspresi heboh ---------- */
function girlSVG(m){
 const ink="#7a4a3a", dark="#3b2418", hair="#c99a72", hairBack="#a9795a", hairHi="#f0cfa8", brow="#9a6a48", red="#d9485a";
 const uid="gc"+m.id;
 const star=(x,y,s,c)=>`<path transform="translate(${x} ${y}) scale(${s})" d="M0 -8 L2 -2 L8 0 L2 2 L0 8 L-2 2 L-8 0 L-2 -2Z" fill="${c}"/>`;
 const heart=(x,y,s,c)=>`<path transform="translate(${x} ${y}) scale(${s})" d="M0 4 C-10 -3 -5 -10 0 -4 C5 -10 10 -3 0 4Z" fill="${c}"/>`;
 const drop=(x,y,s)=>`<path transform="translate(${x} ${y}) scale(${s})" d="M0 -7 Q-6 1 0 5 Q6 1 0 -7Z" fill="#8fd3f7" stroke="#4fa6dc" stroke-width="1.3"/>`;
 const blush=(o=.7)=>`<ellipse cx="25" cy="63" rx="5.2" ry="3" fill="#ff8fa8" opacity="${o}"/><ellipse cx="65" cy="63" rx="5.2" ry="3" fill="#ff8fa8" opacity="${o}"/>`;
 // mata besar ala anime, di dalam kacamata
 const eye=(cx,ry=7.4,sad=false)=>`<ellipse cx="${cx}" cy="53.5" rx="6.3" ry="${ry}" fill="#8a5a3c"/><ellipse cx="${cx}" cy="55" rx="4.6" ry="${ry-2.4}" fill="#c98a5a" opacity=".85"/><ellipse cx="${cx}" cy="54" rx="3" ry="${ry-3.2}" fill="${dark}"/><circle cx="${cx+2.4}" cy="50.4" r="2.5" fill="#fff"/><circle cx="${cx-2.2}" cy="57" r="1.2" fill="#fff"/>${sad?`<circle cx="${cx-2.6}" cy="51" r="1.2" fill="#fff"/>`:""}<path d="M${cx-6.8} 49.5 Q${cx} ${53.5-ry-2.8} ${cx+6.8} 49.5" stroke="${dark}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
 const worried=cx=>`<ellipse cx="${cx}" cy="53.5" rx="6.6" ry="7.4" fill="#fff" stroke="${ink}" stroke-width="1.2"/><circle cx="${cx}" cy="54" r="2.8" fill="#6b4630"/><circle cx="${cx}" cy="54" r="1.4" fill="${dark}"/><circle cx="${cx-1}" cy="52.8" r=".9" fill="#fff"/>`;
 const glasses=`<circle cx="33" cy="53.5" r="10.6" fill="#ffffff" fill-opacity=".22" stroke="${red}" stroke-width="2.3"/><circle cx="57" cy="53.5" r="10.6" fill="#ffffff" fill-opacity=".22" stroke="${red}" stroke-width="2.3"/><path d="M43.4 52 Q45 50.2 46.6 52" fill="none" stroke="${red}" stroke-width="2.1" stroke-linecap="round"/><path d="M26 46.5 Q29 44 33 43.6" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".8"/><path d="M50 46.5 Q53 44 57 43.6" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".8"/>`;
 const nose=`<path d="M44.2 60.6 Q45 61.4 45.8 60.6" stroke="#d99a86" stroke-width="1" fill="none" stroke-linecap="round"/>`;
 const faces={
  Happy:`
   <path d="M27 56 Q33 47 39 56 M51 56 Q57 47 63 56" fill="none" stroke="${ink}" stroke-width="2.8" stroke-linecap="round"/>
   ${blush(.95)}${nose}
   <path d="M39.5 65 Q45 76 50.5 65Z" fill="#e8667f" stroke="${ink}" stroke-width="1.2" stroke-linejoin="round"/>
   <ellipse cx="45" cy="69.5" rx="3" ry="1.8" fill="#ff9bb0"/>`,
  Calm:`
   ${eye(33)}${eye(57)}
   <path d="M27 42.5 Q33 40.5 39 42 M51 42 Q57 40.5 63 42.5" fill="none" stroke="${brow}" stroke-width="1.4" stroke-linecap="round" opacity=".75"/>
   ${blush(.75)}${nose}
   <path d="M42 66.5 Q45 69 48 66.5" fill="none" stroke="#d65a74" stroke-width="1.8" stroke-linecap="round"/>`,
  Tired:`
   <path d="M27 54 Q33 59 39 54 M51 54 Q57 59 63 54" fill="none" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/>
   <path d="M27.5 53.5 l-2.2 1.6 M38.5 53.5 l2.2 1.6 M51.5 53.5 l-2.2 1.6 M62.5 53.5 l2.2 1.6" stroke="${ink}" stroke-width="1.3" stroke-linecap="round"/>
   <path d="M27 43.5 Q33 41 39 43 M51 43 Q57 41 63 43.5" fill="none" stroke="${brow}" stroke-width="1.5" stroke-linecap="round" opacity=".8"/>
   <path d="M28 61 Q33 63 38 61 M52 61 Q57 63 62 61" fill="none" stroke="#c9a0b8" stroke-width="1.1" stroke-linecap="round" opacity=".7"/>
   ${blush(.5)}${nose}
   <path d="M41.5 68 Q43.3 66 45 68 Q46.7 70 48.5 68" fill="none" stroke="#d65a74" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  Sad:`
   ${eye(33,7.8,true)}${eye(57,7.8,true)}
   <path d="M27 44 Q33 42.5 39 39 M63 44 Q57 42.5 51 39" fill="none" stroke="${brow}" stroke-width="1.5" stroke-linecap="round"/>
   <path d="M30 62 Q27 69 29 76 L34 76 Q35.5 69 33.5 62Z" fill="#a7e0fa" stroke="#5fb3e6" stroke-width="1" opacity=".95"/>
   <path d="M60 62 Q63 69 61 76 L56 76 Q54.5 69 56.5 62Z" fill="#a7e0fa" stroke="#5fb3e6" stroke-width="1" opacity=".95"/>
   ${blush(.55)}${nose}
   <path d="M41 70 Q45 65.5 49 70" fill="none" stroke="#d65a74" stroke-width="2" stroke-linecap="round"/>`,
  Anxious:`
   <path d="M27 41 Q33 39.5 39.5 38 M63 41 Q57 39.5 50.5 38" fill="none" stroke="${brow}" stroke-width="1.5" stroke-linecap="round"/>
   ${worried(33)}${worried(57)}
   ${blush(.5)}${nose}
   <path d="M40 69 Q42.5 66.5 45 69 Q47.5 71.5 50 69" fill="none" stroke="#d65a74" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
 };
 const extras={
  Happy:`${star(10,14,1.1,"#fff7b0")}${star(81,13,1.3,"#ffffff")}${heart(85,40,.9,"#ff7fa0")}${heart(5,40,.9,"#ff8fb0")}${star(84,78,.7,"#fff7b0")}${star(6,74,.6,"#ffffff")}`,
  Calm:`<circle cx="9" cy="22" r="3.2" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="16" cy="10" r="2" fill="none" stroke="#fff" stroke-width="1.6"/><circle cx="83" cy="26" r="2.6" fill="none" stroke="#fff" stroke-width="1.6"/>${star(80,12,.9,"#ffffff")}${heart(84,70,.7,"#ffb3c8")}`,
  Tired:`<text x="68" y="22" font-size="14" font-weight="900" fill="#7a5fc4" font-family="Trebuchet MS,sans-serif">Z</text><text x="77" y="12" font-size="10" font-weight="900" fill="#9b84dc" font-family="Trebuchet MS,sans-serif">z</text><circle cx="75" cy="64" r="4.2" fill="#fff" opacity=".75" stroke="#cdbdf5"/>${drop(11,36,.9)}`,
  Sad:`${star(10,12,.8,"#ffffff")}${star(82,16,.7,"#ffffff")}${drop(83,40,.7)}`,
  Anxious:`${drop(79,30,1.1)}${drop(11,34,.9)}<path d="M33 31 v6 M41 31 v7 M49 31 v7 M57 31 v6" stroke="#7b8bc4" stroke-width="1.6" stroke-linecap="round" opacity=".7"/><path d="M4 42 Q1 50 4 58 M86 42 Q89 50 86 58" fill="none" stroke="${ink}" stroke-width="1.5" stroke-linecap="round" opacity=".45"/>`
 };
 return `<svg viewBox="0 0 90 90" role="img" aria-label="${m.label}">
 <defs><clipPath id="${uid}"><circle cx="45" cy="45" r="41"/></clipPath></defs>
 <circle cx="45" cy="45" r="41" fill="${m.bg}"/>
 <g clip-path="url(#${uid})">
  <path d="M8 92 Q10 76 30 73 L60 73 Q80 76 82 92Z" fill="#eaa6a0" stroke="#d98a86" stroke-width="1"/>
  <path d="M33 73 L45 86 L57 73Z" fill="#fffdf8" stroke="#e6d4cc" stroke-width=".8"/>
  <path d="M42 80 L45 77 L48 80 L46 86 L44 86Z" fill="#4a5f8c"/>
  <path d="M30 73 Q31 80 28 90 M60 73 Q59 80 62 90" fill="none" stroke="#d98a86" stroke-width="1.2" stroke-linecap="round"/>
  <circle cx="22" cy="82" r="1.3" fill="#fff7ef"/><circle cx="68" cy="82" r="1.3" fill="#fff7ef"/>
 </g>
 <path d="M12 54 Q6 12 45 8 Q84 12 78 54 L79 70 Q70 77 63 68 L27 68 Q20 77 11 70Z" fill="${hairBack}"/>
 <path d="M39 70 L39 76 Q45 80 51 76 L51 70Z" fill="${m.skin}"/>
 <ellipse cx="45" cy="53" rx="25.5" ry="23" fill="${m.skin}" stroke="#e8b99a" stroke-width="1.1"/>
 ${faces[m.id]}
 ${glasses}
 <path d="M13 50 Q12 62 16 72 Q23 69 23 58 L23 46Z" fill="${hair}"/>
 <path d="M77 50 Q78 62 74 72 Q67 69 67 58 L67 46Z" fill="${hair}"/>
 <path d="M14 48 Q8 14 45 8 Q82 14 76 48 Q72 33 64 31 Q56 39 48 28 Q42 39 33 30 Q22 34 14 48Z" fill="${hair}"/>
 <path d="M44 9 Q38 -1 48.5 2 Q43.5 4 47 9.5" fill="none" stroke="${hair}" stroke-width="2.4" stroke-linecap="round"/>
 <path d="M24 17 Q45 7 66 17" fill="none" stroke="${hairHi}" stroke-width="3" stroke-linecap="round" opacity=".75"/>
 <path d="M29 26 Q36 22 43 24 M52 24 Q59 22 65 26" fill="none" stroke="${hairHi}" stroke-width="1.3" stroke-linecap="round" opacity=".7"/>
 <path d="M15 56 Q14.5 63 17 68" fill="none" stroke="${hairHi}" stroke-width="1.6" stroke-linecap="round" opacity=".7"/>
 <path d="M70 19 L64 14 L63 24Z M70 19 L77 15 L76 25Z" fill="#ff9fc0" stroke="#f0668f" stroke-width=".9" stroke-linejoin="round"/>
 <circle cx="70" cy="19.5" r="2.8" fill="#ff6f9f"/>
 ${extras[m.id]}
 </svg>`;
}
function renderMoods(){
 $("moods").innerHTML=moods.map(m=>`<button type="button" class="mood ${m.id===selectedMood?"selected":""}" data-mood="${m.id}">${girlSVG(m)}<span>${m.label}</span></button>`).join("");
 $("entryMood").innerHTML=moods.map(m=>`<option value="${m.id}">${m.label}</option>`).join("");
 $("entryMood").value=selectedMood;
 $("moods").querySelectorAll("[data-mood]").forEach(b=>b.addEventListener("click",()=>{
   selectedMood=b.dataset.mood;state.lastMood=selectedMood;saveSettings({lastMood:selectedMood});renderMoods();
 }));
}
function prepareDiary(){
 $("entryMood").value=selectedMood;
 $("entryDate").value=$("entryDate").value||today();
 $("entryBody").value=$("quickThought").value;
 go("diary-section");
 $("entryTitle").focus();
}

/* ---------- PET SVG ART: tampak samping, empat kaki, menghadap kiri (dibalik lewat CSS) ---------- */
function petSVG(kind){
 if(kind==="cat") return `
 <svg viewBox="0 0 110 88" aria-label="Mochi, kucing">
  <g class="body">
   <path d="M70 68 Q94 68 90 46" fill="none" stroke="#f0a050" stroke-width="7" stroke-linecap="round"/>
   <path d="M90.5 50 Q90.2 48 90 46.5" fill="none" stroke="#fff3df" stroke-width="7" stroke-linecap="round"/>
   <ellipse cx="55" cy="62" rx="19" ry="15" fill="#f6b46a"/>
   <ellipse cx="55" cy="66" rx="11" ry="9" fill="#fff3df"/>
   <ellipse cx="38" cy="62" rx="5" ry="8" fill="#f6b46a" transform="rotate(12 38 62)"/>
   <ellipse cx="72" cy="62" rx="5" ry="8" fill="#f6b46a" transform="rotate(-12 72 62)"/>
   <g class="legs"><ellipse cx="45" cy="75" rx="8" ry="4.2" fill="#fff3df"/></g>
   <g class="legs back"><ellipse cx="65" cy="75" rx="8" ry="4.2" fill="#fff3df"/></g>
   <path d="M30 36 L31 11 L47 24Z" fill="#f6b46a"/><path d="M34 31 L35 18 L43 25Z" fill="#ffb3c1"/>
   <path d="M63 24 L79 11 L80 36Z" fill="#f6b46a"/><path d="M67 25 L75 18 L76 31Z" fill="#ffb3c1"/>
   <ellipse cx="55" cy="42" rx="27" ry="22" fill="#f6b46a"/>
   <path d="M50 22 L51 29 M55 21 L55 28 M60 22 L59 29" stroke="#e08f45" stroke-width="2.6" stroke-linecap="round"/>
   <ellipse cx="55" cy="51" rx="9" ry="6" fill="#fff3df"/>
   <path d="M52.5 47.5 Q55 46 57.5 47.5 Q55 50.5 52.5 47.5Z" fill="#ff8fa8"/>
   <path d="M55 50 L55 52 Q52 55 49.5 52.5 M55 52 Q58 55 60.5 52.5" stroke="#8a4f45" stroke-width="1.4" fill="none" stroke-linecap="round"/>
   <ellipse cx="38" cy="51" rx="5" ry="3" fill="#ff8fa8" opacity=".6"/><ellipse cx="72" cy="51" rx="5" ry="3" fill="#ff8fa8" opacity=".6"/>
   <path d="M38 47 L30 45 M38 50 L30 51 M72 47 L80 45 M72 50 L80 51" stroke="#a07a68" stroke-width="1" stroke-linecap="round"/>
   <g class="open-eyes">
    <ellipse cx="43" cy="42" rx="4.3" ry="5.4" fill="#2b2024"/><circle cx="44.7" cy="40" r="2" fill="#fff"/><circle cx="41.6" cy="44.2" r="1" fill="#fff"/>
    <ellipse cx="67" cy="42" rx="4.3" ry="5.4" fill="#2b2024"/><circle cx="68.7" cy="40" r="2" fill="#fff"/><circle cx="65.6" cy="44.2" r="1" fill="#fff"/>
   </g>
   <g class="closed-eyes">
    <path d="M38.5 43 Q43 47.5 47.5 43 M62.5 43 Q67 47.5 71.5 43" stroke="#2b2024" stroke-width="2.3" fill="none" stroke-linecap="round"/>
   </g>
  </g>
 </svg>`;
 if(kind==="capy") return `
 <svg viewBox="0 0 110 88" aria-label="Coco, kapibara">
  <g class="body">
   <ellipse cx="55" cy="63" rx="25" ry="15" fill="#b98558"/>
   <ellipse cx="55" cy="67" rx="15" ry="9" fill="#e0bb90"/>
   <ellipse cx="33" cy="63" rx="5" ry="8" fill="#b98558" transform="rotate(12 33 63)"/>
   <ellipse cx="77" cy="63" rx="5" ry="8" fill="#b98558" transform="rotate(-12 77 63)"/>
   <g class="legs"><ellipse cx="42" cy="75.5" rx="8" ry="4.2" fill="#8c5f3a"/></g>
   <g class="legs back"><ellipse cx="68" cy="75.5" rx="8" ry="4.2" fill="#8c5f3a"/></g>
   <circle cx="31" cy="30" r="4.2" fill="#9a6a41"/><circle cx="31" cy="30.5" r="2.1" fill="#f5bdae"/>
   <circle cx="79" cy="30" r="4.2" fill="#9a6a41"/><circle cx="79" cy="30.5" r="2.1" fill="#f5bdae"/>
   <path d="M28 40 Q28 22 55 21 Q82 22 82 40 Q82 62 55 63 Q28 62 28 40Z" fill="#c89562"/>
   <path d="M35 44 Q35 36 55 36 Q75 36 75 44 Q75 63 55 63 Q35 63 35 44Z" fill="#e3bd92"/>
   <ellipse cx="49" cy="44" rx="2.8" ry="3.2" fill="#3b2a22"/><ellipse cx="61" cy="44" rx="2.8" ry="3.2" fill="#3b2a22"/>
   <path d="M55 49 L55 52 Q51 56 47.5 52.5 M55 52 Q59 56 62.5 52.5" stroke="#7a5035" stroke-width="1.5" fill="none" stroke-linecap="round"/>
   <rect x="53.6" y="54.5" width="2.8" height="3" rx=".8" fill="#fff6dc"/>
   <ellipse cx="35" cy="48" rx="5" ry="3" fill="#ff8fa8" opacity=".6"/><ellipse cx="75" cy="48" rx="5" ry="3" fill="#ff8fa8" opacity=".6"/>
   <g class="open-eyes">
    <ellipse cx="42" cy="36" rx="3.8" ry="4.6" fill="#33231d"/><circle cx="43.4" cy="34.3" r="1.7" fill="#fff"/><circle cx="40.8" cy="37.8" r=".8" fill="#fff"/>
    <ellipse cx="68" cy="36" rx="3.8" ry="4.6" fill="#33231d"/><circle cx="69.4" cy="34.3" r="1.7" fill="#fff"/><circle cx="66.8" cy="37.8" r=".8" fill="#fff"/>
   </g>
   <g class="closed-eyes">
    <path d="M38 37 Q42 41.5 46 37 M64 37 Q68 41.5 72 37" stroke="#33231d" stroke-width="2.2" fill="none" stroke-linecap="round"/>
   </g>
  </g>
 </svg>`;
 return `
 <svg viewBox="0 0 110 88" aria-label="Ruru, rakun">
  <defs><clipPath id="rcTail"><path d="M68 70 Q102 74 100 40 Q97 30 87 37 Q92 56 66 58Z"/></clipPath></defs>
  <g class="body">
   <path d="M68 70 Q102 74 100 40 Q97 30 87 37 Q92 56 66 58Z" fill="#a9b4c1"/>
   <g clip-path="url(#rcTail)">
    <path d="M78 30 L75 80" stroke="#5a6577" stroke-width="5"/>
    <path d="M87 30 L85 80" stroke="#5a6577" stroke-width="5"/>
    <path d="M96 30 L97 80" stroke="#5a6577" stroke-width="6"/>
   </g>
   <ellipse cx="55" cy="62" rx="19" ry="15" fill="#a3aebc"/>
   <ellipse cx="55" cy="66" rx="11" ry="9" fill="#dde3ea"/>
   <ellipse cx="38" cy="62" rx="5" ry="8" fill="#a3aebc" transform="rotate(12 38 62)"/>
   <ellipse cx="72" cy="62" rx="5" ry="8" fill="#a3aebc" transform="rotate(-12 72 62)"/>
   <g class="legs"><ellipse cx="45" cy="75.5" rx="8" ry="4.2" fill="#5a6577"/></g>
   <g class="legs back"><ellipse cx="65" cy="75.5" rx="8" ry="4.2" fill="#5a6577"/></g>
   <circle cx="34" cy="25" r="7" fill="#5a6577"/><circle cx="34" cy="26" r="3.4" fill="#f5b8c9"/>
   <circle cx="76" cy="25" r="7" fill="#5a6577"/><circle cx="76" cy="26" r="3.4" fill="#f5b8c9"/>
   <path d="M28 46 L21 50 L28 53 L23 59 L33 58Z" fill="#c9d2dc"/>
   <path d="M82 46 L89 50 L82 53 L87 59 L77 58Z" fill="#c9d2dc"/>
   <ellipse cx="55" cy="42" rx="28" ry="21" fill="#b9c3cf"/>
   <path d="M55 22 Q51 28 55 34 Q59 28 55 22Z" fill="#f6f1e8"/>
   <ellipse cx="42" cy="41" rx="10" ry="8" transform="rotate(-10 42 41)" fill="#6a7587"/>
   <ellipse cx="68" cy="41" rx="10" ry="8" transform="rotate(10 68 41)" fill="#6a7587"/>
   <ellipse cx="55" cy="52" rx="12" ry="8.5" fill="#f6f1e8"/>
   <ellipse cx="55" cy="47.5" rx="3.6" ry="2.7" fill="#2b2f3a"/>
   <path d="M55 50 L55 52.5 Q51.5 56 48 53 M55 52.5 Q58.5 56 62 53" stroke="#7a5a58" stroke-width="1.4" fill="none" stroke-linecap="round"/>
   <ellipse cx="38" cy="52" rx="4.5" ry="2.8" fill="#ff9aa8" opacity=".65"/><ellipse cx="72" cy="52" rx="4.5" ry="2.8" fill="#ff9aa8" opacity=".65"/>
   <g class="open-eyes">
    <ellipse cx="42" cy="41" rx="5" ry="5.6" fill="#fff"/><ellipse cx="42.3" cy="41.6" rx="3.6" ry="4.4" fill="#4a3329"/><circle cx="42.3" cy="41.8" r="2.2" fill="#1f2430"/><circle cx="43.8" cy="39.6" r="1.6" fill="#fff"/><circle cx="40.6" cy="43.8" r=".8" fill="#fff"/>
    <ellipse cx="68" cy="41" rx="5" ry="5.6" fill="#fff"/><ellipse cx="68.3" cy="41.6" rx="3.6" ry="4.4" fill="#4a3329"/><circle cx="68.3" cy="41.8" r="2.2" fill="#1f2430"/><circle cx="69.8" cy="39.6" r="1.6" fill="#fff"/><circle cx="66.6" cy="43.8" r=".8" fill="#fff"/>
   </g>
   <g class="closed-eyes">
    <path d="M37.5 41.5 Q42 46.5 46.5 41.5 M63.5 41.5 Q68 46.5 72.5 41.5" stroke="#f6f1e8" stroke-width="2.4" fill="none" stroke-linecap="round"/>
   </g>
  </g>
 </svg>`;
}
function makePet(kind,name,x,y){
 const el=document.createElement("div");
 el.className="pet";
 el.dataset.kind=kind;
 el.innerHTML=`<div class="sprite">${petSVG(kind)}</div><div class="petname">${name}</div>`;
 $("room").insertBefore(el,$("snacks-layer"));
 const p={kind,name,el,x,y,vx:0,vy:0,drag:false,turnCooldown:0};
 pets.push(p);
 positionPet(p);
 el.addEventListener("pointerdown",e=>startPetDrag(e,p));
 return p;
}
function positionPet(p){
 p.el.style.left=p.x+"px";p.el.style.top=p.y+"px";
}
function startPetDrag(e,p){
 if(sleeping)return;
 e.preventDefault();
 dragPet=p;p.drag=true;p.vx=0;p.vy=0;
 const startX=e.clientX,startY=e.clientY,px=p.x,py=p.y;
 p.el.setPointerCapture?.(e.pointerId);
 const move=ev=>{
  p.x=Math.max(0,Math.min($("room").clientWidth-p.el.offsetWidth,px+ev.clientX-startX));
  p.y=Math.max(0,Math.min($("room").clientHeight-p.el.offsetHeight,py+ev.clientY-startY));
  positionPet(p);
 };
 const up=ev=>{
  p.el.removeEventListener("pointermove",move);
  p.el.removeEventListener("pointerup",up);
  p.el.removeEventListener("pointercancel",up);
  p.drag=false;p.vy=0.5;dragPet=null;
  // Setelah dilepas, gravitasi akan membawa hewan ke lantai.
 };
 p.el.addEventListener("pointermove",move);
 p.el.addEventListener("pointerup",up);
 p.el.addEventListener("pointercancel",up);
}
const WALK_SPEED = 0.03; // px per ms (pelan)
function updatePets(dt){
 const room=$("room");
 if(!room.clientWidth)return; // halaman Little Room sedang tidak tampil
 const floor=room.clientHeight-88;
 for(const p of pets){
  if(p.drag)continue;
  if(sleeping||!walking){p.vx=0;}
  if(walking && !sleeping){
   p.turnCooldown=Math.max(0,p.turnCooldown-dt);
   if(p.turnCooldown<=0 && Math.random()<dt*0.0008){
    const r=Math.random();
    if(r<0.55){
     p.vx=0;p.turnCooldown=3500+Math.random()*4500; // berhenti cukup lama
    }else{
     const cur=Math.sign(p.vx);
     // sering berputar balik ke arah sebaliknya
     const dir=cur?(r<0.7?-cur:cur):(Math.random()<.5?-1:1);
     p.vx=dir*WALK_SPEED;
     p.turnCooldown=1500+Math.random()*1800;
    }
   }
  }
  p.vy+=0.00065*dt;
  p.y+=p.vy*dt;
  if(p.y>=floor){p.y=floor;p.vy=0;}
  p.x+=p.vx*dt;
  const maxX=room.clientWidth-p.el.offsetWidth;
  if(p.x<0){p.x=0;p.vx=Math.abs(p.vx);}
  if(p.x>maxX){p.x=maxX;p.vx=-Math.abs(p.vx);}
  if(p.vx!==0)p.el.classList.toggle("face-right",p.vx>0);
  p.el.classList.toggle("walk",walking&&Math.abs(p.vx)>.02);
  positionPet(p);
 }
}
function animationLoop(t){
 const dt=Math.min(32,lastTime? t-lastTime:16);
 lastTime=t;
 updatePets(dt);
 updateSnacks(dt);
 requestAnimationFrame(animationLoop);
}
function fitRoom(){
 const room=$("room");
 if(!room.clientWidth)return;
 const floor=room.clientHeight-88;
 for(const p of pets){
  p.x=Math.max(0,Math.min(p.x,room.clientWidth-p.el.offsetWidth));
  p.y=Math.max(0,Math.min(p.y,floor));
  positionPet(p);
 }
 for(const s of snacks){
  s.x=Math.max(0,Math.min(s.x,room.clientWidth-40));
  s.y=Math.max(0,Math.min(s.y,room.clientHeight-40));
  positionSnack(s);
 }
}

/* ---------- FOOD: jatuh ke lantai, baru dimakan jika DISERET ke hewan ---------- */
function snackSVG(type){
 if(type==="apple")return `<svg viewBox="0 0 40 40"><path d="M20 11Q13 5 8 13Q2 25 14 33Q19 36 21 31Q24 36 30 31Q39 19 31 12Q25 7 20 11Z" fill="#f46f75" stroke="#b74b5d" stroke-width="2"/><path d="M20 12Q18 6 23 3" stroke="#79533a" stroke-width="2.5" fill="none"/><path d="M22 7Q28 2 31 7Q27 12 22 7Z" fill="#6dbb78"/></svg>`;
 if(type==="cookie")return `<svg viewBox="0 0 40 40"><circle cx="20" cy="21" r="15" fill="#e6b36d" stroke="#bd8751" stroke-width="2"/><circle cx="13" cy="15" r="2.5" fill="#80503d"/><circle cx="25" cy="13" r="2.5" fill="#80503d"/><circle cx="27" cy="24" r="3" fill="#80503d"/><circle cx="16" cy="27" r="2.5" fill="#80503d"/></svg>`;
 if(type==="strawberry")return `<svg viewBox="0 0 40 40"><path d="M20 36Q5 26 7 16Q11 9 20 12Q29 9 33 16Q35 26 20 36Z" fill="#ff5a6e" stroke="#c93a52" stroke-width="2"/><path d="M11 12Q20 3 29 12Q20 9 11 12Z" fill="#5fbf73" stroke="#43a05a" stroke-width="1.5"/><circle cx="14" cy="19" r="1.3" fill="#ffe9a8"/><circle cx="21" cy="22" r="1.3" fill="#ffe9a8"/><circle cx="27" cy="18" r="1.3" fill="#ffe9a8"/><circle cx="17" cy="28" r="1.3" fill="#ffe9a8"/><circle cx="24" cy="29" r="1.3" fill="#ffe9a8"/></svg>`;
 if(type==="cheese")return `<svg viewBox="0 0 40 40"><path d="M4 28L28 8L36 22L36 32L4 34Z" fill="#ffd45e" stroke="#d9a62e" stroke-width="2" stroke-linejoin="round"/><path d="M4 28L36 22" stroke="#d9a62e" stroke-width="2"/><circle cx="14" cy="30" r="2.4" fill="#f2b93b"/><circle cx="26" cy="28" r="2" fill="#f2b93b"/><circle cx="25" cy="17" r="2" fill="#f2b93b"/></svg>`;
 if(type==="fish")return `<svg viewBox="0 0 40 40"><path d="M5 20Q15 7 28 20Q15 33 5 20Z" fill="#7fc4f0" stroke="#4a96c8" stroke-width="2"/><path d="M27 20L36 11L35 20L36 29Z" fill="#7fc4f0" stroke="#4a96c8" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="18" r="2" fill="#2b3a55"/><path d="M19 13Q21 20 19 27" stroke="#4a96c8" stroke-width="1.6" fill="none"/></svg>`;
 return `<svg viewBox="0 0 40 40"><path d="M10 18L34 12L27 29L10 18Z" fill="#ff9c56" stroke="#cf6d3c" stroke-width="2"/><path d="M11 18L6 10L15 15L17 7L22 14" fill="#6fbd7c" stroke="#4d9662" stroke-width="2" stroke-linejoin="round"/></svg>`;
}
function addSnack(type){
 const layer=$("snacks-layer"),room=$("room");
 const el=document.createElement("div");
 el.className="snack";el.innerHTML=snackSVG(type);
 layer.appendChild(el);
 const maxX=Math.max(0,room.clientWidth-42);
 const s={
  id:++snackId,type,el,
  x:Math.max(0,Math.min(maxX,room.clientWidth/2-20)),
  y:Math.max(0,room.clientHeight*.22),
  vx:0,vy:0,drag:false,eaten:false,settled:false,falling:true,moved:false
 };
 snacks.push(s);positionSnack(s);
 el.addEventListener("pointerdown",e=>startSnackDrag(e,s));
 $("snackStatus").textContent="Camilan muncul! Seret ke temanmu, lalu lepaskan supaya dimakan.";
}
function positionSnack(s){
 s.el.style.left=s.x+"px";s.el.style.top=s.y+"px";
}
function startSnackDrag(e,s){
 if(s.eaten)return;
 e.preventDefault();e.stopPropagation();
 dragSnack=s;s.drag=true;s.vx=0;s.vy=0;s.settled=false;s.moved=false;
 const startX=e.clientX,startY=e.clientY,px=s.x,py=s.y;
 try{s.el.setPointerCapture(e.pointerId)}catch{}
 const move=ev=>{
  if(s.eaten)return;
  s.x=Math.max(0,Math.min($("room").clientWidth-40,px+ev.clientX-startX));
  s.y=Math.max(0,Math.min($("room").clientHeight-40,py+ev.clientY-startY));
  s.moved=true;
  positionSnack(s);
  // Selama masih dipegang, camilan tidak dimakan.
 };
 const up=ev=>{
  s.el.removeEventListener("pointermove",move);
  s.el.removeEventListener("pointerup",up);
  s.el.removeEventListener("pointercancel",up);
  if(s.eaten)return;
  s.drag=false;dragSnack=null;
  // Baru dimakan setelah dilepas di atas hewan
  const target=pets.find(p=>!p.drag&&intersects(s,p));
  if(target){eatSnack(s,target);return;}
  s.vy=0.12;s.falling=true;s.settled=false;
 };
 s.el.addEventListener("pointermove",move);
 s.el.addEventListener("pointerup",up);
 s.el.addEventListener("pointercancel",up);
}
function intersects(a,b){
 return a.x < b.x+b.el.offsetWidth &&
 a.x+a.el.offsetWidth > b.x &&
 a.y < b.y+b.el.offsetHeight &&
 a.y+a.el.offsetHeight > b.y;
}
function updateSnacks(dt){
 const room=$("room");
 if(!room.clientWidth)return;
 const floor=room.clientHeight-49;
 for(const s of [...snacks]){
  if(s.eaten||s.drag)continue;
  if(s.falling){
   s.vy=Math.min(0.65,s.vy+0.0012*dt);
   s.y+=s.vy*dt;
  }
  s.x=Math.max(0,Math.min(room.clientWidth-40,s.x+s.vx*dt));
  if(s.y>=floor){
   s.y=floor;s.vy=0;s.falling=false;s.settled=true;
  }
  positionSnack(s);
  // Tidak ada pengecekan makan otomatis di sini: camilan harus diseret ke hewan.
 }
}
function eatSnack(s,p){
 if(!s||s.eaten)return;
 s.eaten=true;s.drag=false;s.falling=false;dragSnack=null;
 s.el.style.pointerEvents="none";
 s.el.remove();
 snacks=snacks.filter(x=>x!==s);
 p.el.classList.remove("walk");
 p.el.animate([
  {transform:"translateY(0) scale(1)"},
  {transform:"translateY(-4px) scale(1.06)"},
  {transform:"translateY(0) scale(1)"}
 ],{duration:420,easing:"ease-in-out"});
 $("snackStatus").textContent=p.name+" sedang menikmati "+s.type+"!";
 playTone(620,.1);
 setTimeout(()=>playTone(820,.12),120);
}
document.querySelectorAll("[data-snack]").forEach(b=>b.addEventListener("click",()=>addSnack(b.dataset.snack)));

$("walkBtn").addEventListener("click",()=>{
 walking=!walking;
 $("walkBtn").innerHTML=walking?"Let them<br>rest":"Let them<br>wander";
 $("walkBtn").classList.toggle("green",walking);
 pets.forEach(p=>{
  if(walking&&p.vx===0&&!sleeping){
   p.vx=(Math.random()<.5?-1:1)*WALK_SPEED;p.turnCooldown=2000;
  }
 });
});
$("sleepBtn").addEventListener("click",()=>{
 sleeping=!sleeping;
 $("room").classList.toggle("night",sleeping);
 $("room").classList.toggle("sleeping-room",sleeping);
 $("sleepBtn").innerHTML=sleeping?"Wake them up":"Sleepy<br>time";
 $("room").querySelectorAll(".pet").forEach(p=>p.classList.toggle("sleeping",sleeping));
 if(sleeping){walking=false;$("walkBtn").innerHTML="Let them<br>wander";$("walkBtn").classList.remove("green");}
 $("snackStatus").textContent=sleeping?"Shhh... semuanya sedang tidur.":"Teman-temanmu sudah bangun.";
});

/* ---------- SOUND: nada buatan browser, tanpa file luar ---------- */
function ensureAudio(){
 if(!audioCtx){
  const AC=window.AudioContext||window.webkitAudioContext;
  if(!AC)return null;
  audioCtx=new AC();
 }
 if(audioCtx.state==="suspended")audioCtx.resume();
 return audioCtx;
}
function playTone(freq,duration=.15,type="sine",vol=.045){
 const ctx=ensureAudio();if(!ctx)return;
 const osc=ctx.createOscillator(),gain=ctx.createGain();
 osc.type=type;osc.frequency.value=freq;
 gain.gain.setValueAtTime(.0001,ctx.currentTime);
 gain.gain.exponentialRampToValueAtTime(vol,ctx.currentTime+.025);
 gain.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+duration);
 osc.connect(gain);gain.connect(ctx.destination);
 osc.start();osc.stop(ctx.currentTime+duration+.02);
}

/* ---------- MUSIK LATAR: aktif di seluruh halaman ---------- */
const melody=[523.25,659.25,783.99,659.25, 587.33,698.46,880,698.46, 523.25,659.25,783.99,1046.5, 880,783.99,659.25,587.33];
const bassLine=[130.81,146.83,174.61,196.00];
function musicTick(){
 const i=musicStepIdx++;
 playTone(melody[i%melody.length],.4,"triangle",.05);
 if(i%4===0)playTone(bassLine[Math.floor(i/4)%bassLine.length],1.6,"sine",.06);
}
function updateMusicUI(){
 $("musicBtn").innerHTML=musicOn?"Stop cozy<br>music":"Play cozy<br>music";
 $("musicFab").textContent=musicOn?"♪ Musik On":"♪ Musik Off";
 $("musicFab").classList.toggle("on",musicOn);
 $("musicFab").setAttribute("aria-pressed",String(musicOn));
}
function setMusic(on){
 musicOn=on;
 clearInterval(musicTimer);
 if(on){
  ensureAudio();
  musicStepIdx=0;
  musicTick();
  musicTimer=setInterval(musicTick,520);
 }
 updateMusicUI();
}
function toggleMusic(){
 userMuted=musicOn;   // jika dimatikan manual, jangan dinyalakan otomatis lagi
 setMusic(!musicOn);
}
$("musicBtn").addEventListener("click",toggleMusic);
$("musicFab").addEventListener("click",toggleMusic);
// Browser memblokir suara sebelum ada interaksi, jadi musik otomatis menyala pada sentuhan/klik pertama.
function firstInteraction(e){
 document.removeEventListener("click",firstInteraction,true);
 document.removeEventListener("keydown",firstInteraction,true);
 if(e.target&&e.target.closest&&e.target.closest("#musicBtn,#musicFab"))return;
 if(!userMuted&&!musicOn)setMusic(true);
}
document.addEventListener("click",firstInteraction,true);
document.addEventListener("keydown",firstInteraction,true);

/* ---------- DIARY ---------- */
$("entryDate").value=today();
$("diaryForm").addEventListener("submit",async e=>{
 e.preventDefault();
 const date=$("entryDate").value;
 const entry={
  date,title:$("entryTitle").value.trim(),
  mood:$("entryMood").value,body:$("entryBody").value.trim(),
  gratitude:$("entryGratitude").value.trim(),song:$("entrySong").value.trim()
 };
 if(!date||!entry.title||!entry.body){$("saveStatus").textContent="Tanggal, judul, dan cerita perlu diisi.";return;}
 try{
  const r=await api("POST","/api/entries",entry);
  const saved=r.entry,i=state.entries.findIndex(x=>x.id===saved.id);
  if(i>=0)state.entries[i]=saved;else state.entries.push(saved);
  state.entries.sort((a,b)=>b.date.localeCompare(a.date));
  state.lastMood=saved.mood;selectedMood=saved.mood;
  renderMoods();renderEntries();renderGarden();
  $("saveStatus").textContent="Cerita tersimpan. Satu hari baru sudah dirawat di tamanmu!";
  $("quickThought").value="";
 }catch(err){$("saveStatus").textContent=err.message;}
});
$("clearForm").addEventListener("click",()=>{
 $("diaryForm").reset();$("entryDate").value=today();$("entryMood").value=selectedMood;
 $("saveStatus").textContent="Form dikosongkan.";
});
function renderEntries(){
 const q=$("searchEntries").value.toLowerCase().trim();
 const found=state.entries.filter(e=>[e.date,e.title,e.body,e.mood,e.gratitude,e.song].join(" ").toLowerCase().includes(q));
 $("entries").innerHTML=found.length?found.map(e=>`
  <article class="entry">
   <div class="section-title"><b>${escapeHTML(e.title)}</b><span class="small">${e.date}</span></div>
   <p class="small">Mood: ${escapeHTML(e.mood||"Calm")}</p>
   <p>${escapeHTML(e.body)}</p>
   ${e.gratitude?`<p class="small">♡ Syukur: ${escapeHTML(e.gratitude)}</p>`:""}
   ${e.song?`<p class="small">♫ ${escapeHTML(e.song)}</p>`:""}
   <button class="pill" data-edit="${escapeHTML(e.id)}">Edit</button>
   <button class="pill" data-delete="${escapeHTML(e.id)}">Delete</button>
  </article>`).join(""):`<p class="small">Belum ada cerita yang cocok. Mulai tulis satu kenangan kecil hari ini.</p>`;
 $("entries").querySelectorAll("[data-edit]").forEach(b=>b.addEventListener("click",()=>{
  const e=state.entries.find(x=>x.id===b.dataset.edit);if(!e)return;
  $("entryDate").value=e.date;$("entryTitle").value=e.title;$("entryMood").value=e.mood;
  $("entryBody").value=e.body;$("entryGratitude").value=e.gratitude||"";$("entrySong").value=e.song||"";
  go("diary-section");$("entryTitle").focus();
 }));
 $("entries").querySelectorAll("[data-delete]").forEach(b=>b.addEventListener("click",async()=>{
  const id=b.dataset.delete,e=state.entries.find(x=>x.id===id);if(!e)return;
  if(!confirm("Hapus diary tanggal "+e.date+"?"))return;
  try{
   await api("DELETE","/api/entries/"+encodeURIComponent(id));
   state.entries=state.entries.filter(x=>x.id!==id);
   renderEntries();renderGarden();
  }catch(err){$("saveStatus").textContent=err.message;}
 }));
}
function escapeHTML(s){
 return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
$("searchEntries").addEventListener("input",renderEntries);

/* ---------- WEEKLY GROWING FLOWERS ---------- */
const flowers=[
 {name:"Daisy Dream",petal:"#fff8ee",center:"#ffcf59",leaf:"#63b982"},
 {name:"Pink Cosmos",petal:"#ff94b9",center:"#ffe17a",leaf:"#56b67e"},
 {name:"Sunny Tulip",petal:"#ffad65",center:"#ffd86f",leaf:"#55aa79"},
 {name:"Bluebell",petal:"#a6c4ff",center:"#fff0b5",leaf:"#4fb58c"},
 {name:"Lavender Bloom",petal:"#c9a8ff",center:"#ffdf85",leaf:"#65ae7a"}
];
function flowerSVG(stage,flower,small=false){
 const width=small?70:180;
 if(stage===0)return `<svg viewBox="0 0 100 100"><ellipse cx="50" cy="79" rx="35" ry="10" fill="#cda77e"/><path d="M18 79Q29 69 40 78T62 77T82 78" fill="none" stroke="#ae845d" stroke-width="3"/><circle cx="50" cy="73" r="2" fill="#916849"/></svg>`;
 let stem=stage>=2?`<path d="M50 79 Q48 59 50 37" fill="none" stroke="${flower.leaf}" stroke-width="4" stroke-linecap="round"/><path d="M49 63 Q31 48 28 61 Q39 72 49 66 M50 55 Q66 39 72 49 Q66 61 50 58" fill="${flower.leaf}" stroke="#4c9c70" stroke-width="1.5"/>`:"";
 let bud=stage===1?`<path d="M50 80L50 67" stroke="${flower.leaf}" stroke-width="4" stroke-linecap="round"/><path d="M50 68Q33 59 44 47Q50 39 56 47Q67 59 50 68Z" fill="${flower.leaf}" stroke="#4c9c70" stroke-width="1.5"/>`:"";
 let closed=stage===2?`<path d="M50 40Q30 31 41 16Q50 8 59 16Q70 31 50 40Z" fill="${flower.petal}" stroke="#d99ca7" stroke-width="1.5"/>`:"";
 let open=stage>=3?Array.from({length:8},(_,i)=>`<ellipse cx="50" cy="24" rx="8" ry="15" transform="rotate(${i*45} 50 39)" fill="${flower.petal}" stroke="#e8b2ad" stroke-width="1"/>`).join("")+`<circle cx="50" cy="39" r="9" fill="${flower.center}" stroke="#d4a34b" stroke-width="1.5"/>`:"";
 return `<svg viewBox="0 0 100 100" role="img" aria-label="${stage===3?"Bunga mekar":"Tanaman tumbuh"}">${stem}${bud}${closed}${open}<ellipse cx="50" cy="84" rx="24" ry="6" fill="#d5b58a" opacity=".6"/></svg>`;
}
function growthStage(date){
 const d=new Date(date+"T12:00:00");
 const start=new Date(d.getFullYear(),0,1);
 const day=Math.floor((d-start)/86400000);
 return day%7;
}
function renderGarden(){
 const dates=[...new Set(state.entries.map(e=>e.date))].sort();
 const count=dates.length;
 const now=today(),dayIndex=Math.floor((new Date(now+"T12:00:00")-new Date(new Date(now+"T12:00:00").getFullYear(),0,1))/86400000);
 const stage=dayIndex%7;
 const flower=flowers[Math.floor(dayIndex/7)%flowers.length];
 const weekDates=dates.filter(d=>{
  const di=Math.floor((new Date(d+"T12:00:00")-new Date(new Date(d+"T12:00:00").getFullYear(),0,1))/86400000);
  return Math.floor(di/7)===Math.floor(dayIndex/7);
 });
 const progress=Math.min(7,weekDates.length);
 $("gardenProgress").textContent=progress+"/7 diary days this week";
 $("gardenMeter").style.width=(progress/7*100)+"%";
 $("mainFlower").innerHTML=flowerSVG(progress===0?0:Math.min(3,Math.floor(progress*4/7)),flower);
 const captions=["The soil is waiting for your first story.","A tiny sprout says hello.","Your little plant is reaching for the sun.","A little bud is getting ready.","Keep writing, little by little.","Almost time to bloom!","Your flower is ready to bloom!"];
 $("flowerCaption").textContent=progress===0?captions[0]:captions[progress];
 const start=new Date(now+"T12:00:00");start.setDate(start.getDate()-6);
 const calendar=[];
 for(let i=0;i<28;i++){
  const d=new Date(start);d.setDate(start.getDate()+i);
  const date=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const entry=state.entries.find(e=>e.date===date);
  const di=Math.floor((d-new Date(d.getFullYear(),0,1))/86400000);
  const fl=flowers[Math.floor(di/7)%flowers.length];
  const stage=entry?Math.min(3,Math.floor((di%7+1)*4/7)):0;
  calendar.push(`<div class="garden-cell" title="${date}${entry?" — diary saved":""}">${flowerSVG(stage,fl,true)}<small>${d.getDate()}</small></div>`);
 }
 $("gardenGrid").innerHTML=calendar.join("");
}

/* ---------- MEMORY JAR & FUTURE LETTER ---------- */
function renderMemories(){
 $("memoryList").innerHTML=state.memories.length?state.memories.slice().reverse().map(m=>`
 <article class="entry"><p>${escapeHTML(m.text)}</p><div class="small">${escapeHTML(m.date)}</div>
 <button class="pill" data-memdelete="${escapeHTML(m.id)}">Remove</button></article>`).join(""):"<p class='small'>Jar-mu masih kosong. Masukkan kenangan pertamamu.</p>";
 $("memoryList").querySelectorAll("[data-memdelete]").forEach(b=>b.addEventListener("click",async()=>{
  const id=b.dataset.memdelete;
  try{
   await api("DELETE","/api/memories/"+encodeURIComponent(id));
   state.memories=state.memories.filter(x=>x.id!==id);renderMemories();
  }catch(err){$("memoryStatus").textContent=err.message;}
 }));
}
$("addMemory").addEventListener("click",async()=>{
 const text=$("memoryText").value.trim();if(!text)return;
 try{
  const r=await api("POST","/api/memories",{text,date:today()});
  state.memories.push(r.memory);$("memoryText").value="";$("memoryStatus").textContent="";renderMemories();
 }catch(err){$("memoryStatus").textContent=err.message;}
});
$("saveLetter").addEventListener("click",async()=>{
 try{
  const letter=$("futureLetter").value;
  await api("PUT","/api/settings",{letter});
  state.letter=letter;$("letterStatus").textContent="Surat untuk dirimu nanti sudah disimpan.";
 }catch(err){$("letterStatus").textContent=err.message;}
});

/* ---------- BACKUP (hanya data milik akun yang sedang masuk) ---------- */
function needUnlock(){
 if(!unlocked){$("privacyStatus").textContent="Buka kunci diary dulu untuk memakai fitur ini.";return true;}
 return false;
}
$("exportBtn").addEventListener("click",async()=>{
 if(needUnlock())return;
 try{
  const data=await api("GET","/api/export");
  saveBlob(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}),"my-little-diary-backup.json");
  $("privacyStatus").textContent="Backup diunduh.";
 }catch{$("privacyStatus").textContent="Gagal mengunduh backup.";}
});
$("importFile").addEventListener("click",e=>{if(needUnlock())e.preventDefault();});
$("importFile").addEventListener("change",async e=>{
 if(needUnlock()){e.target.value="";return;}
 const file=e.target.files?.[0];if(!file)return;
 try{
  if(file.size>3*1024*1024)throw new Error("File backup terlalu besar.");
  let data;try{data=JSON.parse(await file.text());}catch{throw new Error("File backup tidak valid atau tidak bisa dibaca.");}
  if(!confirm("Import akan mengganti data diary di akunmu. Lanjutkan?"))return;
  const r=await api("POST","/api/import",data);
  await loadData();
  $("privacyStatus").textContent=`Backup berhasil diimpor (${r.imported.entries} diary, ${r.imported.memories} kenangan${r.skipped?`, ${r.skipped} dilewati karena tidak valid`:""}).`;
 }catch(err){$("privacyStatus").textContent=err.message||"Gagal mengimpor backup.";}
 e.target.value="";
});

/* ---------- KUNCI DIARY (PIN) ---------- */
$("pinBtn").addEventListener("click",async()=>{
 if(needUnlock())return;
 let current;
 if(hasPin){current=await askSecret("PIN lama","Masukkan PIN lama kamu");if(current===null)return;}
 const pin=await askSecret(hasPin?"PIN baru":"Buat PIN","Gunakan 4-8 digit angka");if(pin===null)return;
 try{await api("POST","/api/pin",{current,pin});hasPin=true;$("privacyStatus").textContent="PIN disimpan di akunmu.";}
 catch(err){$("privacyStatus").textContent=err.message;}
});
$("lockBtn").addEventListener("click",async()=>{
 if(!unlocked){$("privacyStatus").textContent="Diary sudah terkunci.";return;}
 if(!hasPin){$("privacyStatus").textContent="Buat PIN dulu dengan tombol Set diary PIN.";return;}
 try{await api("POST","/api/lock");applyLock(true);}
 catch(err){if(err.status!==423)$("privacyStatus").textContent=err.message;}
});
$("unlockBtn").addEventListener("click",async()=>{
 if(unlocked){$("privacyStatus").textContent="Diary sudah terbuka.";return;}
 const pin=await askSecret("Buka kunci diary","Masukkan PIN diary kamu");if(pin===null)return;
 try{
  await api("POST","/api/unlock",{pin});
  applyLock(false,true);await loadData();
  $("privacyStatus").textContent="Diary dibuka kembali.";
 }catch(err){$("privacyStatus").textContent=err.message;}
});

/* ---------- MONTHLY RECAP ---------- */
const MONTHS=["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];
const MOOD_COLOR={Happy:"#ffd54f",Calm:"#7fd0ea",Tired:"#b79cf5",Sad:"#7fb2f5",Anxious:"#ffab6b"};
const RECAP_PAL={
 Happy:{a:"#ffe9a8",b:"#ffc9da",c:"#f0709a"},
 Calm:{a:"#c7ecf8",b:"#e6f6dd",c:"#4fb0d0"},
 Tired:{a:"#e4d8ff",b:"#fde4f1",c:"#9078dc"},
 Sad:{a:"#cfe6ff",b:"#ebf0fd",c:"#5f95dc"},
 Anxious:{a:"#ffe0c4",b:"#fff3da",c:"#ee8f4f"}
};
const RECAP_TITLE={
 Happy:"Si Matahari Kecil",
 Calm:"Penjaga Ketenangan",
 Tired:"Pejuang yang Butuh Peluk",
 Sad:"Hujan yang Tumbuh Jadi Pelangi",
 Anxious:"Penakluk Badai Pikiran"
};
const QUOTES={
 Happy:[
  "Bahagiamu bulan ini seperti matahari kecil: hangat untukmu dan orang-orang di sekitarmu.",
  "Simpan tawa hari ini. Suatu hari ia jadi obat paling manis.",
  "Kamu tidak perlu alasan besar untuk bersinar. Hal kecil pun cukup.",
  "Terus kumpulkan hari-hari baik, satu halaman demi satu halaman.",
  "Senyummu bulan ini sudah mekar. Rawat terus, ya.",
  "Bersyukur itu seperti menyiram bunga: pelan, tapi hasilnya indah."
 ],
 Calm:[
  "Tenang bukan berarti diam. Tenang berarti kamu tahu ke mana harus melangkah.",
  "Napas pelan, hati lapang. Kamu sudah melakukan yang terbaik.",
  "Air yang tenang justru memantulkan langit paling jernih.",
  "Boleh berjalan pelan, asal tidak berhenti percaya pada dirimu.",
  "Damai itu pilihan, dan bulan ini kamu memilihnya berkali-kali.",
  "Pelan-pelan juga sampai. Dan kamu sedang menuju ke sana."
 ],
 Tired:[
  "Lelah itu tanda kamu sudah berusaha. Istirahat bukan menyerah.",
  "Boleh rebahan dulu. Dunia bisa menunggu satu napas panjang.",
  "Bintang pun beristirahat di siang hari, tapi ia tetap bersinar.",
  "Hari ini cukup. Besok kita mulai lagi dengan langkah kecil.",
  "Tubuhmu bukan mesin. Peluk dirimu, lalu tidur yang nyenyak.",
  "Kamu hebat sudah sampai sini. Isi ulang energimu, ya."
 ],
 Sad:[
  "Hujan membuat bunga tumbuh. Air matamu juga bisa begitu.",
  "Tidak apa-apa menangis. Itu cara hati mencuci jendelanya.",
  "Rasa sedih hanyalah tamu: datang, lalu pergi. Kamu tetap tuan rumahnya.",
  "Kamu sudah kuat melewati hari-hari berat. Peluk jauh untukmu.",
  "Langit mendung tak selamanya. Matahari kecilmu akan kembali.",
  "Sembuh pelan-pelan juga sebuah kemajuan, lho."
 ],
 Anxious:[
  "Satu napas, satu langkah. Kamu tidak harus menyelesaikan semuanya hari ini.",
  "Pikiran yang ribut bukan fakta. Kamu lebih tenang dari yang kamu kira.",
  "Gelisah tandanya kamu peduli. Sekarang, peluk dirimu sebentar.",
  "Badai di kepala akan reda. Kamu sudah sering melewatinya.",
  "Fokus pada yang bisa kamu pegang hari ini. Sisanya serahkan pada waktu.",
  "Kamu aman, kamu cukup, kamu sedang berproses."
 ]
};
const PEARLS=[
 "Sebutir pasir sabar bisa menjadi mutiara bila kamu mau menunggu.",
 "Hidup bukan perlombaan. Bunga pun mekar di waktunya sendiri.",
 "Menulis hari ini adalah hadiah untuk dirimu di masa depan.",
 "Kebaikan kecil yang konsisten lebih kuat dari seribu niat besar.",
 "Jangan bandingkan bab awalmu dengan bab tengah orang lain.",
 "Syukur adalah cara paling murah untuk merasa kaya.",
 "Setiap hari adalah halaman baru, dan penanya ada di tanganmu.",
 "Yang tumbuh pelan biasanya berakar paling dalam.",
 "Berani memulai sudah separuh perjalanan.",
 "Cahaya sekecil apa pun mengusir gelap, asal ia mau menyala.",
 "Kenangan manis dimulai dari hari biasa yang kamu rawat.",
 "Kamu adalah rumah bagi semua hal baik yang kamu percayai."
];
const PET_LINES={
 cat:["Meong~ kamu menulis, aku jaga selimutnya.","Aku bangga! Boleh minta ikan sebagai bonus?","Purr purr, kamu keren banget!","Aku tidur dulu ya, mimpiin kamu."],
 capy:["Santai aja, kita rendam diri dulu.","Aku kasih pelukan hangat 100 persen.","Pelan-pelan, aku selalu di sini.","Semua masalah bisa dibawa santai."],
 raccoon:["Kucuri semua rasa lelahmu ya!","Kucuci bersih semua kekhawatiranmu.","Camilan dulu, baru semangat!","Kamu sudah mencuri hati kami."]
};
const pStar=(x,y,s,c)=>`<path transform="translate(${x} ${y}) scale(${s})" d="M0 -8 L2 -2 L8 0 L2 2 L0 8 L-2 2 L-8 0 L-2 -2Z" fill="${c}"/>`;
const pHeart=(x,y,s,c)=>`<path transform="translate(${x} ${y}) scale(${s})" d="M0 4 C-10 -3 -5 -10 0 -4 C5 -10 10 -3 0 4Z" fill="${c}"/>`;

function monthLabel(key){const [y,m]=key.split("-").map(Number);return MONTHS[m-1]+" "+y;}
function recapData(key){
 const [y,m]=key.split("-").map(Number);
 const days=new Date(y,m,0).getDate();
 const ents=state.entries.filter(e=>String(e.date).startsWith(key+"-"));
 const byDay={};ents.forEach(e=>{byDay[parseInt(String(e.date).slice(8,10),10)]=e;});
 const count={};moods.forEach(mm=>count[mm.id]=0);
 ents.forEach(e=>{if(count[e.mood]!==undefined)count[e.mood]++;});
 let dominant="Calm",best=-1;
 moods.forEach(mm=>{if(count[mm.id]>best){best=count[mm.id];dominant=mm.id;}});
 if(!ents.length)dominant="Calm";
 let streak=0,cur=0;
 for(let d=1;d<=days;d++){if(byDay[d]){cur++;streak=Math.max(streak,cur);}else cur=0;}
 const gratitudes=ents.filter(e=>e.gratitude).map(e=>e.gratitude);
 const songCount={};ents.forEach(e=>{if(e.song)songCount[e.song]=(songCount[e.song]||0)+1;});
 const songs=Object.entries(songCount).sort((a,b)=>b[1]-a[1]).slice(0,3).map(x=>x[0]);
 const jar=state.memories.filter(mm=>String(mm.date).startsWith(key+"-")).length;
 return {key,y,m,days,ents,byDay,count,dominant,streak,gratitudes,songs,jar,written:ents.length};
}
function wrapText(t,max,maxLines){
 const words=String(t).trim().split(/\s+/).flatMap(w=>{
  const out=[];while(w.length>max){out.push(w.slice(0,max));w=w.slice(max);}out.push(w);return out;
 });
 const lines=[];let cur="";
 for(const w of words){
  if((cur?cur+" "+w:w).length>max){if(cur)lines.push(cur);cur=w;}
  else cur=cur?cur+" "+w:w;
 }
 if(cur)lines.push(cur);
 if(lines.length>maxLines){
  lines.length=maxLines;
  const last=lines[maxLines-1];
  lines[maxLines-1]=(last.length>max-1?last.slice(0,max-1):last)+"…";
 }
 return lines;
}
const tspans=(lines,x,dy)=>lines.map((l,i)=>`<tspan x="${x}" dy="${i?dy:0}">${escapeHTML(l)}</tspan>`).join("");
const nestSVG=(markup,x,y,w,h)=>markup.trim().replace("<svg ",`<svg x="${x}" y="${y}" width="${w}" height="${h}" `);
const petForPoster=kind=>petSVG(kind).replace(/<g class="closed-eyes">[\s\S]*?<\/g>/,"");

function recapSVG(key){
 const d=recapData(key),W=540,H=1190,ink="#59404a";
 const pal=RECAP_PAL[d.dominant];
 const mood=moods.find(x=>x.id===d.dominant);
 const seed=d.y*12+d.m;
 const pick=(arr,o=0)=>arr[(seed+o)%arr.length];
 const title=d.written?RECAP_TITLE[d.dominant]:"Penjelajah yang Sedang Beristirahat";
 const titleLines=wrapText(title,19,2);
 let badges=[];
 if(d.streak>=7)badges.push("Api Semangat "+d.streak+" hari");
 if(d.written>=15)badges.push("Penulis Rajin");
 if(d.gratitudes.length>=5)badges.push("Pemburu Syukur");
 if(d.jar>=3)badges.push("Penjaga Toples");
 if(!badges.length)badges.push(d.written?"Langkah Kecil Berarti":"Bulan Istirahat");
 badges=badges.slice(0,2);
 let bx=206;
 const badgeSVG=badges.map(b=>{
  const w=Math.round(b.length*6.4+22),s=`<rect x="${bx}" y="${titleLines.length>1?286:262}" width="${w}" height="24" rx="12" fill="${pal.a}" stroke="${pal.c}" stroke-width="1.4"/><text x="${bx+w/2}" y="${(titleLines.length>1?286:262)+16}" text-anchor="middle" font-size="11" font-weight="800" fill="${ink}">${escapeHTML(b)}</text>`;
  bx+=w+8;return s;
 }).join("");
 const card=(x,y,w,h,big,label)=>`<rect x="${x}" y="${y+4}" width="${w}" height="${h}" rx="22" fill="${pal.c}" opacity=".22"/><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="#fffdf8" opacity=".95"/><text x="${x+w/2}" y="${y+36}" text-anchor="middle" font-size="26" font-weight="900" fill="${pal.c}">${big}</text><text x="${x+w/2}" y="${y+56}" text-anchor="middle" font-size="11" font-weight="700" fill="${ink}" opacity=".8">${label}</text>`;
 // kalender mood
 const first=new Date(d.y,d.m-1,1).getDay();
 let cal="";
 ["M","S","S","R","K","J","S"].forEach((l,i)=>{cal+=`<text x="${58+i*28}" y="486" text-anchor="middle" font-size="9" font-weight="800" fill="${ink}" opacity=".55">${l}</text>`;});
 for(let day=1;day<=d.days;day++){
  const idx=first+day-1,col=idx%7,row=Math.floor(idx/7);
  const x=46+col*28,y=494+row*28,e=d.byDay[day];
  const fill=e&&MOOD_COLOR[e.mood]?MOOD_COLOR[e.mood]:"#f6e9d9";
  cal+=`<rect x="${x}" y="${y}" width="24" height="24" rx="8" fill="${fill}"/><text x="${x+12}" y="${y+16}" text-anchor="middle" font-size="10" font-weight="800" fill="${e?ink:"#c9b49c"}">${day}</text>`;
 }
 const maxC=Math.max(1,...Object.values(d.count));
 let bars="";
 moods.forEach((mm,i)=>{
  const y=478+i*42,c=d.count[mm.id],w=Math.round(c/maxC*170);
  bars+=`<circle cx="292" cy="${y+8}" r="7" fill="${MOOD_COLOR[mm.id]}"/><text x="306" y="${y+12}" font-size="12" font-weight="800" fill="${ink}">${mm.label}</text><rect x="306" y="${y+20}" width="170" height="9" rx="4.5" fill="#f3e6d6"/>${c?`<rect x="306" y="${y+20}" width="${Math.max(9,w)}" height="9" rx="4.5" fill="${MOOD_COLOR[mm.id]}"/>`:""}<text x="496" y="${y+29}" text-anchor="end" font-size="11" font-weight="800" fill="${ink}">${c}x</text>`;
 });
 const grat=d.gratitudes.length?d.gratitudes.slice(0,3).join("  ·  "):"Belum ada catatan syukur. Bulan depan kita isi yuk!";
 const gratLines=wrapText(grat,56,2);
 const songTxt=d.songs.length?d.songs.join("  ·  "):"Belum ada lagu yang menemani";
 const songLines=wrapText(songTxt,40,1);
 const quote=pick(QUOTES[d.dominant],d.written);
 const quoteLines=wrapText(quote,36,4);
 const pearl=pick(PEARLS,3);
 const pearlLines=wrapText(pearl,38,2);
 const petKinds=["cat","capy","raccoon"];
 let pets="";
 petKinds.forEach((k,i)=>{
  const x0=30+i*165,line=wrapText(pick(PET_LINES[k],i+d.written),24,2);
  pets+=`<rect x="${x0}" y="1062" width="150" height="40" rx="14" fill="#fff" stroke="${pal.c}" stroke-width="1.6"/><path d="M${x0+66} 1102 L${x0+75} 1112 L${x0+84} 1102Z" fill="#fff" stroke="${pal.c}" stroke-width="1.6"/><rect x="${x0+60}" y="1100" width="30" height="3" fill="#fff"/><text x="${x0+75}" y="1078" text-anchor="middle" font-size="10" font-weight="700" fill="${ink}">${tspans(line,x0+75,14)}</text>${nestSVG(petForPoster(k),x0+42,1112,66,53)}`;
 });
 return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Trebuchet MS,Segoe UI,Arial,sans-serif">
 <defs>
  <linearGradient id="rbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${pal.a}"/><stop offset="1" stop-color="${pal.b}"/></linearGradient>
  <pattern id="rdots" width="26" height="26" patternUnits="userSpaceOnUse"><circle cx="6" cy="6" r="2" fill="#fff" opacity=".75"/><circle cx="19" cy="19" r="2" fill="${pal.c}" opacity=".22"/></pattern>
 </defs>
 <rect width="${W}" height="${H}" fill="url(#rbg)"/><rect width="${W}" height="${H}" fill="url(#rdots)"/>
 <rect x="14" y="14" width="${W-28}" height="${H-28}" rx="34" fill="none" stroke="#fff" stroke-width="5" stroke-dasharray="1 11" stroke-linecap="round"/>
 ${pStar(46,52,1.3,"#fff")}${pStar(496,60,1,"#fff")}${pHeart(486,112,1,pal.c)}${pHeart(52,118,.9,pal.c)}${pStar(470,30,.7,pal.c)}
 <text x="270" y="62" text-anchor="middle" font-size="13" font-weight="800" letter-spacing="5" fill="${pal.c}">MONTHLY RECAP</text>
 <text x="270" y="112" text-anchor="middle" font-size="44" font-weight="900" fill="${ink}">${MONTHS[d.m-1]} ${d.y}</text>
 <text x="270" y="138" text-anchor="middle" font-size="13" fill="${ink}" opacity=".7">My Little Diary · rekap kenangan bulananmu</text>
 <rect x="30" y="161" width="480" height="168" rx="32" fill="${pal.c}" opacity=".22"/><rect x="30" y="156" width="480" height="168" rx="32" fill="#fffdf8" opacity=".96"/>
 ${nestSVG(girlSVG(mood),40,172,140,140)}
 <text x="206" y="196" font-size="11" font-weight="800" letter-spacing="3" fill="${pal.c}">GELAR BULAN INI</text>
 <text x="206" y="228" font-size="23" font-weight="900" fill="${ink}">${tspans(titleLines,206,27)}</text>
 ${badgeSVG}
 ${card(30,342,150,68,`${d.written}/${d.days}`,"hari menulis")}${card(195,342,150,68,String(d.streak),"hari beruntun terbaik")}${card(360,342,150,68,String(d.jar),"kenangan di toples")}
 <rect x="30" y="428" width="480" height="250" rx="30" fill="${pal.c}" opacity=".18"/><rect x="30" y="424" width="480" height="250" rx="30" fill="#fffdf8" opacity=".95"/>
 <text x="46" y="456" font-size="15" font-weight="900" fill="${ink}">Mood Calendar</text><text x="494" y="456" text-anchor="end" font-size="11" font-weight="700" fill="${ink}" opacity=".6">warna = mood harianmu</text>
 ${cal}${bars}
 <rect x="30" y="692" width="480" height="82" rx="26" fill="#fffdf8" opacity=".95"/>
 ${pHeart(56,716,1.1,pal.c)}<text x="72" y="720" font-size="12" font-weight="900" letter-spacing="1" fill="${pal.c}">RASA SYUKUR BULAN INI</text>
 <text x="48" y="744" font-size="12.5" fill="${ink}">${tspans(gratLines,48,17)}</text>
 <rect x="30" y="786" width="480" height="46" rx="23" fill="#fffdf8" opacity=".95"/>
 <text x="52" y="814" font-size="14" font-weight="900" fill="${pal.c}">♪</text><text x="72" y="814" font-size="12.5" fill="${ink}"><tspan font-weight="800">Soundtrack: </tspan>${escapeHTML(songLines[0]||"")}</text>
 <rect x="30" y="846" width="480" height="124" rx="30" fill="${pal.c}" opacity=".95"/>
 <text x="56" y="906" font-size="60" font-weight="900" fill="#fff" opacity=".45">“</text>
 <text x="56" y="872" font-size="11" font-weight="800" letter-spacing="3" fill="#fff">KATA SEMANGAT</text>
 <text x="96" y="900" font-size="15" font-weight="700" fill="#fff">${tspans(quoteLines,96,21)}</text>
 <rect x="30" y="984" width="480" height="64" rx="26" fill="#fffdf8" opacity=".95"/>
 <circle cx="68" cy="1016" r="19" fill="#fff" stroke="${pal.c}" stroke-width="2"/><circle cx="62" cy="1010" r="5" fill="${pal.a}"/><circle cx="60.5" cy="1008.5" r="1.8" fill="#fff"/>
 <text x="100" y="1004" font-size="11" font-weight="900" letter-spacing="2" fill="${pal.c}">MUTIARA KATA</text>
 <text x="100" y="1022" font-size="12" font-style="italic" fill="${ink}">${tspans(pearlLines,100,15)}</text>
 ${pets}
 <text x="270" y="1180" text-anchor="middle" font-size="10" fill="${ink}" opacity=".6">dibuat dengan sayang · ${today().split("-").reverse().join("/")}</text>
 </svg>`;
}

function recapMonthKeys(){
 const cur=today().slice(0,7);
 const set=new Set(state.entries.map(e=>String(e.date).slice(0,7)));
 set.add(cur);
 return [...set].filter(k=>/^\d{4}-\d{2}$/.test(k)).sort().reverse();
}
function fillRecapMonths(prefer){
 const sel=$("recapMonth"),cur=today().slice(0,7);
 const keep=prefer||sel.value;
 const keys=recapMonthKeys();
 sel.innerHTML=keys.map(k=>`<option value="${k}">${monthLabel(k)}${k===cur?" (bulan ini)":""}</option>`).join("");
 if(keys.includes(keep))sel.value=keep;
 else sel.value=keys.find(k=>k<cur)||cur;
}
function renderRecap(){
 const key=$("recapMonth").value;
 if(!key)return;
 $("recapPoster").innerHTML=recapSVG(key);
 if(!state.recapSeen[key]){state.recapSeen[key]=true;api("POST","/api/recap-seen",{key}).catch(()=>{});}
}
$("recapMonth").addEventListener("change",renderRecap);

function saveBlob(blob,name){
 const url=URL.createObjectURL(blob),a=document.createElement("a");
 a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(url),3000);
}
function recapXML(){
 const svg=$("recapPoster").querySelector("svg");
 return '<?xml version="1.0" encoding="UTF-8"?>\n'+new XMLSerializer().serializeToString(svg);
}
$("recapSvg").addEventListener("click",()=>{
 if(!$("recapPoster").querySelector("svg"))renderRecap();
 saveBlob(new Blob([recapXML()],{type:"image/svg+xml"}),`my-little-diary-recap-${$("recapMonth").value}.svg`);
 $("recapStatus").textContent="Rekap SVG diunduh. Cek folder Download di perangkatmu.";
});
$("recapPng").addEventListener("click",()=>{
 if(!$("recapPoster").querySelector("svg"))renderRecap();
 const xml=recapXML(),img=new Image();
 img.onload=()=>{
  const c=document.createElement("canvas");c.width=1080;c.height=2380;
  const ctx=c.getContext("2d");ctx.fillStyle="#fff";ctx.fillRect(0,0,c.width,c.height);
  ctx.drawImage(img,0,0,c.width,c.height);
  c.toBlob(b=>{
   if(!b){$("recapStatus").textContent="Gagal membuat PNG. Coba unduh versi SVG.";return;}
   saveBlob(b,`my-little-diary-recap-${$("recapMonth").value}.png`);
   $("recapStatus").textContent="Rekap PNG diunduh. Cek folder Download di perangkatmu.";
  },"image/png");
 };
 img.onerror=()=>{$("recapStatus").textContent="Gagal membuat PNG. Coba unduh versi SVG.";};
 img.src="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(xml);
});

/* Popup otomatis saat bulan berganti */
const recapDismissed={};
function checkMonthlyRecap(){
 if(!authed||!unlocked)return;
 const cur=today().slice(0,7);
 const keys=[...new Set(state.entries.map(e=>String(e.date).slice(0,7)))].filter(k=>/^\d{4}-\d{2}$/.test(k)&&k<cur&&!state.recapSeen[k]&&!recapDismissed[k]).sort();
 if(!keys.length)return;
 const key=keys[keys.length-1];
 $("popText").textContent=`Rekap ${monthLabel(key)} sudah siap! Ada gelar, mood calendar, kata semangat, dan mutiara kata khusus untukmu.`;
 $("popView").dataset.key=key;
 $("recapPop").classList.add("show");
}
$("popLater").addEventListener("click",()=>{
 recapDismissed[$("popView").dataset.key]=true;
 $("recapPop").classList.remove("show");
});
$("popView").addEventListener("click",()=>{
 const key=$("popView").dataset.key;
 $("recapPop").classList.remove("show");
 fillRecapMonths(key);
 go("recap-section");
});
setInterval(checkMonthlyRecap,60000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)checkMonthlyRecap();});

/* ---------- INIT ---------- */
renderMoods();
updateMusicUI();
setAuthMode("login");

// Hewan dibuat di atas lantai; posisi dirapikan saat halaman Little Room dibuka (fitRoom).
makePet("cat","Mochi",20,0);
makePet("capy","Coco",130,0);
makePet("raccoon","Ruru",240,0);

window.addEventListener("resize",fitRoom);
requestAnimationFrame(animationLoop);

/* Pulihkan sesi login (Supabase) saat halaman dibuka */
(async function boot(){
 try{
  const { data, error } = await sb.auth.getSession();
  if(error) throw error;
  if(data.session) await enterApp(await buildMe(data.session.user));
  else showAuth("");
 }catch(err){showAuth(err.message);}
})();
