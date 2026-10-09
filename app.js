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
  opts: { section: 'all', newPerDay: 20, dir: 'es', tts: '1', tags: '1' },
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
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch { alert('Kaydedilemedi: depolama dolu olabilir. Ayarlar → Yedeği indir.'); }
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

/* ---------------- etiketler ---------------- */
let TAGS = {};
fetch('tags.json').then(r => r.ok ? r.json() : {}).then(t => { TAGS = t || {}; refreshAll(); }).catch(() => {});

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
  const t = TAGS[c.es];
  if (t) return t.l ? `${t.t} (${t.l})` : t.t;
  return guessTag(c.es);
}
const trOf = c => (TAGS[c.es] && TAGS[c.es].b) || c.tr;

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
  const wasNew = !c.seen;
  markNewSeen(c, countDaily);
  if (wasNew) { c.box = Math.max(1, step); c.due = dueAt(c.box); }
  else if (c.due <= eod()) { c.box = Math.min(5, Math.max(1, c.box + step)); c.due = dueAt(c.box); }
  // vakti gelmemiş kelimeyi bugün tekrar bilmek kutuyu ilerletmez
  if (c.mist && ++c.mstreak >= MIST_EXIT) { c.mist = false; c.mstreak = 0; }
}
function onWrong(c, countDaily = false) {
  markNewSeen(c, countDaily);
  c.box = 0; c.due = Date.now(); c.wrong++; c.mist = true; c.mstreak = 0; c.lastWrong = Date.now();
}

/* ---------------- ses ---------------- */
let voice = null;
function pickVoice() { const v = speechSynthesis.getVoices(); voice = v.find(x => x.lang === 'es-ES') || v.find(x => /^es/i.test(x.lang)) || null; }
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function speak(text, force) {
  if (!('speechSynthesis' in window) || (!force && db.opts.tts !== '1')) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text); u.lang = 'es-ES'; if (voice) u.voice = voice; u.rate = 0.9;
  speechSynthesis.speak(u);
}

/* ---------------- navigasyon ---------------- */
let view = 'play';
function go(v) {
  view = v;
  document.body.classList.toggle('ingame', v === 'game');
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('on', s.id === 'v-' + v));
  if (v === 'play') renderMenu();
  if (v === 'cards') fcStart();
  if (v === 'words') renderList();
  if (v === 'settings') bindSettings();
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => go(b.dataset.v));
function refreshAll() { if (view === 'play') renderMenu(); if (view === 'words') renderList(); }

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
    const l = document.createElement('div'); l.className = 'l'; l.textContent = c.es;
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
   mode: 'timed' | 'train' | 'mist'
   L, R: 5 yuva; her yuva bir kart (es) ya da null
   deck: train/mist için sıralı deste; timed için ağırlıklı seçim  */
let G = null;

