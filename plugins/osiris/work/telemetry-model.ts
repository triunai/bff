// Work telemetry (pure, no fs, no child processes): transcript units + the tracker's beads -> per-bead cost / cache numbers, totals,
// freshness and coverage, plus the critical-path set. The ONE join is telemetry-join.ts joinUnitsToWork (lane name = bead claim actor);
// the ONE transcript reader is transcript-feed.ts. This file only shapes their output for the UI.
// PRIVACY: the result carries numbers, bead ids and LANE NAMES only (each through cleanText). No transcript text, no file paths, no
// session ids: rows hold their file path in `source`, so nothing here ever copies a row.
import { aggregate, rowKey } from "../cache-economics.ts";
import { joinUnitsToWork } from "../telemetry-join.ts";
import type { TelemetryUnit } from "../telemetry-join.ts";
import { criticalSteps } from "./critical-steps.ts";
import { cleanText, redactForDisplay } from "./sanitize.ts";
import { activityFromUnits, transcriptLiveByBead } from "./transcript-liveness.ts";
import type { MissCause, MissEvent } from "../cache-misses.ts";
import type { UsageRow } from "../cache-economics.ts";
import type { WorkDep, WorkIssue } from "./types.ts";
import { buildFleet } from "./fleet-model.ts";
import type { FleetInput } from "./fleet-model.ts";
import type { FleetSnapshot } from "./fleet-types.ts";
import { buildTokenEfficiency } from "./token-efficiency-model.ts";
import type { EffToolUnit, TokenEfficiency } from "./token-efficiency-model.ts";
import { buildSpendDays } from "./spend-days.ts";
import type { DaySpend } from "./spend-days.ts";

export interface BeadCostRow {
  beadId: string;
  /** The lane that wrote last for this bead. */
  lane: string | null;
  /** Dollars at list price, or null when a model had no price (never a silent 0). */
  costUsd: number | null;
  /** Cost of the priced calls only, always a number. */
  pricedUsd: number;
  hitRate: number | null;
  requests: number;
  /** Input-side tokens that missed the cache. */
  missTokens: number;
  /** Unexpected cache misses: miss events other than a lane's first cold start. */
  misses: number;
  /** Misses caused by the cached start of the prompt changing. */
  prefixBreaks: number;
  lastAt: number | null;
  model: string | null;
}
/** One transcript unit (an agent lane), matched to a bead or not. Added for the Cost & cache tab; read-only, same data as `beads`. */
/** One model's share of a lane (or of everything): cost is per model, never the lane's total under its most-used model. */
export interface ModelUse { model: string; requests: number; input: number; output: number; cacheWrite: number; cacheRead: number; hitRate: number | null; costUsd: number | null; pricedUsd: number }
export interface LaneCostRow {
  /** Lane name = bead claim actor; "main session" for an unnamed lane (never a session id). */
  lane: string;
  beadId: string | null;
  model: string | null;
  input: number; output: number; cacheWrite: number; cacheRead: number;
  hitRate: number | null;
  requests: number;
  /** Dollars at list price, null when a model had no price (never a silent 0). */
  costUsd: number | null;
  pricedUsd: number;
  /** Models in this lane that have no price. */
  unpricedModels: string[];
  /** Per-model breakdown of this lane, biggest spend first. */
  models: ModelUse[];
  lastAt: number | null;
  /** Unexpected misses (a lane's first cold start is not counted) and the share caused by the cached prompt start changing. */
  misses: number; prefixBreaks: number;
}
/** One dated cache miss, newest first in `WorkTelemetry.missEvents`. */
export interface LaneMissEvent { at: number | null; lane: string; beadId: string | null; cause: Exclude<MissCause, "cold-start">; write: number; missShare: number; gapMs: number | null }
export interface TelemetryTotals {
  requests: number; input: number; output: number; cacheWrite: number; cacheRead: number;
  hitRate: number | null;
  /** Priced calls only. */
  costUsd: number;
  /** False when some model had no price, so costUsd is a lower bound. */
  costComplete: boolean;
  unpricedModels: string[];
  misses: number; prefixBreaks: number;
  /** Cost already joined to a bead. */
  joinedCostUsd: number;
}
export interface TelemetryFreshness {
  polledAt: number;
  filesSeen: number;
  newRows: number;
  /** True while older history is still being read (a per-poll byte or file bound was hit). */
  catchingUp: boolean;
  /** Records stepped over because one record was longer than a read. Optional: an older answer has none. */
  oversizedSkipped?: number;
}
export interface TelemetryCoverage { units: number; joined: number; unjoined: number; laneNamed: number; unmatched: { lane: string; reason: string }[] }
export interface WorkTelemetry {
  beads: BeadCostRow[];
  /** bead id -> dollars, only where the cost is fully known. Feeds the Factory cost heat. */
  costs: Record<string, number>;
  /** bead id -> the lane writing for it now (transcript-liveness window). Feeds the Factory "agent is working" signal. */
  transcriptLive: Record<string, { lane: string; lastAt: number }>;
  /** Bead ids on a critical path. */
  critical: string[];
  totals: TelemetryTotals;
  freshness: TelemetryFreshness;
  coverage: TelemetryCoverage;
  /** Per-lane rows (biggest spend first, bounded) and recent miss events. Optional: an older answer simply lacks them. */
  lanes?: LaneCostRow[];
  missEvents?: LaneMissEvent[];
  /** How many miss events exist before the list is capped, so the tab can say it shows the newest N of M. */
  missEventsTotal?: number;
  /** Every agent lane on this machine (live / idle / done), named, for the fleet count and call identity. Optional: an older answer lacks it. */
  fleet?: FleetSnapshot;
  /** Spend per model over EVERY unit in the window (not just the capped lane rows). */
  byModel?: ModelUse[];
  /** Token efficiency (D-140): context growth, cache churn, biggest tool outputs, repeated reads, model share, agents near a wrap. Optional: an older answer lacks it. */
  efficiency?: TokenEfficiency;
  /** Spend per LOCAL day over the whole 7-day read window (independent of the Calls range), oldest first. The Calendar's Spend kind reads it.
   *  Optional: an older answer lacks it. Days before the window are simply absent: the Calendar says "not captured", never $0. */
  byDay?: DaySpend[];
}
export type PollInfo = { polledAt: number; filesSeen: number; newRows: number; catchingUp: boolean; /** Records stepped over because one record was longer than a read (cumulative). */ oversizedSkipped?: number };

