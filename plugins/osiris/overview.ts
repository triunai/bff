import type { Call } from "./analytics.ts";
import type { GitGraph, GitStatus } from "./git-types.ts";
import { humanDuration, isSlow } from "./live-observer.ts";
import { triageCounts } from "./triage.ts";

export { humanDuration as fmtMs } from "./live-observer.ts";

/** A tool needs at least this many KNOWN-duration samples before it gets its own percentiles; below that p50/p90 are
 * null (too few samples to mean anything) and the UI renders a dash. */
export const MIN_TOOL_SAMPLES = 5;
export const TOP_TOOLS = 5;
/** A local branch counts as "active" when its newest commit is at most this many days before `now`. */
export const ACTIVE_BRANCH_DAYS = 14;
const DAY_MS = 86_400_000;

/** Nearest-rank percentile over an ascending-sorted array (same rule as analytics.ts totals()). Null when empty. */
function nearestRank(sorted: number[], p: number): number | null {
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
}
const known = (calls: Call[]) => calls.flatMap(c => c.durationMs === null ? [] : [c.durationMs]).sort((a, b) => a - b);

export type ToolMetric = { tool: string; n: number; p50: number | null; p90: number | null };
export type CallMetrics = {
  total: number; problems: number; signals: number;
  /** errors / (success + errors); rate is null when the denominator is 0. running/denied/cancelled/unknown are excluded. */
  errorRate: { rate: number | null; errors: number; denominator: number };
  /** n = calls with a recorded duration; unknown = calls whose duration is null (never counted as 0). */
  timing: { n: number; unknown: number; p50: number | null; p90: number | null };
  slow: number;
  topTools: ToolMetric[];
};

export function callMetrics(calls: Call[]): CallMetrics {
  const { problems, signals } = triageCounts(calls);
  let success = 0, errors = 0, slow = 0;
  const byTool = new Map<string, Call[]>();
  for (const c of calls) {
    if (c.status === "success") success++; else if (c.status === "error") errors++;
    if (isSlow(c)) slow++;
    const list = byTool.get(c.tool); if (list) list.push(c); else byTool.set(c.tool, [c]);
  }
  const denominator = success + errors, ds = known(calls);
  const topTools = [...byTool.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, TOP_TOOLS)
    .map(([tool, list]): ToolMetric => {
      const s = known(list), enough = s.length >= MIN_TOOL_SAMPLES;
      return { tool, n: list.length, p50: enough ? nearestRank(s, .5) : null, p90: enough ? nearestRank(s, .9) : null };
    });
  return {
    total: calls.length, problems, signals,
    errorRate: { rate: denominator ? errors / denominator : null, errors, denominator },
    timing: { n: ds.length, unknown: calls.length - ds.length, p50: nearestRank(ds, .5), p90: nearestRank(ds, .9) },
    slow, topTools,
  };
}

export type RepoStats = {
  /** Commits whose committedAt falls on the local calendar day of `now`. Counts only commits inside the graph's bound. */
  commitsToday: number | null;
  /** Local branches whose newest commit is within ACTIVE_BRANCH_DAYS of now. */
  activeBranches: number | null;
  /** Porcelain entry count. */
  dirty: number | null;
  /** True when git truncated the status list: the real count is higher than `dirty`. */
  dirtyTruncated: boolean;
  /** graph.truncated: commitsToday may undercount because the graph hit its commit bound. */
  bounded: boolean;
};

export function repoStats(graph: GitGraph | null, status: GitStatus | null, now: number): RepoStats {
  const d = new Date(now);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  const cutoff = now - ACTIVE_BRANCH_DAYS * DAY_MS;
  return {
    commitsToday: graph ? graph.commits.filter(c => c.committedAt >= dayStart && c.committedAt < dayEnd).length : null,
    activeBranches: graph ? graph.refs.filter(r => r.kind === "local" && r.committedAt !== null && r.committedAt >= cutoff && r.committedAt <= now).length : null,
    dirty: status ? status.entries.length : null,
    dirtyTruncated: status?.truncated ?? false,
    bounded: graph?.truncated ?? false,
  };
}

// ---- tool-call dashboard (W-193c): same calls, same slow rule, same percentile rule as callMetrics; nothing is parsed twice ----
export const DASH_TOOLS = 8, DASH_SLOW = 5;
export type ToolStat = { tool: string; n: number; errors: number; unknown: number; /** calls with a recorded duration: the sample size behind p50/p90 */ timed: number; p50: number | null; p90: number | null };
export type SlowCall = { tool: string; durationMs: number };
export type CallDashboard = {
  total: number; success: number; errors: number; unknown: number; running: number;
  /** denied + cancelled */
  other: number;
  timing: { n: number; p50: number | null; p90: number | null };
  tools: ToolStat[];
  slow: { count: number; worst: SlowCall[] };
};
export function callDashboard(calls: Call[]): CallDashboard {
  const d: CallDashboard = { total: calls.length, success: 0, errors: 0, unknown: 0, running: 0, other: 0, timing: { n: 0, p50: null, p90: null }, tools: [], slow: { count: 0, worst: [] } };
  const byTool = new Map<string, Call[]>(), slow: SlowCall[] = [];
  for (const c of calls) {
    if (c.status === "success") d.success++; else if (c.status === "error") d.errors++; else if (c.status === "unknown") d.unknown++; else if (c.status === "running") d.running++; else d.other++;
    if (isSlow(c)) slow.push({ tool: c.tool, durationMs: c.durationMs! });
    const l = byTool.get(c.tool); if (l) l.push(c); else byTool.set(c.tool, [c]);
  }
  const ds = known(calls);
  d.timing = { n: ds.length, p50: nearestRank(ds, .5), p90: nearestRank(ds, .9) };
  d.tools = [...byTool].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, DASH_TOOLS).map(([tool, list]): ToolStat => {
    const s = known(list), enough = s.length >= MIN_TOOL_SAMPLES;
    return { tool, n: list.length, errors: list.filter(c => c.status === "error").length, unknown: list.filter(c => c.status === "unknown").length, timed: s.length, p50: enough ? nearestRank(s, .5) : null, p90: enough ? nearestRank(s, .9) : null };
  });
  d.slow = { count: slow.length, worst: slow.sort((a, b) => b.durationMs - a.durationMs || a.tool.localeCompare(b.tool)).slice(0, DASH_SLOW) };
  return d;
}

/** What the Overview says when it has no call numbers. A dash per card cannot tell still-loading apart from zero-recorded, so ONE sentence says which. */
export function overviewNote(m: CallMetrics | null): string | null {
  if (m === null) return "No call numbers yet. They fill in once Osiris has read a call history for this scope; a real zero shows as 0, never a dash.";
  if (m.total === 0) return "No calls are recorded in this scope yet, so every figure here is 0 or has nothing to average.";
  return null;
}
/** The Capture card's first line: where the data came from, how old it is, and whether it is stale. Null input means nothing was captured. */
export function captureText(f: { label: string; ageMs: number | null; stale: boolean } | null): string {
  if (!f) return "Not captured yet";
  const age = f.ageMs === null ? "age unknown" : `${humanDuration(f.ageMs)} ago`;
  return `${f.label} · ${age}${f.stale ? " · stale, re-run the capture" : ""}`;
}
