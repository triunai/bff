// Model of the Calls "Cost & cache" tab (pure, no React): the workTelemetry answer -> header cards, a sortable per-lane table with
// highlight flags, a miss-event list and the coverage note. No second poller or join: the ONE answer is useWorkTelemetry's, built by
// telemetry-model.ts. Every number comes from the answer; a missing price reads "unpriced model: <name>", never a blank or a $0.
import { criticalSteps } from "./critical-steps.ts";
import { QUEST_STATES, boardQuests, questLabel } from "./lane-state.ts";
import type { QuestState } from "./lane-state.ts";
import { formatDuration } from "./flow-metrics.ts";
import { boardCards } from "./surface-model.ts";
import type { WorkSurfaceSnapshot } from "./surface-types.ts";
import { ageText, compactCount } from "./telemetry-model.ts";
import type { BeadCostRow, LaneCostRow, LaneMissEvent, ModelUse, WorkTelemetry } from "./telemetry-model.ts";

/** Date of the built-in price list (cache-economics.ts PRICES: "Anthropic list prices, 2026-10-06"). */
export const PRICE_TABLE_DATE = "2026-10-06";
/** buildWorkTelemetry drops every usage row older than WINDOW_MS by the request's own timestamp, so every total covers this window. */
export const WINDOW_LABEL = "last 7 days";
/** A lane is "expensive" at or above this estimate, and "low reuse" below this hit share once it has enough calls to mean something. */
export const EXPENSIVE_USD = 5;
export const LOW_HIT_RATE = 0.6;
export const LOW_HIT_MIN_REQUESTS = 10;

export const MISS_EXPLAIN: Readonly<Record<LaneMissEvent["cause"], string>> = {
  "prefix-break": "The start of the prompt changed, so the cache could not be reused and the whole prompt was re-sent. Agents stay cheap when the start of the prompt is byte-for-byte stable and new text is only ever added at the end (the stable prefix rule).",
  "ttl-expiry": "The agent paused longer than the cache lives, so the saved prompt expired and had to be re-sent. Not a prompt problem.",
};
export const MISS_LABEL: Readonly<Record<LaneMissEvent["cause"], string>> = { "prefix-break": "prompt start changed", "ttl-expiry": "cache expired" };

export type SortKey = "bead" | "lane" | "model" | "tokensIn" | "tokensOut" | "hitRate" | "cost" | "lastAt" | "misses";
export type SortDir = "asc" | "desc";
export interface CostCard { title: string; value: string; sub: string; hint: string }
export interface LaneView {
  lane: string; beadId: string | null; model: string | null;
  /** Everything sent in: fresh input + cache writes + cache reads. */
  tokensIn: number; tokensOut: number;
  /** Display text: "n/a" when any part was unavailable, instead of a partial sum or 0 (the numbers above are only the sort keys). */
  tokensInText: string; tokensOutText: string;
  hitRate: number | null;
  /** Priced calls only, always a number (the sort key). */
  pricedUsd: number;
  costText: string;
  /** Set when a model has no price: the row says so instead of showing a blank. */
  unpriced: string | null;
  lastAt: number | null; misses: number; prefixBreaks: number; requests: number;
  expensive: boolean; lowReuse: boolean;
}
export interface MissView { at: number | null; lane: string; beadId: string | null; cause: LaneMissEvent["cause"]; label: string; explain: string; detail: string }
export interface CostCacheView {
  cards: CostCard[];
  rows: LaneView[];
  misses: MissView[];
  coverageNote: string;
  unpricedNote: string | null;
  /** Says the read is incomplete (still reading older history, or an oversized record was skipped); null when complete. The tab must not claim zero then. */
  readNote: string | null;
  /** "showing the newest N of M" when the miss list is capped, else null. */
  missesNote: string | null;
  /** "showing the biggest N of M agents" when the answer's lane list is capped, else null. */
  lanesNote: string | null;
  /** True when the answer has no per-lane rows (an older server): the tab then says so instead of an empty table. */
  noLaneData: boolean;
}

const DASH = "—", NA = "n/a";
/** A value that crossed JSON can be null (NaN and Infinity become null) and a bad price can make a number non-finite: say "n/a", never throw. */
const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const safe = (n: unknown): number => (fin(n) ? n : 0);
export const usdText = (n: number | null): string => (fin(n) ? `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}` : NA);
export const pctText = (r: number | null): string => (r === null ? DASH : fin(r) ? `${(r * 100).toFixed(0)}%` : NA);
/** Sum of token counts as text, or "n/a" when any part is unavailable. */
export const sumText = (...parts: unknown[]): string => (parts.every(fin) && fin((parts as number[]).reduce((a, b) => a + b, 0)) ? compactCount((parts as number[]).reduce((a, b) => a + b, 0)) : NA);
export const countText = (n: number | null): string => (fin(n) ? compactCount(n) : NA);

