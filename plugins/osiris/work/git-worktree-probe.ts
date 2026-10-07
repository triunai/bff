// Read-only worktree probe (drift detector input): `git worktree list --porcelain -z` + `git status --porcelain=v1 -z` per worktree.
// This file spawns NOTHING itself. It takes the reviewed runner (git-feed.ts `runGit`: execFile, shell:false, fixed argv, GIT_* stripped,
// hooks/fsmonitor off) as an injected `ProbeGit`, so the S8 spawn-allowlist test stays untouched and tests stub it.
// WIRING NOTE: runGit's verb allowlist does not include `worktree` today, so `worktree list` is refused until git-feed.ts accepts that
// one exact argv (see YB-REPORT). The probe then returns { ok: false } with the reason instead of throwing.
import type { GitResult } from "../git-types.ts";

/** Same signature as git-feed.ts `runGit(repo, args)`. */
export type ProbeGit = (cwd: string, args: string[]) => Promise<GitResult<string>>;
/** `dirty` = entries in `git status` (modified, staged, untracked); null when status could not be read. `branch` null = detached. */
export type WorktreeInfo = { dirty: number | null; branch: string | null };
export type GitState = ReadonlyMap<string, WorktreeInfo>;

export const WORKTREE_LIST_ARGS: readonly string[] = Object.freeze(["worktree", "list", "--porcelain", "-z"]);
export const STATUS_ARGS: readonly string[] = Object.freeze(["status", "--porcelain=v1", "-z"]);
const MAX_WORKTREES = 64;

/** Pure: `worktree list --porcelain -z` -> [{path, branch}]. Bare and prunable entries are dropped (nothing to be dirty). */
export function parseWorktreeList(out: string): { path: string; branch: string | null }[] {
  const res: { path: string; branch: string | null }[] = [];
  let cur: { path: string; branch: string | null; skip: boolean } | null = null;
  const flush = () => { if (cur && !cur.skip) res.push({ path: cur.path, branch: cur.branch }); cur = null; };
  for (const tok of out.split("\0")) {
    if (tok === "") { flush(); continue; }
    if (tok.startsWith("worktree ")) { flush(); cur = { path: tok.slice(9), branch: null, skip: false }; continue; }
    if (!cur) continue;
    if (tok.startsWith("branch ")) cur.branch = tok.slice(7).replace(/^refs\/heads\//, "");
    else if (tok === "bare" || tok.startsWith("prunable")) cur.skip = true;
  }
  flush();
  return res;
}

/** Pure: `status --porcelain=v1 -z` -> number of changed entries. A rename/copy carries its origin path as one extra field. */
export function countStatus(out: string): number {
  const toks = out.split("\0");
  let n = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]; if (t.length < 4) continue; // "XY path"
    n++; if (/[RC]/.test(t.slice(0, 2))) i++;
  }
  return n;
}

/** Reads every worktree of `repo`. A status that fails leaves that worktree's `dirty` null (never guessed as clean). */
export async function probeWorktrees(repo: string, git: ProbeGit): Promise<GitResult<Map<string, WorktreeInfo>>> {
  const l = await git(repo, [...WORKTREE_LIST_ARGS]);
  if (!l.ok) return { ok: false, reason: `could not list worktrees: ${l.reason}` };
  const out = new Map<string, WorktreeInfo>();
  for (const w of parseWorktreeList(l.value).slice(0, MAX_WORKTREES)) {
    const s = await git(w.path, [...STATUS_ARGS]);
    out.set(w.path, { branch: w.branch, dirty: s.ok ? countStatus(s.value) : null });
  }
  return { ok: true, value: out };
}
