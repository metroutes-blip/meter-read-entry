// Leela Chess: play Leela Chess Zero on the iPad, or analyse with it.
import { Chess } from './vendor/chess.js';
import { START_FEN } from './lc0.js';

const $ = id => document.getElementById(id);
const SAVE_KEY = 'leela-chess-v1';
const PIECE_NAMES = { p: 'P', n: 'N', b: 'B', r: 'R', q: 'Q', k: 'K' };
const pieceSrc = (color, type) => `pieces/${color}${PIECE_NAMES[type]}.svg`;

const LEVELS = [
  { id: 'relaxed', name: 'Relaxed', desc: "Leela's instinct with some variety: it picks among the moves its network likes, without searching.", limits: { nodes: 1 }, sample: { temperature: 1, minShare: 0.15 } },
  { id: 'instinct', name: 'Instinct', desc: "Leela's favourite move from its network alone, no search. Already a strong player.", limits: { nodes: 1 } },
  { id: 'quick', name: 'Quick', desc: 'Searches for 1 second a move.', limits: { timeMs: 1000 } },
  { id: 'strong', name: 'Strong', desc: 'Searches for 3 seconds a move.', limits: { timeMs: 3000 } },
  { id: 'deep', name: 'Deep', desc: 'Searches for 10 seconds a move.', limits: { timeMs: 10000 } },
  { id: 'full', name: 'Full', desc: 'Searches for 30 seconds a move, like a deep analysis.', limits: { timeMs: 30000 } },
];
const levelById = id => LEVELS.find(l => l.id === id) || LEVELS[3];

// ------------------------------------------------------------------ state
const defaults = () => ({
  startFen: START_FEN, moves: [], cursor: 0, mode: 'play', human: 'w', level: 'strong',
  flipped: false, showEval: true, coords: true, lastEval: null,
});
let state = defaults();
try {
  const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
  if (saved && Array.isArray(saved.moves)) state = { ...defaults(), ...saved };
} catch { /* start fresh */ }
const save = () => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch { /* ignore */ } };

// Position after the first k moves.
function positionAt(k) {
  const c = new Chess(state.startFen);
  for (let i = 0; i < k; i++) c.move(state.moves[i].uci.length > 4
    ? { from: state.moves[i].uci.slice(0, 2), to: state.moves[i].uci.slice(2, 4), promotion: state.moves[i].uci[4] }
    : { from: state.moves[i].uci.slice(0, 2), to: state.moves[i].uci.slice(2, 4) });
  return c;
}
// Rebuild the saved game; drop anything unreadable.
try { positionAt(state.moves.length); } catch { state = defaults(); }
state.cursor = Math.min(state.cursor, state.moves.length);

let view = positionAt(state.cursor);  // the position on the board
const atEnd = () => state.cursor === state.moves.length;

function gameOver(c) {
  if (c.isCheckmate()) {
    const loser = c.turn();
    return { result: loser === 'w' ? '0-1' : '1-0', text: 'Checkmate', winner: loser === 'w' ? 'b' : 'w' };
  }
  if (c.isStalemate()) return { result: '1/2-1/2', text: 'Draw by stalemate' };
  if (c.isInsufficientMaterial()) return { result: '1/2-1/2', text: 'Draw: not enough material to mate' };
  if (c.isThreefoldRepetition()) return { result: '1/2-1/2', text: 'Draw by threefold repetition' };
  if (c.isDrawByFiftyMoves()) return { result: '1/2-1/2', text: 'Draw by the 50-move rule' };
  return null;
}

// ----------------------------------------------------------------- engine
const engine = { ready: false, backend: '', threads: 0, nps: 0, error: null };
let worker = null;
let searchSeq = 0;
let active = null;        // { id, kind: 'move'|'analysis'|'hint', key }
let liveInfo = null;      // latest info for the active search
let analysisInfo = null;  // info shown in analysis mode
let hintArrow = null;

function startEngine() {
  worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = e => onEngineMessage(e.data);
  worker.onerror = e => { engine.error = e.message || 'The engine could not start'; renderStatus(); };
  worker.postMessage({ type: 'init', preferGpu: true });
  setStatus('loading', 'Loading Leela…');
}

function positionKey() {
  return state.startFen + '|' + state.moves.slice(0, state.cursor).map(m => m.uci).join(' ');
}

function startSearch(kind, limits, sample) {
  const key = positionKey();
  if (active && active.kind === kind && active.key === key) return;
  const id = ++searchSeq;
  active = { id, kind, key, toMove: view.turn(), fen: view.fen() };
  liveInfo = null;
  worker.postMessage({
    type: 'go', id, startFen: state.startFen,
    moves: state.moves.slice(0, state.cursor).map(m => m.uci),
    limits, sample,
  });
  renderEngine();
  renderStatus();
}

