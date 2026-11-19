// Leela Chess Zero in JavaScript: the network's input encoding, its policy
// move table, and Leela's PUCT search with its default settings.
// Ported from Leela Chess Zero (lc0, GPL-3.0): src/neural/encoder.cc and
// src/search/classic/{search.cc,params.cc}.
//
// Positions and moves come from chess.js. For speed the search uses its
// internal move list (_moves / _makeMove), which is fixed by the vendored copy.

import { Chess } from './vendor/chess.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const PLANES = 112;
export const POLICY_SIZE = 1858;

// Leela's defaults (lc0 0.31-0.32, classic search).
export const DEFAULTS = {
  cpuct: 1.745, cpuctBase: 38739, cpuctFactor: 3.894,
  fpuReduction: 0.330,
  policyTemp: 1.359,
  movesLeftMaxEffect: 0.0345, movesLeftThreshold: 0.8, movesLeftSlope: 0.0027,
  movesLeftConstant: 0.0, movesLeftScaled: 1.6521, movesLeftQuadratic: -0.6521,
  twoFoldDraws: true,
  smartPruningFactor: 1.33,
};

// ---------------------------------------------------------------- move table
// The 1858 policy outputs, in Leela's order: for each from-square a1..h8, every
// queen-line and knight destination in square order; then the 66 promotions to
// queen/rook/bishop. A knight promotion uses the plain move's index.
const MOVE_INDEX = new Int16Array(64 * 64 * 4).fill(-1);
export const MOVE_STRS = [];
{
  const name = s => 'abcdefgh'[s & 7] + (1 + (s >> 3));
  for (let from = 0; from < 64; from++) {
    for (let to = 0; to < 64; to++) {
      if (to === from) continue;
      const dr = (to >> 3) - (from >> 3), df = (to & 7) - (from & 7);
      const line = dr === 0 || df === 0 || Math.abs(dr) === Math.abs(df);
      const knight = Math.abs(dr * df) === 2;
      if (!line && !knight) continue;
      MOVE_INDEX[from * 64 + to] = MOVE_STRS.length;
      MOVE_STRS.push(name(from) + name(to));
    }
  }
  const PROMO = { q: 1, r: 2, b: 3 };
  for (let f = 0; f < 8; f++) {
    const from = 48 + f;
    for (let tf = f - 1; tf <= f + 1; tf++) {
      if (tf < 0 || tf > 7) continue;
      const to = 56 + tf;
      for (const p of 'qrb') {
        MOVE_INDEX[PROMO[p] * 4096 + from * 64 + to] = MOVE_STRS.length;
        MOVE_STRS.push(name(from) + name(to) + p);
      }
    }
  }
  if (MOVE_STRS.length !== POLICY_SIZE) throw new Error('policy table size ' + MOVE_STRS.length);
}

// chess.js squares are 0x88 (a8 = 0, h1 = 0x77). Leela's are a1 = 0 .. h8 = 63.
const sq64 = s => ((7 - (s >> 4)) << 3) | (s & 7);
const BITS_KSIDE = 32, BITS_QSIDE = 64;
const PROMO_CODE = { n: 0, q: 1, r: 2, b: 3 };

// Policy index of a chess.js internal move, seen from the side to move.
// Castling is encoded as the king taking its own rook (e1h1 / e1a1).
function policyIndex(m, black) {
  let from = sq64(m.from), to = sq64(m.to);
  if (m.flags & BITS_KSIDE) to = (from & 56) | 7;
  else if (m.flags & BITS_QSIDE) to = from & 56;
  if (black) { from ^= 56; to ^= 56; }
  const promo = m.promotion ? PROMO_CODE[m.promotion] : 0;
  return MOVE_INDEX[promo * 4096 + from * 64 + to];
}

// ------------------------------------------------------------------ positions
// A compact record of one position, enough to encode it and spot repetitions.
const PIECE_CODE = { P: 1, N: 2, B: 3, R: 4, Q: 5, K: 6, p: -1, n: -2, b: -3, r: -4, q: -5, k: -6 };
const START_KEY = START_FEN.split(' ').slice(0, 4).join(' ');

