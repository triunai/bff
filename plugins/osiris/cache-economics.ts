/**
 * Cache economics: per-agent / per-session prompt-cache hit rate and cost, from Claude Code
 * transcript JSONL. Pure functions only (no fs, no network, no clock) so the tailer and the
 * parser are testable with synthetic input. Method and price table: webshop
 * docs/reviews/2026-10-07-day2-blast/token-cost.md (sections 1-2, measured within 0.3% of ccusage).
 * Privacy follows analytics.ts: whitelist counters and ids, never retain message content.
 */
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
const string = (v: unknown) => typeof v === "string" && v.length ? v : null;
const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;

/** One deduped assistant request. Token classes follow the transcript `message.usage` fields. */
export interface UsageRow {
    source: string;
    sessionId: string;
    agentId: string | null;
    model: string | null;
    messageId: string | null;
    requestId: string | null;
    timestamp: number | null;
    input: number;
    output: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    cacheRead: number;
}
export interface UsageSource {
    /** Display/provenance label, usually the file path. */
    source: string;
    sessionId: string;
    agentId?: string | null;
}
export interface ParseResult {
    rows: UsageRow[];
    /** Lines that were not valid JSON. Counted, never thrown. */
    malformed: number;
    /** Valid JSON that was not an assistant usage row, or an all-zero (synthetic) row. */
    skipped: number;
    /** Rows with no (message.id, requestId) pair: kept, but they cannot be deduped. */
    unkeyed: number;
}

/** $ per million tokens. Source: token-cost.md section 2 "Pricing, current" (Anthropic list prices, 2026-10-06). */
export interface Price { input: number; write5m: number; write1h: number; read: number; output: number }
export const PRICES: Readonly<Record<string, Price>> = {
    "claude-fable-5-1": { input: 10, write5m: 12.5, write1h: 20, read: 0.25, output: 50 },
    "claude-opus-5-5": { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 },
    "claude-sonnet-5-5": { input: 2, write5m: 2.5, write1h: 4, read: 0.2, output: 10 },
    "claude-haiku-4-5": { input: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5 }
};
/** Exact id, else the longest known id that prefixes it (`claude-haiku-4-5-20251001`). Unknown is null, never zero prices. */
export function priceFor(model: string | null): Price | null {
    if (!model)
        return null;
    if (Object.hasOwn(PRICES, model))
        return PRICES[model];
    let best: string | null = null;
    for (const k of Object.keys(PRICES))
        if (model.startsWith(`${k}-`) && (best === null || k.length > best.length))
            best = k;
    return best ? PRICES[best] : null;
}
/** Dollar cost of one row, or null when the model is unpriced (the ccusage $0 bug is the thing to avoid). */
export function rowCost(r: UsageRow): number | null {
    const p = priceFor(r.model);
    // Divide each count by 1e6 BEFORE multiplying so a huge count stays finite; a non-finite total is shown as n/a by the views.
    return p ? (r.input / 1e6) * p.input + (r.cacheWrite5m / 1e6) * p.write5m + (r.cacheWrite1h / 1e6) * p.write1h + (r.cacheRead / 1e6) * p.read + (r.output / 1e6) * p.output : null;
}

/** hit = cache_read / (cache_read + input + cache_creation); null when no input-side tokens exist. */
export function hitRate(t: { input: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number }): number | null {
    // Scale by the largest part first so a sum of huge counts cannot overflow into a fake 0%.
    const m = Math.max(t.cacheRead, t.input, t.cacheWrite5m, t.cacheWrite1h);
    if (!(m > 0) || !Number.isFinite(m))
        return null;
    const r = t.cacheRead / m, denom = r + t.input / m + t.cacheWrite5m / m + t.cacheWrite1h / m;
    return denom > 0 ? r / denom : null;
}
export const rowKey = (r: UsageRow) => r.messageId !== null && r.requestId !== null ? JSON.stringify([r.messageId, r.requestId]) : null;

/** Streaming writes several rows per (message.id, requestId); the last one carries the final usage. */
export function dedupeRows(rows: UsageRow[]): UsageRow[] {
    const keyed = new Map<string, UsageRow>(), out: Array<UsageRow | string> = [];
    for (const r of rows) {
        const k = rowKey(r);
        if (k === null) { out.push(r); continue; }
        if (!keyed.has(k))
            out.push(k);
        keyed.set(k, r);
    }
    return out.map(x => typeof x === "string" ? keyed.get(x)! : x);
}

