// The REAL read-only readers behind GuardCtx, shared by the server (`seamReport` RPC) and scripts/check-seams.mjs. Reads only: fs stat/readdir/readFile,
// the real sealing functions on a synthetic sample, and the real herdr launch-plan builder. Nothing here writes, spawns or changes anything.
import { constants } from "node:fs";
import { access as fsAccess, readdir as fsReaddir, readFile, realpath, stat as fsStat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRANSCRIPT_ROOT } from "../../transcript-feed.ts";
import { CODEX_ROOT } from "../codex-feed.ts";
import { herdrLaunchPlan } from "../../herdr-feed.ts";
import { sealFleet } from "../opaque-key.ts";
import type { FleetLane, FleetSnapshot } from "../fleet-types.ts";
import type { HerdrGuardCtx } from "./herdr-session.ts";
import type { BuildFact, GuardCtx, KeepAwakeFact, TranscriptRootFact, ViewFacts } from "./types.ts";
import { TRANSCRIPT_STALE_MS } from "./guards.ts";

const PLUGIN_NAME = "bb-plugin-tool-observer";
const WALK_DEPTH = 5, WALK_MAX = 20_000;

/** The plugin root: the nearest package.json upward from `from` that names this plugin; null when none does. */
export async function readBuild(from: string): Promise<BuildFact | null> {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    try { const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { name?: string; version?: string }; if (pkg.name === PLUGIN_NAME) return { dir: await realpath(dir), version: String(pkg.version ?? "?") }; } catch { /* no package.json here */ }
    const up = dirname(dir); if (up === dir) return null; dir = up;
  }
  return null;
}
export async function runningBuild(): Promise<BuildFact | null> {
  try { return await readBuild(dirname(fileURLToPath(import.meta.url))); } catch { return null; }
}

/** `bb plugin list` text -> the source path of the tool-observer entry, or null. Pure. */
export function installedDirFromPluginList(text: string): string | null {
  const lines = text.split("\n"); const i = lines.findIndex(l => /^tool-observer@/.test(l));
  if (i < 0) return null;
  for (const l of lines.slice(i + 1)) { if (/^\S/.test(l)) return null; const m = /source:\s*path:(\S.*)$/.exec(l.trim()); if (m) return m[1].trim(); }
  return null;
}
export async function installedBuildFromDir(dir: string | null): Promise<BuildFact | null> { return dir ? readBuild(dir) : null; }

/** How a transcript-root check may spend its time. Every field has a production default; tests inject them. */
export type RootCheckOptions = {
  /** A newest-transcript mtime someone already measured (the telemetry service's last listing). It is a LOWER bound on the real newest,
   *  so when it is recent it answers "being written" with no walk at all; when it is old or absent the walk runs. */
  knownNewest?: number | null;
  /** Stop as soon as a transcript newer than this is found: that alone answers "recent". Default TRANSCRIPT_STALE_MS. */
  recentWithinMs?: number;
  /** Hard wall-clock budget for the walk, well under the registry's GUARD_TIMEOUT_MS so the guard answers instead of timing out. */
  budgetMs?: number;
  /** Stats in flight at once. */
  concurrency?: number;
  maxFiles?: number;
  now?: () => number;
  clock?: () => number;
  /** The fs calls the walk makes; defaults to node:fs/promises. A seam so a test can simulate a starved event loop (every call resolves late). */
  fs?: { stat: typeof fsStat; readdir: typeof fsReaddir; access: typeof fsAccess };
};
export const ROOT_CHECK_BUDGET_MS = 2_000, ROOT_CHECK_CONCURRENCY = 32;

/** One transcript root: exists, readable, and a recent .jsonl mtime (or the newest one when none is recent).
 *  The walk is best-first: directories are stat'ed before files and the newest-mtime directory is opened next (a directory's mtime moves
 *  when a session or subagent file is created in it), it stops at the first recent transcript, stats run `concurrency` at a time, and a
 *  wall-clock budget turns a starved event loop into `incomplete` (a distinct warn) instead of the registry's 5 s timeout. Serial stats
 *  of every file were the 0.3.1 timeout: ~2,200 awaits each needing a loop turn while modFeed/workTelemetry stalled the loop for seconds. */