export function makeRecord(fen, prev) {
  // prev: function(i) returning the record i plies back (1 = previous), or null.
  const f = fen.split(' ');
  const pieces = new Int8Array(64);
  let rank = 7, file = 0;
  for (const c of f[0]) {
    if (c === '/') { rank--; file = 0; }
    else if (c >= '1' && c <= '8') file += +c;
    else pieces[rank * 8 + file++] = PIECE_CODE[c];
  }
  const rec = {
    key: f.slice(0, 4).join(' '),
    pieces,
    black: f[1] === 'b',
    castle: f[2],
    ep: f[3] === '-' ? -1 : (f[3].charCodeAt(0) - 97) + (+f[3][1] - 1) * 8,
    rule50: +f[4] || 0,
    reps: 0,
    sincePrevRep: 0,
  };
  // Repetitions can only reach back to the last capture or pawn move.
  if (prev) {
    for (let i = 2; i <= rec.rule50; i += 2) {
      const r = prev(i);
      if (!r) break;
      if (r.key === rec.key) {
        if (!rec.sincePrevRep) rec.sincePrevRep = i;
        rec.reps = r.reps + 1;
        break;
      }
    }
  }
  return rec;
}

// Fill 112x8x8 planes at out[offset..] for the position history ending with
// hist[0] (hist[i] = i plies back). startpos: the game began at the standard
// starting position (Leela's history-fill = fen_only).
export function encode(hist, out, offset) {
  out.fill(0, offset, offset + PLANES * 64);
  const cur = hist[0];
  const black = cur.black;
  const setAll = (p, v = 1) => out.fill(v, offset + p * 64, offset + p * 64 + 64);
  for (let i = 0; i < 8; i++) {
    let rec = hist[i];
    if (!rec) {
      const first = hist[hist.length - 1];
      if (first.key === START_KEY) break;
      rec = undoDoublePush(first);
    }
    const base = offset + i * 13 * 64;
    const p = rec.pieces;
    for (let sq = 0; sq < 64; sq++) {
      const v = p[sq];
      if (!v) continue;
      const ours = (v > 0) !== black;
      const plane = (ours ? 0 : 6) + Math.abs(v) - 1;
      out[base + plane * 64 + (black ? sq ^ 56 : sq)] = 1;
    }
    if (rec.reps >= 1) out.fill(1, base + 12 * 64, base + 13 * 64);
  }
  const c = cur.castle;
  const [weK, weQ, theyK, theyQ] = black ? ['k', 'q', 'K', 'Q'] : ['K', 'Q', 'k', 'q'];
  if (c.includes(weQ)) setAll(104);
  if (c.includes(weK)) setAll(105);
  if (c.includes(theyQ)) setAll(106);
  if (c.includes(theyK)) setAll(107);
  if (black) setAll(108);
  setAll(109, cur.rule50);
  setAll(111);
}

// Leela pads missing history at a set-up position with copies of it, taking
// back a just-played double pawn push when the en passant square shows one.
function undoDoublePush(rec) {
  if (rec.ep < 0 || rec._undone) return rec._undone || rec;
  const pieces = rec.pieces.slice();
  const moverWhite = rec.black; // the side that just moved
  const now = rec.ep + (moverWhite ? 8 : -8);
  const was = rec.ep + (moverWhite ? -8 : 8);
  pieces[was] = pieces[now];
  pieces[now] = 0;
  rec._undone = { ...rec, pieces };
  return rec._undone;
}

// ---------------------------------------------------------------------- search
class Node {
  constructor(parent, idx, prior) {
    this.parent = parent;
    this.idx = idx;            // index into parent's edge arrays
    this.p = prior;
    this.n = 0;                // completed visits
    this.inflight = 0;
    this.wl = 0;               // sum of W-L, for the player who moved into this node
    this.d = 0;                // sum of draw probabilities
    this.m = 0;                // sum of moves-left estimates
    this.fen = null;
    this.rec = null;
    this.moves = null;         // legal moves (chess.js internal) once expanded
    this.priors = null;        // Float32Array, sorted high to low
    this.kids = null;          // child Nodes, created on first visit
    this.terminal = false;
    this.proven = null;        // +1 / 0 / -1 for the player who moved into this node
    this.plies = 0;            // once proven: plies until the game ends with best play
  }
}

