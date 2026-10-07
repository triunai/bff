// Demo mode, server side. While the switch is ON every RPC is answered from demo/fixture.ts and the LIVE handler is never called:
// no bd, git, herdr or caffeinate runs and nothing is written. Every RPC name is classified below; demo.test.ts fails when the
// contract gains an RPC that is not classified, so a new action cannot reach a real spawner by default.
// The fleet and telemetry answers come from the REAL transcript pipeline fed an in-memory file system (merge, never reimplement).
import { report } from "../analytics.ts";
import { parseSpineIndex } from "../spine-index.ts";
import { parseSpineV2 } from "../projects.ts";
import { createTelemetryService } from "../work/telemetry-rpc.ts";
import type { FeedFs } from "../transcript-feed.ts";
import { SEAM_GUARDS } from "../work/seam-guards/registry.ts";
import { DEFAULT_POOLS } from "../work/surface-model.ts";
import { READ_CAP_MS, rangeSpanMs } from "../work/calls-range.ts";
import { DEMO_OFF, DEMO_REPO } from "./constants.ts";
import { DEMO_TRANSCRIPT_ROOT, demoIncidents, demoWorktreeStats, demoCalls, demoCodex, demoCommitDetail, demoDayCommits, demoDayCounts, demoDocSection, demoFileDiff, demoGraph, demoMentions, demoPaneTail, demoPanes, demoProjectsJson, demoRepoHealth, demoRepos, demoSpineIndexJson, demoStatus, demoSurface, demoTranscripts, DEMO_HEAD, DEMO_BRANCH } from "./fixture.ts";

type Handler = (r: any, c?: any) => unknown;
const refuse = (shape: (reason: string) => unknown): Handler => () => shape(DEMO_OFF);
const enc = new TextEncoder();

/** An in-memory FeedFs over generated transcripts. It cannot touch the disk. */
function memoryFs(files: Map<string, string>): FeedFs {
  const bytes = new Map([...files].map(([p, t]) => [p, enc.encode(t)]));
  return {
    chunkLimit: 4 * 1024 * 1024,
    listJsonl: root => [...files.keys()].filter(p => p.startsWith(root) && p.endsWith(".jsonl")).sort(),
    readChunk: (file, from, max) => { const b = bytes.get(file) ?? new Uint8Array(0), end = Math.min(b.length, from + Math.max(0, max ?? b.length)); return { bytes: b.subarray(Math.min(from, b.length), end), size: b.length }; },
    readText: p => files.get(p) ?? null,
  };
}

/** One fleet/telemetry service per minute: the generated transcripts are anchored to `now`, so the newest lanes stay "live" while demo is on. */
export function createDemoServices(now: () => number) {
  let cached: { bucket: number; svc: ReturnType<typeof createTelemetryService> } | null = null;
  return () => {
    const bucket = Math.floor(now() / 60_000);
    if (cached?.bucket === bucket) return cached.svc;
    const t = now(), tr = demoTranscripts(t);
    const svc = createTelemetryService({ readSnapshot: async () => ({ ok: true as const, value: demoSurface(t) }), root: DEMO_TRANSCRIPT_ROOT, fs: memoryFs(tr.files), mtimeOf: p => tr.mtimes.get(p) ?? null, now: () => t, codex: { poll: () => demoCodex(t) }, keySalt: "demo", limits: { minPollMs: 0 } });
    cached = { bucket, svc };
    return svc;
  };
}