export function laneView(r: LaneCostRow): LaneView {
  const unpriced = r.costUsd === null ? (r.unpricedModels.join(", ") || r.model || "unknown model") : null;
  return {
    lane: r.lane, beadId: r.beadId, model: r.model,
    tokensIn: safe(r.input) + safe(r.cacheWrite) + safe(r.cacheRead), tokensOut: safe(r.output),
    tokensInText: sumText(r.input, r.cacheWrite, r.cacheRead), tokensOutText: sumText(r.output), hitRate: fin(r.hitRate) ? r.hitRate : null, pricedUsd: safe(r.pricedUsd),
    costText: !fin(r.pricedUsd) ? NA : unpriced === null ? usdText(r.pricedUsd) : `at least ${usdText(r.pricedUsd)}`, unpriced,
    lastAt: r.lastAt, misses: r.misses, prefixBreaks: r.prefixBreaks, requests: r.requests,
    expensive: r.pricedUsd >= EXPENSIVE_USD,
    lowReuse: r.hitRate !== null && r.hitRate < LOW_HIT_RATE && r.requests >= LOW_HIT_MIN_REQUESTS,
  };
}

const text = (a: string | null, b: string | null) => (a ?? "").localeCompare(b ?? "");
const num = (a: number | null, b: number | null) => (a ?? -1) - (b ?? -1);
const COMPARE: Record<SortKey, (a: LaneView, b: LaneView) => number> = {
  bead: (a, b) => text(a.beadId, b.beadId), lane: (a, b) => text(a.lane, b.lane), model: (a, b) => text(a.model, b.model),
  tokensIn: (a, b) => a.tokensIn - b.tokensIn, tokensOut: (a, b) => a.tokensOut - b.tokensOut,
  hitRate: (a, b) => num(a.hitRate, b.hitRate), cost: (a, b) => a.pricedUsd - b.pricedUsd,
  lastAt: (a, b) => num(a.lastAt, b.lastAt), misses: (a, b) => a.misses - b.misses,
};
/** Stable sort; a missing value (no hit rate, never active) always sorts as the smallest, and ties fall back to the lane name. */
export function sortRows(rows: readonly LaneView[], key: SortKey, dir: SortDir): LaneView[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => sign * COMPARE[key](a, b) || a.lane.localeCompare(b.lane));
}
/** Click on a column: the same column flips direction, a new column starts at its natural direction (text ascending, numbers descending). */
export function nextSort(cur: { key: SortKey; dir: SortDir }, key: SortKey): { key: SortKey; dir: SortDir } {
  if (cur.key === key) return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "bead" || key === "lane" || key === "model" ? "asc" : "desc" };
}

/** Incomplete-read wording. An incomplete read means every number below is a lower bound, never "nothing happened". */
export function readNoteOf(t: WorkTelemetry): string | null {
  const f = t.freshness, parts: string[] = [];
  if (f.catchingUp) parts.push("still reading older transcripts");
  if (f.oversizedSkipped) parts.push(`${f.oversizedSkipped} oversized record${f.oversizedSkipped === 1 ? " was" : "s were"} skipped`);
  return parts.length ? `Incomplete read: ${parts.join(" · ")}. Numbers below may be too low.` : null;
}
/** `windowLabel` names the range the answer was built for ("today", "last 30 days"); default is the 7-day window. */
export function costCacheView(t: WorkTelemetry, windowLabel: string = WINDOW_LABEL): CostCacheView {
  const a = t.totals, c = t.coverage;
  const cards: CostCard[] = [
    { title: "Estimated spend", value: `${a.costComplete || !fin(a.costUsd) ? "" : "at least "}${usdText(a.costUsd)}`, sub: `${windowLabel} · ${a.requests} calls · price list ${PRICE_TABLE_DATE}`, hint: "Priced from a built-in list of public prices, not from a bill. The window is the transcripts Osiris reads, which is the last 7 days, not just today." },
    { title: "Cache reuse", value: pctText(a.hitRate), sub: `read from cache ÷ all input · n=${a.requests} calls`, hint: "How much of what the agents sent in was read back from the cache instead of sent fresh. Higher is cheaper." },
    { title: "Sent fresh", value: countText(a.input), sub: "input tokens the cache did not serve", hint: "Uncached input tokens: new text the model had to read at full price." },
    { title: "Cache writes", value: countText(a.cacheWrite), sub: `${countText(a.cacheRead)} read back`, hint: "Tokens saved into the cache. Writing costs more than reading, so many writes with few reads means the cache is not paying off." },
    { title: "Prompt-start breaks", value: String(a.prefixBreaks), sub: `${a.misses} unexpected misses in all · ${windowLabel}`, hint: MISS_EXPLAIN["prefix-break"] },
  ];
  const lanes = t.lanes ?? [];
  const unpriced = a.unpricedModels.length ? `unpriced model: ${a.unpricedModels.join(", ")} (spend is a lower bound)` : null;
  return {
    cards,
    rows: lanes.map(laneView),
    misses: (t.missEvents ?? []).map(e => ({
      at: e.at, lane: e.lane, beadId: e.beadId, cause: e.cause, label: MISS_LABEL[e.cause], explain: MISS_EXPLAIN[e.cause],
      detail: `${countText(e.write)} tokens re-written · ${pctText(e.missShare)} of the input missed${e.gapMs !== null ? ` · ${ageText(e.gapMs).replace(" ago", "")} since the last call` : ""}`,
    })),
    coverageNote: `matched ${c.joined} of ${c.units} lanes to a work item${c.unjoined ? ` · ${c.unjoined} not matched` : ""}`,
    unpricedNote: unpriced,
    readNote: readNoteOf(t),
    missesNote: t.missEvents && t.missEventsTotal !== undefined && t.missEventsTotal > t.missEvents.length ? `showing the newest ${t.missEvents.length} of ${t.missEventsTotal}` : null,
    lanesNote: lanes.length > 0 && c.units > lanes.length ? `showing the ${lanes.length} biggest of ${c.units} agents` : null,
    noLaneData: t.lanes === undefined,
  };
}

