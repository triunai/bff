// Flow metrics for the factory (td-osi.18): "why did td-X take 52 minutes?" as a per-bead stage breakdown, plus a few
// medians for a small FLOW strip. Pure, no I/O. Single-writer rule: reads only.
// HONESTY RULES, stated: (1) start and end come from criticalSteps (IMPORTED, one timing definition for the whole app):
// start = startedAt else the earliest "started" event; end = the "closed" event, else updatedAt (inferred), else now for
// in_progress. A bead with no start is UNTIMED: listed, excluded from every median, never guessed. (2) Review, rework and
// landing are only visible where a "status" event recorded them (to: "review" | "landing", or back to "in_progress" /
// "building" after one of those); labels carry no timestamp, so with no such events a bead's whole span reads as
// "building" and it does NOT count as review-measured. (3) A gap is never turned into a segment: it is `unknownMs`.
// (4) Clock skew is clamped to zero length and flagged, never turned into a negative duration.
import {criticalSteps} from "./critical-steps.ts";
import type {HistoryEvent} from "./surface-types.ts";
import type {WorkIssue} from "./types.ts";

export type FlowStage = "queued" | "building" | "review" | "rework" | "landing";
/** "timestamp": both edges are bd timestamps. "event": an edge is an observed status event. "inferred": an edge is updatedAt or now. */
export type SegmentSource = "event" | "timestamp" | "inferred";
export interface FlowSegment {stage: FlowStage; from: number; to: number; ms: number; source: SegmentSource}
export interface BeadTimeline {
  id: string;
  timed: boolean; // false: no usable start, so no segments and no numbers
  closed: boolean;
  startMs: number | null; endMs: number | null; // epoch ms, from criticalSteps
  segments: FlowSegment[]; // ordered, contiguous, never overlapping, zero-length dropped
  unknownMs: number; // time inside start..end that could not be assigned to a stage
  reworks: number; // review or landing sent back to building
  reviewMeasured: boolean; // at least one review or rework event: only then are review/rework/first-pass meaningful
  skewed: boolean; // a clock-skew clamp was applied to this bead
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const ms = (iso: string | null) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
const ROOT = "__flow_root__";

/** Clamp skewed timestamps before criticalSteps sees them (it silently drops end < start). Returns copies, never mutates. */
function normalise(issues: readonly WorkIssue[], events: readonly HistoryEvent[], now: number) {
  const skewed = new Set<string>();
  const ev = events.map((e) => ({...e}));
  const out = issues.map((i) => {
    const h = ev.filter((e) => e.id === i.id);
    const hs = h.filter((e) => e.kind === "started").map((e) => e.at);
    const start = ms(i.startedAt) ?? (hs.length ? Math.min(...hs) : null);
    const c = ms(i.createdAt);
    let issue: WorkIssue = {...i, parent: ROOT};
    if (start === null) return issue;
    if (c !== null && c > start) { issue = {...issue, createdAt: new Date(start).toISOString()}; skewed.add(i.id); }
    if (i.status === "in_progress" && now < start) { issue = {...issue, startedAt: new Date(now).toISOString()}; skewed.add(i.id); }
    if (i.status === "closed") {
      const hc = h.filter((e) => e.kind === "closed");
      if (hc.length) { for (const e of hc) if (e.at < start) { e.at = start; skewed.add(i.id); } }
      else { const u = ms(i.updatedAt); if (u !== null && u < start) { issue = {...issue, updatedAt: new Date(start).toISOString()}; skewed.add(i.id); } }
    }
    return issue;
  });
  return {issues: out, events: ev, skewed};
}

function buildTimelines(issues: readonly WorkIssue[], events: readonly HistoryEvent[], now: number): Map<string, BeadTimeline> {
  const n = normalise(issues, events, now);
  const root: WorkIssue = {id: ROOT, title: ROOT, type: "epic", status: "open", priority: 2, parent: null, labels: [], assignee: null, externalRef: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), startedAt: null, heartbeatAt: null};
  const cs = criticalSteps(ROOT, [root, ...n.issues], [], {now, history: n.events});
  const timing = new Map(cs.timed.map((t) => [t.id, t]));
  const out = new Map<string, BeadTimeline>();
  for (const i of n.issues) {
    const t = timing.get(i.id);
    const base: BeadTimeline = {id: i.id, timed: false, closed: i.status === "closed", startMs: null, endMs: null, segments: [], unknownMs: 0, reworks: 0, reviewMeasured: false, skewed: n.skewed.has(i.id)};
    if (!t) { out.set(i.id, base); continue; }
    const create = ms(i.createdAt);
    const endBoundary: SegmentSource = t.source === "history" ? "timestamp" : "inferred";
    const segs: FlowSegment[] = [];
    let unknown = 0, skew = base.skewed;
    const push = (stage: FlowStage, from: number, to: number, a: SegmentSource, b: SegmentSource) => {
      if (to <= from) return;
      segs.push({stage, from, to, ms: to - from, source: a === "inferred" || b === "inferred" ? "inferred" : a === "event" || b === "event" ? "event" : "timestamp"});
    };
    if (create !== null) push("queued", create, t.startMs, "timestamp", "timestamp"); // no created_at: queue wait unknown, not invented

    // Status transitions inside [start, end]; outside means skew: clamp onto the edge and flag it.
    const marks = n.events.filter((e) => e.id === i.id && e.kind === "status").map((e) => {
      const at = Math.min(Math.max(e.at, t.startMs), t.endMs);
      if (at !== e.at) skew = true;
      return {...e, at};
    }).sort((a, b) => a.at - b.at);
    let cur = "building" as FlowStage, curFrom = t.startMs, curSrc: SegmentSource = "timestamp", reworks = 0, measured = false;
    const enter = (next: FlowStage, at: number) => { push(cur, curFrom, at, curSrc, "event"); cur = next; curFrom = at; curSrc = "event"; };
    for (const e of marks) {
      const inReview = cur === "review" || cur === "landing";
      if (e.to === "review" && cur !== "review") { measured = true; enter("review", e.at); }
      else if (e.to === "landing" && cur !== "landing") { measured = true; enter("landing", e.at); }
      else if ((e.to === "in_progress" || e.to === "building") && inReview) { measured = true; reworks++; enter("rework", e.at); }
      else if (e.from === "review" && !inReview) {
        // Left review but we never saw it enter: the span since the last edge cannot be split, so it is unknown.
        measured = true; unknown += Math.max(0, e.at - curFrom); curFrom = e.at; curSrc = "event";
        if (e.to === "in_progress" || e.to === "building") { reworks++; cur = "rework"; }
      }
    }
    push(cur, curFrom, t.endMs, curSrc, endBoundary);
    out.set(i.id, {...base, timed: true, startMs: t.startMs, endMs: t.endMs, segments: segs, unknownMs: unknown, reworks, reviewMeasured: measured, skewed: skew});
  }
  return out;
}