// Leela's centipawn scale: 90 * tan(1.5637541897 * Q).
export function qToCp(q) {
  const cp = Math.round(90 * Math.tan(1.5637541897 * Math.max(-0.99999, Math.min(0.99999, q))));
  return Math.max(-12800, Math.min(12800, cp));
}

export class Search {
  // evaluate(planes Float32Array, count) -> Promise<{policy, wdl, mlh}>, flat arrays.
  constructor(evaluate, opts = {}) {
    this.evaluate = evaluate;
    this.params = { ...DEFAULTS, ...opts };
    this.chess = new Chess();
    this.cache = new Map();
    this.cacheLimit = opts.cacheLimit || 200000;
    this.root = null;
    this.gameRecs = [];
    this.stopFlag = false;
  }

  // Set the game: starting FEN and the moves played (UCI strings). Reuses the
  // existing tree when the new position follows from the old root.
  setPosition(startFen, uciMoves) {
    const chess = this.chess;
    chess.load(startFen || START_FEN);
    const recs = [];
    const back = i => recs[recs.length - i] || null;
    const fens = [chess.fen()];
    recs.push(makeRecord(fens[0], null));
    for (const u of uciMoves) {
      const mv = chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      if (!mv) throw new Error('illegal move ' + u);
      const fen = chess.fen();
      fens.push(fen);
      recs.push(makeRecord(fen, back));
    }
    const rootFen = fens[fens.length - 1];
    const start = startFen || START_FEN;
    // Tree reuse: walk down from the old root along the newly played moves.
    let reuse = null;
    const old = this.rootGame;
    if (this.root && old && old.start === start && uciMoves.length >= old.moves.length &&
        old.moves.every((u, i) => uciMoves[i] === u)) {
      let node = this.root;
      for (const u of uciMoves.slice(old.moves.length)) {
        if (!node || !node.moves) { node = null; break; }
        const i = node.moves.findIndex(m => uciOf(m) === u);
        node = i >= 0 ? node.kids[i] : null;
      }
      if (node && node.fen === rootFen && node.moves) reuse = node;
    }
    this.gameRecs = recs.slice(0, -1);
    this.rootGame = { start, moves: uciMoves.slice() };
    if (reuse) {
      reuse.parent = null;
      this.root = reuse;
      this.root.rec = recs[recs.length - 1];
    } else {
      this.root = new Node(null, -1, 1);
      this.root.fen = rootFen;
      this.root.rec = recs[recs.length - 1];
    }
  }

  // History records, newest first, for a node whose rec is set.
  history(node, count = 8) {
    const out = [];
    let n = node;
    while (n && out.length < count) { out.push(n.rec); n = n.parent; }
    for (let i = this.gameRecs.length - 1; i >= 0 && out.length < count; i--) out.push(this.gameRecs[i]);
    return out;
  }

  // Record lookup i plies back from a node (for repetition detection).
  backFrom(node) {
    return i => {
      let n = node;
      let k = i;
      while (n && k > 0) { n = n.parent; k--; }
      if (n) return n.rec;
      // Walked past the root: continue into the game's earlier positions.
      let depth = 0;
      for (let x = node; x && x.parent; x = x.parent) depth++;
      const j = this.gameRecs.length - (i - depth);
      return j >= 0 && j < this.gameRecs.length ? this.gameRecs[j] : null;
    };
  }

  // Run until a limit is hit or stop() is called.
  // limits: { nodes, timeMs, infinite }, onInfo(info) called every ~reportMs.
  async run({ nodes = Infinity, timeMs = Infinity, infinite = false, batch = 8, reportMs = 250, onInfo } = {}) {
    this.stopFlag = false;
    const root = this.root;
    const t0 = performance.now();
    const n0 = root.n;
    let lastReport = t0, lastYield = t0;
    const maxNodes = infinite ? 2_000_000 : nodes;
    const deadline = infinite ? Infinity : t0 + timeMs;

    while (!this.stopFlag) {
      if (root.n - n0 >= maxNodes && root.n > 0) break;
      if (performance.now() >= deadline && root.n > 0) break;
      if (root.proven !== null && root.n > 0) break;
      // Leela plays a forced move at once.
      if (!infinite && root.moves && root.moves.length === 1) break;
      if (!infinite && root.n > 0 && this.smartPruned(t0, n0, deadline, maxNodes)) break;
      const size = root.n === 0 ? 1 : batch;
      await this.step(size);
      const now = performance.now();
      // Let messages (stop, new position) in: a CPU backend can finish whole
      // steps without ever giving the event loop a turn.
      if (now - lastYield > 30) { lastYield = now; await new Promise(r => setTimeout(r, 0)); }
      if (onInfo && now - lastReport >= reportMs) {
        lastReport = now;
        onInfo(this.info(t0, n0));
      }
    }
    const info = this.info(t0, n0);
    if (onInfo) onInfo(info);
    return info;
  }

