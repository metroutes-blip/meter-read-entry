// Serve from cache first so the app opens offline; refresh the cache in the
// background so a new version is picked up on the next launch.
const CACHE = 'meter-read-entry-v39';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './vendor/xlsx.full.min.js',
  './vendor/jszip.min.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/fonts/fonts.css',
  './vendor/fonts/IBMPlexSans.woff2',
  './vendor/fonts/IBMPlexMono-500.woff2',
  './vendor/fonts/IBMPlexMono-600.woff2',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Fetch app files past the browser's HTTP cache: GitHub Pages lets it keep files for
// 10 minutes, and a new version must never be cached with the previous version's files.
const fresh = url => new Request(url, { cache: 'reload', credentials: 'same-origin' });

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(fresh))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      // Only this app's old versions: other apps on metroutes-blip.github.io (OUTS) share this cache store.
      .then(keys => Promise.all(keys.filter(k => k.startsWith('meter-read-entry-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return;

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
