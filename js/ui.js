// ui.js — correction UI: render the detected board + tray as tappable elements,
// and a bottom-sheet editor to fix any cell. Mutates the shared state in place
// and re-renders.

import { LETTERS } from "./glyphs.js";

const PREMIUMS = ["3L", "2L", "3W", "2W"];

export function renderBoard(state, el, onEdit, overlay = null) {
  el.innerHTML = "";
  state.board.forEach((row, r) => {
    row.forEach((cell, c) => {
      const d = document.createElement("div");
      d.className = "cell";
      const ov = overlay && overlay.get(r + "," + c);
      if (ov) {
        d.classList.add("tile", "candidate");
        if (ov.blank) d.classList.add("blank");
        d.innerHTML = `<span class="letter">${ov.letter}</span>` +
          (ov.value != null ? `<span class="val">${ov.value}</span>` : "");
        d.addEventListener("click", () => onEdit({ kind: "cell", r, c }));
        el.appendChild(d);
        return;
      }
      if (cell.type === "tile") {
        d.classList.add("tile");
        if (cell.blank) d.classList.add("blank");
        const L = document.createElement("span");
        L.className = "letter";
        L.textContent = cell.letter || "?";
        d.appendChild(L);
        if (cell.value != null) {
          const v = document.createElement("span");
          v.className = "val"; v.textContent = cell.value;
          d.appendChild(v);
        }
        if (cell.lowconf) d.classList.add("lowconf");
      } else if (cell.type === "premium") {
        d.classList.add("premium", "p-" + cell.premium.toLowerCase());
        d.textContent = cell.premium;
      }
      d.addEventListener("click", () => onEdit({ kind: "cell", r, c }));
      el.appendChild(d);
    });
  });
}

export function renderTray(state, el, onEdit) {
  el.innerHTML = "";
  (state.tray || []).forEach((t, i) => {
    const d = document.createElement("div");
    d.className = "tile";
    if (t.blank) d.classList.add("blank");
    if (t.lowconf) d.classList.add("lowconf");
    d.innerHTML = `<span class="letter">${t.letter || "?"}</span>` +
      (t.value != null ? `<span class="val">${t.value}</span>` : "");
    d.addEventListener("click", () => onEdit({ kind: "tray", i }));
    el.appendChild(d);
  });
}

export function openEditor(target, state, editorEl, rerender) {
  const isTray = target.kind === "tray";
  let cell;
  if (isTray) {
    cell = state.tray[target.i];
  } else {
    cell = state.board[target.r][target.c];
  }

  const title = isTray ? `Tray tile ${target.i + 1}`
    : `Cell ${String.fromCharCode(65 + target.c)}${target.r + 1}`;

  editorEl.innerHTML = `
    <h3>${title}</h3>
    <div class="keys" id="ed-keys"></div>
    <div class="row">
      <label>Value <input type="number" id="ed-val" min="0" max="30" value="${cell.value ?? ""}" /></label>
      <label><input type="checkbox" id="ed-blank" ${cell.blank ? "checked" : ""}/> blank</label>
    </div>
    ${isTray ? "" : `<div class="row" id="ed-premium"></div>`}
    <div class="row">
      ${isTray ? `<button class="btn" id="ed-remove">Remove tile</button>`
               : `<button class="btn" id="ed-empty">Empty</button>`}
      <button class="btn primary" id="ed-done" style="margin-left:auto">Done</button>
    </div>`;

  // letter keypad
  const keys = editorEl.querySelector("#ed-keys");
  LETTERS.forEach((ch) => {
    const b = document.createElement("button");
    b.textContent = ch;
    b.addEventListener("click", () => {
      if (isTray) cell.type = undefined; else cell.type = "tile";
      cell.letter = ch; cell.lowconf = false;
      delete cell.premium;
      rerender();
    });
    keys.appendChild(b);
  });

  if (!isTray) {
    const pr = editorEl.querySelector("#ed-premium");
    PREMIUMS.forEach((p) => {
      const b = document.createElement("button");
      b.className = "btn"; b.textContent = p;
      b.addEventListener("click", () => {
        cell.type = "premium"; cell.premium = p;
        delete cell.letter; delete cell.value; cell.lowconf = false;
        rerender();
      });
      pr.appendChild(b);
    });
  }

  editorEl.querySelector("#ed-val").addEventListener("input", (e) => {
    const v = e.target.value === "" ? null : parseInt(e.target.value, 10);
    cell.value = v; cell.blank = v === 0;
    if (!isTray && cell.type !== "tile" && v != null) cell.type = "tile";
  });
  editorEl.querySelector("#ed-blank").addEventListener("change", (e) => {
    cell.blank = e.target.checked; if (cell.blank) cell.value = 0;
  });

  if (isTray) {
    editorEl.querySelector("#ed-remove").addEventListener("click", () => {
      state.tray.splice(target.i, 1); closeEditor(editorEl); rerender();
    });
  } else {
    editorEl.querySelector("#ed-empty").addEventListener("click", () => {
      state.board[target.r][target.c] = { type: "empty", rect: cell.rect };
      closeEditor(editorEl); rerender();
    });
  }
  editorEl.querySelector("#ed-done").addEventListener("click", () => closeEditor(editorEl));

  editorEl.classList.remove("hidden");
}

export function closeEditor(editorEl) { editorEl.classList.add("hidden"); }

// ---- best plays list ----------------------------------------------------

const COLS = "ABCDEFGHIJKLMNO";
// Scrabble-style square notation: across = row-number + col-letter, down = col-letter + row-number.
function squareLabel(m) {
  const num = m.row + 1, col = COLS[m.col];
  return m.dir === "A" ? `${num}${col} →` : `${col}${num} ↓`;
}

export function renderMoves(moves, el, onSelect) {
  el.innerHTML = "";
  moves.forEach((m, i) => {
    const li = document.createElement("li");
    const blanks = m.tiles.filter((t) => t.blank).length;
    const keep = m.leave ? `keeps <span class="keep">${m.leave}</span>` : "keeps nothing";
    li.innerHTML =
      `<span class="rank">${i + 1}</span>` +
      `<span class="word">${m.word}</span>` +
      `<span class="meta">${squareLabel(m)} · ${keep}` +
      (blanks ? ` · <span class="blanktag">${blanks} blank</span>` : "") + `</span>` +
      `<span class="scorebox"><span class="score">${m.score}<small> pts</small></span>` +
      (m.equity != null ? `<span class="eq">eq ${m.equity}</span>` : "") + `</span>`;
    li.addEventListener("click", () => {
      [...el.children].forEach((c) => c.classList.remove("selected"));
      li.classList.add("selected");
      onSelect(m);
    });
    el.appendChild(li);
  });
}

// Map a move's placed tiles to an overlay for renderBoard.
export function moveOverlay(m) {
  const map = new Map();
  if (m) for (const t of m.tiles) map.set(t.row + "," + t.col, { letter: t.letter, blank: t.blank, value: t.value });
  return map;
}

export function summarize(state) {
  let tiles = 0, low = 0, prem = 0;
  for (const row of state.board) for (const cell of row) {
    if (cell.type === "tile") { tiles++; if (cell.lowconf) low++; }
    if (cell.type === "premium") prem++;
  }
  const lowTray = (state.tray || []).filter((t) => t.lowconf).length;
  return `${tiles} tiles · ${prem} premium squares · ${(state.tray || []).length} tray tiles` +
    (low + lowTray ? ` · ⚠ ${low + lowTray} low-confidence (highlighted)` : " · all high-confidence");
}
