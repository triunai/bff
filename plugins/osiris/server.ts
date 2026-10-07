import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { report, reduceEvents } from "./analytics.ts";
import type { Call } from "./analytics.ts";
import { readHerdrFeed, readHerdrPanes, readHerdrSessions, resolveHerdrBin, resolveRootBin, resolveEnvBin, launchPlanFor, readHerdrStamps, writeHerdrStamp, launchedSessionOf } from "./herdr-feed.ts";
import { spawnCaffeinate } from "./work/keep-awake-spawn.ts";
import { CAFFEINATE_BIN, createKeepAwake, TICK_MS } from "./work/keep-awake.ts";
import { readSpineIndex } from "./spine-feed.ts";
import { readFleetIncidents } from "./ledger-feed.ts";
import { defaultProjectsDir, readProjects } from "./projects-feed.ts";
import { readDocSection } from "./doc-feed.ts";
import { readHead, readRepoHealth } from "./health-feed.ts";
import { paneSeen, readPaneTail, readWorkSnapshot } from "./work/bdi-feed.ts";
import { defaultDeps, dispatch, previewDispatch } from "./work/dispatch.ts";
import { createTelemetryService } from "./work/telemetry-rpc.ts";
import { READ_CAP_MS, rangeSpanMs } from "./work/calls-range.ts";
import { makeRepoGuard, PIN_KEY } from "./work/repo-allow.ts";
import { runTrackerMove, MOVE_STATUSES } from "./work/tracker-write.ts";
import { checkHerdrSession } from "./work/seam-guards/herdr-session.ts";
import { availableClis, defaultHerdrDispatchDeps, runHerdrDispatch, runHerdrTeam, trustedCli } from "./work/herdr-dispatch/run.ts";
import { PROVIDER_IDS } from "./work/providers/registry.ts";
import { HERDR_CLIS } from "./work/herdr-dispatch/plan.ts";
import { BEAD_ID_RE, MODEL_RE } from "./work/runtime-models.ts";
import { runGuards } from "./work/seam-guards/registry.ts";
import { makeSeamCtx } from "./work/seam-guards/server-ctx.ts";
import { makeGitWrite } from "./work/git-write.ts";
import { REFUSALS as GIT_WRITE_REFUSALS, WRITE_OPS } from "./work/git-write-rules.ts";
import { DEFAULT_POOLS } from "./work/surface-model.ts";
import { PANELS } from "./shell/panel-registry.ts";
import { layoutGetImpl, layoutSetImpl } from "./shell/layout-persist.ts";
import { RUNTIMES } from "./work/runtime-models.ts";
import type { Runtime } from "./work/surface-types.ts";
import { createDemoSwitch, withDemo } from "./demo/serve.ts";
import { discoverRepos, readCommit, readCommitPatch, readDayCommits, readDayCounts, readFileDiff, readGraph, readMentions, readStatus, readWorktreeDiff, readWorktreeStats, validateRepo } from "./git-feed.ts";
const teamMember = z.object({ cli: z.enum(HERDR_CLIS), model: z.string().regex(MODEL_RE).nullable() }).strict();
const dispatchIn = z.object({ repo: z.string().max(4096), beadId: z.string().max(64), runtime: z.enum(RUNTIMES as [Runtime, ...Runtime[]]), model: z.string().max(64).nullable(), base: z.string().max(200).optional(), token: z.string().max(64).optional(), trustHooks: z.boolean().optional() });
// Static DISPLAY table only (the real pools model is another lane's); dispatch never reads it.
const input = z.object({ threadId: z.string().max(256).optional(), provider: z.string().max(256).optional(), source: z.enum(["bb"]).optional(), since: z.number().nonnegative().optional() });
const callSchema = z.object({ source: z.string(), provider: z.string(), sessionId: z.string(), callId: z.string(), turnId: z.string().nullable(), parentCallId: z.string().nullable(), model: z.string().nullable(), tool: z.string(), server: z.string().nullable(), status: z.enum(["success", "error", "denied", "cancelled", "unknown", "running"]), startedAt: z.number().nullable(), endedAt: z.number().nullable(), durationMs: z.number().nullable(), durationKind: z.enum(["provider", "observed", "unknown"]), errorCode: z.string().nullable(), usage: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite5m: z.number(), cacheWrite1h: z.number() }).nullable().optional() });
export const rpcContract = defineRpcContract({
    herdrSnapshot: { input: z.object({}), output: z.object({ available: z.boolean(), note: z.string(), capturedAt: z.number().nullable(), stale: z.boolean(), coverage: z.object({ filesScanned: z.number(), discoveryTruncated: z.boolean() }).nullable(), report: z.object({ version: z.literal(1), calls: z.array(callSchema), totals: z.any(), tools: z.array(z.any()) }).nullable() }) },
    herdrPanes: { input: z.object({}), output: z.object({ state: z.enum(["live", "empty", "unreachable"]), panes: z.array(z.object({ paneId: z.string(), terminalId: z.string().nullable(), title: z.string(), cwd: z.string().nullable(), agent: z.enum(PROVIDER_IDS).nullable(), status: z.string(), workspaceId: z.string(), focused: z.boolean() })), note: z.string().nullable() }) },
    herdrSessions: { input: z.object({}), output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), sessions: z.array(z.object({ name: z.string(), running: z.boolean() })) }), z.object({ ok: z.literal(false), reason: z.string() })]) },
    herdrStamps: { input: z.object({}), output: z.object({ stamps: z.record(z.string(), z.object({ plan: z.number(), session: z.string() })) }) },
    herdrStampSet: { input: z.object({ terminalId: z.string().min(1).max(200), session: z.string().max(64) }), output: z.object({ ok: z.boolean() }) },
    herdrSessionCheck: { input: z.object({ terminalId: z.string().min(1).max(200), session: z.string().regex(/^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/).optional() }), output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), severity: z.enum(["crit", "warn"]), what: z.string(), why: z.string(), fix: z.string() })]) },
    herdrLaunchPlan: { input: z.object({ session: z.string().regex(/^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/).optional() }), output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), argv: z.array(z.string()), cwd: z.string(), title: z.string() }), z.object({ ok: z.literal(false), reason: z.string() })]) },
    spineIndex: { input: z.object({ repo: z.string().max(4096) }), output: z.discriminatedUnion("state", [z.object({ state: z.literal("ok"), path: z.string(), mtimeMs: z.number(), index: z.any(), dropped: z.number() }), z.object({ state: z.literal("missing"), path: z.string(), hint: z.string() }), z.object({ state: z.literal("invalid"), path: z.string(), reason: z.string() })]) },
    fleetIncidents: { input: z.object({ repo: z.string().max(4096) }), output: z.any() },
    projectSpines: { input: z.object({ dir: z.string().max(4096).optional() }), output: z.any() },
    gitRepos: { input: z.object({ extra: z.array(z.string().max(4096)).max(20) }), output: z.any() },
    gitGraph: { input: z.object({ repo: z.string().max(4096), scope: z.enum(["all", "main"]), limit: z.number().int().optional() }), output: z.any() },
    gitStatus: { input: z.object({ repo: z.string().max(4096) }), output: z.any() },
    gitHead: { input: z.object({ repo: z.string().max(4096) }), output: z.any() },
    repoHealth: { input: z.object({ repo: z.string().max(4096), indexHead: z.string().max(64).optional() }), output: z.any() },
    gitCommit: { input: z.object({ repo: z.string().max(4096), sha: z.string().max(64) }), output: z.any() },
    gitWorktreeStats: { input: z.object({ repo: z.string().max(4096) }), output: z.any() },
    gitWorktreeDiff: { input: z.object({ repo: z.string().max(4096), path: z.string().max(4096), area: z.enum(["staged", "unstaged", "untracked"]) }), output: z.any() },
    gitFileDiff: { input: z.object({ repo: z.string().max(4096), sha: z.string().max(64), path: z.string().max(4096) }), output: z.any() },
    gitMentions: { input: z.object({ repo: z.string().max(4096), id: z.string().max(16) }), output: z.any() },
    gitDayCounts: { input: z.object({ repo: z.string().max(4096), days: z.number().int().optional() }), output: z.any() },
    gitDayCommits: { input: z.object({ repo: z.string().max(4096), date: z.string().max(10), limit: z.number().int().optional() }), output: z.any() },
    gitCommitPatch: { input: z.object({ repo: z.string().max(4096), sha: z.string().max(64) }), output: z.any() },
    // Git actions behind the commit menu (td-osi.14.1; threat model docs/reviews/2026-10-06-usability-blast/fg/fg-gitwrite-threat-model.md). All four refuse plugin callers.
    gitLocalDiff: { input: z.object({ repo: z.string().max(4096), sha: z.string().max(64) }), output: z.any() },
    gitFormatPatch: { input: z.object({ repo: z.string().max(4096), sha: z.string().max(64) }), output: z.any() },
    gitWritePreview: { input: z.object({ repo: z.string().max(4096), op: z.enum(WRITE_OPS as [string, ...string[]]), sha: z.string().max(64), name: z.string().max(256).optional() }), output: z.any() },
    gitWriteRun: { input: z.object({ repo: z.string().max(4096), op: z.enum(WRITE_OPS as [string, ...string[]]), sha: z.string().max(64), name: z.string().max(256).optional(), token: z.string().max(128), confirm: z.string().max(64).optional() }), output: z.any() },
    spineDocSection: { input: z.object({ repo: z.string().max(4096), ref: z.string().max(4200) }), output: z.any() },
    workSnapshot: { input: z.object({ repo: z.string().max(4096) }), output: z.any() },
    workPaneTail: { input: z.object({ paneId: z.string().max(64), lines: z.number().int().optional() }), output: z.any() },
    workMove: { input: z.object({ repo: z.string().max(4096), id: z.string().max(64), status: z.enum(MOVE_STATUSES), ifStatus: z.string().max(32), note: z.string().max(400).optional() }), output: z.any() },
    herdrClis: { input: z.object({}), output: z.object({ clis: z.array(z.enum(HERDR_CLIS)), paths: z.record(z.enum(HERDR_CLIS), z.string()).optional() }) },
    herdrTeam: { input: z.object({ repo: z.string().max(4096).optional(), epic: z.string().regex(BEAD_ID_RE).max(64).optional(), lead: teamMember, worker: teamMember, cards: z.array(z.object({ id: z.string().regex(BEAD_ID_RE).max(64), title: z.string().max(200) }).strict()).min(1).max(50), workers: z.number().int().min(1).max(6) }).strict(), output: z.any() },
    herdrDispatch: { input: z.object({ prompt: z.string().max(20000), cli: z.enum(HERDR_CLIS), title: z.string().max(60), repo: z.string().max(4096).optional() }), output: z.any() },
    workDispatchPreview: { input: dispatchIn, output: z.any() },
    workDispatch: { input: dispatchIn, output: z.any() },
    pinRepo: { input: z.object({ path: z.string().max(4096) }), output: z.any() },
    listPinnedRepos: { input: z.object({}), output: z.any() },
    unpinRepo: { input: z.object({ path: z.string().max(4096) }), output: z.any() },
    workTrackers: { input: z.object({}), output: z.any() },
    workPools: { input: z.object({}), output: z.any() },
    workTelemetry: { input: z.object({ repo: z.string().max(4096), range: z.enum(["today", "7d", "30d"]).optional() }), output: z.any() },
    fleetSnapshot: { input: z.object({}), output: z.any() },
    keepAwakeStatus: { input: z.object({}), output: z.object({ supported: z.boolean(), enabled: z.boolean(), active: z.boolean(), live: z.number() }) },
    seamReport: { input: z.object({ trackerRepo: z.string().max(4096).nullable(), snapshotRepo: z.string().max(4096).nullable(), gitRepo: z.string().max(4096).nullable(), terminalSession: z.string().max(64).nullable(), terminalId: z.string().max(200).nullable().optional() }), output: z.any() },
    layoutGet: { input: z.object({}), output: z.any() },
    layoutSet: { input: z.object({ layout: z.any() }), output: z.any() },
    demoState: { input: z.object({}), output: z.object({ on: z.boolean() }) },
    demoSet: { input: z.object({ on: z.boolean() }), output: z.object({ on: z.boolean() }) },
    snapshot: { input, output: z.object({ version: z.literal(1), calls: z.array(callSchema), totals: z.any(), tools: z.array(z.any()), coverage: z.object({ scannedAt: z.number(), threadLimit: z.number(), eventLimitPerThread: z.number(), threadsScanned: z.number(), eventsScanned: z.number(), threadLimitReached: z.boolean(), truncatedThreads: z.array(z.string()), failedThreads: z.array(z.string()), scanErrors:z.array(z.object({threadId:z.string(),code:z.string()})), retainedHistoryOnly: z.literal(true) }), threads: z.array(z.object({ id: z.string(), provider: z.string() })) }) }
});
/** Shown by the Work picker when discovery finds no Beads tracker. The UI renders `reason` from the `workTrackers` reply. */
export const NO_TRACKER_REASON = "No Beads tracker found. Run `bd init` in your repo, then Refresh.";
type TrackerEntry = { path: string; name: string; kind: "sandbox" | "project" };
/** The `workTrackers` reply: `reason` is present only when the list is empty, so a non-empty reply keeps its old shape. */
export const trackersResult = (trackers: TrackerEntry[]) => trackers.length ? { ok: true as const, trackers } : { ok: true as const, trackers, reason: NO_TRACKER_REASON };

