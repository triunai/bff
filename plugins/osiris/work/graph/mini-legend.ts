// Pure helpers for the sidebar's mini dependency graph (ub-graph GRAPH-1..4, td-osi.1.1). No React, no DOM.
// The mini graph says the same thing the canvas Graph says: a dot's colour is its canvas STAGE (replay.ts currentStages) painted
// with the canvas's own `.oi-wg-s-<stage>` colour, selection is a ring (never a fill), and the tab badge names its unit.
import type { Stage } from "../replay.ts";
import { STAGES, stageLabel } from "../replay.ts";
import type { MiniGraph, MiniNode } from "../mini-graph.ts";
import type { WorkSurfaceSnapshot } from "../surface-types.ts";
import { plainTitle, shortId } from "../surface-model.ts";

/** GRAPH-3: the badge counts BLOCKED BEADS (what a person acts on), and says so; the old bare number counted blocks edges. */
export function miniBadge(g: Pick<MiniGraph, "nodes">): { n: number; unit: string } {
  return { n: g.nodes.filter(x => x.blocked).length, unit: "blocked" };
}

/** GRAPH-4: the caption naming what the dots show. `scoped` = a "show all" toggle is meaningful. */
export function miniCaption(snap: Pick<WorkSurfaceSnapshot, "issues">, epicId: string | null): { text: string; scoped: boolean } {
  const e = epicId ? snap.issues.find(i => i.id === epicId) : undefined;
  return e ? { text: `Epic ${shortId(e.id)} · ${plainTitle(e.title)}`, scoped: true } : { text: "All open work", scoped: false };
}

export type LegendItem = { key: string; label: string; kind: "stage"; stage: Stage } | { key: string; label: string; kind: "blocks" | "part" | "selected" };
/** GRAPH-2: the legend lists only the stages that are drawn, then the edge and selection marks, in canvas wording. */
export function miniLegend(stages: ReadonlySet<Stage>, hasBlocks: boolean, hasParts: boolean): LegendItem[] {
  const out: LegendItem[] = STAGES.filter(s => stages.has(s)).map(s => ({ key: `s:${s}`, label: stageLabel(s), kind: "stage" as const, stage: s }));
  if (hasBlocks) out.push({ key: "blocks", label: "blocks", kind: "blocks" });
  if (hasParts) out.push({ key: "part", label: "part of", kind: "part" });
  out.push({ key: "selected", label: "selected", kind: "selected" });
  return out;
}

/** GRAPH-2: which nodes get a visible short id: the ones in motion or stuck (building, blocked) and the selected one; at most `cap`. */
export function labelledIds(nodes: readonly MiniNode[], stages: ReadonlyMap<string, Stage>, selectedId: string | null, cap = 6): Set<string> {
  const out = new Set<string>();
  if (selectedId && nodes.some(n => n.id === selectedId)) out.add(selectedId);
  for (const n of nodes) { if (out.size >= cap) break; if (n.blocked || stages.get(n.id) === "building") out.add(n.id); }
  return out;
}

/** Plain-words aria/title for a dot: id, title, stage. */
export const dotLabel = (n: Pick<MiniNode, "shortId" | "title">, stage: Stage | undefined): string => `${n.shortId} ${n.title}${stage ? ` — ${stageLabel(stage)}` : ""}`;
