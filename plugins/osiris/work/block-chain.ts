// Who waits for what (owner, 22:56: "its really hard to see dependencies in this silo"). Pure, no I/O. One edge model: the
// work graph's `blocks` adjacency (graph/graph.ts buildGraphModel, the same graph the Graph tab and downstreamOf read;
// edge source = the blocker, target = the bead it holds up). This file builds no edges; it only walks them.

import type { GraphModel } from "./graph/graph.ts";

/** A bead on a chain: how many `blocks` hops from the focus (1 = direct), and whether it has landed. */
export type ChainNode = { id: string; depth: number; done: boolean };
/** A `blocks` edge on the chain, blocker → blocked. side = up (the focus waits on it, transitively) or down (it waits on the
 * focus). met = the blocker has landed, so this edge no longer holds anything up. */
export type ChainEdge = { from: string; to: string; side: "up" | "down"; met: boolean };
export type BlockChain = { focus: string; upstream: ChainNode[]; downstream: ChainNode[]; edges: ChainEdge[] };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The focus's whole `blocks` chain in both directions: everything it waits on (upstream) and everything that waits on it
 * (downstream), nearest first, each bead once (cycle-safe). Up and down never share a bead: on a cycle the side found first
 * keeps it. */
export function blockChain(g: GraphModel, focus: string, done: (id: string) => boolean): BlockChain {
  const seen = new Set<string>([focus]), edges: ChainEdge[] = [];
  const walk = (side: "up" | "down") => {
    const out: ChainNode[] = []; let ring = [focus], depth = 0;
    while (ring.length) {
      depth++; const next: string[] = [];
      for (const x of ring) {
        const adj = g.adjacency[x], list = (side === "up" ? adj?.incoming : adj?.outgoing) ?? [];
        for (const e of [...list].sort((a, b) => cmp(a.source + a.target, b.source + b.target))) {
          if (e.type !== "blocks") continue;
          const other = side === "up" ? e.source : e.target;
          edges.push({ from: e.source, to: e.target, side, met: done(e.source) });
          if (seen.has(other)) continue;
          seen.add(other); next.push(other); out.push({ id: other, depth, done: done(other) });
        }
      }
      ring = next;
    }
    return out;
  };
  const upstream = walk("up"), downstream = walk("down");
  const key = new Set<string>();
  return { focus, upstream, downstream, edges: edges.filter(e => (key.has(`${e.from}>${e.to}`) ? false : (key.add(`${e.from}>${e.to}`), true))) };
}

/** Direct `blocks` neighbours: what this bead waits on (its blockers) and what it holds up (its dependents), sorted. */
export function directBlocks(g: GraphModel, id: string): { blockers: string[]; dependents: string[] } {
  const adj = g.adjacency[id];
  const pick = (list: readonly { type: string; source: string; target: string }[] | undefined, end: "source" | "target") => [...new Set((list ?? []).filter(e => e.type === "blocks").map(e => e[end]))].sort(cmp);
  return { blockers: pick(adj?.incoming, "source"), dependents: pick(adj?.outgoing, "target") };
}

/** How each drawn bead reads while a chain is in focus: the focus itself, upstream (it waits on these), downstream (these wait
 * on it), or dimmed. An empty chain (no `blocks` edges either way) dims nothing: there is nothing to point at. */
export function chainRoles(chain: BlockChain | null, ids: readonly string[]): Map<string, "focus" | "up" | "down" | "dim"> {
  const out = new Map<string, "focus" | "up" | "down" | "dim">();
  if (!chain || (chain.upstream.length === 0 && chain.downstream.length === 0)) return out;
  const up = new Set(chain.upstream.map(n => n.id)), down = new Set(chain.downstream.map(n => n.id));
  for (const id of ids) out.set(id, id === chain.focus ? "focus" : up.has(id) ? "up" : down.has(id) ? "down" : "dim");
  return out;
}

/** Every `blocks` edge in the graph at once (the Chains toggle): blocker -> blocked, `side` "down" (each is read from its
 * blocker). Walks the same adjacency as blockChain; builds nothing of its own. Sorted, so the draw order is stable. */
export function allBlockEdges(g: GraphModel, done: (id: string) => boolean): ChainEdge[] {
  const out: ChainEdge[] = [];
  for (const n of g.nodes) for (const e of g.adjacency[n.id]?.outgoing ?? []) if (e.type === "blocks") out.push({ from: e.source, to: e.target, side: "down", met: done(e.source) });
  const seen = new Set<string>();
  return out.filter(e => (seen.has(`${e.from}>${e.to}`) ? false : (seen.add(`${e.from}>${e.to}`), true))).sort((a, b) => cmp(a.from + a.to, b.from + b.to));
}
/** Beads that sit on any `blocks` edge, either end: they get a card (never a folded crate) so their arrows have an endpoint. */
export function chainBeads(edges: readonly ChainEdge[]): Set<string> {
  const ids = new Set<string>(); for (const e of edges) { ids.add(e.from); ids.add(e.to); } return ids;
}
