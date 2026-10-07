// Token efficiency (D-140): where context, cache churn and tool output cost money, from the EXISTING usage rows plus the sizes-only
// tool events (work/tool-output-facts). Pure, no fs. PRIVACY (D-135): numbers, lane names, tool names, model names and file
// BASENAMES only; each string passes redactForDisplay, nothing from a transcript's text, a command or a path above a basename.
import { aggregate, priceFor, rowCost } from "../cache-economics.ts";
import type { UsageRow } from "../cache-economics.ts";
import { redactForDisplay } from "./sanitize.ts";
import type { ToolOutputEvent } from "./tool-output-facts.ts";

/** Context at or above NEAR is "near a wrap"; at or above WRAP the agent should hand off (the coordinator rule is 250k, leads 200k). */
export const NEAR_WRAP = 150_000, WRAP = 200_000, LIVE_MS = 15 * 60_000;
const SERIES_POINTS = 24, MAX_AGENTS = 12, MAX_OUTPUTS = 8, MAX_REPEATS = 8, CHURN_RATIO = 0.15, BYTES_PER_TOKEN = 3.5;

export interface EffUnit { lane: string | null; sessionId: string; agentId: string | null; rows: readonly UsageRow[] }
export interface EffToolUnit { lane: string | null; sessionId: string; agentId: string | null; events: readonly ToolOutputEvent[] }

export type WrapState = "over" | "near" | "ok";
export interface EffAgent {
  lane: string; model: string | null; calls: number;
  /** Context tokens (fresh input + cache write + cache read) on the newest call, the biggest call, and the first call. */
  ctxNow: number; ctxMax: number; ctxFirst: number;
  /** Average context added per call, first to newest. */
  growthPerCall: number;
  /** Context per call, oldest first, at most 24 evenly spaced points. */
  series: number[];
  writeTokens: number; readTokens: number;
  /** cache write / cache read tokens; null when nothing was read. High = the cache is being rebuilt, not reused. */
  writeToRead: number | null;
  wrap: WrapState; live: boolean; lastAt: number | null; costUsd: number | null;
  why: string;
}
export interface EffFamilyShare { family: "opus" | "sonnet" | "haiku" | "other"; calls: number; costUsd: number; costShare: number | null; callShare: number | null; why: string }
export interface EffModelCache { model: string; writeTokens: number; readTokens: number; writeToRead: number | null; why: string }
export interface EffBigOutput { lane: string; tool: string; bytes: number; tokens: number; laterCalls: number; carryUsd: number | null; at: number | null; why: string }
export interface EffRepeatRead { lane: string; file: string; reads: number; totalBytes: number; why: string }
export interface TokenEfficiency {
  /** Biggest current context first (bounded). */
  agents: EffAgent[];
  /** Agents at or above NEAR_WRAP now, biggest first; a subset of the full list, not just the bounded `agents`. */
  nearWrap: EffAgent[];
  families: EffFamilyShare[];
  modelCache: EffModelCache[];
  bigOutputs: EffBigOutput[];
  repeatedReads: EffRepeatRead[];
  thresholds: { near: number; wrap: number };
  /** Calls with a context figure, and tool results seen: so the tile can say "no tool data yet" instead of showing zeros. */
  coverage: { calls: number; toolResults: number };
}

const s = (v: string | null | undefined, max = 64) => redactForDisplay(v ?? "", max).trim();
const ctxOf = (r: UsageRow) => r.input + r.cacheWrite5m + r.cacheWrite1h + r.cacheRead;
const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const family = (m: string | null): EffFamilyShare["family"] => (/opus/i.test(m ?? "") ? "opus" : /sonnet/i.test(m ?? "") ? "sonnet" : /haiku/i.test(m ?? "") ? "haiku" : "other");
const unitKey = (u: { sessionId: string; agentId: string | null }) => `${u.sessionId}\u0000${u.agentId ?? ""}`;
const byTime = (a: UsageRow, b: UsageRow) => (a.timestamp ?? Infinity) - (b.timestamp ?? Infinity);