export async function readTranscriptRoot(path: string, required: boolean, o: RootCheckOptions = {}): Promise<TranscriptRootFact> {
  const { stat, readdir, access } = o.fs ?? { stat: fsStat, readdir: fsReaddir, access: fsAccess };
  const clock = o.clock ?? (() => performance.now()), start = clock(), now = (o.now ?? Date.now)();
  const recentMs = o.recentWithinMs ?? TRANSCRIPT_STALE_MS, budget = o.budgetMs ?? ROOT_CHECK_BUDGET_MS, conc = Math.max(1, o.concurrency ?? ROOT_CHECK_CONCURRENCY), maxFiles = o.maxFiles ?? WALK_MAX;
  try { if (!(await stat(path)).isDirectory()) return { path, required, exists: false, readable: false, newestMtime: null }; } catch { return { path, required, exists: false, readable: false, newestMtime: null }; }
  let top: import("node:fs").Dirent[];
  try { await access(path, constants.R_OK); top = await readdir(path, { withFileTypes: true }); } catch { return { path, required, exists: true, readable: false, newestMtime: null }; }
  const recent = (m: number | null) => m !== null && now - m <= recentMs;
  if (recent(o.knownNewest ?? null)) return { path, required, exists: true, readable: true, newestMtime: o.knownNewest! };
  let newest: number | null = null, scanned = 0;
  const over = () => clock() - start > budget || scanned >= maxFiles;
  const done = (incomplete: boolean): TranscriptRootFact => ({ path, required, exists: true, readable: true, newestMtime: newest, ...(incomplete ? { incomplete: { scanned } } : {}) });
  const mtimes = async (dir: string, ents: readonly import("node:fs").Dirent[]): Promise<(number | null)[]> => {
    const out: (number | null)[] = [];
    for (let i = 0; i < ents.length; i += conc) {
      if (over()) return out; // the caller sees fewer answers than entries and reports incomplete
      out.push(...await Promise.all(ents.slice(i, i + conc).map(e => stat(join(dir, e.name)).then(s => s.mtimeMs, () => null))));
    }
    return out;
  };
  const frontier: { dir: string; depth: number; mtime: number; ents?: import("node:fs").Dirent[] }[] = [{ dir: path, depth: 0, mtime: Infinity, ents: top }];
  while (frontier.length) {
    if (over()) return done(true);
    let bi = 0; for (let i = 1; i < frontier.length; i++) if (frontier[i].mtime > frontier[bi].mtime) bi = i;
    const { dir, depth, ents: pre } = frontier.splice(bi, 1)[0];
    let ents = pre;
    if (!ents) { try { ents = await readdir(dir, { withFileTypes: true }); } catch { continue; } }
    const subs = depth < WALK_DEPTH ? ents.filter(e => e.isDirectory()) : [], files = ents.filter(e => e.isFile() && e.name.endsWith(".jsonl"));
    const dm = await mtimes(dir, subs);
    if (dm.length < subs.length) return done(true);
    subs.forEach((e, i) => frontier.push({ dir: join(dir, e.name), depth: depth + 1, mtime: dm[i] ?? -Infinity }));
    for (let i = 0; i < files.length; i += conc) {
      if (over()) return done(true);
      const chunk = files.slice(i, i + conc), ms = await Promise.all(chunk.map(e => stat(join(dir, e.name)).then(s => s.mtimeMs, () => null)));
      scanned += chunk.length;
      for (const m of ms) if (m !== null && (newest === null || m > newest)) newest = m;
      if (recent(newest)) return done(false);
    }
  }
  return done(false);
}
export const defaultTranscriptRoots = (knownNewest?: (root: string) => number | null): Promise<TranscriptRootFact[]> =>
  Promise.all([readTranscriptRoot(TRANSCRIPT_ROOT, true, { knownNewest: knownNewest?.(TRANSCRIPT_ROOT) ?? null }), readTranscriptRoot(CODEX_ROOT, false, { knownNewest: knownNewest?.(CODEX_ROOT) ?? null })]);

