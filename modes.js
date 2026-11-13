'use strict';
/* Palabras — ek modlar (app.js'ten sonra yüklenir, onun fonksiyonlarını kullanır).
   · Dinleme: kelimeyi duy, Türkçesini seç
   · Fiil çekimi: fiil + kişi + zaman → doğru çekim
   · Seri / haftalık istatistik satırı
   · GitHub gist ile bulut yedeği (çoklu cihaz)
   Bu modların ilerlemesi ayrı tutulur (db.listen, db.conj): eşleştirme oyununun kutularını ve Hatalarım'ı etkilemez. */

const MC_SIZE = 20;
const PERSON_LABEL = ['yo', 'tú', 'él / ella', 'nosotros', 'ellos / ellas'];
const TENSE_LABEL = { pres: 'Presente', pret: 'Pretérito', imp: 'Imperfecto', fut: 'Futuro' };
const TENSE_TR = { pres: 'şimdiki', pret: 'geçmiş (-di)', imp: 'geçmiş (-iyordu)', fut: 'gelecek' };

/* ---------------- çekim tablosu ---------------- */
let CONJ = {};
async function loadConj() {
  for (const url of [RAW_BASE && RAW_BASE + 'conj.json?t=' + Date.now(), 'conj.json'].filter(Boolean)) {
    try { const r = await fetch(url, { cache: 'no-store' }); if (r.ok) { CONJ = await r.json(); if (view === 'play') renderMenu(); return; } } catch {}
  }
}
loadConj();

/* ---------------- menü ekleri ---------------- */
function renderExtras() {
  $('st-streak').textContent = streak();
  $('st-wk').textContent = weekTotal();
  const days = Array.from({ length: 7 }, (_, i) => dayTotal(dayStr(6 - i)));
  const max = Math.max(1, ...days);
  $('st-week').innerHTML = days.map(n => `<i class="${n ? '' : 'z'}" style="height:${n ? Math.max(4, Math.round(22 * n / max)) : 3}px"></i>`).join('');
  const lm = Object.values(db.listen).filter(x => x.mist).length;
  const withAudio = Object.values(db.cards).filter(c => c.audio).length;
  $('listen-sub').textContent = `Kelimeyi duy, Türkçesini seç · 20 soru` + (lm ? ` · ${lm} hata` : '') + (withAudio ? '' : ' · cihaz sesiyle');
  $('go-listen').disabled = Object.keys(db.cards).length < 4;
  const nv = Object.keys(CONJ).length;
  const cm = Object.values(db.conj).filter(x => x.mist).length;
  $('conj-sub').textContent = nv ? `${nv} fiil · 20 soru` + (cm ? ` · ${cm} hata` : '') : 'yükleniyor…';
  document.querySelectorAll('[data-conj]').forEach(b => b.disabled = nv < 2);
}

/* ---------------- çoktan seçmeli motor ---------------- */
let M = null;
const posGroup = c => { const t = (TAGS[c.es] && TAGS[c.es].t) || guessTag(c.es); return /^v\.|^part/.test(t) ? 'v' : /^(m|f)\./.test(t) ? 'n' : t === 'adj.' ? 'a' : t === 'loc.' ? 'l' : 'o'; };

function buildListen() {
  let cards = Object.values(db.cards);
  const audio = cards.filter(c => c.audio);
  if (audio.length >= 40) cards = audio;                       // Duolingo kaydı olanlar öncelikli
  const st = es => db.listen[es] || {};
  const mist = shuffle(cards.filter(c => st(c.es).mist)).slice(0, 8);
  const unseen = shuffle(cards.filter(c => !st(c.es).ok && !st(c.es).mist));
  const rest = shuffle(cards.filter(c => st(c.es).ok && !st(c.es).mist));
  const picks = [...new Map([...mist, ...unseen.slice(0, 8), ...rest, ...unseen].map(c => [c.es, c])).values()].slice(0, MC_SIZE);
  return shuffle(picks).map(c => {
    const right = trOf(c), g = posGroup(c);
    const used = new Set([norm(right)]);
    const others = shuffle(Object.values(db.cards).filter(o => o.es !== c.es));
    const opts = [];
    for (const pass of [o => posGroup(o) === g, () => true]) {
      for (const o of others) {
        if (opts.length >= 3) break;
        const t = trOf(o);
        if (!t || used.has(norm(t)) || !pass(o)) continue;
        used.add(norm(t)); opts.push(t);
      }
    }
    return { kind: 'listen', key: c.es, card: c, right, opts: shuffle([right, ...opts]) };
  });
}

