// Leela Chess service worker.
// 1. Offline: app files are served from the cache and refreshed in the
//    background. The network and WebAssembly runtime (about 70 MB) are cached
//    by engine-worker.js in their own cache, which survives app updates.
// 2. Speed: every response gets the two headers that make the page
//    "cross-origin isolated", which lets Leela use several processor cores.
//    GitHub Pages can't send these headers itself.
const CACHE = 'leela-chess-v1';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './lc0.js',
  './engine-worker.js',
  './styles.css',
  './manifest.json',
  './vendor/chess.js',
  './vendor/ort/ort.webgpu.min.mjs',
  './vendor/ort/ort-wasm-simd-threaded.asyncify.mjs',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  ...['w', 'b'].flatMap(c => ['P', 'N', 'B', 'R', 'Q', 'K'].map(p => `./pieces/${c}${p}.svg`)),
];
const BIG = ['/model/', '.wasm'];

const fresh = url => new Request(url, { cache: 'reload', credentials: 'same-origin' });

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(fresh))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('leela-chess-v') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isolate(res) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // The big files: the engine worker keeps them in its own cache.
  if (BIG.some(b => url.pathname.includes(b))) {
    event.respondWith(
      caches.open('leela-chess-big-v1')
        .then(c => c.match(req.url))
        .then(hit => hit || fetch(req))
        .then(isolate)
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(req, { ignoreSearch: true })
        || (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
      const network = fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }))
        .then(res => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      if (cached) {
        event.waitUntil(network);
        return isolate(cached);
      }
      return isolate(await network);
    })
  );
});