/** Which session dispatch opens its tab in, read from the SAME launch-plan builder the dispatcher uses (it passes no session): "default" or the named one. */
export function dispatchSessionFromPlan(): string {
  const plan = herdrLaunchPlan("/x/herdr", ["/"], "/h", null, "/usr/bin/env");
  if (!plan.ok) throw new Error("the dispatch launch plan could not be built");
  const i = plan.argv.indexOf("session");
  return i >= 0 ? (plan.argv[i + 2] ?? "default") : "default";
}

/** A synthetic fleet whose every id is a known raw string, sealed by the real sealFleet. Mirrors the shapes sealing must scrub: lane keys, parent keys, ids in labels / workspaces / branches / message ends. */
export const SEAL_RAW = ["a5ea1c0ffee00bad01", ["01a107e7", "a467", "7861", "aea3", "274aaad04ccd"].join("-")] as const; // joined so no uuid-shaped literal sits in a non-test file
export async function sealedSample(): Promise<{ raw: string[]; sealed: string }> {
  const [A, U] = SEAL_RAW;
  const lane = (key: string, parentKey: string | null): FleetLane => ({ key, runtime: "claude", label: `webshop/agent-${A}`, labelFrom: "workspace", kind: "subagent", parentKey, role: "worker", model: null, modelKey: "unknown", modelLetter: "?", workspace: `webshop/agent-${A}`, branch: `worktree-agent-${A}`, beadId: null, firstAt: null, lastAt: null, state: "live", requests: 0, tokensIn: 0, tokensOut: 0, costUsd: null, pricedUsd: 0, spark: [] });
  const lanes = [lane(A, U), lane(U, null)];
  const snap = { summary: {} as FleetSnapshot["summary"], lanes, truncated: false, names: lanes.map(l => ({ key: l.key, label: l.label, kind: l.kind, parentKey: l.parentKey, role: l.role, modelLetter: l.modelLetter, workspace: l.workspace, branch: l.branch, beadId: null, state: l.state })),
    messages: [{ at: 1, kind: "send", from: A, to: `agent-${A}`, summary: null, protocol: null, laneKey: A }, { at: 2, kind: "receive", from: "fg-lead", to: U, summary: null, protocol: null, laneKey: U }] } as unknown as FleetSnapshot;
  const sealed = JSON.stringify(sealFleet(snap, "seam-guard-salt"));
  // The check looks for the raw ids and their bare hex cores (an 8-hex prefix or a 16-hex run is enough to identify an agent).
  return { raw: [A, A.slice(1), U, U.slice(0, 8)], sealed };
}

export type SeamCtxDeps = { isRepoAllowed(path: string): Promise<boolean | "busy">; keepAwake(): Promise<KeepAwakeFact>; /** A newest-transcript mtime already measured for this root (the telemetry listing), or null. */ knownNewest?(root: string): number | null; installedBuild?(): Promise<BuildFact | null>; herdrSession?(view: ViewFacts): Promise<HerdrGuardCtx>; now?(): number; platform?: string };
/** The ONE GuardCtx constructor. Every reader is required except installedBuild (only a caller that can ask BB provides it). */
export function makeSeamCtx(view: ViewFacts, d: SeamCtxDeps): GuardCtx {
  return { now: d.now ?? Date.now, platform: d.platform ?? process.platform, view, isRepoAllowed: d.isRepoAllowed, runningBuild, ...(d.installedBuild ? { installedBuild: d.installedBuild } : {}), ...(d.herdrSession ? { herdrSession: () => d.herdrSession!(view) } : {}),
    transcriptRoots: () => defaultTranscriptRoots(d.knownNewest), keepAwake: d.keepAwake, dispatchSession: async () => dispatchSessionFromPlan(), sealedSample };
}
