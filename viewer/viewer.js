'use strict';
// LVB Viewer: opens route spreadsheets and shows their meters against the shared
// locations file. View only: nothing here writes to the spreadsheets or to GitHub.
// The parsing and map pieces are copies of the ones in ../app.js; keep them in step.

const VIEWER_VERSION = '2.0.0';
const GEO = { repo: 'metroutes-blip/meter-geocodes', path: 'geocodes.json', branch: 'main' };
const GOOD_M = 8;    // same lines the reader app draws: a good fix…
const ROUGH_M = 15;  // …and one it will try to improve

const $ = s => document.querySelector(s);
const norm = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// Storage can be unavailable (private windows, some file:// setups); the page still works without it.
const store = {
  get(key, fallback = '') { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* not remembered */ } },
};

const state = {
  routes: [],        // { id, name, meters: [{ item, city, streetNo, street, misc, meter, ... }] }
  selected: null,    // route id
  locations: {},     // "<Meter#>": { lat, lng, acc, by, at }
  geoLoaded: 0,      // time of the last good fetch
  geoError: '',
  geoBusy: false,
  picked: null,      // meter row highlighted in the list
  filter: 'all',     // all | missing | rough
};
let nextId = 1;

let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ── Reading a route spreadsheet ──────────────────────────────
const FIELDS = {
  item: ['item #', 'item#', 'item no', 'item', 'sequence', 'seq #', 'seq'],
  city: ['city'],
  streetNo: ['street #', 'street#', 'street no'],
  street: ['street'],
  misc: ['misc address', 'misc'],
  name: ['name'],
  meter: ['meter#', 'meter #', 'meter no'],
  location: ['meter location', 'location'],
  instructions: ['meter reader instructions', 'instructions'],
};

function cellText(cell) {
  if (!cell || cell.v == null || cell.v === '') return '';
  return cell.w != null ? String(cell.w).trim() : String(cell.v).trim();
}