/** Usage older than this (the default `windowMs` of buildWorkTelemetry; the Calls range control passes a shorter one) (by the request's own timestamp, not the file's mtime) is left out of every number. Rows with no timestamp cannot be dated and are kept. */
export const WINDOW_MS = 7 * 86_400_000;
const MAX_UNMATCHED = 12, MAX_ROOTS = 40, MAX_LANES = 60, MAX_MISS_EVENTS = 40;
const REASON = { "no-lane-name": "no lane name (main session or unnamed agent)", "no-match": "no bead is assigned to this lane", ambiguous: "this lane holds more than one bead" } as const;
// td-osi.37: lane names here (cost lanes, miss events, beads, transcriptLive, coverage) are free text too: canonicalize, redact, then cap.
const name = (s: string | null | undefined, max = 64) => redactForDisplay(s ?? "", max).trim();
/** A lane's display name. An unnamed lane is "main:<sessionId>" inside the join: the id must never leave this file. */
const laneName = (lane: string): string => (lane.startsWith("main:") ? "main session" : name(lane));
const isMiss = <E extends { cause: MissCause }>(e: E): e is E & { cause: Exclude<MissCause, "cold-start"> } => e.cause !== "cold-start";
const modelUse = (rows: UsageRow[]): ModelUse[] => aggregate(rows, r => r.model ?? "unknown").map(u => ({
  model: name(u.key, 40), requests: u.requests, input: u.input, output: u.output, cacheWrite: u.cacheWrite5m + u.cacheWrite1h, cacheRead: u.cacheRead, hitRate: u.hitRate, costUsd: u.cost, pricedUsd: u.pricedCost,
}));
const prefixBreaks = (e: readonly { cause: string }[]) => e.filter(x => x.cause === "prefix-break").length;

