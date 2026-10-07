// Factory floor model (pure, no React, no colours). Rows = parent beads (epics), columns = replay STAGES; every cell is
// derived from stagesAt (the shared replay), so the right edge of the scrubber equals the live board. Never recomputes lanes.
// APPROXIMATIONS, stated: pane is only known for "now" (past frames show none); time-in-stage uses startedAt (building) or
// updatedAt (review), because beads carry no review timestamp; prevStage is the stage one step upstream of `stage`.
import type { HistoryEvent, WorkSurfaceSnapshot } from "./surface-types.ts";
import { workstreamTone } from "./workstream-hue.ts";
import type { WorkIssue } from "./types.ts";
import { STAGES, stagesAt, type Stage } from "./replay.ts";
import { boardCards, plainTitle, shortId } from "./surface-model.ts";

export const MAX_ROWS = 12, HOT_MS = 24 * 3600_000, UNFILED = "__unfiled";
export type FactoryRow = { key: string; label: string; toneIndex: number };
export type FactoryCard = { id: string; shortId: string; title: string; fullTitle: string; stage: Stage; prevStage: Stage | null; blocked: boolean; hot: boolean; pane: string | null; sinceMs: number | null; priority: number };
export type FactoryAt = { rows: FactoryRow[]; cells: Map<string, Map<Stage, FactoryCard[]>>; counts: Record<Stage, number>; hiddenRows: number;
  /** Cards of the groups past MAX_ROWS. The classic view still shows MAX_ROWS rows; the Factory floor draws EVERY eligible bead, so it reads these too (and `hiddenTone`, their group colours). */
  hiddenCards: FactoryCard[]; hiddenTone: Map<string, number> };
export type FactoryEdge = { from: string; to: string; unmet: boolean };

const ms = (iso: string | null) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const UPSTREAM: Record<Stage, Stage | null> = { waiting: null, ready: "waiting", building: "ready", review: "building", done: "building" };

/** Parent of each bead: the `parent` field, else a parent-child dep (dependsOnId is the parent). */
function parentOf(s: WorkSurfaceSnapshot) {
  const m = new Map<string, string>();
  for (const d of s.deps) if (d.type === "parent-child") m.set(d.issueId, d.dependsOnId);
  for (const i of s.issues) if (i.parent) m.set(i.id, i.parent);
  return m;
}
/** How long the bead has been in its stage at t, or null when unknowable. */
function sinceIn(i: WorkIssue, stage: Stage, t: number): number | null {
  const at = stage === "building" ? ms(i.startedAt) ?? ms(i.createdAt) : stage === "review" ? ms(i.updatedAt) : stage === "waiting" || stage === "ready" ? ms(i.createdAt) : null;
  return at === null ? null : Math.max(0, t - at);
}