/** RPC name -> how demo mode answers it. "read" answers from the fixture, "write" refuses with the demo reason. */
export function demoHandlers(now: () => number): Record<string, { kind: "read" | "write"; run: Handler }> {
  const services = createDemoServices(now), read = (run: Handler) => ({ kind: "read" as const, run }), write = (run: Handler) => ({ kind: "write" as const, run });
  const sessions = () => [...new Set(demoCalls(now()).map(c => c.sessionId))];
  return {
    herdrSnapshot: read(() => ({ available: true, note: "Demo capture: synthetic calls, nothing was read from your machine.", capturedAt: now(), stale: false, coverage: { filesScanned: 12, discoveryTruncated: false }, report: report(demoCalls(now(), "claude-transcript")) })),
    herdrPanes: read(() => demoPanes()),
    herdrSessions: read(() => ({ ok: true, sessions: [{ name: "demo", running: true }] })),
    herdrLaunchPlan: write(refuse(reason => ({ ok: false, reason }))),
    herdrClis: read(() => ({ clis: [] })),
    herdrDispatch: write(refuse(reason => ({ ok: false, reason, fallback: false }))),
    spineIndex: read(() => { const p = parseSpineIndex(demoSpineIndexJson(now())); return p.ok ? { state: "ok", path: `${DEMO_REPO}/.bff/spine-index.json`, mtimeMs: now(), index: p.index, dropped: p.dropped } : { state: "invalid", path: "", reason: p.reason }; }),
    projectSpines: read(() => ({ state: "ok", dir: "/demo/projects", projects: demoProjectsJson(now()).map(j => parseSpineV2(j)).flatMap(r => (r.ok ? [r.spine] : [])), invalid: [] })),
    gitRepos: read(() => demoRepos()),
    gitGraph: read(r => ({ ok: true, value: demoGraph(now(), r.scope, r.limit) })),
    gitStatus: read(() => ({ ok: true, value: demoStatus() })),
    gitHead: read(() => ({ ok: true, value: { head: DEMO_HEAD, branch: DEMO_BRANCH } })),
    repoHealth: read(() => ({ ok: true, value: demoRepoHealth(now()) })),
    gitCommit: read(r => ({ ok: true, value: demoCommitDetail(now(), String(r.sha)) })),
    gitFileDiff: read(r => ({ ok: true, value: demoFileDiff(String(r.path)) })),
    gitMentions: read(() => ({ ok: true, value: demoMentions(now()) })),
    gitDayCounts: read(r => ({ ok: true, value: demoDayCounts(now(), r.days) })),
    gitDayCommits: read(r => ({ ok: true, value: demoDayCommits(now(), String(r.date), r.limit) })),
    gitCommitPatch: read(r => ({ ok: true, value: `From ${demoCommitDetail(now(), String(r.sha)).sha}\nSubject: demo patch\n\n--- a/src/export/Pipeline.tsx\n+++ b/src/export/Pipeline.tsx\n@@ -1 +1 @@\n-demo\n+demo patch\n` })),
    gitLocalDiff: write(refuse(reason => ({ ok: false, reason }))),
    gitFormatPatch: write(refuse(reason => ({ ok: false, reason }))),
    gitWritePreview: write(refuse(reason => ({ ok: false, reason }))),
    gitWriteRun: write(refuse(reason => ({ ok: false, reason }))),
    spineDocSection: read(r => ({ ok: true, value: demoDocSection(String(r.ref)) })),
    workSnapshot: read(() => ({ ok: true, value: { ...demoSurface(now()), sandboxElsewhere: false } })),
    workPaneTail: read(r => ({ ok: true, value: demoPaneTail(String(r.paneId), now()) })),
    workMove: write(refuse(reason => ({ ok: false, reason }))),
    workDispatchPreview: write(refuse(reason => ({ ok: false, reason }))),
    workDispatch: write(refuse(reason => ({ ok: false, stage: "validate", reason }))),
    pinRepo: write(() => { throw new Error(DEMO_OFF); }),
    listPinnedRepos: read(() => ({ ok: true, pinned: [] })),
    unpinRepo: write(() => { throw new Error(DEMO_OFF); }),
    workTrackers: read(() => ({ ok: true, trackers: [{ path: DEMO_REPO, name: "demo-repo", kind: "project" }] })),
    workPools: read(() => DEFAULT_POOLS),
    workTelemetry: read(r => services().read(DEMO_REPO, r.range ? Math.min(rangeSpanMs(r.range, now()), READ_CAP_MS) : undefined)),
    fleetSnapshot: read(() => services().fleet()),
    keepAwakeStatus: read(() => ({ supported: true, enabled: false, active: false, live: 0 })),
    layoutGet: read(() => ({ ok: true, layout: null })),
    layoutSet: write(() => ({ ok: true })),
    snapshot: read(r => {
      const calls = demoCalls(now()).filter(c => (!r.provider || c.provider === r.provider) && (!r.threadId || c.sessionId === r.threadId) && (r.since === undefined || (c.endedAt ?? c.startedAt ?? -1) >= r.since)), ids = sessions();
      return { ...report(calls), threads: ids.map(id => ({ id, provider: "claude" })), coverage: { scannedAt: now(), threadLimit: 40, eventLimitPerThread: 1000, threadsScanned: ids.length, eventsScanned: calls.length * 3, threadLimitReached: false, truncatedThreads: [], failedThreads: [], scanErrors: [], retainedHistoryOnly: true } };
    }),
    // Added after the first demo lane: the read-only answers the newer surfaces ask for, and refusals for the newer writes.
    fleetIncidents: read(() => demoIncidents(now())),
    gitWorktreeStats: read(() => ({ ok: true, value: demoWorktreeStats() })),
    gitWorktreeDiff: read(r => ({ ok: true, value: demoFileDiff(String(r.path)) })),
    herdrSessionCheck: read(() => ({ ok: true })),
    herdrStamps: read(() => ({ stamps: {} })),
    herdrStampSet: write(() => { throw new Error(DEMO_OFF); }),
    herdrTeam: write(refuse(reason => ({ ok: false, reason, started: 0, fallback: false }))),
    seamReport: read(() => ({ ok: true, report: { at: now(), entries: SEAM_GUARDS.map(g => ({ id: g.id, seam: g.seam, result: { ok: true } })) } })),
    demoState: read(() => ({ on: true })),
    demoSet: write(() => ({ on: true })),
  };
}

export const DEMO_SET_REFUSAL = "the demo switch is owner-only (not available to plugin callers)";
export type DemoSwitch = { on(): boolean; set(on: boolean): void };
export const createDemoSwitch = (): DemoSwitch => { let v = false; return { on: () => v, set: n => { v = n; } }; };

/** Wraps the live handler table: with demo OFF every call goes live unchanged; with it ON the live handler is never reached. */
export type DemoRpc = { demoState: (r: unknown) => { on: boolean }; demoSet: (r: { on: boolean }) => { on: boolean } };
export function withDemo<T extends Record<string, Handler>>(live: T, sw: DemoSwitch, now: () => number = Date.now): NoInfer<T> & DemoRpc {
  const demo = demoHandlers(now), out: Record<string, Handler> = {};
  for (const name of Object.keys(demo)) {
    if (name === "demoState") out[name] = () => ({ on: sw.on() });
    else if (name === "demoSet") out[name] = (r: { on: boolean }, c?: { experimental_caller?: { kind: string } }) => {
      if (c?.experimental_caller?.kind === "plugin") throw new Error(DEMO_SET_REFUSAL); // owner-only like the other switches: a plugin must not mask live data
      sw.set(r.on === true); return { on: sw.on() };
    };
    else { const liveFn = live[name]; if (!liveFn) throw new Error(`demo: no live handler for ${name}`); out[name] = (r, c) => (sw.on() ? demo[name].run(r, c) : liveFn(r, c)); }
  }
  return out as NoInfer<T> & DemoRpc;
}