function buildConj(tense) {
  const verbs = Object.keys(CONJ);
  if (verbs.length < 2) return [];
  const keyOf = (v, t, p) => `${v}|${t}|${p}`;
  const tenses = tense === 'mix' ? Object.keys(TENSE_LABEL) : [tense];
  const mist = shuffle(Object.entries(db.conj).filter(([k, x]) => x.mist && tenses.includes(k.split('|')[1]) && CONJ[k.split('|')[0]]))
    .slice(0, 6).map(([k]) => { const [v, t, p] = k.split('|'); return [v, t, +p]; });
  const qs = [...mist];
  const seen = new Set(qs.map(([v]) => v));
  for (const v of shuffle(verbs.slice())) {
    if (qs.length >= MC_SIZE) break;
    if (seen.has(v)) continue;
    seen.add(v);
    qs.push([v, tenses[Math.random() * tenses.length | 0], Math.random() * 5 | 0]);
  }
  return shuffle(qs).map(([v, t, p]) => {
    const table = CONJ[v], right = table[t][p];
    const pool = shuffle([...table[t].filter((_, i) => i !== p), ...Object.keys(table).filter(x => x !== t).map(x => table[x][p])]);
    const opts = [];
    for (const f of pool) if (f !== right && !opts.includes(f) && opts.length < 3) opts.push(f);
    return { kind: 'conj', key: keyOf(v, t, p), verb: v, tense: t, person: p, right, opts: shuffle([right, ...opts]) };
  });
}

function mcStart(kind, arg) {
  const qs = kind === 'listen' ? buildListen() : buildConj(arg);
  if (qs.length < 2) return;
  M = { kind, arg, qs, i: 0, score: 0, wrong: 0, combo: 0, best: 0, start: performance.now(), locked: false };
  $('mc-score').textContent = '0'; $('mc-combo').textContent = '';
  go('mc');
  mcShow();
}

function mcShow() {
  const q = M.qs[M.i];
  M.locked = false;
  $('mc-prog').firstElementChild.style.width = (100 * M.i / M.qs.length) + '%';
  $('mc-fb').innerHTML = '';
  const box = $('mc-q'); box.innerHTML = '';
  if (q.kind === 'listen') {
    const play = document.createElement('button'); play.className = 'play'; play.textContent = '🔊'; play.setAttribute('aria-label', 'Tekrar dinle');
    play.onclick = () => speak(q.key, true);
    const slow = document.createElement('button'); slow.className = 'slow'; slow.textContent = '🐢 Yavaş';
    slow.onclick = () => speak(q.key, true, true);
    box.append(play, slow);
    speak(q.key, true);
  } else {
    const v = document.createElement('div'); v.className = 'verb'; v.textContent = q.verb;
    const card = db.cards[q.verb];
    const mean = document.createElement('div'); mean.className = 'mean'; mean.textContent = card ? trOf(card) : '';
    const chips = document.createElement('div'); chips.className = 'chips';
    chips.innerHTML = `<span class="pill">${PERSON_LABEL[q.person]}</span><span class="pill t">${TENSE_LABEL[q.tense]}</span>`;
    box.append(v, mean, chips);
  }
  const opts = $('mc-opts'); opts.innerHTML = '';
  for (const o of q.opts) {
    const b = document.createElement('button'); b.textContent = o;
    b.onclick = () => mcAnswer(b, o);
    opts.appendChild(b);
  }
}

function mcAnswer(btn, val) {
  if (!M || M.locked) return;
  M.locked = true;
  const q = M.qs[M.i];
  const ok = val === q.right;
  const store = q.kind === 'listen' ? db.listen : db.conj;
  const rec = (store[q.key] = store[q.key] || { ok: 0, wrong: 0, mist: false });
  rec.mod = Date.now();
  document.querySelectorAll('#mc-opts button').forEach(b => { b.disabled = true; if (b.textContent === q.right) b.classList.add('ok'); });
  if (ok) {
    rec.ok++; rec.mist = false; M.score++; M.combo++; M.best = Math.max(M.best, M.combo); bump();
  } else {
    rec.wrong++; rec.mist = true; M.wrong++; M.combo = 0; btn.classList.add('bad');
    if (navigator.vibrate) navigator.vibrate(60);
  }
  save();
  $('mc-score').textContent = M.score;
  $('mc-combo').textContent = M.combo >= 3 ? `🔥 ${M.combo}` : '';
  // geri bildirim: doğru kelime / çekim
  const fb = $('mc-fb'); fb.innerHTML = '';
  const w = document.createElement('div'); w.className = 'w';
  if (q.kind === 'listen') {
    w.textContent = `${disp(q.card)} = ${q.right}`;
    fb.appendChild(w);
    const ex = EX[q.key];
    if (ex) { const s = document.createElement('small'); s.textContent = `${ex[0]} — ${ex[1]}`; fb.appendChild(s); }
  } else {
    w.textContent = `${PERSON_LABEL[q.person].split(' / ')[0]} ${q.right}`;
    fb.appendChild(w);
    speak(q.right, true);
  }
  if (ok) setTimeout(mcNext, q.kind === 'listen' ? 1200 : 1000);
  else {
    if (q.kind === 'listen') speak(q.key, true);
    const n = document.createElement('button'); n.className = 'next'; n.textContent = 'Devam'; n.onclick = mcNext;
    fb.appendChild(n);
  }
}