function stopSearch() {
  if (!active) return;
  worker.postMessage({ type: 'stop' });
  active = null;
  liveInfo = null;
  renderStatus();
}

function onEngineMessage(msg) {
  switch (msg.type) {
    case 'progress': {
      if (msg.phase === 'starting') setStatus('loading', 'Starting Leela…');
      else if (msg.total) {
        const pct = Math.floor(100 * msg.loaded / msg.total);
        setStatus('loading', msg.cached ? `Loading Leela… ${pct}%`
          : `Downloading Leela's network… ${pct}% of ${Math.round(msg.total / 1e6)} MB (first time only)`);
      }
      break;
    }
    case 'ready':
      Object.assign(engine, { ready: true, backend: msg.backend, threads: msg.threads, nps: msg.nps });
      renderStatus();
      renderLevels();
      render();
      think();
      break;
    case 'error':
      if (!engine.ready) { engine.error = msg.message; renderStatus(); }
      else toast('Leela: ' + msg.message);
      break;
    case 'info':
      if (!active || msg.id !== active.id) return;
      liveInfo = msg.info;
      if (msg.info.nps > 0 && msg.info.ms > 1500) engine.nps = Math.round(engine.nps * 0.7 + msg.info.nps * 0.3);
      if (active.kind === 'analysis') analysisInfo = { ...msg.info, toMove: active.toMove, fen: active.fen };
      renderEngine();
      renderArrows();
      renderStatus();
      break;
    case 'done': {
      if (!active || msg.id !== active.id) return;
      const done = active;
      active = null;
      liveInfo = null;
      if (done.kind === 'move' && done.key === positionKey() && atEnd()) {
        const line = msg.info.lines.find(l => l.uci === msg.move) || msg.info.lines[0];
        state.lastEval = line ? { ...whiteView(line, done.toMove), pv: line.pv, fen: done.fen, n: msg.info.nodes } : null;
        playUci(msg.move);
      } else if (done.kind === 'hint' && done.key === positionKey()) {
        hintArrow = msg.move;
        const san = sanLine(done.fen, [msg.move], 1);
        toast(`Leela suggests ${san}`);
        renderArrows();
      }
      renderEngine();
      renderStatus();
      break;
    }
  }
}

// Decide what Leela should be doing for the current position.
function think() {
  if (!engine.ready) return;
  const over = gameOver(view);
  if (state.mode === 'analysis') {
    if (over || document.hidden) { stopSearch(); return; }
    startSearch('analysis', { infinite: true });
    return;
  }
  const leelaToMove = atEnd() && !over && view.turn() !== state.human;
  if (leelaToMove) {
    const lvl = levelById(state.level);
    startSearch('move', lvl.limits, lvl.sample);
  } else if (active && !(active.kind === 'hint' && active.key === positionKey())) {
    stopSearch();
  }
}

// ------------------------------------------------------------------ moves
function playUci(uci) {
  const c = positionAt(state.cursor);
  let mv;
  try { mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch { mv = null; }
  if (!mv) return false;
  state.moves = state.moves.slice(0, state.cursor);
  state.moves.push({ uci: mv.lan, san: mv.san });
  state.cursor = state.moves.length;
  view = c;
  hintArrow = null;
  analysisInfo = null;
  selected = null;
  save();
  render();
  think();
  return true;
}

function goTo(k) {
  k = Math.max(0, Math.min(state.moves.length, k));
  if (k === state.cursor) return;
  state.cursor = k;
  view = positionAt(k);
  selected = null;
  hintArrow = null;
  analysisInfo = null;
  save();
  render();
  think();
}

function canMoveNow() {
  if (gameOver(view)) return false;
  return state.mode === 'analysis' || view.turn() === state.human;
}

// --------------------------------------------------------- board drawing
const boardEl = $('board');
let selected = null;
let drag = null;

function squareName(file, rank) { return 'abcdefgh'[file] + (rank + 1); }
function displayToSquare(col, row) {
  return state.flipped ? squareName(7 - col, row) : squareName(col, 7 - row);
}

function renderBoard() {
  boardEl.classList.toggle('hide-coords', !state.coords);
  const last = state.cursor > 0 ? state.moves[state.cursor - 1].uci : null;
  const dests = selected ? view.moves({ square: selected, verbose: true }).map(m => m.to) : [];
  let checkSq = null;
  if (view.inCheck()) {
    const b = view.board();
    for (const row of b) for (const p of row) if (p && p.type === 'k' && p.color === view.turn()) checkSq = p.square;
  }
  const frag = document.createDocumentFragment();
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const sq = displayToSquare(col, row);
      const file = sq.charCodeAt(0) - 97, rank = +sq[1] - 1;
      const el = document.createElement('div');
      el.className = 'sq' + ((file + rank) % 2 === 0 ? ' dark' : '');
      el.dataset.sq = sq;
      if (last && (last.slice(0, 2) === sq || last.slice(2, 4) === sq)) el.classList.add('last');
      if (sq === selected) el.classList.add('sel');
      if (sq === checkSq) el.classList.add('check');
      const p = view.get(sq);
      if (dests.includes(sq)) el.classList.add('dest', ...(p ? ['occupied'] : []));
      if (p) {
        const img = document.createElement('img');
        img.src = pieceSrc(p.color, p.type);
        img.alt = '';
        img.draggable = false;
        el.appendChild(img);
      }
      if (col === 0) { const s = document.createElement('span'); s.className = 'coord rank'; s.textContent = sq[1]; el.appendChild(s); }
      if (row === 7) { const s = document.createElement('span'); s.className = 'coord file'; s.textContent = sq[0]; el.appendChild(s); }
      frag.appendChild(el);
    }
  }
  boardEl.replaceChildren(frag);
}

