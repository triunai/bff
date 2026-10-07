// Server side of workTelemetry: ONE module-level feed state, a bounded and throttled transcript poll, then the pure model.
// Discovery and tailing are transcript-feed.ts's (pollTranscripts over a FeedFs); this file only BOUNDS them:
//   - at most maxFiles transcript files, newest first, none older than maxAgeMs;
//   - at most chunkBytes read per file and pollBytes per poll, so a first poll over a long history catches up across polls
//     (tailFrom keeps byte offsets) instead of blocking the server;
//   - the transcript poll runs at most once per minPollMs, and the answer for a repo is cached for the same time.
// fs only (stat for ages): no child process, no network. The answer is numbers and lane names; see telemetry-model.ts.
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { claudeUsageIndex, createFeedState, fleetSourcesFromState, messageEventsFromState, nodeFeedFs, pollTranscripts, toolEventsFromState, TRANSCRIPT_ROOT, unitsFromState } from "../transcript-feed.ts";
import type { FeedFs, FeedState } from "../transcript-feed.ts";
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
import { buildWorkTelemetry, WINDOW_MS } from "./telemetry-model.ts";
import type { WorkTelemetry } from "./telemetry-model.ts";
import type { WorkSurfaceSnapshot } from "./surface-types.ts";

export const TELEMETRY_LIMITS = { maxFiles: 1000, maxAgeMs: 7 * 86_400_000, chunkBytes: 4 * 1024 * 1024, pollBytes: 32 * 1024 * 1024, minPollMs: 5000 } as const;
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
      const t = now(), all = inner.listJsonl(root), kept: { p: string; m: number }[] = [];
      for (const p of all) { const m = mtimeOf(p); if (m !== null && t - m <= limits.maxAgeMs) kept.push({ p, m }); }
      kept.sort((a, b) => b.m - a.m || (a.p < b.p ? -1 : 1));
      const out = kept.slice(0, limits.maxFiles);
      listed = new Map(out.map(k => [k.p, k.m]));
      return out.map(k => k.p);
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

