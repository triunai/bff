// Shared replay for the Work surface's time scrubber (Graph and Factory both use it). Pure. A bead's stage at time t is
// derived from its timestamps (created/started/closed) and from status changes Osiris itself observed between snapshots;
// "now" uses the live model (boardCards lanes), so the right edge of the scrubber always matches the board exactly.
// APPROXIMATIONS, stated: review has no timestamp (labels carry none), so review is only known for "now"; a closed bead's
// close time is its updatedAt (WorkIssue has no closedAt); a bead counts as "waiting" at t while any bead it is blocked by
// had not closed by t.
import type { HistoryEvent, WorkSurfaceSnapshot } from "./surface-types.ts";
import { boardCards, shortId } from "./surface-model.ts";

export type Stage = "waiting" | "ready" | "building" | "review" | "done";
export const STAGES: readonly Stage[] = ["waiting", "ready", "building", "review", "done"];
export const stageLabel = (s: Stage): string => ({ waiting: "Waiting", ready: "Ready", building: "Being built", review: "In review", done: "Done" })[s];

const ms = (iso: string | null) => { if (!iso) return null; const t = Date.parse(iso); return Number.isNaN(t) ? null : t; };

/** Every bead's stage right now, from the live model. */
export function currentStages(s: WorkSurfaceSnapshot, now: number): Map<string, Stage> {
  const out = new Map<string, Stage>(), lane = new Map(boardCards(s, now).map(c => [c.id, c.workLane]));
  for (const i of s.issues) {
    const l = lane.get(i.id);
    out.set(i.id, i.status === "closed" ? "done" : l === "review" ? "review" : l === "blocked" ? "waiting" : l === "in_progress" ? "building" : l === "ready" ? "ready" : "waiting");
  }
  return out;
}

/** Stages at time t. Beads not yet created at t are absent. t at or after `now` is exactly currentStages. */
export function stagesAt(s: WorkSurfaceSnapshot, events: readonly HistoryEvent[], t: number, now: number): Map<string, Stage> {
  if (t >= now) return currentStages(s, now);
  const closedAt = new Map<string, number>(), observed = new Map<string, HistoryEvent>();
  for (const e of events) {
    if (e.at > t) continue;
    if (e.kind === "closed") closedAt.set(e.id, Math.min(closedAt.get(e.id) ?? Infinity, e.at));
    if (e.kind === "status" && (!observed.has(e.id) || observed.get(e.id)!.at <= e.at)) observed.set(e.id, e);
  }
  const blockers = new Map<string, string[]>();
  const known = new Set(s.issues.map(i => i.id)); // a blocker missing from the snapshot is a dangling edge: the live model ignores it, so do we (review W-1B L6)
  for (const d of s.deps) if (d.type === "blocks" && known.has(d.dependsOnId)) blockers.set(d.issueId, [...(blockers.get(d.issueId) ?? []), d.dependsOnId]);
  const out = new Map<string, Stage>();
  for (const i of s.issues) {
    const c = ms(i.createdAt); if (c === null || c > t) continue;
    const o = observed.get(i.id);
    if (o?.to === "closed" || closedAt.has(i.id)) { out.set(i.id, "done"); continue; }
    const st = ms(i.startedAt);
    if (o?.to === "in_progress" || (st !== null && st <= t && o?.to !== "open")) { out.set(i.id, "building"); continue; }
    out.set(i.id, (blockers.get(i.id) ?? []).some(b => !closedAt.has(b)) ? "waiting" : "ready");
  }
  return out;
}

/** The scrubber's span: the oldest event to now (a one-hour floor so an empty history still scrubs). */
export function timeRange(events: readonly HistoryEvent[], now: number): { t0: number; t1: number } {
  const first = events.length ? Math.min(...events.map(e => e.at)) : now;
  return { t0: Math.min(first, now - 3600_000), t1: now };
}

/** Up to `max` scrubber marks, newest kept: closes ("f6v.1 done") and starts ("f6v.2 started"), plain English. */
export function scrubMarks(events: readonly HistoryEvent[], max = 12): { at: number; label: string }[] {
  const picked = events.filter(e => e.kind === "closed" || e.kind === "started" || (e.kind === "status" && (e.to === "closed" || e.to === "in_progress")));
  return picked.slice(-max).map(e => ({ at: e.at, label: `${shortId(e.id)} ${e.kind === "closed" || e.to === "closed" ? "done" : "started"}` }));
}
