'use strict';
/* Palabras — Duolingo kelimeleriyle eşleştirme oyunu + kart modu.
   Tüm veri telefonda (localStorage). Sunucu yok. */

const KEY = 'palabras.v2';
const DAY = 86400000;
const BOX_DAYS = [0, 1, 3, 7, 16, 35];   // Leitner kutuları → gün
const PAIRS = 5;                           // tahtadaki çift sayısı
const REFILL_AT = 2;                       // kaç çift boşalınca yeni kart gelsin
const TRAIN_SIZE = 20;
const MIST_EXIT = 2;                       // hatalardan çıkmak için art arda ilk denemede doğru

const $ = id => document.getElementById(id);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const norm = s => s.toLocaleLowerCase('tr').trim();

/* ---------------- veri ---------------- */
const blank = () => ({
  cards: {},
  opts: { section: 'all', newPerDay: 20, dir: 'es', tts: '1', tags: '1', art: '1' },
  day: { date: '', newSeen: 0 },
  records: {},
  games: 0,
});
let db;
function load() {
  try { db = JSON.parse(localStorage.getItem(KEY)) || blank(); } catch { db = blank(); }
  const b = blank();
  db.opts = Object.assign(b.opts, db.opts || {});
  db.day = db.day || b.day; db.records = db.records || {}; db.cards = db.cards || {};
  db.nums = db.nums || {};
  db.listen = db.listen || {}; db.conj = db.conj || {};
  db.stats = db.stats || {};
}
/* Kayıt ertelenir: tüm veri (~850 KB) her dokunuşta yazılınca ana iş parçacığı 40–70 ms donuyordu.
   Artık değişiklikler toplanır, 1,5 sn sessizlikte ya da uygulama arka plana geçerken tek seferde yazılır. */