function squareAt(x, y) {
  const r = boardEl.getBoundingClientRect();
  const col = Math.floor((x - r.left) / (r.width / 8));
  const row = Math.floor((y - r.top) / (r.height / 8));
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  return displayToSquare(col, row);
}
const sqEl = sq => boardEl.querySelector(`[data-sq="${sq}"]`);

boardEl.addEventListener('pointerdown', e => {
  if (!$('promo').hidden) return;
  const sq = squareAt(e.clientX, e.clientY);
  if (!sq) return;
  if (!canMoveNow()) { selected = null; renderBoard(); return; }
  const p = view.get(sq);
  if (selected && selected !== sq) {
    const legal = view.moves({ square: selected, verbose: true });
    if (legal.some(m => m.to === sq)) { tryMove(selected, sq); return; }
  }
  if (p && p.color === view.turn()) {
    const wasSelected = selected === sq;
    selected = sq;
    renderBoard();
    drag = { from: sq, id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, wasSelected, ghost: null, hover: null };
    boardEl.setPointerCapture(e.pointerId);
  } else if (selected) {
    selected = null;
    renderBoard();
  }
});

boardEl.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
  if (!drag.moved) {
    drag.moved = true;
    const p = view.get(drag.from);
    const g = document.createElement('img');
    g.src = pieceSrc(p.color, p.type);
    g.className = 'drag-piece';
    const size = boardEl.getBoundingClientRect().width / 8;
    g.style.width = g.style.height = size + 'px';
    document.body.appendChild(g);
    drag.ghost = g;
    const img = sqEl(drag.from)?.querySelector('img');
    if (img) img.classList.add('lifted');
  }
  drag.ghost.style.left = e.clientX + 'px';
  drag.ghost.style.top = e.clientY + 'px';
  const over = squareAt(e.clientX, e.clientY);
  if (over !== drag.hover) {
    if (drag.hover) sqEl(drag.hover)?.classList.remove('hover');
    drag.hover = over;
    if (over) sqEl(over)?.classList.add('hover');
  }
});

function endDrag(e, cancelled) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  if (d.ghost) d.ghost.remove();
  if (d.moved) {
    const to = cancelled ? null : squareAt(e.clientX, e.clientY);
    if (to && to !== d.from && view.moves({ square: d.from, verbose: true }).some(m => m.to === to)) {
      tryMove(d.from, to);
      return;
    }
    renderBoard();
  } else if (d.wasSelected) {
    selected = null;   // second tap on the same piece
    renderBoard();
  }
}
boardEl.addEventListener('pointerup', e => endDrag(e, false));
boardEl.addEventListener('pointercancel', e => endDrag(e, true));

function tryMove(from, to) {
  const options = view.moves({ square: from, verbose: true }).filter(m => m.to === to);
  if (!options.length) return;
  if (options.some(m => m.promotion)) {
    choosePromotion(view.turn()).then(p => {
      if (p) playUci(from + to + p);
      else { selected = null; renderBoard(); }
    });
    return;
  }
  playUci(from + to);
}

function choosePromotion(color) {
  return new Promise(resolve => {
    const box = $('promo');
    const inner = document.createElement('div');
    inner.className = 'promo-box';
    for (const t of ['q', 'r', 'b', 'n']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[t]);
      b.innerHTML = `<img src="${pieceSrc(color, t)}" alt="">`;
      b.onclick = ev => { ev.stopPropagation(); box.hidden = true; resolve(t); };
      inner.appendChild(b);
    }
    box.replaceChildren(inner);
    box.onclick = () => { box.hidden = true; resolve(null); };
    box.hidden = false;
  });
}

