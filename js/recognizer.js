// recognizer.js — turns a Crossplay screenshot into board + tray state.
//
// Pipeline:
//   1. draw image to canvas, grab ImageData
//   2. calibrate: find the board's square bounding box + cell pitch
//   3. per cell: tile / premium / empty
//   4. tile -> OCR letter + value subscript (template matching)
//   5. detect the tray strip below the board and OCR its tiles
//
// The big lever (per NOTES.md): this is a pixel-perfect digital screenshot, so
// everything is deterministic color/geometry work — no heavy ML.

import * as C from "./calibration.js";
import { normalizeInk } from "./glyphs.js";

// ---- low-level pixel helpers --------------------------------------------

function imageData(image) {
  const cv = document.createElement("canvas");
  cv.width = image.naturalWidth || image.width;
  cv.height = image.naturalHeight || image.height;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  return { data: ctx.getImageData(0, 0, cv.width, cv.height), w: cv.width, h: cv.height };
}

const dist2 = (r, g, b, [R, G, B]) => (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2;
const isTileBlue = (r, g, b) => dist2(r, g, b, C.TILE_RGB) <= C.TILE_DIST ** 2;
function isSaturated(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx - mn >= C.SAT_MIN && mx < C.SAT_MAX_BRIGHT;
}
function hue(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d === 0) return 0;
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return h;
}

// ---- calibration ---------------------------------------------------------

// Find the board's square bounding box by locating the tallest horizontal band
// of "structured" (colored/tile) pixels, separated from header & tray by gaps.
export function calibrate({ data, w, h }) {
  const px = data.data;
  const step = 2;
  const rowFrac = new Float32Array(h);
  for (let y = 0; y < h; y += step) {
    let hits = 0, n = 0;
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4, r = px[i], g = px[i + 1], b = px[i + 2];
      n++;
      if (isTileBlue(r, g, b) || isSaturated(r, g, b)) hits++;
    }
    rowFrac[y] = hits / n;
  }

  // contiguous bands above a low threshold
  const thr = 0.03;
  const bands = [];
  let start = -1;
  for (let y = 0; y < h; y += step) {
    const on = rowFrac[y] > thr;
    if (on && start < 0) start = y;
    if ((!on || y + step >= h) && start >= 0) {
      const end = on ? y : y - step;
      if (end - start > 8) bands.push({ top: start, bottom: end, height: end - start });
      start = -1;
    }
  }
  if (!bands.length) throw new Error("Could not locate the board in this image.");

  // board = tallest band
  bands.sort((a, b) => b.height - a.height);
  const board = bands[0];

  // horizontal extent within the board band
  let left = w, right = 0;
  for (let y = board.top; y <= board.bottom; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4, r = px[i], g = px[i + 1], b = px[i + 2];
      if (isTileBlue(r, g, b) || isSaturated(r, g, b)) {
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }

  // The structured band is inset from the true board edges (top-row labels/tiles
  // don't touch the cell borders). Recover the TRUE horizontal edges from the
  // off-white board cells vs the pure-white page, sampled on mid-board rows —
  // empty cells are off-white too, so this reaches the real left/right edges.
  const isPage = (r, g, b) => r >= C.PAGE_MIN && g >= C.PAGE_MIN && b >= C.PAGE_MIN;
  let tLeft = w, tRight = 0;
  for (let k = 1; k <= 9; k++) {
    const y = Math.round(board.top + ((board.bottom - board.top) * k) / 10);
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (!isPage(px[i], px[i + 1], px[i + 2])) {
        if (x < tLeft) tLeft = x;
        if (x > tRight) tRight = x;
      }
    }
  }
  if (tRight <= tLeft) { tLeft = left; tRight = right; }   // fallback

  // Board is square. Width is the trustworthy dimension (true edges); derive the
  // true top by centering the square around the (inset) structured content band.
  const size = tRight - tLeft;
  const cell = size / C.GRID;
  const contentH = board.bottom - board.top;
  const margin = (size - contentH) / 2;
  const top = Math.round(board.top - margin);

  return {
    left: Math.round(tLeft), top, size: Math.round(size), cell,
    grid: C.GRID,
    bands,                                  // kept for tray detection
    rowFrac, step,
    img: { w, h },
  };
}

// ---- cell sampling -------------------------------------------------------

function cellRect(geo, r, c) {
  return {
    x: geo.left + c * geo.cell,
    y: geo.top + r * geo.cell,
    w: geo.cell,
    h: geo.cell,
  };
}