let saveTimer = 0;
function saveNow() {
  clearTimeout(saveTimer); saveTimer = 0;
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch { alert('Kaydedilemedi: depolama dolu olabilir. Ayarlar → Yedeği indir.'); }
}
function save() {
  clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 1500);
  if (typeof window.onSaved === 'function') window.onSaved();   // bulut yedeği (modes.js)
}
const flushSave = () => { if (saveTimer) saveNow(); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
window.addEventListener('pagehide', flushSave);

/* ---------------- istatistik ----------------
   Gün başına doğru cevap sayısı, cihaz bazında (bulut yedeğinde cihazlar toplanır). */
const DEVICE = (() => { try { let d = localStorage.getItem('palabras.device'); if (!d) { d = Math.random().toString(36).slice(2, 10); localStorage.setItem('palabras.device', d); } return d; } catch { return 'local'; } })();
function bump(n = 1) {
  const day = todayStr();
  const s = (db.stats[DEVICE] = db.stats[DEVICE] || {});
  s[day] = (s[day] || 0) + n;
}
function dayTotal(day) { let n = 0; for (const dev of Object.values(db.stats)) n += dev[day] || 0; return n; }
function dayStr(offset) { const d = new Date(); d.setDate(d.getDate() - offset); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
function streak() {
  let n = 0, i = dayTotal(dayStr(0)) ? 0 : 1;      // bugün henüz oynamadıysan seri dünden sayılır
  while (dayTotal(dayStr(i)) > 0) { n++; i++; }
  return n;
}
function weekTotal() { let n = 0; for (let i = 0; i < 7; i++) n += dayTotal(dayStr(i)); return n; }

/* ---------------- artikel ---------------- */
const EL_FEM = new Set(['agua', 'aula', 'arma', 'hambre', 'águila', 'alma', 'área', 'hacha', 'ala', 'ancla', 'agua mineral']);
const NO_ART = new Set(['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre', 'costa rica']);
function articleOf(c) {
  if (c.num || db.opts.art !== '1' || NO_ART.has(c.es) || /^[A-ZÁÉÍÓÚÑ]/.test(c.es) || /^(el|la|los|las|un|una) /.test(c.es)) return '';
  const t = TAGS[c.es] ? TAGS[c.es].t : '';
  if (t === 'm.') return 'el';
  if (t === 'f.') return EL_FEM.has(c.es) ? 'el' : 'la';
  if (t === 'm. pl.') return 'los';
  if (t === 'f. pl.') return 'las';
  if (t === 'm./f.') return 'el/la';
  return '';
}
const disp = c => { const a = articleOf(c); return a ? `${a} ${c.es}` : c.es; };
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

/* ---------------- etiketler ---------------- */
// GitHub Pages'te çalışırken veri dosyaları raw.githubusercontent.com'dan alınır:
// pazartesi botunun commit'lediği son hal, Pages'in yeniden yayınlanmasını beklemeden gelir.
const RAW_BASE = (() => {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return m && repo ? `https://raw.githubusercontent.com/${m[1]}/${repo}/main/` : '';
})();
let TAGS = {};
async function loadTags() {
  for (const url of [RAW_BASE && RAW_BASE + 'tags.json?t=' + Date.now(), 'tags.json'].filter(Boolean)) {
    try { const r = await fetch(url, { cache: 'no-store' }); if (r.ok) { TAGS = await r.json(); refreshAll(); return; } } catch {}
  }
}
loadTags();
// örnek cümleler (pazartesi botu üretir): { kelime: [ispanyolca cümle, türkçesi] }
let EX = {};
async function loadExamples() {
  for (const url of [RAW_BASE && RAW_BASE + 'examples.json?t=' + Date.now(), 'examples.json'].filter(Boolean)) {
    try { const r = await fetch(url, { cache: 'no-store' }); if (r.ok) { EX = await r.json(); return; } } catch {}
  }
}
loadExamples();

function guessTag(es) {
  const w = es.toLowerCase();
  if (w.includes(' ')) return 'loc.';
  if (/(ción|sión|dad|tad|tud|umbre)$/.test(w)) return 'f.';
  if (/mente$/.test(w)) return 'adv.';
  if (/(arse|erse|irse)$/.test(w)) return 'v. prnl.';
  if (w.length > 3 && /(ar|er|ir)$/.test(w)) return 'v.';
  return '';
}
function tagOf(c) {
  if (c.num) return '';
  const t = TAGS[c.es];
  if (t) return t.l ? `${t.t} (${t.l})` : t.t;
  return guessTag(c.es);
}
const trOf = c => c.num ? c.tr : ((TAGS[c.es] && TAGS[c.es].b) || c.tr);
const isVerb = c => /^(v\.|part\.)/.test(TAGS[c.es] ? TAGS[c.es].t : guessTag(c.es));

/* ---------------- sayılar ----------------
   1–100 ve 200, 300 … 1000. İlerleme kelimelerden ayrı tutulur (db.nums),
   böylece "dos", "cien" gibi kelime kartlarıyla karışmaz. */
const ES_1_29 = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
  'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte',
  'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const ES_TENS = { 3: 'treinta', 4: 'cuarenta', 5: 'cincuenta', 6: 'sesenta', 7: 'setenta', 8: 'ochenta', 9: 'noventa' };
const ES_HUNDREDS = { 100: 'cien', 200: 'doscientos', 300: 'trescientos', 400: 'cuatrocientos', 500: 'quinientos',
  600: 'seiscientos', 700: 'setecientos', 800: 'ochocientos', 900: 'novecientos', 1000: 'mil' };
function numEs(n) {
  if (ES_HUNDREDS[n]) return ES_HUNDREDS[n];
  if (n < 30) return ES_1_29[n];
  const t = Math.floor(n / 10), u = n % 10;
  return u ? `${ES_TENS[t]} y ${ES_1_29[u]}` : ES_TENS[t];
}
const NUM_LIST = [...Array.from({ length: 100 }, (_, i) => i + 1), 200, 300, 400, 500, 600, 700, 800, 900, 1000];
const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MONTHS_TR = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const ORDINALS = ['primero', 'segundo', 'tercero', 'cuarto', 'quinto', 'sexto', 'séptimo', 'octavo', 'noveno', 'décimo'];
const hourEs = h => h === 1 ? 'la una' : 'las ' + numEs(h);
function timeEs(h, m) {
  if (m === 0) return `${hourEs(h)} en punto`;
  if (m <= 30) return `${hourEs(h)} y ${m === 15 ? 'cuarto' : m === 30 ? 'media' : numEs(m)}`;
  const nh = h === 12 ? 1 : h + 1, r = 60 - m;
  return `${hourEs(nh)} menos ${r === 15 ? 'cuarto' : numEs(r)}`;
}
// db.nums: sayılar (kind yok/'num'), saatler ('time'), sıra sayıları ('ord'), tarihler ('date')
function numEntry(es, tr, kind, order) {
  if (!db.nums[es]) db.nums[es] = { es, tr, num: true, kind, box: 0, due: 0, seen: false, wrong: 0, mist: false, mstreak: 0, order };
  else if (!db.nums[es].kind) db.nums[es].kind = kind;
}
function ensureNums() {
  if (ensureNums.done) return; ensureNums.done = true;
  NUM_LIST.forEach((n, i) => numEntry(numEs(n), String(n), 'num', i));
  let i = 0;
  for (let h = 1; h <= 12; h++) for (let m = 0; m < 60; m += 5) numEntry(timeEs(h, m), `${h}:${String(m).padStart(2, '0')}`, 'time', i++);
  ORDINALS.forEach((o, k) => numEntry(o, `${k + 1}.`, 'ord', k));
  i = 0;
  MONTHS_ES.forEach((mes, mi) => { for (let d = 1; d <= MONTH_DAYS[mi]; d++) numEntry(`el ${d === 1 ? 'primero' : numEs(d)} de ${mes}`, `${d} ${MONTHS_TR[mi]}`, 'date', i++); });
}
const numsOf = kind => { ensureNums(); return Object.values(db.nums).filter(c => (c.kind || 'num') === kind); };

/* ---------------- son üniteler ---------------- */
const unitKey = c => c.unit ? c.unit.sec * 1000 + c.unit.no : -1;
function recentUnits(n) {
  const keys = [...new Set(Object.values(db.cards).map(unitKey).filter(k => k > 0))].sort((a, b) => b - a).slice(0, n);
  return new Set(keys);
}
function recentPool(n) { const ks = recentUnits(n); return Object.values(db.cards).filter(c => ks.has(unitKey(c))); }
function unitLabel(key) { return `${Math.floor(key / 1000)}. Kısım ${key % 1000}. Ünite`; }

/* ---------------- konu havuzları ----------------
   Her konu: başlık, kart deposu (kelimeler ya da sayılar), havuz ve tur destesi. */
// secs olan konular süreli oynanır (geri sayım + konuya özel rekor); olmayanlar 20'lik tur.
const TOPIC_SECS = 90;
const TOPICS = {
  verbs: { title: 'Fiiller', secs: TOPIC_SECS, store: () => db.cards, pool: () => pool().filter(isVerb) },
  nums:  { title: 'Sayılar', store: () => db.nums, pool: () => numsOf('num'), deck: p => buildTrainDeck(p) },
  times: { title: 'Saatler', store: () => db.nums, pool: () => numsOf('time'), deck: p => buildTrainDeck(p) },
  ords:  { title: 'Sıra sayıları', store: () => db.nums, pool: () => numsOf('ord'), deck: p => buildTrainDeck(p) },
  dates: { title: 'Tarihler', store: () => db.nums, pool: () => numsOf('date'), deck: p => buildTrainDeck(p) },
  r3:    { title: 'Son 3 ünite', secs: TOPIC_SECS, store: () => db.cards, pool: () => recentPool(3) },
  r5:    { title: 'Son 5 ünite', secs: TOPIC_SECS, store: () => db.cards, pool: () => recentPool(5) },
  r7:    { title: 'Son 7 ünite', secs: TOPIC_SECS, store: () => db.cards, pool: () => recentPool(7) },
};
const recKey = id => 'topic-' + id;
const recOf = key => db.records[key] ? db.records[key].best : null;

/* ---------------- CSV import ---------------- */
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split('\n')[0];
  const delim = first.includes('\t') && !first.includes(',') ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); f = ''; if (row.some(x => x.trim())) rows.push(row); row = [];
    } else f += c;
  }
  row.push(f); if (row.some(x => x.trim())) rows.push(row);
  if (rows.length && /^(front|es|spanish|ispanyolca|word)$/i.test((rows[0][0] || '').trim())) rows.shift();
  return rows;
}
const UNIT_RE = /(\d+)\. Kısım (\d+)\. Ünite(?: – (.*))?/;
function importRows(rows) {
  let added = 0, updated = 0;
  for (const r of rows) {
    const es = (r[0] || '').trim(), tr = (r[1] || '').trim();
    if (!es || !tr) continue;
    let alt = (r[2] || '').trim(), unit = null;
    const m = alt.match(UNIT_RE);
    if (m) { unit = { sec: +m[1], no: +m[2], title: (m[3] || '').trim() }; alt = alt.replace(/\s*\|?\s*\d+\. Kısım \d+\. Ünite.*$/, '').trim(); }
    const old = db.cards[es];
    if (old) { old.tr = tr; if (alt) old.alt = alt; if (unit) old.unit = unit; updated++; }
    else {
      db.cards[es] = { es, tr, alt, unit, box: 0, due: 0, seen: false, wrong: 0, mist: false, mstreak: 0, order: Object.keys(db.cards).length };
      added++;
    }
  }
  save();
  return { added, updated };
}

