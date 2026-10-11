/**
 * Server-side, read-only, incremental tailer over Claude Code transcripts
 * (`~/.claude/projects/<project>/**\/*.jsonl` + `subagents/agent-<id>.meta.json`).
 * Byte offsets per file, via cache-economics `tailFrom`. fs only: no child processes, no network.
 *
 * PRIVACY: only usage numbers, ids, model, timestamps and the agent name/description leave a line.
 * `parseUsageLines` already whitelists the usage fields; the only other thing read from a line is the
 * `bead=<id>` tag, extracted by pattern from the first user message and the rest of the text is dropped.
 * Message content is never stored, returned or logged.
 */
import { lstatSync, openSync, readSync, closeSync, readFileSync, readdirSync } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { dedupeRows, parseUsageLines, sourceFromPath, tailFrom } from "./cache-economics.ts";
import type { ReadChunk, UsageRow, UsageSource } from "./cache-economics.ts";
import type { TelemetryUnit } from "./telemetry-join.ts";
import { messageEventsFromLine } from "./work/message-flow.ts";
import { FLEET_OPEN_MAX } from "./work/fleet-types.ts";
import { claudeIndex, claudeToolUses, INDEX_MAX_CALLS } from "./work/providers/call-usage-index.ts";
import type { ProviderIndex } from "./work/call-usage-join.ts";
import { MAX_TOOL_EVENTS, toolOutputFacts } from "./work/tool-output-facts.ts";
import type { PendingTool, ToolOutputEvent } from "./work/tool-output-facts.ts";
import type { LastTool, LastTurn, MessageEvent, OpenTool } from "./work/fleet-types.ts";

export const TRANSCRIPT_ROOT = join(homedir(), ".claude", "projects");
/** Per-read cap; offsets advance to the last newline, so a bigger backlog is caught up across polls. */
const MAX_CHUNK = 16 * 1024 * 1024;

export interface FeedFs {
    /** Absolute paths of candidate `.jsonl` files under root (regular files only). */
    listJsonl(root: string): string[];
    readChunk: ReadChunk;
    /** The most bytes one readChunk returns. Lets tailFrom tell a record longer than a read apart from a writer that is still mid-append. */
    chunkLimit?: number;
    /** Whole small text file, or null when absent. */
    readText(path: string): string | null;
}
export const nodeFeedFs: FeedFs = {
    chunkLimit: MAX_CHUNK,
    listJsonl(root) {
        const out: string[] = [];
        const walk = (dir: string, depth: number) => {
            let names: string[];
            try { names = readdirSync(dir); } catch { return; }
            for (const n of names) {
                const p = join(dir, n);
                let st;
                try { st = lstatSync(p); } catch { continue; }
                if (st.isSymbolicLink())
                    continue;
                if (st.isDirectory() && depth < 5)
                    walk(p, depth + 1);
                else if (st.isFile() && n.endsWith(".jsonl"))
                    out.push(p);
            }
        };
        walk(root, 0);
        return out.sort();
    },
    readChunk(file, from, max) {
        const fd = openSync(file, "r");
        try {
            const size = lstatSync(file).size;
            if (size <= from)
                return { bytes: new Uint8Array(0), size };
            const len = Math.min(size - from, MAX_CHUNK, Math.max(0, max ?? MAX_CHUNK)), buf = Buffer.alloc(len), n = readSync(fd, buf, 0, len, from);
            return { bytes: buf.subarray(0, n), size };
        } finally { closeSync(fd); }
    },
    readText(path) {
        try { return readFileSync(path, "utf8"); } catch { return null; }
    }
};

/** `agent-a<lane>-<16 hex>` -> `<lane>`. Teammate agent ids embed the lane name; others do not. */
export function laneFromAgentId(agentId: string | null): string | null {
    const m = agentId ? /^a(.+)-[0-9a-f]{16}$/.exec(agentId) : null;
    return m ? m[1] : null;
}
export interface LaneMeta { name: string | null; description: string | null; agentType: string | null; model: string | null; parentAgentId: string | null; worktreePath: string | null; workflowPhase: string | null; taskKind: string | null }
/** Whitelist the meta.json fields. The lane name is `name`, else the id-embedded name, else null. */
export function parseLaneMeta(text: string | null): LaneMeta {
    let m: Record<string, unknown> = {};
    try { const v = text ? JSON.parse(text) : null; if (v && typeof v === "object" && !Array.isArray(v)) m = v as Record<string, unknown>; } catch { /* tolerated: meta is optional */ }
    const s = (v: unknown) => typeof v === "string" && v.length ? v : null;
    // worktreePath is server-side only (fleet-model derives a short display name from it; it is never output raw).
    return { name: s(m.name), description: s(m.description), agentType: s(m.agentType), model: s(m.model), parentAgentId: s(m.parentAgentId), worktreePath: s(m.worktreePath), workflowPhase: s(m.workflowPhase), taskKind: s(m.taskKind) };
}

