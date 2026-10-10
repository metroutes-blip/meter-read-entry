'use strict';

const APP_VERSION = '0.2.9';

// Who the Finish & Export email goes to, comma-separated. Blank = the worker fills it in.
const EMAIL_RECIPIENTS = '';

// ══════════════════════════════════════════════════════════════
//  Small helpers
// ══════════════════════════════════════════════════════════════
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const norm = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const prefs = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function isoToSerial(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5;
}
function serialToLabel(serial) {
  if (typeof serial !== 'number' || !isFinite(serial)) return '';
  return XLSX.SSF.format('mmm d, yyyy', serial);
}

let toastTimer;
function toast(msg, ms = 2500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ══════════════════════════════════════════════════════════════
//  IndexedDB — "files" holds original bytes, "routes" holds entries,
//  "kv" holds meter locations (cached + waiting to upload)
// ══════════════════════════════════════════════════════════════
let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('meter-read-entry', 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('routes')) d.createObjectStore('routes', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function dbRun(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const db = {
  get: (store, id) => dbRun(store, 'readonly', s => s.get(id)),
  put: (store, rec) => dbRun(store, 'readwrite', s => s.put(rec)),
  del: (store, id) => dbRun(store, 'readwrite', s => s.delete(id)),
  all: store => dbRun(store, 'readonly', s => s.getAll()),
};
const kv = {
  get: key => dbRun('kv', 'readonly', s => s.get(key)),
  set: (key, value) => dbRun('kv', 'readwrite', s => s.put(value, key)),
};

// ══════════════════════════════════════════════════════════════
//  Workbook parsing
// ══════════════════════════════════════════════════════════════
// Header names are matched case-insensitively with whitespace collapsed.
// Grid columns differ between templates and are intentionally not mapped.
const FIELDS = {
  item: ['item #', 'item#', 'item no', 'item', 'sequence', 'seq #', 'seq'],
  city: ['city'],
  streetNo: ['street #', 'street#', 'street no'],
  street: ['street'],
  misc: ['misc address', 'misc'],
  name: ['name'],
  size: ['mtr sz', 'meter size', 'mtr size'],
  meter: ['meter#', 'meter #', 'meter no'],
  instrument: ['instrument #', 'instrument#', 'instrument no'],
  miniId: ['mini id', 'mini id #'],
  location: ['meter location', 'location'],
  instructions: ['meter reader instructions', 'instructions'],
  station: ['station #', 'station#'],
};

// Order of the six columns in each monthly group.
const SLOTS = ['c', 'u', 'm', 'date', 'by', 'comment'];
const READ_KEYS = ['c', 'u', 'm'];

function isGroupStart(h, c) {
  return h[c]?.startsWith('corrected')
    && h[c + 1]?.startsWith('uncorrected')
    && h[c + 2]?.startsWith('metered')
    && h[c + 3]?.startsWith('date')
    && h[c + 4]?.startsWith('read by')
    && h[c + 5]?.includes('comment');
}

function simplifyCell(cell) {
  if (!cell || cell.v == null || cell.v === '') return null;
  const w = cell.w != null ? String(cell.w).trim() : String(cell.v).trim();
  if (w === '' && typeof cell.v !== 'number') return null;
  return { v: cell.v, w, t: cell.t };
}
function cellNum(cell) {
  if (!cell) return NaN;
  if (typeof cell.v === 'number') return cell.v;
  const s = String(cell.v).replace(/[^\d.]/g, '');
  return s ? parseFloat(s) : NaN;
}
function cellText(cell) { return cell ? cell.w : ''; }

function parseWorkbook(bytes) {
  const wb = XLSX.read(bytes, { type: 'array', cellFormula: false, cellHTML: false, cellStyles: false });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws || !ws['!ref']) throw new Error('The first sheet in this file is empty.');
  const range = XLSX.utils.decode_range(ws['!ref']);
  const at = (r, c) => simplifyCell(ws[XLSX.utils.encode_cell({ r, c })]);

  // Header row = first row (within the top 10) that has a Meter# heading.
  let hr = range.s.r;
  for (let r = range.s.r; r <= Math.min(range.s.r + 10, range.e.r); r++) {
    let found = false;
    for (let c = range.s.c; c <= range.e.c; c++) {
      if (FIELDS.meter.includes(norm(cellText(at(r, c))))) { found = true; break; }
    }
    if (found) { hr = r; break; }
  }

  const headers = [];
  for (let c = 0; c <= range.e.c; c++) headers[c] = norm(cellText(at(hr, c)));

  const groups = [];
  for (let c = 0; c <= range.e.c - 5; c++) {
    if (isGroupStart(headers, c)) {
      groups.push({
        index: groups.length,
        col: c,
        letters: `${XLSX.utils.encode_col(c)}–${XLSX.utils.encode_col(c + 5)}`,
      });
      c += 5;
    }
  }
  if (!groups.length) {
    throw new Error('Could not find the monthly read columns (Corrected read, Uncorrected Read, Metered Read, Date Read, Read By, Meter Reader Comments).');
  }

  // Map info fields only from the columns before the first monthly group.
  const cols = {};
  for (const [key, names] of Object.entries(FIELDS)) {
    for (let c = 0; c < groups[0].col; c++) {
      if (names.includes(headers[c])) { cols[key] = c; break; }
    }
  }
  if (cols.meter == null) throw new Error('Could not find a "Meter#" column.');

  const meters = [];
  for (let r = hr + 1; r <= range.e.r; r++) {
    const info = {};
    for (const [key, c] of Object.entries(cols)) info[key] = cellText(at(r, c));
    if (!info.meter && !info.item) continue;

    const hist = groups.map(g => {
      const cells = {};
      let any = false;
      SLOTS.forEach((slot, k) => {
        const cell = at(r, g.col + k);
        cells[slot] = cell;
        if (cell) any = true;
      });
      return any ? cells : null;
    });
    meters.push({ r, ...info, hist });
  }
  if (!meters.length) throw new Error('No meter rows found under the header row.');

  // Label each group with the latest date found in it (helps confirm the month).
  for (const g of groups) {
    let maxDate = NaN, filled = 0;
    for (const m of meters) {
      const h = m.hist[g.index];
      if (!h) continue;
      filled++;
      const d = cellNum(h.date);
      if (isFinite(d) && !(d <= maxDate)) maxDate = d;
    }
    g.filled = filled;
    g.lastDate = isFinite(maxDate) ? maxDate : null;
  }

  const emptyGroup = groups.find(g => g.filled === 0);

  return {
    sheetName,
    headerRow: hr,
    groups,
    meters,
    suggestedTarget: emptyGroup ? emptyGroup.index : null,
  };
}

// Previous reads / typical usage relative to the chosen target month.
function meterContext(meter, target) {
  const prev = {};
  for (const key of READ_KEYS) {
    for (let gi = target - 1; gi >= 0; gi--) {
      const cell = meter.hist[gi]?.[key];
      if (cell && isFinite(cellNum(cell))) {
        prev[key] = { cell, date: cellNum(meter.hist[gi].date) };
        break;
      }
    }
  }
  const avgUse = {};
  for (const key of READ_KEYS) {
    const vals = [];
    for (let gi = target - 1; gi >= 0 && vals.length < 13; gi--) {
      const n = cellNum(meter.hist[gi]?.[key]);
      if (isFinite(n)) vals.push(n);
    }
    const diffs = [];
    for (let i = 0; i < vals.length - 1; i++) {
      const d = vals[i] - vals[i + 1];
      if (d >= 0) diffs.push(d);
    }
    avgUse[key] = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null;
  }
  const hadMetered = meter.hist.some((h, gi) => gi < target && h?.m);
  return { prev, avgUse, hadMetered };
}

function checkRead(ctx, key, text) {
  const warnings = [];
  if (!text) return warnings;
  if (!/^\d+(\.\d+)?$/.test(text)) return ['Numbers only'];
  const val = parseFloat(text);
  const p = ctx.prev[key];
  if (!p) return warnings;
  const prevNum = cellNum(p.cell);
  if (val < prevNum) {
    warnings.push(`Lower than last read (${p.cell.w})`);
  } else {
    const avg = ctx.avgUse[key];
    const use = val - prevNum;
    if (avg != null && use > avg * 3 && use - avg > 5) {
      warnings.push(`High use: ${Math.round(use)} vs usual ~${Math.round(avg)}`);
    }
  }
  const newDigits = text.split('.')[0].replace(/^0+/, '').length;
  const prevDigits = String(p.cell.w).split('.')[0].replace(/\D/g, '').replace(/^0+/, '').length;
  if (Math.abs(newDigits - prevDigits) >= 2) warnings.push('Digit count differs from last read');
  return warnings;
}

// ══════════════════════════════════════════════════════════════
//  App state
// ══════════════════════════════════════════════════════════════
const state = {
  route: null,    // { id, name, type, entries, target, added, updated }
  bytes: null,    // ArrayBuffer of the original file
  parsed: null,   // result of parseWorkbook
  ctx: new Map(), // row -> meterContext for the current target
  filter: 'all',
  query: '',
  pos: 0,         // index into parsed.meters for the entry screen
  exportFile: null,
};

function entryFor(meter) { return state.route.entries[meter.r]; }
function hasRead(e) { return !!(e && (e.c || e.u || e.m)); }
function meterStatus(meter) {
  const e = entryFor(meter);
  if (hasRead(e)) return 'done';
  if (e?.comment) return 'note';
  return 'todo';
}
function meterWarnings(meter) {
  const e = entryFor(meter);
  if (!e) return [];
  const ctx = state.ctx.get(meter.r);
  return READ_KEYS.flatMap(k => checkRead(ctx, k, e[k] || ''));
}
function addressOf(m) {
  return [m.streetNo, m.street].filter(Boolean).join(' ') + (m.misc ? ` ${m.misc}` : '');
}

function rebuildContext() {
  state.ctx.clear();
  for (const m of state.parsed.meters) state.ctx.set(m.r, meterContext(m, state.route.target));
}

let saveTimer;
function scheduleSave() {
  $('#save-state').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!state.route) return;
  state.route.updated = Date.now();
  try {
    await db.put('routes', state.route);
    $('#save-state').textContent = 'Saved';
  } catch (err) {
    $('#save-state').textContent = 'Not saved!';
    toast('Could not save to this device: ' + err.message, 5000);
  }
}

// ══════════════════════════════════════════════════════════════
//  Views
// ══════════════════════════════════════════════════════════════
function show(view) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  window.scrollTo(0, 0);
  if (view !== 'map') stopWatchingMe();
  if (view !== 'route') stopNearby();
  if (view === 'home') renderHome();
  if (view === 'route') { renderRoute(); startNearby(); }
}