// Build an ink map (whiteness, 0..1) for a sub-region of the image.
function inkMap(px, w, rx, ry, rw, rh) {
  const W = Math.max(1, Math.round(rw)), H = Math.max(1, Math.round(rh));
  const out = new Float32Array(W * H);
  const x0 = Math.round(rx), y0 = Math.round(ry);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = ((y0 + y) * w + (x0 + x)) * 4;
      const r = px[i];
      out[y * W + x] = Math.min(1, Math.max(0, (r - C.INK_LO) / (C.INK_HI - C.INK_LO)));
    }
  }
  return { data: out, w: W, h: H };
}

function frac(rect, fr) {
  return {
    x: rect.x + rect.w * fr.x0,
    y: rect.y + rect.h * fr.y0,
    w: rect.w * (fr.x1 - fr.x0),
    h: rect.h * (fr.y1 - fr.y0),
  };
}

// Classify a cell as tile / premium / empty.
function classifyCell(px, w, rect) {
  // sample inner region to avoid neighbor bleed
  const inset = 0.12;
  const x0 = Math.round(rect.x + rect.w * inset), x1 = Math.round(rect.x + rect.w * (1 - inset));
  const y0 = Math.round(rect.y + rect.h * inset), y1 = Math.round(rect.y + rect.h * (1 - inset));
  let blue = 0, n = 0, sat = 0, hx = 0, hy = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * w + x) * 4, r = px[i], g = px[i + 1], b = px[i + 2];
      n++;
      if (isTileBlue(r, g, b)) { blue++; continue; }
      if (isSaturated(r, g, b)) {
        sat++;
        const a = (hue(r, g, b) * Math.PI) / 180;
        hx += Math.cos(a); hy += Math.sin(a);
      }
    }
  }
  if (blue / n >= C.TILE_FILL_MIN) return { type: "tile" };
  if (sat >= 8) {
    let deg = (Math.atan2(hy, hx) * 180) / Math.PI; if (deg < 0) deg += 360;
    const premium = nearestPremium(deg);
    if (premium) return { type: "premium", premium };
  }
  return { type: "empty" };
}

function nearestPremium(deg) {
  let best = null, bestD = 1e9;
  for (const [label, h] of Object.entries(C.PREMIUM_HUES)) {
    let d = Math.abs(deg - h); d = Math.min(d, 360 - d);
    if (d < bestD) { bestD = d; best = label; }
  }
  return bestD <= C.PREMIUM_HUE_TOL ? best : null;
}

// ---- OCR -----------------------------------------------------------------

function ocrLetter(px, w, rect, templates) {
  const region = frac(rect, C.LETTER_REGION);
  const ink = inkMap(px, w, region.x, region.y, region.w, region.h);
  const vec = normalizeInk(ink);
  if (!vec) return { letter: "?", score: 0, margin: 0 };
  const m = templates.match(vec, "letter");
  return { letter: m.ch, score: m.score, margin: m.margin };
}

// OCR the value subscript: segment into digit runs, match each.
function ocrValue(px, w, rect, templates) {
  const region = frac(rect, C.VALUE_REGION);
  const ink = inkMap(px, w, region.x, region.y, region.w, region.h);
  const { data, w: W, h: H } = ink;
  // column ink profile
  const col = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    let s = 0; for (let y = 0; y < H; y++) s += data[y * W + x];
    col[x] = s;
  }
  // find runs of inked columns
  const runs = [];
  let s = -1;
  for (let x = 0; x < W; x++) {
    const on = col[x] > 0.6;
    if (on && s < 0) s = x;
    if ((!on || x === W - 1) && s >= 0) { runs.push([s, on ? x : x - 1]); s = -1; }
  }
  if (!runs.length) return { value: null, score: 0 };
  let str = "", minScore = 1;
  for (const [a, b] of runs.slice(0, 2)) {
    const sub = { data: new Float32Array((b - a + 1) * H), w: b - a + 1, h: H };
    for (let y = 0; y < H; y++)
      for (let x = a; x <= b; x++) sub.data[y * sub.w + (x - a)] = data[y * W + x];
    const vec = normalizeInk(sub);
    if (!vec) continue;
    const m = templates.match(vec, "digit");
    str += m.ch; minScore = Math.min(minScore, m.score);
  }
  const value = str === "" ? null : parseInt(str, 10);
  return { value: Number.isNaN(value) ? null : value, score: minScore };
}

// ---- tray ----------------------------------------------------------------