const BEAD_TAG = /\bbead=([A-Za-z0-9][A-Za-z0-9._-]{0,63})/;
/** The `bead=<id>` value in a string, or null. Trailing dots are sentence punctuation. Only the id is returned. */
export function detectBeadTag(text: string | null): string | null {
    const m = text ? BEAD_TAG.exec(text) : null;
    return m ? m[1].replace(/[.-]+$/, "") : null;
}
/**
 * Bead tag from ONE transcript line, only when it is a user message. The content is searched and dropped;
 * nothing but the matched id survives. Returns `seen: true` for any user line so the caller stops after the first.
 */
export function beadTagFromLine(line: string): { seen: boolean; tag: string | null } {
    let o: unknown;
    try { o = JSON.parse(line); } catch { return { seen: false, tag: null }; }
    const rec = o && typeof o === "object" ? o as Record<string, unknown> : {}, msg = rec.message && typeof rec.message === "object" ? rec.message as Record<string, unknown> : {};
    if (rec.type !== "user")
        return { seen: false, tag: null };
    const c = msg.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map(p => p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string" ? (p as Record<string, unknown>).text as string : "").join("\n") : "";
    return { seen: true, tag: detectBeadTag(text) };
}

/** Per-file bound on kept message events (newest). */
const MAX_FILE_MESSAGES = 200;
interface FileState { /** The reader has read to the end of the file as listed (cold catch-up in progress when false). */ atTail: boolean; messages: MessageEvent[]; calls: Map<string, string>; open: OpenTool[]; lastTurn: LastTurn | null; lastTool: LastTool | null; rows: UsageRow[]; /** tool_use id -> request key (ids only), for the call->usage join. */ toolReq: Map<string, string>; meta: LaneMeta; beadTag: string | null; sawUser: boolean; sessionId: string; agentId: string | null; cwd: string | null; gitBranch: string | null; firstAt: number | null; lastAt: number | null; /** Tool results as sizes (work/tool-output-facts). Optional: a hand-built state has none. */ tools?: ToolOutputEvent[]; toolPending?: Map<string, PendingTool> }

/** The only three fields read from a line for the fleet: cwd, gitBranch, timestamp. The parsed line is dropped by the caller. */
function lineFacts(line: string): { cwd: string | null; gitBranch: string | null; at: number | null } {
    let o: unknown;
    try { o = JSON.parse(line); } catch { return { cwd: null, gitBranch: null, at: null }; }
    const r = o && typeof o === "object" ? o as Record<string, unknown> : {}, at = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
    return { cwd: typeof r.cwd === "string" && r.cwd ? r.cwd : null, gitBranch: typeof r.gitBranch === "string" && r.gitBranch ? r.gitBranch : null, at: Number.isFinite(at) ? at : null };
}
const FACT_SCAN = 5, LAST_SCAN = 64;
/** Fleet facts from one chunk: cwd/branch from the first few lines until known, lastAt from the newest TIMED line near the end (Claude Code
 *  appends untimed mode / last-prompt / ai-title records after most turns, so the very last line usually has no time), firstAt from the
 *  first line that has a time. */
function chunkFacts(st: FileState, lines: string[]): Pick<FileState, "cwd" | "gitBranch" | "firstAt" | "lastAt"> {
    let { cwd, gitBranch, firstAt, lastAt } = st;
    if (!lines.length)
        return { cwd, gitBranch, firstAt, lastAt };
    for (let i = 0; i < Math.min(lines.length, FACT_SCAN) && (cwd === null || firstAt === null); i++) {
        const f = lineFacts(lines[i]);
        cwd = cwd ?? f.cwd; gitBranch = gitBranch ?? f.gitBranch;
        if (firstAt === null) firstAt = f.at;
    }
    let last = lineFacts(lines[lines.length - 1]);
    for (let i = lines.length - 2; last.at === null && i >= Math.max(0, lines.length - LAST_SCAN); i--) last = lineFacts(lines[i]);
    if (last.at !== null) lastAt = lastAt === null ? last.at : Math.max(lastAt, last.at);
    cwd = cwd ?? last.cwd; gitBranch = last.gitBranch ?? gitBranch;
    return { cwd, gitBranch, firstAt, lastAt };
}
const TOOL_NAME = /^[A-Za-z0-9._:-]{1,64}$/;
/** Open tool calls and the last turn from a chunk (metadata only). Verified shapes: an assistant record's content holds `tool_use` blocks
 *  { id, name, input } and message.stop_reason ("end_turn" closes a turn); a user record closes a call with a `tool_result` block carrying
 *  `tool_use_id`; a user record with no tool_result is a human or teammate turn and leaves open calls alone (an interrupt writes its own tool_result).
 *  Only the id, the tool NAME and the time are read from a block; input and result are never touched. `open` is capped at FLEET_OPEN_MAX (newest). */
function turnFacts(st: FileState, lines: string[]): Pick<FileState, "open" | "lastTurn" | "lastTool"> {
    let open = st.open, lastTurn = st.lastTurn, lastTool = st.lastTool;
    for (const l of lines) {
        const asst = l.includes('"type":"assistant"'), usr = !asst && l.includes('"type":"user"');
        if (!asst && !usr)
            continue;
        let o: unknown;
        try { o = JSON.parse(l); } catch { continue; }
        const r = o && typeof o === "object" ? o as Record<string, unknown> : {}, msg = r.message && typeof r.message === "object" ? r.message as Record<string, unknown> : {};
        const at = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN, blocks = Array.isArray(msg.content) ? msg.content as unknown[] : [];
        if (!Number.isFinite(at) || (r.type !== "assistant" && r.type !== "user"))
            continue;
        if (r.type === "assistant") {
            const added: OpenTool[] = [];
            for (const b of blocks) {
                const x = b && typeof b === "object" ? b as Record<string, unknown> : {};
                if (x.type === "tool_use" && typeof x.id === "string" && x.id) added.push({ id: x.id, tool: typeof x.name === "string" && TOOL_NAME.test(x.name) ? x.name : "?", at });
            }
            if (added.length) open = [...open.filter(t => !added.some(a => a.id === t.id)), ...added].slice(-FLEET_OPEN_MAX);
            lastTurn = { at, role: "assistant", endTurn: msg.stop_reason === "end_turn" };
        } else {
            const closed = new Set<string>();
            for (const b of blocks) {
                const x = b && typeof b === "object" ? b as Record<string, unknown> : {};
                if (x.type === "tool_result" && typeof x.tool_use_id === "string") closed.add(x.tool_use_id);
            }
            // A closure records the newest closed tool: name + start from the open entry, end = this record's time.
            for (const t of open) if (closed.has(t.id) && (lastTool === null || at >= lastTool.endedAt)) lastTool = { tool: t.tool, at: t.at, endedAt: at };
            if (closed.size) open = open.filter(t => !closed.has(t.id));
            lastTurn = { at, role: "user", endTurn: false };
        }
    }
    return { open, lastTurn, lastTool };
}
export interface FeedState { offsets: Record<string, number>; files: Record<string, FileState> }
export const createFeedState = (): FeedState => ({ offsets: {}, files: {} });
export interface PollResult { state: FeedState; newRows: number; filesSeen: number; resets: string[]; malformed: number; /** Records stepped over because one record was longer than a read. */ oversized: number }

interface PollAcc { newRows: number; malformed: number; filesSeen: number; oversized: number; resets: string[] }
const metaPathOf = (file: string) => file.replace(/\.jsonl$/, ".meta.json");
/** One file's share of a poll, shared by the sync and the async poll so both build the SAME state. `files` / `offsets` are the poll's own
 *  copies (mutated here, never the caller's input). `metaText` reads the lane's meta.json (called only for a subagent file). */
function stepFile(files: Record<string, FileState>, offsets: Record<string, number>, file: string, src: UsageSource, read: ReadChunk, chunkLimit: number | undefined, metaText: () => string | null, acc: PollAcc): void {
    let tail, readFrom = 0, readLen = 0, readSize = 0;
    // Remember the last read's window so the poll can tell reaching the end of the file apart from catching up (td-osi.37 / Codex M3).
    const probe: ReadChunk = (f, from) => { const c = read(f, from); readFrom = from; readLen = c.bytes.length; readSize = c.size; return c; };
    // tailFrom returns a COPY of the offsets it is given: hand it this file's entry only (copying all ~1000 per file was O(files^2) per poll).
    try { tail = tailFrom(Object.hasOwn(offsets, file) ? { [file]: offsets[file] } : {}, file, probe, chunkLimit); } catch { return; }
    offsets[file] = tail.offsets[file];
    if (tail.oversized) acc.oversized++;
    let st: FileState = files[file] ?? { atTail: false, messages: [], calls: new Map(), open: [], lastTurn: null, lastTool: null, rows: [], toolReq: new Map(), meta: parseLaneMeta(src.agentId ? metaText() : null), beadTag: null, sawUser: false, sessionId: src.sessionId, agentId: src.agentId, cwd: null, gitBranch: null, firstAt: null, lastAt: null };
    if (tail.reset) {
        acc.resets.push(file);
        st = { ...st, tools: [], toolPending: new Map(), rows: [], toolReq: new Map(), messages: [], calls: new Map(), open: [], lastTurn: null, lastTool: null, beadTag: null, sawUser: false, cwd: null, gitBranch: null, firstAt: null, lastAt: null };
    }
    // Meta can appear a moment after the transcript: retry until a name is known.
    if (src.agentId && !st.meta.name && !st.meta.description)
        st = { ...st, meta: parseLaneMeta(metaText()) };
    let { beadTag, sawUser } = st;
    if (!sawUser)
        for (const l of tail.lines) {
            const b = beadTagFromLine(l);
            if (b.seen) { sawUser = true; beadTag = b.tag; break; }
        }
    const parsed = parseUsageLines(tail.lines, src);
    acc.malformed += parsed.malformed;
    acc.newRows += parsed.rows.length;
    // Message events: a substring prefilter inside messageEventsFromLine keeps JSON.parse off nearly every line. The pending-call map is copied so the input state stays unmutated.
    const calls = new Map(st.calls), lane = st.meta.name ?? laneFromAgentId(st.agentId) ?? (st.agentId ? null : "main"), found: MessageEvent[] = [];
    for (const l of tail.lines) found.push(...messageEventsFromLine(l, st.agentId ?? st.sessionId, lane, calls));
    const messages = found.length ? [...st.messages, ...found].slice(-MAX_FILE_MESSAGES) : st.messages;
    const tf = toolOutputFacts(st.toolPending ?? new Map(), tail.lines), tools = tf.events.length ? [...(st.tools ?? []), ...tf.events].slice(-MAX_TOOL_EVENTS) : st.tools;
    // An empty read (a spent byte budget reports size = from) proves nothing, so the earlier verdict stands.
    const atTail = readLen > 0 ? readFrom + readLen >= readSize : tail.reset ? false : st.atTail;
    // Call -> request ids (no content): a copy, so the input state stays unmutated; capped per file, oldest dropped first.
    let toolReq = st.toolReq;
    for (const l of tail.lines) {
        const t = claudeToolUses(l);
        if (!t) continue;
        if (toolReq === st.toolReq) toolReq = new Map(st.toolReq);
        for (const id of t.ids) toolReq.set(id, t.key);
    }
    if (toolReq.size > INDEX_MAX_CALLS) toolReq = new Map([...toolReq].slice(-INDEX_MAX_CALLS));
    files[file] = { ...st, atTail, messages, calls, toolReq, tools, toolPending: tf.pending, ...turnFacts(st, tail.lines), ...chunkFacts(st, tail.lines), rows: parsed.rows.length ? dedupeRows([...st.rows, ...parsed.rows]) : st.rows, beadTag, sawUser };
}
/** A file that left the listing (aged out of the read window, or past the file bound) leaves the state too, so memory and the fleet's
 *  counts stay bounded by the listing (review MED-3). A listed file the byte budget skipped this poll is kept. An EMPTY listing over a
 *  populated state is a failed read of the root (the fs swallows readdir errors), not "every agent left". */
function pruneUnlisted(files: Record<string, FileState>, offsets: Record<string, number>, listed: readonly string[]): void {
    const keep = new Set(listed);
    if (listed.length || !Object.keys(files).length) {
        for (const f of Object.keys(files)) if (!keep.has(f)) delete files[f];
        for (const f of Object.keys(offsets)) if (!keep.has(f)) delete offsets[f];
    }
}
/** One poll: read every file's new complete lines. The input state is not mutated. */
export function pollTranscripts(prev: FeedState, root: string = TRANSCRIPT_ROOT, fs: FeedFs = nodeFeedFs): PollResult {
    const offsets = { ...prev.offsets }, files: Record<string, FileState> = { ...prev.files };
    const acc: PollAcc = { newRows: 0, malformed: 0, filesSeen: 0, oversized: 0, resets: [] };
    const listed = fs.listJsonl(root);
    for (const file of listed) {
        const src = sourceFromPath(file);
        if (!src)
            continue;
        acc.filesSeen++;
        stepFile(files, offsets, file, src, (f, from) => fs.readChunk(f, from), fs.chunkLimit, () => fs.readText(metaPathOf(file)), acc);
    }
    pruneUnlisted(files, offsets, listed);
    return { state: { offsets, files }, newRows: acc.newRows, filesSeen: acc.filesSeen, resets: acc.resets, malformed: acc.malformed, oversized: acc.oversized };
}

// ---- the async poll (2026-10-11): the server's path. Same state as pollTranscripts, but fs/promises only and it yields the loop. ----
/** One listed transcript with the stat the listing already took (no second stat): mtime for the age bound, size + inode for "unchanged". */
export interface ListedFile { path: string; mtimeMs: number | null; size: number | null; ino: number | null }
export interface AsyncFeedFs {
    listJsonl(root: string): Promise<ListedFile[]>;
    readChunk(file: string, from: number, max?: number): Promise<{ bytes: Uint8Array; size: number }>;
    readText(path: string): Promise<string | null>;
}
export const nodeAsyncFeedFs: AsyncFeedFs = {
    async listJsonl(root) {
        const out: ListedFile[] = [];
        const walk = async (dir: string, depth: number): Promise<void> => {
            let names: string[];
            try { names = await readdir(dir); } catch { return; }
            const subs: Promise<void>[] = [];
            await Promise.all(names.map(async n => {
                const p = join(dir, n);
                let st;
                try { st = await lstat(p); } catch { return; }
                if (st.isSymbolicLink())
                    return;
                if (st.isDirectory() && depth < 5)
                    subs.push(walk(p, depth + 1));
                else if (st.isFile() && n.endsWith(".jsonl"))
                    out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size, ino: st.ino });
            }));
            await Promise.all(subs);
        };
        await walk(root, 0);
        return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },
    async readChunk(file, from, max) {
        const fh = await open(file, "r");
        try {
            const size = (await lstat(file)).size;
            if (size <= from)
                return { bytes: new Uint8Array(0), size };
            const len = Math.min(size - from, MAX_CHUNK, Math.max(0, max ?? MAX_CHUNK)), buf = Buffer.alloc(len), { bytesRead } = await fh.read(buf, 0, len, from);
            return { bytes: buf.subarray(0, bytesRead), size };
        } finally { await fh.close(); }
    },
    async readText(path) {
        try { return await readFile(path, "utf8"); } catch { return null; }
    },
};
/** An injected sync FeedFs (tests, fixtures) as an AsyncFeedFs. Size / inode are unknown, so nothing is ever skipped as unchanged. */
export const asyncFromSync = (fs: FeedFs, mtimeOf: (path: string) => number | null): AsyncFeedFs => ({
    listJsonl: async root => fs.listJsonl(root).map(path => ({ path, mtimeMs: mtimeOf(path), size: null, ino: null })),
    readChunk: async (file, from, max) => fs.readChunk(file, from, max),
    readText: async path => fs.readText(path),
});
export interface AsyncPollOptions {
    /** Bytes one file may read this poll (the per-file window; also tailFrom's oversized-record limit). */
    chunkBytes: number;
    /** Bytes the whole poll may read. Spent => every later file gets the empty read a spent budget gives (state kept, `capped`). */
    budgetBytes: number;
    /** Clock (ms) for the time budget and the yield cadence. */
    clock: () => number;
    /** No new read starts after this clock time: the rest wait for the next poll (`capped`). */
    deadline: number;
    /** Give the event loop a turn after this much uninterrupted work (ms). */
    sliceMs: number;
    /** Per-file stat memo from the previous poll: path -> "size:mtime:ino" of the last poll that read it to its end. Never mutated: the
     *  updated memo is returned with the state, so a poll that throws half way leaves both untouched (the caller swaps them together). */
    seen: ReadonlyMap<string, string>;
}
export interface AsyncPollResult extends PollResult { /** The stat memo to pass to the next poll, together with `state`. */ seen: Map<string, string>; /** The byte or time budget ran out before every file was read to its end. */ capped: boolean; /** Files skipped as unchanged (no read). */ skipped: number; bytesRead: number }
const yieldLoop = () => new Promise<void>(r => setImmediate(r));
/** The async poll: the SAME per-file step and order as pollTranscripts (identical state for the same bytes), over fs/promises. It never
 *  re-reads a file whose (size, mtime, inode) match the last poll that read it to its end (an unchanged file's empty read changes no state),
 *  bounds bytes and time per poll, and yields the event loop every `sliceMs` of work. One file's step (<= chunkBytes) is the largest slice. */
