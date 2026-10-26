'use strict';

const APP_VERSION = '1.0.0';
const STATUSES = ['In use', 'Spare', 'Repair', 'Lost', 'Retired'];
const FIELDS = [
  ['assetTag', 'Asset tag'], ['serial', 'Serial'], ['name', 'Name'], ['model', 'Model'],
  ['area', 'Area'], ['assignedTo', 'Assigned to'], ['status', 'Status'], ['notes', 'Notes'],
];
const HISTORY_MAX = 300;
const UNSEEN_DAYS = 30;
// What the scanner looks for: our own labels plus the barcodes already on iPad boxes and asset stickers.
const SCAN_FORMATS = ['QRCode', 'DataMatrix', 'MicroQRCode', 'Code128', 'Code39', 'Code93', 'EAN-13', 'UPC-A', 'ITF', 'PDF417', 'Aztec'];

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
const now = () => new Date().toISOString();
const byTag = (a, b) => (a.assetTag || a.serial || '').localeCompare(b.assetTag || b.serial || '', undefined, { numeric: true, sensitivity: 'base' });
const norm = s => String(s || '').trim().toUpperCase();

// Settings live in localStorage under "ipt." so they never collide with LVB on the same origin.
const prefs = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`ipt.${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`ipt.${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};
const userName = () => prefs.get('user', '').trim();

