// Run folding (pure): consecutive calls of the SAME tool on the SAME lane collapse into one run, so a lane with 400 Read / Bash / Edit
// calls reads as a handful of runs that expand on click. Shape borrowed from Kimi Code's tool stack ("Read x12"). PRIVACY: tool names,
// statuses and timestamps only; the data carries no arguments or output and this module never asks for any.
import { callKey, type Call, type Status } from "../analytics.ts";
import { humanDuration, isSlow } from "../live-observer.ts";

export const DEFAULT_MAX_GAP_MS = 60_000;
export const DEFAULT_MIN_RUN = 3;

export interface RunOptions {
  /** Time `running` calls extend to. */
  now: number;
  /** Largest gap between one call's end and the next call's start that still continues a run. Default 60 s. */
  maxGapMs?: number;
  /** Shortest run worth folding. Default 3. */
  minRun?: number;
  /** Also require the same server. Default false (a tool name already says which server). */
  bySameServer?: boolean;
}
export interface CallRun {
  /** First call's key + "+run": stable while the window moves AND while the run grows (a growing run stays open and keeps its keyboard stop). */
  key: string;
  lane: string;
  tool: string;
  server: string | null;
  count: number;
  start: number;
  end: number;
  wall: number;
  /** error + denied calls inside the run. */
  failed: number;
  slow: number;
  statuses: Partial<Record<Status, number>>;
  callKeys: string[];
  title: string;
}
export type CallRow = { kind: "run"; run: CallRun } | { kind: "call"; call: Call };

const failedStatus = (s: Status) => s === "error" || s === "denied";
const endOf = (c: Call, now: number) => c.endedAt !== null ? Math.max(c.endedAt, c.startedAt!) : c.status === "running" ? Math.max(now, c.startedAt!) : c.startedAt!;
const wallText = (ms: number) => ms < 1000 ? "<1s" : humanDuration(ms);
/** Plain words: "Read ×12 · 40s · 1 failed". */
export const runTitle = (tool: string, count: number, wall: number, failed: number) => `${tool} ×${count} · ${wallText(wall)}${failed > 0 ? ` · ${failed} failed` : ""}`;

/** Runs of >= minRun consecutive same-tool calls per lane (sessionId), ordered by start. Calls with no start time are never in a run. */
export function foldRuns(calls: readonly Call[], opts: RunOptions): CallRun[] {
  const maxGap = opts.maxGapMs ?? DEFAULT_MAX_GAP_MS, minRun = Math.max(2, opts.minRun ?? DEFAULT_MIN_RUN); // a run is at least two calls: minRun <= 1 is clamped to 2
  const byLane = new Map<string, Call[]>();
  for (const c of calls) {
    if (c.startedAt === null) continue;
    const g = byLane.get(c.sessionId);
    if (g) g.push(c); else byLane.set(c.sessionId, [c]);
  }
  const out: CallRun[] = [];
  for (const [lane, cs] of byLane) {
    const keyed = cs.map(c => ({ c, k: callKey(c) }));
    keyed.sort((a, b) => a.c.startedAt! - b.c.startedAt! || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
    let from = 0, reach = -Infinity;
    const flush = (to: number) => {
      if (to - from < minRun) return;
      const part = keyed.slice(from, to), first = part[0].c;
      const tally: Partial<Record<Status, number>> = {};
      let failed = 0, slow = 0, end = -Infinity;
      for (const { c } of part) {
        tally[c.status] = (tally[c.status] ?? 0) + 1;
        if (failedStatus(c.status)) failed++;
        if (isSlow(c)) slow++;
        end = Math.max(end, endOf(c, opts.now));
      }
      const start = first.startedAt!, wall = end - start;
      out.push({ key: `${part[0].k}+run`, lane, tool: first.tool, server: first.server, count: part.length, start, end, wall, failed, slow, statuses: tally, callKeys: part.map(p => p.k), title: runTitle(first.tool, part.length, wall, failed) });
    };
    for (let i = 0; i < keyed.length; i++) {
      const c = keyed[i].c, p = i > 0 ? keyed[i - 1].c : null;
      const continues = p !== null && p.tool === c.tool && (!opts.bySameServer || p.server === c.server) && c.startedAt! - reach <= maxGap;
      if (!continues) { flush(i); from = i; reach = -Infinity; }
      reach = Math.max(reach, endOf(c, opts.now));
    }
    flush(keyed.length);
  }
  return out.sort((a, b) => a.start - b.start || (a.key < b.key ? -1 : 1));
}

/** The All-calls list: runs and the calls left over, newest first (by end, then start). Every call appears exactly once. */
export function foldRows(calls: readonly Call[], opts: RunOptions): CallRow[] {
  const runs = foldRuns(calls, opts), inRun = new Set<string>();
  for (const r of runs) for (const k of r.callKeys) inRun.add(k);
  const rows: { row: CallRow; at: number; start: number; k: string }[] = runs.map(run => ({ row: { kind: "run", run }, at: run.end, start: run.start, k: run.key }));
  for (const call of calls) { const k = callKey(call); if (!inRun.has(k)) rows.push({ row: { kind: "call", call }, at: call.endedAt ?? call.startedAt ?? 0, start: call.startedAt ?? 0, k }); }
  rows.sort((a, b) => b.at - a.at || b.start - a.start || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return rows.map(r => r.row);
}
export const countRows = (calls: readonly Call[], now: number, opts: Partial<RunOptions> = {}) => foldRows(calls, { ...opts, now }).length;