export interface TelemetryDeps {
  readSnapshot(repo: string): Promise<SnapshotResult>;
  root?: string; fs?: FeedFs; codex?: CodexFeed; codexUsage?: CodexUsageFeed; codexRoot?: string; gemini?: GeminiFeed; geminiRoot?: string; /** Installed-CLI probe (tests inject one; production checks the trusted install dirs). */ installed?: () => Record<string, boolean>; mtimeOf?: (path: string) => number | null; now?: () => number; limits?: Partial<TelemetryLimits>;
  /** Per-process salt for opaque fleet keys (tests inject one; production draws a random one per plugin load). */
  keySalt?: string;
}
/** ONE service per plugin load: holds the one FeedState. `read(repo)` expects a repo path already through assertAllowedRepo. */
export function createTelemetryService(d: TelemetryDeps) {
  const limits = { ...TELEMETRY_LIMITS, ...d.limits }, now = d.now ?? Date.now, root = d.root ?? TRANSCRIPT_ROOT;
  // Codex R4 M1: no raw session id leaves in a fleet payload. sealFleet (opaque-key.ts) is applied to EVERY fleet this service returns.
  const salt = d.keySalt ?? randomBytes(12).toString("hex");
  const fs = boundedFeedFs(d.fs ?? nodeFeedFs, d.mtimeOf ?? nodeMtime, now, limits);
  // An injected transcript fs or root means a test or a sandbox: never fall back to the real ~/.codex then.
  const codexFeed: CodexFeed = d.codex ?? (d.fs || d.root ? { poll: () => [] } : createCodexFeed(undefined, now)), codexRoot = d.codexRoot ?? CODEX_ROOT;
  const geminiFeed: GeminiFeed = d.gemini ?? (d.fs || d.root ? { poll: () => [] } : createGeminiFeed(undefined, now)), geminiRoot = d.geminiRoot ?? GEMINI_ROOT, installed = d.installed ?? (() => (d.fs || d.root ? {} : detectInstalled()));
  const codexUsageFeed: CodexUsageFeed = d.codexUsage ?? (d.fs || d.root ? { poll: () => null } : createCodexUsageFeed(undefined, undefined, now));
  let codexUsageIdx: ReturnType<CodexUsageFeed["poll"]> = null, geminiSessions: GeminiSession[] = [], codexSessions: CodexSession[] = [], feed: FeedState = createFeedState(), lastPoll = -Infinity, info = { polledAt: 0, filesSeen: 0, newRows: 0, catchingUp: false, oversizedSkipped: 0 };
  const cache = new Map<string, { at: number; value: WorkTelemetry }>(), inflight = new Map<string, Promise<TelemetryResult>>();
  // The repo-free fleet answer (Toolcalls panel, no tracker chosen): same feed, same throttle; bead ids from the newest tracker join, if any.
  let beadByKey: ReadonlyMap<string, string> = new Map(), fleetHit: { at: number; value: FleetSnapshot } | null = null;
  function poll(t: number) {
    if (t - lastPoll < limits.minPollMs) return;
    lastPoll = t; fs.beginPoll();
    const r = pollTranscripts(feed, root, fs);
    feed = r.state;
    try { codexSessions = codexFeed.poll(codexRoot); } catch { codexSessions = []; } // Codex is optional: a missing or unreadable ~/.codex is an empty fleet half
    try { codexUsageIdx = codexUsageFeed.poll(codexRoot); } catch { codexUsageIdx = null; } // the call -> usage join's Codex half: optional too
    try { geminiSessions = geminiFeed.poll(geminiRoot); } catch { geminiSessions = []; } // Gemini is optional too (and unverified on a real install)
    info = { polledAt: t, filesSeen: r.filesSeen, newRows: r.newRows, catchingUp: fs.capped(), oversizedSkipped: info.oversizedSkipped + r.oversized };
  }
  const ck = (repo: string, windowMs: number) => `${repo}\u0000${windowMs}`;
  async function compute(repo: string, windowMs: number): Promise<TelemetryResult> {
    try { return await computeInner(repo, windowMs); } catch (e) { return { ok: false, reason: redactReason((e as Error)?.message ?? "telemetry failed") }; }
  }
  async function computeInner(repo: string, windowMs: number): Promise<TelemetryResult> {
    const snap = await d.readSnapshot(repo);
    if (!snap.ok) return { ok: false, reason: redactReason(snap.reason) };
    const t = now();
    poll(t);
    const built = buildWorkTelemetry(unitsFromState(feed), snap.value.issues, snap.value.deps, t, info, { files: fleetSourcesFromState(feed, p => fs.listedMtime(p)), codex: codexSessions, gemini: geminiSessions, home: homedir(), messages: messageEventsFromState(feed, undefined, t) }, windowMs, toolEventsFromState(feed));
    // The bead join needs the RAW keys (internal only), so it is read before the payload is sealed.
    beadByKey = new Map((built.fleet?.names ?? []).flatMap(n => (n.beadId ? [[n.key, n.beadId] as const] : [])));
    const value: WorkTelemetry = sealWorkTelemetry(built, salt);
    cache.set(ck(repo, windowMs), { at: t, value }); if (cache.size > 8) cache.delete(cache.keys().next().value!);
    return { ok: true, value };
  }
  return {
    /** `windowMs` = how far back the totals reach (the Calls range control); the default is the 7-day window. Each (repo, window) is cached on its own. */
    read(repo: string, windowMs: number = WINDOW_MS): Promise<TelemetryResult> {
      const key = ck(repo, windowMs), hit = cache.get(key);
      if (hit && now() - hit.at < limits.minPollMs) return Promise.resolve({ ok: true, value: hit.value });
      const run = inflight.get(key) ?? inflight.set(key, compute(repo, windowMs).finally(() => inflight.delete(key))).get(key)!;
      return run;
    },
    /** Every agent lane on this machine, named, without a tracker repo. Lanes carry bead ids only once some repo's read has joined them. */
    fleet(): FleetResult {
      const t = now();
      if (fleetHit && t - fleetHit.at < limits.minPollMs) return { ok: true, value: fleetHit.value };
      try {
        poll(t);
        const built = buildFleet({ files: fleetSourcesFromState(feed, p => fs.listedMtime(p)), codex: codexSessions, gemini: geminiSessions, home: homedir(), beadByKey, messages: messageEventsFromState(feed, undefined, t) }, t);
        // Claude + Codex have a transcript reader for the call -> usage join; Gemini has none yet, so its calls say "provider not read".
        const raw: UsageIndexes = { claude: claudeUsageIndex(feed), ...(codexUsageIdx ? { codex: codexUsageIdx } : {}) };
        const value = sealFleet({ ...built, providers: buildProviderStatus(installed(), built.summary.byRuntime), callUsage: sealUsageIndexes(raw, salt) }, salt);
        fleetHit = { at: t, value };
        return { ok: true, value };
      } catch (e) { return { ok: false, reason: redactReason((e as Error)?.message ?? "fleet read failed") }; }
    },
  };
}
