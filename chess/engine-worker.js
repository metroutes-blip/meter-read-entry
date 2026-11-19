// Runs Leela off the main thread: loads the network with ONNX Runtime Web
// (WebGPU when the iPad offers it, otherwise WebAssembly on the CPU) and
// answers search requests from app.js.

import * as ort from './vendor/ort/ort.webgpu.min.mjs';
import { Search, PLANES, POLICY_SIZE, START_FEN } from './lc0.js';

const MODEL_URL = new URL('./model/t1-256x10.onnx', import.meta.url).href;
const WASM_URL = new URL('./vendor/ort/ort-wasm-simd-threaded.asyncify.wasm', import.meta.url).href;
// Large files are kept in their own cache, so app updates don't download them
// again. Change a file's name to replace it.
const BIG_CACHE = 'leela-chess-big-v1';

let session = null;
let backend = '';
let batchSize = 8;
let search = null;
let running = null;      // promise of the search in progress
let currentId = 0;

const post = (type, data = {}) => self.postMessage({ type, ...data });

async function cachedBytes(url, onProgress) {
  let cache = null;
  try { cache = await caches.open(BIG_CACHE); } catch { /* private mode */ }
  let res = cache ? await cache.match(url) : null;
  const fromCache = !!res;
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url.split('/').pop()}`);
  }
  const total = +res.headers.get('content-length') || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (onProgress) onProgress(loaded, total, fromCache);
  }
  const bytes = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) { bytes.set(c, o); o += c.length; }
  if (cache && !fromCache) {
    try {
      await cache.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(loaded) } }));
    } catch { /* storage full: still works online */ }
  }
  return bytes;
}

// Pad each batch to a few fixed sizes so the GPU compiles few shader variants.
const SIZES = [1, 2, 4, 8, 16, 32];
async function evaluate(planes, count) {
  const size = SIZES.find(s => s >= count) || count;
  let input = planes;
  if (size !== count) {
    input = new Float32Array(size * PLANES * 64);
    input.set(planes);
  }
  const r = await session.run({ '/input/planes': new ort.Tensor('float32', input, [size, PLANES, 8, 8]) });
  return {
    policy: r['/output/policy'].data,
    wdl: r['/output/wdl'].data,
    mlh: r['/output/mlh'] ? r['/output/mlh'].data : null,
  };
}

// A quick check that a backend gives sane answers: from the starting position
// Leela's top choices are d4, e4, Nf3 and c4, and the game is roughly level.
async function sanityCheck() {
  const s = new Search(evaluate);
  s.setPosition(START_FEN, []);
  await s.run({ nodes: 1 });
  const root = s.root;
  if (!root.moves || !root.priors || !Number.isFinite(root.wl)) return false;
  const top = s.info(performance.now(), 0).best;
  return ['d2d4', 'e2e4', 'g1f3', 'c2c4'].includes(top) && Math.abs(root.wl) < 0.5;
}

async function init({ preferGpu = true }) {
  const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
  ort.env.logLevel = 'error';

  let wasmDone = 0, wasmTotal = 0, modelDone = 0, modelTotal = 0, cached = true;
  const report = () => post('progress', { loaded: wasmDone + modelDone, total: wasmTotal + modelTotal || 0, cached });
  const [wasm, model] = await Promise.all([
    cachedBytes(WASM_URL, (l, t, c) => { wasmDone = l; wasmTotal = t; cached = cached && c; report(); }),
    cachedBytes(MODEL_URL, (l, t, c) => { modelDone = l; modelTotal = t; cached = cached && c; report(); }),
  ]);
  ort.env.wasm.wasmBinary = wasm;
  post('progress', { loaded: 1, total: 1, phase: 'starting', cached });

  const attempts = [];
  if (preferGpu && 'gpu' in navigator) attempts.push(['webgpu', 16]);
  attempts.push(['wasm', 8]);
  let lastError = null;
  for (const [ep, batch] of attempts) {
    try {
      session = await ort.InferenceSession.create(model, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all',
      });
      backend = ep;
      batchSize = batch;
      if (await sanityCheck()) break;
      lastError = new Error(`${ep} gave wrong answers`);
    } catch (e) {
      lastError = e;
    }
    if (session) { try { await session.release(); } catch { /* ignore */ } }
    session = null;
  }
  if (!session) throw lastError || new Error('No way to run the network on this device');
  search = new Search(evaluate);
  // Measure speed on a short search so the app can describe the levels.
  search.setPosition(START_FEN, []);
  const bench = await search.run({ nodes: batchSize * 6, batch: batchSize });
  post('ready', { backend, threads: backend === 'wasm' ? threads : 0, nps: bench.nps });
}

async function go(msg) {
  const { id, startFen, moves, limits = {}, sample } = msg;
  search.setPosition(startFen || START_FEN, moves || []);
  const info = await search.run({
    nodes: limits.nodes ?? Infinity,
    timeMs: limits.timeMs ?? Infinity,
    infinite: !!limits.infinite,
    batch: batchSize,
    reportMs: 250,
    onInfo: i => { if (id === currentId) post('info', { id, info: i }); },
  });
  let move = info.best;
  if (sample && search.root.moves) move = search.samplePolicy(sample.temperature || 1, sample.minShare || 0.1) || move;
  post('done', { id, info, move });
}

let queue = Promise.resolve();
self.onmessage = e => {
  const msg = e.data;
  if (msg.type === 'init') {
    init(msg).catch(err => post('error', { message: String(err && err.message || err) }));
  } else if (msg.type === 'go') {
    currentId = msg.id;
    if (search) search.stop();
    queue = queue.then(async () => {
      if (msg.id !== currentId || !search) return;   // superseded before it started
      try { await go(msg); } catch (err) { post('error', { id: msg.id, message: String(err && err.message || err) }); }
    });
  } else if (msg.type === 'stop') {
    if (search) search.stop();
  } else if (msg.type === 'clear') {
    if (search) { search.stop(); search.root = null; search.rootGame = null; }
  }
};