/* ---------------- tekrar mantığı (Leitner) ---------------- */
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
function eod() { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); }
function rollDay() { if (db.day.date !== todayStr()) { db.day = { date: todayStr(), newSeen: 0 }; save(); } }
function dueAt(box) { const d = new Date(); d.setHours(4, 0, 0, 0); return d.getTime() + BOX_DAYS[box] * DAY; }
const isDue = c => c.seen && c.due <= eod();
const newLeft = () => { rollDay(); return Math.max(0, db.opts.newPerDay - db.day.newSeen); };
const inPool = c => db.opts.section === 'all' || (c.unit && String(c.unit.sec) === db.opts.section);
const pool = () => Object.values(db.cards).filter(inPool);

// Günlük yeni kelime limiti sadece kart modunu sınırlar; kelimeler zaten Duolingo'da görüldü,
// oyunlar bu hakkı tüketmez.
function markNewSeen(c, countDaily) { if (!c.seen) { c.seen = true; if (countDaily) { rollDay(); db.day.newSeen++; } } }
// doğru cevap; step: kaç kutu ilerlesin (0 = yerinde kal)
function onRight(c, step = 1, countDaily = false) {
  c.mod = Date.now(); bump();
  const wasNew = !c.seen;
  markNewSeen(c, countDaily);
  if (wasNew) { c.box = Math.max(1, step); c.due = dueAt(c.box); }
  else if (c.due <= eod()) { c.box = Math.min(5, Math.max(1, c.box + step)); c.due = dueAt(c.box); }
  // vakti gelmemiş kelimeyi bugün tekrar bilmek kutuyu ilerletmez
  if (c.mist && ++c.mstreak >= MIST_EXIT) { c.mist = false; c.mstreak = 0; }
}
function onWrong(c, countDaily = false) {
  c.mod = Date.now();
  markNewSeen(c, countDaily);
  c.box = 0; c.due = Date.now(); c.wrong++; c.mist = true; c.mstreak = 0; c.lastWrong = Date.now();
}

/* ---------------- ses ----------------
   Önce Duolingo'nun kendi ses kaydı (<audio> ile çalınır: iPhone sessiz moddayken de duyulur),
   kaydı olmayanlarda (sayılar, çekimler) cihazın konuşma sentezi.
   audioSession = 'playback': iOS 17+ Safari'de sayfanın sesini sessiz mod anahtarından bağımsız yapar. */
try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
let voice = null;
function pickVoice() { const v = speechSynthesis.getVoices(); voice = v.find(x => x.lang === 'es-ES') || v.find(x => /^es/i.test(x.lang)) || null; }
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
const AUD = typeof Audio !== 'undefined' ? new Audio() : null;
if (AUD) { AUD.preload = 'auto'; AUD.setAttribute('playsinline', ''); }
function tts(text, rate = 0.9) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text); u.lang = 'es-ES'; if (voice) u.voice = voice; u.rate = rate;
  speechSynthesis.speak(u);
}
function audioFor(text) { const c = db.cards[text]; return c && c.audio ? c.audio : ''; }
/* Ses çalma, iki yol:
   1) Web Audio (asıl yol): kelime tahtaya gelince kaydı indirilip çözülür ve bellekte hazır bekler;
      dokununca start() ile milisaniyeler içinde çalar. iPhone'da <audio>.play() ayrıca 150–400 ms
      başlama gecikmesi taşıyor, ayrıca iOS önceden yüklemeyi (preload) çoğu zaman yok sayıyor.
      Sessiz modda da duyulması navigator.audioSession = 'playback' sayesinde (iOS 17+).
   2) Kayıt henüz hazır değilse, indirilemiyorsa ya da yavaş dinlemede: eski <audio> yolu. */
const AC = window.AudioContext || window.webkitAudioContext;
const WEB_AUDIO = !!AC && (!/iPhone|iPad|iPod/.test(navigator.userAgent) || !!navigator.audioSession);   // eski iOS'ta sessiz mod için <audio>
let actx = null;
const ctx = () => actx || (actx = new AC());
const BUF = new Map();     // url → AudioBuffer | null (null = indirilemedi) ; en yeni sonda
const LOADING = new Set();
function loadBuf(url) {
  if (!WEB_AUDIO || BUF.has(url) || LOADING.has(url)) return;
  LOADING.add(url);
  fetch(url, { mode: 'cors' })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
    .then(ab => new Promise((res, rej) => ctx().decodeAudioData(ab, res, rej)))
    .then(b => BUF.set(url, b), () => BUF.set(url, null))
    .finally(() => {
      LOADING.delete(url);
      while (BUF.size > 120) BUF.delete(BUF.keys().next().value);
    });
}
// iOS ses bağlamını ancak bir dokunuş sırasında açar: ilk dokunuşta aç, sonra açık kalır
function unlockAudio() { if (!WEB_AUDIO) return; const c = ctx(); if (c.state !== 'running') c.resume().catch(() => {}); }
['pointerdown', 'touchend', 'click'].forEach(t => document.addEventListener(t, unlockAudio, { capture: true, passive: true }));
function preloadAudio(texts) {
  for (const t of texts) { const u = t && audioFor(t); if (u) loadBuf(u); }
}
let playingSrc = null;
function stopAll() {
  if (playingSrc) { try { playingSrc.stop(); } catch {} playingSrc = null; }
  if (AUD && !AUD.paused) AUD.pause();
  try { if ('speechSynthesis' in window && speechSynthesis.speaking) speechSynthesis.cancel(); } catch {}
}
function speak(text, force, slow) {
  if (!force && db.opts.tts !== '1') return;
  const url = audioFor(text);
  if (!url || !AUD) { stopAll(); tts(text, slow ? 0.6 : 0.9); return; }
  stopAll();
  const buf = BUF.get(url);
  if (buf && !slow) {
    const c = ctx(); if (c.state !== 'running') c.resume().catch(() => {});
    const src = c.createBufferSource(); src.buffer = buf; src.connect(c.destination); src.start(0);
    playingSrc = src;
    return;
  }
  loadBuf(url);   // bir dahaki sefere hazır olsun
  AUD.src = url; AUD.playbackRate = slow ? 0.7 : 1;
  const p = AUD.play(); if (p && p.catch) p.catch(() => tts(text, slow ? 0.6 : 0.9));
}