/** Critical-path bead ids over every root (an issue with children and no parent): the timed critical chain, plus the longest blocks
 *  chain when it is a real chain of two or more. Closed beads are left out: the ring marks work still to do. */
export function criticalIds(issues: readonly WorkIssue[], deps: readonly WorkDep[], now: number): string[] {
  const parents = new Set<string>();
  for (const i of issues) if (i.parent) parents.add(i.parent);
  for (const d of deps) if (d.type === "parent-child") parents.add(d.dependsOnId);
  const status = new Map(issues.map(i => [i.id, i.status]));
  const roots = issues.filter(i => !i.parent && parents.has(i.id)).sort((a, b) => (a.status === "closed" ? 1 : 0) - (b.status === "closed" ? 1 : 0) || (a.id < b.id ? -1 : 1)).slice(0, MAX_ROOTS);
  const out = new Set<string>();
  for (const r of roots) {
    const c = criticalSteps(r.id, issues, deps, { now });
    for (const id of c.weightedPath) out.add(id);
    if (c.plannedPath.length >= 2) for (const id of c.plannedPath) out.add(id);
  }
  return [...out].filter(id => status.get(id) !== "closed").sort();
}

/** The same request can sit in several transcript files (a copied or forked session directory). A request id is unique per API call, so a
 *  row already seen in an EARLIER unit is dropped from the later one; rows with no id cannot be matched and stay. Streaming repeats inside ONE
 *  unit are left for aggregate's own dedupe. Units left with no rows disappear, so lanes, totals, models, beads and misses all count each call once. */
export function dedupeUnits(units: readonly TelemetryUnit[]): TelemetryUnit[] {
  const seen = new Set<string>(), out: TelemetryUnit[] = [];
  for (const u of units) {
    const mine = new Set<string>(), rows = u.rows.filter(r => { const k = rowKey(r); if (k === null) return true; mine.add(k); return !seen.has(k); });
    for (const k of mine) seen.add(k);
    if (rows.length) out.push({ ...u, rows });
  }
  return out;
}

