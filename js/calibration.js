// calibration.js — tunable constants for the recognizer.
// Derived from analysis of real Crossplay screenshots (1179×2556 iPhone capture):
// board is full-width with ~78.6px square cells; tiles are a saturated blue #4076c6.
// Values are mostly normalized / color-based so they generalize across resolutions.

export const GRID = 15;

// Reference tile color (Crossplay blue) and how close a pixel must be to count as tile ink.
export const TILE_RGB = [64, 118, 198];     // #4076c6
export const TILE_DIST = 70;                // max euclidean distance to count as "tile blue"
export const TILE_FILL_MIN = 0.22;          // min fraction of blue pixels in a cell -> it's a tile

// A pixel is "saturated/colored" (premium label or tile, not page background) if:
export const SAT_MIN = 28;                   // max(rgb)-min(rgb) >= this
export const SAT_MAX_BRIGHT = 252;           // and max(rgb) < this (excludes pure white page)

// Crossplay's premium-square layout is FIXED in every game, so we treat this map
// as the source of truth for premiums (looked up by grid position) rather than
// classifying each square by color — adjacent label hues (2L tan ≈ 47°, 3L green
// ≈ 79°) are close enough that color detection occasionally misreads, putting
// premiums in "wonky" spots. The layout was verified from real boards: it is NOT
// the Scrabble layout (corners are 3L, not triple-word; the center is just a start
// logo with no multiplier). Legend: '.' none · d=2L · t=3L · D=2W · T=3W.
const PREMIUM_ROWS = [
  "t..T...d...T..t",
  ".D....t.t....D.",
  "....d.....d....",
  "T..d...D...d..T",
  "..d..t...t..d..",
  "....t..d..t....",
  ".t...........t.",
  "d..D.d...d.D..d",
  ".t...........t.",
  "....t..d..t....",
  "..d..t...t..d..",
  "T..d...D...d..T",
  "....d.....d....",
  ".D....t.t....D.",
  "t..T...d...T..t",
];
const PREMIUM_CHARS = { d: "2L", t: "3L", D: "2W", T: "3W" };
// 15×15 array of premium label ("3L"/"2L"/"3W"/"2W") or null.
export const PREMIUM_LAYOUT = PREMIUM_ROWS.map((row) =>
  [...row].map((ch) => PREMIUM_CHARS[ch] || null));

// Crossplay's letter→value mapping is FIXED, so we look the value up from the
// (reliably OCR'd) letter rather than trusting the tiny value-superscript OCR,
// which often misreads (e.g. M3→M8, W5→W95). Values read directly off real
// screenshots; several differ from standard Scrabble (B/G/K/L/U/V/W bumped up).
// The one exception is a BLANK: it shows as a letter with value 0 — detected via
// the superscript actually reading "0".
export const LETTER_VALUES = {
  A: 1, B: 4, C: 3, D: 2, E: 1, F: 4, G: 4, H: 3, I: 1, J: 8, K: 6, L: 2, M: 3,
  N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1, U: 2, V: 6, W: 5, X: 8, Y: 4, Z: 10,
};

// Region layout within a tile cell (fractions), measured from real tiles:
//   - the big letter sits lower-center; the point value is a small SUPERSCRIPT
//     in the upper-right; light gridline stripes hug the top & left edges.
// The letter is isolated by connected-component analysis (largest central ink
// blob) rather than a tight crop, so a GENEROUS window is used here — this makes
// recognition tolerant to a few px of calibration drift, which matters because
// board size/position varies between screenshots.
export const LETTER_REGION = { x0: 0.06, y0: 0.24, x1: 0.94, y1: 0.98 };
export const VALUE_REGION  = { x0: 0.52, y0: 0.04, x1: 0.99, y1: 0.38 };

// Ink extraction: white glyph on blue. ink = how white a pixel is.
// r channel ~255 for white glyph, ~64 for blue bg.
export const INK_LO = 95, INK_HI = 245;

// Confidence thresholds for flagging cells in the correction UI.
export const LETTER_MIN_SCORE = 0.45;
export const LETTER_MIN_MARGIN = 0.04;
