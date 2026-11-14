// Basit önbellek: uygulama internetsiz de açılır.
// Dosyaları güncellediğinde VERSION'ı artır ki telefona yeni sürüm gelsin.
const VERSION = 'palabras-v16';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'tags.json', 'modes.js', 'ui.js', 'conj.json', 'manifest.webmanifest',
  'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Önce ağdan dene (güncel sürüm), olmazsa önbellekten ver.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Sadece uygulamanın kendi dosyaları ve kelime verisi önbelleğe girer.
  // Ses dosyaları (Duolingo CDN), yazı tipleri ve parça (Range) istekleri hiç durdurulmaz:
  // eskiden her ses tıklaması service worker'dan geçip bir de önbelleğe kopyalanıyordu.
  const u = new URL(e.request.url);
  if (u.origin !== location.origin && u.hostname !== 'raw.githubusercontent.com') return;
  if (e.request.headers.has('range')) return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(VERSION).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});
