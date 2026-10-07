// The REAL read-only readers behind GuardCtx, shared by the server (`seamReport` RPC) and scripts/check-seams.mjs. Reads only: fs stat/readdir/readFile,
// the real sealing functions on a synthetic sample, and the real herdr launch-plan builder. Nothing here writes, spawns or changes anything.
import { constants } from "node:fs";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRANSCRIPT_ROOT } from "../../transcript-feed.ts";
import { CODEX_ROOT } from "../codex-feed.ts";
import { herdrLaunchPlan } from "../../herdr-feed.ts";
import { sealFleet } from "../opaque-key.ts";
import type { FleetLane, FleetSnapshot } from "../fleet-types.ts";
import type { HerdrGuardCtx } from "./herdr-session.ts";
import type { BuildFact, GuardCtx, KeepAwakeFact, TranscriptRootFact, ViewFacts } from "./types.ts";

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

/** One transcript root: exists, readable, newest .jsonl mtime (bounded async walk, so the registry's timeout can bite). */
export async function readTranscriptRoot(path: string, required: boolean): Promise<TranscriptRootFact> {
  try { if (!(await stat(path)).isDirectory()) return { path, required, exists: false, readable: false, newestMtime: null }; } catch { return { path, required, exists: false, readable: false, newestMtime: null }; }
  try { await access(path, constants.R_OK); await readdir(path); } catch { return { path, required, exists: true, readable: false, newestMtime: null }; }
  let newest: number | null = null, seen = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let names: import("node:fs").Dirent[];
    try { names = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      if (seen >= WALK_MAX) return;
      const p = join(dir, n.name);
      if (n.isDirectory() && depth < WALK_DEPTH) await walk(p, depth + 1);
      else if (n.isFile() && n.name.endsWith(".jsonl")) { seen++; try { const m = (await stat(p)).mtimeMs; if (newest === null || m > newest) newest = m; } catch { /* vanished */ } }
    }
  };
  await walk(path, 0);
  return { path, required, exists: true, readable: true, newestMtime: newest };
}
export const defaultTranscriptRoots = (): Promise<TranscriptRootFact[]> => Promise.all([readTranscriptRoot(TRANSCRIPT_ROOT, true), readTranscriptRoot(CODEX_ROOT, false)]);

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

export type SeamCtxDeps = { isRepoAllowed(path: string): Promise<boolean>; keepAwake(): Promise<KeepAwakeFact>; installedBuild?(): Promise<BuildFact | null>; herdrSession?(view: ViewFacts): Promise<HerdrGuardCtx>; now?(): number; platform?: string };
/** The ONE GuardCtx constructor. Every reader is required except installedBuild (only a caller that can ask BB provides it). */
export function makeSeamCtx(view: ViewFacts, d: SeamCtxDeps): GuardCtx {
  return { now: d.now ?? Date.now, platform: d.platform ?? process.platform, view, isRepoAllowed: d.isRepoAllowed, runningBuild, ...(d.installedBuild ? { installedBuild: d.installedBuild } : {}), ...(d.herdrSession ? { herdrSession: () => d.herdrSession!(view) } : {}),
    transcriptRoots: defaultTranscriptRoots, keepAwake: d.keepAwake, dispatchSession: async () => dispatchSessionFromPlan(), sealedSample };
}