  stop() { this.stopFlag = true; }

  // Stop early once the best move cannot be overtaken in the time left.
  smartPruned(t0, n0, deadline, maxNodes) {
    const kids = this.root.kids;
    if (!kids) return false;
    const now = performance.now();
    const elapsed = now - t0, done = this.root.n - n0;
    if (done < 50 || elapsed < 100) return false;
    let remaining = maxNodes - done;
    if (deadline !== Infinity) remaining = Math.min(remaining, (deadline - now) * done / elapsed);
    let a = 0, b = 0;
    for (const k of kids) if (k) { const v = k.n; if (v > a) { b = a; a = v; } else if (v > b) b = v; }
    return remaining < Infinity && a - b > remaining / this.params.smartPruningFactor;
  }

  // Gather up to `size` leaves, evaluate them together, back the results up.
  async step(size) {
    const pending = [];
    let collisions = 0, tries = 0;
    while (pending.length < size && collisions < size && tries++ < size * 4) {
      const leaf = this.selectLeaf();
      if (!leaf) { collisions++; continue; }
      if (leaf.done) continue;           // terminal or cached: already backed up
      pending.push(leaf);
    }
    if (!pending.length) return;
    const planes = new Float32Array(pending.length * PLANES * 64);
    pending.forEach((l, i) => encode(l.hist, planes, i * PLANES * 64));
    const out = await this.evaluate(planes, pending.length);
    pending.forEach((l, i) => {
      const w = out.wdl[i * 3], d = out.wdl[i * 3 + 1], lo = out.wdl[i * 3 + 2];
      const logits = new Float32Array(l.legal.length);
      for (let j = 0; j < l.legal.length; j++) logits[j] = out.policy[i * POLICY_SIZE + l.idx[j]];
      const res = { wl: w - lo, d, m: out.mlh ? out.mlh[i] : 0, logits };
      this.cachePut(l.node.rec.key, res);
      this.expand(l.node, l.legal, res.logits);
      this.backup(l.node, -res.wl, res.d, res.m, true);
    });
  }

  cachePut(key, res) {
    if (this.cache.size >= this.cacheLimit) {
      // Drop the oldest quarter.
      let n = this.cacheLimit >> 2;
      for (const k of this.cache.keys()) { this.cache.delete(k); if (--n <= 0) break; }
    }
    this.cache.set(key, res);
  }