function toRow(line: Obj, src: UsageSource): UsageRow | null {
    if (line.type !== "assistant")
        return null;
    const msg = object(line.message), u = object(msg.usage);
    if (!Object.keys(u).length)
        return null;
    const cc = object(u.cache_creation), total = count(u.cache_creation_input_tokens);
    let w5 = count(cc.ephemeral_5m_input_tokens);
    const w1 = count(cc.ephemeral_1h_input_tokens);
    // Older transcripts have only the total: price it as 5m. Any unexplained remainder is 5m too, never dropped.
    if (w5 + w1 < total)
        w5 = total - w1;
    const ts = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
    const row: UsageRow = { source: src.source, sessionId: string(line.sessionId) ?? src.sessionId, agentId: src.agentId ?? null, model: string(msg.model), messageId: string(msg.id), requestId: string(line.requestId), timestamp: Number.isFinite(ts) ? ts : null, input: count(u.input_tokens), output: count(u.output_tokens), cacheWrite5m: w5, cacheWrite1h: w1, cacheRead: count(u.cache_read_input_tokens) };
    return row.input + row.output + row.cacheWrite5m + row.cacheWrite1h + row.cacheRead === 0 ? null : row;
}
/** Parse transcript lines into deduped usage rows. Malformed lines are counted, not thrown. */
export function parseUsageLines(lines: string[], source: UsageSource): ParseResult {
    const rows: UsageRow[] = [];
    let malformed = 0, skipped = 0;
    for (const raw of lines) {
        if (!raw.trim())
            continue;
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { malformed++; continue; }
        const row = toRow(object(parsed), source);
        if (row)
            rows.push(row);
        else
            skipped++;
    }
    const deduped = dedupeRows(rows);
    return { rows: deduped, malformed, skipped, unkeyed: deduped.filter(r => rowKey(r) === null).length };
}

/**
 * Locate a transcript from its path: `<project>/<sessionId>.jsonl` (main) or
 * `<project>/<sessionId>/subagents/agent-<id>.jsonl` (subagent) or `<project>/<sessionId>/subagents/workflows/<wf>/agent-<id>.jsonl` (workflow agent). Observed layout, not a documented API.
 */
export function sourceFromPath(path: string): UsageSource | null {
    const parts = path.split("/").filter(Boolean), file = parts[parts.length - 1] ?? "";
    if (!file.endsWith(".jsonl"))
        return null;
    const sub = /^agent-(.+)\.jsonl$/.exec(file);
    if (sub && parts[parts.length - 2] === "subagents" && parts.length >= 3)
        return { source: path, sessionId: parts[parts.length - 3], agentId: sub[1] };
    // Workflow-tool agents: `<session>/subagents/workflows/<wf>/agent-<id>.jsonl`.
    if (sub && parts.length >= 5 && parts[parts.length - 3] === "workflows" && parts[parts.length - 4] === "subagents")
        return { source: path, sessionId: parts[parts.length - 5], agentId: sub[1] };
    return { source: path, sessionId: file.slice(0, -".jsonl".length), agentId: null };
}
export interface AgentMeta { agentType: string | null; description: string | null; model: string | null; parentAgentId: string | null }
/** Whitelist the sibling `agent-<id>.meta.json`. Tolerates garbage. */
export function parseAgentMeta(text: string): AgentMeta {
    let m: Obj = {};
    try { m = object(JSON.parse(text)); } catch { /* tolerated: meta is optional */ }
    return { agentType: string(m.agentType), description: string(m.description), model: string(m.model), parentAgentId: string(m.parentAgentId) };
}

export interface Unit {
    key: string;
    requests: number;
    input: number;
    output: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    cacheRead: number;
    hitRate: number | null;
    /** Total dollars, or null when any row used an unpriced model. Never a silent $0. */
    cost: number | null;
    /** Sum over the priced rows only; a lower bound when `cost` is null. */
    pricedCost: number;
    unpricedModels: string[];
    firstAt: number | null;
    lastAt: number | null;
}
export type KeyBy = "session" | "agent" | "model" | ((r: UsageRow) => string);
const keyOf = (by: KeyBy, r: UsageRow) => typeof by === "function" ? by(r) : by === "session" ? r.sessionId : by === "agent" ? r.agentId ?? `main:${r.sessionId}` : r.model ?? "unknown";

export function groupRows(rows: UsageRow[], keyBy: KeyBy): Map<string, UsageRow[]> {
    const groups = new Map<string, UsageRow[]>();
    for (const r of dedupeRows(rows)) {
        const k = keyOf(keyBy, r), g = groups.get(k);
        if (g)
            g.push(r);
        else
            groups.set(k, [r]);
    }
    return groups;
}
export function aggregate(rows: UsageRow[], keyBy: KeyBy): Unit[] {
    const out: Unit[] = [];
    for (const [key, g] of groupRows(rows, keyBy)) {
        const u: Unit = { key, requests: g.length, input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, hitRate: null, cost: 0, pricedCost: 0, unpricedModels: [], firstAt: null, lastAt: null };
        const unpriced = new Set<string>();
        for (const r of g) {
            u.input += r.input; u.output += r.output; u.cacheWrite5m += r.cacheWrite5m; u.cacheWrite1h += r.cacheWrite1h; u.cacheRead += r.cacheRead;
            const c = rowCost(r);
            if (c === null)
                unpriced.add(r.model ?? "unknown");
            else
                u.pricedCost += c;
            if (r.timestamp !== null) {
                u.firstAt = u.firstAt === null ? r.timestamp : Math.min(u.firstAt, r.timestamp);
                u.lastAt = u.lastAt === null ? r.timestamp : Math.max(u.lastAt, r.timestamp);
            }
        }
        u.hitRate = hitRate(u);
        u.unpricedModels = [...unpriced].sort();
        u.cost = unpriced.size ? null : u.pricedCost;
        out.push(u);
    }
    return out.sort((a, b) => (b.pricedCost - a.pricedCost) || a.key.localeCompare(b.key));
}

