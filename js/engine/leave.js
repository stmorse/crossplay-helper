// leave.js — rack-leave equity (a "leave" is the tiles you keep after a play).
//
// A play's true value is its score PLUS the expected value of the tiles it leaves
// on your rack: keeping a blank, an S, or a balanced VC mix is worth real points
// next turn; keeping QUV or five vowels is a liability. Engines like Quackle use a
// table of leave equities learned from millions of games. We don't have Crossplay
// game data yet, so this is a TRANSPARENT HEURISTIC placeholder — same role as the
// ENABLE word list — designed to be swapped for a calibrated table later.
//
// All values are in points, on a scale where an average leave ≈ 0.

import { code } from "./dawg.js";

// Single-tile leave equities (approx. standard-English Scrabble wisdom). Summed
// across the leave, then corrected for balance and duplication below.
const SINGLE = {
  A: 1.0, B: -1.0, C: 0.5, D: 0.5, E: 4.0, F: -1.0, G: -2.5, H: 1.0, I: 0.0,
  J: -2.0, K: -0.5, L: -0.5, M: 0.5, N: 0.5, O: -1.0, P: 0.0, Q: -7.0, R: 1.5,
  S: 8.0, T: 0.5, U: -3.0, V: -4.5, W: -2.5, X: 3.5, Y: -1.5, Z: 3.5,
};
const SINGLE_ARR = new Array(26).fill(0);
for (const [k, v] of Object.entries(SINGLE)) SINGLE_ARR[code(k)] = v;

const VOWEL = new Array(26).fill(false);
for (const v of "AEIOU") VOWEL[code(v)] = true;

export const LEAVE_CONFIG = {
  blank: 25.0,             // keeping a blank is hugely valuable
  vowelExcessPenalty: 1.5, // per vowel beyond (consonants + 1)
  consExcessPenalty: 1.0,  // per consonant beyond (vowels + 2)
  dupPenaltyCommon: 1.5,   // first extra copy of E/A/I/O/S
  dupPenaltyOther: 2.5,    // first extra copy of any other letter
  dupEscalate: 1.0,        // added penalty that grows with each further copy
  qWithoutU: -4.0,         // extra penalty for holding Q with no U
};

const COMMON_DUP = new Set("EAIOS".split("").map(code));

// leaveCount: Int array[26] of letters kept; blanks: number of blanks kept.
export function leaveValue(leaveCount, blanks, cfg = LEAVE_CONFIG) {
  let value = blanks * cfg.blank;
  let vowels = 0, consonants = 0, hasU = false, hasQ = false;

  for (let i = 0; i < 26; i++) {
    const c = leaveCount[i];
    if (!c) continue;
    value += SINGLE_ARR[i] * c;
    if (VOWEL[i]) vowels += c; else consonants += c;
    if (i === code("U")) hasU = true;
    if (i === code("Q")) hasQ = true;
    if (c >= 2) {
      const extras = c - 1;
      const base = COMMON_DUP.has(i) ? cfg.dupPenaltyCommon : cfg.dupPenaltyOther;
      value -= base * extras + cfg.dupEscalate * (extras * (extras - 1)) / 2;
    }
  }

  // vowel/consonant balance (blanks count as flexible — ignored here)
  value -= cfg.vowelExcessPenalty * Math.max(0, vowels - (consonants + 1));
  value -= cfg.consExcessPenalty * Math.max(0, consonants - (vowels + 2));

  if (hasQ && !hasU) value += cfg.qWithoutU;

  return value;
}

// Human-readable leave string, e.g. "AERT?" (blanks shown as ?).
export function leaveString(leaveCount, blanks) {
  let s = "";
  for (let i = 0; i < 26; i++) s += String.fromCharCode(65 + i).repeat(leaveCount[i]);
  return s + "?".repeat(blanks);
}
