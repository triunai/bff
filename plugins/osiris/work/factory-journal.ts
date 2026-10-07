// The Factory's TEMPORAL layer (design v5 §2.3). Pure: no React, no DOM, no clocks of its own (the caller passes `wall`).
// Time is two sources. Neither needs de-duplication WITHIN itself; where they overlap (a live transition that history later also shows)
// logAt converges them to ONE line by identity (sameTransition):
//   (A) the PAST is reconstructed: historyLog(t) is deterministic in (snapshot, events, t), so every replay position, rewind and
//       16x run recomputes the same lines (idempotent by construction: no consumed set, no LRU).
//   (B) the PRESENT is journaled from LIVE data only, for what history lacks (lock acquired / released, a bead reaching the Gate,
//       live-observed rework). The reducer holds its own baseline, so N actions before a render chain correctly, and a repeated
//       revision is a no-op (StrictMode-safe). Scrubbing never observes: replay position is not a journal action.
import { historyLog, lockLogLines, lockText, logTitle, moveLogLines, type FloorFrame, type FloorOpts, type LogLine } from "./factory-floor-model.ts";
import { BURST, landingMoments } from "./factory-fx.ts";
import type { HistoryEvent, WorkSurfaceSnapshot } from "./surface-types.ts";

/** A data revision: any string that changes when snapshot, leases, transcript liveness or costs change (the shell builds it). */
export type Rev = string;
/** One line of ON THE FLOOR / the timeline, structured: `beadId` and `kind` ride on LogLine, `at` is when it happened. */
export type SceneEvent = LogLine & { at: number; earlier?: boolean };
/** `from` is the previous observation time (the window a transition happened in) and `lock` the lock key, so a record and its later
 * history copy share ONE identity: (kind, beadId, lock) inside [from, at]. */
export type JournalRecord = SceneEvent & { id: string; lock?: string; from: number; since?: number };
export type Observe = { type: "observe"; rev: Rev; live: FloorFrame; wall: number; reduced: boolean; t0: number };
export type Tick = { type: "tick"; wall: number };
export type Journal = {
  rev: Rev | null;
  baseline: FloorFrame | null;
  open: ReadonlyMap<string, { instance: string; since: number }>;
  records: readonly JournalRecord[];
  fxUntil: ReadonlyMap<string, number>;
};
export const CHAIN_MS = 2600;
export const EMPTY_JOURNAL: Journal = { rev: null, baseline: null, open: new Map(), records: [], fxUntil: new Map() };
/** Kinds the journal records: only what history cannot reconstruct. Claimed / landed / reopened come from history. */
const JOURNALED = new Set(["gate", "sentBack"]);

export function journal(j: Journal, a: Observe | Tick): Journal {
  if (a.type === "tick") {
    const live = new Map([...j.fxUntil].filter(([, u]) => u > a.wall));
    return live.size === j.fxUntil.size ? j : { ...j, fxUntil: live };
  }
  if (j.rev === a.rev) return j; // the same data revision twice (StrictMode): a no-op, same reference
  const live = a.live, at = live.t, base = j.baseline, forward = base !== null && live.t >= base.t;
  const locks = live.locks.filter(l => l.kind !== "gate"), keys = new Set(locks.map(l => l.key));
  const open = new Map(j.open), add: JournalRecord[] = [], fx = new Map([...j.fxUntil].filter(([, u]) => u > a.wall));
  const titleOf = (id: string) => { const k = live.tokens.find(x => x.id === id); return k ? { title: logTitle(k.title) } : {}; };
  const taken = new Set(j.records.map(r => r.id)), from = base ? base.t : at;
  for (const l of locks) {
    if (open.has(l.key)) continue;
    let instance = `${l.key}@${at}`; if ([...taken].some(id => id.startsWith(`${instance}:`)) || [...open.values()].some(o => o.instance === instance)) instance += `~${j.records.length}`;
    open.set(l.key, { instance, since: at });
    if (forward) { add.push({ id: `${instance}:acquired`, key: `${instance}:acquired`, at, text: lockText(l), tone: "failure", kind: "locked", beadId: l.beadId, lock: l.key, from, ...titleOf(l.beadId) }); if (!a.reduced) fx.set(`chain:${l.key}`, a.wall + CHAIN_MS); }
  }
  for (const [key, o] of j.open) {
    if (keys.has(key)) continue;
    open.delete(key);
    const l = base?.locks.find(x => x.key === key);
    if (forward && l) add.push({ id: `${o.instance}:released`, key: `${o.instance}:released`, at, text: lockText(l, true), tone: "success", kind: "unlocked", beadId: l.beadId, lock: key, from, since: o.since, ...titleOf(l.beadId) });
  }
  if (forward) {
    for (const l of [...lockLogLines(base, live).filter(x => x.beadId === undefined), ...moveLogLines(base, live).filter(x => JOURNALED.has(x.kind ?? ""))]) add.push({ ...l, id: `${l.key}~${a.rev}`, key: `${l.key}~${a.rev}`, at, from });
    if (!a.reduced) for (const id of landingMoments(base, live)) fx.set(`burst:${id}`, a.wall + BURST.MS);
  }
  const records = [...j.records, ...add].filter(r => r.at >= a.t0);
  return { rev: a.rev, baseline: live, open, records, fxUntil: fx };
}

/** Rework seen per bead, DERIVED from the journal (never stored): the count of live-observed sent-back records AT OR BEFORE `upTo` (the
 * shown time), so a replayed moment never counts a transition that had not happened yet. */
