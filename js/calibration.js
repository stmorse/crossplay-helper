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

// Premium-label hue prototypes (measured from real empty premium squares).
// Classified by nearest hue among these.
export const PREMIUM_HUES = {
  "3L": 79,    // yellow-green
  "2L": 47,    // tan / gold
  "3W": 295,   // purple / magenta
  "2W": 221,   // muted blue
};
export const PREMIUM_HUE_TOL = 22;           // max hue distance to accept a premium label

// A pixel is "page background" (pure white app background, outside the board) if
// every channel is at/above this. Off-white board cells (~#f8f7f6) fall below it.
export const PAGE_MIN = 250;

// Region layout within a tile cell (fractions), measured from real tiles:
//   - the big letter sits lower-center-left
//   - the point value is a small SUPERSCRIPT in the upper-right
//   - light gridline stripes hug the top & left edges (must be excluded)
export const LETTER_REGION = { x0: 0.13, y0: 0.40, x1: 0.71, y1: 0.93 };
export const VALUE_REGION  = { x0: 0.55, y0: 0.06, x1: 0.99, y1: 0.36 };

// Ink extraction: white glyph on blue. ink = how white a pixel is.
// r channel ~255 for white glyph, ~64 for blue bg.
export const INK_LO = 95, INK_HI = 245;

// Confidence thresholds for flagging cells in the correction UI.
export const LETTER_MIN_SCORE = 0.45;
export const LETTER_MIN_MARGIN = 0.04;