/** Result of one incremental read. `offsets` is a fresh record; the input is never mutated. */
export interface TailResult { lines: string[]; offsets: Record<string, number>; reset: boolean; /** A single record longer than the read limit was stepped over (it can never fit in one read). */ oversized: boolean }
/** Injected reader: bytes of `file` from byte `from` to EOF (at most `max` bytes when given; the underlying read itself is bounded), plus the file's current total size. */
export type ReadChunk = (file: string, from: number, max?: number) => { bytes: Uint8Array; size: number };
/**
 * Read only the complete lines appended since the stored byte offset. A trailing partial line (no newline
 * yet, the writer is mid-append) is left for the next call. A file smaller than its offset was rotated or
 * truncated: restart from 0 and say so.
 */
export function tailFrom(offsets: Readonly<Record<string, number>>, file: string, readChunk: ReadChunk, chunkLimit?: number): TailResult {
    let from = offsets[file] ?? 0, reset = false, chunk = readChunk(file, from);
    if (chunk.size < from) {
        reset = true;
        from = 0;
        chunk = readChunk(file, 0);
    }
    const last = chunk.bytes.lastIndexOf(0x0a);
    if (last < 0) {
        // A FULL read with no newline and more file behind it is one record longer than the limit: it can never complete, so waiting would
        // stall this file forever. Step past the bytes read (the rest of that record parses as malformed and is dropped) and say so.
        const oversized = chunkLimit !== undefined && chunk.bytes.length >= chunkLimit && from + chunk.bytes.length < chunk.size;
        return { lines: [], offsets: { ...offsets, [file]: oversized ? from + chunk.bytes.length : from }, reset, oversized };
    }
    const text = new TextDecoder().decode(chunk.bytes.subarray(0, last));
    return { lines: text.split("\n").map(l => l.endsWith("\r") ? l.slice(0, -1) : l).filter(l => l.length), offsets: { ...offsets, [file]: from + last + 1 }, reset, oversized: false };
}

export interface HitRateAlert { key: string; baseline: number; recent: number; dropPct: number; requests: number }
export interface AlertOptions {
    /** A unit needs at least this many baseline requests (before the recent window) to be judged. */
    minRequests: number;
    /** Alert when recent hit rate is more than this many percentage points under the baseline. */
    dropPct: number;
    /** Newest requests that form the "recent" rate. Default 3. */
    recentWindow?: number;
    /** At most this many requests before the recent window form the baseline. Default 20. */
    baselineWindow?: number;
}
const pooled = (rows: UsageRow[]) => hitRate(rows.reduce((a, r) => ({ input: a.input + r.input, cacheWrite5m: a.cacheWrite5m + r.cacheWrite5m, cacheWrite1h: a.cacheWrite1h + r.cacheWrite1h, cacheRead: a.cacheRead + r.cacheRead }), { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }));
/**
 * Units whose recent hit rate fell below their OWN rolling baseline. Token-weighted, so one cold re-prime
 * call shows up as the drop it is. Data shape for a later Health row; no UI here.
 */
export function hitRateAlerts(units: Iterable<{ key: string; rows: UsageRow[] }> | Map<string, UsageRow[]>, opts: AlertOptions): HitRateAlert[] {
    const recentN = opts.recentWindow ?? 3, baseN = opts.baselineWindow ?? 20, alerts: HitRateAlert[] = [];
    const entries = units instanceof Map ? [...units].map(([key, rows]) => ({ key, rows })) : [...units];
    for (const { key, rows } of entries) {
        const sorted = [...rows].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
        if (sorted.length - recentN < opts.minRequests)
            continue;
        const recent = pooled(sorted.slice(-recentN)), baseline = pooled(sorted.slice(Math.max(0, sorted.length - recentN - baseN), sorted.length - recentN));
        if (recent === null || baseline === null)
            continue;
        const dropPct = (baseline - recent) * 100;
        if (dropPct > opts.dropPct)
            alerts.push({ key, baseline, recent, dropPct, requests: sorted.length });
    }
    return alerts.sort((a, b) => b.dropPct - a.dropPct || a.key.localeCompare(b.key));
}