export function reworkOf(j: Journal, upTo: number = Infinity): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of j.records) if (r.kind === "sentBack" && r.beadId && r.at <= upTo) m.set(r.beadId, (m.get(r.beadId) ?? 0) + 1);
  return m;
}
/** What is lit now: landing bursts (bead ids) and lock chains (lock keys), from the journal's wall expiries. */
export function litOf(j: Journal, wall: number): { bursts: ReadonlySet<string>; chainsLit: ReadonlySet<string> } {
  const bursts = new Set<string>(), chainsLit = new Set<string>();
  for (const [k, u] of j.fxUntil) if (u > wall) (k.startsWith("burst:") ? bursts : chainsLit).add(k.slice(k.indexOf(":") + 1));
  return { bursts, chainsLit };
}

const HIST_LOCK = /^[ul]:(.+):\d+$/;
const SLACK_MS = 1000;
/** Does a history line and a journal record describe the same transition? Locks compare their lock key (parsed from the history key
 * `u:<lock>:<t>` / `l:<lock>:<t>`); the aggregated Gate line compares its text. The window: a RELEASE can have happened any time since
 * its instance was acquired (the data may lag the event by a long gap), an acquisition since the previous observation; both up to the
 * observation (plus a little slack). */
export function sameTransition(h: SceneEvent, r: JournalRecord): boolean {
  const low = r.id.endsWith(":released") && r.since !== undefined ? r.since : r.from;
  if (h.kind !== r.kind || h.beadId !== r.beadId || h.at < low - SLACK_MS || h.at > r.at + SLACK_MS) return false;
  if (r.lock) return HIST_LOCK.exec(h.key)?.[1] === r.lock;
  return h.text === r.text;
}

let hist: { snap: WorkSurfaceSnapshot; events: readonly HistoryEvent[]; key: string; max: number; out: SceneEvent[] } | null = null;
/** ON THE FLOOR at shown time t: merge(historyLog(t), journal records at or before t), newest `max`, sorted by time then id.
 * `now` is the real present: only a position AT now is read as live, so scrubbing into the past never shows what the CURRENT snapshot
 * says (a bead that closes at 11:00 is not "landed" at 08:00). historyLog is deterministic in (snapshot, events, t, now), and its result
 * only changes when a meaningful event time passes, so it is cached on the last such time at or before t plus whether t is live.
 * `t` is OMITTED from the key on purpose: historyLog's one t-stamped emit (the last stretch, frame(last) -> frame(t)) is non-empty only when the
 * two frames differ in lock or intake-leaving lines. Between events in a PAST position floorAt moves a bead only claim <-> build by age, which
 * logs nothing, and the live flip (the one real difference) is in the key; so the stamp is never visible. Pinned in factory-journal.test.ts. */
export function logAt(snap: WorkSurfaceSnapshot, events: readonly HistoryEvent[], j: Journal, t: number, max: number, opts: FloorOpts = {}, now: number = t): SceneEvent[] {
  let last = -Infinity; for (const e of events) if (e.kind !== "created" && e.at <= t && e.at > last) last = e.at;
  const key = `${last}:${t >= now ? `live@${now}` : `past@${now}`}:${opts.thresholds ? JSON.stringify(opts.thresholds) : ""}`;
  if (!hist || hist.snap !== snap || hist.events !== events || hist.key !== key || hist.max !== max) hist = { snap, events, key, max, out: historyLog(snap, events, now, opts, max, t).map(l => ({ ...l, earlier: true })) };
  const past = hist.out.filter(l => l.at <= t), recs = j.records.filter(x => x.at <= t);
  // ONE identity per transition across both sources, matched ONE-TO-ONE and nearest-first: a journaled record yields to a history line that
  // says the same thing (same kind, bead, lock or aggregate text) inside its window, and each history line absorbs at most one record, so
  // distinct lock instances never collapse into one. History carries the true event time.
  const pairs: { r: number; h: number; gap: number }[] = [];
  recs.forEach((r, ri) => past.forEach((h, hi) => { if (sameTransition(h, r)) pairs.push({ r: ri, h: hi, gap: Math.abs(h.at - r.at) }); }));
  const takenR = new Set<number>(), takenH = new Set<number>();
  for (const q of pairs.sort((x, y) => x.gap - y.gap || x.r - y.r || x.h - y.h)) if (!takenR.has(q.r) && !takenH.has(q.h)) { takenR.add(q.r); takenH.add(q.h); }
  const mine = recs.filter((_, i) => !takenR.has(i));
  return [...past, ...mine].sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, max);
}

/** PRESENTATION moments between the previously shown scene and the next (none when it is the SAME frame: a fx overlay that merely
 * expired is not a new moment, or the highlight would renew itself forever) (a burst as a crate lands, a chain flashing as a lock
 * closes while scrubbing). Never logged or counted. None under reduced motion, at 16x, or on a rewind. */
export function momentsOf(prev: { frame: FloorFrame } | null, next: { frame: FloorFrame }, o: { reduced: boolean; speed: number }): { landed: string[]; locked: string[] } {
  if (!prev || prev.frame === next.frame || o.reduced || o.speed >= 16 || next.frame.t < prev.frame.t) return { landed: [], locked: [] };
  return { landed: landingMoments(prev.frame, next.frame), locked: next.frame.lockMoments.locked.map(l => l.key) };
}