/** Units + beads -> everything the Factory, the Board and the observer show. `units` come from unitsFromState. */
export function buildWorkTelemetry(rawUnits: readonly TelemetryUnit[], issues: readonly WorkIssue[], deps: readonly WorkDep[], now: number, poll: PollInfo, fleetIn?: Omit<FleetInput, "beadByKey">, windowMs: number = WINDOW_MS, toolUnits: readonly EffToolUnit[] = []): WorkTelemetry {
  const units = dedupeUnits(rawUnits);
  const inWindow = (r: UsageRow) => r.timestamp === null || !Number.isFinite(r.timestamp) || now - r.timestamp <= windowMs;
  // Totals, cost and the lane list use only the window. Miss CLASSIFICATION uses the full history (a cut at the window edge would restart the
  // warm-up and turn a real prefix break into a "cold start"), and only the events it reports are then limited to the window.
  const idx: number[] = [], us: TelemetryUnit[] = [];
  units.forEach((u, i) => { const rows = u.rows.filter(inWindow); if (rows.length) { idx.push(i); us.push({ ...u, rows }); } });
  const refs = issues.map(i => ({ id: i.id, assignee: i.assignee }));
  const join = joinUnitsToWork(us, refs, []), full = joinUnitsToWork([...units], refs, []);
  const inWinEvent = <E extends { timestamp: number | null }>(e: E) => e.timestamp === null || !Number.isFinite(e.timestamp) || now - e.timestamp <= windowMs;
  // A bead's misses are the sum of its units' own classified events. full.byBead classifies the merged rows, which lets a fresh lane's
  // cold start borrow an older lane's warm-up and read as a prefix break.
  const beadMiss = new Map<string, MissEvent[]>();
  for (const l of full.byLane) if (l.beadId) beadMiss.set(l.beadId, [...(beadMiss.get(l.beadId) ?? []), ...l.missEvents.filter(inWinEvent)]);
  const laneMissOf = (i: number) => full.byLane[idx[i]].missEvents.filter(inWinEvent);
  // byLane[i] is units[i]: recover each joined unit's newest row time to say when its bead was last written for.
  const lastOfUnit = us.map(u => u.rows.reduce<number | null>((m, r) => (r.timestamp !== null && Number.isFinite(r.timestamp) && (m === null || r.timestamp > m) ? r.timestamp : m), null));
  const lastByBead = new Map<string, { at: number; lane: string }>();
  join.byLane.forEach((l, i) => {
    const at = lastOfUnit[i];
    if (!l.beadId || at === null) return;
    const had = lastByBead.get(l.beadId);
    if (!had || at > had.at) lastByBead.set(l.beadId, { at, lane: l.lane });
  });
  const beads: BeadCostRow[] = join.byBead.map(b => {
    const last = lastByBead.get(b.beadId);
    return {
      beadId: name(b.beadId), lane: last ? laneName(last.lane) : b.lanes[0] ? laneName(b.lanes[0]) : null,
      costUsd: b.cost, pricedUsd: b.pricedCost, hitRate: b.hitRate, requests: b.requests, missTokens: b.missTokens,
      misses: (beadMiss.get(b.beadId) ?? []).filter(e => e.cause !== "cold-start").length, prefixBreaks: prefixBreaks(beadMiss.get(b.beadId) ?? []),
      lastAt: last?.at ?? null, model: b.model ? name(b.model, 40) : null,
    };
  });
  const costs: Record<string, number> = {};
  for (const b of beads) if (b.costUsd !== null) costs[b.beadId] = b.costUsd;

  const all = aggregate(us.flatMap(u => u.rows), () => "all")[0];
  const joinedCostUsd = beads.reduce((s, b) => s + b.pricedUsd, 0);
  const allMiss = us.flatMap((_, i) => laneMissOf(i));
  const totals: TelemetryTotals = all
    ? { requests: all.requests, input: all.input, output: all.output, cacheWrite: all.cacheWrite5m + all.cacheWrite1h, cacheRead: all.cacheRead, hitRate: all.hitRate, costUsd: all.pricedCost, costComplete: all.cost !== null, unpricedModels: all.unpricedModels.map(m => name(m, 40)), misses: allMiss.filter(e => e.cause !== "cold-start").length, prefixBreaks: prefixBreaks(allMiss), joinedCostUsd }
    : { requests: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, hitRate: null, costUsd: 0, costComplete: true, unpricedModels: [], misses: 0, prefixBreaks: 0, joinedCostUsd: 0 };

  const live: WorkTelemetry["transcriptLive"] = {};
  for (const [id, v] of transcriptLiveByBead(join.byLane, activityFromUnits(us), now)) live[name(id)] = { lane: name(v.lane), lastAt: v.lastAt };

  const bySpend = (a: ModelUse, b: ModelUse) => b.pricedUsd - a.pricedUsd || (a.model < b.model ? -1 : 1);
  const laneModels = (i: number) => modelUse(us[i].rows).sort(bySpend);
  const laneRows: LaneCostRow[] = join.byLane.map((l, i) => ({
    lane: laneName(l.lane), beadId: l.beadId ? name(l.beadId) : null, model: l.model ? name(l.model, 40) : null,
    input: l.input, output: l.output, cacheWrite: l.cacheWrite, cacheRead: l.cacheRead, hitRate: l.hitRate, requests: l.requests,
    costUsd: l.cost, pricedUsd: l.pricedCost, unpricedModels: laneModels(i).filter(m => m.costUsd === null).map(m => m.model), models: laneModels(i),
    lastAt: lastOfUnit[i], misses: laneMissOf(i).filter(e => e.cause !== "cold-start").length, prefixBreaks: prefixBreaks(laneMissOf(i)),
  })).sort((a, b) => b.pricedUsd - a.pricedUsd || (a.lane < b.lane ? -1 : 1)).slice(0, MAX_LANES);
  const allMissEvents: LaneMissEvent[] = join.byLane.flatMap((l, i) => laneMissOf(i).flatMap(e => !isMiss(e) ? [] : [{
    at: e.timestamp, lane: laneName(l.lane), beadId: l.beadId ? name(l.beadId) : null,
    cause: e.cause, write: e.write, missShare: e.missShare, gapMs: e.gapMs,
  }])).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const missEvents = allMissEvents.slice(0, MAX_MISS_EVENTS);

  // Lane key (what a tool call carries as sessionId) -> bead: a subagent is keyed by its agentId, a main session by its session id.
  const beadByKey = new Map<string, string>();
  for (const l of join.byLane) if (l.beadId) beadByKey.set(l.agentId ?? l.sessionId, l.beadId);
  const fleet = fleetIn ? buildFleet({ ...fleetIn, beadByKey }, now) : undefined;

  return {
    ...(fleet ? { fleet } : {}),
    efficiency: buildTokenEfficiency(us, toolUnits, now, windowMs),
    byDay: buildSpendDays(units, now, WINDOW_MS, u => (u.lane ? name(u.lane) : "main session")),
    lanes: laneRows, missEvents, missEventsTotal: allMissEvents.length, byModel: modelUse(us.flatMap(u => u.rows)).sort((a, b) => b.pricedUsd - a.pricedUsd || (a.model < b.model ? -1 : 1)),
    beads, costs, transcriptLive: live, critical: criticalIds(issues, deps, now), totals,
    freshness: { polledAt: poll.polledAt, filesSeen: poll.filesSeen, newRows: poll.newRows, catchingUp: poll.catchingUp, oversizedSkipped: poll.oversizedSkipped ?? 0 },
    coverage: {
      units: join.coverage.lanes, joined: join.coverage.matched, unjoined: join.coverage.lanes - join.coverage.matched, laneNamed: join.coverage.laneNamed,
      unmatched: [...join.unmatched].sort((a, b) => Number(!a.lane) - Number(!b.lane)).slice(0, MAX_UNMATCHED).map(u => ({ lane: u.lane ? name(u.lane) : "main session", reason: REASON[u.reason] })),
    },
  };
}