/** "3 min ago" / "—" for a lane's last activity. */
export const lastActivityText = (at: number | null, now: number): string => (at === null ? DASH : ageText(Math.max(0, now - at)));

// ---- $ per model and per work item, and the two fleet panels from the work snapshot (Kimi critical steps, Qoder quest states) ----
export interface ModelSpend { model: string; usd: number; costText: string; unpriced: boolean; requests: number; tokensIn: number; tokensOut: number; tokensInText: string; tokensOutText: string; hitRate: number | null }
/** Spend per model over every request in the window (the answer's byModel): each model carries its own cost and hit rate. Biggest first. */
export function spendByModel(byModel: readonly ModelUse[]): ModelSpend[] {
  return byModel.map(m => ({
    model: m.model, usd: safe(m.pricedUsd), unpriced: m.costUsd === null, requests: m.requests, tokensIn: safe(m.input) + safe(m.cacheWrite) + safe(m.cacheRead), tokensOut: safe(m.output), tokensInText: sumText(m.input, m.cacheWrite, m.cacheRead), tokensOutText: sumText(m.output), hitRate: fin(m.hitRate) ? m.hitRate : null,
    costText: !fin(m.pricedUsd) ? NA : m.costUsd === null ? `at least ${usdText(m.pricedUsd)}` : usdText(m.pricedUsd),
  })).sort((a, b) => b.usd - a.usd || a.model.localeCompare(b.model));
}
export interface BeadSpend { beadId: string; lane: string | null; model: string | null; costText: string; usd: number; unpriced: boolean; hitRate: number | null; misses: number }
/** Spend per work item, biggest first (the answer's `beads` rows, already joined by claim name). */
export function spendByBead(beads: readonly BeadCostRow[]): BeadSpend[] {
  return beads.map(b => ({ beadId: b.beadId, lane: b.lane, model: b.model, usd: safe(b.pricedUsd), unpriced: b.costUsd === null, costText: !fin(b.pricedUsd) ? NA : b.costUsd === null ? `at least ${usdText(b.pricedUsd)}` : usdText(b.pricedUsd), hitRate: fin(b.hitRate) ? b.hitRate : null, misses: b.misses }))
    .sort((a, b) => b.usd - a.usd || a.beadId.localeCompare(b.beadId));
}

export interface FleetSummary {
  quests: { state: QuestState; label: string; count: number }[];
  /** Longest chain of dependent work in any one open epic versus all work across the open epics. Null when no epic has timed work. */
  critical: { pathText: string; totalText: string; parallelism: number | null; serialEpics: number; steps: number; epics: number } | null;
}
const MAX_EPICS = 40;
/** Qoder quest-state counts (the existing boardQuests) and Kimi critical steps (the existing criticalSteps) over the tracker snapshot. */
export function fleetSummary(snap: WorkSurfaceSnapshot, now: number): FleetSummary {
  const states = boardQuests(snap, boardCards(snap, now), now), counts = new Map<QuestState, number>();
  for (const st of states.values()) counts.set(st, (counts.get(st) ?? 0) + 1);
  const parents = new Set<string>();
  for (const i of snap.issues) if (i.parent) parents.add(i.parent);
  for (const d of snap.deps) if (d.type === "parent-child") parents.add(d.dependsOnId);
  const roots = snap.issues.filter(i => !i.parent && parents.has(i.id) && i.status !== "closed").sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, MAX_EPICS);
  let path = -1, total = 0, steps = 0, timed = 0, serial = 0;
  for (const r of roots) {
    const c = criticalSteps(r.id, snap.issues, snap.deps, { now });
    if (!c.timed.length) continue;
    // Epics are independent chains, so the fleet's critical path is the LONGEST ONE; summing them would call two parallel epics one chain.
    // The step count travels with the chosen path (its own number of tasks), never the maximum from some other epic.
    timed++; total += c.totalWork; if (c.weightedCritical > path) { path = c.weightedCritical; steps = c.weightedPath.length; } if (c.serialCollapse) serial++;
  }
  return {
    quests: QUEST_STATES.map(state => ({ state, label: questLabel(state), count: counts.get(state) ?? 0 })),
    critical: timed ? { pathText: formatDuration(path), totalText: formatDuration(total), parallelism: path > 0 ? total / path : null, serialEpics: serial, steps, epics: timed } : null,
  };
}