export async function pollTranscriptsAsync(prev: FeedState, listed: readonly ListedFile[], fs: AsyncFeedFs, o: AsyncPollOptions): Promise<AsyncPollResult> {
    const offsets = { ...prev.offsets }, files: Record<string, FileState> = { ...prev.files };
    const acc: PollAcc = { newRows: 0, malformed: 0, filesSeen: 0, oversized: 0, resets: [] };
    const seen = new Map(o.seen);
    let budget = o.budgetBytes, capped = false, skipped = 0, bytesRead = 0, slice = o.clock();
    const EMPTY = new Uint8Array(0);
    for (const f of listed) {
        const file = f.path, src = sourceFromPath(file);
        if (!src)
            continue;
        acc.filesSeen++;
        const stamp = f.size === null || f.ino === null || f.mtimeMs === null ? null : `${f.size}:${f.mtimeMs}:${f.ino}`, st = files[file];
        // Unchanged since it was last read to its end, and its lane meta settled: the sync poll's empty read would leave its state as is.
        if (stamp !== null && st && seen.get(file) === stamp && !(src.agentId && !st.meta.name && !st.meta.description)) { skipped++; continue; }
        const from0 = Object.hasOwn(offsets, file) ? offsets[file] : 0, spent = budget <= 0 || o.clock() >= o.deadline;
        let first: { bytes: Uint8Array; size: number }, again: { bytes: Uint8Array; size: number } | null = null;
        if (spent) { capped = true; first = { bytes: EMPTY, size: from0 }; } // no reset: the file just waits for the next poll
        else {
            // Byte accounting exactly as boundedFeedFs: each read is allowed min(chunkBytes, what is left), and a spent budget answers empty.
            const take = async (from: number) => {
                if (budget <= 0) { capped = true; return { bytes: EMPTY, size: from }; }
                const allow = Math.min(o.chunkBytes, budget), r = await fs.readChunk(file, from, allow), n = Math.min(r.bytes.length, allow);
                if (n < r.bytes.length || from + n < r.size) capped = true;
                budget -= n; bytesRead += n;
                return { bytes: r.bytes.subarray(0, n), size: r.size };
            };
            try {
                first = await take(from0);
                if (first.size < from0) again = await take(0); // truncated / rotated: tailFrom restarts from 0
            } catch { continue; } // vanished between listing and read: the sync poll's tailFrom throw skips it the same way
        }
        let meta: string | null = null;
        if (src.agentId && (!st || (!st.meta.name && !st.meta.description))) meta = await fs.readText(metaPathOf(file));
        const replay: ReadChunk = (_f, from) => (again && from === 0 ? again : from === from0 ? first : { bytes: EMPTY, size: from });
        stepFile(files, offsets, file, src, replay, o.chunkBytes, () => meta, acc);
        const done = again ?? first, doneAt = again ? 0 : from0;
        if (!spent && stamp !== null && done.size === f.size && doneAt + done.bytes.length >= done.size) seen.set(file, stamp);
        else seen.delete(file);
        if (o.clock() - slice >= o.sliceMs) { await yieldLoop(); slice = o.clock(); }
    }
    const paths = listed.map(f => f.path);
    pruneUnlisted(files, offsets, paths);
    for (const p of [...seen.keys()]) if (!Object.hasOwn(files, p)) seen.delete(p);
    return { state: { offsets, files }, seen, newRows: acc.newRows, filesSeen: acc.filesSeen, resets: acc.resets, malformed: acc.malformed, oversized: acc.oversized, capped, skipped, bytesRead };
}

