// worker.js — runs the move engine off the main thread so the UI never blocks.
// Builds the DAWG once from the bundled word list, then answers solve requests.

import { buildDawg } from "./dawg.js";
import { boardFromState, generateMoves } from "./movegen.js";

let dawg = null;

async function init() {
  try {
    const url = new URL("../../assets/words.txt", import.meta.url);
    const text = await (await fetch(url)).text();
    const words = text.split("\n").map((w) => w.trim()).filter(Boolean);
    const t0 = performance.now();
    dawg = buildDawg(words);
    postMessage({
      type: "ready",
      words: words.length,
      nodes: dawg.firstEdge.length - 1,
      buildMs: Math.round(performance.now() - t0),
    });
  } catch (e) {
    postMessage({ type: "error", error: String(e && e.message || e) });
  }
}

onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "solve") {
    if (!dawg) { postMessage({ type: "error", error: "engine not ready" }); return; }
    const t0 = performance.now();
    const eb = boardFromState(msg.state);
    const moves = generateMoves(eb, dawg, msg.opts || {});
    postMessage({
      type: "result",
      ms: Math.round(performance.now() - t0),
      total: moves.length,
      moves: moves.slice(0, msg.limit || 40),
    });
  }
};

init();
