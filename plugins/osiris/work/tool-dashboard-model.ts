// Tool dashboard model (pure, takes `now`): the numbers behind the Calls panel's full dashboard. KPI strip, outcome pulse strip,
// Sentry-style incident rows, per-tool latency with a histogram, and filter chips. It reuses reduceIncidents / totals / identityOf; it
// never groups, joins or polls on its own. PRIVACY: tool names, statuses, normalized error codes, timestamps and numbers only.
import type { Call } from "../analytics.ts";
import { callKey } from "../analytics.ts";
import { humanDuration } from "../live-observer.ts";
import type { Incident } from "../triage.ts";
import type { FleetSnapshot } from "./fleet-types.ts";
import { identityOf } from "./call-identity.ts";
import type { FleetIndex } from "./call-identity.ts";
import { clampWindow, clockLabel } from "./call-timeline-model.ts";
import { runCost, usdPerCallText } from "./call-cost.ts";

export type TimeWindow = { t0: number; t1: number } | null;
export type Outcome = "success" | "failure" | "attention" | "running";
export const MIN_P95_SAMPLES = 20;
export const HOUR_MS = 3_600_000;
export const SPARK_BUCKETS = 12;
export const SPARK_SPAN_MS = 24 * HOUR_MS;

export const callTime = (c: Call): number | null => c.endedAt ?? c.startedAt ?? null;
/** error/denied = failure; unknown/cancelled = attention (a capture gap or a stop, never a failure); running stays running. */
export const outcomeOf = (c: Call): Outcome => c.status === "success" ? "success" : c.status === "error" || c.status === "denied" ? "failure" : c.status === "running" ? "running" : "attention";

/** Calls inside the window. A call with no timestamp is kept only when there is no window (it cannot be placed). */
export function inWindow(calls: readonly Call[], w: TimeWindow): Call[] {
  if (!w) return [...calls];
  return calls.filter(c => { const t = callTime(c); return t !== null && t >= w.t0 && t <= w.t1; });
}
/** Full time span of the calls, padded to at least one minute; null when nothing has a timestamp. */
export function domainOf(calls: readonly Call[]): { t0: number; t1: number } | null {
  let lo = Infinity, hi = -Infinity;
  for (const c of calls) { const t = callTime(c); if (t === null) continue; if (t < lo) lo = t; if (t > hi) hi = t; }
  if (lo === Infinity) return null;
  return hi - lo < 60_000 ? { t0: lo, t1: lo + 60_000 } : { t0: lo, t1: hi };
}

const percentile = (sorted: number[], p: number) => sorted[Math.ceil(sorted.length * p) - 1];
const durations = (calls: readonly Call[]) => calls.flatMap(c => c.durationMs === null ? [] : [c.durationMs]).sort((a, b) => a - b);

export interface Kpis {
  /** null = this server sent no agent list (older server / no tracker). Never a zero. */
  liveAgents: number | null;
  callsPerMin: number | null;
  calls: number;
  errors: number;
  decided: number;
  errorRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  samples: number;
  /** True when there are too few timed calls for a 95th percentile (it would just be the maximum). */
  p95TooFew: boolean;
  burnUsdPerHour: number | null;
  burnNote: string;
}
export function kpis(calls: readonly Call[], window: TimeWindow, fleet?: FleetSnapshot | null): Kpis {
  const scoped = inWindow(calls, window);
  const span = window ? window.t1 - window.t0 : (domainOf(scoped) ? domainOf(scoped)!.t1 - domainOf(scoped)!.t0 : 0);
  const minutes = Math.max(1, span / 60_000);
  let errors = 0, success = 0;
  for (const c of scoped) { if (c.status === "error") errors++; else if (c.status === "success") success++; }
  const decided = errors + success, ds = durations(scoped);
  return {
    liveAgents: fleet ? fleet.summary.live : null,
    callsPerMin: scoped.length ? scoped.length / minutes : null,
    calls: scoped.length, errors, decided, errorRate: decided ? errors / decided : null,
    p50Ms: ds.length ? percentile(ds, .5) : null,
    p95Ms: ds.length >= MIN_P95_SAMPLES ? percentile(ds, .95) : null,
    samples: ds.length, p95TooFew: ds.length < MIN_P95_SAMPLES,
    burnUsdPerHour: fleet?.summary.burnUsdPerHour ?? null,
    burnNote: fleet ? "list-price estimate, last hour" : "no agent list from this server",
  };
}

export interface PulseBucket { t0: number; success: number; failure: number; attention: number; running: number; total: number }
export interface Pulse { t0: number; t1: number; bucketMs: number; buckets: PulseBucket[]; max: number }
export function pulse(calls: readonly Call[], domain: { t0: number; t1: number }, buckets = 60): Pulse {
  const span = Math.max(1, domain.t1 - domain.t0), bucketMs = span / buckets;
  const out: PulseBucket[] = Array.from({ length: buckets }, (_, i) => ({ t0: domain.t0 + i * bucketMs, success: 0, failure: 0, attention: 0, running: 0, total: 0 }));
  for (const c of calls) {
    const t = callTime(c);
    if (t === null || t < domain.t0 || t > domain.t1) continue;
    const b = out[Math.min(buckets - 1, Math.floor((t - domain.t0) / bucketMs))];
    b[outcomeOf(c)]++; b.total++;
  }
  return { t0: domain.t0, t1: domain.t1, bucketMs, buckets: out, max: Math.max(0, ...out.map(b => b.total)) };
}

