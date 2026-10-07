// `osiris-tui.mjs prune [--repo <p>] [--apply] [--min-idle-days N] [--installed <dir>] [--json]`.
// ALWAYS A DRY RUN that prints the plan. The plugin carries no worktree-mutating argv: `--apply` prints the plan, says removal runs in bff
// (`bff osiris prune --apply`) and exits 2 without removing anything.
import { resolve } from "node:path";
import { readWorkSnapshot } from "../work/bdi-feed.ts";
import { resolveTrustedPath, trustedRun } from "../work/trusted-bin.ts";
import { installedDirFromPluginList } from "../work/seam-guards/server-ctx.ts";
import { termSafe } from "./sanitize.ts";
import { planPrune, readGit, type PruneGit } from "./prune-git.ts";
import { planText } from "./prune-model.ts";
import type { PaneAt } from "./worktrees-git.ts";

export type PruneArgs = { repo: string; apply: boolean; minIdleDays: number; json: boolean; installed: string | null };
export function parsePruneArgs(argv: readonly string[]): PruneArgs {
  const opt = (k: string): string | null => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] ?? null : null; };
  const n = Number(opt("--min-idle-days") ?? 3);
  return { repo: resolve(opt("--repo") ?? process.cwd()), apply: argv.includes("--apply"), minIdleDays: Number.isFinite(n) && n >= 0 ? n : 3, json: argv.includes("--json"), installed: opt("--installed") };
}

/** The installed plugin dir, read from `bb plugin list` as osiris-update does, through the trusted-binary primitive (ADR D-139: fixed dirs, re-vetted per call, minimal env). null when bb is missing or the plugin is not listed. */
export const installedDir = async (): Promise<string | null> => {
  const bb = resolveTrustedPath("bb", { aliasTargets: "trusted" }); if (!bb) return null;
  try { return installedDirFromPluginList((await trustedRun(bb, ["plugin", "list"], { timeoutMs: 15_000, label: "bb", trust: { aliasTargets: "trusted" } })).stdout); } catch { return null; }
};
/** Agent panes the work feed knows (cwd + pane id). Best effort: none known is not an error (the 2 h modified rule still protects fresh dirs). */
export async function panesOf(repo: string): Promise<PaneAt[]> {
  const r = await readWorkSnapshot(repo).catch(() => null);
  return r?.ok ? [...r.value.tree.flatMap(t => t.nodes.flatMap(n => (n.agent?.cwd ? [{ cwd: n.agent.cwd, label: n.agent.paneId }] : []))), ...r.value.unattributed.flatMap(p => (p.cwd ? [{ cwd: p.cwd, label: p.paneId }] : []))] : [];
}

/** The plugin never removes a worktree: this is the whole of `--apply` and of the TUI `p` then `y` flow. */
export const REMOVAL_IN_BFF = "Removal runs in bff: `bff osiris prune --apply`.";
/** `deps` exist so tests can run the whole command on canned git; the real CLI passes none. */
export type PruneDeps = { git?: PruneGit; panes?: PaneAt[]; now?: () => number };
export async function runPrune(a: PruneArgs, log: (s: string) => void = console.log, deps: PruneDeps = {}): Promise<number> {
  const installed = a.installed ?? (await installedDir()), panes = deps.panes ?? (await panesOf(a.repo)), git = deps.git ?? readGit, now = deps.now ?? Date.now;
  const plan = await planPrune(a.repo, { now: now(), minIdleDays: a.minIdleDays, installed }, { git, panes });
  if ("error" in plan) { console.error(termSafe(`prune: ${plan.error}`)); return 1; }
  if (a.json) { log(JSON.stringify({ plan, applied: null }, null, 2)); return a.apply ? 2 : 0; }
  for (const l of planText(plan)) log(termSafe(l));
  if (a.apply) { console.error(`${REMOVAL_IN_BFF} Nothing removed.`); return 2; }
  log(`dry run: nothing removed. ${REMOVAL_IN_BFF}`);
  return 0;
}