// ----------------------------------------------------------------- arrows
function renderArrows() {
  const svg = $('arrows');
  const arrows = [];
  if (state.mode === 'analysis' && analysisInfo && analysisInfo.fen === view.fen()) {
    const lines = analysisInfo.lines;
    if (lines[1] && lines[1].n > lines[0].n * 0.25) arrows.push([lines[1].uci, 'var(--arrow-2)']);
    if (lines[0]) arrows.push([lines[0].uci, 'var(--arrow)']);
  }
  if (hintArrow) arrows.push([hintArrow, 'var(--arrow)']);
  const center = sq => {
    const f = sq.charCodeAt(0) - 97, r = +sq[1] - 1;
    return state.flipped ? [7 - f + 0.5, r + 0.5] : [f + 0.5, 7 - r + 0.5];
  };
  svg.innerHTML = arrows.map(([uci, color], i) => {
    const [x1, y1] = center(uci.slice(0, 2));
    const [x2, y2] = center(uci.slice(2, 4));
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    const head = 0.42, w = 0.16;
    const bx = x2 - ux * head, by = y2 - uy * head;   // base of the arrow head
    const px = -uy, py = ux;
    const sx = x1 + ux * 0.18, sy = y1 + uy * 0.18;
    const pts = [
      [sx + px * w / 2, sy + py * w / 2], [bx + px * w / 2, by + py * w / 2], [bx + px * 0.24, by + py * 0.24],
      [x2 - ux * 0.08, y2 - uy * 0.08], [bx - px * 0.24, by - py * 0.24], [bx - px * w / 2, by - py * w / 2],
      [sx - px * w / 2, sy - py * w / 2],
    ].map(p => p.map(v => v.toFixed(3)).join(',')).join(' ');
    return `<polygon points="${pts}" fill="${color}" data-i="${i}"/>`;
  }).join('');
}

// ------------------------------------------------------------- evaluation
// Turn a line seen by the side to move into White's point of view.
function whiteView(line, toMove) {
  const s = toMove === 'w' ? 1 : -1;
  return {
    q: line.q * s, cp: line.cp * s, d: line.d,
    w: toMove === 'w' ? line.w : line.l, l: toMove === 'w' ? line.l : line.w,
    mate: line.mate ? line.mate * s : 0,
  };
}
function fmtScore(ev) {
  if (ev.mate) return ev.mate > 0 ? `#${ev.mate}` : `#-${-ev.mate}`;
  const v = ev.cp / 100;
  if (Math.abs(v) >= 100) return v > 0 ? '+M' : '−M';
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
}
const fmtNodes = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);

