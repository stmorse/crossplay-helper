// app.js — entry point. Upload → recognize → correction UI.

import { TemplateSet } from "./glyphs.js";
import { recognize } from "./recognizer.js";
import * as UI from "./ui.js";

const $ = (id) => document.getElementById(id);

const els = {
  dropzone: $("dropzone"),
  fileInput: $("file-input"),
  loadExample: $("load-example"),
  status: $("status"),
  boardCard: $("board-card"),
  board: $("board"),
  tray: $("tray"),
  recogSummary: $("recog-summary"),
  confirm: $("confirm-board"),
  playsCard: $("plays-card"),
  plays: $("plays"),
  playsStatus: $("plays-status"),
  rankToggle: $("rank-toggle"),
  editor: $("editor"),
  help: $("help"),
  helpBtn: $("help-btn"),
  helpClose: $("help-close"),
};

// Build template set once. Priority: user-trained (localStorage) > baked (from a
// real screenshot) > rendered seed font (fallback for un-baked glyphs like K/Z).
const templates = new TemplateSet();
templates.buildSeed();
templates.loadBaked();
templates.loadTrained();

let state = null;       // last recognition result
let currentImage = null;
let selectedMove = null;
let currentRank = "equity";
let lastLite = null;    // last board sent to the engine (for re-ranking)

// ---- engine worker (builds the dictionary in the background) -------------
let engineReady = false;
const worker = new Worker(new URL("./engine/worker.js", import.meta.url), { type: "module" });
worker.onerror = (e) => {
  console.error("WORKER ERROR:", e.message, e.filename + ":" + e.lineno);
  setStatus("Engine failed to load: " + (e.message || "worker error"), "err");
};
worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "ready") {
    console.log(`[engine] ${m.words} words, ${m.nodes} nodes, built in ${m.buildMs} ms`);
    engineReady = true;
    els.confirm.disabled = false;
  } else if (m.type === "result") {
    els.playsCard.classList.remove("hidden");
    els.playsStatus.textContent = m.total
      ? `${m.total} legal plays found in ${m.ms} ms — showing top ${m.moves.length}.`
      : "No legal plays found (check the board and tray for misreads).";
    UI.renderMoves(m.moves, els.plays, selectMove);
    if (m.moves.length) selectMove(m.moves[0]);
    els.confirm.disabled = false;
    els.confirm.textContent = "Find best plays";
  } else if (m.type === "error") {
    setStatus("Engine error: " + m.error, "err");
    els.confirm.disabled = false;
  }
};

function selectMove(move) {
  selectedMove = move;
  rerender();
  els.board.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function setStatus(msg, cls = "") { els.status.className = "status " + cls; els.status.textContent = msg; }

function rerender() {
  UI.renderBoard(state, els.board, onEdit, UI.moveOverlay(selectedMove));
  UI.renderTray(state, els.tray, onEdit);
  els.recogSummary.textContent = UI.summarize(state);
}

function onEdit(target) {
  selectedMove = null;                 // clear any candidate overlay while editing
  UI.openEditor(target, state, els.editor, rerender);
}

async function handleImage(img) {
  currentImage = img;
  setStatus("Reading board…");
  // let the status paint before the (synchronous) heavy work
  await new Promise((r) => requestAnimationFrame(r));
  try {
    state = recognize(img, templates);
    selectedMove = null;
    lastLite = null;
    els.playsCard.classList.add("hidden");
    els.boardCard.classList.remove("hidden");
    rerender();
    setStatus("");
    maybeAutoSolve();
  } catch (e) {
    console.error(e);
    setStatus(e.message || "Recognition failed.", "err");
  }
}

function loadFromBlobOrUrl(src) {
  const img = new Image();
  img.onload = () => handleImage(img);
  img.onerror = () => setStatus("Could not load that image.", "err");
  img.src = src;
}

// ---- wiring --------------------------------------------------------------

els.dropzone.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) loadFromBlobOrUrl(URL.createObjectURL(f));
});

["dragover", "dragenter"].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.remove("drag"); }));
els.dropzone.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f) loadFromBlobOrUrl(URL.createObjectURL(f));
});

els.loadExample.addEventListener("click", () => {
  setStatus("Loading example…");
  loadFromBlobOrUrl("examples/example0.png");
});

// Convenience for demos/dev: #example auto-loads the sample; #solve also auto-solves.
const autoSolve = location.hash === "#solve";
if (location.hash === "#example" || autoSolve) els.loadExample.click();

let autoSolved = false;
function maybeAutoSolve() {
  if (autoSolve && !autoSolved && engineReady && state && !els.confirm.disabled) {
    autoSolved = true;
    els.confirm.click();
  }
}
const _onmsg = worker.onmessage;
worker.onmessage = (ev) => { _onmsg(ev); maybeAutoSolve(); };

// "how it works" modal
const showHelp = (show) => els.help.classList.toggle("hidden", !show);
els.helpBtn.addEventListener("click", () => showHelp(true));
els.helpClose.addEventListener("click", () => showHelp(false));
els.help.addEventListener("click", (e) => { if (e.target === els.help) showHelp(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") showHelp(false); });

function postSolve() {
  if (!lastLite || !engineReady) return;
  selectedMove = null;
  els.confirm.disabled = true;
  els.confirm.textContent = "Solving…";
  worker.postMessage({ type: "solve", state: lastLite, opts: { rankBy: currentRank }, limit: 40 });
}

els.confirm.addEventListener("click", () => {
  if (!state) return;
  window.crossplayBoard = state;
  if (!engineReady) { setStatus("Engine still loading the dictionary…", ""); return; }
  // strip the heavy `rect` fields the engine doesn't need before cloning to the worker
  lastLite = {
    board: state.board.map((row) => row.map((c) => ({ type: c.type, letter: c.letter, value: c.value, blank: c.blank, premium: c.premium }))),
    tray: (state.tray || []).map((t) => ({ letter: t.letter, value: t.value, blank: t.blank })),
  };
  postSolve();
});

els.rankToggle.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn || btn.dataset.rank === currentRank) return;
  currentRank = btn.dataset.rank;
  [...els.rankToggle.children].forEach((b) => b.classList.toggle("active", b === btn));
  postSolve();
});
