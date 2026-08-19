/* Spark service worker — gjør appen installerbar og robust ved dårlig nett.
   Bump CACHE når du oppdaterer spark.html, ellers serveres den gamle. */
const CACHE = 'spark-v4';
const FILES = ['./spark.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API-kall skal ALDRI caches
  if (url.hostname.includes('googleapis.com') || url.hostname.includes('anthropic.com')) return;
  if (e.request.method !== 'GET') return;

  // nett først, cache som reserve
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return r;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./spark.html')))
  );
});
