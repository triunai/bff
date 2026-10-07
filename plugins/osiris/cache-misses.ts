/**
 * Cache-miss accounting on top of cache-economics.ts (imported, not forked). Pure: no fs, no clock.
 * A MISS is input the cache did not serve: uncached input + cache_creation (write). A HIT is cache_read.
 * Per unit (lane, bead or session) we keep a miss rate over time and a list of miss events, each with a
 * likely cause, so a prefix that stopped being byte-stable shows up as a dated event, not a vague drop.
 */
import { hitRate } from "./cache-economics.ts";
import type { UsageRow } from "./cache-economics.ts";

export type MissCause = "cold-start" | "ttl-expiry" | "prefix-break";
export interface MissEvent {
    /** Index of the call within the unit, in timestamp order (0-based). */
    callIndex: number;
    timestamp: number | null;
    /** Tokens written to the cache by this call (the jump). */
    write: number;
    /** Rolling norm of prior writes the jump is measured against. */
    norm: number;
    /** Share of this call's input-side tokens that missed (0..1). */
    missShare: number;
    /** Milliseconds since the previous call in the unit, or null (first call or no timestamps). */
    gapMs: number | null;
    cause: MissCause;
}
export interface MissPoint { callIndex: number; timestamp: number | null; missTokens: number; readTokens: number; missRate: number | null }
export interface MissOptions {
    /** Calls at the start of a unit that count as warm-up. Default 2. */
    warmupCalls?: number;
    /** A write must be at least this many tokens to be a miss event. Default 2000. */
    minWrite?: number;
    /** ...and at least this multiple of the rolling norm. Default 4. */
    jumpFactor?: number;
    /** ...and the call must have missed at least this share of its input. Default 0.5 (a big tool result on a warm prefix is not a miss). */
    minMissShare?: number;
    /** Prior calls the rolling norm is the median of. Default 8. */
    normWindow?: number;
    ttl5mMs?: number;
    ttl1hMs?: number;
}
export interface UnitMisses {
    key: string;
    calls: number;
    missTokens: number;
    readTokens: number;
    /** miss / (miss + read); null when the unit has no input-side tokens. */
    missRate: number | null;
    series: MissPoint[];
    missEvents: MissEvent[];
    causes: Record<MissCause, number>;
}

export const callMissTokens = (r: UsageRow) => r.input + r.cacheWrite5m + r.cacheWrite1h;
export const callReadTokens = (r: UsageRow) => r.cacheRead;
const writeOf = (r: UsageRow) => r.cacheWrite5m + r.cacheWrite1h;
const ratio = (miss: number, read: number) => miss + read > 0 ? miss / (miss + read) : null;
const median = (xs: number[]) => {
    if (!xs.length)
        return 0;
    const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const byTime = (rows: UsageRow[]) => rows.map((r, i) => ({ r, i })).sort((a, b) => ((a.r.timestamp ?? 0) - (b.r.timestamp ?? 0)) || a.i - b.i).map(x => x.r);

/** Which TTL governed the prefix the previous call left behind: the 1h tier only when its writes dominate. */
const ttlAfter = (prev: UsageRow, o: Required<Pick<MissOptions, "ttl5mMs" | "ttl1hMs">>) => prev.cacheWrite1h > prev.cacheWrite5m ? o.ttl1hMs : o.ttl5mMs;

export function analyzeUnit(key: string, rows: UsageRow[], opts: MissOptions = {}): UnitMisses {
    const o = { warmupCalls: 2, minWrite: 2000, jumpFactor: 4, minMissShare: 0.5, normWindow: 8, ttl5mMs: 5 * 60_000, ttl1hMs: 60 * 60_000, ...opts };
    const sorted = byTime(rows), series: MissPoint[] = [], missEvents: MissEvent[] = [];
    const causes: Record<MissCause, number> = { "cold-start": 0, "ttl-expiry": 0, "prefix-break": 0 };
    let miss = 0, read = 0;
    sorted.forEach((r, i) => {
        const m = callMissTokens(r), rd = callReadTokens(r), w = writeOf(r);
        miss += m; read += rd;
        series.push({ callIndex: i, timestamp: r.timestamp, missTokens: m, readTokens: rd, missRate: ratio(m, rd) });
        const share = ratio(m, rd) ?? 0, prev = i > 0 ? sorted[i - 1] : null;
        const gapMs = prev && prev.timestamp !== null && r.timestamp !== null ? r.timestamp - prev.timestamp : null;
        const norm = median(sorted.slice(Math.max(0, i - o.normWindow), i).map(writeOf));
        const warm = i < o.warmupCalls;
        // Warm-up has no norm to jump over: a write-dominated start is simply the cold prime.
        const isEvent = w >= o.minWrite && share >= o.minMissShare && (warm || w >= o.jumpFactor * Math.max(norm, 1));
        if (!isEvent)
            return;
        const cause: MissCause = warm ? "cold-start" : prev && gapMs !== null && gapMs > ttlAfter(prev, o) ? "ttl-expiry" : "prefix-break";
        causes[cause]++;
        missEvents.push({ callIndex: i, timestamp: r.timestamp, write: w, norm, missShare: share, gapMs, cause });
    });
    return { key, calls: sorted.length, missTokens: miss, readTokens: read, missRate: ratio(miss, read), series, missEvents, causes };
}

/** Pooled hit rate over the first n calls of a unit (by timestamp). Null when there is nothing to pool. */
export function firstCallsHitRate(rows: UsageRow[], n: number): number | null {
    return hitRate(byTime(rows).slice(0, n).reduce((a, r) => ({ input: a.input + r.input, cacheWrite5m: a.cacheWrite5m + r.cacheWrite5m, cacheWrite1h: a.cacheWrite1h + r.cacheWrite1h, cacheRead: a.cacheRead + r.cacheRead }), { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }));
}
