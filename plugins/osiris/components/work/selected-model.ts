// Pure model for the right-rail "Selected" inspector (no React): the rows come from the Board's own cards, so the tree, Board,
// Factory and this rail can never disagree about a work item's stage, blockers or age.
import { boardCards, formatAge, laneLabel, plainTitle } from "../../work/surface-model.ts";
import type { BoardCard, WorkSurfaceSnapshot } from "../../work/surface-types.ts";
import { dispatchBlockReason } from "../../work/ui-text.ts";

export type SelectedModel = {
  id: string; priority: number; title: string;
  stage: string; pane: string | null; waitingOn: string[]; unblocks: string[]; age: string; blockReason: string | null;
};

const linkIds = (l: BoardCard["blockedBy"]) => l.map(x => x.id);

/** Null when the id is not in the snapshot (the rail then shows its empty state). */
export function selectedModel(snap: WorkSurfaceSnapshot, id: string | null, now: number): SelectedModel | null {
  const issue = id ? snap.issues.find(i => i.id === id) : undefined;
  if (!issue) return null;
  const card = boardCards(snap, now).find(c => c.id === id) ?? null;
  const created = Date.parse(issue.createdAt);
  return {
    id: issue.id, priority: issue.priority, title: plainTitle(issue.title),
    stage: card ? laneLabel(card.lane) : issue.status === "closed" ? "Closed" : issue.status.replace("_", " "),
    pane: card?.pane ?? null,
    waitingOn: card ? linkIds(card.blockedBy) : [], unblocks: card ? linkIds(card.unblocks) : [],
    age: Number.isFinite(created) ? formatAge(Math.max(0, now - created)) : "unknown",
    blockReason: dispatchBlockReason(snap, issue.id, now),
  };
}

/** A decision row is Critical when the tracker says so (crit label or title) or the item is P0. */
export function isCriticalDecision(snap: WorkSurfaceSnapshot, row: { id: string; kind: string }): boolean {
  return row.kind === "crit" || snap.issues.find(i => i.id === row.id)?.priority === 0;
}
