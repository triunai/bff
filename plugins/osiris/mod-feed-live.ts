/**
 * The server's live reader for the osiris-bridge feed. Unlike readModFeed (a one-shot sync tail read), this one is safe to poll:
 *  - async fs only (fs/promises), so a call never blocks the event loop on disk;
 *  - at most FEED_MAX_BYTES read per refresh, and only the APPENDED bytes when the file merely grew (incremental by size + mtime);
 *  - an unchanged (size, mtime) costs one stat and re-parses nothing;
 *  - single-flight: concurrent callers share one refresh;
 *  - parsing yields to the event loop between slices, so a 1 MB cold read never holds it for long.
 * It also owns the "newest transcript mtime" probe (async walk, 15 s cache, single-flight) that used to be a sync tree walk.
 */
import { open, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { FEED_MAX_BYTES, FEED_MAX_LINE, MOD_FEED_PATH, replyFrom, validateRow } from "./mod-feed.ts";
import type { FeedRow, ModFeedReply } from "./mod-feed.ts";
import { laneSignals } from "./work/loop-signals.ts";
import type { LaneSignal } from "./work/loop-signals.ts";

/** Validated rows kept in memory (the reply only ever needs the newest; signals replay these). */
export const KEEP_ROWS = 6000;
const YIELD_EVERY = 400;
const tick = () => new Promise<void>(r => setImmediate(r));

interface Snap { ino: number; dev: number; dropped: number; error: string | null; size: number; mtimeMs: number; consumed: number; rows: FeedRow[]; malformed: number; oversized: number; truncated: boolean; bytesRead: number; lanes: LaneSignal[] }
const EMPTY: Snap = { ino: 0, dev: 0, dropped: 0, error: null, size: 0, mtimeMs: 0, consumed: 0, rows: [], malformed: 0, oversized: 0, truncated: false, bytesRead: 0, lanes: [] };

async function parseLines(textIn: string, dropFirst: boolean, into: FeedRow[]): Promise<{ malformed: number; oversized: number }> {
    const lines = textIn.split("\n");
    if (dropFirst) lines.shift();
    let malformed = 0, oversized = 0, n = 0;
    for (const line of lines) {
        if (++n % YIELD_EVERY === 0) await tick();
        if (!line.trim()) continue;
        if (line.length > FEED_MAX_LINE) { oversized++; continue; }
        let v: unknown;
        try { v = JSON.parse(line); } catch { malformed++; continue; }
        const row = validateRow(v);
        if (row) into.push(row); else malformed++;
    }
    return { malformed, oversized };
}

export function createModFeedReader(opts: { path?: string } = {}) {
    const path = opts.path ?? MOD_FEED_PATH;
    let snap: Snap = EMPTY;
    let inflight: Promise<Snap> | null = null;

    async function refresh(): Promise<Snap> {
        // lstat first and require a regular file BEFORE open: a FIFO would block a thread-pool slot, a symlink is refused (as the sync reader does).
        let pre;
        try { pre = await lstat(path); } catch (e) { snap = (e as NodeJS.ErrnoException)?.code === "ENOENT" ? EMPTY : { ...EMPTY, error: String((e as NodeJS.ErrnoException)?.code ?? "stat-failed") }; return snap; }
        if (!pre.isFile()) { snap = { ...EMPTY, error: pre.isSymbolicLink() ? "symlink-refused" : "not-a-regular-file" }; return snap; }
        let fh;
        try { fh = await open(path, "r"); } catch (e) { snap = { ...EMPTY, error: String((e as NodeJS.ErrnoException)?.code ?? "open-failed") }; return snap; }
        try {
            const st = await fh.stat();
            if (!st.isFile()) { snap = { ...EMPTY, error: "not-a-regular-file" }; return snap; }
            if (snap.size === st.size && snap.mtimeMs === st.mtimeMs && snap.ino === st.ino && snap.dev === st.dev && snap.consumed > 0) return snap;
            const rotated = snap.ino !== st.ino || snap.dev !== st.dev;
            const cold = snap.consumed === 0 || rotated || st.size < snap.consumed || st.size - snap.consumed > FEED_MAX_BYTES;
            const from = cold ? Math.max(0, st.size - FEED_MAX_BYTES) : snap.consumed;
            const len = st.size - from;
            const buf = Buffer.alloc(len);
            let got = 0;
            while (got < len) { const { bytesRead } = await fh.read(buf, got, len - got, from + got); if (bytesRead === 0) break; got += bytesRead; }
            // Only whole lines are consumed; a half-written last line waits for its newline.
            const end = buf.subarray(0, got).lastIndexOf(10) + 1;
            const rows = cold ? [] : snap.rows.slice();
            const counts = await parseLines(buf.subarray(0, end).toString("utf8"), cold && from > 0, rows);
            const over = Math.max(0, rows.length - KEEP_ROWS), kept = over ? rows.slice(-KEEP_ROWS) : rows;
            snap = {
                ino: st.ino, dev: st.dev, dropped: (cold ? 0 : snap.dropped) + over, error: null,
                size: st.size, mtimeMs: st.mtimeMs, consumed: from + end, rows: kept,
                malformed: (cold ? 0 : snap.malformed) + counts.malformed, oversized: (cold ? 0 : snap.oversized) + counts.oversized,
                truncated: cold ? from > 0 : snap.truncated, bytesRead: got, lanes: laneSignals(kept),
            };
            return snap;
        } catch (e) { snap = { ...EMPTY, error: String((e as NodeJS.ErrnoException)?.code ?? "read-failed") }; return snap; } finally { await fh.close().catch(() => {}); }
    }

    return {
        async read(o: { limit?: number; transcriptActiveMs?: number | null; now?: number } = {}): Promise<ModFeedReply> {
            inflight ??= refresh().finally(() => { inflight = null; });
            const s = await inflight;
            return replyFrom(s.rows, { size: s.size, bytesRead: s.bytesRead, truncated: s.truncated, malformed: s.malformed, oversized: s.oversized, droppedRows: s.dropped, error: s.error }, { ...o, lanes: s.lanes });
        },
    };
}

/** Newest .jsonl mtime under root (depth <= 5, no symlinks), async, single-flight, cached for ttlMs. Stats at most maxFiles (the last by name). */
export function createTranscriptActivity(root: string, opts: { ttlMs?: number; maxFiles?: number; now?: () => number } = {}) {
    const ttl = opts.ttlMs ?? 15_000, maxFiles = opts.maxFiles ?? 1000, now = opts.now ?? Date.now;
    let at = -Infinity, val: number | null = null, inflight: Promise<number | null> | null = null;
    async function walk(dir: string, depth: number, out: string[]): Promise<void> {
        let ents;
        try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            if (e.isSymbolicLink()) continue;
            const p = join(dir, e.name);
            if (e.isDirectory()) { if (depth < 5) await walk(p, depth + 1, out); }
            else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
        }
    }
    async function scan(): Promise<number | null> {
        const files: string[] = [];
        await walk(root, 0, files);
        files.sort();
        const pick = files.slice(-maxFiles);
        let best: number | null = null;
        for (let i = 0; i < pick.length; i += 32) {
            const ms = await Promise.all(pick.slice(i, i + 32).map(p => lstat(p).then(s => s.mtimeMs, () => null)));
            for (const m of ms) if (m !== null && (best === null || m > best)) best = m;
        }
        return best;
    }
    return {
        async get(): Promise<number | null> {
            if (now() - at <= ttl) return val;
            inflight ??= scan().catch(() => null).then(v => { val = v; at = now(); return v; }).finally(() => { inflight = null; });
            return inflight;
        },
    };
}
