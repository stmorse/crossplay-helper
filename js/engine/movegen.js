// movegen.js — legal move generation + scoring over a DAWG.
//
// Approach: for each row, try every possible left boundary (start column) and
// extend rightward through the DAWG, consuming existing tiles and placing rack
// tiles on empty squares (subject to perpendicular cross-checks). A move is legal
// when the across word is in the dictionary, it places ≥1 new tile, it connects to
// the board (covers an "anchor" — an empty square adjacent to a filled one), and
// both ends abut an empty square or the edge. Down moves are produced by running
// the same routine on the transposed board. Results are de-duplicated by the exact
// set of placed tiles and sorted by score.
//
// Scoring uses the per-tile point values read from the screenshot (Crossplay's
// values are non-standard), so no hardcoded value table is needed.

import { code, letter as toLetter } from "./dawg.js";

const ALL = (1 << 26) - 1;
export const BINGO_BONUS = 50;      // placeholder; calibrate to Crossplay later

// ---- build engine board from recognizer state ---------------------------

export function boardFromState(state) {
  const grid = Array.from({ length: 15 }, () => new Array(15).fill(null));
  const values = Array.from({ length: 15 }, () => new Array(15).fill(0));
  const premium = Array.from({ length: 15 }, () => new Array(15).fill(null));

  // empirical letter→value table from every non-blank tile we've seen
  const letterValues = new Array(26).fill(0);
  const seen = (ch, v) => { if (ch && ch !== "?" && v != null) letterValues[code(ch)] = v; };

  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      const cell = state.board[r][c];
      if (cell.type === "tile" && cell.letter && cell.letter !== "?") {
        grid[r][c] = cell.letter;
        values[r][c] = cell.blank ? 0 : (cell.value ?? 0);
        if (!cell.blank) seen(cell.letter, cell.value);
      } else if (cell.type === "premium") {
        premium[r][c] = parsePremium(cell.premium);
      }
    }
  }

  // rack
  const rackCount = new Array(26).fill(0);
  let blanks = 0, rackSize = 0;
  for (const t of state.tray || []) {
    rackSize++;
    if (t.blank || t.value === 0 || !t.letter || t.letter === "?") { blanks++; continue; }
    rackCount[code(t.letter)]++;
    seen(t.letter, t.value);
  }
  // fill in any board tile values that were null using the empirical table
  for (let r = 0; r < 15; r++)
    for (let c = 0; c < 15; c++)
      if (grid[r][c] && values[r][c] === 0 && state.board[r][c] && !state.board[r][c].blank)
        values[r][c] = letterValues[code(grid[r][c])];

  return { grid, values, premium, rackCount, blanks, rackSize, letterValues };
}

function parsePremium(p) {
  switch (p) {
    case "2L": return { letter: 2 };
    case "3L": return { letter: 3 };
    case "2W": return { word: 2 };
    case "3W": return { word: 3 };
    default: return null;
  }
}

// ---- public entry --------------------------------------------------------