let toastTimer;
function toast(msg, ms = 2500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function seenText(iso) {
  if (!iso) return 'Never scanned';
  const days = Math.floor((Date.now() - new Date(iso)) / 86400000);
  if (days <= 0) return 'Seen today';
  if (days === 1) return 'Seen yesterday';
  return `Seen ${days} days ago`;
}
const isUnseen = rec => !rec.lastSeenAt || Date.now() - new Date(rec.lastSeenAt) > UNSEEN_DAYS * 86400000;

// ══════════════════════════════════════════════════════════════
//  IndexedDB — "ipads" holds one record per iPad (deleted ones stay as
//  tombstones so sharing can pass the deletion on), "kv" holds sync state.
// ══════════════════════════════════════════════════════════════
let dbPromise;
function openDb() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('ipad-tracker', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('ipads')) db.createObjectStore('ipads', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const store = {
  all: () => tx('ipads', 'readonly', s => s.getAll()),
  put: recs => tx('ipads', 'readwrite', s => { for (const r of [].concat(recs)) s.put(r); }),
  kvGet: key => tx('kv', 'readonly', s => s.get(key)),
  kvSet: (key, value) => tx('kv', 'readwrite', s => s.put(value, key)),
};

// ══════════════════════════════════════════════════════════════
//  Inventory
// ══════════════════════════════════════════════════════════════
const ipads = new Map(); // id → record, tombstones included
const live = () => [...ipads.values()].filter(r => !r.deleted);

function findByCode(raw) {
  const text = codeToKey(raw);
  if (!text) return null;
  const n = norm(text);
  const serial = AboutParser.cleanSerial(n);
  return live().find(r => norm(r.assetTag) === n || norm(r.serial) === n || (serial && norm(r.serial) === serial) || r.id === text) || null;
}

// Our "link" labels hold ...#ipad=<tag>; anything else is the code itself.
function codeToKey(raw) {
  const text = String(raw || '').trim();
  const m = /[#?&]ipad=([^&#\s]+)/.exec(text);
  return m ? decodeURIComponent(m[1]) : text;
}

function historyEntry(text) {
  return { id: uid(), at: now(), by: userName(), text };
}
function addHistory(rec, text) {
  rec.history = [...(rec.history || []), historyEntry(text)].slice(-HISTORY_MAX);
}

async function saveRecord(rec, note) {
  rec.updatedAt = now();
  rec.updatedBy = userName();
  if (note) addHistory(rec, note);
  ipads.set(rec.id, rec);
  await store.put(rec);
  await markPending(rec);
  scheduleSync();
}

function describeChanges(before, after) {
  const out = [];
  for (const [key, label] of FIELDS) {
    const a = before[key] || '';
    const b = after[key] || '';
    if (a === b) continue;
    if (key === 'notes') out.push('Notes changed');
    else out.push(a ? `${label}: ${a} → ${b || '(blank)'}` : `${label}: ${b}`);
  }
  return out.join(' · ');
}

async function markSeen(rec, how) {
  rec.lastSeenAt = now();
  rec.lastSeenBy = userName();
  await saveRecord(rec, how);
}

// Two copies of one iPad (this device and the shared file): the newer edit wins,
// the history is the union of both, and "last seen" is the latest of the two.
function mergeRecord(a, b) {
  if (!a) return b;
  if (!b) return a;
  const newer = (b.updatedAt || '') > (a.updatedAt || '') ? b : a;
  const older = newer === a ? b : a;
  const hist = new Map();
  for (const h of [...(older.history || []), ...(newer.history || [])]) hist.set(h.id, h);
  const merged = { ...newer, history: [...hist.values()].sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0)).slice(-HISTORY_MAX) };
  if ((older.lastSeenAt || '') > (newer.lastSeenAt || '')) {
    merged.lastSeenAt = older.lastSeenAt;
    merged.lastSeenBy = older.lastSeenBy;
  }
  return merged;
}
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const sameRecord = (a, b) => canonical(a ?? null) === canonical(b ?? null);

const distinct = key => [...new Set(live().map(r => (r[key] || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

// ══════════════════════════════════════════════════════════════
//  Navigation
// ══════════════════════════════════════════════════════════════
const nav = ['home'];
function showView(name) {
  const leaving = $('.view.active')?.id.replace('view-', '');
  if (leaving === 'scan' && name !== 'scan') stopCamera();
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  window.scrollTo(0, 0);
  if (name === 'home') renderHome();
  if (name === 'labels') renderLabels();
  if (name === 'settings') renderSettings();
}
function go(name) { nav.push(name); showView(name); }
function replaceView(name) { nav[nav.length - 1] = name; showView(name); }
async function back() {
  if (nav.at(-1) === 'ipad' && formDirty() && !await confirmBox('Discard changes?', 'Your changes to this iPad have not been saved.', 'Discard')) return;
  if (nav.length > 1) nav.pop();
  showView(nav.at(-1));
}
const viewActive = name => $(`#view-${name}`).classList.contains('active');

function confirmBox(title, text, okLabel = 'OK') {
  const dlg = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

// ══════════════════════════════════════════════════════════════
//  Inventory list
// ══════════════════════════════════════════════════════════════
function fillSelect(sel, options, keep = true) {
  const current = sel.value;
  sel.innerHTML = options.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
  if (keep && options.some(([v]) => v === current)) sel.value = current;
}

function renderHome() {
  const all = live();
  const areas = distinct('area');
  fillSelect($('#filter-area'), [['', 'All areas'], ...areas.map(a => [a, a]), ...(all.some(r => !r.area) ? [['\u0000', 'No area']] : [])]);
  fillSelect($('#filter-status'), [['', 'All statuses'], ...STATUSES.map(s => [s, s])]);
  $('#areas').innerHTML = areas.map(a => `<option value="${esc(a)}">`).join('');
  $('#workers').innerHTML = distinct('assignedTo').map(a => `<option value="${esc(a)}">`).join('');

  const counts = STATUSES.map(s => [s, all.filter(r => (r.status || 'In use') === s).length]).filter(([, n]) => n);
  $('#home-summary').textContent = all.length
    ? [`${all.length} iPad${all.length === 1 ? '' : 's'}`, ...counts.map(([s, n]) => `${n} ${s.toLowerCase()}`)].join(' · ')
    : 'Track who has each iPad and where it is';

  const q = $('#search').value.trim().toLowerCase();
  const area = $('#filter-area').value;
  const status = $('#filter-status').value;
  const unseen = $('#filter-unseen').checked;
  const shown = all.filter(r => {
    if (area === '\u0000' ? r.area : area && r.area !== area) return false;
    if (status && (r.status || 'In use') !== status) return false;
    if (unseen && (!isUnseen(r) || ['Retired', 'Lost'].includes(r.status))) return false;
    if (q && ![r.assetTag, r.serial, r.name, r.model, r.area, r.assignedTo, r.notes].some(v => (v || '').toLowerCase().includes(q))) return false;
    return true;
  }).sort(byTag);

  $('#empty').hidden = all.length > 0;
  const groups = new Map();
  for (const r of shown) {
    const key = r.area || 'No area';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === 'No area') - (b === 'No area') || a.localeCompare(b));
  $('#ipad-list').innerHTML = all.length && !shown.length
    ? '<p class="muted">No iPads match.</p>'
    : keys.map(k => `
      <h2 class="group-title">${esc(k)} <span>${groups.get(k).length}</span></h2>
      <ul class="ipad-list">${groups.get(k).map(itemHtml).join('')}</ul>`).join('');
}

function itemHtml(r) {
  const status = r.status || 'In use';
  const meta = [r.serial, r.model || r.name].filter(Boolean).join(' · ');
  return `<li><button type="button" class="ipad-item" data-id="${esc(r.id)}">
    <span class="tag">${esc(r.assetTag || r.serial || '(no tag)')}</span>
    <span class="badge s-${status.toLowerCase().replace(/\s+/g, '-')}">${esc(status)}</span>
    <span class="who">${esc(r.assignedTo || 'Not assigned')}</span>
    ${meta ? `<span class="meta">${esc(meta)}</span>` : ''}
    <span class="seen">${esc(seenText(r.lastSeenAt))}${r.lastSeenBy ? ` by ${esc(r.lastSeenBy)}` : ''}</span>
  </button></li>`;
}

// ══════════════════════════════════════════════════════════════
//  One iPad
// ══════════════════════════════════════════════════════════════
const editing = { id: null, snapshot: '' };
const form = () => $('#ipad-form');
function formValues() {
  const f = form();
  return Object.fromEntries(FIELDS.map(([k]) => [k, (f.elements[k].value || '').trim()]));
}
const formDirty = () => canonical(formValues()) !== editing.snapshot;

function fillForm(values) {
  const f = form();
  fillSelect(f.elements.status, STATUSES.map(s => [s, s]), false);
  for (const [k] of FIELDS) f.elements[k].value = values[k] || (k === 'status' ? 'In use' : '');
}

function openIpad(id, prefill = {}, { replace = false } = {}) {
  const rec = id ? ipads.get(id) : null;
  editing.id = rec ? rec.id : null;
  fillForm(rec || {});
  editing.snapshot = canonical(formValues());
  // Values read from a code or the Settings screen fill blanks; a new serial replaces the old one.
  const f = form();
  for (const [k, v] of Object.entries(prefill)) {
    if (!v || !f.elements[k]) continue;
    if (!f.elements[k].value || k === 'serial') f.elements[k].value = v;
  }
  renderIpadExtra();
  if (replace) replaceView('ipad'); else go('ipad');
}

function renderIpadExtra() {
  const rec = editing.id ? ipads.get(editing.id) : null;
  $('#ipad-title').textContent = rec ? (rec.assetTag || rec.serial || 'iPad') : 'New iPad';
  $('#ipad-extra').hidden = !rec;
  if (!rec) return;
  const content = codeContent(rec);
  $('#code-content').textContent = content ? `Holds: ${content}` : 'Add an asset tag or serial to make a code';
  for (const [el, format] of [['#code-qr', 'QRCode'], ['#code-dm', 'DataMatrix']]) {
    $(el).innerHTML = '';
    if (content) codeSvg(content, format).then(svg => { $(el).innerHTML = svg; }).catch(err => { $(el).textContent = err.message; });
  }
  const hist = [...(rec.history || [])].reverse();
  $('#history').innerHTML = hist.length
    ? hist.map(h => `<li>${esc(h.text)}<time>${esc(fmtDate(h.at))}${h.by ? ` · ${esc(h.by)}` : ''}</time></li>`).join('')
    : '<li class="muted">No history yet.</li>';
}

async function saveForm(e) {
  e.preventDefault();
  const values = formValues();
  if (!values.assetTag && !values.serial) {
    toast('Enter an asset tag or a serial number');
    form().elements.assetTag.focus();
    return;
  }
  if (values.serial) values.serial = values.serial.toUpperCase();
  const clash = live().find(r => r.id !== editing.id && (
    (values.assetTag && norm(r.assetTag) === norm(values.assetTag)) || (values.serial && norm(r.serial) === norm(values.serial))));
  if (clash && !await confirmBox('Already in the list',
    `${clash.assetTag || clash.serial} has the same ${norm(clash.serial) === norm(values.serial) && values.serial ? 'serial number' : 'asset tag'}. Save anyway?`, 'Save anyway')) return;

  const existing = editing.id ? ipads.get(editing.id) : null;
  if (existing) {
    const changes = describeChanges(existing, values);
    if (!changes) { toast('No changes'); return; }
    await saveRecord({ ...existing, ...values }, changes);
    toast('Saved');
  } else {
    const rec = { id: uid(), createdAt: now(), ...values, history: [] };
    const where = [values.area, values.assignedTo].filter(Boolean).join(', ');
    await saveRecord(rec, `Added${where ? ` (${where})` : ''}`);
    editing.id = rec.id;
    toast('iPad added');
  }
  fillForm(ipads.get(editing.id));
  editing.snapshot = canonical(formValues());
  renderIpadExtra();
}

// ══════════════════════════════════════════════════════════════
//  QR / Data Matrix codes (zxing-wasm, works offline)
// ══════════════════════════════════════════════════════════════
const ZX = window.ZXingWASM;
ZX.prepareZXingModule({
  overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? new URL('vendor/zxing/zxing_full.wasm', location.href).href : prefix + path) },
});

function appLink(tag) {
  const base = location.href.split('#')[0].split('?')[0].replace(/index\.html$/, '');
  return `${base}#ipad=${encodeURIComponent(tag)}`;
}
function codeContent(rec) {
  const mode = prefs.get('codeContent', 'tag');
  if (mode === 'serial') return rec.serial || rec.assetTag || '';
  const key = rec.assetTag || rec.serial || '';
  return mode === 'link' && key ? appLink(key) : key;
}

const svgCache = new Map();
async function codeSvg(text, format) {
  const key = `${format}\u0000${text}`;
  if (!svgCache.has(key)) {
    svgCache.set(key, ZX.writeBarcode(text, format === 'QRCode' ? { format, ecLevel: 'M' } : { format }).then(res => {
      if (res.error) throw new Error(res.error);
      // zxing draws fixed-size SVG; give it a viewBox so it scales to any label size.
      return res.svg
        .replace(/<\?xml[^>]*>\s*/, '').replace(/<!DOCTYPE[^>]*>\s*/, '')
        .replace(/<svg width="(\d+)" height="(\d+)"/, '<svg viewBox="0 0 $1 $2" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges"');
    }).catch(err => { svgCache.delete(key); throw err; }));
  }
  return svgCache.get(key);
}

async function saveCodeImage(format) {
  const rec = ipads.get(editing.id);
  const content = rec && codeContent(rec);
  if (!content) return;
  const res = await ZX.writeBarcode(content, { format, scale: format === 'QRCode' ? 16 : 20 });
  if (res.error || !res.image) { toast(res.error || 'Could not make the image'); return; }
  const name = `${(rec.assetTag || rec.serial).replace(/[^\w.-]+/g, '_')} ${format === 'QRCode' ? 'QR' : 'DataMatrix'}.png`;
  await saveFile(new File([res.image], name, { type: 'image/png' }));
}

async function saveFile(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

// ══════════════════════════════════════════════════════════════
//  Labels
// ══════════════════════════════════════════════════════════════
const labelOff = new Set();
function labelOpts() {
  return {
    format: prefs.get('labelFormat', 'QRCode'),
    size: prefs.get('labelSize', 'm'),
    area: prefs.get('labelArea', ''),
    showName: prefs.get('labelShowName', true),
    showArea: prefs.get('labelShowArea', false),
  };
}
async function labelHtml(rec, o) {
  const content = codeContent(rec);
  if (!content) return '';
  const svg = await codeSvg(content, o.format);
  const sub = [o.showName && rec.name, o.showArea && rec.area].filter(Boolean).map(esc).join(' · ');
  return `<div class="label size-${o.size}${labelOff.has(rec.id) ? ' off' : ''}" data-id="${esc(rec.id)}">
    <div class="code">${svg}</div>
    <div class="l-tag">${esc(rec.assetTag || rec.serial)}</div>
    ${sub ? `<div class="l-sub">${sub}</div>` : ''}
  </div>`;
}
async function renderLabels() {
  const o = labelOpts();
  const areas = distinct('area');
  fillSelect($('#label-area'), [['', `All iPads (${live().length})`], ...areas.map(a => [a, `${a} (${live().filter(r => r.area === a).length})`])], false);
  $('#label-area').value = areas.includes(o.area) ? o.area : '';
  $('#label-format').value = o.format;
  $('#label-size').value = o.size;
  $('#label-name').checked = o.showName;
  $('#label-area-text').checked = o.showArea;
  const recs = live().filter(r => !o.area || r.area === o.area).sort(byTag);
  const sheet = $('#label-sheet');
  const token = (sheet.dataset.token = uid());
  const html = (await Promise.all(recs.map(r => labelHtml(r, o).catch(() => '')))).join('');
  if (sheet.dataset.token !== token) return; // a newer render started meanwhile
  sheet.innerHTML = html || '<p>No iPads to print.</p>';
}
function printHtml(html) {
  $('#print-area').innerHTML = html;
  window.print();
}

// ══════════════════════════════════════════════════════════════
//  Camera: codes (zxing) and the Settings screen (Tesseract OCR)
// ══════════════════════════════════════════════════════════════
const scan = { stream: null, track: null, mode: 'code', purpose: 'find', timer: 0, busy: false, last: '', lastAt: 0, session: new Set(), ocrBusy: false };
let audioCtx;

function beep() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 1320;
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.12);
  } catch { /* no audio */ }
  navigator.vibrate?.(60);
}

// purpose: "find" (look up / add), "fill-tag" (put a scanned code in the form), "fill-text" (Settings screen into the form)
function openScan(mode, purpose = 'find') {
  // Created inside the tap so iPad allows the scan beep later.
  try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* no audio */ }
  scan.purpose = purpose;
  scan.session.clear();
  $('#stocktake-count').hidden = true;
  $('.segmented').hidden = purpose !== 'find';
  $('#stocktake-wrap').hidden = purpose !== 'find';
  $('#manual-form').hidden = purpose === 'fill-tag';
  go('scan');
  setScanMode(mode);
  startCamera();
}