/** One bead's ordered stage segments, plus unknown time. `issues` may be the whole list; only `id` is described. */
export function beadTimeline(id: string, issues: readonly WorkIssue[], events: readonly HistoryEvent[], now: number): BeadTimeline {
  const mine = issues.filter((i) => i.id === id);
  const empty: BeadTimeline = {id, timed: false, closed: false, startMs: null, endMs: null, segments: [], unknownMs: 0, reworks: 0, reviewMeasured: false, skewed: false};
  if (!mine.length) return empty;
  return buildTimelines(mine, events.filter((e) => e.id === id), now).get(id) ?? empty;
}

// ---- plain-English line ---------------------------------------------------------------------------------------------
export function formatDuration(msv: number): string {
  const m = Math.round(msv / 60_000);
  if (msv > 0 && m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}
const PHRASE: Record<FlowStage, string> = {building: "building", review: "in review", queued: "waiting", rework: "rework", landing: "landing"};
const ORDER: FlowStage[] = ["building", "review", "queued", "rework", "landing"];
/** e.g. "9m building · 3m in review · 28m waiting · 10m rework · 2m landing (14m unknown)". */
export function breakdownText(t: BeadTimeline): string {
  if (!t.timed) return "no timing recorded";
  const parts: string[] = [];
  for (const s of ORDER) {
    const total = t.segments.filter((x) => x.stage === s).reduce((a, x) => a + x.ms, 0);
    if (total > 0) parts.push(`${formatDuration(total)} ${PHRASE[s]}`);
  }
  let line = parts.length ? parts.join(" · ") : "0m building";
  if (t.unknownMs > 0) line += ` (${formatDuration(t.unknownMs)} unknown)`;
  if (t.skewed) line += " [clock skew clamped]";
  return line;
}

// ---- flow metrics ---------------------------------------------------------------------------------------------------
export interface Stat {median: number | null; n: number}
export interface Rate {rate: number | null; n: number}
export interface FlowMetrics {
  windowMs: number;
  queueWait: Stat; build: Stat; review: Stat; landing: Stat;
  rework: {count: number; rate: Rate};
  acceptedFirstPass: Rate; // closed without rework, over closed beads whose review was measured
  counts: {created: number; started: number; reviewed: number; closed: number};
  /** ALWAYS show next to the medians: timed / total beads active in the window, and how many had review events. */
  coverage: {timed: number; total: number; share: number | null; reviewMeasured: number};
  untimed: string[];
  skewed: string[];
}

/** Exact median; an even count averages the two middle values. */
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const stat = (xs: number[]): Stat => ({median: median(xs), n: xs.length});
const sum = (t: BeadTimeline, stages: FlowStage[]) => t.segments.filter((s) => stages.includes(s.stage)).reduce((a, s) => a + s.ms, 0);

export function flowMetrics(issues: readonly WorkIssue[], events: readonly HistoryEvent[], opts: {windowMs: number; now: number}): FlowMetrics {
  const {windowMs, now} = opts, lo = now - windowMs;
  const inWin = (t: number | null) => t !== null && t >= lo && t <= now;
  const tl = buildTimelines(issues, events, now);
  const statusEv = events.filter((e) => e.kind === "status");
  const counts = {created: 0, started: 0, reviewed: 0, closed: 0};
  const queue: number[] = [], build: number[] = [], review: number[] = [], landing: number[] = [];
  let timed = 0, total = 0, reviewMeasuredN = 0, reworkCount = 0, reworkBeads = 0, firstPass = 0, measuredClosed = 0;
  const untimed: string[] = [], skewed: string[] = [];
  for (const i of [...issues].sort((a, b) => byId(a.id, b.id))) {
    const t = tl.get(i.id)!;
    const closedIn = t.timed && t.closed && inWin(t.endMs), startedIn = t.timed && inWin(t.startMs);
    const createdIn = inWin(ms(i.createdAt));
    const reviewedIn = statusEv.some((e) => e.id === i.id && e.to === "review" && inWin(e.at));
    if (createdIn) counts.created++;
    if (startedIn) counts.started++;
    if (reviewedIn) counts.reviewed++;
    if (closedIn) counts.closed++;
    const active = createdIn || startedIn || closedIn || reviewedIn || i.status === "in_progress";
    if (!active) continue;
    total++;
    if (!t.timed) { untimed.push(i.id); continue; }
    timed++; if (t.reviewMeasured) reviewMeasuredN++; if (t.skewed) skewed.push(i.id);
    if (startedIn) { const q = sum(t, ["queued"]); if (t.segments.some((s) => s.stage === "queued")) queue.push(q); }
    if (closedIn) {
      build.push(sum(t, ["building"]));
      if (t.reviewMeasured) {
        measuredClosed++;
        const rv = sum(t, ["review"]); if (t.segments.some((s) => s.stage === "review")) review.push(rv);
        reworkCount += t.reworks; if (t.reworks > 0) reworkBeads++; else firstPass++;
      }
      if (t.segments.some((s) => s.stage === "landing")) landing.push(sum(t, ["landing"]));
    }
  }
  const rate = (a: number, n: number): Rate => ({rate: n ? a / n : null, n});
  return {
    windowMs, queueWait: stat(queue), build: stat(build), review: stat(review), landing: stat(landing),
    rework: {count: reworkCount, rate: rate(reworkBeads, measuredClosed)},
    acceptedFirstPass: rate(firstPass, measuredClosed),
    counts,
    coverage: {timed, total, share: total ? timed / total : null, reviewMeasured: reviewMeasuredN},
    untimed, skewed,
  };
}