function sanLine(fen, ucis, max = 10) {
  const c = new Chess(fen);
  const parts = [];
  for (const u of ucis.slice(0, max)) {
    const ply = c.moveNumber();
    const white = c.turn() === 'w';
    let mv;
    try { mv = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { break; }
    if (white) parts.push(`${ply}. ${mv.san}`);
    else parts.push(parts.length ? mv.san : `${ply}… ${mv.san}`);
  }
  return parts.join(' ');
}

function setWdl(ev) {
  const el = $('wdl');
  const [w, d, l] = ev ? [ev.w, ev.d, ev.l] : [0, 1, 0];
  el.querySelector('.w').style.flexBasis = (w * 100) + '%';
  el.querySelector('.d').style.flexBasis = (d * 100) + '%';
  el.querySelector('.l').style.flexBasis = (l * 100) + '%';
  $('wdlLegend').innerHTML = ev
    ? `<span>White wins ${Math.round(w * 100)}%</span><span>Draw ${Math.round(d * 100)}%</span><span>Black wins ${Math.round(l * 100)}%</span>`
    : '';
}

function setEvalBar(ev) {
  const bar = $('evalbar');
  bar.classList.toggle('flipped', state.flipped);
  const showBar = state.mode === 'analysis' || state.showEval;
  bar.classList.toggle('off', !showBar);
  const score = ev ? Math.max(0.02, Math.min(0.98, ev.w + ev.d / 2)) : 0.5;
  $('evalbarWhite').style.height = (score * 100) + '%';
  const txt = $('evalbarText');
  txt.textContent = ev ? fmtScore(ev).replace('+', '') : '';
  const whiteSideOnTop = state.flipped;
  const whiteAhead = score >= 0.5;
  // Put the number on the leading side's end of the bar, in contrasting colour.
  const onTop = whiteAhead === whiteSideOnTop;
  txt.style.top = onTop ? '0' : '';
  txt.style.bottom = onTop ? '' : '0';
  txt.style.color = whiteAhead ? 'var(--b-bar)' : 'var(--w-bar)';
}

function renderEngine() {
  const card = $('engineCard');
  const over = gameOver(view);
  let ev = null, sub = '', lines = [];
  const thinking = active && (active.kind === 'move' || active.kind === 'hint');

  if (!engine.ready) {
    sub = engine.error ? 'Leela could not start.' : 'Leela is loading…';
  } else if (state.mode === 'analysis') {
    const info = analysisInfo && analysisInfo.fen === view.fen() ? analysisInfo : null;
    if (info && info.lines.length) {
      ev = whiteView(info.lines[0], info.toMove);
      lines = info.lines.slice(0, 3).map(l => ({ ev: whiteView(l, info.toMove), text: sanLine(info.fen, l.pv, 10), uci: l.uci, n: l.n }));
      sub = `Analysing · ${fmtNodes(info.nodes)} positions`;
    } else sub = over ? over.text : 'Analysing…';
  } else {
    if (thinking && liveInfo && liveInfo.lines.length) {
      ev = whiteView(liveInfo.lines[0], active.toMove);
      sub = active.kind === 'hint' ? `Finding a hint · ${fmtNodes(liveInfo.nodes)} positions` : `Leela is thinking · ${fmtNodes(liveInfo.nodes)} positions`;
    } else if (thinking) {
      sub = active.kind === 'hint' ? 'Finding a hint…' : 'Leela is thinking…';
      if (state.lastEval) ev = state.lastEval;
    } else {
      ev = state.lastEval;
      if (over) sub = over.text;
      else if (!atEnd()) sub = 'Looking back through the game';
      else if (view.turn() === state.human) sub = 'Your move';
      if (ev && ev.pv && ev.pv.length > 1 && atEnd() && !over) {
        // Leela's expected continuation after its move
        const c = new Chess(ev.fen);
        try {
          c.move({ from: ev.pv[0].slice(0, 2), to: ev.pv[0].slice(2, 4), promotion: ev.pv[0][4] });
          lines = [{ label: 'Leela expects', text: sanLine(c.fen(), ev.pv.slice(1), 8) }];
        } catch { /* stale */ }
      }
    }
  }
  const hide = state.mode === 'play' && !state.showEval;
  card.classList.toggle('hidden-eval', hide);
  $('evalBig').textContent = ev ? fmtScore(ev) : '–';
  $('evalSub').textContent = sub;
  const meta = [];
  if (engine.ready) meta.push(engine.backend === 'webgpu' ? 'WebGPU' : `CPU${engine.threads > 1 ? ' ×' + engine.threads : ''}`);
  const nps = (state.mode === 'analysis' ? analysisInfo?.nps : liveInfo?.nps) || 0;
  if (nps) meta.push(`${fmtNodes(nps)}/s`);
  $('engineMeta').innerHTML = meta.join('<br>');
  setWdl(hide ? null : ev);
  setEvalBar(hide ? null : ev);
  const ol = $('lines');
  ol.replaceChildren(...lines.map(l => {
    const li = document.createElement('li');
    if (l.label) {
      li.className = 'note';
      li.innerHTML = `<span class="sc"></span><span class="pv"></span>`;
      li.querySelector('.sc').textContent = l.label;
      li.querySelector('.pv').textContent = l.text;
    } else {
      li.innerHTML = `<span class="sc"></span><span class="pv"></span>`;
      li.querySelector('.sc').textContent = fmtScore(l.ev);
      li.querySelector('.pv').textContent = l.text;
      li.title = 'Play this move';
      li.onclick = () => playUci(l.uci);
    }
    return li;
  }));
}

function setStatus(kind, text) {
  const el = $('engineStatus');
  el.className = 'engine-status ' + kind;
  $('engineStatusText').textContent = text;
}
function renderStatus() {
  if (engine.error) setStatus('error', 'Leela could not start: ' + engine.error);
  else if (!engine.ready) { /* progress messages set the text */ }
  else if (active && active.kind === 'analysis') setStatus('thinking', 'Leela is analysing');
  else if (active) setStatus('thinking', active.kind === 'hint' ? 'Leela is finding a hint…' : 'Leela is thinking…');
  else setStatus('ready', `Leela ready · ${engine.backend === 'webgpu' ? 'WebGPU' : 'CPU'}`);
  renderButtons();
}

// --------------------------------------------------------- side panel
function renderMoves() {
  const ol = $('moves');
  const items = [];
  const first = new Chess(state.startFen);
  let num = first.moveNumber();
  let whiteTurn = first.turn() === 'w';
  if (!state.moves.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = state.mode === 'play' ? (state.human === 'w' ? 'You have White. Make your first move.' : 'Leela has White and moves first.') : 'Move pieces for either side. Leela analyses every position.';
    items.push(li);
  }
  state.moves.forEach((m, i) => {
    if (whiteTurn || i === 0) {
      const no = document.createElement('li');
      no.className = 'no';
      no.textContent = num + '.';
      items.push(no);
      if (!whiteTurn) { const gap = document.createElement('li'); gap.className = 'mv'; gap.textContent = '…'; gap.style.cursor = 'default'; items.push(gap); }
    }
    const li = document.createElement('li');
    li.className = 'mv' + (i + 1 === state.cursor ? ' cur' : '');
    li.textContent = m.san;
    li.onclick = () => goTo(i + 1);
    items.push(li);
    if (!whiteTurn) num++;
    whiteTurn = !whiteTurn;
  });
  ol.replaceChildren(...items);
  const cur = ol.querySelector('.cur');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
  else if (state.cursor === 0) ol.scrollTop = 0;

  const over = state.moves.length ? gameOver(positionAt(state.moves.length)) : null;
  const banner = $('banner');
  if (over && atEnd()) {
    let who = '';
    if (over.winner && state.mode === 'play') who = over.winner === state.human ? ' · You win!' : ' · Leela wins';
    else if (over.winner) who = over.winner === 'w' ? ' · White wins' : ' · Black wins';
    banner.textContent = `${over.text}${who} (${over.result})`;
    banner.hidden = false;
  } else banner.hidden = true;

  $('navStart').disabled = $('navBack').disabled = state.cursor === 0;
  $('navFwd').disabled = $('navEnd').disabled = atEnd();
}

function renderPlayers() {
  const lvl = levelById(state.level);
  const name = color => state.mode === 'analysis' ? (color === 'w' ? 'White' : 'Black')
    : color === state.human ? 'You' : `Leela`;
  const tag = color => state.mode === 'play' && color !== state.human ? `<span class="tag">${lvl.name}</span>` : '';
  // material
  const count = { w: {}, b: {} };
  for (const row of view.board()) for (const p of row) if (p) count[p.color][p.type] = (count[p.color][p.type] || 0) + 1;
  const full = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const val = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  let wMat = 0, bMat = 0;
  for (const t in val) { wMat += (count.w[t] || 0) * val[t]; bMat += (count.b[t] || 0) * val[t]; }
  const captured = color => {   // pieces this side has taken
    const them = color === 'w' ? 'b' : 'w';
    let html = '';
    for (const t of ['q', 'r', 'b', 'n', 'p']) {
      const lost = Math.max(0, full[t] - (count[them][t] || 0));
      for (let i = 0; i < lost; i++) html += `<img src="${pieceSrc(them, t)}" alt="">`;
    }
    const adv = color === 'w' ? wMat - bMat : bMat - wMat;
    return `<span class="captured">${html}${adv > 0 ? `<span class="adv">+${adv}</span>` : ''}</span>`;
  };
  const fill = (el, color) => {
    el.innerHTML = `<span class="turn"></span><span>${name(color)}</span>${tag(color)}${captured(color)}`;
    el.classList.toggle('to-move', view.turn() === color && !gameOver(view));
  };
  const bottom = state.flipped ? 'b' : 'w';
  fill($('playerBottom'), bottom);
  fill($('playerTop'), bottom === 'w' ? 'b' : 'w');
}

function renderButtons() {
  const play = state.mode === 'play';
  const leelaThinking = active && active.kind === 'move';
  $('btnHint').hidden = !play;
  $('btnMoveNow').hidden = !play;
  $('btnPlayHere').hidden = play;
  $('btnUndo').disabled = state.moves.length === 0;
  $('btnHint').disabled = !engine.ready || !atEnd() || view.turn() !== state.human || !!gameOver(view) || !!active;
  $('btnMoveNow').disabled = !leelaThinking || !levelById(state.level).limits.timeMs;
  $('btnPlayHere').disabled = !!gameOver(view);
  $('optEval').checked = state.showEval;
  $('optCoords').checked = state.coords;
  document.querySelector('#menu [data-act="analysis"]').textContent = play ? 'Analyse this game' : 'New analysis board';
}

function render() {
  renderBoard();
  renderArrows();
  renderMoves();
  renderPlayers();
  renderEngine();
  renderButtons();
}

// -------------------------------------------------------------- controls
$('navStart').onclick = () => goTo(0);
$('navBack').onclick = () => goTo(state.cursor - 1);
$('navFwd').onclick = () => goTo(state.cursor + 1);
$('navEnd').onclick = () => goTo(state.moves.length);
document.addEventListener('keydown', e => {
  if (e.target.closest('textarea, input, dialog[open]')) return;
  if (e.key === 'ArrowLeft') goTo(state.cursor - 1);
  else if (e.key === 'ArrowRight') goTo(state.cursor + 1);
  else if (e.key === 'Home') goTo(0);
  else if (e.key === 'End') goTo(state.moves.length);
});

function flip() { state.flipped = !state.flipped; save(); render(); }
$('btnFlip').onclick = flip;

$('btnUndo').onclick = () => {
  stopSearch();
  let moves = state.moves.slice();
  if (!moves.length) return;
  if (state.mode === 'play') {
    // Back to the last position where it was your move, taking back at least
    // one move. If Leela has White this can go back to the start.
    let n = moves.length - 1;
    while (n > 0 && positionAt(n).turn() !== state.human) n--;
    moves = moves.slice(0, n);
  } else {
    moves = moves.slice(0, state.cursor > 0 ? state.cursor - 1 : 0);
  }
  state.moves = moves;
  state.cursor = moves.length;
  view = positionAt(state.cursor);
  state.lastEval = null;
  hintArrow = null;
  analysisInfo = null;
  selected = null;
  save();
  render();
  think();
};

$('btnHint').onclick = () => {
  if (!engine.ready) return;
  startSearch('hint', { timeMs: 2500 });
  renderButtons();
};
$('btnMoveNow').onclick = () => { if (active && active.kind === 'move') worker.postMessage({ type: 'stop' }); };
$('btnPlayHere').onclick = () => {
  stopSearch();
  state.moves = state.moves.slice(0, state.cursor);
  state.mode = 'play';
  state.human = view.turn();
  state.flipped = state.human === 'b';
  state.lastEval = null;
  analysisInfo = null;
  save();
  render();
  think();
  toast(`You have ${state.human === 'w' ? 'White' : 'Black'}. Your move.`);
};

// New game dialog
function renderLevels() {
  const box = $('levels');
  const legend = box.querySelector('legend');
  const nps = engine.nps;
  box.replaceChildren(legend, ...LEVELS.map(l => {
    const label = document.createElement('label');
    let est = '';
    if (l.limits.timeMs && nps) est = `≈ ${fmtNodes(Math.round(nps * l.limits.timeMs / 1000))} positions`;
    label.innerHTML = `<input type="radio" name="level" value="${l.id}"><span><b></b><em>${est}</em><small></small></span>`;
    label.querySelector('b').textContent = l.name;
    label.querySelector('small').textContent = l.desc;
    label.querySelector('input').checked = l.id === state.level;
    return label;
  }));
  $('speedNote').textContent = engine.ready
    ? `On this iPad Leela looks at about ${fmtNodes(nps)} positions a second (${engine.backend === 'webgpu' ? 'graphics chip' : 'processor'}). Even a few hundred positions make it very strong.`
    : 'Leela is still loading. You can start now; it plays as soon as it is ready.';
}

$('btnNew').onclick = () => {
  renderLevels();
  $('dlgNew').showModal();
};
$('dlgNew').addEventListener('close', () => {
  if ($('dlgNew').returnValue !== 'start') return;
  const form = $('dlgNew').querySelector('form');
  let color = form.elements.color.value;
  if (color === 'random') color = Math.random() < 0.5 ? 'w' : 'b';
  stopSearch();
  state = { ...defaults(), showEval: state.showEval, coords: state.coords, level: form.elements.level.value || state.level, human: color, flipped: color === 'b' };
  view = positionAt(0);
  hintArrow = null;
  analysisInfo = null;
  selected = null;
  save();
  render();
  think();
});

// Menu
const menu = $('menu');
$('btnMenu').onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
document.addEventListener('pointerdown', e => { if (!menu.hidden && !e.target.closest('#menu, #btnMenu')) menu.hidden = true; });
menu.addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  menu.hidden = true;
  if (act === 'flip') flip();
  else if (act === 'pgn') openPgn();
  else if (act === 'about') {
    $('aboutDevice').textContent = engine.ready
      ? `On this iPad Leela runs on the ${engine.backend === 'webgpu' ? 'graphics chip (WebGPU)' : `processor (${engine.threads} thread${engine.threads > 1 ? 's' : ''})`} at about ${fmtNodes(engine.nps)} positions a second.`
      : '';
    $('dlgAbout').showModal();
  } else if (act === 'analysis') {
    stopSearch();
    if (state.mode === 'play') {
      state.mode = 'analysis';
    } else {
      state = { ...defaults(), mode: 'analysis', showEval: state.showEval, coords: state.coords, level: state.level, flipped: state.flipped };
      view = positionAt(0);
    }
    analysisInfo = null;
    hintArrow = null;
    save();
    render();
    think();
  }
});
$('optEval').onchange = e => { state.showEval = e.target.checked; save(); render(); };
$('optCoords').onchange = e => { state.coords = e.target.checked; save(); renderBoard(); };