function startGame(mode, secs) {
  const p = pool();
  if (p.length < 2) return;
  G = { mode, secs, L: Array(PAIRS).fill(null), R: Array(PAIRS).fill(null), sel: null, busy: false,
        score: 0, wrong: 0, combo: 0, bestCombo: 0, cleared: 0, wrongSet: new Map(), recent: [],
        usedThisGame: new Set(), deck: [], total: 0, start: 0, timer: null, over: false, lockedTap: false };
  if (mode === 'train') G.deck = buildTrainDeck(p);
  if (mode === 'mist') G.deck = buildMistDeck(p);
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

function buildTrainDeck(p) {
  const due = shuffle(p.filter(c => isDue(c) && !c.mist));
  const mist = shuffle(p.filter(c => c.mist));
  const fresh = p.filter(c => !c.seen).sort((a, b) => a.order - b.order).slice(0, 8);
  let picks = [...mist.slice(0, 6), ...due, ...fresh];
  picks = [...new Map(picks.map(c => [c.es, c])).values()].slice(0, TRAIN_SIZE);
  if (picks.length < TRAIN_SIZE) {                // eksikse en zayıf kutulardan tamamla
    const rest = shuffle(p.filter(c => c.seen && !picks.includes(c))).sort((a, b) => a.box - b.box);
    picks.push(...rest.slice(0, TRAIN_SIZE - picks.length));
  }
  if (picks.length < TRAIN_SIZE) picks.push(...shuffle(p.filter(c => !picks.includes(c))).slice(0, TRAIN_SIZE - picks.length));
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
  for (const k of [...G.L, ...extra]) if (k) { es.add(k); tr.add(norm(trOf(db.cards[k]))); }
  return { es, tr };
}
function fits(c, keys) { return !keys.es.has(c.es) && !keys.tr.has(norm(trOf(c))); }

function nextTimed(keys) {
  const p = pool();
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
    const c = db.cards[G.deck[i].es];
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
      b.onclick = () => tap(side, i);
      board.appendChild(b);
    }
  }
  for (const el of board.children) {
    const side = el.dataset.side, i = +el.dataset.i, k = G[side][i];
    const id = side + i;
    el.classList.remove('sel', 'ok', 'bad', 'gone');
    el.classList.toggle('empty', !k);
    if (!k) { el.textContent = ''; continue; }
    const c = db.cards[k];
    if (G.fresh && G.fresh.has(id)) { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); }
    if (side === 'L') {
      el.textContent = c.es; fit(el, c.es);
      const t = db.opts.tags === '1' ? (TAGS[c.es] ? TAGS[c.es].t : guessTag(c.es)) : '';
      if (t) { const s = document.createElement('span'); s.className = 'tg'; s.textContent = t; el.appendChild(s); }
    } else { const t = trOf(c); el.textContent = t; fit(el, t); }
    if (G.sel && G.sel.side === side && G.sel.i === i) el.classList.add('sel');
  }
  G.fresh = new Set();
}
const slotEl = (side, i) => $('board').querySelector(`[data-side="${side}"][data-i="${i}"]`);

function tap(side, i) {
  if (!G || G.over || G.lockedTap || !G[side][i]) return;
  if (G.mode === 'timed' && !G.start) return;
  if (side === 'L') speak(G.L[i]);
  if (!G.sel || G.sel.side === side) {
    if (G.sel && G.sel.side === side && G.sel.i === i) { G.sel = null; }
    else G.sel = { side, i };
    document.querySelectorAll('.slot.sel').forEach(e => e.classList.remove('sel'));
    if (G.sel) slotEl(side, i).classList.add('sel');
    return;
  }
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
  const k = G.L[li], c = db.cards[k];
  eL.classList.add('ok'); eR.classList.add('ok');
  const firstTry = !G.wrongSet.has(k);
  const filler = G.fillers && G.fillers.has(k);
  if (firstTry && !filler) onRight(c, 1);
  else if (firstTry && filler) markNewSeen(c);
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
    }, 160);
  }, 220);
}
function miss(lk, rk, eL, eR) {
  G.wrong++; G.combo = 0; $('g-combo').textContent = '';
  const c = db.cards[lk];
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
    const k = String(G.secs), prev = db.records[k] ? db.records[k].best : 0;
    const isRec = G.score > prev;
    if (isRec) db.records[k] = { best: G.score, date: todayStr() };
    title = `${G.secs / 60} dakikalık oyun`;
    big = G.score;
    sub = (isRec ? `<span class="r-rec">Yeni rekor! 🏆</span>\n` : `Rekor: ${prev}\n`) +
          `Doğruluk %${acc} · En uzun seri ${G.bestCombo}`;
  } else {
    title = G.mode === 'train' ? 'Antrenman bitti' : 'Hatalar turu bitti';
    big = `${G.cleared}/${G.total}`;
    const still = pool().filter(c => c.mist).length;
    sub = `Süre ${fmt(dur)} · Doğruluk %${acc}` + (G.mode === 'mist' ? `\nHatalarında kalan: ${still}` : '');
  }
  save();
  $('r-title').textContent = title;
  $('r-big').textContent = big;
  $('r-sub').innerHTML = sub;
  const last = { mode: G.mode, secs: G.secs };
  $('r-again').onclick = () => startGame(last.mode, last.secs);
  $('r-again').disabled = last.mode === 'mist' && !pool().some(c => c.mist);
  go('result');
}
function quitGame() {
  if (!G) return go('play');
  if (!G.over && (G.score || G.wrong) && !confirm('Oyundan çıkılsın mı? İlerlemen kaydedildi, skor sayılmaz.')) return;
  clearInterval(G.timer); G.over = true; G = null; go('play');
}
$('g-quit').onclick = quitGame;
$('r-menu').onclick = () => go('play');
document.querySelectorAll('[data-timed]').forEach(b => b.onclick = () => startGame('timed', +b.dataset.timed));
$('go-train').onclick = () => startGame('train');
$('go-mist').onclick = () => startGame('mist');
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && G && G.mode === 'timed' && !G.over && G.start) tick();
});