/** Join-ready units, one per transcript file. Files with no usage rows are dropped. */
export function unitsFromState(state: FeedState): TelemetryUnit[] {
    return Object.values(state.files).filter(f => f.rows.length).map(f => ({
        lane: f.meta.name ?? laneFromAgentId(f.agentId), sessionId: f.sessionId, agentId: f.agentId, rows: f.rows, beadTag: f.beadTag ?? detectBeadTag(f.meta.description)
    }));
}

/** The Claude half of the call->usage index (call-usage-join.ts): tool_use id -> request key -> usage, across every transcript file read. */
export function claudeUsageIndex(state: FeedState): ProviderIndex {
    return claudeIndex(Object.values(state.files).filter(f => f.toolReq.size).map(f => ({ sessionId: f.sessionId, agentId: f.agentId, rows: f.rows, toolReq: f.toolReq })));
}

/** Per transcript file: the lane name and the tool-result sizes read so far (work/tool-output-facts). Sizes, tool names and basenames only. */
export function toolEventsFromState(state: FeedState): { lane: string | null; sessionId: string; agentId: string | null; events: ToolOutputEvent[] }[] {
    return Object.values(state.files).filter(f => f.tools?.length).map(f => ({ lane: f.meta.name ?? laneFromAgentId(f.agentId), sessionId: f.sessionId, agentId: f.agentId, events: f.tools! }));
}