/* ---------------- navigasyon ---------------- */
let view = 'home';
const TABS = ['home', 'play', 'cards', 'words', 'settings'];
let lastTab = 'home';            // oyundan çıkınca dönülecek sekme
const isMenu = v => v === 'play' || v === 'home';
function go(v) {
  view = v;
  if (TABS.includes(v)) lastTab = v;
  document.body.classList.toggle('ingame', v === 'game' || v === 'mc' || v === 'result');
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('on', s.id === 'v-' + v));
  if (typeof onView === 'function') onView(v);
  if (isMenu(v)) renderMenu();
  if (v === 'cards') fcStart();
  if (v === 'words') renderList();
  if (v === 'settings') { bindSettings(); syncInfo(); }
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => go(b.dataset.v));
function refreshAll() { if (isMenu(view)) renderMenu(); if (view === 'words') renderList(); }

/* ---------------- menü ---------------- */
function renderMenu() {
  const p = pool();
  $('st-total').textContent = p.length;
  $('st-due').textContent = p.filter(isDue).length;
  $('st-known').textContent = p.filter(c => c.box >= 3).length;
  for (const s of ['60', '180', '300']) document.querySelector(`[data-rec="${s}"]`).textContent = db.records[s] ? db.records[s].best : '–';
  const mc = p.filter(c => c.mist).length;
  $('mist-count').textContent = mc;
  $('go-mist').disabled = !mc;
  $('play-empty').hidden = p.length > 0;
  document.querySelectorAll('[data-timed]').forEach(b => b.disabled = p.length < 2);
  $('go-train').disabled = p.length < 2;
  renderMistList(p);
  renderTopics();
}

function renderTopics() {
  const vp = TOPICS.verbs.pool();
  const vr = recOf(recKey('verbs'));
  $('verbs-sub').textContent = `${vp.length} fiil · 90 sn · Rekor ${vr ?? '–'}` + (vp.some(c => c.mist) ? ` · ${vp.filter(c => c.mist).length} hata` : '');
  $('go-verbs').disabled = vp.length < 2;
  for (const id of ['nums', 'times', 'ords', 'dates']) {
    const nm = TOPICS[id].pool().filter(c => c.mist).length;
    const el = document.querySelector(`[data-numtopic="${id}"] .rec`);
    if (el) el.textContent = nm ? `${nm} hata` : '20\'lik tur';
  }
  for (const n of [3, 5, 7]) {
    const ks = [...recentUnits(n)].sort((a, b) => a - b);
    const cnt = recentPool(n).length;
    const b = document.querySelector(`[data-recent="${n}"]`);
    b.disabled = cnt < 2;
    b.querySelector('.cnt').textContent = cnt ? `${cnt} kelime` : '–';
    b.querySelector('.rec').textContent = `Rekor ${recOf(recKey('r' + n)) ?? '–'}`;
  }
  const top = [...recentUnits(1)][0];
  if (typeof renderExtras === 'function') renderExtras();
  if (typeof renderHome === 'function') renderHome();
  $('recent-note').textContent = top ? `En son ünite: ${unitLabel(top)} · 90 saniyelik oyun, sadece seçilen ünitelerin kelimeleri.` : '';
}

/* Hatalarım listesi: şimdiye kadar yanlış eşleştirdiğin bütün kelimeler.
   Hâlâ hatalı olanlar üstte (en çok hata yapılan önce); düzelttiklerin altta, soluk. */
let mistAll = false;
const MIST_SHOW = 15;
function renderMistList(p) {
  const list = (p || pool()).filter(c => c.wrong > 0)
    .sort((a, b) => (b.mist - a.mist) || (b.wrong - a.wrong) || ((b.lastWrong || 0) - (a.lastWrong || 0)));
  const el = $('mist-list'); el.innerHTML = '';
  if (!list.length) { el.innerHTML = '<p class="note">Henüz hata yok 🎉 Oyunlarda yanlış eşleştirdiğin kelimeler burada birikir.</p>'; $('mist-more').hidden = true; return; }
  const frag = document.createDocumentFragment();
  for (const c of mistAll ? list : list.slice(0, MIST_SHOW)) {
    const d = document.createElement('div'); d.className = 'mi' + (c.mist ? '' : ' done');
    const l = document.createElement('div'); l.className = 'l'; l.textContent = disp(c);
    if (db.opts.tags === '1') { const t = tagOf(c); if (t) { const s = document.createElement('small'); s.textContent = t; l.appendChild(s); } }
    const n = document.createElement('span'); n.className = 'n';
    n.textContent = c.mist ? `${c.wrong} hata` : `${c.wrong} hata · düzeldi ✓`;
    l.appendChild(n);
    const r = document.createElement('div'); r.className = 'r'; r.textContent = trOf(c);
    d.append(l, r); d.onclick = () => speak(c.es, true); frag.appendChild(d);
  }
  el.appendChild(frag);
  const more = $('mist-more');
  more.hidden = list.length <= MIST_SHOW;
  more.textContent = mistAll ? 'Daha az göster' : `Tümünü göster (${list.length})`;
}
$('mist-more').onclick = () => { mistAll = !mistAll; renderMistList(); };

/* ---------------- eşleştirme oyunu ---------------- */
/* G: aktif oyun durumu
   mode: 'timed' | 'train' | 'mist' | 'topic'
   L, R: 5 yuva; her yuva bir kart anahtarı (es) ya da null
   store: kartların tutulduğu depo (kelimeler db.cards, sayılar db.nums)
   deck: süreli olmayan modlar için sıralı deste; timed için ağırlıklı seçim  */
let G = null;

function startGame(mode, arg) {
  const topic = mode === 'topic' ? TOPICS[arg] : null;
  const p = topic ? topic.pool() : pool();
  if (p.length < 2) return;
  const secs = mode === 'timed' ? arg : topic && topic.secs ? topic.secs : 0;
  if (secs) mode = 'timed';
  G = { mode, secs, topicId: topic ? arg : null, store: topic ? topic.store() : db.cards, poolFn: topic ? topic.pool : pool,
        L: Array(PAIRS).fill(null), R: Array(PAIRS).fill(null), sel: null, busy: false,
        score: 0, wrong: 0, combo: 0, bestCombo: 0, cleared: 0, wrongSet: new Map(), recent: [],
        usedThisGame: new Set(), deck: [], total: 0, start: 0, timer: null, over: false, lockedTap: false };
  if (mode === 'train') G.deck = buildTrainDeck(p);
  if (mode === 'mist') G.deck = buildMistDeck(p);
  if (topic && mode !== 'timed') G.deck = topic.deck(p);
  G.total = mode === 'timed' ? 0 : G.deck.filter(x => !x.filler).length;
  $('g-time').hidden = mode !== 'timed';
  $('g-prog').hidden = mode === 'timed';
  $('g-score').textContent = '0'; $('g-combo').textContent = '';
  go('game');
  refill(true);
  render(true);
  if (mode === 'timed') countdown(() => { G.start = performance.now(); tick(); G.timer = setInterval(tick, 200); });
  else { G.start = performance.now(); updateProg(); }
}

