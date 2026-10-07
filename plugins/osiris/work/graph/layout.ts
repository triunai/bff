// The ONE dagre layout for the Work graph: the full graph (components/work/graph/workflow-graph.tsx) and the sidebar's mini graph
// (work/mini-graph.ts) both call layoutPositions, so the mini view can never drift into a second layout. Pure, no React.
import dagre from "dagre";

export const NODE_WIDTH = 320;
export const NODE_HEIGHT = 150;
export type LayoutDirection = "LR" | "TB";
export type LayoutDensity = "normal" | "compact";
export type LayoutEdge = { source: string; target: string };
/** The node footprint and gaps dagre lays out with. The canvas uses the default (a card); the sidebar's dots use MINI_FOOTPRINT so the area is spent on the graph, not on card-sized gaps (GRAPH-5). */
export type Footprint = { w: number; h: number; ranksep: number; nodesep: number };
export const MINI_FOOTPRINT: Footprint = { w: 28, h: 14, ranksep: 14, nodesep: 8 };

/** Top-left position per node id (the same convention React Flow uses). */
export function layoutPositions(ids: readonly string[], edges: readonly LayoutEdge[], direction: LayoutDirection = "LR", density: LayoutDensity = "normal", foot?: Footprint): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  const w = foot?.w ?? NODE_WIDTH, h = foot?.h ?? NODE_HEIGHT;
  g.setGraph({ rankdir: direction, ranksep: foot?.ranksep ?? (density === "compact" ? 70 : 120), nodesep: foot?.nodesep ?? (density === "compact" ? 35 : 70) });
  for (const id of ids) g.setNode(id, { width: w, height: h });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  const out = new Map<string, { x: number; y: number }>();
  for (const id of ids) { const n = g.node(id); out.set(id, { x: n.x - w / 2, y: n.y - h / 2 }); }
  return out;
}