function setScanMode(mode) {
  scan.mode = mode;
  $$('.segmented [data-mode]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
  $('#code-controls').hidden = mode !== 'code';
  $('#text-controls').hidden = mode !== 'text';
  $('#frame').classList.toggle('wide', mode === 'text');
  $('#scan-title').textContent = mode === 'code' ? (scan.purpose === 'fill-tag' ? 'Scan the label' : 'Scan') : 'Settings screen';
  $('#scan-hint').innerHTML = mode === 'code'
    ? 'Point the camera at a QR code, Data Matrix or barcode. It reads by itself.'
    : 'On the iPad, open <b>Settings › General › About</b>. Fill the frame with the list (Name down to Serial Number), hold steady, then tap <b>Read the screen</b>. For the iPad you are holding, take a screenshot of that page and use <b>Use a screenshot</b>.';
  clearTimeout(scan.timer);
  if (mode === 'code' && scan.stream) decodeLoop();
}

async function startCamera() {
  const msg = $('#camera-msg');
  msg.hidden = true;
  if (scan.stream) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    msg.textContent = 'This browser has no camera access. Open the app from its https address.';
    msg.hidden = false;
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    if (!viewActive('scan')) { stream.getTracks().forEach(t => t.stop()); return; }
    scan.stream = stream;
    scan.track = stream.getVideoTracks()[0];
    const video = $('#video');
    video.srcObject = stream;
    await video.play().catch(() => {});
    const caps = scan.track.getCapabilities?.() || {};
    $('#btn-torch').hidden = !caps.torch;
    if (caps.focusMode?.includes('continuous')) scan.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    if (scan.mode === 'code') decodeLoop();
  } catch (err) {
    msg.textContent = err.name === 'NotAllowedError'
      ? 'Camera access was blocked. Allow the camera for this app in Settings › Safari › Camera (or the site settings), then try again.'
      : `Camera could not start: ${err.message}`;
    msg.hidden = false;
  }
}

