// Server side of workTelemetry: ONE module-level feed state, a bounded and throttled transcript poll, then the pure model.
// Discovery and tailing are transcript-feed.ts's (pollTranscripts over a FeedFs); this file only BOUNDS them:
//   - at most maxFiles transcript files, newest first, none older than maxAgeMs;
//   - at most chunkBytes read per file and pollBytes per poll, so a first poll over a long history catches up across polls
//     (tailFrom keeps byte offsets) instead of blocking the server;
//   - the transcript poll runs at most once per minPollMs, and the answer for a repo is cached for the same time.
// fs only (stat for ages): no child process, no network. The answer is numbers and lane names; see telemetry-model.ts.
// 2026-10-11 (BB event loop stalled 20-48 s with several workTelemetry / fleetSnapshot in flight): this plugin runs INSIDE BB's server
// process, so the server path is now async end to end: fs/promises listing and reads (pollTranscriptsAsync), an unchanged file is not read
// again, the poll has a time budget (pollMs) beside the byte budget, the builds run as cooperative steps (yield-steps.ts), ONE poll is in
// flight at a time (shared by read and fleet), and a recompute that is slow or fails serves the last good answer marked stale.
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { asyncFromSync, claudeUsageIndex, createFeedState, fleetSourcesFromState, messageEventsFromState, nodeAsyncFeedFs, pollTranscriptsAsync, toolEventsFromState, TRANSCRIPT_ROOT, unitsFromState } from "../transcript-feed.ts";
import type { AsyncFeedFs, FeedFs, FeedState } from "../transcript-feed.ts";
import { createCodexFeed, CODEX_ROOT } from "./codex-feed.ts";
import type { CodexFeed, CodexSession } from "./codex-feed.ts";
import { createGeminiFeed, GEMINI_ROOT } from "./providers/gemini-feed.ts";
import { createCodexUsageFeed } from "./providers/codex-usage-feed.ts";
import type { CodexUsageFeed } from "./providers/codex-usage-feed.ts";
import { sealUsageIndexes } from "./call-usage-join.ts";
import type { UsageIndexes } from "./call-usage-join.ts";
import type { GeminiFeed, GeminiSession } from "./providers/gemini-feed.ts";
import { detectInstalled } from "./providers/detect.ts";
import { buildProviderStatus } from "./providers/status.ts";
import { redactReason } from "./sanitize.ts";
import { buildFleet } from "./fleet-model.ts";
import { sealFleet, sealWorkTelemetry } from "./opaque-key.ts";
import type { FleetSnapshot } from "./fleet-types.ts";
import { buildWorkTelemetrySteps, WINDOW_MS } from "./telemetry-model.ts";
import { runStepsAsync } from "./yield-steps.ts";
import type { WorkTelemetry } from "./telemetry-model.ts";
import type { WorkSurfaceSnapshot } from "./surface-types.ts";

export const TELEMETRY_LIMITS = {
  maxFiles: 1000, maxAgeMs: 7 * 86_400_000, chunkBytes: 4 * 1024 * 1024, pollBytes: 32 * 1024 * 1024, minPollMs: 5000,
  /** Wall time one poll may spend reading before the rest waits for the next poll (flagged catchingUp). */
  pollMs: 1500,
  /** Bytes the Codex usage reader may take per poll (it had no per-poll bound: 85 MB on a cold first poll, measured 2026-10-11). */
  codexPollBytes: 16 * 1024 * 1024,
  /** Uninterrupted work before the event loop gets a turn. */
  sliceMs: 10,
  /** With a last good answer in hand, a recompute slower than this answers with that answer marked stale (and keeps running). */
  answerMs: 2000,
  /** With NO answer yet, a first compute slower than this (a hung fs read) answers a loud "still reading" instead of never answering. */
  firstAnswerMs: 20_000,
} as const;
export type TelemetryLimits = { [K in keyof typeof TELEMETRY_LIMITS]: number };
export type TelemetryResult = { ok: true; value: WorkTelemetry } | { ok: false; reason: string };
export type FleetResult = { ok: true; value: FleetSnapshot } | { ok: false; reason: string };
type SnapshotResult = { ok: true; value: WorkSurfaceSnapshot } | { ok: false; reason: string };

