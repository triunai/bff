// The sidebar's MINI dependency graph: dots and edges only. It does NOT lay anything out itself: positions come from the full
// graph's layout (work/graph/layout.ts layoutPositions, the same call as workflow-graph.tsx with its defaults: left to right,
// roomy, hierarchy shown) and are only translated and uniformly scaled to fit a w x h box, so relative positions match the full graph.
import type { WorkSurfaceSnapshot } from "./surface-types.ts";
import { toBeadIssues } from "./graph/adapter.ts";
import { buildWorkflowEdges, collectEpicDescendantIds } from "./graph/epic-graph.ts";
import { layoutPositions, MINI_FOOTPRINT } from "./graph/layout.ts";
import { plainTitle, shortId } from "./surface-model.ts";

export type MiniNode = { id: string; x: number; y: number; shortId: string; title: string; status: string; blocked: boolean };
export type MiniEdge = { id: string; source: string; target: string; kind: "blocks" | "subtask" };
export type MiniGraph = { nodes: MiniNode[]; edges: MiniEdge[]; scale: number; width: number; height: number; /** open `blocks` links in scope */ blockers: number };
const PAD = 6;

/** The epic a bead belongs to: itself when it is an epic, else the nearest epic ancestor, else null (= whole tracker). */
export function epicOf(snap: WorkSurfaceSnapshot, id: string | null): string | null {
  if (!id) return null;
  const by = new Map(snap.issues.map(i => [i.id, i])), up = new Map<string, string>();
  for (const d of snap.deps) if (d.type === "parent-child") up.set(d.issueId, d.dependsOnId);
  for (const i of snap.issues) if (i.parent) up.set(i.id, i.parent);
  const seen = new Set<string>();
  for (let cur: string | undefined = id; cur && !seen.has(cur); cur = up.get(cur)) { seen.add(cur); if (by.get(cur)?.type === "epic") return cur; }
  return null;
}

/** Layout for the open beads of `epicId` (or of the whole tracker when null / unknown), fitted to w x h. */
export function miniGraphLayout(snap: WorkSurfaceSnapshot, epicId: string | null, w: number, h: number): MiniGraph {
  const issues = toBeadIssues(snap);
  const scope = epicId && issues.some(i => i.id === epicId) ? new Set([epicId, ...collectEpicDescendantIds(issues, epicId)]) : null;
  const visible = issues.filter(i => i.status !== "closed" && (!scope || scope.has(i.id)));
  const ids = new Set(visible.map(i => i.id));
  const edges = buildWorkflowEdges({ issues, visibleIds: ids, selectedId: null, includeHierarchy: true });
  const pos = layoutPositions(visible.map(i => i.id), edges, "LR", "normal", MINI_FOOTPRINT); // same dagre call, dot-sized footprint
  if (visible.length === 0) return { nodes: [], edges: [], scale: 1, width: w, height: h, blockers: 0 };
  const xs = [...pos.values()].map(p => p.x), ys = [...pos.values()].map(p => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys), gw = Math.max(...xs) - minX + MINI_FOOTPRINT.w, gh = Math.max(...ys) - minY + MINI_FOOTPRINT.h;
  const scale = Math.min((w - 2 * PAD) / gw, (h - 2 * PAD) / gh);
  const offX = (w - gw * scale) / 2, offY = (h - gh * scale) / 2; // centred in the box
  const blockedIds = new Set(edges.filter(e => e.kind === "blocks").map(e => e.target));
  // GRAPH-9: keyboard (tab) order follows the work, not the layout: active first, then by id, so the order is the same on every redraw.
  const rank = (s: string) => (s === "in_progress" ? 0 : s === "blocked" ? 1 : s === "open" ? 2 : 3);
  const nodes = [...visible].sort((a, b) => rank(a.status) - rank(b.status) || a.id.localeCompare(b.id)).map((i): MiniNode => { const p = pos.get(i.id)!; return { id: i.id, x: offX + (p.x - minX + MINI_FOOTPRINT.w / 2) * scale, y: offY + (p.y - minY + MINI_FOOTPRINT.h / 2) * scale, shortId: shortId(i.id), title: plainTitle(i.title), status: i.status, blocked: blockedIds.has(i.id) }; });
  return { nodes, edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target, kind: e.kind })), scale, width: w, height: h, blockers: edges.filter(e => e.kind === "blocks").length };
}