// Tur destesi: birkaç hata (tekrar etsin) → tekrar zamanı gelenler → hiç görülmemişler →
// (hepsi görüldüyse) en uzun zamandır çalışılmayanlar. Az önce doğru bildiğin kelime, görülmemiş kelime
// kaldıkça bir sonraki turda tekrar gelmez.
function buildTrainDeck(p) {
  const mist = shuffle(p.filter(c => c.mist)).slice(0, 6);
  const due = shuffle(p.filter(c => isDue(c) && !c.mist));
  const fresh = shuffle(p.filter(c => !c.seen));
  const rest = shuffle(p.filter(c => c.seen && !c.mist && !isDue(c))).sort((a, b) => (a.mod || 0) - (b.mod || 0));
  const picks = [...new Map([...mist, ...due, ...fresh, ...rest].map(c => [c.es, c])).values()].slice(0, TRAIN_SIZE);
  return shuffle(picks).map(c => ({ es: c.es, filler: false }));
}
function buildMistDeck(p) {
  const mist = shuffle(p.filter(c => c.mist)).slice(0, TRAIN_SIZE);
  const deck = mist.map(c => ({ es: c.es, filler: false }));
  // tahta 5 çiftle dolsun diye gerekirse "dolgu" kelimeler (ilerlemeyi etkilemez)
  const need = Math.max(0, PAIRS * 2 - deck.length);
  const fill = shuffle(p.filter(c => !c.mist && c.seen)).slice(0, need);
  const fill2 = need > fill.length ? shuffle(p.filter(c => !c.mist && !c.seen)).slice(0, need - fill.length) : [];
  return interleave(deck, [...fill, ...fill2].map(c => ({ es: c.es, filler: true })));
}
function interleave(a, b) { const out = []; while (a.length || b.length) { if (a.length) out.push(a.shift()); if (b.length) out.push(b.shift()); } return out; }

// tahtada aynı İspanyolca ya da aynı Türkçe karşılık olmasın
function boardKeys(extra = []) {
  const es = new Set(), tr = new Set();
  for (const k of [...G.L, ...extra]) if (k) { es.add(k); tr.add(norm(trOf(G.store[k]))); }
  return { es, tr };
}
function fits(c, keys) { return !keys.es.has(c.es) && !keys.tr.has(norm(trOf(c))); }

function nextTimed(keys) {
  const p = G.poolFn();
  const recent = new Set(G.recent.slice(-12));
  const score = c => c.mist ? 6 : isDue(c) ? 4 : !c.seen ? 2 : 1;
  let cands = p.filter(c => fits(c, keys) && !recent.has(c.es) && score(c) > 0);
  if (!cands.length) cands = p.filter(c => fits(c, keys) && score(c) > 0);
  if (!cands.length) cands = p.filter(c => fits(c, keys));
  if (!cands.length) return null;
  let sum = 0; const w = cands.map(c => (sum += score(c) ** 2));
  const r = Math.random() * sum;
  return cands[w.findIndex(x => x >= r)];
}
function nextFromDeck(keys) {
  for (let i = 0; i < G.deck.length; i++) {
    const c = G.store[G.deck[i].es];
    if (c && fits(c, keys)) return { c, filler: G.deck.splice(i, 1)[0].filler };
  }
  return null;
}

// boş yuvaları doldur: yeni sol kartlar boş sol yuvalara, sağ kartlar boş sağ yuvalara karışık dağılır
function refill(initial) {
  const emptyL = G.L.map((k, i) => k ? -1 : i).filter(i => i >= 0);
  if (!emptyL.length) return;
  const live = PAIRS - emptyL.length;
  if (!initial && emptyL.length < REFILL_AT && live > 0) return;
  const batch = [];
  const keys = boardKeys();
  for (let n = 0; n < emptyL.length; n++) {
    let pick = null;
    if (G.mode === 'timed') { const c = nextTimed(keys); if (c) pick = { c, filler: false }; }
    else pick = nextFromDeck(keys);
    if (!pick) break;
    batch.push(pick); keys.es.add(pick.c.es); keys.tr.add(norm(trOf(pick.c)));
  }
  if (!batch.length) return;
  const emptyR = G.R.map((k, i) => k ? -1 : i).filter(i => i >= 0);
  const ls = shuffle(emptyL.slice()), rs = shuffle(emptyR.slice());
  // aynı çiftin iki kartı aynı satıra düşmesin (mümkünse)
  for (let tries = 0; tries < 8 && batch.length > 1 && batch.some((_, i) => ls[i] === rs[i]); tries++) shuffle(rs);
  batch.forEach((b, i) => {
    G.L[ls[i]] = b.c.es; G.R[rs[i]] = b.c.es;
    G.fresh = (G.fresh || new Set()); G.fresh.add('L' + ls[i]); G.fresh.add('R' + rs[i]);
    if (b.filler) (G.fillers = G.fillers || new Set()).add(b.c.es);
    G.recent.push(b.c.es);
  });
}

function fit(el, text) {
  el.classList.toggle('long', text.length > 14 && text.length <= 22);
  el.classList.toggle('xlong', text.length > 22);
}
function render(all) {
  const board = $('board');
  if (all || board.children.length !== PAIRS * 2) {
    board.innerHTML = '';
    for (let i = 0; i < PAIRS; i++) for (const side of ['L', 'R']) {
      const b = document.createElement('button');
      b.className = 'slot'; b.dataset.side = side; b.dataset.i = i;
      // parmak ekrana değdiği an tepki ver (click, parmak kalkınca gelir); klavye için click yedekte
      b.onpointerdown = e => { if (e.button > 0) return; e.preventDefault(); tap(side, i); };
      b.onclick = e => { if (e.detail === 0) tap(side, i); };
      board.appendChild(b);
    }
  }
  for (const el of board.children) {
    const side = el.dataset.side, i = +el.dataset.i, k = G[side][i];
    const id = side + i;
    el.classList.remove('sel', 'ok', 'bad', 'gone');
    el.classList.toggle('empty', !k);
    const isFresh = G.fresh && G.fresh.has(id);
    if (!k) { if (el.dataset.k) { el.textContent = ''; el.dataset.k = ''; } continue; }
    if (G.sel && G.sel.side === side && G.sel.i === i) el.classList.add('sel');
    if (el.dataset.k === k && !all && !isFresh) continue;      // değişmeyen kartı yeniden yazma
    el.dataset.k = k;
    const c = G.store[k];
    if (isFresh) { el.classList.remove('enter'); requestAnimationFrame(() => el.classList.add('enter')); }
    if (side === 'L') {
      const shown = disp(c); el.textContent = shown; fit(el, shown);
      // fiillerde mastar da görünür: quiero → v. (querer)
      const t = db.opts.tags === '1' ? tagOf(c) : '';
      if (t) { const s = document.createElement('span'); s.className = 'tg'; s.textContent = t; el.appendChild(s); }
    } else { const t = trOf(c); el.textContent = t; fit(el, t); }
  }
  G.fresh = new Set();
  preloadAudio(G.L);
}
const slotEl = (side, i) => $('board').querySelector(`[data-side="${side}"][data-i="${i}"]`);