function mcNext() {
  if (!M) return;
  M.i++;
  if (M.i >= M.qs.length) return mcEnd();
  mcShow();
}

function mcEnd() {
  const dur = Math.round((performance.now() - M.start) / 1000);
  const acc = Math.round(100 * M.score / M.qs.length);
  $('r-title').textContent = M.kind === 'listen' ? 'Dinleme bitti' : `Fiil çekimi · ${M.arg === 'mix' ? 'Karışık' : TENSE_LABEL[M.arg]}`;
  $('r-big').textContent = `${M.score}/${M.qs.length}`;
  $('r-sub').innerHTML = `Süre ${fmt(dur)} · Doğruluk %${acc} · En uzun seri ${M.best}`;
  const last = { kind: M.kind, arg: M.arg };
  $('r-again').disabled = false;
  $('r-again').onclick = () => mcStart(last.kind, last.arg);
  M = null;
  go('result');
}

$('mc-quit').onclick = () => {
  if (M && M.i > 0 && !confirm('Çıkılsın mı? Cevapladıkların kaydedildi.')) return;
  M = null; go('play');
};
$('go-listen').onclick = () => mcStart('listen');
document.querySelectorAll('[data-conj]').forEach(b => b.onclick = () => mcStart('conj', b.dataset.conj));

/* ---------------- bulut yedeği (GitHub gist) ----------------
   Token sadece bu cihazda (localStorage) durur, yedeğin içine yazılmaz.
   Eşitleme: buluttakini indir → kayıt bazında birleştir (son değişen kazanır) → birleşmiş hali yükle.
   Böylece telefon ve bilgisayar aynı anda kullanılabilir. */
const TOKEN_KEY = 'palabras.token', GIST_KEY = 'palabras.gist', GIST_DESC = 'palabras-backup', GIST_FILE = 'palabras.json';
const ls = { get: k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } }, set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} } };
let cloudBusy = false, cloudTimer = null, cloudMuted = false, cloudLast = 0;