export interface TelemetryMaps {
  costs: ReadonlyMap<string, number>;
  critical: ReadonlySet<string>;
  transcriptLive: ReadonlyMap<string, { lane: string; lastAt: number }>;
}
/** The three inputs FactoryFloor takes, from one answer. Null in, null out: a missing answer must read "not connected", never "free". */
export function telemetryMaps(t: WorkTelemetry | null): TelemetryMaps | null {
  return t ? { costs: new Map(Object.entries(t.costs)), critical: new Set(t.critical), transcriptLive: new Map(Object.entries(t.transcriptLive)) } : null;
}

// ---- plain-English text for the observer's cost and cache cards (pure, so the words are tested) ----
export const compactCount = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
const pctText = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(0)}%`);
export const ageText = (ms: number) => (ms < 1000 ? "just now" : ms < 60_000 ? `${Math.round(ms / 1000)}s ago` : `${Math.round(ms / 60_000)} min ago`);
export interface TelemetryCards {
  tokens: { value: string; sub: string };
  cost: { value: string; sub: string };
  cache: { value: string; sub: string };
  misses: { value: string; sub: string };
  freshness: { value: string; sub: string };
}
/** What the Cost cards say. Cost is an estimate at list price, and a lower bound while any model has no price. */
export function telemetryCards(t: WorkTelemetry, now: number): TelemetryCards {
  const a = t.totals, f = t.freshness, c = t.coverage;
  return {
    tokens: { value: `${compactCount(a.input + a.cacheWrite + a.cacheRead)} in · ${compactCount(a.output)} out`, sub: `${a.requests} calls · ${compactCount(a.cacheRead)} read from cache` },
    cost: { value: `${a.costComplete ? "" : "at least "}${usd(a.costUsd)}`, sub: a.costComplete ? `estimate at list price · ${usd(a.joinedCostUsd)} matched to beads` : `estimate at list price · no price for ${a.unpricedModels.join(", ") || "a model"}` },
    cache: { value: pctText(a.hitRate), sub: "share of input read from cache; higher is cheaper" },
    misses: { value: `${a.misses}`, sub: `${a.prefixBreaks} because the cached start of the prompt changed` },
    freshness: { value: f.polledAt ? `read ${ageText(Math.max(0, now - f.polledAt))}` : "not read yet", sub: `${f.filesSeen} transcript files · ${c.joined} of ${c.units} agents matched to a bead${f.catchingUp ? " · still reading older history" : ""}` },
  };
}