// ── Home ───────────────────────────────────────────────────────
async function renderHome() {
  const routes = (await db.all('routes')).sort((a, b) => b.updated - a.updated);
  const list = $('#saved-routes');
  list.innerHTML = '';
  $('#no-routes').hidden = routes.length > 0;
  for (const r of routes) {
    const done = Object.values(r.entries).filter(hasRead).length;
    const li = document.createElement('li');
    li.className = 'saved-route card';
    li.innerHTML = `
      <div class="saved-route-main">
        <div class="strong">${esc(r.name)}</div>
        <div class="muted small">${done} of ${r.total ?? '?'} read · last edited ${new Date(r.updated).toLocaleString()}</div>
      </div>
      <button class="btn btn-primary" data-open="${esc(r.id)}">Resume</button>
      <button class="btn btn-ghost danger" data-delete="${esc(r.id)}">Delete</button>`;
    list.appendChild(li);
  }
}

async function handleFile(file) {
  if (!file) return;
  const lower = file.name.toLowerCase();
  const type = lower.endsWith('.xlsx') ? 'xlsx' : lower.endsWith('.xls') ? 'xls' : null;
  if (!type) { toast('Please choose an .xlsx or .xls file.'); return; }

  let bytes, parsed;
  try {
    bytes = await file.arrayBuffer();
    parsed = parseWorkbook(bytes);
  } catch (err) {
    alert(`Couldn't read "${file.name}".\n\n${err.message}`);
    return;
  }

  const id = file.name;
  const existing = await db.get('routes', id);
  if (existing) {
    const keep = confirm(`"${file.name}" is already on this tablet with ${Object.values(existing.entries).filter(hasRead).length} reads entered.\n\nOK = keep those reads and continue\nCancel = start over with this file`);
    if (keep) {
      await db.put('files', { id, bytes });
      await openRoute(id);
      return;
    }
  }

  const route = {
    id,
    name: file.name,
    type,
    entries: {},
    target: parsed.suggestedTarget ?? parsed.groups.length - 1,
    total: parsed.meters.length,
    added: Date.now(),
    updated: Date.now(),
  };
  await db.put('files', { id, bytes });
  await db.put('routes', route);
  await openRoute(id);
  if (parsed.suggestedTarget == null) {
    alert('Every month column in this file already has reads. Pick the month column to fill at the top of the list before entering reads.');
  }
}