function parseRoute(bytes) {
  const wb = XLSX.read(bytes, { type: 'array', cellFormula: false, cellHTML: false, cellStyles: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref']) throw new Error('the first sheet is empty');
  const range = XLSX.utils.decode_range(ws['!ref']);
  const at = (r, c) => cellText(ws[XLSX.utils.encode_cell({ r, c })]);

  // Header row = first row (within the top 10) that has a Meter# heading.
  let hr = -1;
  for (let r = range.s.r; r <= Math.min(range.s.r + 10, range.e.r) && hr < 0; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      if (FIELDS.meter.includes(norm(at(r, c)))) { hr = r; break; }
    }
  }
  if (hr < 0) throw new Error('no "Meter#" column found');

  const headers = [];
  for (let c = 0; c <= range.e.c; c++) headers[c] = norm(at(hr, c));
  // Stop at the first monthly read group, whose "Date"/"Comments" columns are not route info.
  let end = headers.findIndex(h => h.startsWith('corrected'));
  if (end < 0) end = headers.length;

  const cols = {};
  for (const [key, names] of Object.entries(FIELDS)) {
    for (let c = 0; c < end; c++) {
      if (names.includes(headers[c])) { cols[key] = c; break; }
    }
  }
  if (cols.meter == null) throw new Error('no "Meter#" column found');

  const meters = [];
  for (let r = hr + 1; r <= range.e.r; r++) {
    const m = { r };
    for (const [key, c] of Object.entries(cols)) m[key] = at(r, c);
    if (!m.meter && !m.item) continue;
    meters.push(m);
  }
  if (!meters.length) throw new Error('no meter rows found');
  return meters;
}

const addressOf = m => [m.streetNo, m.street].filter(Boolean).join(' ') + (m.misc ? ` ${m.misc}` : '');
const fullAddress = m => [addressOf(m), m.city].filter(Boolean).join(', ');
const addressKey = m => norm(`${addressOf(m)} ${m.city || ''}`);
const locationFor = m => {
  const key = String(m.meter || '').trim();
  return key ? state.locations[key] || null : null;
};

async function openFiles(files) {
  let opened = 0, last = null;
  const failed = [];
  for (const file of files) {
    try {
      const meters = parseRoute(new Uint8Array(await file.arrayBuffer()));
      const name = file.name.replace(/\.[^.]+$/, '');
      const existing = state.routes.find(r => r.name === name);
      if (existing) { existing.meters = meters; last = existing; }
      else { last = { id: nextId++, name, meters }; state.routes.push(last); }
      opened++;
    } catch (err) {
      failed.push(`${file.name}: ${err.message}`);
    }
  }
  if (failed.length) toast(`Could not open ${failed.join('; ')}.`, 7000);
  else if (opened > 1) toast(`${opened} routes opened.`);
  if (last) selectRoute(last.id);
  else render();
}

// ── Shared locations (read only) ─────────────────────────────
const key = () => store.get('lvbViewerKey').trim();

function ghFetch(url) {
  return fetch(url, {
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${key()}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
}
function ghError(status) {
  if (status === 401) return 'The access key was rejected. Check that it was pasted in full and has not expired.';
  if (status === 403) return 'This access key is not allowed to read the locations file.';
  if (status === 404) return 'The locations file was not found, or this access key cannot see it.';
  return `GitHub error ${status}.`;
}
function b64ToText(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function fetchLocations() {
  const repo = `https://api.github.com/repos/${GEO.repo}`;
  const res = await ghFetch(`${repo}/contents/${GEO.path}?ref=${encodeURIComponent(GEO.branch)}`);
  if (!res.ok) throw new Error(ghError(res.status));
  const meta = await res.json();
  let b64 = meta.content;
  if (!b64) { // files over 1 MB come back without content
    const blob = await ghFetch(`${repo}/git/blobs/${meta.sha}`);
    if (!blob.ok) throw new Error(ghError(blob.status));
    b64 = (await blob.json()).content;
  }
  const text = b64ToText(b64);
  try { return (text.trim() ? JSON.parse(text) : {}).meters || {}; }
  catch { throw new Error('The locations file could not be read.'); }
}

async function loadLocations(announce = false) {
  if (!key()) { state.geoError = ''; renderGeo(); return; }
  if (state.geoBusy) return;
  state.geoBusy = true;
  renderGeo();
  try {
    state.locations = await fetchLocations();
    state.geoLoaded = Date.now();
    state.geoError = '';
    if (announce) toast(`${Object.keys(state.locations).length.toLocaleString()} saved locations loaded.`);
  } catch (err) {
    state.geoError = err instanceof TypeError ? 'Could not reach GitHub. Check the internet connection.' : err.message;
  }
  state.geoBusy = false;
  render();
  drawMap(!mapState.fitted);
}

// ── Screen ───────────────────────────────────────────────────
const quality = loc => loc.acc <= GOOD_M ? 'good' : loc.acc <= ROUGH_M ? 'ok' : 'rough';
const isRough = m => { const l = locationFor(m); return !!l && quality(l) === 'rough'; };
const QUALITY_COLOUR = { good: '#1b6b3c', ok: '#a87400', rough: '#c2410c' };
const QUALITY_ORDER = ['rough', 'ok', 'good'];
const accText = loc => Number.isFinite(loc.acc) ? `±${Math.round(loc.acc)} m` : 'saved';
const dateText = (iso, year = true) => {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, year ? { year: 'numeric', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
};
const coverage = meters => {
  const located = meters.filter(locationFor).length;
  return { located, total: meters.length, pct: meters.length ? Math.round(100 * located / meters.length) : 0 };
};
const coverText = c => `${c.located} of ${c.total} located (${c.pct}%)`;
const selectedRoute = () => state.routes.find(r => r.id === state.selected) || null;
const timeText = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function renderGeo() {
  const count = Object.keys(state.locations).length.toLocaleString();
  let pill, dot, long;
  if (state.geoBusy) { pill = 'Loading locations…'; dot = 'busy'; long = 'Loading saved locations…'; }
  else if (state.geoError) { pill = 'Locations not loaded'; dot = 'err'; long = state.geoError; }
  else if (!key()) { pill = 'No access key'; dot = ''; long = 'Enter the access key to load saved locations.'; }
  else if (state.geoLoaded) { pill = `${count} locations · ${timeText(state.geoLoaded)}`; dot = 'ok'; long = `${count} locations loaded at ${timeText(state.geoLoaded)}.`; }
  else { pill = 'Locations not loaded'; dot = ''; long = ''; }
  $('#geo-status-text').textContent = pill;
  $('#geo-dot').className = `pill-dot ${dot}`;
  $('#geo-pill').title = long;
  const status = $('#geo-status');
  status.textContent = long;
  status.classList.toggle('err', !!state.geoError);
  $('#btn-refresh').disabled = state.geoBusy || !key();
}

function renderRoutes() {
  $('#tabs').hidden = state.routes.length === 0;
  $('#routes').innerHTML = state.routes.map(r => {
    const c = coverage(r.meters);
    const on = r.id === state.selected;
    return `<div class="tab${on ? ' on' : ''}">
      <button type="button" class="tab-pick" data-route="${r.id}" aria-current="${on}" title="${esc(coverText(c))}">
        <span class="tab-name">${esc(r.name)}</span>
        <span class="tab-cover"><span class="bar"><i style="width:${c.pct}%"></i></span>${c.pct}%</span>
      </button>
      <button type="button" class="tab-close" data-close="${r.id}" title="Close this route" aria-label="Close ${esc(r.name)}">×</button>
    </div>`;
  }).join('');
  const total = $('#routes-total');
  total.hidden = state.routes.length < 2;
  if (!total.hidden) {
    const c = coverage(state.routes.flatMap(r => r.meters));
    total.innerHTML = `All ${state.routes.length} routes: <strong>${c.located} of ${c.total}</strong> located (${c.pct}%)`;
  }
}

function renderStats(route) {
  const c = coverage(route.meters);
  const rough = route.meters.filter(isRough).length;
  $('#stat-total').textContent = c.total;
  $('#stat-located').innerHTML = `${c.located}<small>${c.pct}%</small>`;
  $('#stat-missing').textContent = c.total - c.located;
  $('#stat-rough').textContent = rough;
  $('#n-all').textContent = c.total;
  $('#n-missing').textContent = c.total - c.located;
  $('#n-rough').textContent = rough;
  $('#stats').setAttribute('aria-label', `${route.name} summary`);
}

function visibleMeters(route) {
  const q = norm($('#search').value);
  return route.meters.filter(m => {
    if (state.filter === 'missing' && locationFor(m)) return false;
    if (state.filter === 'rough' && !isRough(m)) return false;
    return !q || norm(`${m.item} ${fullAddress(m)} ${m.meter} ${m.name || ''}`).includes(q);
  });
}

function renderList() {
  const route = selectedRoute();
  if (!route) return;
  document.querySelectorAll('#filters [data-filter]').forEach(b =>
    b.setAttribute('aria-pressed', b.dataset.filter === state.filter));
  const list = visibleMeters(route);
  $('#rows').innerHTML = list.map(m => {
    const loc = locationFor(m);
    const sub = loc
      ? [loc.by, dateText(loc.at, false)].filter(Boolean).join(' · ')
      : '';
    const where = loc
      ? `<span class="m-loc"><i class="dot q-${quality(loc)}"></i>${esc(accText(loc))}</span>`
      : '<span class="m-missing">Missing</span>';
    const cls = [loc ? 'has-loc' : 'missing', m.r === state.picked ? 'picked' : ''].filter(Boolean).join(' ');
    return `<li data-row="${m.r}" class="${cls}"${loc ? ' tabindex="0"' : ''}>
      <span class="m-item">${esc(m.item)}</span>
      <span class="m-main">
        <span class="m-addr">${esc(addressOf(m) || fullAddress(m))}</span>
        <span class="m-sub"><span class="num">${esc(m.meter)}</span>${sub ? ` · ${esc(sub)}` : ''}</span>
      </span>
      ${where}
    </li>`;
  }).join('') || '<li class="none">No meters match.</li>';
}

function render() {
  renderGeo();
  renderRoutes();
  const route = selectedRoute();
  $('#empty').hidden = !!route;
  $('#route').hidden = !route;
  if (!route) return;
  $('#route-name').textContent = route.name;
  renderStats(route);
  renderList();
}

// ── Map ──────────────────────────────────────────────────────
// Street and Satellite come from Esri's public basemaps, which work from a double-clicked file.
// OpenStreetMap's own servers refuse requests that carry no website address, so that choice
// is offered only when the viewer is opened from a web link.
const ON_WEB = /^https?:$/.test(location.protocol);
const esriTiles = name => `https://server.arcgisonline.com/ArcGIS/rest/services/${name}/MapServer/tile/{z}/{y}/{x}`;
const TILES = {
  street: {
    layers: [esriTiles('World_Street_Map')],
    attribution: '© <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, © OpenStreetMap contributors',
  },
  satellite: {
    layers: [esriTiles('World_Imagery'), esriTiles('Reference/World_Transportation'), esriTiles('Reference/World_Boundaries_and_Places')],
    attribution: '© <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics, HERE, Garmin',
  },
  osm: {
    layers: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
};
const mapStyle = () => {
  const style = store.get('lvbViewerMapStyle', 'street');
  return TILES[style] && (style !== 'osm' || ON_WEB) ? style : 'street';
};
function markMapStyle() {
  const style = mapStyle();
  document.querySelectorAll('#map-styles [data-style]').forEach(b => {
    b.classList.toggle('on', b.dataset.style === style);
    b.setAttribute('aria-pressed', b.dataset.style === style);
  });
}
const mapState = { map: null, tiles: null, pins: null, markerFor: new Map(), points: [], fitted: false };

function setMapStyle(style) {
  store.set('lvbViewerMapStyle', style);
  style = mapStyle();
  const cfg = TILES[style];
  if (mapState.tiles) mapState.map.removeLayer(mapState.tiles);
  mapState.tiles = L.layerGroup(cfg.layers.map((url, i) => L.tileLayer(url, {
    maxZoom: 19,
    attribution: i === 0 ? cfg.attribution : '',
  }))).addTo(mapState.map);
  markMapStyle();
}

// "4"; "1–2" or "7–9" for a consecutive run; "1+3" for two; "8…12" (first…last) for more.
function pinLabel(items) {
  if (items.length === 1) return items[0] || '•';
  const nums = items.map(Number);
  if (items.every(s => /^\d+$/.test(s)) && nums.every((n, i) => !i || n === nums[i - 1] + 1)) return `${nums[0]}–${nums.at(-1)}`;
  if (!items.every(Boolean)) return `×${items.length}`;
  return items.length === 2 ? `${items[0]}+${items[1]}` : `${items[0]}…${items.at(-1)}`;
}

function fitMap() {
  if (!mapState.map || !mapState.points.length) return;
  mapState.map.fitBounds(mapState.points, { padding: [40, 40], maxZoom: 18 });
  mapState.fitted = true;
}

function drawMap(fit) {
  const route = selectedRoute();
  if (!route || !window.L) return;
  if (!mapState.map) {
    mapState.map = L.map('map', { zoomControl: true, maxZoom: 19 }).setView([43.7, -79.4], 10);
    setMapStyle(mapStyle());
    mapState.pins = L.layerGroup().addTo(mapState.map);
  }
  mapState.map.invalidateSize();
  mapState.pins.clearLayers();
  mapState.markerFor.clear();

  // One pin per address: meters in the same room would otherwise stack and hide each other.
  const groups = new Map();
  for (const m of route.meters) {
    if (!locationFor(m)) continue;
    const k = addressKey(m);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  mapState.points = [];
  for (const meters of groups.values()) {
    const locs = meters.map(locationFor);
    const worst = QUALITY_ORDER.find(q => locs.some(l => quality(l) === q));
    const text = pinLabel(meters.map(m => m.item));
    const w = Math.max(32, 14 + text.length * 8);
    const icon = L.divIcon({
      className: '',
      html: `<div class="pin" style="width:${w}px;background:${QUALITY_COLOUR[worst]}">${esc(text)}</div>`,
      iconSize: [w, 32],
      iconAnchor: [w / 2, 16],
    });
    const head = `<strong>${esc(fullAddress(meters[0]))}</strong>${meters.length > 1 ? ` · ${meters.length} meters` : ''}`;
    const rows = meters.map((m, i) => `
      <div class="pop-meter">
        <strong>Item ${esc(m.item)}</strong> · Meter ${esc(m.meter)}
        <br><span class="sub">${esc(accText(locs[i]))}${locs[i].by ? ` · saved by ${esc(locs[i].by)}` : ''}${dateText(locs[i].at) ? ` · ${esc(dateText(locs[i].at))}` : ''}</span>
        ${m.instructions ? `<br><em>${esc(m.instructions)}</em>` : ''}
      </div>`).join('');
    const marker = L.marker([locs[0].lat, locs[0].lng], { icon })
      .bindPopup(`<div class="pop">${head}${rows}</div>`)
      .addTo(mapState.pins);
    for (const m of meters) mapState.markerFor.set(m.r, marker);
    mapState.points.push([locs[0].lat, locs[0].lng]);
  }
  if (fit) { mapState.fitted = false; fitMap(); }
}

function selectRoute(id) {
  state.selected = id;
  state.picked = null;
  state.filter = 'all';
  $('#search').value = '';
  render();
  // The map box only has a size once the route section is showing.
  setTimeout(() => drawMap(true), 0);
}

function showMeter(row) {
  const marker = mapState.markerFor.get(row);
  if (!marker) return;
  state.picked = row;
  renderList();
  mapState.map.setView(marker.getLatLng(), 18);
  marker.openPopup();
}

// ── Wiring ───────────────────────────────────────────────────
function init() {
  $('#version').textContent = `v${VIEWER_VERSION}`;

  $('#btn-open').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', e => {
    openFiles([...e.target.files]);
    e.target.value = '';
  });

  $('#routes').addEventListener('click', e => {
    const pick = e.target.closest('[data-route]');
    const close = e.target.closest('[data-close]');
    if (pick) selectRoute(+pick.dataset.route);
    if (close) {
      state.routes = state.routes.filter(r => r.id !== +close.dataset.close);
      if (!selectedRoute()) selectRoute(state.routes[0]?.id ?? null);
      else render();
    }
  });

  // Access key dialog.
  const dialog = $('#key-dialog');
  const openKey = () => {
    $('#key').value = key();
    renderGeo();
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
    $('#key').focus();
  };
  $('#btn-key-open').addEventListener('click', openKey);
  $('#geo-pill').addEventListener('click', openKey);
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'save') return;
    store.set('lvbViewerKey', $('#key').value.trim());
    if (!key()) { state.locations = {}; state.geoLoaded = 0; state.geoError = ''; render(); drawMap(false); return; }
    loadLocations(true);
  });
  $('#btn-refresh').addEventListener('click', () => loadLocations(true));

  $('#search').addEventListener('input', renderList);
  $('#filters').addEventListener('click', e => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    renderList();
  });
  $('#btn-fit').addEventListener('click', () => {
    if (mapState.points.length) fitMap();
    else toast('No meters on this route have a saved location yet.');
  });
  $('#map-styles [data-style="osm"]').hidden = !ON_WEB;
  markMapStyle();
  $('#map-styles').addEventListener('click', e => {
    const btn = e.target.closest('[data-style]');
    if (btn && mapState.map) setMapStyle(btn.dataset.style);
  });

  // Full screen: the tabs, numbers and list step aside so the map fills the window.
  const setBigMap = on => {
    document.body.classList.toggle('big-map', on);
    $('#btn-big').textContent = on ? 'Show list' : 'Full screen';
    store.set('lvbViewerBigMap', on ? '1' : '');
    mapState.map?.invalidateSize();
  };
  setBigMap(store.get('lvbViewerBigMap') === '1');
  $('#btn-big').addEventListener('click', () => setBigMap(!document.body.classList.contains('big-map')));

  $('#rows').addEventListener('click', e => {
    const row = e.target.closest('li[data-row]');
    if (row) showMeter(+row.dataset.row);
  });
  $('#rows').addEventListener('keydown', e => {
    const row = e.target.closest('li[data-row]');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); showMeter(+row.dataset.row); }
  });

  // Drag and drop anywhere on the page.
  let depth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', e => { if (hasFiles(e)) { depth++; $('#drop').hidden = false; } });
  window.addEventListener('dragleave', e => { if (hasFiles(e) && --depth <= 0) { depth = 0; $('#drop').hidden = true; } });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    $('#drop').hidden = true;
    const files = [...e.dataTransfer.files].filter(f => /\.xlsx?$/i.test(f.name));
    if (files.length) openFiles(files);
    else toast('Only .xlsx or .xls route files can be opened.');
  });

  render();
  if (key()) loadLocations();
  else openKey();
}

init();