function tap(side, i) {
  if (!G || G.over || G.lockedTap || !G[side][i]) return;
  if (G.mode === 'timed' && !G.start) return;
  if (!G.sel || G.sel.side === side) {
    if (G.sel && G.sel.side === side && G.sel.i === i) { G.sel = null; }
    else G.sel = { side, i };
    document.querySelectorAll('.slot.sel').forEach(e => e.classList.remove('sel'));
    if (G.sel) slotEl(side, i).classList.add('sel');
    if (side === 'L') speak(G.L[i]);
    return;
  }
  if (side === 'L') speak(G.L[i]);
  const a = G.sel, b = { side, i };
  G.sel = null;
  const li = a.side === 'L' ? a.i : b.i, ri = a.side === 'R' ? a.i : b.i;
  const lk = G.L[li], rk = G.R[ri];
  const eL = slotEl('L', li), eR = slotEl('R', ri);
  eL.classList.remove('sel'); eR.classList.remove('sel');
  if (lk === rk) match(li, ri, eL, eR);
  else miss(lk, rk, eL, eR);
}

function match(li, ri, eL, eR) {
  const k = G.L[li], c = G.store[k];
  eL.classList.add('ok'); eR.classList.add('ok');
  const firstTry = !G.wrongSet.has(k);
  const filler = G.fillers && G.fillers.has(k);
  if (firstTry && !filler) onRight(c, 1);
  else { if (firstTry && filler) markNewSeen(c); bump(); }
  save();
  G.score++; G.cleared += filler ? 0 : 1;
  G.combo = firstTry ? G.combo + 1 : 0; G.bestCombo = Math.max(G.bestCombo, G.combo);
  $('g-score').textContent = G.mode === 'timed' ? G.score : G.cleared;
  $('g-combo').textContent = G.combo >= 3 ? `🔥 ${G.combo}` : '';
  G.L[li] = null; G.R[ri] = null;
  setTimeout(() => {
    eL.classList.add('gone'); eR.classList.add('gone');
    setTimeout(() => {
      if (!G || G.over) return;
      refill(false);
      render(false);
      updateProg();
      checkEnd();
    }, 140);
  }, 170);
}
function miss(lk, rk, eL, eR) {
  G.wrong++; G.combo = 0; $('g-combo').textContent = '';
  const c = G.store[lk];
  if (!(G.fillers && G.fillers.has(lk))) { onWrong(c); G.wrongSet.set(lk, (G.wrongSet.get(lk) || 0) + 1); }
  save();
  eL.classList.add('bad'); eR.classList.add('bad');
  if (navigator.vibrate) navigator.vibrate(60);
  G.lockedTap = true;
  setTimeout(() => { eL.classList.remove('bad'); eR.classList.remove('bad'); G.lockedTap = false; }, 380);
}

function updateProg() {
  if (G.mode === 'timed') return;
  $('g-prog').firstElementChild.style.width = (G.total ? (G.cleared / G.total) * 100 : 0) + '%';
}
function checkEnd() {
  if (G.mode === 'timed') { if (!G.L.some(Boolean)) endGame(); return; }
  const left = G.L.some(k => k && !(G.fillers && G.fillers.has(k))) || G.deck.some(x => !x.filler);
  if (!left) endGame();
}
function tick() {
  const left = Math.max(0, G.secs - (performance.now() - G.start) / 1000);
  const t = $('g-time');
  t.textContent = fmt(Math.ceil(left));
  t.classList.toggle('low', left <= 10);
  if (left <= 0) endGame();
}
const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
function countdown(done) {
  const el = $('g-count'); let n = 3; el.hidden = false; el.textContent = n;
  const iv = setInterval(() => { n--; if (n <= 0) { clearInterval(iv); el.hidden = true; done(); } else el.textContent = n; }, 700);
  $('g-time').textContent = fmt(G.secs);
}

function endGame() {
  if (!G || G.over) return;
  G.over = true; clearInterval(G.timer);
  const dur = Math.round((performance.now() - G.start) / 1000);
  db.games = (db.games || 0) + 1;
  let title, big, sub;
  const acc = G.score + G.wrong ? Math.round(100 * G.score / (G.score + G.wrong)) : 100;
  if (G.mode === 'timed') {
    const k = G.topicId ? recKey(G.topicId) : String(G.secs), prev = db.records[k] ? db.records[k].best : 0;
    const isRec = G.score > prev;
    if (isRec) db.records[k] = { best: G.score, date: todayStr() };
    title = G.topicId ? `${TOPICS[G.topicId].title} · ${G.secs} sn` : `${G.secs / 60} dakikalık oyun`;
    big = G.score;
    sub = (isRec ? `<span class="r-rec">Yeni rekor! 🏆</span>\n` : `Rekor: ${prev}\n`) +
          `Doğruluk %${acc} · En uzun seri ${G.bestCombo}`;
  } else {
    title = G.mode === 'topic' ? `${TOPICS[G.topicId].title} turu bitti` : G.mode === 'train' ? 'Antrenman bitti' : 'Hatalar turu bitti';
    big = `${G.cleared}/${G.total}`;
    const still = pool().filter(c => c.mist).length;
    sub = `Süre ${fmt(dur)} · Doğruluk %${acc}` + (G.mode === 'mist' ? `\nHatalarında kalan: ${still}` : '');
  }
  save();
  $('r-title').textContent = title;
  $('r-big').textContent = big;
  $('r-sub').innerHTML = sub;
  const last = G.topicId ? { mode: 'topic', arg: G.topicId } : { mode: G.mode, arg: G.secs };
  $('r-again').onclick = () => startGame(last.mode, last.arg);
  $('r-again').disabled = last.mode === 'mist' && !pool().some(c => c.mist);
  go('result');
}
function quitGame() {
  if (!G) return go(lastTab);
  if (!G.over && (G.score || G.wrong) && !confirm('Oyundan çıkılsın mı? İlerlemen kaydedildi, skor sayılmaz.')) return;
  clearInterval(G.timer); G.over = true; G = null; go(lastTab);
}
$('g-quit').onclick = quitGame;
$('r-menu').onclick = () => go(lastTab);
document.querySelectorAll('[data-timed]').forEach(b => b.onclick = () => startGame('timed', +b.dataset.timed));
$('go-train').onclick = () => startGame('train');
$('go-mist').onclick = () => startGame('mist');
$('go-verbs').onclick = () => startGame('topic', 'verbs');
document.querySelectorAll('[data-numtopic]').forEach(b => b.onclick = () => startGame('topic', b.dataset.numtopic));
document.querySelectorAll('[data-recent]').forEach(b => b.onclick = () => startGame('topic', 'r' + b.dataset.recent));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && G && G.mode === 'timed' && !G.over && G.start) tick();
});