function downsample(xs: number[], n: number): number[] {
  if (xs.length <= n) return xs;
  return Array.from({ length: n }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (n - 1))]);
}
function topModel(rows: readonly UsageRow[]): string | null {
  const c = new Map<string, number>();
  for (const r of rows) if (r.model) c.set(r.model, (c.get(r.model) ?? 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;
}

export function buildTokenEfficiency(units: readonly EffUnit[], tools: readonly EffToolUnit[], now: number, windowMs: number): TokenEfficiency {
  const inWin = (t: number | null) => t === null || !Number.isFinite(t) || now - t <= windowMs;
  const toolsBy = new Map(tools.map(t => [unitKey(t), t]));
  const agents: EffAgent[] = [], allRows: UsageRow[] = [], outputs: EffBigOutput[] = [];
  const reads = new Map<string, EffRepeatRead>();
  let toolResults = 0;
  for (const u of units) {
    const rows = u.rows.filter(r => inWin(r.timestamp)).sort(byTime);
    if (!rows.length) continue;
    allRows.push(...rows);
    const lane = u.lane ? s(u.lane) : "main session", model = topModel(rows), ctx = rows.map(ctxOf);
    const first = ctx[0], now_ = ctx[ctx.length - 1], max = Math.max(...ctx);
    const write = rows.reduce((n, r) => n + r.cacheWrite5m + r.cacheWrite1h, 0), read = rows.reduce((n, r) => n + r.cacheRead, 0);
    const costs = rows.map(rowCost), costUsd = costs.some(c => c === null) ? null : costs.reduce<number>((n, c) => n + (c ?? 0), 0);
    const lastAt = rows.reduce<number | null>((m, r) => (r.timestamp !== null && Number.isFinite(r.timestamp) && (m === null || r.timestamp > m) ? r.timestamp : m), null);
    const growth = rows.length > 1 ? Math.round((now_ - first) / (rows.length - 1)) : 0;
    const wrap: WrapState = now_ >= WRAP ? "over" : now_ >= NEAR_WRAP ? "near" : "ok";
    const ratio = read > 0 ? write / read : null;
    agents.push({
      lane, model: model ? s(model, 40) : null, calls: rows.length, ctxNow: now_, ctxMax: max, ctxFirst: first, growthPerCall: growth, series: downsample(ctx, SERIES_POINTS),
      writeTokens: write, readTokens: read, writeToRead: ratio, wrap, live: lastAt !== null && now - lastAt <= LIVE_MS, lastAt, costUsd,
      why: `Every call re-reads the whole context: ${tok(now_)} tokens now, growing about ${tok(Math.max(0, growth))} per call. ${wrap === "ok" ? "Cheap while small; the cost compounds." : "Hand off to a fresh agent with a short state file instead of running on."}`,
    });
    const t = toolsBy.get(unitKey(u));
    if (!t) continue;
    const price = priceFor(model);
    for (const e of t.events) {
      if (!inWin(e.at)) continue;
      toolResults++;
      const tokens = Math.round(e.bytes / BYTES_PER_TOKEN), later = e.at === null ? 0 : rows.filter(r => r.timestamp !== null && r.timestamp > e.at!).length;
      outputs.push({
        lane, tool: s(e.tool, 40), bytes: e.bytes, tokens, laterCalls: later, carryUsd: price ? (tokens / 1e6) * price.read * later : null, at: e.at,
        why: `Fed back into context once, then re-read on each of the ${later} later calls (about ${tok(tokens)} tokens each time).`,
      });
      if (e.file) {
        const k = `${unitKey(u)}\u0000${e.file}`, cur = reads.get(k) ?? { lane, file: s(e.file), reads: 0, totalBytes: 0, why: "" };
        cur.reads++; cur.totalBytes += e.bytes; reads.set(k, cur);
      }
    }
  }
  const repeatedReads = [...reads.values()].filter(r => r.reads >= 2).map(r => ({ ...r, why: `Read ${r.reads} times by the same agent (${kb(r.totalBytes)} in total); each read puts the file into context again. Keep a note, or read only the part you need (peek --range).` }))
    .sort((a, b) => b.totalBytes - a.totalBytes || (a.file < b.file ? -1 : 1)).slice(0, MAX_REPEATS);

  const fam = new Map<EffFamilyShare["family"], { calls: number; cost: number; unpriced: boolean }>();
  for (const r of allRows) {
    const f = family(r.model), c = fam.get(f) ?? { calls: 0, cost: 0, unpriced: false }, rc = rowCost(r);
    c.calls++; if (rc === null) c.unpriced = true; else c.cost += rc; fam.set(f, c);
  }
  const totalCost = [...fam.values()].reduce((n, c) => n + c.cost, 0);
  const families: EffFamilyShare[] = [...fam].map(([f, c]) => ({
    family: f, calls: c.calls, costUsd: c.cost, costShare: totalCost > 0 ? c.cost / totalCost : null, callShare: allRows.length ? c.calls / allRows.length : null,
    why: f === "opus" ? "Opus costs about twice Sonnet per token; use it for design and adversarial review, not chores." : f === "haiku" ? "Cheapest tier; good for mechanical sweeps." : f === "sonnet" ? "The default workhorse." : "Not priced here.",
  })).sort((a, b) => b.costUsd - a.costUsd || (a.family < b.family ? -1 : 1));

  const modelCache: EffModelCache[] = aggregate(allRows, r => r.model ?? "unknown").map(u => {
    const write = u.cacheWrite5m + u.cacheWrite1h, ratio = u.cacheRead > 0 ? write / u.cacheRead : null;
    return { model: s(u.key, 40), writeTokens: write, readTokens: u.cacheRead, writeToRead: ratio, why: ratio !== null && ratio > CHURN_RATIO ? "Many tokens written to the cache per token read back: the cache is being rebuilt (a changed prompt start, or a pause longer than its lifetime). A write costs at least 12 times a read." : "Mostly reads: the cache is being reused, which is the cheap path." };
  }).sort((a, b) => b.writeTokens - a.writeTokens || (a.model < b.model ? -1 : 1));

  const bySize = agents.slice().sort((a, b) => b.ctxNow - a.ctxNow || (a.lane < b.lane ? -1 : 1));
  return {
    agents: bySize.slice(0, MAX_AGENTS), nearWrap: bySize.filter(a => a.wrap !== "ok"), families, modelCache,
    bigOutputs: outputs.sort((a, b) => b.bytes - a.bytes || (a.tool < b.tool ? -1 : 1)).slice(0, MAX_OUTPUTS), repeatedReads,
    thresholds: { near: NEAR_WRAP, wrap: WRAP }, coverage: { calls: allRows.length, toolResults },
  };
}
