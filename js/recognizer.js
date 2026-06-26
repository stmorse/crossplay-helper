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

// Group a boolean-ish profile into bands of "on" runs, merging gaps shorter than
// `maxGap` so that sparse boards (rows/cols with no premium label) stay intact.
function bandsFromProfile(frac, n, thr, maxGap) {
  const bands = [];
  let start = -1, gap = 0;
  for (let i = 0; i < n; i++) {
    if (frac[i] > thr) { if (start < 0) start = i; gap = 0; }
    else if (start >= 0) {
      if (++gap > maxGap) { bands.push({ start, end: i - gap, len: i - gap - start }); start = -1; }
    }
  }
  if (start >= 0) bands.push({ start, end: n - 1, len: n - 1 - start });
  return bands;
}

// Find the board's square bounding box. The board is the tallest run of rows
// containing "colored" pixels (tiles or premium labels). Colored is measured by
// saturation, NOT by an absolute white threshold, so it's robust to the page
// being pure white or slightly tinted, and to the board's size/position varying
// between screenshots. Small internal gaps (empty rows/cols) are bridged.
export function calibrate({ data, w, h }) {
  const px = data.data;
  const step = 2;
  const colored = (i) => isTileBlue(px[i], px[i + 1], px[i + 2]) || isSaturated(px[i], px[i + 1], px[i + 2]);

  const rowFrac = new Float32Array(h);
  for (let y = 0; y < h; y += step) {
    let hits = 0, n = 0;
    for (let x = 0; x < w; x += step) { n++; if (colored((y * w + x) * 4)) hits++; }
    rowFrac[y] = hits / n;
  }

  // Bridge gaps up to ~1 empty cell-row. The header/tray are separated from the
  // board by larger gaps, so they stay distinct; the tallest band is the board.
  const maxGap = Math.round(h * 0.045);     // ≈ 115px on a 2556-tall screenshot
  const rowBands = bandsFromProfile(rowFrac, h, 0.02, maxGap);
  if (!rowBands.length) throw new Error("Could not locate the board in this image.");
  rowBands.sort((a, b) => b.len - a.len);
  const top0 = rowBands[0].start, bot0 = rowBands[0].end;

  // The vertical extent is the reliable axis for SIZE: tiles/premium labels reach
  // the true top & bottom rows, and the header/tray are far enough never to merge.
  const size = bot0 - top0;
  const cell = size / C.GRID;

  // For horizontal POSITION, find the board's left/right edges from columns with
  // a meaningful amount of colored content (a 0.06 threshold rejects stray edge
  // pixels), then take the MIDPOINT as the center — robust to a board whose tiles
  // sit mostly on one side (a centroid would be pulled off-center).
  const colFrac = new Float32Array(w);
  for (let x = 0; x < w; x += step) {
    let hits = 0, n = 0;
    for (let y = top0; y <= bot0; y += step) { n++; if (colored((y * w + x) * 4)) hits++; }
    colFrac[x] = hits / n;
  }
  let left0 = -1, right0 = -1;
  for (let x = 0; x < w; x += step) if (colFrac[x] > 0.06) { if (left0 < 0) left0 = x; right0 = x; }
  const cx = left0 < 0 ? w / 2 : (left0 + right0) / 2;

  return {
    left: Math.round(cx - size / 2), top: top0,
    size, cell, grid: C.GRID,
    boardBottom: bot0,
    rowFrac, step, img: { w, h },
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

// Isolate the letter glyph as the largest, roughly-central connected ink blob in
// a generous cell window. This drops the value superscript (a separate, smaller
// blob), gridline fragments at the edges, and any neighbor-tile bleed, and makes
// recognition tolerant to a few px of calibration drift. Used by OCR + training,
// so the same extraction is baked into the templates. Exported for the generator.
export function extractLetterInk(px, w, rect) {
  const region = frac(rect, C.LETTER_REGION);
  const ink = inkMap(px, w, region.x, region.y, region.w, region.h);
  return largestBlob(ink);
}

export function extractValueInk(px, w, rect) {
  const region = frac(rect, C.VALUE_REGION);
  return inkMap(px, w, region.x, region.y, region.w, region.h);
}

// Keep only the largest connected component of ink (8-connectivity), preferring
// a centrally-located blob over a larger one hugging the window edge.
function largestBlob(ink, thr = 0.5) {
  const { data, w: W, h: H } = ink;
  const labels = new Int32Array(W * H);
  const stack = [];
  let cur = 0;
  const size = [0], cx = [0], cy = [0];
  for (let i = 0; i < W * H; i++) {
    if (data[i] <= thr || labels[i]) continue;
    cur++; labels[i] = cur; stack.push(i);
    let s = 0, sx = 0, sy = 0;
    while (stack.length) {
      const p = stack.pop(); s++; const py = (p / W) | 0, pxc = p % W; sx += pxc; sy += py;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = pxc + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const np = ny * W + nx;
        if (data[np] > thr && !labels[np]) { labels[np] = cur; stack.push(np); }
      }
    }
    size[cur] = s; cx[cur] = sx / s; cy[cur] = sy / s;
  }
  if (!cur) return ink;
  let best = 0, bestScore = -1;
  for (let l = 1; l <= cur; l++) {
    if (size[l] < 8) continue;
    const nx = cx[l] / W, ny = cy[l] / H;
    const central = (nx > 0.15 && nx < 0.85 && ny > 0.12 && ny < 0.93) ? 1 : 0.35;
    const score = size[l] * central;
    if (score > bestScore) { bestScore = score; best = l; }
  }
  if (!best) return ink;
  const out = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) if (labels[i] === best) out[i] = data[i];
  return { data: out, w: W, h: H };
}

function ocrLetter(px, w, rect, templates) {
  const vec = normalizeInk(extractLetterInk(px, w, rect));
  if (!vec) return { letter: "?", score: 0, margin: 0 };
  const m = templates.match(vec, "letter");
  return { letter: m.ch, score: m.score, margin: m.margin };
}

// OCR the value superscript: segment into digit runs, match each.
function ocrValue(px, w, rect, templates) {
  const ink = extractValueInk(px, w, rect);
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

// Resolve a tile's point value. Crossplay values are fixed, so we take the value
// from the letter via LETTER_VALUES and use the (unreliable) superscript OCR only
// to detect a blank — a letter whose superscript reads 0. Falls back to the OCR'd
// value for letters not in the table (e.g. an uncommon glyph the OCR guessed).
function resolveValue(letter, ocr) {
  if (ocr.value === 0) return { value: 0, blank: true };
  const std = C.LETTER_VALUES[letter];
  return { value: std != null ? std : ocr.value, blank: false };
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
    const V = resolveValue(L.letter, ocrValue(px, w, rect, templates));
    tiles.push({
      letter: L.letter, value: V.value, blank: V.blank,
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
        const V = resolveValue(L.letter, ocrValue(px, img.w, rect, templates));
        row.push({
          type: "tile", letter: L.letter, value: V.value, blank: V.blank,
          rect,
          lowconf: L.score < C.LETTER_MIN_SCORE || L.margin < C.LETTER_MIN_MARGIN,
          conf: { letter: L.score },
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