/* ---------------- kart modu ---------------- */
let F = { q: [], cur: null, dir: 'es', shown: false };
function fcStart() {
  const p = pool();
  const due = shuffle(p.filter(isDue));
  // kelimeler Duolingo'da zaten öğrenildiği için yeniler rastgele seçilir; tekrarlar ve yeniler karışık gelir
  const fresh = shuffle(p.filter(c => !c.seen)).slice(0, newLeft());
  F.q = shuffle([...due, ...fresh]);
  fcStats(); fcNext();
}
function fcStats() { $('c-due').textContent = F.q.filter(c => c.seen).length + (F.cur && F.cur.seen ? 1 : 0); $('c-new').textContent = F.q.filter(c => !c.seen).length + (F.cur && !F.cur.seen ? 1 : 0); }
function fcNext() {
  F.shown = false; $('fc-a').textContent = ''; $('fc-h').textContent = ''; $('fc-tag').textContent = ''; $('fc-x').innerHTML = '';
  $('fc-grade').hidden = true;
  F.cur = F.q.shift() || null;
  if (!F.cur) {
    $('fc-q').innerHTML = `<span class="empty-msg">${Object.keys(db.cards).length ? 'Bugünlük kart kalmadı 🎉<br>Oyna sekmesinden devam edebilirsin.' : 'Henüz kelime yok.<br>⚙︎ Ayarlar → CSV dosyası seç.'}</span>`;
    $('fc-unit').textContent = ''; $('fc-dir').textContent = '';
    $('fc-show').hidden = true; $('fc-speak').hidden = true; fcStats(); return;
  }
  const c = F.cur;
  F.dir = db.opts.dir === 'mix' ? (Math.random() < .5 ? 'es' : 'tr') : db.opts.dir;
  $('fc-q').textContent = F.dir === 'es' ? disp(c) : trOf(c);
  if (F.dir === 'es' && db.opts.tags === '1') $('fc-tag').textContent = tagOf(c);
  $('fc-unit').textContent = c.unit ? `${c.unit.sec}. Kısım · ${c.unit.no}. Ünite${c.unit.title ? ' · ' + c.unit.title : ''}` : '';
  $('fc-dir').textContent = (c.seen ? '' : 'YENİ · ') + (F.dir === 'es' ? 'İspanyolca → Türkçe' : 'Türkçe → İspanyolca');
  $('fc-show').hidden = false; $('fc-speak').hidden = false;
  if (F.dir === 'es') speak(c.es);
  fcStats();
}
function fcShow() {
  if (!F.cur || F.shown) return;
  F.shown = true; const c = F.cur;
  $('fc-a').textContent = F.dir === 'es' ? trOf(c) : disp(c);
  if (F.dir === 'tr' && db.opts.tags === '1') $('fc-tag').textContent = tagOf(c);
  const alt = (c.alt || '').split(',').map(s => s.trim()).filter(s => s && norm(s) !== norm(trOf(c))).join(', ');
  $('fc-h').textContent = alt;
  const ex = EX[c.es];
  $('fc-x').innerHTML = '';
  if (ex) { const a = document.createElement('div'); a.textContent = ex[0]; const b = document.createElement('small'); b.textContent = ex[1]; $('fc-x').append(a, b); }
  $('fc-show').hidden = true; $('fc-grade').hidden = false;
  if (F.dir === 'tr') speak(c.es);
}
function fcGrade(g) {
  const c = F.cur; if (!c) return;
  if (g === 0) { onWrong(c, true); F.q.splice(Math.min(F.q.length, 4), 0, c); }
  else onRight(c, g === 1 ? 0 : g === 2 ? 1 : 2, true);
  if (g === 1) c.due = dueAt(1);                 // "Zor": kutu yerinde, yarın tekrar
  save(); fcNext();
}
$('fc-show').onclick = fcShow;
$('fcard').onclick = e => { if (e.target.id !== 'fc-speak') fcShow(); };
$('fc-speak').onclick = () => F.cur && speak(F.cur.es, true);
document.querySelectorAll('#fc-grade button').forEach(b => b.onclick = () => fcGrade(+b.dataset.g));

/* ---------------- kelime listesi ---------------- */
let listFilter = 'all';
function renderList() {
  const s = norm($('search').value);
  let cards = pool();
  if (listFilter === 'mist') cards = cards.filter(c => c.mist);
  if (listFilter === 'new') cards = cards.filter(c => !c.seen);
  if (s) cards = cards.filter(c => c.es.toLowerCase().includes(s) || norm(trOf(c)).includes(s));
  cards.sort((a, b) => a.order - b.order);
  const el = $('list'); el.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const c of cards.slice(0, 500)) {
    const d = document.createElement('div'); d.className = 'item';
    const l = document.createElement('div'); l.className = 'l'; l.textContent = disp(c);
    if (db.opts.tags === '1') { const t = tagOf(c); if (t) { const sm = document.createElement('small'); sm.textContent = t; l.appendChild(sm); } }
    const dots = document.createElement('span'); dots.className = 'dots' + (c.mist ? ' m' : '');
    dots.textContent = !c.seen ? 'yeni' : '●'.repeat(c.box) + '○'.repeat(5 - c.box) + (c.mist ? '  hata' : '');
    l.appendChild(dots);
    const r = document.createElement('div'); r.className = 'r'; r.textContent = trOf(c);
    d.append(l, r); d.onclick = () => speak(c.es, true); frag.appendChild(d);
  }
  el.appendChild(frag);
  if (!cards.length) el.innerHTML = '<p class="note">Kelime yok.</p>';
  else if (cards.length > 500) el.insertAdjacentHTML('beforeend', `<p class="note">İlk 500 gösteriliyor (${cards.length}). Aramayı daralt.</p>`);
}
$('search').oninput = renderList;
document.querySelectorAll('.chip').forEach(b => b.onclick = () => {
  listFilter = b.dataset.f; document.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b)); renderList();
});