export function factoryAt(s: WorkSurfaceSnapshot, events: readonly HistoryEvent[], t: number, now: number): FactoryAt {
  const stages = stagesAt(s, events, t, now), parents = parentOf(s), by = new Map(s.issues.map(i => [i.id, i]));
  const containers = new Set(parents.values());
  const pane = new Map(t >= now ? boardCards(s, now).map(c => [c.id, c.pane]) : []);
  const blockedBy = new Set(s.deps.filter(d => d.type === "blocks").map(d => d.issueId));
  const groups = new Map<string, FactoryCard[]>(), counts = { waiting: 0, ready: 0, building: 0, review: 0, done: 0 } as Record<Stage, number>;
  for (const i of s.issues) {
    const stage = stages.get(i.id); if (!stage || containers.has(i.id)) continue; // not yet created / an epic is a row, not a card
    const since = sinceIn(i, stage, t);
    const card: FactoryCard = { id: i.id, shortId: shortId(i.id), title: plainTitle(i.title), fullTitle: i.title, stage, prevStage: stage === "ready" && blockedBy.has(i.id) ? "waiting" : UPSTREAM[stage], blocked: stage === "waiting", hot: (stage === "building" || stage === "review") && since !== null && since > HOT_MS, pane: pane.get(i.id) ?? null, sinceMs: since, priority: i.priority };
    const key = parents.get(i.id) ?? UNFILED;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(card); counts[stage]++;
  }
  const keys = [...groups.keys()].sort(cmp), tone = new Map(keys.map(k => [k, workstreamTone(k)]));
  const activity = (k: string) => groups.get(k)!.filter(c => c.stage !== "done").length;
  const named = keys.filter(k => k !== UNFILED).sort((a, b) => activity(b) - activity(a) || groups.get(b)!.length - groups.get(a)!.length || cmp(a, b));
  const hasUnfiled = groups.has(UNFILED), shown = named.slice(0, MAX_ROWS - (hasUnfiled ? 1 : 0)), order = hasUnfiled ? [...shown, UNFILED] : shown;
  const rows: FactoryRow[] = order.map(k => ({ key: k, toneIndex: tone.get(k)!, label: k === UNFILED ? "Unfiled" : `${shortId(k)} · ${by.has(k) ? plainTitle(by.get(k)!.title) : "parent"}` }));
  const cells = new Map<string, Map<Stage, FactoryCard[]>>();
  for (const k of order) {
    const cs = groups.get(k)!.sort((a, b) => a.priority - b.priority || cmp(a.id, b.id)), row = new Map<Stage, FactoryCard[]>(STAGES.map(st => [st, []]));
    for (const c of cs) row.get(c.stage)!.push(c);
    cells.set(k, row);
  }
  const hiddenCards: FactoryCard[] = [], hiddenTone = new Map<string, number>();
  for (const k of named.slice(shown.length)) for (const c of groups.get(k)!.sort((a, b) => a.priority - b.priority || cmp(a.id, b.id))) { hiddenCards.push(c); hiddenTone.set(c.id, tone.get(k)!); }
  return { rows, cells, counts, hiddenRows: named.length - shown.length, hiddenCards, hiddenTone };
}

export const cardsOf = (f: FactoryAt): FactoryCard[] => [...f.cells.values()].flatMap(r => [...r.values()].flat());
/** Every eligible bead, including the groups past MAX_ROWS: the complete record the floor draws from. */
export const allCardsOf = (f: FactoryAt): FactoryCard[] => [...cardsOf(f), ...f.hiddenCards];

/** Ids that moved forward (fresh: glow) and ids that moved BACKWARD (rework, e.g. review to building: bounce). */
export function motionDelta(prev: FactoryAt, next: FactoryAt): { fresh: string[]; rework: string[] } {
  const was = new Map(allCardsOf(prev).map(c => [c.id, STAGES.indexOf(c.stage)])), fresh: string[] = [], rework: string[] = [];
  for (const c of allCardsOf(next)) {
    const p = was.get(c.id), n = STAGES.indexOf(c.stage);
    if (p === undefined || p === n) continue;
    (n > p ? fresh : rework).push(c.id);
  }
  return { fresh, rework };
}

/** `blocks` deps between cards visible in the frame; unmet while the blocker is not done. */
export function factoryEdges(s: WorkSurfaceSnapshot, f: FactoryAt, all = false): FactoryEdge[] {
  const st = new Map((all ? allCardsOf(f) : cardsOf(f)).map(c => [c.id, c.stage])), seen = new Set<string>(), out: FactoryEdge[] = [];
  for (const d of s.deps) {
    if (d.type !== "blocks") continue;
    const a = st.get(d.dependsOnId), b = st.get(d.issueId), k = `${d.dependsOnId}>${d.issueId}`;
    if (!a || !b || seen.has(k)) continue; seen.add(k);
    out.push({ from: d.dependsOnId, to: d.issueId, unmet: a !== "done" });
  }
  return out;
}

/** Plain-English header counts, e.g. "2 waiting · 1 ready · 3 being built · 0 in review · 5 done". */
export const countsLine = (c: Record<Stage, number>) => `${c.waiting} waiting · ${c.ready} ready · ${c.building} being built · ${c.review} in review · ${c.done} done`;