async function gh(path, opt = {}, token = ls.get(TOKEN_KEY)) {
  const r = await fetch('https://api.github.com' + path, { ...opt, headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' } });
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  return r.status === 204 ? null : r.json();
}

const PACK = ['box', 'due', 'seen', 'wrong', 'mist', 'mstreak', 'lastWrong', 'mod'];
function payload() {
  const pack = store => {
    const out = {};
    for (const [k, c] of Object.entries(store)) if (c.seen || c.wrong) out[k] = PACK.map(f => typeof c[f] === 'boolean' ? +c[f] : (c[f] || 0));
    return out;
  };
  return { v: 1, saved: Date.now(), cards: pack(db.cards), nums: pack(db.nums), listen: db.listen, conj: db.conj, records: db.records, stats: db.stats, pending: db.pending || {} };
}
function mergeRemote(r) {
  let changed = false;
  const apply = (store, remote, pendingKey) => {
    for (const [k, arr] of Object.entries(remote || {})) {
      const c = store[k];
      const rmod = arr[7] || 0;
      if (!c) { if (pendingKey) { (db.pending = db.pending || {})[k] = arr; } continue; }   // kelime bu cihaza henüz gelmemiş
      const untouched = !c.mod && !c.seen && !c.wrong;      // bu cihazda hiç çalışılmamış: buluttaki her zaman geçerli
      if (rmod > (c.mod || 0) || (untouched && (arr[2] || arr[3]))) { PACK.forEach((f, i) => { c[f] = (f === 'seen' || f === 'mist') ? !!arr[i] : arr[i]; }); changed = true; }
    }
  };
  apply(db.cards, { ...(r.pending || {}), ...r.cards }, true);
  ensureNums(); apply(db.nums, r.nums, false);
  for (const name of ['listen', 'conj']) for (const [k, x] of Object.entries(r[name] || {})) {
    const l = db[name][k];
    if (!l || (x.mod || 0) > (l.mod || 0)) { db[name][k] = x; changed = true; }
  }
  for (const [k, x] of Object.entries(r.records || {})) if (!db.records[k] || x.best > db.records[k].best) { db.records[k] = x; changed = true; }
  for (const [dev, days] of Object.entries(r.stats || {})) {
    const l = (db.stats[dev] = db.stats[dev] || {});
    for (const [d, n] of Object.entries(days)) if ((l[d] || 0) < n) { l[d] = n; changed = true; }
  }
  return changed;
}
function applyPending() {   // bulutta olup bu cihaza sonradan gelen kelimelerin ilerlemesi
  if (!db.pending) return;
  const rest = {};
  for (const [k, arr] of Object.entries(db.pending)) {
    const c = db.cards[k];
    if (!c) { rest[k] = arr; continue; }
    if ((arr[7] || 0) > (c.mod || 0) || (!c.mod && !c.seen && !c.wrong)) PACK.forEach((f, i) => { c[f] = (f === 'seen' || f === 'mist') ? !!arr[i] : arr[i]; });
  }
  db.pending = rest;
}
async function findGist(token) {
  for (let page = 1; page <= 5; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`, {}, token);
    const g = list.find(x => x.description === GIST_DESC && x.files && x.files[GIST_FILE]);
    if (g) return g.id;
    if (list.length < 100) break;
  }
  const g = await gh('/gists', { method: 'POST', body: JSON.stringify({ description: GIST_DESC, public: false, files: { [GIST_FILE]: { content: JSON.stringify(payload()) } } }) }, token);
  return g.id;
}
async function cloudSync(reason) {
  const id = ls.get(GIST_KEY);
  if (!ls.get(TOKEN_KEY) || !id || cloudBusy) return;
  cloudBusy = true;
  try {
    const g = await gh('/gists/' + id);
    const f = g.files && g.files[GIST_FILE];
    let remote = null;
    if (f) remote = f.truncated ? await (await fetch(f.raw_url)).json() : JSON.parse(f.content || '{}');
    applyPending();
    let changed = false;
    if (remote) changed = mergeRemote(remote);
    cloudMuted = true; save(); cloudMuted = false;
    await gh('/gists/' + id, { method: 'PATCH', keepalive: reason === 'hide', body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(payload()) } } }) });
    cloudLast = Date.now(); ls.set('palabras.cloudLast', String(cloudLast));
    if (changed) { if (view === 'play') renderMenu(); if (view === 'words') renderList(); }
    if (reason === 'manual') toast(changed ? 'Eşitlendi: buluttan ilerleme alındı ✓' : 'Eşitlendi ✓');
  } catch (e) {
    if (e.status === 401) { cloudInfo('Token geçersiz ya da süresi dolmuş. Yeniden bağlan.'); return; }
    if (e.status === 404) ls.set(GIST_KEY, '');
    if (reason === 'manual') toast('Eşitlenemedi: ' + e.message);
  } finally { cloudBusy = false; cloudInfo(); }
}
function cloudInfo(msg) {
  const on = !!(ls.get(TOKEN_KEY) && ls.get(GIST_KEY));
  $('cloud-on').hidden = !on; $('cloud-off').hidden = on;
  const last = +ls.get('palabras.cloudLast') || 0;
  $('cloud-info').textContent = msg || (on
    ? `Bağlı · ilerlemen otomatik yedekleniyor.` + (last ? `\nSon eşitleme: ${new Date(last).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '')
    : 'Bağlı değil. İlerlemen sadece bu cihazda.');
}
window.onSaved = () => {
  if (cloudMuted || !ls.get(TOKEN_KEY)) return;
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(() => cloudSync('auto'), 15000);
};
$('cloud-connect').onclick = async () => {
  const token = $('cloud-token').value.trim();
  if (!token) return;
  cloudInfo('Bağlanılıyor…');
  try {
    const id = await findGist(token);
    ls.set(TOKEN_KEY, token); ls.set(GIST_KEY, id);
    $('cloud-token').value = '';
    await cloudSync('manual');
  } catch (e) {
    cloudInfo(e.status === 401 ? 'Token geçersiz.' : e.status === 403 || e.status === 404 ? 'Token\'ın gist izni yok.' : 'Bağlanılamadı: ' + e.message);
  }
};
$('cloud-now').onclick = () => cloudSync('manual');
$('cloud-off-btn').onclick = () => {
  if (!confirm('Bulut bağlantısı kesilsin mi? Buluttaki yedek silinmez.')) return;
  ls.set(TOKEN_KEY, ''); ls.set(GIST_KEY, ''); cloudInfo();
};
document.addEventListener('visibilitychange', () => {
  if (!ls.get(TOKEN_KEY)) return;
  if (document.hidden) { clearTimeout(cloudTimer); cloudSync('hide'); }
  else if (Date.now() - cloudLast > 60000) cloudSync('show');
});

/* ---------------- başlat ---------------- */
cloudInfo();
if (view === 'play') renderMenu();
setTimeout(() => cloudSync('open'), 2500);   // önce kelime senkronu bitsin
