# Leela Chess

Play chess against **Leela Chess Zero** on the iPad, or analyse positions with it. Everything runs on the iPad and works offline after the first launch.

Live at **https://metroutes-blip.github.io/meter-read-entry/chess/** (the `chess/` folder of this repo, published with LVB once it is on `main`). Open it in Safari and choose **Share › Add to Home Screen**.

The first launch downloads about 70 MB (Leela's network and the engine runtime), so use Wi-Fi. After that it starts in a few seconds, also offline.

## Playing like Leela
This isn't an imitation of Leela: it is Leela's own network and Leela's own search, ported to run in Safari.

- **Network:** `T1-256x10` (`model/t1-256x10.onnx`), a 10-layer transformer distilled from Leela's large networks. It is the official Leela network `t1-256x10-distilled-swa-2432500`, converted to ONNX by Lc0's own converter (Lc0 0.31.2, from `lczerolens/t1-256x10-distilled-swa-2432500` on Hugging Face). Its weights are stored as 16-bit numbers to halve the download; it computes in 32-bit, and its outputs differ from the original by less than 0.01.
- **Input encoding and move table** (`lc0.js`): ported from Lc0's `src/neural/encoder.cc` (classic 112-plane input, 8 positions of history, castling as king-takes-rook). The generated 1858-move table matches Lc0's exactly.
- **Search** (`lc0.js`): Leela's PUCT search with Lc0's default settings: cpuct 1.745 (base 38739, factor 3.894), first-play urgency reduction 0.33, policy temperature 1.359, moves-left utility, two-fold repetitions scored as draws, smart pruning, tree reuse between moves, a position cache, and solved-position (mate) propagation. Scores use Lc0's centipawn scale, 90 × tan(1.5637541897 × Q).

The engine uses the iPad's graphics chip (WebGPU) when Safari offers it, otherwise several processor cores (WebAssembly threads). It checks the results on the starting position before using either.

## Features
- **New game:** play White, Black or random, at one of six strengths, from *Relaxed* (network instinct with some variety) to *Full* (30 s of search per move).
- **Take back**, **Hint** (Leela suggests your move), **Move now** (Leela plays its best move so far), **Flip**.
- Leela's evaluation (pawn score, win/draw/loss chances and the line it expects) can be shown or hidden during games (menu › *Show Leela's evaluation in games*).
- **Analysis board:** move both sides; Leela analyses each position continuously and shows its top three lines with arrows. Tap a line to play its first move. **Play Leela from here** turns any position into a game.
- **Copy or load a game:** copy or share the game as PGN; paste a PGN or FEN to analyse it.
- The current game is kept on the iPad between launches.

## Files
- `index.html`, `styles.css`, `app.js`: the app (board, game, panels).
- `lc0.js`: Leela's encoding, move table and search.
- `engine-worker.js`: runs the network and search in a background thread.
- `sw.js`: offline cache, plus the headers that let Leela use several processor cores (GitHub Pages can't send them itself). The network and runtime are cached separately (`leela-chess-big-v1`) so app updates don't download them again; to replace one, give the file a new name.
- `model/`: the network. `vendor/`: ONNX Runtime Web 1.31.1 (`ort.webgpu` build) and chess.js 1.4.0. `pieces/`: piece images.

## Credits
Leela Chess Zero and its networks: the LCZero authors (GPL-3.0). ONNX Runtime: Microsoft (MIT). chess.js: Jeff Hlywa (BSD-2-Clause). Pieces: Colin M.L. Burnett (CC BY-SA 3.0).