/* ---------------- kart modu ---------------- */
let F = { q: [], cur: null, dir: 'es', shown: false };
function fcStart() {
  const p = pool();
  const due = shuffle(p.filter(isDue));
  const fresh = p.filter(c => !c.seen).sort((a, b) => a.order - b.order).slice(0, newLeft());
  F.q = [...due, ...fresh];
  fcStats(); fcNext();
}
function fcStats() { $('c-due').textContent = F.q.filter(c => c.seen).length + (F.cur && F.cur.seen ? 1 : 0); $('c-new').textContent = F.q.filter(c => !c.seen).length + (F.cur && !F.cur.seen ? 1 : 0); }
function fcNext() {
  F.shown = false; $('fc-a').textContent = ''; $('fc-h').textContent = ''; $('fc-tag').textContent = '';
  $('fc-grade').hidden = true;
  F.cur = F.q.shift() || null;
  if (!F.cur) {
    $('fc-q').innerHTML = `<span class="empty-msg">${Object.keys(db.cards).length ? 'Bugünlük kart kalmadı 🎉<br>Oyna sekmesinden devam edebilirsin.' : 'Henüz kelime yok.<br>⚙︎ Ayarlar → CSV dosyası seç.'}</span>`;
    $('fc-unit').textContent = ''; $('fc-dir').textContent = '';
    $('fc-show').hidden = true; $('fc-speak').hidden = true; fcStats(); return;
  }
  const c = F.cur;
  F.dir = db.opts.dir === 'mix' ? (Math.random() < .5 ? 'es' : 'tr') : db.opts.dir;
  $('fc-q').textContent = F.dir === 'es' ? c.es : trOf(c);
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
  $('fc-a').textContent = F.dir === 'es' ? trOf(c) : c.es;
  if (F.dir === 'tr' && db.opts.tags === '1') $('fc-tag').textContent = tagOf(c);
  const alt = (c.alt || '').split(',').map(s => s.trim()).filter(s => s && norm(s) !== norm(trOf(c))).join(', ');
  $('fc-h').textContent = alt;
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
    const l = document.createElement('div'); l.className = 'l'; l.textContent = c.es;
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
  $('o-dir').value = db.opts.dir; $('o-tts').value = db.opts.tts; $('o-tags').value = db.opts.tags;
}
$('o-sec').onchange = e => { db.opts.section = e.target.value; save(); };
$('o-new').onchange = e => { db.opts.newPerDay = Math.max(0, +e.target.value || 0); save(); };
$('o-dir').onchange = e => { db.opts.dir = e.target.value; save(); };
$('o-tts').onchange = e => { db.opts.tts = e.target.value; save(); };
$('o-tags').onchange = e => { db.opts.tags = e.target.value; save(); };
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

/* ---------------- başlat ---------------- */
load();
go('play');
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
