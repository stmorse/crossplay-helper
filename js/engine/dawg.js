// dawg.js — a minimized DAWG (directed acyclic word graph) of the dictionary,
// built with Daciuk's incremental-minimization algorithm (requires sorted input)
// and stored in a compact CSR (compressed-sparse-row) typed-array form for fast
// traversal during move generation.
//
// Letters are encoded as 0..25 ('A'..'Z'). A node is an integer index. Its
// outgoing edges are edges[firstEdge[node] .. firstEdge[node+1]); each edge has a
// letter (edgeChar) and a destination node (edgeTarget). final[node] marks a node
// reached by following a complete word.

export const A_CODE = 65;
export const code = (ch) => ch.charCodeAt(0) - A_CODE;          // 'A' -> 0
export const letter = (c) => String.fromCharCode(c + A_CODE);   // 0 -> 'A'

export class Dawg {
  constructor({ firstEdge, edgeChar, edgeTarget, final, root }) {
    this.firstEdge = firstEdge;
    this.edgeChar = edgeChar;
    this.edgeTarget = edgeTarget;
    this.final = final;
    this.root = root;
  }

  // Destination node when following letter `c` (0..25) from `node`, or -1.
  child(node, c) {
    for (let e = this.firstEdge[node], end = this.firstEdge[node + 1]; e < end; e++)
      if (this.edgeChar[e] === c) return this.edgeTarget[e];
    return -1;
  }

  isFinal(node) { return this.final[node] === 1; }

  // [start, end) range of edge indices for iterating a node's outgoing letters.
  edgeStart(node) { return this.firstEdge[node]; }
  edgeEnd(node) { return this.firstEdge[node + 1]; }

  // Whole-word membership test (mainly for tests / cross-word validation).
  has(word) {
    let node = this.root;
    for (let i = 0; i < word.length; i++) {
      node = this.child(node, word.charCodeAt(i) - A_CODE);
      if (node < 0) return false;
    }
    return this.isFinal(node);
  }

  serialize() {
    return {
      firstEdge: this.firstEdge, edgeChar: this.edgeChar,
      edgeTarget: this.edgeTarget, final: this.final, root: this.root,
    };
  }
}

// Build a minimized DAWG from a list of words (uppercase A–Z). The list need not
// be pre-sorted — we sort+dedupe here so callers can't get it subtly wrong.
export function buildDawg(words) {
  const sorted = Array.from(new Set(words)).sort();

  let nextId = 1;
  const mkNode = () => ({ id: nextId++, final: false, children: new Map() });
  const root = { id: 0, final: false, children: new Map() };

  const register = new Map();   // signature -> canonical node
  const unchecked = [];         // {parent, ch, child} along the previous word's path
  let prevWord = "";

  const signature = (node) => {
    let s = node.final ? "1" : "0";
    // children inserted in sorted order; build a stable key from canonical ids
    const keys = [...node.children.keys()].sort();
    for (const k of keys) s += "|" + k + ":" + node.children.get(k).id;
    return s;
  };

  const minimize = (downTo) => {
    for (let i = unchecked.length - 1; i >= downTo; i--) {
      const { parent, ch, child } = unchecked[i];
      const sig = signature(child);
      const found = register.get(sig);
      if (found) parent.children.set(ch, found);
      else register.set(sig, child);
      unchecked.pop();
    }
  };

  for (const word of sorted) {
    // length of common prefix with previous word
    let cp = 0;
    const m = Math.min(word.length, prevWord.length);
    while (cp < m && word[cp] === prevWord[cp]) cp++;

    minimize(cp);

    let node = unchecked.length ? unchecked[unchecked.length - 1].child : root;
    for (let i = cp; i < word.length; i++) {
      const ch = word[i];
      const next = mkNode();
      node.children.set(ch, next);
      unchecked.push({ parent: node, ch, child: next });
      node = next;
    }
    node.final = true;
    prevWord = word;
  }
  minimize(0);

  return toCSR(root);
}

// Flatten the minimized node graph into CSR typed arrays.
function toCSR(root) {
  // assign compact indices via DFS over unique nodes
  const index = new Map();
  const order = [];
  const visit = (node) => {
    if (index.has(node)) return;
    index.set(node, order.length);
    order.push(node);
    for (const k of [...node.children.keys()].sort())
      visit(node.children.get(k));
  };
  visit(root);

  const numNodes = order.length;
  let numEdges = 0;
  for (const node of order) numEdges += node.children.size;

  const firstEdge = new Int32Array(numNodes + 1);
  const edgeChar = new Uint8Array(numEdges);
  const edgeTarget = new Int32Array(numEdges);
  const final = new Uint8Array(numNodes);

  let e = 0;
  for (let n = 0; n < numNodes; n++) {
    const node = order[n];
    firstEdge[n] = e;
    final[n] = node.final ? 1 : 0;
    for (const k of [...node.children.keys()].sort()) {
      edgeChar[e] = k.charCodeAt(0) - A_CODE;
      edgeTarget[e] = index.get(node.children.get(k));
      e++;
    }
  }
  firstEdge[numNodes] = e;

  return new Dawg({ firstEdge, edgeChar, edgeTarget, final, root: index.get(root) });
}