function detectTray(px, w, h, geo, templates) {
  const boardBottom = geo.top + geo.size;
  // find next blue-heavy band below the board
  const step = 2, thr = 0.25;
  let start = -1, band = null;
  for (let y = boardBottom + 4; y < h; y += step) {
    let blue = 0, n = 0;
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      n++; if (isTileBlue(px[i], px[i + 1], px[i + 2])) blue++;
    }
    const on = blue / n > thr;
    if (on && start < 0) start = y;
    if ((!on || y + step >= h) && start >= 0) {
      const end = on ? y : y - step;
      if (end - start > geo.cell * 0.4) { band = { top: start, bottom: end }; break; }
      start = -1;
    }
  }
  if (!band) return [];

  // column blue profile within band -> tile segments
  const colBlue = [];
  for (let x = 0; x < w; x++) {
    let blue = 0, n = 0;
    for (let y = band.top; y <= band.bottom; y += 2) {
      const i = (y * w + x) * 4; n++;
      if (isTileBlue(px[i], px[i + 1], px[i + 2])) blue++;
    }
    colBlue.push(blue / n);
  }
  const segs = [];
  let s = -1;
  for (let x = 0; x < w; x++) {
    const on = colBlue[x] > 0.35;
    if (on && s < 0) s = x;
    if ((!on || x === w - 1) && s >= 0) {
      const e = on ? x : x - 1;
      if (e - s > geo.cell * 0.4) segs.push([s, e]);
      s = -1;
    }
  }

  const tiles = [];
  for (const [a, b] of segs.slice(0, 7)) {
    const rect = { x: a, y: band.top, w: b - a, h: band.bottom - band.top };
    const L = ocrLetter(px, w, rect, templates);
    const V = ocrValue(px, w, rect, templates);
    tiles.push({
      letter: L.letter, value: V.value, blank: V.value === 0,
      rect,
      lowconf: L.score < C.LETTER_MIN_SCORE || L.margin < C.LETTER_MIN_MARGIN,
    });
  }
  return tiles;
}

// ---- top level -----------------------------------------------------------

export function recognize(image, templates) {
  return recognizeImageData(imageData(image), templates);
}

// Pure pipeline over an {data: ImageData-like, w, h} — no DOM, so it can run
// headless (Node) for testing against raw pixel buffers.
export function recognizeImageData(img, templates) {
  const px = img.data.data;
  const geo = calibrate(img);

  const board = [];
  for (let r = 0; r < C.GRID; r++) {
    const row = [];
    for (let c = 0; c < C.GRID; c++) {
      const rect = cellRect(geo, r, c);
      const cls = classifyCell(px, img.w, rect);
      if (cls.type === "tile") {
        const L = ocrLetter(px, img.w, rect, templates);
        const V = ocrValue(px, img.w, rect, templates);
        row.push({
          type: "tile", letter: L.letter, value: V.value, blank: V.value === 0,
          rect,
          lowconf: L.score < C.LETTER_MIN_SCORE || L.margin < C.LETTER_MIN_MARGIN,
          conf: { letter: L.score, margin: L.margin, value: V.score },
        });
      } else if (cls.type === "premium") {
        row.push({ type: "premium", premium: cls.premium, rect });
      } else {
        row.push({ type: "empty", rect });
      }
    }
    board.push(row);
  }

  const tray = detectTray(px, img.w, img.h, geo, templates);
  return { board, tray, geo, img: { w: img.w, h: img.h } };
}

// Capture exact glyph templates from a corrected board (the same screenshot the
// user just fixed). Letters always; values only when a single digit (0–9) so we
// feed one glyph per template. Makes recognition self-improving over time.
export function trainFromState(image, state, templates) {
  const px = imageData(image).data.data;
  const w = state.img.w;
  let trained = 0;
  const learn = (t) => {
    if (!t.rect || !t.letter || t.letter === "?") return;
    const lr = frac(t.rect, C.LETTER_REGION);
    templates.train("letter", t.letter, inkMap(px, w, lr.x, lr.y, lr.w, lr.h));
    if (t.value != null && t.value >= 0 && t.value <= 9) {
      const vr = frac(t.rect, C.VALUE_REGION);
      templates.train("digit", String(t.value), inkMap(px, w, vr.x, vr.y, vr.w, vr.h));
    }
    trained++;
  };
  for (const row of state.board) for (const cell of row) if (cell.type === "tile") learn(cell);
  for (const t of state.tray || []) learn(t);
  templates.persist();
  return trained;
}
