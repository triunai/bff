/**
 * Server-side, read-only reader for the osiris-bridge JSONL feed (`~/.osiris/mod-feed.jsonl`, written by
 * mods/osiris-bridge/hooks/register.tsx). Sits beside transcript-feed.ts; the transcript scanner stays the
 * fallback and the only path for Codex/Gemini.
 *
 * The file is written by a plugin in another process, so it is untrusted input: reads are byte-capped (only the tail
 * is read), every line is schema-validated (unknown fields dropped, oversized lines rejected, bad lines skipped,
 * strings cleaned), and the whole thing fails open to "no rows". fs only: no child processes, no network.
 */
import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanText } from "./work/sanitize.ts";
import { laneSignals } from "./work/loop-signals.ts";
import type { LaneSignal } from "./work/loop-signals.ts";

export const MOD_FEED_PATH = join(homedir(), ".osiris", "mod-feed.jsonl");
/** The most bytes read from the feed per call (the tail). */
export const FEED_MAX_BYTES = 1024 * 1024;
/** A single line longer than this is rejected, not parsed. */
export const FEED_MAX_LINE = 8 * 1024;
/** The most rows an RPC reply carries. */
export const FEED_MAX_ROWS = 200;
/** Transcript activity this recent counts as "a lane is live". */
export const GAP_ACTIVE_MS = 5 * 60_000;
/** The feed may trail transcript activity by this much before it is called a gap. */
export const GAP_GRACE_MS = 2 * 60_000;

// Hand-rolled validation (like transcript-feed.ts): the feed readers carry no runtime dependency, so they unit-test without an install.
// Each field is copied by name into a fresh object, which IS the "unknown fields dropped" rule.
type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, n: number): string | null => (typeof v === "string" ? cleanText(v, n) : null);
const fin = (v: unknown, lo = -Infinity, hi = Infinity): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
/** Optional nullable field: absent/null -> null, valid -> value, present but wrong type -> undefined (row rejected). */
const optText = (v: unknown, n: number) => (v === undefined || v === null ? null : text(v, n) ?? undefined);
const optNum = (v: unknown, lo: number) => (v === undefined || v === null ? null : fin(v, lo) ?? undefined);

export interface RateRow { kind: string; percentUsed: number; resetsAt?: string }
/** Salted fingerprints of an edit: file, and the (old, new) hash pairs. Never text. */
export interface EditHash { p: string; code: boolean; pairs: [string, string][] }
/** Message-delivery fact from the bridge: metadata only, never the body. */
export interface MsgFeedRow { kind: "msg"; ts: number; sid: string; dir: "send" | "recv"; from: string | null; to: string | null; origin: string; bytes: number; ok: boolean | null; flag: string | null }
export type FeedRow =
    | { kind: "tool"; ts: number; sid: string; tool: string; toolUseId: string | null; agentId: string | null; ms: number | null; outcome: "ok" | "error" | "denied"; h?: string; chk?: boolean; mut?: boolean; ed?: EditHash }
    | { kind: "turn"; ts: number; sid: string; turnId: string | null; agentId: string | null; reason: string | null; ms: number | null }
    | MsgFeedRow
    | { kind: "measure"; ts: number; sid: string; usd: number | null; ctxPct: number | null; rate: RateRow[] };

function rateRows(v: unknown): RateRow[] | null {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > 8) return null;
    const out: RateRow[] = [];
    for (const w of v) {
        if (!isRec(w)) return null;
        const kind = text(w.kind, 32), pct = fin(w.percentUsed, 0, 1000);
        if (kind === null || pct === null) return null;
        const at = w.resetsAt === undefined ? null : text(w.resetsAt, 40);
        out.push(at ? { kind, percentUsed: pct, resetsAt: at } : { kind, percentUsed: pct });
    }
    return out;
}