/* ---------------- ayarlar ---------------- */
function bindSettings() {
  const secs = [...new Set(Object.values(db.cards).map(c => c.unit && c.unit.sec).filter(Boolean))].sort((a, b) => a - b);
  $('o-sec').innerHTML = '<option value="all">Tümü</option>' + secs.map(s => `<option value="${s}">${s}. Kısım</option>`).join('');
  if (db.opts.section !== 'all' && !secs.map(String).includes(db.opts.section)) db.opts.section = 'all';
  $('o-sec').value = db.opts.section; $('o-new').value = db.opts.newPerDay;
  $('o-dir').value = db.opts.dir; $('o-tts').value = db.opts.tts; $('o-tags').value = db.opts.tags; $('o-art').value = db.opts.art;
}
$('o-sec').onchange = e => { db.opts.section = e.target.value; save(); };
$('o-new').onchange = e => { db.opts.newPerDay = Math.max(0, +e.target.value || 0); save(); };
$('o-dir').onchange = e => { db.opts.dir = e.target.value; save(); };
$('o-tts').onchange = e => { db.opts.tts = e.target.value; save(); };
$('o-tags').onchange = e => { db.opts.tags = e.target.value; save(); };
$('o-art').onchange = e => { db.opts.art = e.target.value; save(); };
$('f-csv').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const r = importRows(parseCSV(await f.text()));
  $('m-import').textContent = `${f.name}: ${r.added} yeni kelime eklendi, ${r.updated} kelime güncellendi.\nToplam: ${Object.keys(db.cards).length}`;
  bindSettings(); e.target.value = '';
};
$('b-export').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(db)], { type: 'application/json' }));
  a.download = `palabras-yedek-${todayStr()}.json`; a.click();
};
$('f-backup').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!d.cards) throw 0;
    if (!confirm(`Yedekte ${Object.keys(d.cards).length} kelime var. Mevcut verinin üzerine yazılsın mı?`)) return;
    localStorage.setItem(KEY, JSON.stringify(d)); load(); bindSettings();
    $('m-backup').textContent = 'Yedek geri yüklendi.';
  } catch { $('m-backup').textContent = 'Geçersiz yedek dosyası.'; }
  e.target.value = '';
};
$('b-reset').onclick = () => {
  if (!confirm('Bütün kelimeler, ilerleme ve rekorlar silinecek. Emin misin?')) return;
  db = blank(); save(); bindSettings(); $('m-backup').textContent = 'Silindi.';
};

/* ---------------- otomatik senkron ----------------
   GitHub Actions haftada bir Duolingo'dan words.json üretir. Uygulama açılışta
   (ve uzun süre arka planda kaldıktan sonra) bu dosyayı okuyup yeni kelimeleri ekler.
   GitHub Pages'te çalışırken dosya raw.githubusercontent.com'dan alınır: Pages
   yeniden yayınlanmayı beklemeden her zaman repodaki son hali gelir. */
const SYNC_URL = RAW_BASE ? RAW_BASE + 'words.json' : 'words.json';
const SYNC_EVERY = 6 * 3600 * 1000;

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, 3200);
}
function importWords(list) {
  const res = importRows(list.map(w => {
    const [es, tr, alt, sec, no, title] = w;
    const unit = sec ? `${sec}. Kısım ${no}. Ünite – ${title}` : '';
    return [es, tr, [alt, unit].filter(Boolean).join(' | ')];
  }));
  for (const w of list) if (w[7] && db.cards[w[0]]) db.cards[w[0]].audio = w[7];
  if (typeof applyPending === 'function') applyPending();
  save();
  return res;
}
function fmtDate(iso) {
  try { return new Date(iso).toLocaleString('tr-TR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }); } catch { return iso; }
}
// üst çubuktaki küçük durum: son otomatik güncelleme ve Duolingo'daki yerin
function headerSync(err) {
  const el = $('hdr-sync'); const s = db.sync;
  el.classList.toggle('warn', !s);
  if (!s) { el.innerHTML = err ? 'Güncelleme alınamadı' : 'Otomatik güncelleme<br>henüz gelmedi'; return; }
  const d = new Date(s.updated);
  const when = isNaN(d) ? s.updated : d.toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `Güncellendi: <b>${when}</b>` + (s.lastUnit ? `<br>${s.lastUnit.sec}. Kısım ${s.lastUnit.no}. Ünite` : '');
}
function syncInfo(err) {
  headerSync(err);
  const el = $('sync-info'); if (!el) return;
  const s = db.sync;
  if (!s) { el.textContent = err ? 'Kelime listesine ulaşılamadı. İnternet bağlantını kontrol et.' : 'Henüz senkron yapılmadı.'; return; }
  el.textContent = `Son güncelleme: ${fmtDate(s.updated)} · ${s.count} kelime` +
    (s.lastUnit ? `\nDuolingo'daki yerin: ${s.lastUnit.sec}. Kısım ${s.lastUnit.no}. Ünite` : '') +
    `\nGüncellemeler haftada bir otomatik gelir; uygulama açılınca eklenir.` + (err ? '\n(Son kontrol başarısız oldu.)' : '');
}
let syncing = false;
async function autoSync(manual) {
  if (syncing) return; syncing = true;
  try {
    const r = await fetch(SYNC_URL + (SYNC_URL.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (r.status === 404) { syncInfo(false); if (manual) toast('Henüz otomatik güncelleme yok.'); return; } // words.json daha oluşmadı
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (!Array.isArray(d.words)) throw new Error('biçim');
    db.syncChecked = Date.now();
    if (!db.sync || db.sync.updated !== d.updated || manual) {
      const res = importWords(d.words);
      db.sync = { updated: d.updated, count: d.words.length, lastUnit: d.lastUnit || null };
      save();
      if (res.added) { toast(`${res.added} yeni kelime eklendi 🎉`); loadTags(); }
      else if (manual) toast('Yeni kelime yok, liste güncel.');
      refreshAll();
    } else { save(); if (manual) toast('Yeni kelime yok, liste güncel.'); }
    syncInfo();
  } catch (e) {
    syncInfo(true);
    if (manual) toast('Güncelleme alınamadı.');
  } finally { syncing = false; }
}
$('b-sync').onclick = () => autoSync(true);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !G && Date.now() - (db.syncChecked || 0) > SYNC_EVERY) autoSync(false);
});

/* ---------------- başlat ---------------- */
load();
go('home');
syncInfo();
autoSync(false);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
