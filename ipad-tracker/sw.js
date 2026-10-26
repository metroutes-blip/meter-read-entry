// Serve from cache first so the app opens offline; refresh the cache in the
// background so a new version is picked up on the next launch.
const CACHE = 'ipad-tracker-v1';
// Libraries (several MB for the text reader): kept across app updates, cached on first use.
// Change this name only when a file in vendor/ changes.
const VENDOR_CACHE = 'ipad-tracker-vendor-v1';
const FONT_CACHE = 'ipad-tracker-fonts';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './parse.js',
  './styles.css',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
const VENDOR_ASSETS = [
  './vendor/zxing/zxing-full.js',
  './vendor/zxing/zxing_full.wasm',
];
const KEEP = [CACHE, VENDOR_CACHE, FONT_CACHE];

// Fetch app files past the browser's HTTP cache: GitHub Pages lets it keep files for
// 10 minutes, and a new version must never be cached with the previous version's files.
const fresh = url => new Request(url, { cache: 'reload', credentials: 'same-origin' });

self.addEventListener('install', event => {
  event.waitUntil(Promise.all([
    caches.open(CACHE).then(c => c.addAll(ASSETS.map(fresh))),
    caches.open(VENDOR_CACHE).then(async c => {
      for (const url of VENDOR_ASSETS) if (!await c.match(url)) await c.add(fresh(url));
    }),
  ]).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      // Only this app's old versions: other apps on this origin (LVB, OUTS) share the cache store.
      .then(keys => Promise.all(keys.filter(k => k.startsWith('ipad-tracker-') && !KEEP.includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function cacheFirst(cacheName, req) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreSearch: true });
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Fonts: the files at a given Google Fonts URL never change.
  if (FONT_HOSTS.includes(url.hostname)) { event.respondWith(cacheFirst(FONT_CACHE, req)); return; }
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;
  if (url.pathname.startsWith(`${scope.pathname}vendor/`)) { event.respondWith(cacheFirst(VENDOR_CACHE, req)); return; }

  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(req, { ignoreSearch: true })
        || (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
      // Background refresh: revalidate with the server (a cheap 304 when nothing changed).
      const network = fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }))
        .then(res => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      return network;
    })
  );
});
