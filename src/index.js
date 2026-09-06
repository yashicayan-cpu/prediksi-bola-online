const enc = new TextEncoder();
const dec = new TextDecoder();

function J(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

function H(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

async function sign(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}

async function makeSession(env) {
  const payload = b64(enc.encode(JSON.stringify({
    exp: Date.now() + 43200000,
    nonce: crypto.randomUUID()
  })));
  return payload + "." + b64(await sign(env.SESSION_SECRET, payload));
}

async function validSession(env, token) {
  try {
    if (!token || !token.includes(".") || !env.SESSION_SECRET) return false;
    const [payload, sig] = token.split(".");
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(env.SESSION_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const ok = await crypto.subtle.verify("HMAC", key, unb64(sig), enc.encode(payload));
    if (!ok) return false;
    return JSON.parse(dec.decode(unb64(payload))).exp > Date.now();
  } catch {
    return false;
  }
}

function cookie(req, name) {
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

async function isAdmin(req, env) {
  return validSession(env, cookie(req, "bp_session"));
}

function eq(a, b) {
  a = String(a ?? "");
  b = String(b ?? "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function frac(s) {
  s = String(s).trim().replace(/\s+/g, " ");
  if (s === "0") return 0;
  if (/^\d+\s+\d+\/\d+$/.test(s)) {
    const [whole, f] = s.split(" ");
    const [a, b] = f.split("/").map(Number);
    return Number(whole) + (b ? a / b : 0);
  }
  if (/^\d+\/\d+$/.test(s)) {
    const [a, b] = s.split("/").map(Number);
    return b ? a / b : 0;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function favored(home, away, hdp) {
  const p = String(hdp).split(":").map(x => x.trim());
  if (p.length !== 2) return { favorite: "Tidak terdeteksi", side: "even", strength: 0 };
  const left = frac(p[0]);
  const right = frac(p[1]);
  if (left === 0 && right > 0) return { favorite: home, side: "home", strength: right };
  if (right === 0 && left > 0) return { favorite: away, side: "away", strength: left };
  return { favorite: "Seimbang", side: "even", strength: 0 };
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function score(side, strength) {
  if (side === "home") {
    if (strength >= 1.5) return pick(["3-0", "3-1", "4-0", "4-1"]);
    if (strength >= 1) return pick(["2-0", "3-0", "3-1", "2-1"]);
    if (strength >= 0.75) return pick(["2-0", "2-1", "3-0", "3-1"]);
    if (strength >= 0.5) return pick(["1-0", "2-0", "2-1", "3-1"]);
    return pick(["1-0", "2-1", "2-0"]);
  }
  if (side === "away") {
    if (strength >= 1.5) return pick(["0-3", "1-3", "0-4", "1-4"]);
    if (strength >= 1) return pick(["0-2", "0-3", "1-3", "1-2"]);
    if (strength >= 0.75) return pick(["0-2", "1-2", "0-3", "1-3"]);
    if (strength >= 0.5) return pick(["0-1", "0-2", "1-2", "1-3"]);
    return pick(["0-1", "1-2", "0-2"]);
  }
  return pick(["0-0", "1-1", "2-2", "1-0", "0-1", "2-1", "1-2"]);
}

function pred(home, away, hdp) {
  const f = favored(home, away, hdp);
  let prediction;
  if (f.side === "home") prediction = home + " WIN";
  else if (f.side === "away") prediction = away + " WIN";
  else {
    const r = Math.random();
    prediction = r < 0.4 ? home + " WIN" : r < 0.8 ? away + " WIN" : "DRAW";
  }
  return {
    favorite: f.favorite,
    prediction,
    score: score(f.side, f.strength)
  };
}

function fixture(line, league, year) {
  const side = "(?:0|\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:\\.\\d+)?)";
  const rx = new RegExp(
    "^(\\d{1,2})\\/(\\d{1,2})\\s+(\\d{1,2}:\\d{2})\\s+(.+?)\\s+VS\\s+(.+?)\\s+(" +
    side + "\\s*:\\s*" + side + ")\\s*$",
    "i"
  );
  const m = line.match(rx);
  if (!m) return null;

  const day = m[1].padStart(2, "0");
  const month = m[2].padStart(2, "0");
  const kickoff = m[3].length === 4 ? "0" + m[3] : m[3];
  const home = m[4].trim();
  const away = m[5].trim();
  const handicap = m[6].replace(/\s+/g, " ").trim();
  const p = pred(home, away, handicap);

  return {
    league,
    match_date: year + "-" + month + "-" + day,
    date_display: day + "/" + month,
    kickoff,
    home,
    away,
    handicap,
    favorite: p.favorite,
    prediction: p.prediction,
    score: p.score
  };
}

function parseBulk(raw, year) {
  let league = "";
  const matches = [];
  const errors = [];

  String(raw || "")
    .replace(/\r/g, "")
    .split("\n")
    .map(x => x.trim())
    .forEach((line, i) => {
      if (!line) return;

      const f = fixture(line, league, year);
      if (f) {
        if (!league) errors.push("Baris " + (i + 1) + ": belum ada heading liga.");
        else matches.push(f);
        return;
      }

      if (!/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}/.test(line)) {
        league = line;
      } else {
        errors.push("Baris " + (i + 1) + " tidak terbaca: " + line);
      }
    });

  return { matches, errors };
}

const PUBLIC = String.raw`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jadwal Prediksi Bola | Jadwal & Prediksi Bola</title>
<meta name="description" content="Jadwal pertandingan, pasaran HDP, dan prediksi skor bola terbaru.">
<meta name="robots" content="index,follow">
<style>
:root{
  --primary:#83fe43;--secondary:#35c56b;--accent:#c7ff4d;
  --bg:#061108;--card:#0d1f13;--card2:#102718;--line:#1f4228;
  --text:#f0fff3;--muted:#9bb5a1;--danger:#ff5d5d;--shadow:0 20px 60px rgba(0,0,0,.28)
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:
radial-gradient(circle at 12% 0%,rgba(131,254,67,.12),transparent 28%),
radial-gradient(circle at 88% 16%,rgba(53,197,107,.10),transparent 30%),var(--bg);color:var(--text);min-height:100vh}
a{color:inherit;text-decoration:none}
button,input{font:inherit}
.container{width:min(1180px,calc(100% - 32px));margin:auto}
.site-header{position:sticky;top:0;z-index:30;background:rgba(6,17,8,.88);backdrop-filter:blur(18px);border-bottom:1px solid rgba(131,254,67,.12)}
.nav-wrap{height:76px;display:flex;align-items:center;justify-content:space-between;gap:20px}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.brand-mark{width:44px;height:44px;display:grid;place-items:center;border-radius:14px;background:linear-gradient(135deg,var(--primary),var(--secondary));color:#07110a;font-size:23px;box-shadow:0 0 32px rgba(131,254,67,.25)}
.brand-copy{display:flex;flex-direction:column;line-height:1.2}
.brand-copy b{font-size:15px}.brand-copy small{color:var(--muted);font-size:11px;margin-top:3px}
.main-nav{display:flex;gap:8px}
.main-nav a{padding:10px 13px;border-radius:11px;color:var(--muted);font-size:13px;font-weight:750}
.main-nav a:hover,.main-nav a.active{background:rgba(131,254,67,.1);color:var(--primary)}
.hero{margin-top:32px;border:1px solid rgba(131,254,67,.18);background:linear-gradient(135deg,rgba(16,39,24,.92),rgba(8,24,13,.90));border-radius:24px;padding:30px;display:grid;grid-template-columns:1.5fr .7fr;gap:28px;overflow:hidden;position:relative;box-shadow:var(--shadow)}
.hero:before{content:"";position:absolute;width:320px;height:320px;border-radius:50%;border:1px solid rgba(131,254,67,.08);right:-90px;top:-120px;box-shadow:0 0 0 40px rgba(131,254,67,.025),0 0 0 80px rgba(131,254,67,.018)}
.eyebrow{display:inline-flex;align-items:center;gap:8px;color:var(--primary);font-size:12px;font-weight:900;letter-spacing:.08em}
.hero h1{font-size:clamp(30px,5vw,54px);line-height:1.02;margin:14px 0 12px;max-width:800px}
.hero p{margin:0;color:var(--muted);max-width:720px;line-height:1.65}
.stat-row{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}
.stat{padding:9px 12px;border-radius:12px;border:1px solid rgba(131,254,67,.14);background:rgba(0,0,0,.14);font-size:12px;color:var(--muted)}
.stat b{color:var(--text);font-size:15px;margin-right:5px}
.hero-visual{display:grid;place-items:center;min-height:200px;position:relative}
.orb{width:150px;height:150px;border-radius:50%;display:grid;place-items:center;font-size:64px;background:
radial-gradient(circle at 35% 30%,rgba(255,255,255,.22),transparent 18%),
linear-gradient(145deg,var(--primary),#1c9e54);box-shadow:0 0 55px rgba(131,254,67,.26);position:relative}
.orb:before,.orb:after{content:"";position:absolute;border:1px solid rgba(199,255,77,.15);border-radius:50%;inset:-35px}
.orb:after{inset:-70px;opacity:.5}
.live-pill{position:absolute;bottom:4px;padding:8px 11px;border-radius:999px;background:#08140c;border:1px solid rgba(131,254,67,.2);font-size:11px;font-weight:900;color:var(--primary)}
.live-pill i{display:inline-block;width:7px;height:7px;background:var(--primary);border-radius:50%;margin-right:6px;box-shadow:0 0 10px var(--primary)}
.section{margin-top:26px}
.section-head{display:flex;align-items:end;justify-content:space-between;gap:14px;margin-bottom:12px}
.section-title{display:flex;align-items:center;gap:9px;font-weight:900;font-size:18px}
.section-title span{color:var(--accent)}
.section-sub{color:var(--muted);font-size:12px;margin-top:4px}
.featured-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.featured-card{position:relative;background:linear-gradient(180deg,#102718,#0c1d12);border:1px solid rgba(131,254,67,.16);border-radius:18px;padding:16px;overflow:hidden;cursor:pointer;transition:.18s ease;box-shadow:0 10px 32px rgba(0,0,0,.18)}
.featured-card:hover{transform:translateY(-2px);border-color:rgba(131,254,67,.34)}
.featured-card:before{content:"";position:absolute;inset:auto -30px -50px auto;width:130px;height:130px;background:radial-gradient(circle,rgba(131,254,67,.13),transparent 65%)}
.feature-top{display:flex;justify-content:space-between;gap:10px;align-items:center}
.feature-label{font-size:10px;font-weight:950;letter-spacing:.08em;color:#07110a;background:linear-gradient(90deg,var(--accent),var(--primary));padding:6px 8px;border-radius:8px}
.feature-top small{color:var(--muted);font-size:10px;text-align:right}
.feature-teams{display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:center;margin:20px 0 14px}
.team-box{text-align:center;min-width:0}
.logo-bubble{width:54px;height:54px;margin:auto auto 8px;border-radius:50%;background:#07140b;border:1px solid rgba(131,254,67,.18);display:grid;place-items:center;color:var(--primary);font-weight:950;font-size:15px}
.team-box b{font-size:12px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vs{font-weight:950;color:var(--muted);font-size:11px}
.feature-meta{text-align:center;color:var(--muted);font-size:11px}
.feature-values{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}
.feature-values span{padding:9px;border-radius:10px;background:#08140c;border:1px solid rgba(131,254,67,.1);font-size:10px;color:var(--muted)}
.feature-values b{display:block;color:var(--text);font-size:14px;margin-top:3px}
.hub{margin:28px 0 40px;background:rgba(13,31,19,.72);border:1px solid rgba(131,254,67,.14);border-radius:22px;padding:18px;box-shadow:var(--shadow)}
.hub-head{display:flex;justify-content:space-between;gap:15px;align-items:end}
.hub-head h2{margin:0;font-size:22px}.hub-head p{margin:6px 0 0;color:var(--muted);font-size:12px}
.tabs{display:flex;gap:7px}
.tabs button{border:1px solid rgba(131,254,67,.14);background:#08150c;color:var(--muted);padding:9px 12px;border-radius:10px;font-weight:850;cursor:pointer}
.tabs button.active{background:var(--primary);color:#07110a;border-color:var(--primary)}
.search{margin:16px 0 12px;display:flex;gap:9px}
.search input{width:100%;background:#08150c;color:var(--text);border:1px solid rgba(131,254,67,.14);border-radius:12px;padding:12px 14px;outline:none}
.search input:focus{border-color:rgba(131,254,67,.42);box-shadow:0 0 0 3px rgba(131,254,67,.06)}
.match-content{display:grid;gap:12px}
.league-block{border:1px solid rgba(131,254,67,.12);border-radius:15px;overflow:hidden;background:#08150c}
.league-block h3{margin:0;padding:10px 13px;background:linear-gradient(90deg,rgba(131,254,67,.10),rgba(53,197,107,.03));font-size:11px;letter-spacing:.06em;color:var(--primary)}
.match-row{display:grid;grid-template-columns:110px 1fr 120px;gap:12px;align-items:center;padding:11px 13px;border-top:1px solid rgba(131,254,67,.08)}
.match-time strong{display:block;font-size:14px}.match-time span{color:var(--muted);font-size:10px}
.match-teams{display:flex;align-items:center;gap:10px;min-width:0}.match-teams b{font-size:12px}.match-teams span{color:var(--muted);font-size:10px}
.match-value{text-align:right;font-weight:950;color:var(--accent);font-size:14px}
.empty{padding:32px;text-align:center;color:var(--muted);border:1px dashed rgba(131,254,67,.16);border-radius:14px}
.footer{border-top:1px solid rgba(131,254,67,.1);padding:25px 0 35px;color:var(--muted);font-size:12px}
.footer-wrap{display:flex;justify-content:space-between;gap:20px}.footer b{color:var(--text)}
.modal{position:fixed;inset:0;z-index:60;display:none;place-items:center;padding:18px}
.modal.open{display:grid}.backdrop{position:absolute;inset:0;background:rgba(0,0,0,.72);backdrop-filter:blur(8px)}
.dialog{position:relative;width:min(520px,100%);background:#0d1f13;border:1px solid rgba(131,254,67,.2);border-radius:20px;padding:20px;box-shadow:0 30px 100px rgba(0,0,0,.55)}
.close{position:absolute;right:12px;top:12px;width:34px;height:34px;border-radius:10px;border:1px solid rgba(131,254,67,.14);background:#08150c;color:var(--text);cursor:pointer}
.modal-title{font-size:11px;color:var(--primary);font-weight:950;letter-spacing:.08em}.dialog h2{margin:8px 0 4px}.dialog p{margin:0;color:var(--muted)}
.modal-teams{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px;margin:20px 0}
.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.detail{padding:10px;border-radius:11px;background:#08150c;border:1px solid rgba(131,254,67,.1)}.detail span{display:block;color:var(--muted);font-size:10px}.detail b{display:block;margin-top:4px}
@media(max-width:900px){.hero{grid-template-columns:1fr}.hero-visual{min-height:160px}.featured-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:680px){
.container{width:min(100% - 20px,1180px)}.nav-wrap{height:66px}.brand-copy small{display:none}.main-nav a{padding:8px 9px;font-size:11px}
.hero{padding:20px;margin-top:18px;border-radius:18px}.hero-visual{display:none}.featured-grid{grid-template-columns:1fr}
.hub{padding:12px}.hub-head{align-items:flex-start;flex-direction:column}.tabs{width:100%}.tabs button{flex:1}
.match-row{grid-template-columns:76px 1fr 74px;padding:10px}.match-teams{display:grid;grid-template-columns:1fr}.match-teams span{display:none}
.footer-wrap{flex-direction:column}.section-head{align-items:flex-start;flex-direction:column}
}
</style>
</head>
<body>
<header class="site-header">
  <div class="container nav-wrap">
    <a class="brand" href="/">
      <span class="brand-mark">⚽</span>
      <span class="brand-copy"><b>Jadwal Prediksi Bola</b><small>Jadwal dan Prediksi Bola Terbaru Bolapelangi2</small></span>
    </a>
    <nav class="main-nav">
      <a href="/" data-nav="home">Home</a>
      <a href="/jadwal-bola" data-nav="schedule">Jadwal</a>
      <a href="/prediksi-bola" data-nav="prediction">Prediksi</a>
    </nav>
  </div>
</header>

<main>
  <section class="container hero">
    <div>
      <span class="eyebrow">⚡ UPDATE PERTANDINGAN • WIB</span>
      <h1 id="heroTitle">Jadwal & Prediksi Bola</h1>
      <p>Temukan jadwal pertandingan, pasaran HDP, dan prediksi skor terbaru dalam tampilan yang cepat dan mudah dibaca.</p>
      <div class="stat-row">
        <span class="stat"><b id="statMatches">0</b> Jadwal</span>
        <span class="stat"><b id="statPredictions">0</b> Prediksi</span>
        <span class="stat"><b id="statLeagues">0</b> Liga</span>
      </div>
    </div>
    <div class="hero-visual">
      <div class="orb">⚽</div>
      <span class="live-pill"><i></i> LIVE UPDATE</span>
    </div>
  </section>

  <section class="container section">
    <div class="section-head">
      <div>
        <div class="section-title"><span>✦</span> Pertandingan Spesial</div>
        <div class="section-sub">Otomatis dipilih dari pooran terkuat hari ini.</div>
      </div>
    </div>
    <div id="featured" class="featured-grid"></div>
  </section>

  <section class="container hub">
    <div class="hub-head">
      <div>
        <h2>Jadwal Bola & Prediksi Skor Hari Ini</h2>
        <p>Cek jam kick-off, pasaran HDP, dan prediksi skor pilihan dari pertandingan hari ini sampai dini hari.</p>
      </div>
      <div class="tabs">
        <button id="tabSchedule" data-tab="schedule">Jadwal</button>
        <button id="tabPrediction" data-tab="prediction">Prediksi</button>
      </div>
    </div>
    <div class="search"><input id="searchBox" type="search" placeholder="Ketik nama tim, contoh Arsenal atau Indonesia"></div>
    <div id="matchContent" class="match-content"></div>
  </section>
</main>

<footer class="footer">
  <div class="container footer-wrap">
    <div><b>Jadwal Prediksi Bola</b><div>Jadwal dan Prediksi Bola Terbaru Bolapelangi2</div></div>
    <div>© 2026 Jadwal Prediksi Bola • <a href="/admin">Admin</a></div>
  </div>
</footer>

<div id="modal" class="modal" aria-hidden="true">
  <div class="backdrop" data-close></div>
  <div class="dialog" role="dialog" aria-modal="true">
    <button class="close" data-close>✕</button>
    <div class="modal-title">🔥 BIG MATCH</div>
    <h2 id="modalLeague">Rincian Pertandingan</h2>
    <p id="modalSubtitle"></p>
    <div id="modalTeams" class="modal-teams"></div>
    <div id="modalDetails" class="detail-grid"></div>
  </div>
</div>

<script>
(function(){
  var all = [];
  var mode = location.pathname.indexOf("prediksi-bola") >= 0 ? "prediction" : "schedule";
  var E = function(s){return String(s == null ? "" : s).replace(/[&<>"']/g,function(m){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]})};
  var initials = function(name){
    return String(name || "?").split(/\s+/).filter(Boolean).slice(0,2).map(function(x){return x[0]}).join("").toUpperCase();
  };
  var frac = function(s){
    s = String(s || "").trim().replace(/\s+/g," ");
    if(s === "0") return 0;
    if(/^\d+\s+\d+\/\d+$/.test(s)){var p=s.split(" ");var f=p[1].split("/");return Number(p[0])+Number(f[0])/Number(f[1])}
    if(/^\d+\/\d+$/.test(s)){var q=s.split("/");return Number(q[0])/Number(q[1])}
    var n=Number(s);return isFinite(n)?n:0;
  };
  var strength = function(hdp){
    var p=String(hdp||"").split(":").map(function(x){return x.trim()});
    if(p.length!==2)return 0;
    return Math.max(frac(p[0]),frac(p[1]));
  };
  var prettyDate = function(s){
    if(!s)return "";
    var p=s.split("-");
    if(p.length!==3)return s;
    var names=["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"];
    return Number(p[2])+" "+names[Number(p[1])-1]+" "+p[0];
  };
  var rangeTitle = function(data){
    if(!data.length)return "Jadwal & Prediksi Bola";
    var dates=[].concat(data.map(function(x){return x.match_date})).sort();
    var a=dates[0],b=dates[dates.length-1];
    if(a===b)return "Jadwal & Prediksi Bola "+prettyDate(a);
    return "Jadwal & Prediksi Bola "+prettyDate(a)+" - "+prettyDate(b);
  };
  var leaguePriority = function(name){
    name=String(name||"").toUpperCase();
    var list=["ENGLISH PREMIER LEAGUE","SPAIN LA LIGA","ITALY SERIE A","GERMANY BUNDESLIGA","FRANCE LIGUE 1","UEFA CHAMPIONS LEAGUE"];
    var i=list.indexOf(name);return i<0?0:(list.length-i)*.08;
  };
  function featuredScore(x){return strength(x.handicap)+leaguePriority(x.league)}
  function setMode(next){
    mode=next;
    document.getElementById("tabSchedule").classList.toggle("active",mode==="schedule");
    document.getElementById("tabPrediction").classList.toggle("active",mode==="prediction");
    document.querySelectorAll("[data-nav]").forEach(function(a){
      var key=a.getAttribute("data-nav");
      a.classList.toggle("active",(mode==="schedule"&&key==="schedule")||(mode==="prediction"&&key==="prediction")||(location.pathname==="/"&&key==="home"));
    });
    renderMatches();
  }
  function renderStats(){
    document.getElementById("heroTitle").textContent=rangeTitle(all);
    document.getElementById("statMatches").textContent=all.length;
    document.getElementById("statPredictions").textContent=all.filter(function(x){return x.score}).length;
    document.getElementById("statLeagues").textContent=new Set(all.map(function(x){return x.league})).size;
  }
  function card(x){
    return '<article class="featured-card" data-id="'+E(x.id)+'">'+
      '<div class="feature-top"><span class="feature-label">🔥 BIG MATCH</span><small>'+E(x.league)+'</small></div>'+
      '<div class="feature-teams">'+
        '<div class="team-box"><span class="logo-bubble">'+E(initials(x.home))+'</span><b>'+E(x.home)+'</b></div>'+
        '<span class="vs">VS</span>'+
        '<div class="team-box"><span class="logo-bubble">'+E(initials(x.away))+'</span><b>'+E(x.away)+'</b></div>'+
      '</div>'+
      '<div class="feature-meta">'+E(x.date_display)+' • '+E(x.kickoff)+' WIB</div>'+
      '<div class="feature-values"><span>Pasaran HDP<b>'+E(x.handicap)+'</b></span><span>Prediksi<b>'+E(x.score)+'</b></span></div>'+
    '</article>';
  }
  function renderFeatured(){
    var box=document.getElementById("featured");
    if(!all.length){box.innerHTML='<div class="empty">Belum ada pertandingan spesial.</div>';return}
    var chosen=all.slice().sort(function(a,b){return featuredScore(b)-featuredScore(a)}).slice(0,6);
    box.innerHTML=chosen.map(card).join("");
    box.querySelectorAll("[data-id]").forEach(function(el){el.addEventListener("click",function(){openModal(el.getAttribute("data-id"))})});
  }
  function renderMatches(){
    var q=document.getElementById("searchBox").value.toLowerCase().trim();
    var data=all.filter(function(x){return (x.league+" "+x.home+" "+x.away).toLowerCase().indexOf(q)>=0});
    var groups={};
    data.forEach(function(x){(groups[x.league]||(groups[x.league]=[])).push(x)});
    var out=Object.keys(groups).map(function(league){
      var rows=groups[league].map(function(x){
        var value=mode==="prediction"?x.score:x.handicap;
        return '<article class="match-row" data-id="'+E(x.id)+'">'+
          '<div class="match-time"><strong>'+E(x.kickoff)+'</strong><span>WIB • '+E(x.date_display)+'</span></div>'+
          '<div class="match-teams"><b>'+E(x.home)+'</b><span>VS</span><b>'+E(x.away)+'</b></div>'+
          '<div class="match-value">'+E(value)+'</div>'+
        '</article>';
      }).join("");
      return '<section class="league-block"><h3>'+E(league)+'</h3>'+rows+'</section>';
    }).join("");
    document.getElementById("matchContent").innerHTML=out||'<div class="empty">Tidak ada pertandingan yang cocok.</div>';
  }
  function openModal(id){
    var x=all.find(function(m){return String(m.id)===String(id)});
    if(!x)return;
    document.getElementById("modalLeague").textContent=x.league;
    document.getElementById("modalSubtitle").textContent=x.home+" vs "+x.away;
    document.getElementById("modalTeams").innerHTML=
      '<div class="team-box"><span class="logo-bubble">'+E(initials(x.home))+'</span><b>'+E(x.home)+'</b></div>'+
      '<span class="vs">VS</span>'+
      '<div class="team-box"><span class="logo-bubble">'+E(initials(x.away))+'</span><b>'+E(x.away)+'</b></div>';
    document.getElementById("modalDetails").innerHTML=
      '<div class="detail"><span>Tanggal</span><b>'+E(prettyDate(x.match_date))+'</b></div>'+
      '<div class="detail"><span>Kick-off</span><b>'+E(x.kickoff)+' WIB</b></div>'+
      '<div class="detail"><span>Pasaran HDP</span><b>'+E(x.handicap)+'</b></div>'+
      '<div class="detail"><span>Prediksi Skor</span><b>'+E(x.score)+'</b></div>'+
      '<div class="detail"><span>Favorit Pasar</span><b>'+E(x.favorite)+'</b></div>'+
      '<div class="detail"><span>Pilihan Sistem</span><b>'+E(x.prediction)+'</b></div>';
    document.getElementById("modal").classList.add("open");
    document.getElementById("modal").setAttribute("aria-hidden","false");
  }
  function closeModal(){
    document.getElementById("modal").classList.remove("open");
    document.getElementById("modal").setAttribute("aria-hidden","true");
  }
  async function load(){
    try{
      var r=await fetch("/api/matches");
      var j=await r.json();
      all=j.matches||[];
      renderStats();renderFeatured();setMode(mode);
    }catch(e){
      document.getElementById("matchContent").innerHTML='<div class="empty">Data belum dapat dimuat.</div>';
    }
  }
  document.getElementById("tabSchedule").addEventListener("click",function(){setMode("schedule")});
  document.getElementById("tabPrediction").addEventListener("click",function(){setMode("prediction")});
  document.getElementById("searchBox").addEventListener("input",renderMatches);
  document.querySelectorAll("[data-close]").forEach(function(x){x.addEventListener("click",closeModal)});
  document.addEventListener("keydown",function(e){if(e.key==="Escape")closeModal()});
  load();
})();
</script>
</body>
</html>`;

const ADMIN = String.raw`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin | Jadwal Prediksi Bola</title>
<style>
:root{--p:#83fe43;--s:#35c56b;--bg:#061108;--card:#0d1f13;--line:#1f4228;--text:#f0fff3;--muted:#9bb5a1;--red:#ff6565}
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,sans-serif;background:radial-gradient(circle at 12% 0%,rgba(131,254,67,.11),transparent 27%),var(--bg);color:var(--text);min-height:100vh}
a{color:inherit;text-decoration:none}button,input,textarea{font:inherit}.wrap{width:min(1220px,calc(100% - 28px));margin:auto}
header{border-bottom:1px solid rgba(131,254,67,.12);background:rgba(6,17,8,.9);backdrop-filter:blur(14px);position:sticky;top:0;z-index:20}
.head{height:72px;display:flex;justify-content:space-between;align-items:center;gap:15px}.head h1{margin:0;font-size:18px}.head small{color:var(--muted)}
.panel{background:rgba(13,31,19,.94);border:1px solid rgba(131,254,67,.14);border-radius:18px;padding:17px;margin:18px 0;box-shadow:0 20px 60px rgba(0,0,0,.25)}
.login{max-width:420px;margin:70px auto}.hidden{display:none!important}
label{display:block;font-size:11px;font-weight:850;color:var(--muted);margin-bottom:5px}
input,textarea{width:100%;background:#08150c;color:var(--text);border:1px solid rgba(131,254,67,.15);border-radius:11px;padding:11px;outline:none}
input:focus,textarea:focus{border-color:rgba(131,254,67,.45);box-shadow:0 0 0 3px rgba(131,254,67,.06)}
textarea{min-height:300px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.55;resize:vertical}
button{border:0;border-radius:10px;padding:10px 13px;font-weight:900;cursor:pointer}.btn{background:linear-gradient(90deg,var(--p),var(--s));color:#07110a}.btn2{background:#102718;color:var(--text);border:1px solid rgba(131,254,67,.13)}.danger{background:#2a1111;color:#ffaaaa;border:1px solid rgba(255,101,101,.15)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.top{display:flex;justify-content:space-between;align-items:center;gap:12px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.note{padding:10px 12px;border-radius:11px;background:rgba(131,254,67,.06);border:1px solid rgba(131,254,67,.12);color:var(--muted);font-size:12px;line-height:1.5;margin:12px 0}
.tw{overflow:auto;border:1px solid rgba(131,254,67,.1);border-radius:12px;margin-top:12px}table{width:100%;border-collapse:collapse;min-width:920px}th,td{padding:9px;border-bottom:1px solid rgba(131,254,67,.08);font-size:11px;text-align:left}th{background:#102718;color:var(--muted)}.pick{color:var(--p);font-weight:900}.fav{color:#d9ff85;font-weight:900}
.metric-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.metric{background:#08150c;border:1px solid rgba(131,254,67,.1);border-radius:10px;padding:8px 10px;color:var(--muted);font-size:11px}.metric b{color:var(--text)}
.err{color:#ff8585}.ok{color:var(--p)}@media(max-width:700px){.grid{grid-template-columns:1fr}.top,.head{align-items:flex-start;flex-direction:column;height:auto;padding:14px 0}.panel{border-radius:14px}}
</style>
</head>
<body>
<header><div class="wrap head"><div><h1>⚽ Admin Jadwal Prediksi Bola</h1><small>Paste jadwal → generate → preview → publish</small></div><a href="/">← Lihat Website</a></div></header>

<div id="loginBox" class="panel login">
  <h2>Admin Login</h2>
  <div style="margin:12px 0"><label>Username</label><input id="user" autocomplete="username"></div>
  <div style="margin:12px 0"><label>Password</label><input id="pass" type="password" autocomplete="current-password"></div>
  <button class="btn" id="loginBtn">LOGIN</button>
  <div id="loginMsg" class="err" style="margin-top:9px;font-size:12px"></div>
</div>

<main id="app" class="wrap hidden">
  <section class="panel">
    <div class="top">
      <div><h2 style="margin:0">Input Jadwal Massal</h2><div style="color:var(--muted);font-size:12px;margin-top:4px">Format liga + pertandingan seperti yang biasa kau pakai.</div></div>
      <button class="btn2" id="logoutBtn">Logout</button>
    </div>
    <div class="grid" style="margin-top:14px">
      <div><label>Tahun</label><input id="year" type="number" value="2026"></div>
      <div><label>Mode Prediksi</label><input value="Favorit pooran + skor acak terarah" disabled></div>
    </div>
    <div class="note">Aturan utama: <b>0 : 1/2</b> berarti HOME favorit, <b>1/4 : 0</b> berarti AWAY favorit, dan <b>0 : 0</b> dianggap seimbang. Skor acak diarahkan ke tim yang difavoritkan oleh pooran.</div>
    <textarea id="bulk">ITALY SERIE A

08/09 0:00  Cagliari  VS  Lecce 0 : 1/2
08/09 2:45  Udinese  VS  Lazio 0 : 1/4

SPAIN LA LIGA

08/09 1:00  Getafe CF  VS  Celta Vigo 0 : 1/4
08/09 3:30  Elche  VS  Real Sociedad 1/4 : 0

SWEDEN ALLSVENSKAN

08/09 1:00  Mjallby  VS  IFK Goteborg 0 : 1/4
08/09 1:00  Kalmar  VS  Djurgardens 0 : 1/4
08/09 1:00  Malmo  VS  AIK Fotboll 0 : 0</textarea>
    <div class="actions"><button class="btn" id="previewBtn">⚙️ GENERATE PREDIKSI</button><button class="btn2" id="clearInputBtn">Kosongkan</button></div>
    <div id="msg" style="font-size:12px;margin-top:10px"></div>
  </section>

  <section id="previewPanel" class="panel hidden">
    <div class="top"><div><h2 style="margin:0">Preview</h2><div id="previewCount" style="color:var(--muted);font-size:12px"></div></div></div>
    <div class="metric-row">
      <span class="metric"><b id="metricMatch">0</b> match</span>
      <span class="metric"><b id="metricLeague">0</b> liga</span>
      <span class="metric"><b id="metricFav">0</b> favorit jelas</span>
    </div>
    <div class="tw"><table>
      <thead><tr><th>Liga</th><th>Tanggal</th><th>Jam</th><th>Match</th><th>HDP</th><th>Favorit</th><th>Prediksi</th><th>Skor</th></tr></thead>
      <tbody id="previewRows"></tbody>
    </table></div>
    <div class="actions"><button class="btn" id="publishBtn">✅ PUBLIKASIKAN SEMUA</button><button class="btn2" id="rerollBtn">🎲 Acak Ulang</button></div>
  </section>

  <section class="panel">
    <div class="top">
      <div><h2 style="margin:0">Data Tersimpan</h2><div id="savedCount" style="color:var(--muted);font-size:12px"></div></div>
      <button class="danger" id="clearAllBtn">Hapus Semua</button>
    </div>
    <div class="tw"><table>
      <thead><tr><th>Liga</th><th>Tanggal</th><th>Jam</th><th>Match</th><th>HDP</th><th>Prediksi</th><th>Skor</th><th>Aksi</th></tr></thead>
      <tbody id="savedRows"></tbody>
    </table></div>
  </section>
</main>

<script>
(function(){
  var previewData=[];
  var E=function(s){return String(s==null?"":s).replace(/[&<>"']/g,function(m){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]})};
  async function api(url,opt){
    opt=opt||{};
    var headers={"content-type":"application/json"};
    if(opt.headers)Object.assign(headers,opt.headers);
    var r=await fetch(url,Object.assign({},opt,{headers:headers}));
    var j={};try{j=await r.json()}catch(e){}
    if(!r.ok)throw new Error(j.error||"Request gagal");
    return j;
  }
  async function login(){
    try{
      await api("/api/login",{method:"POST",body:JSON.stringify({username:document.getElementById("user").value,password:document.getElementById("pass").value})});
      showApp();
    }catch(e){document.getElementById("loginMsg").textContent=e.message}
  }
  async function logout(){await api("/api/logout",{method:"POST"});location.reload()}
  async function checkAuth(){
    try{var j=await api("/api/me");if(j.authenticated)showApp()}catch(e){}
  }
  function showApp(){
    document.getElementById("loginBox").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    loadSaved();
  }
  async function preview(){
    var msg=document.getElementById("msg");
    msg.textContent="Memproses...";
    try{
      var j=await api("/api/parse",{method:"POST",body:JSON.stringify({raw:document.getElementById("bulk").value,year:document.getElementById("year").value})});
      previewData=j.matches||[];
      msg.innerHTML='<span class="ok">Terbaca <b>'+previewData.length+'</b> pertandingan.</span>'+(j.errors&&j.errors.length?' <span class="err">'+j.errors.length+' baris gagal dibaca.</span>':'');
      renderPreview();
    }catch(e){msg.innerHTML='<span class="err">'+E(e.message)+'</span>'}
  }
  function renderPreview(){
    var panel=document.getElementById("previewPanel");
    if(!previewData.length){panel.classList.add("hidden");return}
    panel.classList.remove("hidden");
    document.getElementById("previewCount").textContent=previewData.length+" pertandingan siap dipublikasikan";
    document.getElementById("metricMatch").textContent=previewData.length;
    document.getElementById("metricLeague").textContent=new Set(previewData.map(function(x){return x.league})).size;
    document.getElementById("metricFav").textContent=previewData.filter(function(x){return x.favorite!=="Seimbang"}).length;
    document.getElementById("previewRows").innerHTML=previewData.map(function(x){
      return '<tr><td>'+E(x.league)+'</td><td>'+E(x.date_display)+'</td><td>'+E(x.kickoff)+'</td><td><b>'+E(x.home)+'</b> vs <b>'+E(x.away)+'</b></td><td>'+E(x.handicap)+'</td><td class="fav">'+E(x.favorite)+'</td><td class="pick">'+E(x.prediction)+'</td><td><b>'+E(x.score)+'</b></td></tr>';
    }).join("");
  }
  async function publishAll(){
    if(!previewData.length)return;
    try{
      await api("/api/matches/bulk",{method:"POST",body:JSON.stringify({matches:previewData})});
      alert(previewData.length+" pertandingan berhasil dipublikasikan.");
      previewData=[];renderPreview();loadSaved();
    }catch(e){alert(e.message)}
  }
  async function loadSaved(){
    try{
      var j=await api("/api/matches"),d=j.matches||[];
      document.getElementById("savedCount").textContent=d.length+" pertandingan tersimpan";
      document.getElementById("savedRows").innerHTML=d.length?d.map(function(x){
        return '<tr><td>'+E(x.league)+'</td><td>'+E(x.date_display)+'</td><td>'+E(x.kickoff)+'</td><td><b>'+E(x.home)+'</b> vs <b>'+E(x.away)+'</b></td><td>'+E(x.handicap)+'</td><td class="pick">'+E(x.prediction)+'</td><td><b>'+E(x.score)+'</b></td><td><button class="danger" data-delete="'+E(x.id)+'">Hapus</button></td></tr>';
      }).join(""):'<tr><td colspan="8">Belum ada data.</td></tr>';
      document.querySelectorAll("[data-delete]").forEach(function(b){b.addEventListener("click",function(){delMatch(b.getAttribute("data-delete"))})});
    }catch(e){}
  }
  async function delMatch(id){
    if(!confirm("Hapus pertandingan ini?"))return;
    await api("/api/matches/"+id,{method:"DELETE"});loadSaved();
  }
  async function clearAll(){
    if(!confirm("Hapus SEMUA pertandingan?"))return;
    await api("/api/matches",{method:"DELETE"});loadSaved();
  }
  document.getElementById("loginBtn").addEventListener("click",login);
  document.getElementById("pass").addEventListener("keydown",function(e){if(e.key==="Enter")login()});
  document.getElementById("logoutBtn").addEventListener("click",logout);
  document.getElementById("previewBtn").addEventListener("click",preview);
  document.getElementById("rerollBtn").addEventListener("click",preview);
  document.getElementById("publishBtn").addEventListener("click",publishAll);
  document.getElementById("clearInputBtn").addEventListener("click",function(){document.getElementById("bulk").value=""});
  document.getElementById("clearAllBtn").addEventListener("click",clearAll);
  checkAuth();
})();
</script>
</body>
</html>`;

async function handleApi(req, env, url) {
  const path = url.pathname;

  if (path === "/api/login" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
      return J({ error: "Secret admin belum dikonfigurasi di Cloudflare." }, 500);
    }
    if (!eq(body.username, env.ADMIN_USERNAME) || !eq(body.password, env.ADMIN_PASSWORD)) {
      return J({ error: "Username atau password salah." }, 401);
    }
    const token = await makeSession(env);
    return J({ ok: true }, 200, {
      "set-cookie": "bp_session=" + encodeURIComponent(token) + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200"
    });
  }

  if (path === "/api/logout" && req.method === "POST") {
    return J({ ok: true }, 200, {
      "set-cookie": "bp_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
    });
  }

  if (path === "/api/me" && req.method === "GET") {
    return J({ authenticated: await isAdmin(req, env) });
  }

  if (path === "/api/matches" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, league, match_date, date_display, kickoff, home, away, handicap, favorite, prediction, score, created_at FROM matches ORDER BY match_date ASC, kickoff ASC, id ASC"
    ).all();
    return J({ matches: results || [] });
  }

  if (path === "/api/parse" && req.method === "POST") {
    if (!(await isAdmin(req, env))) return J({ error: "Login admin diperlukan." }, 401);
    const body = await req.json().catch(() => ({}));
    const year = String(body.year || new Date().getFullYear());
    return J(parseBulk(body.raw, year));
  }

  if (path === "/api/matches/bulk" && req.method === "POST") {
    if (!(await isAdmin(req, env))) return J({ error: "Login admin diperlukan." }, 401);
    const body = await req.json().catch(() => ({}));
    const matches = Array.isArray(body.matches) ? body.matches : [];
    if (!matches.length) return J({ error: "Tidak ada pertandingan untuk disimpan." }, 400);
    if (matches.length > 300) return J({ error: "Maksimal 300 pertandingan per publish." }, 400);

    const stmts = [];
    for (const x of matches) {
      const league = String(x.league || "").slice(0, 120);
      const matchDate = String(x.match_date || "").slice(0, 10);
      const dateDisplay = String(x.date_display || "").slice(0, 10);
      const kickoff = String(x.kickoff || "").slice(0, 5);
      const home = String(x.home || "").slice(0, 120);
      const away = String(x.away || "").slice(0, 120);
      const handicap = String(x.handicap || "").slice(0, 30);
      const favorite = String(x.favorite || "").slice(0, 120);
      const prediction = String(x.prediction || "").slice(0, 160);
      const scoreValue = String(x.score || "").slice(0, 20);

      stmts.push(
        env.DB.prepare(
          "DELETE FROM matches WHERE league=? AND match_date=? AND kickoff=? AND home=? AND away=?"
        ).bind(league, matchDate, kickoff, home, away)
      );
      stmts.push(
        env.DB.prepare(
          "INSERT INTO matches (league, match_date, date_display, kickoff, home, away, handicap, favorite, prediction, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(league, matchDate, dateDisplay, kickoff, home, away, handicap, favorite, prediction, scoreValue)
      );
    }
    await env.DB.batch(stmts);
    return J({ ok: true, inserted: matches.length });
  }

  const idMatch = path.match(/^\/api\/matches\/(\d+)$/);
  if (idMatch && req.method === "DELETE") {
    if (!(await isAdmin(req, env))) return J({ error: "Login admin diperlukan." }, 401);
    await env.DB.prepare("DELETE FROM matches WHERE id=?").bind(Number(idMatch[1])).run();
    return J({ ok: true });
  }

  if (path === "/api/matches" && req.method === "DELETE") {
    if (!(await isAdmin(req, env))) return J({ error: "Login admin diperlukan." }, 401);
    await env.DB.prepare("DELETE FROM matches").run();
    return J({ ok: true });
  }

  return J({ error: "Not found" }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(req, env, url);
      if (url.pathname === "/admin") return H(ADMIN);
      if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/jadwal-bola" || url.pathname === "/prediksi-bola") {
        return H(PUBLIC);
      }
      return H("<h1>404</h1>", 404);
    } catch (err) {
      return J({ error: "Server error", detail: String(err && err.message ? err.message : err) }, 500);
    }
  }
};
