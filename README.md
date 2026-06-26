# crossplay-helper

A lightweight, mobile-first, **fully client-side** web app that reads a screenshot of an
NYT Crossplay game and reconstructs the board + tray state, as the first step toward
finding optimal plays. Designed to be hosted on GitHub Pages — no backend, no build step.

See [`NOTES.md`](NOTES.md) for the full design rationale and roadmap.

## Status

- ✅ **Board recognizer** — screenshot → board + tray state, runs entirely in-browser:
  - auto-calibrates board geometry robustly across screenshots — board size/position
    and page tint vary, so it locates the board by a gap-merged band of *colored*
    (saturation-based) pixels and sizes the square from the reliable vertical extent
  - classifies every cell as tile / empty / premium (`3L`/`2L`/`3W`/`2W`, by color)
  - OCRs each tile's letter (largest connected ink blob → tolerant to a few px of
    drift) via template matching against a glyph set baked from a real screenshot
    (Crossplay uses a fixed digital font); the point value comes from a fixed
    letter→value table (`LETTER_VALUES`), since the tiny value superscript OCRs
    unreliably — the superscript is read only to detect blanks (a letter showing 0)
  - detects the tray tiles
  - verified on four different boards (`examples/`): full, mid-game, and near-empty —
    all letters / values / trays correct, including blanks
- ✅ **Correction UI** — tappable board + tray; low-confidence cells are highlighted so
  you can fix any misread.
- ✅ **Move engine** — runs in a Web Worker, off the main thread:
  - minimized **DAWG** of ~196k words (Daciuk incremental minimization), ~0.9 MB,
    built in ~120 ms
  - **Appel & Jacobs** anchor + cross-check move generation, across + transposed
  - **scoring from the per-tile point values read off the screenshot** (Crossplay's
    values are non-standard, so no hardcoded table) — main word + cross words + bingo
    (+50, the confirmed Crossplay bonus)
  - finds every legal play on a full board in **single-digit milliseconds**
  - "Find best plays" lists the top plays; tapping one highlights it on the board.
  - **Dictionary is the real Crossplay lexicon** (`assets/words.txt`, 196,419 words):
    NWL2023 minus the 182 (mostly trademark) words NYT removed. See
    [`tools/build-wordlist.sh`](tools/build-wordlist.sh) for how it's derived. NWL2023
    is NASPA's copyrighted list; it's shipped here for convenience — swap in your own
    `words.txt` if you'd rather.
- ✅ **Rack-leave equity** — ranks plays by *equity* = score + the value of the tiles you
  keep, not just raw points (a transparent heuristic placeholder in `js/engine/leave.js`:
  blank/S bonuses, vowel-consonant balance, duplicate and Q-without-U penalties; swap for
  a Crossplay-calibrated table later). A **Best-overall / Most-points toggle** lets you
  pick the ranking; each play shows its leave and equity.
- ✅ **Defensive/blocking heuristic** (`js/engine/defense.js`) — equity also *subtracts* a
  static danger penalty for premium squares a play newly opens for the opponent (a high
  tile left beside an empty 3W is a gift). Plays that hand over a premium show a red
  "⚠ opens 3W" note and drop in the ranking. Weights are a rough first pass, easy to tune.
- ⬜ **Move quality** (next, optional) — Monte-Carlo "deep analysis": simulate opponent
  replies to score the top candidates empirically (augments the static blocking above).

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
js/engine/leave.js      rack-leave equity heuristic
js/engine/defense.js    defensive/blocking penalty (premiums opened for the opponent)
js/engine/worker.js     Web Worker: builds the dictionary, answers solve requests
assets/words.txt        Crossplay lexicon (NWL2023 minus NYT's 182 removed words)
tools/build-wordlist.sh         dev: regenerate assets/words.txt from NWL2023
tools/generate-templates.html   dev: regenerate the baked glyph templates
tools/stress-test.html          dev: run the recognizer over every examples/ screenshot
examples/                sample in-game screenshots (example0.png used for calibration)
```

Open `index.html#solve` to auto-load the sample and immediately solve it.