async function openRoute(id) {
  const [route, file] = await Promise.all([db.get('routes', id), db.get('files', id)]);
  if (!route || !file) { toast('That route is missing from this tablet.'); return; }
  try {
    state.parsed = parseWorkbook(file.bytes);
  } catch (err) {
    alert(err.message);
    return;
  }
  state.route = route;
  state.bytes = file.bytes;
  state.route.total = state.parsed.meters.length;
  state.filter = 'all';
  state.query = '';
  $('#search').value = '';
  $$('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
  rebuildContext();
  if (!prefs.get('initials', '')) askInitials();
  show('route');
}

function askInitials() {
  const v = prompt('Enter your initials for the "Read By" column:', prefs.get('initials', '')) || '';
  const clean = v.trim().toUpperCase().slice(0, 4);
  if (clean) {
    prefs.set('initials', clean);
    $('#initials').value = clean;
  }
  return clean;
}

// ── Route list ─────────────────────────────────────────────────
function renderRoute() {
  const { route, parsed } = state;
  $('#route-name').textContent = route.name;

  const total = parsed.meters.length;
  const done = parsed.meters.filter(m => hasRead(entryFor(m))).length;
  const notes = parsed.meters.filter(m => meterStatus(m) === 'note').length;
  $('#route-progress-text').textContent = `${done} of ${total} read` + (notes ? ` · ${notes} with note only` : '');
  $('#route-progress-bar').style.width = `${(done / total) * 100}%`;

  const notice = $('#route-notice');
  if (route.type === 'xls') {
    notice.hidden = false;
    notice.textContent = 'This is an older .xls file. The completed file will keep your data, but some formatting (colours, borders, column widths) may be lost. Your original file is never changed.';
  } else {
    notice.hidden = true;
  }

  const sel = $('#target-select');
  sel.innerHTML = parsed.groups.map(g => {
    const label = g.filled === 0 ? 'empty' : `${g.filled} reads${g.lastDate ? ', latest ' + serialToLabel(g.lastDate) : ''}`;
    return `<option value="${g.index}">${g.letters} (${label})</option>`;
  }).join('');
  sel.value = String(route.target);

  renderRouteGeo();
  renderMeterList();
}

function filteredMeters() {
  const q = norm(state.query);
  return state.parsed.meters.filter(m => {
    const status = meterStatus(m);
    if (state.filter === 'todo' && status === 'done') return false;
    if (state.filter === 'done' && status !== 'done') return false;
    if (state.filter === 'flag' && !meterWarnings(m).length) return false;
    if (!q) return true;
    return [m.item, m.meter, m.instrument, m.miniId, m.streetNo, m.street, m.misc, m.name, m.city, m.location]
      .some(v => norm(v).includes(q));
  });
}

function renderMeterList() {
  const list = $('#meter-list');
  const meters = filteredMeters();
  list.innerHTML = meters.map(m => {
    const status = meterStatus(m);
    const warns = meterWarnings(m);
    const chip = status === 'done' ? '<span class="chip chip-done">Done</span>'
      : status === 'note' ? '<span class="chip chip-note">Note</span>'
        : '<span class="chip chip-todo">Not read</span>';
    const flag = warns.length ? `<span class="chip chip-warn" title="${esc(warns.join('; '))}">⚠ Check</span>` : '';
    return `
      <li>
        <button class="meter-row" data-row="${m.r}">
          <span class="item-no">${esc(m.item || '–')}</span>
          <span class="meter-row-main">
            <span class="strong">${esc(addressOf(m) || '(no address)')}</span>
            <span class="muted small">Meter ${esc(m.meter)}${m.location ? ' · ' + esc(m.location) : ''}${m.instructions ? ' · ' + esc(m.instructions) : ''}</span>
          </span>
          <span class="meter-row-status">${flag}${chip}</span>
        </button>
      </li>`;
  }).join('') || '<li class="muted empty-list">No meters match.</li>';
}

// ── Meter entry ────────────────────────────────────────────────
const COMMENT_CHIPS = ['No access', 'Locked gate', 'Dog', 'Meter damaged', 'Battery exchange', 'Instrument display off', 'Estimated'];

function openMeter(pos) {
  const meters = state.parsed.meters;
  state.pos = Math.max(0, Math.min(meters.length - 1, pos));
  renderMeter();
  show('meter');
}

function renderMeter() {
  const meters = state.parsed.meters;
  const m = meters[state.pos];
  const ctx = state.ctx.get(m.r);
  const e = entryFor(m) || {};

  $('#meter-pos').textContent = `Item ${m.item || '–'} · ${state.pos + 1} of ${meters.length}`;
  $('#save-state').textContent = '';

  const row = (label, value) => value ? `<div class="info-row"><span class="muted">${label}</span><span>${esc(value)}</span></div>` : '';
  $('#meter-info').innerHTML = `
    <h2 class="meter-address">${esc(addressOf(m) || '(no address)')}</h2>
    ${m.city ? `<div class="muted">${esc(m.city)}</div>` : ''}
    ${m.instructions ? `<div class="instructions"><span class="instructions-label">Instructions</span>${esc(m.instructions)}</div>` : ''}
    <div class="info-grid">
      ${row('Meter #', m.meter)}
      ${row('Instrument #', m.instrument)}
      ${row('Mini ID', m.miniId)}
      ${row('Size', m.size)}
      ${row('Location', m.location)}
      ${row('Name', m.name)}
      ${row('Station', m.station)}
    </div>`;

  for (const key of READ_KEYS) {
    $(`#in-${key}`).value = e[key] || '';
    const p = ctx.prev[key];
    $(`#last-${key}`).textContent = p ? `Last: ${p.cell.w}${p.date ? ' on ' + serialToLabel(p.date) : ''}` : 'No previous read';
  }
  const showMetered = ctx.hadMetered || !!e.m;
  $('#field-m').hidden = !showMetered;
  $('#btn-show-m').hidden = showMetered;

  $('#in-comment').value = e.comment || '';
  $('#in-date').value = e.date || todayISO();
  $('#read-by').textContent = e.by || prefs.get('initials', '') || '—';
  updateWarnings();
  renderMeterLocation();

  $('#btn-prev').disabled = state.pos === 0;
  $('#btn-next').disabled = state.pos === meters.length - 1;
}

function updateWarnings() {
  const m = state.parsed.meters[state.pos];
  const ctx = state.ctx.get(m.r);
  for (const key of READ_KEYS) {
    const warns = checkRead(ctx, key, $(`#in-${key}`).value.trim());
    const el = $(`#warn-${key}`);
    el.textContent = warns.length ? '⚠ ' + warns.join(' · ') : '';
    $(`#in-${key}`).classList.toggle('has-warn', warns.length > 0);
  }
}

function captureForm() {
  const m = state.parsed.meters[state.pos];
  const prev = entryFor(m) || {};
  const next = {
    c: $('#in-c').value.trim(),
    u: $('#in-u').value.trim(),
    m: $('#in-m').value.trim(),
    comment: $('#in-comment').value.trim(),
  };
  const empty = !next.c && !next.u && !next.m && !next.comment;
  if (empty) {
    delete state.route.entries[m.r];
  } else {
    next.date = $('#in-date').value || prev.date || todayISO();
    next.by = prev.by || prefs.get('initials', '') || askInitials();
    next.t = Date.now();
    state.route.entries[m.r] = next;
    $('#read-by').textContent = next.by || '—';
    if (hasRead(next) && !hasRead(prev)) autoCaptureLocation(m);
  }
  scheduleSave();
}

function nextUnread() {
  const meters = state.parsed.meters;
  for (let i = 1; i <= meters.length; i++) {
    const idx = (state.pos + i) % meters.length;
    if (meterStatus(meters[idx]) === 'todo') return idx;
  }
  return -1;
}

// ══════════════════════════════════════════════════════════════
//  Meter locations — captured on the tablet, shared through a JSON
//  file in a private GitHub repo: { version, updated, meters: { "<Meter#>": {lat,lng,acc,by,at} } }
// ══════════════════════════════════════════════════════════════
const geo = {
  cache: { sha: null, meters: {}, fetchedAt: 0 }, // last copy of the GitHub file
  pending: {},          // captured here, not uploaded yet
  syncing: false,
  lastError: '',
  lastSync: 0,
  autoTried: new Set(), // meters already auto-captured this session
};
let geoSyncTimer;

const geoSettings = () => ({ repo: 'metroutes-blip/meter-geocodes', path: 'geocodes.json', branch: 'main', ...prefs.get('geoSettings', {}) });
const geoToken = () => prefs.get('geoToken', '');
const geoConfigured = () => !!(geoSettings().repo && geoToken());
const meterKey = m => String(m.meter || '').trim();
const locationFor = m => {
  const key = meterKey(m);
  return key ? geo.pending[key] || geo.cache.meters[key] || null : null;
};

async function loadGeoLocal() {
  try {
    geo.cache = (await kv.get('geoCache')) || geo.cache;
    geo.pending = (await kv.get('geoPending')) || {};
  } catch (err) {
    console.warn('Could not load saved locations', err);
  }
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('Location is not available on this device')); return; }
    navigator.geolocation.getCurrentPosition(resolve, err => {
      reject(new Error(err.code === 1 ? 'Location permission is turned off for this app' : 'Could not get a GPS fix'));
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 });
  });
}

