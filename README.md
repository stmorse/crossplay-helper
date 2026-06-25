# crossplay-helper

A lightweight, mobile-first, **fully client-side** web app that reads a screenshot of an
NYT Crossplay game and reconstructs the board + tray state, as the first step toward
finding optimal plays. Designed to be hosted on GitHub Pages — no backend, no build step.

See [`NOTES.md`](NOTES.md) for the full design rationale and roadmap.

## Status

- ✅ **Board recognizer** — screenshot → board + tray state, runs entirely in-browser:
  - auto-calibrates the board geometry (resolution-independent)
  - classifies every cell as tile / empty / premium (`3L`/`2L`/`3W`/`2W`, by color)
  - OCRs each tile's letter **and** point value via template matching against a glyph
    set baked from a real screenshot (Crossplay uses a fixed digital font)
  - detects the tray tiles
  - on `example.png`: **100% letters / values / tray** out of the box
- ✅ **Correction UI** — tappable board + tray; low-confidence cells are highlighted so
  you can fix any misread. "Improve accuracy" learns the font from your corrections
  (stored in `localStorage`) for even better future reads.
- ✅ **Move engine** — runs in a Web Worker, off the main thread:
  - minimized **DAWG** of ~168k words (Daciuk incremental minimization), ~0.8 MB,
    built in ~100 ms
  - **Appel & Jacobs** anchor + cross-check move generation, across + transposed
  - **scoring from the per-tile point values read off the screenshot** (Crossplay's
    values are non-standard, so no hardcoded table) — main word + cross words + bingo
  - finds every legal play on a full board in **single-digit milliseconds**
  - "Find best plays" lists the top plays by score; tapping one highlights it on the
    board. Placeholder dictionary is ENABLE (`assets/words.txt`); swap for the real
    Crossplay list later.
- ⬜ **Move quality** (next) — rack-leave equity, then blocking/defense heuristics, then
  optional Monte-Carlo simulation. Currently ranks by raw score only.

## Run locally

ES modules require a server (not `file://`):

```sh
python3 -m http.server 8000
# then open http://localhost:8000/  (or .../#example to auto-load the sample)
```

## Layout

```
index.html              app shell (dark, mobile-first)
css/style.css
js/app.js               upload -> recognize -> correction UI wiring
js/recognizer.js        calibration, cell classification, OCR, tray, training
js/glyphs.js            template-matching OCR (normalize + NCC), template store
js/calibration.js       tunable constants (geometry, colors, regions)
js/templates-data.js    glyph templates baked from a real screenshot
js/ui.js                board/tray rendering + cell editor + plays list + overlay
js/engine/dawg.js       minimized DAWG (build + compact traversal)
js/engine/movegen.js    move generation + scoring (Appel & Jacobs)
js/engine/worker.js     Web Worker: builds the dictionary, answers solve requests
assets/words.txt        placeholder dictionary (ENABLE, public domain)
tools/                  dev utility to regenerate the baked templates
example.png             sample in-game screenshot used for calibration/tests
```

Open `index.html#solve` to auto-load the sample and immediately solve it.
