// defense.js — static "blocking" heuristic.
//
// A play's equity should account for what it hands the OPPONENT, not just your own
// score + leave. The cheapest meaningful proxy (no simulation) is: count the premium
// squares this play newly makes reachable for the opponent — i.e. an empty premium
// that becomes adjacent to a tile *because of one of your placed tiles*, and wasn't
// already next to a tile before. Each such "opened" premium is weighted by how
// dangerous it is. The total is a penalty subtracted from equity.
//
// This over-counts (a premium can be adjacent yet unplayable) — that's the accepted
// cost of a fast static rule. Weights are rough; tune against real play output.

export const DEFENSE_CONFIG = {
  open3W: 9.0,           // you left a triple-word square live next to your tile
  open2W: 4.5,           // double-word
  open3L: 2.5,           // triple-letter
  open2L: 1.0,           // double-letter
  hookValueFactor: 0.6,  // extra word-premium danger per point of the exposed tile
                         // (a high-value tile beside an open 2W/3W is a juicy hook)
};

const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0]];
const SEVERITY = { "3W": 0, "2W": 1, "3L": 2, "2L": 3 };

// eb: engine board (pre-move grid/premium). tiles: this play's placed tiles.
// Returns { value, opened } — value >= 0 is the equity penalty; opened lists the
// premium labels exposed (for the UI risk note).
export function dangerValue(eb, tiles, cfg = DEFENSE_CONFIG) {
  const { grid, premium } = eb;
  const placed = new Set(tiles.map((t) => t.row + "," + t.col));
  const counted = new Set();   // don't charge the same premium square twice
  let value = 0;
  const opened = [];

  for (const t of tiles) {
    for (const [dr, dc] of DIRS) {
      const r = t.row + dr, c = t.col + dc;
      if (r < 0 || r > 14 || c < 0 || c > 14) continue;
      const key = r + "," + c;
      if (grid[r][c] || placed.has(key)) continue;        // filled after the move
      const pm = premium[r][c];
      if (!pm) continue;
      if (counted.has(key)) continue;
      if (wasLiveBefore(grid, r, c)) continue;            // opponent already had it

      let d = 0, label = "";
      if (pm.word) {
        d = (pm.word === 3 ? cfg.open3W : cfg.open2W)
          + cfg.hookValueFactor * (t.value || 0) * (pm.word - 1);
        label = pm.word === 3 ? "3W" : "2W";
      } else if (pm.letter) {
        d = pm.letter === 3 ? cfg.open3L : cfg.open2L;
        label = pm.letter === 3 ? "3L" : "2L";
      }
      if (d > 0) { value += d; opened.push(label); counted.add(key); }
    }
  }
  return { value, opened };
}

// Was (r,c) already adjacent to a tile before this play? eb.grid is the pre-move
// board (it doesn't include the play's tiles), so a `true` here means the square was
// already an anchor the opponent could reach — opening it isn't this play's fault.
function wasLiveBefore(grid, r, c) {
  for (const [dr, dc] of DIRS) {
    const rr = r + dr, cc = c + dc;
    if (rr < 0 || rr > 14 || cc < 0 || cc > 14) continue;
    if (grid[rr][cc]) return true;
  }
  return false;
}

// Compact label for the UI, e.g. ["3W","2L","3W"] -> "3W, 2L" (unique, worst first).
export function riskLabel(opened) {
  if (!opened || !opened.length) return "";
  return [...new Set(opened)].sort((a, b) => SEVERITY[a] - SEVERITY[b]).join(", ");
}