function stopCamera() {
  clearTimeout(scan.timer);
  scan.stream?.getTracks().forEach(t => t.stop());
  scan.stream = null;
  scan.track = null;
  $('#video').srcObject = null;
}

// One video frame as a canvas. crop = fraction of the frame kept around the centre.
function grabFrame(crop = 1, maxSide = 4096) {
  const video = $('#video');
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const sw = Math.round(vw * crop);
  const sh = Math.round(vh * crop);
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * k);
  canvas.height = Math.round(sh * k);
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function decodeLoop() {
  clearTimeout(scan.timer);
  if (!scan.stream || scan.mode !== 'code' || !viewActive('scan')) return;
  if (!scan.busy) {
    scan.busy = true;
    try {
      const canvas = grabFrame(0.8, 1280);
      if (canvas) {
        const img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
        const [hit] = await ZX.readBarcodes(img, { formats: SCAN_FORMATS, tryHarder: true, maxNumberOfSymbols: 1 });
        if (hit?.isValid && hit.text) onCode(hit.text.trim());
      }
    } catch (err) {
      console.warn('Scan failed', err);
    } finally {
      scan.busy = false;
    }
  }
  if (scan.stream && scan.mode === 'code') scan.timer = setTimeout(decodeLoop, 150);
}

function flashFrame() {
  const f = $('#frame');
  f.classList.add('hit');
  setTimeout(() => f.classList.remove('hit'), 500);
}

async function onCode(text) {
  // The same code stays in view for a while; act on it once.
  if (text === scan.last && Date.now() - scan.lastAt < 3000) return;
  scan.last = text;
  scan.lastAt = Date.now();
  beep();
  flashFrame();
  if (scan.purpose === 'fill-tag') {
    form().elements.assetTag.value = codeToKey(text);
    back();
    return;
  }
  await handleFound(text, 'Scanned');
}

async function handleFound(text, how) {
  const rec = findByCode(text);
  if ($('#stocktake').checked) {
    if (!rec) { toast(`Not in the list: ${codeToKey(text)}`, 3500); return; }
    await markSeen(rec, `${how} in stocktake`);
    scan.session.add(rec.id);
    const total = live().filter(r => !['Retired', 'Lost'].includes(r.status)).length;
    $('#stocktake-count').textContent = `${scan.session.size} scanned this session · ${live().filter(r => !isUnseen(r)).length} of ${total} seen in the last ${UNSEEN_DAYS} days`;
    $('#stocktake-count').hidden = false;
    toast(`✓ ${rec.assetTag || rec.serial}${rec.assignedTo ? ` · ${rec.assignedTo}` : ''}`);
    return;
  }
  stopCamera();
  if (rec) {
    // Typing a tag doesn't prove the iPad is here; scanning its label does.
    if (how === 'Scanned') await markSeen(rec, how);
    openIpad(rec.id, {}, { replace: true });
    return;
  }
  const key = codeToKey(text);
  const prefix = norm(prefs.get('prefix', ''));
  const asSerial = !(prefix && norm(key).startsWith(prefix)) && /^[A-Z0-9]{10,12}$/.test(norm(key)) && /\d/.test(key) && /[A-Z]/i.test(key);
  if (await confirmBox('Not in the list', `No iPad has the code “${key}”. Add a new iPad with it as its ${asSerial ? 'serial number' : 'asset tag'}?`, 'Add iPad')) {
    openIpad(null, asSerial ? { serial: norm(key) } : { assetTag: key }, { replace: true });
  } else {
    startCamera();
  }
}