const HASH = /^[0-9a-f]{1,16}$/;
/** Optional hash fields: absent -> {}, valid -> fields, present but malformed -> null (row rejected). */
function hashFields(v: Rec): { h?: string; chk?: boolean; mut?: boolean; ed?: EditHash } | null {
    const out: { h?: string; chk?: boolean; mut?: boolean; ed?: EditHash } = {};
    if (v.h !== undefined) { if (typeof v.h !== "string" || !HASH.test(v.h)) return null; out.h = v.h; }
    if (v.chk !== undefined) { if (typeof v.chk !== "boolean") return null; out.chk = v.chk; }
    if (v.mut !== undefined) { if (typeof v.mut !== "boolean") return null; out.mut = v.mut; }
    if (v.ed !== undefined) {
        const e = v.ed;
        if (!isRec(e) || typeof e.p !== "string" || !HASH.test(e.p) || typeof e.code !== "boolean" || !Array.isArray(e.pairs) || e.pairs.length > 8) return null;
        const pairs: [string, string][] = [];
        for (const p of e.pairs) {
            if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "string" || typeof p[1] !== "string" || !HASH.test(p[0]) || !HASH.test(p[1])) return null;
            pairs.push([p[0], p[1]]);
        }
        out.ed = { p: e.p, code: e.code, pairs };
    }
    return out;
}

export function validateRow(v: unknown): FeedRow | null {
    if (!isRec(v)) return null;
    const ts = fin(v.ts, 0), sid = text(v.sid, 128);
    if (ts === null || sid === null) return null;
    if (v.kind === "tool") {
        const tool = text(v.tool, 64), toolUseId = optText(v.toolUseId, 128), agentId = optText(v.agentId, 128), ms = optNum(v.ms, 0);
        if (tool === null || toolUseId === undefined || agentId === undefined || ms === undefined) return null;
        if (v.outcome !== "ok" && v.outcome !== "error" && v.outcome !== "denied") return null;
        const hf = hashFields(v);
        if (hf === null) return null;
        return { kind: "tool", ts, sid, tool, toolUseId, agentId, ms, outcome: v.outcome, ...hf };
    }
    if (v.kind === "turn") {
        const turnId = optText(v.turnId, 128), agentId = optText(v.agentId, 128), reason = optText(v.reason, 32), ms = optNum(v.ms, 0);
        if (turnId === undefined || agentId === undefined || reason === undefined || ms === undefined) return null;
        return { kind: "turn", ts, sid, turnId, agentId, reason, ms };
    }
    if (v.kind === "msg") {
        const from = optText(v.from, 128), to = optText(v.to, 128), origin = text(v.origin, 32), bytes = fin(v.bytes, 0), flag = optText(v.flag, 32);
        if (from === undefined || to === undefined || origin === null || bytes === null || flag === undefined) return null;
        if (v.dir !== "send" && v.dir !== "recv") return null;
        if (v.ok !== null && v.ok !== undefined && typeof v.ok !== "boolean") return null;
        return { kind: "msg", ts, sid, dir: v.dir, from, to, origin, bytes, ok: typeof v.ok === "boolean" ? v.ok : null, flag };
    }
    if (v.kind === "measure") {
        const usd = optNum(v.usd, -Infinity), ctxPct = optNum(v.ctxPct, -Infinity), rate = rateRows(v.rate);
        if (usd === undefined || ctxPct === undefined || rate === null) return null;
        return { kind: "measure", ts, sid, usd, ctxPct, rate };
    }
    return null;
}

/** droppedRows: validated rows pushed out of the in-memory window (older than KEEP_ROWS). error: a read/open failure, distinct from no feed (null when fine or the file is simply absent). */
export interface ReadStats { droppedRows: number; error: string | null; bytesRead: number; size: number; truncated: boolean; rows: number; malformed: number; oversized: number }

/** Parse a tail of feed text into validated rows. `partialHead` drops the first line (the cut may have split it). */
export function parseFeedText(input: string, partialHead: boolean): { rows: FeedRow[]; malformed: number; oversized: number } {
    const lines = input.split("\n");
    if (partialHead) lines.shift();
    const rows: FeedRow[] = [];
    let malformed = 0, oversized = 0;
    for (const line of lines) {
        if (!line.trim()) continue;
        if (line.length > FEED_MAX_LINE) { oversized++; continue; }
        let v: unknown;
        try { v = JSON.parse(line); } catch { malformed++; continue; }
        const row = validateRow(v);
        if (row) rows.push(row); else malformed++;
    }
    return { rows, malformed, oversized };
}

export interface FeedTail { text: string; size: number; partialHead: boolean }
export type ReadTail = (path: string, maxBytes: number) => FeedTail | null;
export const nodeReadTail: ReadTail = (path, maxBytes) => {
    let fd: number;
    try { fd = openSync(path, "r"); } catch { return null; }
    try {
        const st = lstatSync(path);
        if (!st.isFile()) return null;
        const len = Math.min(st.size, maxBytes), from = st.size - len, buf = Buffer.alloc(len), n = readSync(fd, buf, 0, len, from);
        return { text: buf.subarray(0, n).toString("utf8"), size: st.size, partialHead: from > 0 };
    } catch { return null; } finally { closeSync(fd); }
};

