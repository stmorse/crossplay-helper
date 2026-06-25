// glyphs.js — template-matching OCR for Crossplay's fixed digital font.
//
// A "template" is a glyph rendered/extracted, binarized to an ink map, then
// normalized into an N×N zero-mean vector. Matching is normalized cross-
// correlation (cosine of mean-subtracted vectors) — brightness/contrast robust.
//
// Two template sources, merged at lookup time:
//   1. Seed templates rendered from a web font (works out of the box, approximate).
//   2. Trained templates captured from a real screenshot (exact font → high accuracy),
//      persisted in localStorage so they survive reloads.

import { BAKED_TEMPLATES } from "./templates-data.js";

export const N = 24;                       // normalized glyph grid (N×N)
export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
export const DIGITS  = "0123456789".split("");

const STORE_KEY = "crossplay.templates.v1";

// ---- normalization -------------------------------------------------------

// Crop an ink map {data:Float32Array(0..1), w, h} to its ink bbox, scale to fit
// N×N preserving aspect ratio, center, and return a zero-mean Float32Array(N*N).
// Returns null if there is essentially no ink.
export function normalizeInk(ink, threshold = 0.35) {
  const { data, w, h } = ink;
  let minX = w, minY = h, maxX = -1, maxY = -1, total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x];
      if (v > threshold) {
        total += v;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || total < 1.5) return null;       // blank cell
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const scale = (N - 2) / Math.max(bw, bh);       // 1px margin
  const outW = Math.round(bw * scale), outH = Math.round(bh * scale);
  const offX = Math.floor((N - outW) / 2), offY = Math.floor((N - outH) / 2);

  const out = new Float32Array(N * N);
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const sx = minX + Math.min(bw - 1, Math.floor(ox / scale));
      const sy = minY + Math.min(bh - 1, Math.floor(oy / scale));
      out[(oy + offY) * N + (ox + offX)] = data[sy * w + sx];
    }
  }
  // zero-mean for NCC
  let mean = 0;
  for (let i = 0; i < out.length; i++) mean += out[i];
  mean /= out.length;
  let norm = 0;
  for (let i = 0; i < out.length; i++) { out[i] -= mean; norm += out[i] * out[i]; }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

// Zero-mean + unit-normalize an arbitrary vector (used to finalize averaged templates).
function renormalize(v) {
  const out = Float32Array.from(v);
  let mean = 0;
  for (let i = 0; i < out.length; i++) mean += out[i];
  mean /= out.length;
  let norm = 0;
  for (let i = 0; i < out.length; i++) { out[i] -= mean; norm += out[i] * out[i]; }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

function ncc(a, b) {            // both already zero-mean unit-norm
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;                     // ∈ [-1, 1]
}

// ---- template store ------------------------------------------------------

export class TemplateSet {
  constructor() {
    this.letters = new Map();   // char -> Float32Array(N*N)  (best template)
    this.digits  = new Map();
    this.trained = { letters: {}, digits: {} }; // raw arrays for persistence
    this.acc = { letter: new Map(), digit: new Map() }; // char -> {sum, n} for averaging
  }

  // Build approximate seed templates by rendering a bold rounded sans.
  buildSeed() {
    const font = `800 ${N * 0.8}px "Arial Rounded MT Bold", "Nunito", "Segoe UI", system-ui, sans-serif`;
    for (const ch of LETTERS) this.letters.set(ch, renderGlyphTemplate(ch, font));
    for (const ch of DIGITS)  this.digits.set(ch,  renderGlyphTemplate(ch, font));
  }

  // Load the templates baked from a real screenshot (accurate defaults). Seeds the
  // averaging accumulator so later user training blends with them.
  loadBaked() {
    const load = (kind, src) => {
      for (const [ch, arr] of Object.entries(src || {})) {
        const vec = renormalize(Float32Array.from(arr));
        (kind === "digit" ? this.digits : this.letters).set(ch, vec);
        this.acc[kind].set(ch, { sum: Float32Array.from(vec), n: 1 });
      }
    };
    load("letter", BAKED_TEMPLATES.letters);
    load("digit", BAKED_TEMPLATES.digits);
  }

  loadTrained() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (!raw) return false;
      for (const [k, v] of Object.entries(raw.letters || {}))
        this.letters.set(k, Float32Array.from(v));
      for (const [k, v] of Object.entries(raw.digits || {}))
        this.digits.set(k, Float32Array.from(v));
      this.trained = raw;
      return true;
    } catch { return false; }
  }

  // Add an exact template captured from a real glyph ink map. Multiple samples
  // of the same glyph are averaged into a single robust template (a bad single
  // extraction can't poison the class).
  train(kind, ch, ink) {
    const norm = normalizeInk(ink);
    if (!norm) return;
    const accMap = this.acc[kind];
    let a = accMap.get(ch);
    if (!a) { a = { sum: new Float32Array(N * N), n: 0 }; accMap.set(ch, a); }
    for (let i = 0; i < norm.length; i++) a.sum[i] += norm[i];
    a.n++;
    const avg = renormalize(a.sum);
    (kind === "digit" ? this.digits : this.letters).set(ch, avg);
    const bucket = kind === "digit" ? this.trained.digits : this.trained.letters;
    bucket[ch] = Array.from(avg);
  }

  persist() { localStorage.setItem(STORE_KEY, JSON.stringify(this.trained)); }
  clearTrained() { this.trained = { letters: {}, digits: {} }; localStorage.removeItem(STORE_KEY); }

  // Best match for a normalized vector. Returns {ch, score, margin}.
  match(vec, kind = "letter") {
    const map = kind === "digit" ? this.digits : this.letters;
    let best = null, bestScore = -2, second = -2;
    for (const [ch, tpl] of map) {
      const s = ncc(vec, tpl);
      if (s > bestScore) { second = bestScore; bestScore = s; best = ch; }
      else if (s > second) { second = s; }
    }
    return { ch: best, score: bestScore, margin: bestScore - second };
  }
}

// Render a single glyph (white on black) and convert to an ink map → normalized.
function renderGlyphTemplate(ch, font) {
  const S = 64;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const g = cv.getContext("2d");
  g.fillStyle = "#000"; g.fillRect(0, 0, S, S);
  g.fillStyle = "#fff";
  g.font = font;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(ch, S / 2, S / 2 + 2);
  const px = g.getImageData(0, 0, S, S).data;
  const ink = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) ink[i] = px[i * 4] / 255; // R channel = whiteness
  return normalizeInk({ data: ink, w: S, h: S });
}
