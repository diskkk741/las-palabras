'use strict';
/* Palabras — arayüz katmanı: sayfa başlıkları, Bugün ekranı, hızlı erişim düğmeleri.
   Oyun mantığına dokunmaz; sadece app.js / modes.js'teki fonksiyonları çağırır. */

const PAGE = {
  home: ['Bugün', () => new Date().toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' })],
  play: ['Pratik', () => 'Bir mod seç'],
  cards: ['Kartlar', () => 'Hatırla, sonra kontrol et'],
  words: ['Kelimeler', () => `${Object.keys(db.cards).length} kelime`],
  settings: ['Ayarlar', () => ''],
};
function onView(v) {
  const p = PAGE[v]; if (!p) return;
  $('page-title').textContent = p[0];
  $('page-sub').textContent = p[1]();
  document.querySelectorAll('.view.on .scroll, #list').forEach(el => { el.scrollTop = 0; });
}

// hızlı erişim: aynı modu birden fazla yerde açan düğmeler
const GO = {
  train: () => startGame('train'),
  timed60: () => startGame('timed', 60),
  listen: () => mcStart('listen'),
  mist: () => { if (pool().some(c => c.mist)) startGame('mist'); else go('play'); },
  r3: () => startGame('topic', 'r3'),
};
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => GO[b.dataset.go] && GO[b.dataset.go]());

const DAY_INITIAL = ['P', 'P', 'S', 'Ç', 'P', 'C', 'C'];   // Pazar, Pazartesi, Salı, …
function renderHome() {
  // haftalık çubukların altına gün baş harfleri (bugün vurgulu)
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(`<span${i ? '' : ' class="today"'}>${DAY_INITIAL[d.getDay()]}</span>`); }
  $('week-days').innerHTML = days.join('');

  const p = pool();
  const due = p.filter(isDue).length, mist = p.filter(c => c.mist).length;
  $('hero-sub').textContent = due ? `${due} kelimenin tekrar zamanı geldi` : '20 kelime, yeniler ve en zayıflar';

  const rec = db.records['60'] ? db.records['60'].best : null;
  $('qk-timed').textContent = rec ? `Rekor ${rec}` : 'Rekorunu kır';
  const lm = Object.values(db.listen).filter(x => x.mist).length;
  $('qk-listen').textContent = lm ? `${lm} hata bekliyor` : '20 soru';
  $('qk-mist').textContent = mist ? `${mist} kelime` : 'Hata yok';
  document.querySelector('[data-go="mist"]').classList.toggle('dim', !mist);
  const r3 = recentPool(3).length;
  $('qk-r3').textContent = r3 ? `${r3} kelime` : '–';
}

onView(view);
if (isMenu(view)) renderMenu();
