// `osiris prune` git access: READS ONLY. readGit is built on git-feed's spawnGit (the trusted-binary primitive, ADR D-139: HARDEN_ARGS, minimal env) and refuses any argv that is not
// one of the exact read shapes below. The plugin carries NO worktree-mutating argv (the safety scan protects that); removal runs in bff
// (`bff osiris prune --apply`), a separate tool with its own trusted-binary rules.
import { stat } from "node:fs/promises";
import { HARDEN_ARGS, spawnGit } from "../git-feed.ts";
import type { GitResult } from "../git-types.ts";
import { countStatus } from "../work/git-worktree-probe.ts";
import { buildPlan, type PruneFacts, type PruneOpts, type PrunePlan, type StaleEntry } from "./prune-model.ts";
import type { PaneAt } from "./worktrees-git.ts";

export type PruneGit = (cwd: string, args: string[]) => Promise<GitResult<string>>;

// ---- read shapes -------------------------------------------------------------------------------------------------------------------
export const LIST_READ: readonly string[] = Object.freeze(["worktree", "list", "--porcelain", "-z"]);
export const STATUS_PRUNE_READ: readonly string[] = Object.freeze(["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
export const HEAD_READ: readonly string[] = Object.freeze(["rev-parse", "HEAD"]);
export const TIME_READ: readonly string[] = Object.freeze(["log", "-1", "--format=%ct"]);
export const REFS_READ: readonly string[] = Object.freeze(["for-each-ref", "--format=%(refname)", "refs/heads/"]);
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const SHA = /^[0-9a-f]{40}$/, HEAD_REF = /^refs\/heads\/[^\s-]\S*$/;
/** `rev-list --count <sha> --not --remotes <refs/heads/...>...`: the reachability measure (by commits, never by branch name). */
export const isReachArgv = (a: readonly string[]): boolean => a.length >= 5 && a[0] === "rev-list" && a[1] === "--count" && SHA.test(a[2]) && a[3] === "--not" && a[4] === "--remotes" && a.slice(5).every(r => HEAD_REF.test(r));
export const isPruneReadArgv = (a: readonly string[]): boolean => [LIST_READ, STATUS_PRUNE_READ, HEAD_READ, TIME_READ, REFS_READ].some(s => same(a, s)) || isReachArgv(a);

const exec = async (cwd: string, args: string[], timeoutMs: number): Promise<GitResult<string>> => {
  const r = await spawnGit(["-C", cwd, "--no-optional-locks", ...HARDEN_ARGS, ...args], { timeoutMs, maxBytes: 8 << 20 });
  return r.kind === "exit" && r.code === 0 ? { ok: true, value: r.stdout } : { ok: false, reason: `git ${args[0]} failed` };
};
export const guardedRead = (inner: PruneGit): PruneGit => (cwd, args) => (isPruneReadArgv(args) ? inner(cwd, args) : Promise.resolve({ ok: false, reason: "git subcommand not permitted (prune reads)" }));
export const readGit: PruneGit = guardedRead((cwd, args) => exec(cwd, args, 20_000));

// ---- collection (reads) ------------------------------------------------------------------------------------------------------------
export type ListedWorktree = { path: string; head: string | null; branch: string | null; locked: boolean; prunable: boolean; bare: boolean };
/** Pure: `worktree list --porcelain -z`. Unlike probe's parser this KEEPS locked/prunable/bare entries (and says so). The first entry is the main worktree. */
export function parseListing(out: string): ListedWorktree[] {
  const res: ListedWorktree[] = []; let cur: ListedWorktree | null = null;
  const flush = () => { if (cur) res.push(cur); cur = null; };
  for (const tok of out.split("\0")) {
    if (tok === "") { flush(); continue; }
    if (tok.startsWith("worktree ")) { flush(); cur = { path: tok.slice(9), head: null, branch: null, locked: false, prunable: false, bare: false }; continue; }
    if (!cur) continue;
    if (tok.startsWith("HEAD ")) cur.head = tok.slice(5);
    else if (tok.startsWith("branch ")) cur.branch = tok.slice(7).replace(/^refs\/heads\//, "");
    else if (tok === "locked" || tok.startsWith("locked ")) cur.locked = true;
    else if (tok === "prunable" || tok.startsWith("prunable ")) cur.prunable = true;
    else if (tok === "bare") cur.bare = true;
  }
  flush();
  return res;
}

/** Branches whose commits count as "kept elsewhere": main, wip/t1-0216 and the integration branches (fin/integ-N). Remotes are always protected. */
export const isProtectedBranch = (name: string): boolean => name === "main" || name === "wip/t1-0216" || /^(fin\/)?integ[-/]/.test(name);

export type CollectDeps = { git: PruneGit; panes?: readonly PaneAt[]; mtime?: (path: string) => Promise<number | null>; concurrency?: number };
const agentOn = (path: string, panes: readonly PaneAt[]): string | null => panes.find(p => p.cwd === path || p.cwd.startsWith(`${path}/`))?.label ?? null;
export const dirMtime = async (p: string): Promise<number | null> => stat(p).then(s => s.mtimeMs, () => null);

async function protectedRefs(repo: string, git: PruneGit): Promise<string[] | null> {
  const r = await git(repo, [...REFS_READ]);
  return r.ok ? r.value.split("\n").map(s => s.trim()).filter(s => HEAD_REF.test(s) && isProtectedBranch(s.slice(11))) : null;
}
/** The facts of one listed worktree. Anything unreadable stays null: the model turns null into KEEP/REVIEW, never into SAFE. */
async function factsOf(w: ListedWorktree, main: string, refs: readonly string[] | null, d: CollectDeps): Promise<PruneFacts> {
  const git = d.git, [st, hd, tm, mt] = await Promise.all([git(w.path, [...STATUS_PRUNE_READ]), git(w.path, [...HEAD_READ]), git(w.path, [...TIME_READ]), (d.mtime ?? dirMtime)(w.path)]);
  const sha = hd.ok ? hd.value.trim() : null, reach = sha && SHA.test(sha) && refs ? await git(w.path, ["rev-list", "--count", sha, "--not", "--remotes", ...refs]) : null;
  const commitAt = tm.ok && /^\d+$/.test(tm.value.trim()) ? Number(tm.value.trim()) * 1000 : null;
  const times = [commitAt, mt].filter((x): x is number => x !== null);
  return {
    path: w.path, name: w.path.split("/").filter(Boolean).pop() ?? w.path, main: w.path === main, locked: w.locked, branch: w.branch,
    dirty: st.ok ? countStatus(st.value) : null, unreachable: reach?.ok && /^\d+$/.test(reach.value.trim()) ? Number(reach.value.trim()) : null,
    activeAt: times.length ? Math.max(...times) : null, live: agentOn(w.path, d.panes ?? []),
  };
}
async function pool<T, R>(xs: readonly T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (i < xs.length) { const k = i++; out[k] = await f(xs[k]); } }));
  return out;
}

/** Read every worktree of `repo` and build the plan. An error object when the listing itself failed (nothing is guessed). */
export async function planPrune(repo: string, o: PruneOpts, d: CollectDeps): Promise<PrunePlan | { error: string }> {
  const l = await d.git(repo, [...LIST_READ]);
  if (!l.ok) return { error: `could not list worktrees: ${l.reason}` };
  const listed = parseListing(l.value), main = listed[0]?.path ?? repo;
  const stale: StaleEntry[] = listed.filter(w => w.prunable).map(w => ({ path: w.path, reason: "directory is gone (admin entry only)" }));
  const live = listed.filter(w => !w.prunable && !w.bare), refs = await protectedRefs(repo, d.git);
  const facts = await pool(live, d.concurrency ?? 8, w => factsOf(w, main, refs, d));
  return buildPlan(main, facts, stale, o);
}