export type IncidentState = "new" | "escalating" | "ongoing";
export type IncidentSort = "last" | "first" | "events";
export interface IncidentRow {
  fingerprint: string; title: string; tool: string; error: string; count: number;
  agentCount: number; agentNames: string[]; agentsMore: number; workspace: string;
  firstSeen: number | null; lastSeen: number | null; firstText: string; lastText: string;
  spark: number[]; state: IncidentState; lastHour: number; prevHour: number;
}
export const ageText = (ms: number): string => {
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};
/** New = first seen under an hour ago. Escalating = more than twice as many in the last hour as the hour before, and at least 3.
 * Escalating wins over new (a new incident that is already bursting is the more urgent thing to say). Otherwise ongoing. */
export function incidentState(firstSeen: number | null, lastHour: number, prevHour: number, now: number): IncidentState {
  if (lastHour >= 3 && lastHour > 2 * prevHour) return "escalating";
  if (firstSeen !== null && now - firstSeen < HOUR_MS) return "new";
  return "ongoing";
}
export function incidentRows(incidents: readonly Incident[], calls: readonly Call[], now: number, sort: IncidentSort = "last"): IncidentRow[] {
  const byKey = new Map(calls.map(c => [callKey(c), c]));
  const bucketMs = SPARK_SPAN_MS / SPARK_BUCKETS;
  const rows = incidents.map((inc): IncidentRow => {
    const spark = new Array<number>(SPARK_BUCKETS).fill(0);
    let lastHour = 0, prevHour = 0;
    for (const k of inc.callKeys) {
      const c = byKey.get(k), t = c ? callTime(c) : null;
      if (t === null) continue;
      const age = now - t;
      if (age >= 0 && age < HOUR_MS) lastHour++; else if (age >= HOUR_MS && age < 2 * HOUR_MS) prevHour++;
      if (age >= 0 && age < SPARK_SPAN_MS) spark[SPARK_BUCKETS - 1 - Math.floor(age / bucketMs)]++;
    }
    return {
      fingerprint: inc.fingerprint, title: `${inc.tool} · ${inc.error}`, tool: inc.tool, error: inc.error, count: inc.count,
      agentCount: inc.agents.length, agentNames: inc.agents.slice(0, 3), agentsMore: Math.max(0, inc.agents.length - 3),
      workspace: inc.workspace === "workspace:unmapped" ? "workspace unknown" : inc.workspace,
      firstSeen: inc.firstSeen, lastSeen: inc.lastSeen,
      firstText: inc.firstSeen === null ? "unknown" : ageText(Math.max(0, now - inc.firstSeen)),
      lastText: inc.lastSeen === null ? "unknown" : ageText(Math.max(0, now - inc.lastSeen)),
      spark, state: incidentState(inc.firstSeen, lastHour, prevHour, now), lastHour, prevHour,
    };
  });
  const num = (n: number | null, fallback: number) => n ?? fallback;
  return rows.sort((a, b) =>
    (sort === "events" ? b.count - a.count : sort === "first" ? num(b.firstSeen, -Infinity) - num(a.firstSeen, -Infinity) : num(b.lastSeen, -Infinity) - num(a.lastSeen, -Infinity))
    || b.count - a.count || (a.fingerprint < b.fingerprint ? -1 : 1));
}