// ── Settings screen (OCR) ──
let ocrWorkerPromise;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(s);
  });
}
// The SIMD build is faster; the plain one covers older iPads.
const wasmSimd = () => { try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch { return false; } };
const ocrFiles = () => {
  const base = new URL('vendor/tesseract/', location.href).href;
  return {
    script: `${base}tesseract.min.js`,
    workerPath: `${base}worker.min.js`,
    corePath: `${base}core/${wasmSimd() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js'}`,
    langPath: `${base}lang`,
  };
};
let ocrProgress = () => {};
function getOcr() {
  ocrWorkerPromise ||= (async () => {
    const files = ocrFiles();
    if (!window.Tesseract) await loadScript(files.script);
    const worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
      workerPath: files.workerPath,
      corePath: files.corePath,
      langPath: files.langPath,
      workerBlobURL: false, // load from our own URL so the service worker can serve it offline
      logger: m => ocrProgress(m),
    });
    // Mode 6 keeps each "Label   value" row of the About list on one line.
    await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    return worker;
  })().catch(err => { ocrWorkerPromise = null; throw err; });
  return ocrWorkerPromise;
}
// Fetch the OCR files once while online so reading the Settings screen also works offline later.
function warmOcrFiles() {
  if (!navigator.onLine || !('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;
  const f = ocrFiles();
  [f.script, f.workerPath, f.corePath, `${f.langPath}/eng.traineddata.gz`].forEach(u => fetch(u).catch(() => {}));
}

// Dark text on a plain white page, sized for OCR. Settings in dark mode is inverted first.
// The grey cards behind each list (and uneven light on a photographed screen) are flattened
// to white: left in, Tesseract's threshold can turn a whole card black and lose its text.
function prepareForOcr(source, sw, sh, maxSide) {
  const scale = maxSide / Math.max(sw, sh);
  const W = Math.round(sw * scale);
  const H = Math.round(sh * scale);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, W, H);
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const g = new Float32Array(W * H);
  for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;

  // Dark mode: judge by the middle of the picture, where the list is.
  let mid = 0, midN = 0;
  for (let y = H >> 2; y < (H * 3) >> 2; y += 2) for (let x = W >> 2; x < (W * 3) >> 2; x += 2) { mid += g[y * W + x]; midN++; }
  if (mid / midN < 110) for (let i = 0; i < g.length; i++) g[i] = 255 - g[i];

  // Background estimate: block means, then the brightest of each 3×3 neighbourhood (so text never counts as background).
  const B = Math.max(8, Math.round(Math.max(W, H) / 100));
  const bw = Math.ceil(W / B);
  const bh = Math.ceil(H / B);
  const mean = new Float32Array(bw * bh);
  const cnt = new Uint32Array(bw * bh);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = ((y / B) | 0) * bw + ((x / B) | 0); mean[k] += g[y * W + x]; cnt[k]++; }
  for (let k = 0; k < mean.length; k++) mean[k] /= cnt[k];
  const bg = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = by + dy, xx = bx + dx;
      if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) m = Math.max(m, mean[yy * bw + xx]);
    }
    bg[by * bw + bx] = Math.max(m, 1);
  }
  // Divide by the (bilinear) background, then darken greys so light-grey values read as solidly as labels.
  for (let y = 0; y < H; y++) {
    const fy = Math.min(Math.max((y + 0.5) / B - 0.5, 0), bh - 1);
    const y0 = fy | 0, y1 = Math.min(y0 + 1, bh - 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(Math.max((x + 0.5) / B - 0.5, 0), bw - 1);
      const x0 = fx | 0, x1 = Math.min(x0 + 1, bw - 1), tx = fx - x0;
      const b = (bg[y0 * bw + x0] * (1 - tx) + bg[y0 * bw + x1] * tx) * (1 - ty) + (bg[y1 * bw + x0] * (1 - tx) + bg[y1 * bw + x1] * tx) * ty;
      const v = Math.min(1, g[y * W + x] / b);
      const i = (y * W + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255 * v * v;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function showOcrProgress(text, frac) {
  const box = $('#ocr-progress');
  box.hidden = text == null;
  if (text == null) return;
  $('p', box).textContent = text;
  $('.bar span', box).style.width = `${Math.round((frac || 0) * 100)}%`;
}

// One OCR pass: what the parser found, how sure Tesseract was of the serial, and the usual line height.
async function ocrPass(worker, canvas) {
  const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
  const found = AboutParser.parseAbout(data.text, { assetPrefix: prefs.get('prefix', ''), nameIsAssetTag: prefs.get('nameIsTag', false) });
  const lines = (data.blocks || []).flatMap(b => b.paragraphs.flatMap(p => p.lines));
  const serialLine = lines.find(l => /s[eo]r[il1]a[il1]/i.test(l.text));
  found.confidence = found.serial ? (serialLine?.words.at(-1)?.confidence ?? 50) : 0;
  const heights = lines.filter(l => l.confidence > 40 && l.text.trim().length >= 3).map(l => l.bbox.y1 - l.bbox.y0).sort((x, y) => x - y);
  found.lineHeight = heights.length ? heights[heights.length >> 1] : 0;
  return found;
}

// The first pass works for screenshots and a screen filling the frame. If it finds no serial
// (screen small in the photo, or very close), a second pass resizes so rows are ~28 px tall.
const OCR_FIRST_SIZE = 1600;
const OCR_LINE_PX = 28;
async function readText(source, sw, sh) {
  if (scan.ocrBusy) return;
  scan.ocrBusy = true;
  $('#btn-capture').disabled = true;
  try {
    ocrProgress = m => {
      if (m.status === 'recognizing text') showOcrProgress('Reading the text…', m.progress);
      else if (/load|initiali/.test(m.status)) showOcrProgress('Getting the text reader ready (the first time can take a moment)…', m.progress);
    };
    showOcrProgress('Getting the text reader ready…', 0);
    const worker = await getOcr();
    showOcrProgress('Reading the text…', 0);
    let found = await ocrPass(worker, prepareForOcr(source, sw, sh, OCR_FIRST_SIZE));
    const off = found.lineHeight && Math.abs(found.lineHeight / OCR_LINE_PX - 1) > 0.3;
    if (off && found.confidence < 60) {
      const size = Math.round(Math.min(3200, Math.max(600, OCR_FIRST_SIZE * OCR_LINE_PX / found.lineHeight)));
      showOcrProgress('Checking…', 0);
      const second = await ocrPass(worker, prepareForOcr(source, sw, sh, size));
      const [best, other] = (second.serial && second.confidence >= found.confidence) || !found.serial ? [second, found] : [found, second];
      for (const k of ['name', 'modelName', 'modelNumber', 'assetTag']) best[k] ||= other[k];
      best.lines = best.lines.length >= other.lines.length ? best.lines : other.lines;
      found = best;
    }
    showOcrProgress(null);
    if (!found.serial && !found.lines.length) {
      toast('No text found. Move closer so the list fills the frame, and avoid glare.', 4000);
      return;
    }
    showOcrResults(found);
  } catch (err) {
    showOcrProgress(null);
    toast(navigator.onLine ? `Could not read the text: ${err.message}` : 'The text reader is not downloaded yet. Connect to the internet once and try again.', 5000);
  } finally {
    scan.ocrBusy = false;
    $('#btn-capture').disabled = false;
  }
}

async function captureScreen() {
  const frame = grabFrame(1);
  if (!frame) { toast('The camera is not ready yet'); return; }
  await readText(frame, frame.width, frame.height);
}

async function readScreenshot(file) {
  if (!file) return;
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch (err) {
    toast(`Could not open that image: ${err.message}`, 4000);
    return;
  }
  await readText(bmp, bmp.width, bmp.height);
  bmp.close?.();
}

let ocrTarget = null;
function showOcrResults(found) {
  const dlg = $('#ocr-dialog');
  const f = $('#ocr-form');
  f.elements.serial.value = found.serial;
  f.elements.assetTag.value = found.assetTag;
  f.elements.name.value = found.name;
  f.elements.model.value = found.modelName || found.modelNumber;
  ocrTarget = f.elements.serial;
  $('#ocr-unsure').hidden = !found.serial || found.confidence >= 80;
  $('#ocr-lines').innerHTML = found.lines
    .flatMap(l => [l, ...l.split(/\s{2,}/)].filter((v, i, a) => v && a.indexOf(v) === i))
    .map(t => `<button type="button" data-text="${esc(t)}">${esc(t)}</button>`).join('');
  updateOcrMatch();
  dlg.returnValue = '';
  dlg.showModal();
}
function ocrValues() {
  const f = $('#ocr-form');
  return {
    serial: norm(f.elements.serial.value).replace(/\s+/g, ''),
    assetTag: f.elements.assetTag.value.trim(),
    name: f.elements.name.value.trim(),
    model: f.elements.model.value.trim(),
  };
}
function ocrMatch() {
  const v = ocrValues();
  return (v.serial && findByCode(v.serial)) || (v.assetTag && findByCode(v.assetTag)) || null;
}
function updateOcrMatch() {
  const el = $('#ocr-match');
  const rec = scan.purpose === 'find' ? ocrMatch() : null;
  el.hidden = !rec;
  if (rec) el.textContent = `Already in the list as ${rec.assetTag || rec.serial}${rec.assignedTo ? ` (${rec.assignedTo})` : ''}. “Use these” opens it.`;
  $('#ocr-use').textContent = scan.purpose === 'find' ? (rec ? 'Open this iPad' : 'Add this iPad') : 'Use these';
}
async function useOcrResults() {
  const v = ocrValues();
  if (scan.purpose === 'fill-text') {
    const f = form();
    if (v.serial) f.elements.serial.value = v.serial;
    for (const k of ['assetTag', 'name', 'model']) if (v[k] && !f.elements[k].value.trim()) f.elements[k].value = v[k];
    back();
    return;
  }
  const rec = ocrMatch();
  stopCamera();
  if (rec) {
    await markSeen(rec, 'Read from its Settings screen');
    openIpad(rec.id, v, { replace: true });
  } else {
    openIpad(null, v, { replace: true });
  }
}

// ══════════════════════════════════════════════════════════════
//  Sharing between devices: one JSON file in a GitHub repo
// ══════════════════════════════════════════════════════════════
const sync = { busy: false, lastError: '', lastSync: 0, pending: {}, timer: 0, sha: null };
const syncSettings = () => ({ repo: 'metroutes-blip/meter-geocodes', path: 'ipads.json', branch: 'main', token: '', ...prefs.get('sync', {}) });
const syncConfigured = () => { const s = syncSettings(); return !!(s.repo && s.token); };

async function markPending(rec) {
  sync.pending[rec.id] = rec.updatedAt;
  await store.kvSet('pending', sync.pending);
}
function scheduleSync(ms = 3000) {
  clearTimeout(sync.timer);
  setSyncStatus();
  sync.timer = setTimeout(syncNow, ms);
}

function textToB64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64ToText(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function ghFetch(url, opts = {}) {
  return fetch(url, {
    cache: 'no-store',
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${syncSettings().token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
}
function ghError(status) {
  if (status === 401) return 'GitHub rejected the access token';
  if (status === 403) return 'The token is not allowed to do this (needs Contents: read and write)';
  if (status === 404) return 'Repository not found, or the token has no access to it';
  return `GitHub error ${status}`;
}
const ghRepoUrl = s => `https://api.github.com/repos/${s.repo}`;
const ghFileUrl = s => `${ghRepoUrl(s)}/contents/${s.path.split('/').map(encodeURIComponent).join('/')}`;

async function fetchRemote() {
  const s = syncSettings();
  const res = await ghFetch(`${ghFileUrl(s)}?ref=${encodeURIComponent(s.branch)}`);
  if (res.status === 404) {
    // Either the file doesn't exist yet (fine) or the repo is unreachable (not fine).
    const repo = await ghFetch(ghRepoUrl(s));
    if (!repo.ok) throw new Error(ghError(repo.status));
    return { sha: null, ipads: {} };
  }
  if (!res.ok) throw new Error(ghError(res.status));
  const meta = await res.json();
  let b64 = meta.content;
  if (!b64) { // files over 1 MB come back without content
    const blob = await ghFetch(`${ghRepoUrl(s)}/git/blobs/${meta.sha}`);
    if (!blob.ok) throw new Error(ghError(blob.status));
    b64 = (await blob.json()).content;
  }
  const text = b64ToText(b64);
  let data = {};
  try { if (text.trim()) data = JSON.parse(text); } catch { throw new Error(`${s.path} on GitHub is not valid JSON`); }
  return { sha: meta.sha, ipads: data.ipads || {} };
}

// One iPad per line so changes are easy to read in GitHub's history.
function syncFileText(all) {
  const lines = Object.keys(all).sort().map(k => `    ${JSON.stringify(k)}: ${JSON.stringify(all[k])}`);
  return `{\n  "version": 1,\n  "updated": ${JSON.stringify(now())},\n  "ipads": {\n${lines.join(',\n')}\n  }\n}\n`;
}

// Pull the shared file, merge it with this device (newest edit wins per iPad), push back if anything is new.
async function syncNow() {
  clearTimeout(sync.timer);
  if (!syncConfigured() || sync.busy || !navigator.onLine) { setSyncStatus(); return; }
  sync.busy = true;
  setSyncStatus();
  try {
    const s = syncSettings();
    for (let attempt = 1; ; attempt++) {
      const remote = await fetchRemote();
      const snapshot = { ...sync.pending };
      const merged = {};
      for (const id of new Set([...Object.keys(remote.ipads), ...ipads.keys()])) merged[id] = mergeRecord(remote.ipads[id], ipads.get(id));
      const changed = Object.keys(merged).filter(id => !sameRecord(merged[id], remote.ipads[id]));
      if (changed.length) {
        const body = {
          message: `iPads: ${changed.length} updated${userName() ? ` by ${userName()}` : ''}`,
          content: textToB64(syncFileText(merged)),
          branch: s.branch,
        };
        if (remote.sha) body.sha = remote.sha;
        const res = await ghFetch(ghFileUrl(s), { method: 'PUT', body: JSON.stringify(body) });
        if ((res.status === 409 || res.status === 422) && attempt < 4) continue; // another device saved first
        if (!res.ok) throw new Error(ghError(res.status));
      }
      // Bring in what other devices changed, unless it was edited here again during the upload.
      const local = Object.keys(merged).filter(id => !sameRecord(merged[id], ipads.get(id)) && sync.pending[id] === snapshot[id]);
      for (const id of local) ipads.set(id, merged[id]);
      if (local.length) await store.put(local.map(id => merged[id]));
      for (const id of Object.keys(snapshot)) if (sync.pending[id] === snapshot[id]) delete sync.pending[id];
      await store.kvSet('pending', sync.pending);
      if (local.length) refreshViews();
      break;
    }
    sync.lastError = '';
    sync.lastSync = Date.now();
  } catch (err) {
    sync.lastError = err.message === 'Failed to fetch' || err.name === 'TypeError' ? 'No connection to GitHub' : err.message;
  } finally {
    sync.busy = false;
    setSyncStatus();
  }
}

function syncStatusText() {
  const n = Object.keys(sync.pending).length;
  const waiting = n ? `${n} change${n === 1 ? '' : 's'} waiting to upload` : '';
  if (!syncConfigured()) return prefs.get('sync', null) ? 'Sharing is off · saved on this device only' : '';
  if (sync.busy) return 'Syncing…';
  if (sync.lastError) return `Sync problem: ${sync.lastError}${n ? ` · ${waiting}` : ''}`;
  if (n) return navigator.onLine ? waiting : `Offline · ${waiting}`;
  if (sync.lastSync) return `Shared list up to date (${new Date(sync.lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})`;
  return 'Shared list';
}
function setSyncStatus() {
  const text = syncStatusText();
  $$('.sync-status').forEach(el => {
    el.textContent = text;
    el.classList.toggle('error', !!sync.lastError);
  });
}

function refreshViews() {
  if (viewActive('home')) renderHome();
  if (viewActive('labels')) renderLabels();
  // Don't overwrite a form someone is typing in; just refresh the codes and history.
  if (viewActive('ipad') && editing.id) {
    if (!formDirty()) { fillForm(ipads.get(editing.id)); editing.snapshot = canonical(formValues()); }
    renderIpadExtra();
  }
}

// ══════════════════════════════════════════════════════════════
//  Settings, import and export
// ══════════════════════════════════════════════════════════════
function renderSettings() {
  const s = syncSettings();
  $('#set-user').value = userName();
  $('#set-code-content').value = prefs.get('codeContent', 'tag');
  $('#set-prefix').value = prefs.get('prefix', '');
  $('#set-name-tag').checked = prefs.get('nameIsTag', false);
  $('#gh-repo').value = s.repo;
  $('#gh-path').value = s.path;
  $('#gh-branch').value = s.branch;
  $('#gh-token').value = s.token;
  $('#app-version').textContent = APP_VERSION;
  setSyncStatus();
}

const CSV_COLUMNS = [
  ['assetTag', 'Asset Tag', /^(asset\s*(tag|#|no|number)?|tag)$/i],
  ['serial', 'Serial', /^serial(\s*(number|no|#))?$/i],
  ['name', 'Name', /^(device\s*)?name$/i],
  ['model', 'Model', /^model(\s*name)?$/i],
  ['area', 'Area', /^(area|location|site|department)$/i],
  ['assignedTo', 'Assigned To', /^(assigned(\s*to)?|worker|user|employee|owner)$/i],
  ['status', 'Status', /^status$/i],
  ['notes', 'Notes', /^(notes?|comments?)$/i],
];
const csvCell = v => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function exportCsv() {
  const rows = [[...CSV_COLUMNS.map(c => c[1]), 'Last Seen', 'Last Seen By']];
  for (const r of live().sort(byTag)) rows.push([...CSV_COLUMNS.map(([k]) => r[k] || (k === 'status' ? 'In use' : '')), r.lastSeenAt ? fmtDate(r.lastSeenAt) : '', r.lastSeenBy || '']);
  const text = `﻿${rows.map(row => row.map(v => csvCell(String(v))).join(',')).join('\r\n')}\r\n`;
  saveFile(new File([text], `iPads ${new Date().toISOString().slice(0, 10)}.csv`, { type: 'text/csv' }));
}
function exportJson() {
  const text = JSON.stringify({ app: 'ipad-tracker', version: 1, exported: now(), ipads: [...ipads.values()] }, null, 1);
  saveFile(new File([text], `iPads backup ${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' }));
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

async function importFile(file) {
  const text = await file.text();
  if (/\.json$/i.test(file.name) || text.trim().startsWith('{')) {
    let data;
    try { data = JSON.parse(text); } catch { toast('That file is not a valid backup'); return; }
    const list = Array.isArray(data.ipads) ? data.ipads : Object.values(data.ipads || {});
    if (!list.length || !list.every(r => r && r.id)) { toast('That file is not an iPad Tracker backup'); return; }
    if (!await confirmBox('Restore backup?', `${list.length} iPads in the file. Newer changes win, nothing is lost from either side.`, 'Restore')) return;
    const changed = [];
    for (const r of list) {
      const merged = mergeRecord(ipads.get(r.id), r);
      if (!sameRecord(merged, ipads.get(r.id))) { merged.updatedAt = now(); changed.push(merged); ipads.set(r.id, merged); }
    }
    if (changed.length) { await store.put(changed); for (const r of changed) await markPending(r); scheduleSync(); }
    toast(`Restored: ${changed.length} iPad${changed.length === 1 ? '' : 's'} changed`);
    return;
  }

  const rows = parseCsv(text);
  if (rows.length < 2) { toast('No rows found in that file'); return; }
  const header = rows[0].map(h => h.trim());
  const map = CSV_COLUMNS.map(([key, , re]) => [key, header.findIndex(h => re.test(h))]).filter(([, i]) => i >= 0);
  if (!map.some(([k]) => k === 'assetTag' || k === 'serial')) {
    toast('The first row needs an "Asset Tag" or "Serial" column', 4000);
    return;
  }
  let added = 0, updated = 0;
  for (const row of rows.slice(1)) {
    const values = {};
    for (const [k, i] of map) values[k] = (row[i] || '').trim();
    if (values.serial) values.serial = values.serial.toUpperCase();
    if (values.status) values.status = STATUSES.find(s => s.toLowerCase() === values.status.toLowerCase()) || values.status;
    if (!values.assetTag && !values.serial) continue;
    const existing = (values.assetTag && findByCode(values.assetTag)) || (values.serial && findByCode(values.serial));
    if (existing) {
      const next = { ...existing };
      for (const [k, v] of Object.entries(values)) if (v) next[k] = v;
      const changes = describeChanges(existing, next);
      if (changes) { await saveRecord(next, `Imported: ${changes}`); updated++; }
    } else {
      await saveRecord({ id: uid(), createdAt: now(), status: 'In use', ...Object.fromEntries(Object.entries(values).filter(([, v]) => v)), history: [] }, `Added from ${file.name}`);
      added++;
    }
  }
  toast(`Imported: ${added} new, ${updated} updated`, 3500);
}

// ══════════════════════════════════════════════════════════════
//  Wiring
// ══════════════════════════════════════════════════════════════
function wire() {
  document.addEventListener('click', e => {
    const goBtn = e.target.closest('[data-go]');
    if (goBtn) go(goBtn.dataset.go);
    if (e.target.closest('[data-back]')) back();
  });

  // Inventory
  $('#btn-scan').addEventListener('click', () => openScan('code'));
  $('#btn-read-settings').addEventListener('click', () => openScan('text'));
  $('#btn-add').addEventListener('click', () => openIpad(null));
  $('#ipad-list').addEventListener('click', e => {
    const item = e.target.closest('.ipad-item');
    if (item) openIpad(item.dataset.id);
  });
  ['#search', '#filter-area', '#filter-status', '#filter-unseen'].forEach(sel => $(sel).addEventListener('input', renderHome));

  // One iPad
  form().addEventListener('submit', saveForm);
  $('[data-fill-scan]').addEventListener('click', () => openScan('code', 'fill-tag'));
  $('[data-fill-text]').addEventListener('click', () => openScan('text', 'fill-text'));
  $('#btn-seen').addEventListener('click', async () => {
    const rec = ipads.get(editing.id);
    if (!rec) return;
    await markSeen(rec, 'Marked as seen');
    renderIpadExtra();
    toast('Marked as seen');
  });
  $('#btn-delete').addEventListener('click', async () => {
    const rec = ipads.get(editing.id);
    if (!rec || !await confirmBox(`Delete ${rec.assetTag || rec.serial}?`, 'It is removed from the list on every device that shares it.', 'Delete')) return;
    await saveRecord({ ...rec, deleted: true }, 'Deleted');
    editing.snapshot = canonical(formValues()); // nothing to discard
    toast('Deleted');
    back();
  });
  $('#btn-save-qr').addEventListener('click', () => saveCodeImage('QRCode'));
  $('#btn-save-dm').addEventListener('click', () => saveCodeImage('DataMatrix'));
  $('#btn-print-one').addEventListener('click', async () => {
    const rec = ipads.get(editing.id);
    if (rec) printHtml(await labelHtml(rec, labelOpts()));
  });

  // Scanner
  $$('.segmented [data-mode]').forEach(b => b.addEventListener('click', () => setScanMode(b.dataset.mode)));
  $('#manual-form').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('#manual-code').value.trim();
    if (!v) return;
    $('#manual-code').value = '';
    handleFound(v, 'Looked up');
  });
  $('#btn-capture').addEventListener('click', captureScreen);
  $('#shot-input').addEventListener('change', e => { readScreenshot(e.target.files[0]); e.target.value = ''; });
  $('#btn-torch').addEventListener('click', async () => {
    if (!scan.track) return;
    scan.torch = !scan.torch;
    await scan.track.applyConstraints({ advanced: [{ torch: scan.torch }] }).catch(() => {});
  });

  // Settings-screen results
  const ocrForm = $('#ocr-form');
  ocrForm.addEventListener('focusin', e => { if (e.target.matches('input')) ocrTarget = e.target; });
  ocrForm.addEventListener('input', updateOcrMatch);
  $('#ocr-lines').addEventListener('click', e => {
    const b = e.target.closest('[data-text]');
    if (!b || !ocrTarget) return;
    ocrTarget.value = ocrTarget.name === 'serial' ? (AboutParser.cleanSerial(b.dataset.text) || norm(b.dataset.text)) : b.dataset.text;
    updateOcrMatch();
  });
  $('#ocr-retry').addEventListener('click', () => $('#ocr-dialog').close('retry'));
  $('#ocr-dialog').addEventListener('close', () => { if ($('#ocr-dialog').returnValue === 'use') useOcrResults(); });

  // Labels
  const labelPref = (sel, key, prop = 'value') => $(sel).addEventListener('change', e => { prefs.set(key, e.target[prop]); renderLabels(); });
  labelPref('#label-format', 'labelFormat');
  labelPref('#label-size', 'labelSize');
  labelPref('#label-area', 'labelArea');
  labelPref('#label-name', 'labelShowName', 'checked');
  labelPref('#label-area-text', 'labelShowArea', 'checked');
  $('#label-sheet').addEventListener('click', e => {
    const l = e.target.closest('.label');
    if (!l) return;
    if (labelOff.has(l.dataset.id)) labelOff.delete(l.dataset.id); else labelOff.add(l.dataset.id);
    l.classList.toggle('off');
  });
  $('#btn-print').addEventListener('click', () => {
    const html = $$('#label-sheet .label:not(.off)').map(l => l.outerHTML).join('');
    if (!html) { toast('No labels selected'); return; }
    printHtml(html);
  });

  // Settings
  $('#set-user').addEventListener('change', e => prefs.set('user', e.target.value.trim()));
  $('#set-code-content').addEventListener('change', e => prefs.set('codeContent', e.target.value));
  $('#set-prefix').addEventListener('change', e => prefs.set('prefix', e.target.value.trim()));
  $('#set-name-tag').addEventListener('change', e => prefs.set('nameIsTag', e.target.checked));
  $('#gh-save').addEventListener('click', async () => {
    prefs.set('sync', {
      repo: $('#gh-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$|\/$/g, ''),
      path: $('#gh-path').value.trim() || 'ipads.json',
      branch: $('#gh-branch').value.trim() || 'main',
      token: $('#gh-token').value.trim(),
    });
    if (!syncConfigured()) { toast('Enter the repository and a token'); setSyncStatus(); return; }
    await syncNow();
    toast(sync.lastError ? sync.lastError : 'Connected · list shared', 3500);
    renderSettings();
  });
  $('#gh-clear').addEventListener('click', async () => {
    if (!await confirmBox('Stop sharing?', 'The token is removed from this device. The list stays on this device.', 'Stop sharing')) return;
    prefs.set('sync', { ...syncSettings(), token: '' });
    sync.lastError = '';
    renderSettings();
  });
  $('#btn-export-csv').addEventListener('click', exportCsv);
  $('#btn-export-json').addEventListener('click', exportJson);
  $('#import-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) { await importFile(file); renderHome(); }
  });
  $('#btn-refresh').addEventListener('click', refreshApp);

  // Camera off when the app is in the background; back on when it returns to the scanner.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopCamera(); return; }
    if (viewActive('scan')) startCamera();
    if (syncConfigured()) scheduleSync(500);
  });
  window.addEventListener('online', () => scheduleSync(500));
  window.addEventListener('offline', setSyncStatus);
  window.addEventListener('hashchange', openFromHash);
  setInterval(() => { if (!document.hidden && syncConfigured()) syncNow(); }, 5 * 60 * 1000);
}

// A "link" label scanned with the iPad's own Camera app opens #ipad=<tag>.
function openFromHash() {
  const m = /ipad=([^&]+)/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  const rec = findByCode(decodeURIComponent(m[1]));
  if (rec) openIpad(rec.id);
  else toast(`${decodeURIComponent(m[1])} is not in the list on this device`, 4000);
}

// Drop this app's cached files and service worker, then reload from the network.
// The list, settings and token live in IndexedDB and localStorage, which this never touches.
async function refreshApp() {
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('ipad-tracker-') && !k.startsWith('ipad-tracker-vendor')).map(k => caches.delete(k)));
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.unregister();
    await Promise.all(['./', 'index.html', 'app.js', 'parse.js', 'styles.css', 'sw.js', 'manifest.json']
      .map(u => fetch(u, { cache: 'reload' }).catch(() => {})));
  } catch (err) {
    console.warn('Refresh cleanup failed', err);
  }
  location.reload();
}

async function init() {
  wire();
  try {
    for (const r of await store.all()) ipads.set(r.id, r);
    sync.pending = (await store.kvGet('pending')) || {};
  } catch (err) {
    toast(`Storage problem: ${err.message}`, 5000);
  }
  renderHome();
  setSyncStatus();
  openFromHash();
  if (syncConfigured()) syncNow();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker not registered', err));
    navigator.serviceWorker.ready.then(() => setTimeout(warmOcrFiles, 5000));
  }
}

init();