/** What fleet-model needs from each transcript file, INCLUDING files with no usage rows yet (a just-started agent is live). */
export interface FleetSource {
    /** Lane name: meta.name, else the id-embedded name, else null (resolved here so fleet-model stays free of node imports). */
    lane: string | null;
    sessionId: string; agentId: string | null; meta: LaneMeta; rows: UsageRow[]; beadTag: string | null;
    cwd: string | null; gitBranch: string | null; firstAt: number | null; lastAt: number | null;
    /** Tool calls with no result yet, and the newest user/assistant turn (td-osi.21.2). Optional: a hand-built source without them has none. */
    open?: readonly OpenTool[]; lastTurn?: LastTurn | null; lastTool?: LastTool | null;
    /** False while the reader is still catching up on a big transcript: open / lastTurn / lastTool then describe history, not the present. Absent = at tail. */
    atTail?: boolean;
}
/** `mtimeOf` (optional): the file's last write time from the listing's stat. It lifts lastAt, so a lane whose big transcript is still being
 *  caught up (4 MiB per file per poll) reads live from its FIRST poll instead of after the backlog is read (a 33 MB transcript took ~9 polls). */
export function fleetSourcesFromState(state: FeedState, mtimeOf?: (path: string) => number | null): FleetSource[] {
    return Object.entries(state.files).map(([path, f]) => {
        // A record more than a day newer than the file's own last write is a bogus clock: ignore it and trust the mtime.
        const m = mtimeOf?.(path) ?? null, lastAt = m === null ? f.lastAt : f.lastAt === null || f.lastAt > m + 86_400_000 ? m : Math.max(f.lastAt, m);
        return { lane: f.meta.name ?? laneFromAgentId(f.agentId), sessionId: f.sessionId, agentId: f.agentId, meta: f.meta, rows: f.rows, beadTag: f.beadTag, cwd: f.cwd, gitBranch: f.gitBranch, firstAt: f.firstAt, lastAt, open: f.open, lastTurn: f.lastTurn, lastTool: f.lastTool, atTail: f.atTail };
    });
}

/** Message events across every file, newest first, at most `limit` (the fleet snapshot carries 300). */
/** `now` (optional): events stamped more than a minute ahead of it are a bad clock and are dropped BEFORE the cap, so they cannot push real
 *  events out of the 300. Without it nothing is dropped here (the model still ignores them). */
export function messageEventsFromState(state: FeedState, limit = 300, now?: number): MessageEvent[] {
  return Object.values(state.files).flatMap(f => f.messages).filter(e => now === undefined || e.at <= now + 60_000).sort((a, b) => b.at - a.at).slice(0, limit);
}