async function recordLocation(meter, pos) {
  const key = meterKey(meter);
  if (!key) throw new Error('This meter has no meter number');
  const entry = {
    lat: +pos.coords.latitude.toFixed(6),
    lng: +pos.coords.longitude.toFixed(6),
    acc: Math.round(pos.coords.accuracy),
    by: prefs.get('initials', ''),
    at: new Date().toISOString(),
  };
  geo.pending[key] = entry;
  await kv.set('geoPending', geo.pending);
  scheduleGeoSync();
  refreshGeoViews();
  return entry;
}

// Called when a meter gets its first read: grab a position if we don't have one.
function autoCaptureLocation(meter) {
  const key = meterKey(meter);
  if (!key || locationFor(meter) || geo.autoTried.has(key)) return;
  geo.autoTried.add(key);
  getPosition()
    .then(pos => recordLocation(meter, pos))
    .catch(err => toast(`Location not saved: ${err.message}`, 4000));
}

async function saveLocationHere() {
  const meter = state.parsed.meters[state.pos];
  const btn = $('#btn-save-loc');
  btn.disabled = true;
  btn.textContent = 'Getting GPS…';
  try {
    const entry = await recordLocation(meter, await getPosition());
    toast(`Location saved (±${entry.acc} m)`);
  } catch (err) {
    toast(err.message, 4000);
  } finally {
    btn.disabled = false;
    btn.textContent = '📍 Save my location here';
  }
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
      Authorization: `Bearer ${geoToken()}`,
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

async function fetchRemoteGeo() {
  const s = geoSettings();
  const res = await ghFetch(`${ghFileUrl(s)}?ref=${encodeURIComponent(s.branch)}`);
  if (res.status === 404) {
    // Either the file doesn't exist yet (fine) or the repo is unreachable (not fine).
    const repo = await ghFetch(ghRepoUrl(s));
    if (!repo.ok) throw new Error(ghError(repo.status));
    return { sha: null, meters: {} };
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
  return { sha: meta.sha, meters: data.meters || {} };
}

// One meter per line so changes are easy to read in GitHub's history.
function geoFileText(meters) {
  const lines = Object.keys(meters).sort().map(k => `    ${JSON.stringify(k)}: ${JSON.stringify(meters[k])}`);
  return `{\n  "version": 1,\n  "updated": ${JSON.stringify(new Date().toISOString())},\n  "meters": {\n${lines.join(',\n')}\n  }\n}\n`;
}

function scheduleGeoSync() {
  clearTimeout(geoSyncTimer);
  geoSyncTimer = setTimeout(syncGeo, 4000);
}

// Pull the shared file, merge in anything captured here (newest wins), push it back.
async function syncGeo() {
  clearTimeout(geoSyncTimer);
  if (!geoConfigured() || geo.syncing || !navigator.onLine) { setGeoStatus(); return; }
  geo.syncing = true;
  setGeoStatus();
  try {
    const s = geoSettings();
    for (let attempt = 1; ; attempt++) {
      const remote = await fetchRemoteGeo();
      const snapshot = { ...geo.pending };
      const keys = Object.keys(snapshot);
      const merged = { ...remote.meters };
      for (const k of keys) {
        if (!merged[k] || !(merged[k].at > snapshot[k].at)) merged[k] = snapshot[k];
      }
      if (!keys.length) {
        geo.cache = { sha: remote.sha, meters: merged, fetchedAt: Date.now() };
        break;
      }
      const body = {
        message: `Meter locations: ${keys.length} updated${prefs.get('initials', '') ? ' by ' + prefs.get('initials', '') : ''}`,
        content: textToB64(geoFileText(merged)),
        branch: s.branch,
      };
      if (remote.sha) body.sha = remote.sha;
      const res = await ghFetch(ghFileUrl(s), { method: 'PUT', body: JSON.stringify(body) });
      if ((res.status === 409 || res.status === 422) && attempt < 4) continue; // someone else saved first
      if (!res.ok) throw new Error(ghError(res.status));
      const out = await res.json();
      geo.cache = { sha: out.content.sha, meters: merged, fetchedAt: Date.now() };
      // Keep anything re-captured while the upload was in flight.
      for (const k of keys) if (geo.pending[k] === snapshot[k]) delete geo.pending[k];
      await kv.set('geoPending', geo.pending);
      break;
    }
    await kv.set('geoCache', geo.cache);
    geo.lastError = '';
    geo.lastSync = Date.now();
  } catch (err) {
    geo.lastError = err.message === 'Failed to fetch' ? 'No connection to GitHub' : err.message;
  } finally {
    geo.syncing = false;
    setGeoStatus();
    refreshGeoViews();
  }
}

function geoStatusText() {
  const n = Object.keys(geo.pending).length;
  const waiting = n ? `${n} location${n === 1 ? '' : 's'} waiting to upload` : '';
  if (!geoConfigured()) return n ? `${waiting} (location sync not set up)` : 'Location sync not set up';
  if (geo.syncing) return 'Syncing locations…';
  if (geo.lastError) return `Sync problem: ${geo.lastError}${n ? ` · ${waiting}` : ''}`;
  if (n) return navigator.onLine ? waiting : `Offline · ${waiting}`;
  if (geo.lastSync) return `Locations synced ${new Date(geo.lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return 'Locations saved on this tablet';
}
function setGeoStatus() {
  const text = geoStatusText();
  $$('.geo-status').forEach(el => {
    el.textContent = text;
    el.classList.toggle('geo-error', !!geo.lastError);
  });
}

function refreshGeoViews() {
  if (!state.parsed) return;
  if ($('#view-route').classList.contains('active')) renderRouteGeo();
  if ($('#view-meter').classList.contains('active')) renderMeterLocation();
  if ($('#view-map').classList.contains('active')) drawMapMeters(false);
}

function renderRouteGeo() {
  const located = state.parsed.meters.filter(locationFor).length;
  $('#route-located').textContent = `📍 ${located} of ${state.parsed.meters.length} meters located`;
  setGeoStatus();
}

const isApple = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function directionsUrl(meter) {
  const loc = locationFor(meter);
  const dest = loc ? `${loc.lat},${loc.lng}` : [meter.streetNo, meter.street, meter.city].filter(Boolean).join(' ');
  return isApple()
    ? `https://maps.apple.com/?daddr=${encodeURIComponent(dest)}`
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
}

function renderMeterLocation() {
  const meter = state.parsed.meters[state.pos];
  const loc = locationFor(meter);
  const pending = loc && geo.pending[meterKey(meter)] === loc;
  const when = loc ? new Date(loc.at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  $('#loc-status').innerHTML = loc
    ? `📍 Location saved <strong>±${esc(loc.acc)} m</strong> · ${esc(when)}${loc.by ? ' · ' + esc(loc.by) : ''}${pending ? ' · <span class="muted">not uploaded yet</span>' : ''}`
    : '📍 No location yet. It will be saved when you enter a read, or tap the button at the meter.';
  $('#loc-status').classList.toggle('loc-weak', !!loc && loc.acc > 50);
  $('#btn-directions').href = directionsUrl(meter);
  $('#btn-directions').textContent = loc ? 'Directions' : 'Directions (by address)';
}

// ── Map ────────────────────────────────────────────────────────
const mapState = { map: null, meters: null, me: null, tiles: null, watchId: null, myPos: null, fitted: false };

// OpenStreetMap's own tile servers block apps, and CARTO now needs an API key,
// so both styles come from Esri's public basemaps. Layers are stacked in order.
const esriTiles = name => `https://server.arcgisonline.com/ArcGIS/rest/services/${name}/MapServer/tile/{z}/{y}/{x}`;
const TILES = {
  street: {
    layers: [esriTiles('World_Street_Map')],
    attribution: '© <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, © OpenStreetMap contributors',
  },
  // Aerial photo with road lines and street names drawn on top.
  satellite: {
    layers: [esriTiles('World_Imagery'), esriTiles('Reference/World_Transportation'), esriTiles('Reference/World_Boundaries_and_Places')],
    attribution: '© <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics, HERE, Garmin',
  },
};

function setMapStyle(style) {
  const cfg = TILES[style] || TILES.street;
  prefs.set('mapStyle', style);
  if (mapState.tiles) mapState.map.removeLayer(mapState.tiles);
  mapState.tiles = L.layerGroup(cfg.layers.map((url, i) => L.tileLayer(url, {
    maxZoom: 19,
    attribution: i === 0 ? cfg.attribution : '',
  }))).addTo(mapState.map);
  $('#btn-map-style').textContent = style === 'satellite' ? 'Street' : 'Satellite';
}

function openMap() {
  show('map');
  if (!window.L) { $('#map').textContent = 'The map could not be loaded.'; return; }
  if (!mapState.map) {
    mapState.map = L.map('map', { zoomControl: true, maxZoom: 19 }).setView([43.7, -79.6], 10);
    setMapStyle(prefs.get('mapStyle', 'street'));
    mapState.meters = L.layerGroup().addTo(mapState.map);
    mapState.me = L.layerGroup().addTo(mapState.map);
    // Leaflet stops clicks inside popups from bubbling, so wire the button per popup.
    mapState.map.on('popupopen', e => {
      const btn = e.popup.getElement()?.querySelector('[data-open-meter]');
      if (btn) btn.addEventListener('click', () => openMeter(state.parsed.meters.findIndex(m => m.r === +btn.dataset.openMeter)));
    });
  }
  mapState.fitted = false;
  setTimeout(() => {
    mapState.map.invalidateSize();
    drawMapMeters(true);
  }, 0);
  startWatchingMe();
}

function drawMapMeters(fit) {
  if (!mapState.map) return;
  mapState.meters.clearLayers();
  const points = [];
  for (const m of state.parsed.meters) {
    const loc = locationFor(m);
    if (!loc) continue;
    const status = meterWarnings(m).length ? 'warn' : meterStatus(m);
    const icon = L.divIcon({
      className: '',
      html: `<div class="pin pin-${status}">${esc(m.item || '•')}</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
    const label = status === 'done' ? 'Read' : status === 'note' ? 'Note only' : status === 'warn' ? 'Check read' : 'Not read';
    L.marker([loc.lat, loc.lng], { icon })
      .bindPopup(`
        <div class="pop">
          <strong>Item ${esc(m.item)} · ${esc(addressOf(m))}</strong><br>
          Meter ${esc(m.meter)} · ${label}<br>
          ${m.instructions ? `<em>${esc(m.instructions)}</em><br>` : ''}
          <button type="button" class="btn btn-primary small" data-open-meter="${m.r}">Open meter</button>
        </div>`)
      .addTo(mapState.meters);
    points.push([loc.lat, loc.lng]);
  }
  $('#map-summary').textContent = `${points.length} of ${state.parsed.meters.length} meters located`;
  if (fit && points.length) {
    mapState.map.fitBounds(points, { padding: [40, 40], maxZoom: 18 });
    mapState.fitted = true;
  }
}

function startWatchingMe() {
  if (!navigator.geolocation || mapState.watchId != null) return;
  mapState.watchId = navigator.geolocation.watchPosition(pos => {
    const ll = [pos.coords.latitude, pos.coords.longitude];
    mapState.myPos = ll;
    mapState.me.clearLayers();
    L.circle(ll, { radius: pos.coords.accuracy, color: '#2b7de9', weight: 1, fillOpacity: 0.12 }).addTo(mapState.me);
    L.circleMarker(ll, { radius: 8, color: '#ffffff', weight: 3, fillColor: '#2b7de9', fillOpacity: 1 }).addTo(mapState.me);
    if (!mapState.fitted) { mapState.map.setView(ll, 16); mapState.fitted = true; }
  }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
}
function stopWatchingMe() {
  if (mapState.watchId != null) navigator.geolocation.clearWatch(mapState.watchId);
  mapState.watchId = null;
}

// ══════════════════════════════════════════════════════════════
//  Nearby meters — while the route list is on screen, check GPS every
//  30 s, list the closest unread meters, and open one automatically when
//  it is clearly the meter you're standing at.
// ══════════════════════════════════════════════════════════════
const NEARBY_EVERY_MS = 30000;
const NEARBY_LIST_M = 100;     // list unread meters within this distance
const NEARBY_MAX_ACC_M = 50;   // ignore GPS fixes rougher than this
const AUTO_OPEN_M = 15;        // auto-open an unread meter this close…
const AUTO_OPEN_CLEAR_M = 30;  // …when no other unread meter is within this distance
const AUTO_OPEN_ACC_M = 20;    // …and both fixes are at least this good
const nearby = { timer: null, busy: false, opened: new Set() };

function distanceM(a, b) {
  const rad = Math.PI / 180, R = 6371000;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const routeListShowing = () => $('#view-route').classList.contains('active') && !document.hidden;

function startNearby() {
  if (nearby.timer || !navigator.geolocation) return;
  checkNearby();
  nearby.timer = setInterval(checkNearby, NEARBY_EVERY_MS);
}
function stopNearby() {
  clearInterval(nearby.timer);
  nearby.timer = null;
}

async function checkNearby() {
  if (nearby.busy || !routeListShowing() || !state.parsed) return;
  // No meter on this route has a location yet: nothing to compare against, so leave GPS off.
  if (!state.parsed.meters.some(locationFor)) { renderNearby(null, []); return; }
  nearby.busy = true;
  try {
    const pos = await getPosition();
    if (!routeListShowing()) return; // left the list while waiting for GPS
    const me = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
    const unread = state.parsed.meters
      .map((m, i) => ({ m, i, loc: locationFor(m) }))
      .filter(x => x.loc && meterStatus(x.m) === 'todo')
      .map(x => ({ ...x, d: distanceM(me, x.loc) }))
      .sort((a, b) => a.d - b.d);
    renderNearby(me, unread);
    maybeAutoOpen(me, unread);
  } catch {
    renderNearby(null, []);
  } finally {
    nearby.busy = false;
  }
}

function renderNearby(me, unread) {
  const box = $('#route-nearby');
  if (!me || me.acc > NEARBY_MAX_ACC_M) { box.hidden = true; return; }
  const close = unread.filter(x => x.d <= NEARBY_LIST_M).slice(0, 3);
  box.hidden = false;
  box.innerHTML = close.length
    ? '<span class="strong">📍 Nearby:</span>' + close.map(x =>
      `<button type="button" class="nearby-btn" data-pos="${x.i}">${esc(addressOf(x.m) || '(no address)')} · Meter ${esc(x.m.meter)} · ${Math.round(x.d)} m</button>`).join('')
    : `<span class="muted">📍 No unread meters within ${NEARBY_LIST_M} m (GPS ±${Math.round(me.acc)} m)</span>`;
}

function maybeAutoOpen(me, unread) {
  if (!prefs.get('autoOpenNearest', true) || me.acc > AUTO_OPEN_ACC_M) return;
  // Don't pull the list out from under someone who is searching or has a dialog open.
  if (document.activeElement === $('#search') || document.querySelector('dialog[open]')) return;
  const [first, second] = unread;
  if (!first || first.d > AUTO_OPEN_M || (first.loc.acc ?? 0) > AUTO_OPEN_ACC_M) return;
  if (second && second.d <= AUTO_OPEN_CLEAR_M) return; // two candidates: let the worker pick from the strip
  const key = `${state.route.id}:${first.m.r}`;
  if (nearby.opened.has(key)) return; // only once per meter, so "‹ Routes" doesn't bounce straight back
  nearby.opened.add(key);
  openMeter(first.i);
  toast(`Opened the nearest meter (${Math.round(first.d)} m away)`, 3500);
}

// ══════════════════════════════════════════════════════════════
//  Export
// ══════════════════════════════════════════════════════════════
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIME_XLS = 'application/vnd.ms-excel';

// The six values to write for one meter: { kind: 'read'|'date'|'text', value } or null.
function valuesToWrite(entry) {
  const initials = entry.by || prefs.get('initials', '');
  const anything = hasRead(entry) || entry.comment;
  return [
    entry.c ? { kind: 'read', value: entry.c } : null,
    entry.u ? { kind: 'read', value: entry.u } : null,
    entry.m ? { kind: 'read', value: entry.m } : null,
    anything ? { kind: 'date', value: isoToSerial(entry.date || todayISO()) } : null,
    anything && initials ? { kind: 'text', value: initials } : null,
    entry.comment ? { kind: 'text', value: entry.comment } : null,
  ];
}

function completedName(name) {
  const dot = name.lastIndexOf('.');
  const base = name.slice(0, dot), ext = name.slice(dot);
  return (/input/i.test(base) ? base.replace(/input/i, 'completed') : `${base} completed`) + ext;
}

async function firstSheetPath(zip) {
  const parser = new DOMParser();
  const wbDoc = parser.parseFromString(await zip.file('xl/workbook.xml').async('string'), 'application/xml');
  const sheet = wbDoc.getElementsByTagName('sheet')[0];
  const rid = sheet.getAttributeNS(REL_NS, 'id') || sheet.getAttribute('r:id');
  const relDoc = parser.parseFromString(await zip.file('xl/_rels/workbook.xml.rels').async('string'), 'application/xml');
  const rel = Array.from(relDoc.getElementsByTagName('Relationship')).find(x => x.getAttribute('Id') === rid);
  const target = rel.getAttribute('Target');
  return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
}

// .xlsx: edit only the target cells inside the sheet XML; every other part of
// the package (external links, formulas, styles, calcChain) is left untouched.
async function exportXlsx() {
  const { parsed, route } = state;
  const zip = await JSZip.loadAsync(state.bytes);
  const sheetPath = await firstSheetPath(zip);
  const xml = await zip.file(sheetPath).async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Could not read the sheet inside this file.');

  const NS = doc.documentElement.namespaceURI;
  const sheetData = doc.getElementsByTagNameNS(NS, 'sheetData')[0];
  const rows = new Map();
  for (const row of sheetData.getElementsByTagNameNS(NS, 'row')) rows.set(+row.getAttribute('r'), row);

  const target = parsed.groups[route.target];
  const prevGroup = parsed.groups[route.target - 1];
  const colOf = ref => XLSX.utils.decode_cell(ref).c;

  const getRow = rowNum => {
    let row = rows.get(rowNum);
    if (row) return row;
    row = doc.createElementNS(NS, 'row');
    row.setAttribute('r', rowNum);
    const after = Array.from(rows.keys()).sort((a, b) => a - b).find(n => n > rowNum);
    sheetData.insertBefore(row, after ? rows.get(after) : null);
    rows.set(rowNum, row);
    return row;
  };
  const findCell = (row, col) => {
    for (const c of row.getElementsByTagNameNS(NS, 'c')) if (colOf(c.getAttribute('r')) === col) return c;
    return null;
  };
  const getCell = (row, r, col) => {
    const existing = findCell(row, col);
    if (existing) return existing;
    const cell = doc.createElementNS(NS, 'c');
    cell.setAttribute('r', XLSX.utils.encode_cell({ r, c: col }));
    const after = Array.from(row.getElementsByTagNameNS(NS, 'c')).find(c => colOf(c.getAttribute('r')) > col);
    row.insertBefore(cell, after || null);
    return cell;
  };
  const isStringCell = c => c && ['s', 'str', 'inlineStr'].includes(c.getAttribute('t'));

  let written = 0;
  for (const m of parsed.meters) {
    const entry = route.entries[m.r];
    if (!entry) continue;
    const vals = valuesToWrite(entry);
    const row = getRow(m.r + 1);
    vals.forEach((val, k) => {
      if (!val) return;
      const col = target.col + k;
      const model = prevGroup ? findCell(row, prevGroup.col + k) : null;
      const cell = getCell(row, m.r, col);
      if (!cell.getAttribute('s') && model?.getAttribute('s')) cell.setAttribute('s', model.getAttribute('s'));
      while (cell.firstChild) cell.removeChild(cell.firstChild);
      cell.removeAttribute('t');

      const asText = val.kind === 'text'
        || (val.kind === 'read' && (isStringCell(model) || /^0\d/.test(val.value)));
      if (asText) {
        cell.setAttribute('t', 'inlineStr');
        const is = doc.createElementNS(NS, 'is');
        const t = doc.createElementNS(NS, 't');
        t.setAttributeNS(XML_NS, 'xml:space', 'preserve');
        t.textContent = String(val.value);
        is.appendChild(t);
        cell.appendChild(is);
      } else {
        const v = doc.createElementNS(NS, 'v');
        v.textContent = String(val.kind === 'read' ? parseFloat(val.value) : val.value);
        cell.appendChild(v);
      }
    });
    written++;
  }

  let out = new XMLSerializer().serializeToString(doc);
  if (!out.startsWith('<?xml')) out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + out;
  zip.file(sheetPath, out, { createFolders: false });
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: MIME_XLSX });
  return { blob, written };
}

// .xls: legacy binary can't be patched in place, so rewrite it with SheetJS.
function exportXls() {
  const { parsed, route } = state;
  const wb = XLSX.read(state.bytes, { type: 'array', cellStyles: true, cellFormula: true, cellNF: true, cellDates: false });
  const ws = wb.Sheets[parsed.sheetName];
  const target = parsed.groups[route.target];
  const prevGroup = parsed.groups[route.target - 1];
  const range = XLSX.utils.decode_range(ws['!ref']);

  let written = 0;
  for (const m of parsed.meters) {
    const entry = route.entries[m.r];
    if (!entry) continue;
    valuesToWrite(entry).forEach((val, k) => {
      if (!val) return;
      const col = target.col + k;
      const addr = XLSX.utils.encode_cell({ r: m.r, c: col });
      const model = prevGroup ? ws[XLSX.utils.encode_cell({ r: m.r, c: prevGroup.col + k })] : null;
      const asText = val.kind === 'text'
        || (val.kind === 'read' && (model?.t === 's' || /^0\d/.test(val.value)));
      const cell = asText
        ? { t: 's', v: String(val.value) }
        : { t: 'n', v: val.kind === 'read' ? parseFloat(val.value) : val.value };
      if (val.kind === 'date') cell.z = (model?.z && model.z !== 'General') ? model.z : 'm/d/yyyy';
      if (model?.s) cell.s = model.s;
      ws[addr] = cell;
      range.e.c = Math.max(range.e.c, col);
      range.e.r = Math.max(range.e.r, m.r);
    });
    written++;
  }
  ws['!ref'] = XLSX.utils.encode_range(range);
  const out = XLSX.write(wb, { bookType: 'xls', type: 'array', cellStyles: true });
  return { blob: new Blob([out], { type: MIME_XLS }), written };
}

function openExport() {
  const { parsed } = state;
  const meters = parsed.meters;
  const done = meters.filter(m => meterStatus(m) === 'done');
  const notes = meters.filter(m => meterStatus(m) === 'note');
  const todo = meters.filter(m => meterStatus(m) === 'todo');
  const flagged = meters.filter(m => meterWarnings(m).length);
  const target = parsed.groups[state.route.target];
  state.exportCounts = { done: done.length, notes: notes.length, todo: todo.length, flagged: flagged.length, columns: target.letters };

  $('#export-summary').innerHTML = `
    <div class="summary-grid">
      <div><span class="big-num">${done.length}</span><span class="muted">read</span></div>
      <div><span class="big-num">${notes.length}</span><span class="muted">note only</span></div>
      <div><span class="big-num">${todo.length}</span><span class="muted">not read</span></div>
      <div><span class="big-num">${flagged.length}</span><span class="muted">to check</span></div>
    </div>
    <p class="muted small">Reads go into columns ${target.letters}. Output file: <strong>${esc(completedName(state.route.name))}</strong></p>`;

  const issueList = (title, list) => list.length ? `
    <h3>${title}</h3>
    <ul class="issue-list">${list.map(m => `<li><button type="button" class="link-btn" data-jump="${m.r}">Item ${esc(m.item)} · ${esc(addressOf(m))} · Meter ${esc(m.meter)}</button></li>`).join('')}</ul>` : '';
  $('#export-issues').innerHTML = issueList('To check', flagged) + issueList('Not read yet', todo);

  state.exportFile = null;
  $('#export-status').textContent = '';
  $('#btn-build').hidden = false;
  $('#export-send').hidden = true;
  $('#btn-download').hidden = true;
  $('#export-dialog').showModal();
}

async function buildExport() {
  const status = $('#export-status');
  const btn = $('#btn-build');
  btn.disabled = true;
  status.textContent = 'Creating file…';
  try {
    await saveNow();
    const { blob, written } = state.route.type === 'xls' ? exportXls() : await exportXlsx();
    const name = completedName(state.route.name);
    state.exportFile = new File([blob], name, { type: blob.type });
    status.textContent = `Ready: ${name} (${written} meters written).`;
    btn.hidden = true;
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [state.exportFile] }));
    $('#btn-share').hidden = !canShare;
    $('#email-pick').textContent = canShare ? 'Or open a new email in:' : 'Open a new email in:';
    $('#export-send').hidden = false;
    $('#btn-download').hidden = false;
  } catch (err) {
    console.error(err);
    status.textContent = 'Could not create the file: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

function emailSubject() {
  const base = state.exportFile.name.replace(/\.[^.]+$/, '');
  return `Meter Reads — ${base} — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function emailBody(attached) {
  const c = state.exportCounts;
  const initials = prefs.get('initials', '');
  return [
    `Completed route: ${state.exportFile.name}`,
    `Read: ${c.done} · Note only: ${c.notes} · Not read: ${c.todo} · To check: ${c.flagged}`,
    `Columns filled: ${c.columns}`,
    ...(initials ? [`Read by: ${initials}`] : []),
    '',
    attached ? 'The completed spreadsheet is attached.' : '(Attach the completed spreadsheet from your Downloads.)',
  ].join('\n');
}

async function shareExport() {
  // share() needs a fresh tap, which is why the file is built first.
  // On iPad, picking Mail or Outlook opens a new email with the file already attached.
  try {
    await navigator.share({ files: [state.exportFile], title: emailSubject(), text: emailBody(true) });
  } catch (err) {
    if (err.name !== 'AbortError') toast('Sharing failed — use one of the email buttons instead.');
  }
}

// Web mail can't take an attachment from a link, so download the file first, then open a compose window.
function emailExport(provider) {
  downloadExport();
  const to = encodeURIComponent(EMAIL_RECIPIENTS);
  const su = encodeURIComponent(emailSubject());
  const body = encodeURIComponent(emailBody(false));
  const urls = {
    gmail: `https://mail.google.com/mail/?view=cm&to=${to}&su=${su}&body=${body}`,
    outlook: `https://outlook.live.com/mail/deeplink/compose?to=${to}&subject=${su}&body=${body}`,
    yahoo: `https://compose.mail.yahoo.com/?to=${to}&subject=${su}&body=${body}`,
  };
  setTimeout(() => {
    if (urls[provider]) window.open(urls[provider], '_blank');
    else location.href = `mailto:${to}?subject=${su}&body=${body}`;
  }, 400);
}

function downloadExport() {
  const url = URL.createObjectURL(state.exportFile);
  const a = document.createElement('a');
  a.href = url;
  a.download = state.exportFile.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function testGeoConnection() {
  prefs.set('geoSettings', {
    repo: $('#gh-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$|\/$/g, ''),
    path: $('#gh-path').value.trim() || 'geocodes.json',
    branch: $('#gh-branch').value.trim() || 'main',
  });
  prefs.set('geoToken', $('#gh-token').value.trim());
  $('#gh-repo').value = geoSettings().repo;
  const out = $('#gh-result');
  if (!geoConfigured()) { out.textContent = 'Enter the repository and access token.'; return; }
  out.textContent = 'Checking…';
  try {
    const s = geoSettings();
    const res = await ghFetch(ghRepoUrl(s));
    if (!res.ok) throw new Error(ghError(res.status));
    const info = await res.json();
    const remote = await fetchRemoteGeo();
    const notes = [];
    if (!info.private) notes.push('⚠ This repository is PUBLIC — anyone can see the meter locations. Make it private.');
    if (info.permissions && !info.permissions.push) notes.push('⚠ This token can read but not save.');
    if (!remote.sha) notes.push(`${s.path} will be created on the first upload.`);
    out.textContent = `Connected to ${info.full_name} · ${Object.keys(remote.meters).length} locations on GitHub. ${notes.join(' ')}`;
    geo.lastError = '';
    await syncGeo();
  } catch (err) {
    out.textContent = err.message === 'Failed to fetch' ? 'No connection to GitHub.' : err.message;
  }
}

// ══════════════════════════════════════════════════════════════
//  Wiring
// ══════════════════════════════════════════════════════════════
function init() {
  $$('.app-version').forEach(el => { el.textContent = `Version ${APP_VERSION}`; });

  // The pinned search bar sits just under the route list's top bar, whatever its height.
  const routeBar = $('#view-route .topbar');
  new ResizeObserver(() => {
    if (routeBar.offsetHeight) $('#view-route').style.setProperty('--topbar-h', `${routeBar.offsetHeight}px`);
  }).observe(routeBar);

  const initials = $('#initials');
  initials.value = prefs.get('initials', '');
  initials.addEventListener('input', () => {
    initials.value = initials.value.toUpperCase();
    prefs.set('initials', initials.value.trim());
  });

  $('#file-input').addEventListener('change', e => {
    handleFile(e.target.files[0]);
    e.target.value = '';
  });

  $('#saved-routes').addEventListener('click', async e => {
    const open = e.target.closest('[data-open]');
    const del = e.target.closest('[data-delete]');
    if (open) openRoute(open.dataset.open);
    if (del && confirm(`Delete "${del.dataset.delete}" and all reads entered for it from this tablet?`)) {
      await db.del('routes', del.dataset.delete);
      await db.del('files', del.dataset.delete);
      renderHome();
    }
  });

  $$('[data-go]').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.go === 'home') await saveNow();
    show(b.dataset.go);
  }));

  // Route list
  $$('.seg-btn').forEach(b => b.addEventListener('click', () => {
    state.filter = b.dataset.filter;
    $$('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
    renderMeterList();
  }));
  $('#search').addEventListener('input', e => { state.query = e.target.value; renderMeterList(); });
  $('#meter-list').addEventListener('click', e => {
    const row = e.target.closest('[data-row]');
    if (!row) return;
    openMeter(state.parsed.meters.findIndex(m => m.r === +row.dataset.row));
  });
  $('#target-select').addEventListener('change', e => {
    const next = +e.target.value;
    const g = state.parsed.groups[next];
    if (g.filled > 0 && !confirm(`Columns ${g.letters} already have ${g.filled} reads. Reads you enter will overwrite those cells. Use this column anyway?`)) {
      e.target.value = String(state.route.target);
      return;
    }
    state.route.target = next;
    rebuildContext();
    scheduleSave();
    renderRoute();
  });
  $('#btn-export').addEventListener('click', openExport);

  // Meter entry
  for (const key of READ_KEYS) {
    const input = $(`#in-${key}`);
    input.addEventListener('input', () => { updateWarnings(); captureForm(); });
  }
  $('#in-comment').addEventListener('input', captureForm);
  $('#in-date').addEventListener('change', captureForm);
  $('#btn-show-m').addEventListener('click', () => {
    $('#field-m').hidden = false;
    $('#btn-show-m').hidden = true;
    $('#in-m').focus();
  });
  $('#comment-chips').innerHTML = COMMENT_CHIPS.map(c => `<button type="button" class="chip-btn">${esc(c)}</button>`).join('');
  $('#comment-chips').addEventListener('click', e => {
    const chip = e.target.closest('.chip-btn');
    if (!chip) return;
    const ta = $('#in-comment');
    ta.value = ta.value ? `${ta.value.replace(/[\s.;]*$/, '')}; ${chip.textContent}` : chip.textContent;
    captureForm();
  });
  $('#btn-clear').addEventListener('click', () => {
    if (!confirm('Clear everything entered for this meter?')) return;
    ['#in-c', '#in-u', '#in-m', '#in-comment'].forEach(s => { $(s).value = ''; });
    captureForm();
    renderMeter();
  });
  $('#btn-prev').addEventListener('click', () => { saveNow(); openMeter(state.pos - 1); });
  $('#btn-next').addEventListener('click', () => { saveNow(); openMeter(state.pos + 1); });
  $('#btn-next-todo').addEventListener('click', () => {
    saveNow();
    const idx = nextUnread();
    if (idx < 0) { toast('All meters have reads or notes.'); return; }
    openMeter(idx);
  });

  // Swipe left/right on the info card to move between meters.
  let touchStart = null;
  const info = $('#meter-info');
  info.addEventListener('touchstart', e => { touchStart = e.touches[0]; }, { passive: true });
  info.addEventListener('touchend', e => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.clientX, dy = t.clientY - touchStart.clientY;
    touchStart = null;
    if (Math.abs(dx) > 80 && Math.abs(dy) < 60) {
      saveNow();
      openMeter(state.pos + (dx < 0 ? 1 : -1));
    }
  });

  // Enter on a read field jumps to the next visible field.
  $('#meter-form').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    e.preventDefault();
    const fields = $$('#meter-form input[type=text], #meter-form textarea').filter(el => !el.closest('[hidden]'));
    fields[fields.indexOf(e.target) + 1]?.focus();
  });

  // Export dialog
  $('#btn-build').addEventListener('click', buildExport);
  $('#btn-share').addEventListener('click', shareExport);
  $('#btn-download').addEventListener('click', downloadExport);
  $$('[data-mail]').forEach(btn => btn.addEventListener('click', () => emailExport(btn.dataset.mail)));
  $('#export-issues').addEventListener('click', e => {
    const jump = e.target.closest('[data-jump]');
    if (!jump) return;
    $('#export-dialog').close();
    openMeter(state.parsed.meters.findIndex(m => m.r === +jump.dataset.jump));
  });

  // Locations & map
  const gs = geoSettings();
  $('#gh-repo').value = gs.repo;
  $('#gh-path').value = gs.path;
  $('#gh-branch').value = gs.branch;
  $('#gh-token').value = geoToken();
  $('#btn-gh-save').addEventListener('click', testGeoConnection);
  $$('.btn-sync').forEach(b => b.addEventListener('click', syncGeo));
  $('#btn-map').addEventListener('click', openMap);
  $('#btn-save-loc').addEventListener('click', saveLocationHere);
  $('#btn-map-style').addEventListener('click', () => {
    if (mapState.map) setMapStyle(prefs.get('mapStyle', 'street') === 'satellite' ? 'street' : 'satellite');
  });
  $('#btn-locate').addEventListener('click', () => {
    if (mapState.myPos) mapState.map.setView(mapState.myPos, 17);
    else toast('Waiting for GPS…');
  });
  window.addEventListener('online', syncGeo);
  window.addEventListener('offline', setGeoStatus);
  loadGeoLocal().then(() => { setGeoStatus(); syncGeo(); });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveNow();
    else checkNearby(); // back from another app or a locked screen: refresh straight away
  });

  // Nearby meters
  const autoOpen = $('#auto-open');
  autoOpen.checked = prefs.get('autoOpenNearest', true);
  autoOpen.addEventListener('change', () => prefs.set('autoOpenNearest', autoOpen.checked));
  $('#route-nearby').addEventListener('click', e => {
    const btn = e.target.closest('[data-pos]');
    if (btn) openMeter(+btn.dataset.pos);
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker not registered', err));
  }

  show('home');
}

init();