  // Walk from the root to a leaf. Returns {done:true} if the leaf was handled
  // at once (terminal position or cache hit), a pending leaf to evaluate, or
  // null on a collision with a leaf already waiting for the network.
  selectLeaf() {
    const P = this.params;
    let node = this.root;
    let depth = 0;
    const path = [node];
    // Solved positions are treated like finished games: their value is exact.
    while (node.moves && !node.terminal && (node.proven === null || node === this.root)) {
      // pick the child with the best Q + U + M
      const n = node.n;
      const cpuct = P.cpuct + P.cpuctFactor * Math.log((n + P.cpuctBase) / P.cpuctBase);
      const puctMult = cpuct * Math.sqrt(Math.max(n - 1, 1));
      const parentQ = n ? -node.wl / n : 0;          // for the side to move here
      let visitedPolicy = 0;
      const kids = node.kids;
      for (let i = 0; i < kids.length; i++) if (kids[i] && kids[i].n > 0) visitedPolicy += node.priors[i];
      const fpu = parentQ - P.fpuReduction * Math.sqrt(visitedPolicy);
      const parentM = n ? node.m / n : 0;
      const mOn = Math.abs(parentQ) > P.movesLeftThreshold;
      let best = -1, bestScore = -Infinity;
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i];
        const cn = c ? c.n : 0;
        let q = cn > 0 ? c.wl / cn : fpu;
        if (c && c.proven !== null) q = c.proven;
        let score = q + puctMult * node.priors[i] / (1 + cn + (c ? c.inflight : 0));
        if (mOn && cn > 0) {
          let mu = Math.max(-P.movesLeftMaxEffect, Math.min(P.movesLeftMaxEffect,
            P.movesLeftSlope * (c.m / cn - parentM)));
          mu *= q > 0 ? -1 : q < 0 ? 1 : 0;
          const aq = Math.max(0, Math.abs(q) - P.movesLeftThreshold) / (1 - P.movesLeftThreshold);
          mu *= P.movesLeftConstant + P.movesLeftScaled * aq + P.movesLeftQuadratic * aq * aq;
          score += mu;
        }
        if (score > bestScore) { bestScore = score; best = i; }
      }
      let child = kids[best];
      if (!child) child = kids[best] = new Node(node, best, node.priors[best]);
      node = child;
      depth++;
      path.push(node);
    }

    if (node.terminal || (node.proven !== null && node !== this.root)) {
      this.backup(node, node.proven, node.proven === 0 ? 1 : 0, node.plies, false);
      return { done: true };
    }
    if (node.inflight > 0) return null;  // already waiting for the network

    // Make the position for this leaf.
    const chess = this.chess;
    if (!node.fen) {
      chess.load(node.parent.fen, { skipValidation: true });
      const m = node.parent.moves[node.idx];
      chess['_makeMove'](m);
      node.fen = chess.fen();
    } else {
      chess.load(node.fen, { skipValidation: true });
    }
    if (!node.rec) node.rec = makeRecord(node.fen, this.backFrom(node));
    const rec = node.rec;
    const legal = chess['_moves']({ legal: true });

    // Game over?
    let result = null;
    if (legal.length === 0) result = chess.inCheck() ? 1 : 0;   // mate: the mover won
    else if (node !== this.root) {
      if (rec.rule50 >= 100 || chess.isInsufficientMaterial() || rec.reps >= 2) result = 0;
      else if (P.twoFoldDraws && rec.reps >= 1 && rec.sincePrevRep <= depth) result = 0;
    }
    if (result !== null && node !== this.root) {
      node.terminal = true;
      node.proven = result;
      node.moves = null;
      this.backup(node, result, result === 0 ? 1 : 0, 0, false);
      this.propagateProof(node.parent);
      return { done: true };
    }
    if (legal.length === 0) {           // root position is already over
      node.terminal = true;
      node.proven = result;
      return { done: true };
    }

    const cached = this.cache.get(rec.key);
    if (cached && cached.logits.length === legal.length) {
      this.expand(node, legal, cached.logits);
      this.backup(node, -cached.wl, cached.d, cached.m, false);
      return { done: true };
    }

    for (const p of path) p.inflight++;
    const idx = legal.map(m => policyIndex(m, rec.black));
    return { node, legal, idx, hist: this.history(node) };
  }

  expand(node, legal, logits) {
    const T = this.params.policyTemp;
    let max = -Infinity;
    for (const l of logits) if (l > max) max = l;
    const pr = Array.from(logits, l => Math.exp((l - max) / T));
    const sum = pr.reduce((a, b) => a + b, 0);
    const order = pr.map((p, i) => i).sort((a, b) => pr[b] - pr[a]);
    node.moves = order.map(i => legal[i]);
    node.priors = Float32Array.from(order, i => pr[i] / sum);
    node.kids = new Array(legal.length).fill(null);
  }

  // value: W-L for the player who moved into `node`.
  backup(node, value, draw, movesLeft, wasInflight) {
    let v = value, m = movesLeft;
    for (let n = node; n; n = n.parent) {
      n.n++;
      n.wl += v;
      n.d += draw;
      n.m += m;
      if (wasInflight) n.inflight--;
      v = -v;
      m += 1;
    }
  }

  // A child that wins proves its parent lost; all children proven proves the
  // parent. Also tracks how many plies the solved result takes (for mate counts):
  // the winner takes the quickest win, the loser the longest defence.
  propagateProof(node) {
    while (node && node.kids) {
      let all = true, bestChild = -2, winPlies = Infinity, losePlies = 0;
      for (let i = 0; i < node.kids.length; i++) {
        const c = node.kids[i];
        if (!c || c.proven === null) { all = false; continue; }
        if (c.proven > bestChild) bestChild = c.proven;
        if (c.proven === 1) winPlies = Math.min(winPlies, c.plies + 1);
        losePlies = Math.max(losePlies, c.plies + 1);
      }
      let proven = null, plies = 0;
      if (bestChild === 1) { proven = -1; plies = winPlies; }
      else if (all) { proven = -bestChild; plies = proven === 1 ? losePlies : 0; }
      if (proven === null || (node.proven === proven && node.plies === plies)) return;
      node.proven = proven;
      node.plies = plies;
      node = node.parent;
    }
  }

  // ---------------------------------------------------------------- results
  rankedChildren(node = this.root) {
    if (!node.kids) return [];
    const out = [];
    node.kids.forEach((c, i) => out.push({ c, i, n: c ? c.n : 0 }));
    const val = x => (x.c && x.c.proven !== null ? x.c.proven : x.c && x.c.n ? x.c.wl / x.c.n : -2);
    out.sort((a, b) => {
      // proven wins first (fastest mate), proven losses last
      const pa = a.c && a.c.proven, pb = b.c && b.c.proven;
      if (pa === 1 || pb === 1) {
        if (pa === 1 && pb === 1) return a.c.plies - b.c.plies;
        return pa === 1 ? -1 : 1;
      }
      if (pa === -1 && pb === -1) return b.c.plies - a.c.plies;
      if (pa === -1 && pb !== -1 && b.n > 0) return 1;
      if (pb === -1 && pa !== -1 && a.n > 0) return -1;
      return b.n - a.n || val(b) - val(a) || node.priors[b.i] - node.priors[a.i];
    });
    return out;
  }

  pv(node, maxLen = 12) {
    const out = [];
    let n = node;
    while (n && out.length < maxLen) {
      out.push(uciOf(n.parent.moves[n.idx]));
      const r = this.rankedChildren(n);
      if (!r.length || !r[0].c || r[0].n === 0) break;
      n = r[0].c;
    }
    return out;
  }

  info(t0, n0, lines = 5) {
    const root = this.root;
    const ms = Math.max(1, performance.now() - t0);
    const ranked = this.rankedChildren();
    const out = [];
    for (const r of ranked.slice(0, lines)) {
      const c = r.c;
      if (!c || c.n === 0) continue;
      const q = c.proven !== null ? c.proven : c.wl / c.n;
      const d = c.proven !== null ? (c.proven === 0 ? 1 : 0) : c.d / c.n;
      out.push({
        uci: uciOf(root.moves[r.i]),
        pv: this.pv(c),
        n: c.n,
        q, d,
        w: Math.max(0, (1 + q - d) / 2), l: Math.max(0, (1 - q - d) / 2),
        cp: qToCp(q),
        // Moves to mate: positive when the side to move mates, negative when it is mated.
        mate: c.proven === 1 ? c.plies / 2 + 1 : c.proven === -1 ? -(c.plies + 1) / 2 : 0,
        prior: root.priors[r.i],
      });
    }
    const total = root.n;
    return {
      nodes: total,
      searched: total - n0,
      nps: Math.round((total - n0) * 1000 / ms),
      ms: Math.round(ms),
      lines: out,
      best: out.length ? out[0].uci : (root.moves && root.moves.length ? uciOf(root.moves[0]) : null),
      rootProven: root.proven,
    };
  }

  // Sample a move from the network's policy (for the relaxed level).
  samplePolicy(temperature, minShare = 0.1) {
    const root = this.root;
    if (!root.moves) return null;
    const pr = Array.from(root.priors, p => Math.pow(p, 1 / temperature));
    const top = pr[0];
    const keep = pr.map(p => (p >= top * minShare ? p : 0));
    const sum = keep.reduce((a, b) => a + b, 0);
    let r = Math.random() * sum;
    for (let i = 0; i < keep.length; i++) { r -= keep[i]; if (r <= 0) return uciOf(root.moves[i]); }
    return uciOf(root.moves[0]);
  }
}

export function uciOf(m) {
  const sq = s => 'abcdefgh'[s & 7] + (8 - (s >> 4));
  return sq(m.from) + sq(m.to) + (m.promotion || '');
}

export { policyIndex as _policyIndex };