// PGN / FEN
function currentPgn() {
  const c = new Chess(state.startFen);
  if (state.startFen !== START_FEN) { c.setHeader('SetUp', '1'); c.setHeader('FEN', state.startFen); }
  for (const m of state.moves) c.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] });
  const lvl = levelById(state.level);
  const d = new Date();
  c.setHeader('Event', state.mode === 'play' ? 'Game against Leela' : 'Analysis');
  c.setHeader('Date', `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`);
  if (state.mode === 'play') {
    const leela = `Leela Chess Zero T1-256x10 (${lvl.name})`;
    c.setHeader('White', state.human === 'w' ? 'You' : leela);
    c.setHeader('Black', state.human === 'b' ? 'You' : leela);
  }
  const over = gameOver(c);
  c.setHeader('Result', over ? over.result : '*');
  return c.pgn({ maxWidth: 80 });
}
function openPgn() {
  $('pgnText').value = currentPgn();
  $('pgnError').hidden = true;
  $('dlgPgn').showModal();
}
$('btnCopyPgn').onclick = async () => {
  try { await navigator.clipboard.writeText($('pgnText').value); toast('Copied'); }
  catch { $('pgnText').select(); document.execCommand('copy'); toast('Copied'); }
};
$('btnSharePgn').onclick = async () => {
  const text = $('pgnText').value;
  if (navigator.share) {
    try { await navigator.share({ title: 'Chess game', text }); } catch { /* cancelled */ }
  } else {
    try { await navigator.clipboard.writeText(text); toast('Sharing is not available here, so the game was copied.'); } catch { /* ignore */ }
  }
};
$('btnLoadPgn').onclick = () => {
  const text = $('pgnText').value.trim();
  const err = $('pgnError');
  err.hidden = true;
  let startFen = START_FEN, moves = [];
  try {
    if (/^[rnbqkpRNBQKP1-8]+(\/[rnbqkpRNBQKP1-8]+){7}\s/.test(text) || /^[rnbqkpRNBQKP1-8]+(\/[rnbqkpRNBQKP1-8]+){7}$/.test(text)) {
      const fen = text.split(/\s+/).length >= 6 ? text : text.split(/\s+/).concat(['w', '-', '-', '0', '1']).slice(0, 6).join(' ');
      const c = new Chess(fen);
      startFen = c.fen();
    } else {
      const c = new Chess();
      c.loadPgn(text);
      const h = c.getHeaders();
      startFen = h.FEN || START_FEN;
      moves = c.history({ verbose: true }).map(m => ({ uci: m.lan, san: m.san }));
    }
  } catch (e) {
    err.textContent = 'That is not a PGN game or a FEN position this app can read. ' + (e && e.message ? `(${e.message})` : '');
    err.hidden = false;
    return;
  }
  stopSearch();
  state = { ...defaults(), mode: 'analysis', startFen, moves, cursor: moves.length, showEval: state.showEval, coords: state.coords, level: state.level, flipped: state.flipped };
  view = positionAt(state.cursor);
  analysisInfo = null;
  hintArrow = null;
  save();
  $('dlgPgn').close();
  render();
  think();
  toast('Loaded on the analysis board');
};

let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// Pause analysis while the app is in the background, to save battery.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.mode === 'analysis') stopSearch();
  else if (!document.hidden) think();
});

// ------------------------------------------------- offline + start-up
// The service worker makes the app work offline and lets the page use
// several processor cores (it marks pages "cross-origin isolated", which
// WebAssembly threads need). A first visit reloads once to get that.
async function boot() {
  render();
  if (!('serviceWorker' in navigator)) { startEngine(); return; }
  let reg = null;
  try { reg = await navigator.serviceWorker.register('sw.js'); } catch { /* still runs online */ }
  const tried = sessionStorage.getItem('leela-isolate');
  if (reg && !self.crossOriginIsolated && !tried) {
    sessionStorage.setItem('leela-isolate', '1');
    if (navigator.serviceWorker.controller) { location.reload(); return; }
    const reload = () => location.reload();
    navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
    // If the worker never takes over, carry on without threads.
    setTimeout(() => { navigator.serviceWorker.removeEventListener('controllerchange', reload); startEngine(); }, 5000);
    return;
  }
  startEngine();
}
boot();
