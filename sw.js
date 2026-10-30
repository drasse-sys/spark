/* Spark stabilization generation. API traffic never enters this cache. */
const CACHE = 'spark-learning-20261030-lf1';
const FILES = ['./spark.html', './manifest.json', './arithmetic.js', './learning.js', './visuals.js', './learning-ui.js', './icon-192.png', './icon-512.png'];
const STATIC_URLS = new Set(FILES.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(FILES.map(path => new Request(new URL(path, self.registration.scope), {cache:'reload'}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k.startsWith('spark-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const navigation = e.request.mode === 'navigate' && url.pathname.startsWith(new URL(self.registration.scope).pathname);
  const canonical = new URL(url.href); canonical.search = ''; canonical.hash = '';
  if (!navigation && !STATIC_URLS.has(canonical.href)) return;
  const key = navigation ? new URL('./spark.html', self.registration.scope).href : canonical.href;
  const opened = caches.open(CACHE);
  const network = fetch(e.request).then(async response => {
    const cache = await opened;
    if (response.ok && !response.redirected && (response.type === 'basic' || response.type === 'default')) {
      // Root navigation may contain an index redirect, not the app shell.
      if (!navigation || canonical.pathname.endsWith('/spark.html')) {
        try { await cache.put(key, response.clone()); } catch {}
      }
    }
    return response.ok ? response : (await cache.match(key)) || response;
  });
  e.waitUntil(network.catch(() => {}));
  e.respondWith((async () => {
    const cache = await opened;
    let timer;
    const delayedCache = new Promise(resolve => {
      timer = setTimeout(async () => {
        const cached = await cache.match(key);
        if (cached) resolve(cached);
      }, 3500);
    });
    try { return await Promise.race([network, delayedCache]); }
    catch { return (await cache.match(key)) || Response.error(); }
    finally { clearTimeout(timer); }
  })());
});
