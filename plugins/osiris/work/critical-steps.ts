// Kimi K2.5 "Critical Steps" for a fleet (an epic and its descendants): the longest chain of dependent work versus the
// total work done, plus a flag for a fleet that behaved like ONE agent working in sequence. Pure, no I/O. Single-writer
// rule: reads only. Edge building and de-duplication are reused from buildWorkGraph; this file only adds the path maths.
import {buildWorkGraph} from "./work-model.ts";
import type {WorkDep, WorkIssue} from "./types.ts";
import type {HistoryEvent} from "./surface-types.ts";

/** Observed span at or above this share of total work means the work ran one task after another. */
export const SERIAL_COLLAPSE_RATIO = 0.9;
/** A collapse verdict needs at least this many timed children, or a two-task epic would always "collapse". */
export const SERIAL_COLLAPSE_MIN_TIMED = 3;

export type DurationSource = "history" | "updatedAt" | "now";
export interface NodeTiming {id: string; startMs: number; endMs: number; durationMs: number; source: DurationSource}
export interface CriticalStepsOptions {now: number; history?: readonly HistoryEvent[]}
export interface CriticalSteps {
  rootId: string;
  nodeCount: number;
  plannedCritical: number; // longest blocks chain, in nodes
  plannedPath: string[];
  weightedCritical: number; // ms, longest chain by duration
  weightedPath: string[];
  totalWork: number; // ms, sum of durations
  parallelism: number | null; // totalWork / weightedCritical; null when nothing is timed
  observedSpan: number; // ms, earliest start to latest end
  serialCollapse: boolean;
  timed: NodeTiming[]; // sorted by id; source says where each end time came from
  untimed: string[]; // no usable timestamps: excluded from the weighted numbers, never guessed
  cycles: string[]; // blocks-cycle members; same meaning as WavePlan.unschedulable
  unschedulable: string[]; // cycle members plus anything stuck behind them
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const ms = (iso: string | null) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };

export function criticalSteps(rootId: string, issues: readonly WorkIssue[], deps: readonly WorkDep[], opts: CriticalStepsOptions): CriticalSteps {
  const g = buildWorkGraph(issues, deps, opts.now);
  const byKey = new Map(issues.map((i) => [i.id, i]));

  // Descendants of the root through parent-child edges (root itself excluded).
  const kids = new Map<string, string[]>();
  for (const e of g.edges) if (e.kind === "parent-child") (kids.get(e.from) ?? kids.set(e.from, []).get(e.from)!).push(e.to);
  const members = new Set<string>(), stack = [rootId];
  while (stack.length) for (const c of kids.get(stack.pop()!) ?? []) if (c !== rootId && !members.has(c)) { members.add(c); stack.push(c); }
  const ids = [...members].sort(byId);

  // Timing. Closed beads have no closedAt on WorkIssue, so a close is the history event if given, else updatedAt.
  const hist = new Map<string, {started?: number; closed?: number}>();
  for (const h of opts.history ?? []) {
    if (!members.has(h.id) || (h.kind !== "started" && h.kind !== "closed")) continue;
    const r = hist.get(h.id) ?? hist.set(h.id, {}).get(h.id)!;
    if (h.kind === "started") r.started = Math.min(r.started ?? Infinity, h.at); else r.closed = Math.max(r.closed ?? -Infinity, h.at);
  }
  const timing = new Map<string, NodeTiming>();
  for (const id of ids) {
    const i = byKey.get(id)!, h = hist.get(id);
    const start = ms(i.startedAt) ?? h?.started ?? null;
    if (start === null) continue;
    let end: number | null = null, source: DurationSource = "now";
    if (i.status === "closed") { if (h?.closed !== undefined) { end = h.closed; source = "history"; } else { end = ms(i.updatedAt); source = "updatedAt"; } }
    else if (i.status === "in_progress") { end = opts.now; source = "now"; }
    if (end === null || end < start) continue;
    timing.set(id, {id, startMs: start, endMs: end, durationMs: end - start, source});
  }
  const untimed = ids.filter((id) => !timing.has(id));

  // Kahn over blocks edges inside the fleet. Closed blockers STAY in: they were real work on the path. Cycle members
  // and anything behind them are never processed, so they are unschedulable (planWaves semantics).
  const adj = new Map<string, string[]>(), inDeg = new Map<string, number>();
  for (const id of ids) { adj.set(id, []); inDeg.set(id, 0); }
  for (const e of g.edges) {
    if (e.kind !== "blocks" || !members.has(e.from) || !members.has(e.to)) continue;
    adj.get(e.from)!.push(e.to); inDeg.set(e.to, inDeg.get(e.to)! + 1);
  }
  for (const v of adj.values()) v.sort(byId);
  const remaining = new Map(inDeg), order: string[] = [];
  let queue = ids.filter((id) => remaining.get(id) === 0);
  while (queue.length) {
    const next: string[] = [];
    for (const id of queue) {
      order.push(id);
      for (const nb of adj.get(id)!) { const d = remaining.get(nb)! - 1; remaining.set(nb, d); if (d === 0) next.push(nb); }
    }
    queue = next.sort(byId);
  }
  const done = new Set(order);
  const unschedulable = ids.filter((id) => !done.has(id));
  // Cycle members proper: stuck nodes that can reach themselves.
  const stuck = new Set(unschedulable);
  const cycles = unschedulable.filter((id) => {
    const seen = new Set<string>(), st = [...adj.get(id)!];
    while (st.length) { const n = st.pop()!; if (n === id) return true; if (!stuck.has(n) || seen.has(n)) continue; seen.add(n); st.push(...adj.get(n)!); }
    return false;
  });

  // Longest paths by DP in topological order. Ties break toward the smaller id, at every predecessor and at the end.
  const preds = new Map<string, string[]>();
  for (const id of order) for (const nb of adj.get(id)!) (preds.get(nb) ?? preds.set(nb, []).get(nb)!).push(id);
  const longest = (weight: (id: string) => number): {value: number; path: string[]} => {
    const val = new Map<string, number>(), from = new Map<string, string | null>();
    for (const id of order) {
      let best: string | null = null, bv = 0;
      for (const p of (preds.get(id) ?? []).sort(byId)) if (best === null || val.get(p)! > bv) { best = p; bv = val.get(p)!; }
      val.set(id, bv + weight(id)); from.set(id, best);
    }
    let end: string | null = null;
    for (const id of order.slice().sort(byId)) if (end === null || val.get(id)! > val.get(end)!) end = id;
    const path: string[] = [];
    for (let c = end; c !== null; c = from.get(c)!) path.unshift(c);
    return {value: end === null ? 0 : val.get(end)!, path};
  };
  const planned = longest(() => 1);
  const weighted = longest((id) => timing.get(id)?.durationMs ?? 0);

  const timed = [...timing.values()].sort((a, b) => byId(a.id, b.id));
  const totalWork = timed.reduce((s, t) => s + t.durationMs, 0);
  const observedSpan = timed.length ? Math.max(...timed.map((t) => t.endMs)) - Math.min(...timed.map((t) => t.startMs)) : 0;
  // Collapse = tasks ran back to back AND the dependencies did not force it: if the critical chain alone already
  // accounts for the work, the graph itself was serial and the fleet did nothing wrong.
  const chainExplainsIt = weighted.value >= SERIAL_COLLAPSE_RATIO * totalWork;
  // "One after another" needs the tasks not to overlap: the covered time (union of the intervals) must be nearly all of the work. A wide span
  // alone is not evidence: two simultaneous tasks followed, hours later, by a third have a long span and ran in parallel.
  const covered = (() => { let sum = 0, curEnd = -Infinity, curStart = 0; for (const t of [...timed].sort((a, b) => a.startMs - b.startMs)) { if (t.startMs > curEnd) { sum += curEnd - curStart > 0 ? curEnd - curStart : 0; curStart = t.startMs; curEnd = t.endMs; } else if (t.endMs > curEnd) curEnd = t.endMs; } return sum + (curEnd - curStart > 0 ? curEnd - curStart : 0); })();
  return {
    rootId, nodeCount: ids.length,
    plannedCritical: planned.path.length, plannedPath: planned.path,
    weightedCritical: weighted.value, weightedPath: weighted.path.filter((id) => timing.has(id)),
    totalWork,
    parallelism: weighted.value > 0 ? totalWork / weighted.value : null,
    observedSpan,
    serialCollapse: timed.length >= SERIAL_COLLAPSE_MIN_TIMED && observedSpan >= SERIAL_COLLAPSE_RATIO * totalWork && covered >= SERIAL_COLLAPSE_RATIO * totalWork && !chainExplainsIt,
    timed, untimed, cycles, unschedulable,
  };
}