export type Snapshot = ReturnType<typeof report> & {
    coverage: {
        scannedAt: number;
        threadLimit: number;
        eventLimitPerThread: number;
        threadsScanned: number;
        eventsScanned: number;
        threadLimitReached: boolean;
        truncatedThreads: string[];
        failedThreads: string[];
        scanErrors:{threadId:string;code:string}[];
        retainedHistoryOnly: true;
    };
    threads: {
        id: string;
        provider: string;
    }[];
};
const THREAD_LIMIT = 40, EVENT_LIMIT = 1000, PAGE_SIZE = 100;
export default async function plugin(bb: BbPluginApi) {
    const cache = new Map<string, {
        at: number;
        value: Promise<Snapshot>;
        pending: boolean;
    }>();
    async function collect(filters: z.infer<typeof input>): Promise<Snapshot> {
        let threadLimitReached = false;
        let threads;
        if (filters.threadId)
            threads = [await bb.sdk.threads.get({ threadId: filters.threadId })];
        else {
            const [open, archived] = await Promise.all([bb.sdk.threads.list({ limit: THREAD_LIMIT + 1, includeHidden: true, archived: false }), bb.sdk.threads.list({ limit: THREAD_LIMIT + 1, includeHidden: true, archived: true })]);
            const unique = [...new Map([...open, ...archived].map(t => [t.id, t])).values()].sort((a, b) => b.updatedAt - a.updatedAt);
            threadLimitReached = unique.length > THREAD_LIMIT;
            threads = unique.slice(0, THREAD_LIMIT);
        }
        const choices = threads.map(t => ({ id: t.id, provider: t.providerId }));
        if (filters.provider)
            threads = threads.filter(t => t.providerId === filters.provider);
        const calls: Call[] = [], truncatedThreads: string[] = [], failedThreads: string[] = [],scanErrors:{threadId:string;code:string}[]=[];
        let eventsScanned = 0;
        for (let i = 0; i < threads.length; i += 4)
            await Promise.all(threads.slice(i, i + 4).map(async (thread) => {
                try {
                    const rows: Parameters<typeof reduceEvents>[0] = [];
                    let beforeSeq: string | undefined;
                    while (rows.length < EVENT_LIMIT) {
                        const page = await bb.sdk.threads.events.list({ threadId: thread.id, order: "desc", limit: String(PAGE_SIZE), beforeSeq, types: ["item/started", "item/completed", "turn/started", "turn/completed"] });
                        rows.push(...page);
                        if (page.length < PAGE_SIZE)
                            break;
                        beforeSeq = String(Math.min(...page.map(e => e.seq)));
                    }
                    if (rows.length >= EVENT_LIMIT) {
                        const extra = await bb.sdk.threads.events.list({ threadId: thread.id, order: "desc", limit: "1", beforeSeq, types: ["item/started", "item/completed", "turn/started", "turn/completed"] });
                        if (extra.length)
                            truncatedThreads.push(thread.id);
                    }
                    eventsScanned += rows.length;
                    calls.push(...reduceEvents(rows, thread));
                }
                catch(error) {
                    const candidate=error!==null&&typeof error==="object"&&"code" in error?String(error.code):error instanceof Error?error.name:"SCAN_ERROR";
                    const code=/^[A-Za-z0-9_.:-]{1,64}$/.test(candidate)?candidate:"SCAN_ERROR";
                    failedThreads.push(thread.id);scanErrors.push({threadId:thread.id,code});
                    bb.log.warn(`thread event scan failed: ${code} (${thread.id})`);
                }
            }));
        const filtered = calls.filter(c => filters.since === undefined || (c.endedAt ?? c.startedAt ?? -1) >= filters.since);
        return { ...report(filtered), threads: choices, coverage: { scannedAt: Date.now(), threadLimit: THREAD_LIMIT, eventLimitPerThread: EVENT_LIMIT, threadsScanned: threads.length, eventsScanned, threadLimitReached, truncatedThreads, failedThreads, scanErrors, retainedHistoryOnly: true } };
    }
    function snapshot(filters: z.infer<typeof input>): Promise<Snapshot> { const normalized = { ...filters, ...(filters.since === undefined ? {} : { since: Math.floor(filters.since / 5000) * 5000 }) }; const key = JSON.stringify(normalized), old = cache.get(key); if (old && (old.pending || Date.now() - old.at < 5000))
        return old.value; const value = collect(normalized); if (cache.size >= 20)
        cache.delete(cache.keys().next().value!); const entry = { at: Date.now(), value, pending: true }; cache.set(key, entry); void value.then(() => { entry.pending = false; entry.at = Date.now(); }, () => cache.delete(key)); return value; }
    // Demo mode: one in-memory switch per plugin load. While ON, withDemo answers every RPC from demo/fixture.ts and the live handlers never run.
    const demoSwitch = createDemoSwitch();
    // ONE guard state per plugin load: the dispatch token, rate limiter and in-flight set live in `dispatchDeps.guard`.
    // BB gives the plugin a curated PATH, so herdr is found ONLY through resolveHerdrBin (fixed paths, realpath + ownership checks), re-run on every call; no env, no PATH.
    const dispatchDeps = defaultDeps({ herdrBin: () => resolveHerdrBin() });
    // ONE transcript feed state per plugin load (bounded + throttled inside the service).
    const telemetry = createTelemetryService({ readSnapshot: readWorkSnapshot });
    // td-osi.12: keep the Mac awake while agents work. macOS only: elsewhere no setting is defined and the controller is a no-op.
    const awakeSetting = process.platform === "darwin" ? bb.settings.define({ keepAwake: { type: "boolean", label: "Keep Mac awake while agents work", description: "Holds a self-expiring idle-sleep assertion while agents are live. Lid-close still sleeps on battery. macOS only for now.", default: true } }) : null;
    let awakeOn = true, awakeLive = 0;
    if (awakeSetting) { void awakeSetting.get().then(v => { awakeOn = v.keepAwake; }, () => {}); awakeSetting.onChange(n => { awakeOn = n.keepAwake; if (!awakeOn) keepAwake.release(); }); }
    const keepAwake = createKeepAwake({ platform: process.platform, enabled: () => awakeOn, trusted: () => resolveRootBin(CAFFEINATE_BIN), now: Date.now,
        spawn: spawnCaffeinate });
    bb.background.service("keep-awake", { start: signal => new Promise<void>(done => {
        const run = () => { if (demoSwitch.on()) { keepAwake.release(); return; } let f: ReturnType<typeof telemetry.fleet> | null = null; try { f = telemetry.fleet(); } catch { /* count as 0 */ } awakeLive = f?.ok ? f.value.summary.live : 0; keepAwake.tick(awakeLive); };
        run(); const timer = setInterval(run, TICK_MS);
        signal.addEventListener("abort", () => { clearInterval(timer); keepAwake.release(); done(); }, { once: true });
        if (signal.aborted) { clearInterval(timer); keepAwake.release(); done(); }
    }) });
    const keepAwakeFact = () => ({ supported: process.platform === "darwin", enabled: awakeOn, active: keepAwake.active(), live: awakeLive });
    const projectPaths = async (): Promise<string[]> => { const ps = await bb.sdk.projects.list(); return ps.flatMap(p => p.sources.filter(s => s.type === "local_path").map(s => s.path)); };
    const repoGuard = makeRepoGuard({ discover: async () => (await discoverRepos([])).map(r => r.path), projects: projectPaths, defaultDir: defaultProjectsDir, kvGet: () => bb.storage.kv.get<string[]>(PIN_KEY), kvSet: v => bb.storage.kv.set(PIN_KEY, v), now: Date.now, validateRepo: async p => validateRepo(p) });
    const { assertAllowedRepo, filterAllowedRepos } = repoGuard;
    const pluginCaller = (c: { experimental_caller?: { kind: string } } | undefined) => c?.experimental_caller?.kind === "plugin";
    const NO_PLUGIN = "dispatch and pinning are not available to other plugins";
    const gitWrite = makeGitWrite();
    const herdrDispatchDeps = defaultHerdrDispatchDeps({ herdrBin: () => resolveHerdrBin(), envBin: () => resolveEnvBin() });
    // Candidate Work trackers: the sandbox beads repo plus allowed project/discovered repos that have a .beads folder.
    const hasBeads = async (p: string) => { try { return (await stat(join(p, ".beads"))).isDirectory(); } catch { return false; } };
    /** The sandbox beads repo's canonical path, or null when it is absent or not a pinnable git repo. One fixed path: no discovery. */
    const sandboxPath = async (): Promise<string | null> => {
        const sandbox = join(homedir(), ".local", "share", "osiris", "sandbox-beads");
        if (!(await hasBeads(sandbox))) return null;
        try { const v = await validateRepo(sandbox); return v.ok ? v.value : null; } catch { return null; }
    };
    const withSandboxFlag = async (repo: string, r: Awaited<ReturnType<typeof readWorkSnapshot>>) => {
        if (!r.ok) return r;
        const sb = await sandboxPath();
        return { ok: true as const, value: { ...r.value, sandboxElsewhere: !!sb && sb !== repo } };
    };
    const listTrackers = async () => {
        const out: { path: string; name: string; kind: "sandbox" | "project" }[] = [];
        // Review W-7 MED-1: LIST only. Nothing is pinned (persisted) before the owner picks; the pick pins via pinRepo.
        const sb = await sandboxPath();
        if (sb) out.push({ path: sb, name: basename(sb), kind: "sandbox" });
        const seen = new Set(out.map(t => t.path));
        const candidates = [...await projectPaths().catch(() => [] as string[]), ...(await discoverRepos([]).catch(() => [])).map(r => r.path)];
        for (const raw of candidates) {
            if (out.length >= 12) break;
            let path: string; try { path = await assertAllowedRepo(raw); } catch { continue; }
            if (seen.has(path) || !(await hasBeads(path))) continue;
            seen.add(path); out.push({ path, name: basename(path), kind: "project" });
        }
        return trackersResult(out);
    };
    bb.rpc.register(rpcContract, withDemo({
        workMove: async (r, c) => pluginCaller(c) ? { ok: false, reason: NO_PLUGIN } : runTrackerMove({ ...r, repo: await assertAllowedRepo(r.repo) }, dispatchDeps.bd),
        herdrClis: async (_r, c) => { if (pluginCaller(c)) return { clis: [] }; const clis = availableClis(); return { clis, paths: Object.fromEntries(clis.map(k => [k, trustedCli(k)]).filter(e => e[1])) }; },
        herdrTeam: async (r, c) => pluginCaller(c) ? { ok: false, reason: NO_PLUGIN, started: 0, fallback: false } : runHerdrTeam({ ...r, repo: r.repo ? await assertAllowedRepo(r.repo) : undefined }, herdrDispatchDeps),
        herdrDispatch: async (r, c) => pluginCaller(c) ? { ok: false, reason: NO_PLUGIN, fallback: false } : runHerdrDispatch({ ...r, repo: r.repo ? await assertAllowedRepo(r.repo) : undefined }, herdrDispatchDeps),
        workDispatchPreview: async (r, c) => pluginCaller(c) ? { ok: false, reason: NO_PLUGIN } : previewDispatch({ ...r, repo: await assertAllowedRepo(r.repo) }, dispatchDeps),
        workDispatch: async (r, c) => pluginCaller(c) ? { ok: false, stage: "validate", reason: NO_PLUGIN } : dispatch({ ...r, repo: await assertAllowedRepo(r.repo) }, dispatchDeps),
        pinRepo: async ({ path }, c) => { if (pluginCaller(c)) throw new Error(NO_PLUGIN); return { ok: true, path: await repoGuard.pinRepo(path) }; },
        workTrackers: async (_r, c) => pluginCaller(c) ? { ok: false, reason: NO_PLUGIN } : listTrackers(),
        layoutGet: async () => layoutGetImpl(bb.storage.kv, PANELS),
        layoutSet: async ({ layout }) => layoutSetImpl(bb.storage.kv, PANELS, layout),
        workPools: async () => DEFAULT_POOLS, snapshot, herdrSnapshot: async () => readHerdrFeed(),
        // Live, read-only `herdr pane list` through the ONE reviewed herdr runner (no new spawner); never for a plugin caller.
        // Plan only (fixed argv); the human-clicked client call does the one BB terminal create. Refused for plugin callers.
        herdrLaunchPlan: async (r, c) => launchPlanFor(pluginCaller(c), NO_PLUGIN, () => projectPaths().catch(() => [] as string[]), undefined, undefined, r.session),
        // Launch-plan stamp per BB terminal id (td-osi.12): which plan version + herdr session a persisted Osiris terminal was created on.
        herdrStamps: async (_r, c) => pluginCaller(c) ? { stamps: {} } : readHerdrStamps(bb.storage.kv),
        herdrStampSet: async (r, c) => pluginCaller(c) ? { ok: false } : writeHerdrStamp(bb.storage.kv, r.terminalId, r.session),
        herdrSessionCheck: async (r, c) => pluginCaller(c) ? { ok: false as const, severity: "crit" as const, what: "Not available to plugins", why: NO_PLUGIN, fix: "Use the Osiris app." } : checkHerdrSession({ run: dispatchDeps.herdr, picked: r.session ?? null, launched: await launchedSessionOf(bb.storage.kv, r.terminalId) }),
        herdrSessions: async (_r, c) => pluginCaller(c) ? { ok: false as const, reason: NO_PLUGIN } : readHerdrSessions(dispatchDeps.herdr),
        herdrPanes: async (_r, c) => pluginCaller(c) ? { state: "unreachable" as const, panes: [], note: NO_PLUGIN } : readHerdrPanes(dispatchDeps.herdr, () => readHerdrFeed()),
        spineIndex: async ({ repo }) => readSpineIndex(await assertAllowedRepo(repo)),
        fleetIncidents: async ({ repo }) => readFleetIncidents(await assertAllowedRepo(repo)),
        projectSpines: async ({ dir }) => readProjects(await assertAllowedRepo(dir || defaultProjectsDir())),
        gitRepos: async ({ extra }) => discoverRepos(await filterAllowedRepos(extra)),
        gitGraph: async ({ repo, scope, limit }) => readGraph(await assertAllowedRepo(repo), scope, limit),
        gitStatus: async ({ repo }) => readStatus(await assertAllowedRepo(repo)),
        gitHead: async ({ repo }) => readHead(await assertAllowedRepo(repo)),
        repoHealth: async ({ repo, indexHead }) => readRepoHealth(await assertAllowedRepo(repo), indexHead),
        gitCommit: async ({ repo, sha }) => readCommit(await assertAllowedRepo(repo), sha),
        gitWorktreeStats: async ({ repo }) => readWorktreeStats(await assertAllowedRepo(repo)),
        gitWorktreeDiff: async ({ repo, path, area }) => readWorktreeDiff(await assertAllowedRepo(repo), path, area),
        gitFileDiff: async ({ repo, sha, path }) => readFileDiff(await assertAllowedRepo(repo), sha, path),
        gitMentions: async ({ repo, id }) => readMentions(await assertAllowedRepo(repo), id),
        gitDayCounts: async ({ repo, days }) => readDayCounts(await assertAllowedRepo(repo), days),
        gitDayCommits: async ({ repo, date, limit }) => readDayCommits(await assertAllowedRepo(repo), date, limit),
        gitCommitPatch: async ({ repo, sha }) => readCommitPatch(await assertAllowedRepo(repo), sha),
        gitLocalDiff: async ({ repo, sha }, c) => pluginCaller(c) ? { ok: false, reason: GIT_WRITE_REFUSALS.plugin } : gitWrite.localDiff(await assertAllowedRepo(repo), sha),
        gitFormatPatch: async ({ repo, sha }, c) => pluginCaller(c) ? { ok: false, reason: GIT_WRITE_REFUSALS.plugin } : gitWrite.formatPatch(await assertAllowedRepo(repo), sha),
        gitWritePreview: async ({ repo, op, sha, name }, c) => pluginCaller(c) ? { ok: false, reason: GIT_WRITE_REFUSALS.plugin } : gitWrite.preview(await assertAllowedRepo(repo), op, sha, name),
        gitWriteRun: async ({ repo, op, sha, name, token, confirm }, c) => pluginCaller(c) ? { ok: false, reason: GIT_WRITE_REFUSALS.plugin } : gitWrite.run({ repo: await assertAllowedRepo(repo), op, sha, name, token, confirm }),
        spineDocSection: async ({ repo, ref }) => readDocSection(await assertAllowedRepo(repo), ref),
        workSnapshot: async ({ repo }) => { const path = await assertAllowedRepo(repo); return withSandboxFlag(path, await readWorkSnapshot(path)); },
        // M5: only a pane that appeared as a joined agent pane in the latest snapshot of an allowed repo; never for a plugin caller.
        workPaneTail: async ({ paneId, lines }, c) => pluginCaller(c) ? { ok: false, reason: NO_PLUGIN } : !paneSeen(paneId) ? { ok: false, reason: "not a pane from your tracker" } : readPaneTail(paneId, lines),
        workTelemetry: async ({ repo, range }, c) => pluginCaller(c) ? { ok: false, reason: NO_PLUGIN } : telemetry.read(await assertAllowedRepo(repo), range ? Math.min(rangeSpanMs(range, Date.now()), READ_CAP_MS) : undefined),
        keepAwakeStatus: async () => keepAwakeFact(),
        // Runtime seam guards (td-osi.12): read-only; the answer is a verdict per guard, never an action. Never for a plugin caller.
        seamReport: async (view, c) => pluginCaller(c) ? { ok: false, reason: NO_PLUGIN } : { ok: true, report: await runGuards(makeSeamCtx(view, { isRepoAllowed: p => assertAllowedRepo(p).then(() => true, () => false), herdrSession: async v => ({ run: dispatchDeps.herdr, picked: v.terminalSession ?? null, launched: v.terminalId ? await launchedSessionOf(bb.storage.kv, v.terminalId) : null }), keepAwake: async () => keepAwakeFact() })) },
        fleetSnapshot: async (_i, c) => pluginCaller(c) ? { ok: false, reason: NO_PLUGIN } : telemetry.fleet(),
        listPinnedRepos: async (_r, c) => { if (pluginCaller(c)) throw new Error(NO_PLUGIN); return { ok: true, pinned: await repoGuard.listPinned() }; },
        unpinRepo: async ({ path }, c) => { if (pluginCaller(c)) throw new Error(NO_PLUGIN); return { ok: true, pinned: await repoGuard.unpinRepo(path) }; },
    }, demoSwitch));
    const changed = () => { bb.realtime.publish("changed", { changed: true }); };
    bb.events.on("experimental_thread.events", changed);
    bb.events.on("thread.deleted", changed);
    bb.cli.register({ name: "tool-observer", summary: "Metadata-only tool frequency and failure analytics", commands: [{ name: "summary", summary: "Read bounded BB event history", usage: "bb tool-observer summary [--thread ID] [--provider ID] [--json]" }], async run(argv) {
            if (argv[0] !== "summary")
                return { exitCode: 1, stderr: "Usage: bb tool-observer summary [--thread ID] [--provider ID] [--json]" };
            const options: {
                threadId?: string;
                provider?: string;
            } = {};
            for (let i = 1; i < argv.length; i++) {
                if (argv[i] === "--json")
                    continue;
                if ((argv[i] === "--thread" || argv[i] === "--provider") && argv[i + 1])
                    options[argv[i] === "--thread" ? "threadId" : "provider"] = argv[++i];
                else
                    return { exitCode: 1, stderr: "Unknown or missing argument" };
            }
            return { exitCode: 0, stdout: JSON.stringify(await snapshot(options), null, 2) };
        } });
}