export interface BoundedFs extends FeedFs { beginPoll(): void; capped(): boolean; /** mtime seen by the latest listing (no extra stat). */ listedMtime(path: string): number | null }
/** Wraps a FeedFs with the file-count, age, per-file and per-poll byte bounds. `mtimeOf` is injected so tests need no real clock. */
export function boundedFeedFs(inner: FeedFs, mtimeOf: (path: string) => number | null, now: () => number, limits: TelemetryLimits = TELEMETRY_LIMITS): BoundedFs {
  let budget = limits.pollBytes, capped = false, listed = new Map<string, number>();
  return {
    chunkLimit: limits.chunkBytes,
    beginPoll() { budget = limits.pollBytes; capped = false; },
    capped: () => capped,
    listedMtime: p => listed.get(p) ?? null,
    listJsonl(root) {
      const out = boundListing(inner.listJsonl(root).map(path => ({ path, mtimeMs: mtimeOf(path) })), now(), limits);
      listed = new Map(out.map(k => [k.path, k.mtimeMs]));
      return out.map(k => k.path);
    },
    readChunk(file, from) {
      if (budget <= 0) { capped = true; return { bytes: new Uint8Array(0), size: from }; } // no reset: the file just waits for the next poll
      // The allowance goes INTO the underlying read, so the budget bounds real I/O and allocation, not just the slice we keep.
      const r = inner.readChunk(file, from, Math.min(limits.chunkBytes, budget)), take = Math.min(r.bytes.length, limits.chunkBytes, budget);
      if (take < r.bytes.length || from + take < r.size) capped = true;
      budget -= take;
      return { bytes: r.bytes.subarray(0, take), size: r.size };
    },
    readText: p => inner.readText(p),
  };
}
const nodeMtime = (p: string): number | null => { try { return statSync(p).mtimeMs; } catch { return null; } };
/** THE listing bound (sync and async fs share it): inside maxAgeMs, newest first (path breaks ties), at most maxFiles. */
export function boundListing<T extends { path: string; mtimeMs: number | null }>(all: readonly T[], t: number, limits: Pick<TelemetryLimits, "maxAgeMs" | "maxFiles">): (T & { mtimeMs: number })[] {
  const kept = all.filter((f): f is T & { mtimeMs: number } => f.mtimeMs !== null && t - f.mtimeMs <= limits.maxAgeMs);
  kept.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1));
  return kept.slice(0, limits.maxFiles);
}
type Stale = { since: number; reason: string };
/** The first answer is late (D-138: said, not a silent hang). The read keeps going and the next call gets it. */
export const STILL_READING = "still reading transcript history: the first read has not finished yet, so there are no numbers to show; it keeps going and the next refresh will have them";
/** Resolve with `run`, or after `ms` with `late()` (the run keeps going and fills the cache). The timer never holds the process open. */
function within<T>(run: Promise<T>, ms: number, late: () => T): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(late()), ms);
    (timer as { unref?: () => void }).unref?.();
    run.then(v => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(late()); });
  });
}