export function generateMoves(eb, dawg, opts = {}) {
  const bingo = opts.bingoBonus ?? BINGO_BONUS;
  const across = genDirection(eb, dawg, bingo, "A");
  const down = genDirection(transpose(eb), dawg, bingo, "D").map(swapCoords);

  const seen = new Map();
  for (const m of across.concat(down)) {
    const key = m.tiles.map((t) => `${t.row},${t.col},${t.letter},${t.blank ? 1 : 0}`).join("|");
    const prev = seen.get(key);
    if (!prev || m.score > prev.score) seen.set(key, m);
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}

// ---- one direction (rows of eb) -----------------------------------------

function genDirection(eb, dawg, bingo, dir) {
  const { grid, values, premium, rackCount, blanks, rackSize, letterValues } = eb;
  const moves = [];

  // anchors: empty square adjacent to a filled one. Empty board → center only.
  let anyTile = false;
  for (let r = 0; r < 15 && !anyTile; r++) for (let c = 0; c < 15; c++) if (grid[r][c]) { anyTile = true; break; }
  const isAnchor = Array.from({ length: 15 }, () => new Array(15).fill(false));
  if (!anyTile) isAnchor[7][7] = true;
  else for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) {
    if (grid[r][c]) continue;
    if ((r > 0 && grid[r - 1][c]) || (r < 14 && grid[r + 1][c]) ||
        (c > 0 && grid[r][c - 1]) || (c < 14 && grid[r][c + 1])) isAnchor[r][c] = true;
  }

  // mutable rack copy
  const rc = rackCount.slice();
  let bl = blanks;

  for (let r = 0; r < 15; r++) {
    const { allow, xhas, xscore } = crossChecks(eb, dawg, r);

    const record = (startCol, endCol, placed) => {
      let mainSum = 0, wordMult = 1, total;
      const byCol = new Map(placed.map((t) => [t.col, t]));
      let word = "";
      for (let c = startCol; c <= endCol; c++) {
        const t = byCol.get(c);
        if (t) {
          let lv = t.value; const pm = premium[r][c];
          if (pm && pm.letter) lv *= pm.letter;
          mainSum += lv;
          if (pm && pm.word) wordMult *= pm.word;
          word += toLetter(t.lc);
        } else {
          mainSum += values[r][c];
          word += grid[r][c];
        }
      }
      total = mainSum * wordMult;
      for (const t of placed) {
        if (!xhas[t.col]) continue;
        let lv = t.value; const pm = premium[r][t.col];
        if (pm && pm.letter) lv *= pm.letter;
        let cw = xscore[t.col] + lv;
        if (pm && pm.word) cw *= pm.word;
        total += cw;
      }
      if (placed.length === rackSize && rackSize > 0) total += bingo;
      moves.push({
        dir, row: r, col: startCol, word, score: total,
        tiles: placed.map((t) => ({ row: r, col: t.col, letter: toLetter(t.lc), blank: t.blank, value: t.value })),
      });
    };

    const dfs = (startCol, col, node, placed, covered) => {
      if (col > startCol && col <= 15 && dawg.isFinal(node) && placed.length >= 1 && covered &&
          (col > 14 || !grid[r][col])) {
        record(startCol, col - 1, placed);
      }
      if (col > 14) return;
      const g = grid[r][col];
      if (g) {
        const ch = dawg.child(node, code(g));
        if (ch >= 0) dfs(startCol, col + 1, ch, placed, covered);
        return;
      }
      const mask = allow[col];
      if (mask === 0 && xhas[col]) return;          // no letter fits the cross word
      for (let e = dawg.edgeStart(node), end = dawg.edgeEnd(node); e < end; e++) {
        const lc = dawg.edgeChar[e];
        if (xhas[col] && !(mask & (1 << lc))) continue;
        const child = dawg.edgeTarget[e];
        const here = covered || isAnchor[r][col];
        if (rc[lc] > 0) {
          rc[lc]--; placed.push({ col, lc, value: letterValues[lc], blank: false });
          dfs(startCol, col + 1, child, placed, here);
          placed.pop(); rc[lc]++;
        }
        if (bl > 0) {
          bl--; placed.push({ col, lc, value: 0, blank: true });
          dfs(startCol, col + 1, child, placed, here);
          placed.pop(); bl++;
        }
      }
    };

    for (let s = 0; s < 15; s++) {
      if (s > 0 && grid[r][s - 1]) continue;        // start must be a left boundary
      dfs(s, s, dawg.root, [], false);
    }
  }
  return moves;
}

// ---- cross-checks for a row (perpendicular words) ------------------------

function crossChecks(eb, dawg, r) {
  const { grid, values } = eb;
  const allow = new Int32Array(15);
  const xhas = new Array(15).fill(false);
  const xscore = new Int32Array(15);

  for (let c = 0; c < 15; c++) {
    if (grid[r][c]) { allow[c] = 0; continue; }
    let up = r - 1; while (up >= 0 && grid[up][c]) up--;
    let down = r + 1; while (down <= 14 && grid[down][c]) down++;
    const top = up + 1, bot = down - 1;
    if (top > r - 1 && bot < r + 1) { allow[c] = ALL; continue; }   // no vertical neighbors

    xhas[c] = true;
    let sc = 0;
    let node = dawg.root, ok = true;
    for (let rr = top; rr <= r - 1; rr++) { node = dawg.child(node, code(grid[rr][c])); sc += values[rr][c]; if (node < 0) { ok = false; break; } }
    let mask = 0;
    if (ok) {
      for (let e = dawg.edgeStart(node), end = dawg.edgeEnd(node); e < end; e++) {
        const lc = dawg.edgeChar[e];
        let n2 = dawg.edgeTarget[e], good = true;
        for (let rr = r + 1; rr <= bot; rr++) { n2 = dawg.child(n2, code(grid[rr][c])); if (n2 < 0) { good = false; break; } }
        if (good && dawg.isFinal(n2)) mask |= (1 << lc);
      }
    }
    for (let rr = r + 1; rr <= bot; rr++) sc += values[rr][c];
    allow[c] = mask;
    xscore[c] = sc;
  }
  return { allow, xhas, xscore };
}

// ---- transpose ----------------------------------------------------------

function transpose(eb) {
  const grid = Array.from({ length: 15 }, () => new Array(15).fill(null));
  const values = Array.from({ length: 15 }, () => new Array(15).fill(0));
  const premium = Array.from({ length: 15 }, () => new Array(15).fill(null));
  for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) {
    grid[c][r] = eb.grid[r][c];
    values[c][r] = eb.values[r][c];
    premium[c][r] = eb.premium[r][c];
  }
  return { ...eb, grid, values, premium };
}

function swapCoords(m) {
  return {
    ...m, row: m.col, col: m.row,
    tiles: m.tiles.map((t) => ({ ...t, row: t.col, col: t.row })),
  };
}