/** Feed gap: transcripts show recent activity but the feed has nothing as new. */
export function feedGap(lastFeedTs: number | null, transcriptActiveMs: number | null, now: number): boolean {
    if (transcriptActiveMs === null || now - transcriptActiveMs > GAP_ACTIVE_MS) return false;
    return lastFeedTs === null || lastFeedTs < transcriptActiveMs - GAP_GRACE_MS;
}

export interface ModFeedReply {
    rows: FeedRow[];
    /** Latest 5h / weekly window seen, if any measure row carried one. */
    windows: { fiveHour: { percentUsed: number; resetsAt?: string } | null; sevenDay: { percentUsed: number; resetsAt?: string } | null };
    lastTs: number | null;
    gap: boolean;
    /** Lanes the loop / flip-flop / unverified rules flagged, over the whole read tail (not just `rows`). */
    lanes: LaneSignal[];
    stats: ReadStats;
}

/** Build the RPC reply from every validated row in hand. Shared by the one-shot sync reader and the live async reader. */
export function replyFrom(all: FeedRow[], stats: { size: number; bytesRead: number; truncated: boolean; malformed: number; oversized: number; droppedRows?: number; error?: string | null }, opts: { now?: number; transcriptActiveMs?: number | null; limit?: number; lanes?: LaneSignal[] } = {}): ModFeedReply {
    const now = opts.now ?? Date.now();
    const limit = Math.max(1, Math.min(FEED_MAX_ROWS, Math.floor(opts.limit ?? FEED_MAX_ROWS)));
    const rows = all.slice(-limit);
    let lastTs: number | null = null;
    for (const r of all) if (lastTs === null || r.ts > lastTs) lastTs = r.ts;
    const windows: ModFeedReply["windows"] = { fiveHour: null, sevenDay: null };
    for (let i = all.length - 1; i >= 0 && (!windows.fiveHour || !windows.sevenDay); i--) {
        const r = all[i]!;
        if (r.kind !== "measure") continue;
        for (const w of r.rate) {
            if (w.kind === "five_hour" && !windows.fiveHour) windows.fiveHour = { percentUsed: w.percentUsed, resetsAt: w.resetsAt };
            if (w.kind === "seven_day" && !windows.sevenDay) windows.sevenDay = { percentUsed: w.percentUsed, resetsAt: w.resetsAt };
        }
    }
    return {
        rows, windows, lastTs, lanes: opts.lanes ?? laneSignals(all),
        gap: feedGap(lastTs, opts.transcriptActiveMs ?? null, now),
        stats: { bytesRead: stats.bytesRead, size: stats.size, truncated: stats.truncated, droppedRows: stats.droppedRows ?? 0, error: stats.error ?? null, rows: all.length, malformed: stats.malformed, oversized: stats.oversized }
    };
}

/** One-shot synchronous read (tests and tools). The server path uses the async, incremental reader in mod-feed-live.ts. */
export function readModFeed(opts: { path?: string; readTail?: ReadTail; now?: number; transcriptActiveMs?: number | null; limit?: number } = {}): ModFeedReply {
    const tail = (opts.readTail ?? nodeReadTail)(opts.path ?? MOD_FEED_PATH, FEED_MAX_BYTES);
    const parsed = tail ? parseFeedText(tail.text, tail.partialHead) : { rows: [], malformed: 0, oversized: 0 };
    return replyFrom(parsed.rows, { size: tail?.size ?? 0, bytesRead: tail ? Math.min(tail.size, FEED_MAX_BYTES) : 0, truncated: !!tail?.partialHead, malformed: parsed.malformed, oversized: parsed.oversized }, opts);
}

/** Newest transcript mtime (ms) under root, or null. Bounded by the injected listing; callers cache the result. */
export function newestTranscriptMtime(list: () => string[], mtimeOf: (p: string) => number | null, maxFiles = 1000): number | null {
    let best: number | null = null;
    for (const p of list().slice(-maxFiles)) { const m = mtimeOf(p); if (m !== null && (best === null || m > best)) best = m; }
    return best;
}
export const nodeMtime = (p: string): number | null => { try { return lstatSync(p).mtimeMs; } catch { return null; } };