export interface TelemetryDeps {
  readSnapshot(repo: string): Promise<SnapshotResult>;
  root?: string; fs?: FeedFs; /** An async transcript fs (tests spy on reads with it); wins over `fs`. */ asyncFs?: AsyncFeedFs; codex?: CodexFeed; codexUsage?: CodexUsageFeed; codexRoot?: string; gemini?: GeminiFeed; geminiRoot?: string; /** Installed-CLI probe (tests inject one; production checks the trusted install dirs). */ installed?: () => Record<string, boolean>; mtimeOf?: (path: string) => number | null; now?: () => number; limits?: Partial<TelemetryLimits>;
  /** Per-process salt for opaque fleet keys (tests inject one; production draws a random one per plugin load). */
  keySalt?: string;
}
/** ONE service per plugin load: holds the one FeedState. `read(repo)` expects a repo path already through assertAllowedRepo. */
export function createTelemetryService(d: TelemetryDeps) {
  const limits = { ...TELEMETRY_LIMITS, ...d.limits }, now = d.now ?? Date.now, root = d.root ?? TRANSCRIPT_ROOT;
  // Codex R4 M1: no raw session id leaves in a fleet payload. sealFleet (opaque-key.ts) is applied to EVERY fleet this service returns.
  const salt = d.keySalt ?? randomBytes(12).toString("hex");
  // An injected sync fs (tests, fixtures) is adapted; production reads with fs/promises. An injected mtimeOf replaces the listing's own mtime.
  const afs: AsyncFeedFs = d.asyncFs ?? (d.fs ? asyncFromSync(d.fs, d.mtimeOf ?? nodeMtime) : nodeAsyncFeedFs), mtimeOf = d.mtimeOf;
  // An injected transcript fs or root means a test or a sandbox: never fall back to the real ~/.codex then.
  const codexFeed: CodexFeed = d.codex ?? (d.fs || d.root || d.asyncFs ? { poll: () => [] } : createCodexFeed(undefined, now)), codexRoot = d.codexRoot ?? CODEX_ROOT;
  const geminiFeed: GeminiFeed = d.gemini ?? (d.fs || d.root || d.asyncFs ? { poll: () => [] } : createGeminiFeed(undefined, now)), geminiRoot = d.geminiRoot ?? GEMINI_ROOT, installed = d.installed ?? (() => (d.fs || d.root || d.asyncFs ? {} : detectInstalled()));
  const codexUsageFeed: CodexUsageFeed = d.codexUsage ?? (d.fs || d.root || d.asyncFs ? { poll: () => null } : createCodexUsageFeed(undefined, undefined, now));
  let codexUsageIdx: ReturnType<CodexUsageFeed["poll"]> = null, geminiSessions: GeminiSession[] = [], codexSessions: CodexSession[] = [], feed: FeedState = createFeedState(), lastPoll = -Infinity, info = { polledAt: 0, filesSeen: 0, newRows: 0, catchingUp: false, oversizedSkipped: 0 };
  let listedMtime = new Map<string, number>(), polling: Promise<void> | null = null;
  let seen: ReadonlyMap<string, string> = new Map();
  const clock = () => performance.now();
  const cache = new Map<string, { at: number; value: WorkTelemetry }>(), inflight = new Map<string, Promise<TelemetryResult>>();
  // The repo-free fleet answer (Toolcalls panel, no tracker chosen): same feed, same throttle; bead ids from the newest tracker join, if any.
  let beadByKey: ReadonlyMap<string, string> = new Map(), fleetHit: { at: number; value: FleetSnapshot } | null = null, fleetRun: Promise<FleetResult> | null = null;
  const listed = (p: string) => listedMtime.get(p) ?? null;
  // ONE heavy build at a time. Concurrent builds each yield, but their continuations run back to back inside one turn of the loop (5 at
  // once measured a 163 ms block on the real data), so builds queue here and the loop sees at most one slice of work per turn.
  let heavy: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(f: () => Promise<T>): Promise<T> => { const run = heavy.then(f, f); heavy = run.catch(() => undefined); return run; };
  /** At most one poll in flight: a caller that arrives during one shares it (the stall log showed several running at once). */
  function poll(t: number): Promise<void> {
    if (polling) return polling;
    if (t - lastPoll < limits.minPollMs) return Promise.resolve();
    lastPoll = t;
    polling = pollOnce(t).finally(() => { polling = null; });
    return polling;
  }
  async function pollOnce(t: number): Promise<void> {
    const start = clock(), deadline = start + limits.pollMs;
    const all = await afs.listJsonl(root);
    const files = boundListing(mtimeOf ? all.map(f => ({ ...f, mtimeMs: mtimeOf(f.path) })) : all, t, limits);
    listedMtime = new Map(files.map(f => [f.path, f.mtimeMs]));
    const r = await pollTranscriptsAsync(feed, files, afs, { chunkBytes: limits.chunkBytes, budgetBytes: limits.pollBytes, clock, deadline, sliceMs: limits.sliceMs, seen });
    feed = r.state; seen = r.seen; // swapped together, only after the poll finished
    try { codexSessions = codexFeed.poll(codexRoot); } catch { codexSessions = []; } // Codex is optional: a missing or unreadable ~/.codex is an empty fleet half
    let codexCapped = false;
    try { // the call -> usage join's Codex half: optional too
      if (codexUsageFeed.pollAsync) { const c = await codexUsageFeed.pollAsync(codexRoot, { budgetBytes: limits.codexPollBytes, deadline, sliceMs: limits.sliceMs, clock }); codexUsageIdx = c.index; codexCapped = c.capped; }
      else codexUsageIdx = codexUsageFeed.poll(codexRoot);
    } catch { codexUsageIdx = null; }
    try { geminiSessions = geminiFeed.poll(geminiRoot); } catch { geminiSessions = []; } // Gemini is optional too (and unverified on a real install)
    info = { polledAt: t, filesSeen: r.filesSeen, newRows: r.newRows, catchingUp: r.capped || codexCapped, oversizedSkipped: info.oversizedSkipped + r.oversized };
  }
  const ck = (repo: string, windowMs: number) => `${repo}\u0000${windowMs}`;
  async function compute(repo: string, windowMs: number): Promise<TelemetryResult> {
    try { return await computeInner(repo, windowMs); } catch (e) { return { ok: false, reason: redactReason((e as Error)?.message ?? "telemetry failed") }; }
  }
  async function computeInner(repo: string, windowMs: number): Promise<TelemetryResult> {
    const snap = await d.readSnapshot(repo);
    if (!snap.ok) return { ok: false, reason: redactReason(snap.reason) };
    const t = now();
    await poll(t);
    return exclusive(() => buildRead(repo, windowMs, snap.value, t));
  }
  async function buildRead(repo: string, windowMs: number, snapValue: WorkSurfaceSnapshot, t: number): Promise<TelemetryResult> {
    await turn();
    const pollInfo = info, state = feed;
    const built = await runStepsAsync(buildWorkTelemetrySteps(unitsFromState(state), snapValue.issues, snapValue.deps, t, pollInfo, { files: fleetSourcesFromState(state, listed), codex: codexSessions, gemini: geminiSessions, home: homedir(), messages: messageEventsFromState(state, undefined, t) }, windowMs, toolEventsFromState(state)), limits.sliceMs, clock);
    // The bead join needs the RAW keys (internal only), so it is read before the payload is sealed.
    beadByKey = new Map((built.fleet?.names ?? []).flatMap(n => (n.beadId ? [[n.key, n.beadId] as const] : [])));
    await turn();
    const value: WorkTelemetry = sealWorkTelemetry(built, salt);
    cache.set(ck(repo, windowMs), { at: t, value }); if (cache.size > 8) cache.delete(cache.keys().next().value!);
    return { ok: true, value };
  }
  async function computeFleet(t: number): Promise<FleetResult> {
    try {
      await poll(t);
      return await exclusive(() => buildFleetAnswer(t));
    } catch (e) { return { ok: false, reason: redactReason((e as Error)?.message ?? "fleet read failed") }; }
  }
  async function buildFleetAnswer(t: number): Promise<FleetResult> {
    try {
      await turn();
      const state = feed;
      const built = buildFleet({ files: fleetSourcesFromState(state, listed), codex: codexSessions, gemini: geminiSessions, home: homedir(), beadByKey, messages: messageEventsFromState(state, undefined, t) }, t);
      await turn();
      // Claude + Codex have a transcript reader for the call -> usage join; Gemini has none yet, so its calls say "provider not read".
      const raw: UsageIndexes = { claude: claudeUsageIndex(state), ...(codexUsageIdx ? { codex: codexUsageIdx } : {}) };
      await turn();
      const callUsage = sealUsageIndexes(raw, salt);
      await turn();
      const value = sealFleet({ ...built, providers: buildProviderStatus(installed(), built.summary.byRuntime), callUsage }, salt);
      fleetHit = { at: t, value };
      return { ok: true, value };
    } catch (e) { return { ok: false, reason: redactReason((e as Error)?.message ?? "fleet read failed") }; }
  }
  const staleTelemetry = (hit: { at: number; value: WorkTelemetry }, reason: string): TelemetryResult => ({ ok: true, value: { ...hit.value, freshness: { ...hit.value.freshness, stale: { since: hit.at, reason: redactReason(reason) } } } });
  const staleFleet = (hit: { at: number; value: FleetSnapshot }, reason: string): FleetResult => ({ ok: true, value: { ...hit.value, stale: { since: hit.at, reason: redactReason(reason) } as Stale } });
  return {
    /** `windowMs` = how far back the totals reach (the Calls range control); the default is the 7-day window. Each (repo, window) is cached on its own.
     *  Concurrent and back-to-back calls share one computation; with a last good answer, a slow or failed recompute answers with it, marked stale. */
    read(repo: string, windowMs: number = WINDOW_MS): Promise<TelemetryResult> {
      const key = ck(repo, windowMs), hit = cache.get(key);
      if (hit && now() - hit.at < limits.minPollMs) return Promise.resolve({ ok: true, value: hit.value });
      const run = inflight.get(key) ?? inflight.set(key, compute(repo, windowMs).finally(() => inflight.delete(key))).get(key)!;
      if (!hit) return within(run, limits.firstAnswerMs, () => ({ ok: false, reason: STILL_READING }));
      return within(run.then(r => (r.ok ? r : staleTelemetry(hit, r.reason))), limits.answerMs, () => staleTelemetry(hit, "recomputing"));
    },
    /** Every agent lane on this machine, named, without a tracker repo. Lanes carry bead ids only once some repo's read has joined them. */
    fleet(): Promise<FleetResult> {
      const t = now(), hit = fleetHit;
      if (hit && t - hit.at < limits.minPollMs) return Promise.resolve({ ok: true, value: hit.value });
      const run = fleetRun ?? (fleetRun = computeFleet(t).finally(() => { fleetRun = null; }));
      if (!hit) return within(run, limits.firstAnswerMs, () => ({ ok: false, reason: STILL_READING }));
      return within(run.then(r => (r.ok ? r : staleFleet(hit, r.reason))), limits.answerMs, () => staleFleet(hit, "recomputing"));
    },
  };
}
const turn = (): Promise<void> => new Promise(r => setImmediate(r));