export const HIST_EDGES_MS = [100, 1_000, 5_000, 30_000, 120_000] as const;
export const HIST_LABELS = ["<100 ms", "<1 s", "<5 s", "<30 s", "<2 min", "2 min+"] as const;
export interface LatencyRow {
  tool: string; calls: number; errors: number; samples: number;
  p50Ms: number | null; p95Ms: number | null; p95TooFew: boolean;
  histogram: number[]; callShare: number; errorShare: number;
  /** List-price estimate from the calls that carry token counts (call-cost.ts, the same price table as Cost & cache); null = n/a. */
  costUsd: number | null;
  /** Some calls of this tool carried no token counts, so costUsd is a lower bound. */
  costPartial: boolean;
}
export function latencyRows(calls: readonly Call[]): LatencyRow[] {
  const groups = new Map<string, Call[]>();
  for (const c of calls) { const g = groups.get(c.tool); if (g) g.push(c); else groups.set(c.tool, [c]); }
  const totalErrors = calls.filter(c => c.status === "error").length;
  return [...groups].map(([tool, cs]): LatencyRow => {
    const rc = runCost(cs), ds = durations(cs), histogram = new Array<number>(HIST_LABELS.length).fill(0);
    for (const d of ds) { let i = HIST_EDGES_MS.findIndex(e => d < e); if (i < 0) i = HIST_EDGES_MS.length; histogram[i]++; }
    const errors = cs.filter(c => c.status === "error").length;
    return {
      tool, calls: cs.length, errors, samples: ds.length,
      p50Ms: ds.length ? percentile(ds, .5) : null,
      p95Ms: ds.length >= MIN_P95_SAMPLES ? percentile(ds, .95) : null, p95TooFew: ds.length < MIN_P95_SAMPLES,
      histogram, callShare: calls.length ? cs.length / calls.length : 0, errorShare: totalErrors ? errors / totalErrors : 0,
      costUsd: rc.usd, costPartial: rc.usd !== null && rc.uncounted > 0,
    };
  }).sort((a, b) => b.calls - a.calls || (a.tool < b.tool ? -1 : 1));
}
/** "n/a" when no call of the tool carried priced token counts: never $0. A partial sum reads "at least". */
export const toolCostText = (r: Pick<LatencyRow, "costUsd" | "costPartial">): string => (r.costUsd === null ? "n/a" : `${r.costPartial ? "at least " : ""}${usdPerCallText(r.costUsd)}`);
export const msText = (ms: number | null): string => ms === null ? "—" : humanDuration(ms);

export type ChipKind = "model" | "role" | "workspace" | "outcome";
export interface Chip { kind: ChipKind; value: string }
export interface ChipCount extends Chip { label: string; count: number }
export const UNKNOWN_CHIP = "unknown";
const OUTCOME_LABEL: Record<Outcome, string> = { success: "Succeeded", failure: "Failed", attention: "Needs a look", running: "Running" };
const chipValue = (c: Call, kind: ChipKind, index: FleetIndex): string => {
  if (kind === "outcome") return outcomeOf(c);
  const id = identityOf(c, index);
  return (kind === "model" ? id.modelLetter : kind === "role" ? id.role : id.workspace) ?? UNKNOWN_CHIP;
};
export function chipCounts(calls: readonly Call[], index: FleetIndex): ChipCount[] {
  const counts = new Map<string, ChipCount>();
  for (const c of calls) for (const kind of ["model", "role", "workspace", "outcome"] as const) {
    const value = chipValue(c, kind, index), k = `${kind}\u0000${value}`, e = counts.get(k);
    if (e) e.count++;
    else counts.set(k, { kind, value, count: 1, label: kind === "outcome" ? OUTCOME_LABEL[value as Outcome] : kind === "model" ? `Model ${value}` : value });
  }
  const order: Record<ChipKind, number> = { model: 0, role: 1, workspace: 2, outcome: 3 };
  return [...counts.values()].sort((a, b) => order[a.kind] - order[b.kind] || b.count - a.count || (a.value < b.value ? -1 : 1));
}
/** AND across kinds, OR inside a kind (Model S + Model H + role worker = (S or H) and worker). */
export function applyChips(calls: readonly Call[], index: FleetIndex, chips: readonly Chip[]): Call[] {
  if (!chips.length) return [...calls];
  const byKind = new Map<ChipKind, Set<string>>();
  for (const ch of chips) { const s = byKind.get(ch.kind); if (s) s.add(ch.value); else byKind.set(ch.kind, new Set([ch.value])); }
  return calls.filter(c => [...byKind].every(([kind, vals]) => vals.has(chipValue(c, kind, index))));
}

// Keyboard control of the pulse strip's window (pure). null window = the whole domain.
type Span = { t0: number; t1: number };
/** Arrow = move one bucket; Shift+Arrow = grow (Right) or shrink (Left) the far edge by one bucket. Clamped to the domain, never narrower than one bucket. */
export function stepWindow(w: TimeWindow, domain: Span, bucketMs: number, dir: -1 | 1, resize: boolean): Span {
  // With no window set, an arrow drops one bucket off the far side (a visible move), instead of shifting the whole domain and clamping it back.
  if (w === null && !resize) return clampWindow(dir < 0 ? { t0: domain.t0, t1: domain.t1 - bucketMs } : { t0: domain.t0 + bucketMs, t1: domain.t1 }, domain);
  const cur = w ?? domain, min = Math.min(bucketMs, domain.t1 - domain.t0);
  if (resize) return clampWindow({ t0: cur.t0, t1: Math.max(cur.t0 + min, cur.t1 + dir * bucketMs) }, domain);
  return clampWindow({ t0: cur.t0 + dir * bucketMs, t1: cur.t1 + dir * bucketMs }, domain);
}
/** The last `ms` of the domain; 0 or more than the domain = the whole of it. */
export const presetWindow = (domain: Span, ms: number): Span => ms > 0 ? clampWindow({ t0: domain.t1 - ms, t1: domain.t1 }, domain) : { ...domain };
/** Plain-words value for the strip's slider role. */
export const windowWords = (w: TimeWindow): string => w ? `Showing ${clockLabel(w.t0, false)} to ${clockLabel(w.t1, false)}` : "Showing all time";
