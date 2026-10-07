// READ-ONLY repo-health reader (server-only) for the Health view. Every git call goes through runGit (read verbs only, bounded,
// no network, no fetch); the linked-worktree listing reads <common-git-dir>/worktrees with bounded fs reads and never writes.
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readStatus, runGit, validateRepo } from "./git-feed.ts";
import type { GitResult } from "./git-types.ts";
import type { HeadInfo, RepoHealth } from "./health-types.ts";

const PROBE_MS = 2000, WT_CAP = 200, BRANCH_CAP = 50, CONCURRENCY = 4, FILE_MAX = 4096, SAMPLE = 10, SHA = /^[0-9a-f]{40}$/;
/** A wrap COMMIT, not a subject that mentions the word: `wrap` leading the subject or its description (`docs(state): wrap …`)
 * or a `(wrap)` scope, and the word must END the phrase (end, colon, a date, `session`, or a dash): "queue a wrap counter" and
 * "fix: wrap long text" are not wraps (the first anchored every trend wrongly on a real repo; review H-2 N2). */
export const WRAP = /(?:^|:\s*)wrap(?:[- ]?up)?(?=\s*$|\s*:|\s+(?:\d{4}-\d{2}-\d{2}|session)\b|\s+[—–-]\s)|\(wrap\)/i;
type Opts = { cap?: number; wrapPattern?: RegExp; scanSubjects?: number; now?: number };
const lines = (s: string) => s.split("\n").filter(Boolean);
const posInt = (n: unknown, d: number, max: number) => typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : d;

export async function readHead(repo: string): Promise<GitResult<HeadInfo>> {
  const v = await validateRepo(repo);
  if (!v.ok) return v;
  const [h, b] = await Promise.all([runGit(v.value, ["rev-parse", "HEAD"], { timeoutMs: PROBE_MS }), runGit(v.value, ["rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: PROBE_MS })]);
  if (!h.ok) return h;
  const head = h.value.trim();
  // A detached HEAD abbreviates to the literal "HEAD", which is the contract's branch value for it.
  return SHA.test(head) ? { ok: true, value: { head, branch: b.ok ? b.value.trim() || "HEAD" : "HEAD" } } : { ok: false, reason: "unexpected git output" };
}

/** Bounded text read of a small file inside the worktrees admin dir; null when absent, oversized or unreadable. */
async function smallFile(p: string): Promise<string | null> {
  try { const s = await stat(p); return s.isFile() && s.size <= FILE_MAX ? (await readFile(p, "utf8")).trim() : null; } catch { return null; }
}
const exists = async (p: string) => { try { await stat(p); return true; } catch { return false; } };

/** Linked worktrees from the filesystem (`git worktree` is not a permitted verb). Reads only inside <common>/worktrees; the one
 * access outside it is an existence `stat` of each worktree directory (the path named by its `gitdir` file), which returns a
 * boolean and reads no content. */
async function readWorktrees(repo: string): Promise<{ list: RepoHealth["worktrees"]; total: number }> {
  const c = await runGit(repo, ["rev-parse", "--git-common-dir"], { timeoutMs: PROBE_MS });
  if (!c.ok) return { list: [], total: 0 };
  const root = join(resolve(repo, c.value.trim()), "worktrees");
  let all: string[];
  try { all = (await readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch { return { list: [], total: 0 }; }
  const names = all.slice(0, WT_CAP);
  const raw = await Promise.all(names.map(async n => {
    const d = join(root, n), gd = await smallFile(join(d, "gitdir")), head = await smallFile(join(d, "HEAD"));
    if (!gd) return null;
    // `gitdir` may be RELATIVE to this admin dir (worktree.useRelativePaths): resolve it here, never against the server cwd.
    const path = dirname(resolve(d, gd)), ref = head?.startsWith("ref: ") ? head.slice(5).trim() : null;
    return { path, ref, sha: head && SHA.test(head) ? head : null, missing: !(await exists(path)), locked: await exists(join(d, "locked")) };
  }));
  const wts = raw.filter((w): w is NonNullable<typeof w> => w !== null);
  // Branch heads (one for-each-ref call) + detached shas -> ONE `log --no-walk` for the commit times.
  const heads = new Map<string, string>();
  if (wts.some(w => w.ref)) {
    const r = await runGit(repo, ["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/heads"]);
    if (r.ok) for (const l of lines(r.value)) { const [n, s] = l.split("\t"); if (n && SHA.test(s ?? "")) heads.set(n, s); }
  }
  const shaOf = (w: typeof wts[number]) => w.sha ?? (w.ref ? heads.get(w.ref) ?? null : null);
  const shas = [...new Set(wts.map(shaOf).filter((s): s is string => !!s))];
  const times = new Map<string, number>();
  if (shas.length) {
    const r = await runGit(repo, ["log", "--no-walk=unsorted", "--format=%H%x09%ct", ...shas, "--"]);
    if (r.ok) for (const l of lines(r.value)) { const [s, t] = l.split("\t"), n = Number(t); if (SHA.test(s ?? "") && Number.isFinite(n)) times.set(s, n * 1000); }
  }
  // Admin dirs without a readable gitdir are not worktrees: discount the ones seen in the checked window (H-2 N6).
  return { total: all.length - (names.length - wts.length), list: wts.map(w => ({ path: w.path, branch: w.ref ? w.ref.replace(/^refs\/heads\//, "") : null, missing: w.missing, locked: w.locked, lastCommitAt: times.get(shaOf(w) ?? "") ?? null })) };
}

/** Per-branch commits on no remote: the 50 newest local branches, one bounded `log` each (4 at a time). The branch goes in as a
 * full ref so a name can never parse as an option. `more`: there were more branches than the bound. */
/** Branches with commits on no remote, counted per branch (shared commits count for each). A branch has such commits IFF its
 * tip is itself on no remote, so candidates come from tip membership in the distinct `--branches --not --remotes` set across
 * EVERY branch (review H-2 N1: picking the 50 newest branches first hid an older branch's forgotten work). Then at most
 * BRANCH_CAP candidates (newest first) get a bounded per-branch count. Full ref names (`%(refname)`), never `:short`, which
 * turns ambiguous names into `heads/x` (N3). `more` is set when candidates were cut, the distinct set was capped (a tip
 * beyond it cannot be seen), or any count failed. */
async function perBranch(repo: string, cap: number, unremoted: Set<string>, setCapped: boolean): Promise<{ branches: { branch: string; count: number }[]; more: boolean }> {
  const refs = await runGit(repo, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%09%(objectname)", "refs/heads"]);
  if (!refs.ok) return { branches: [], more: unremoted.size > 0 };
  const cands = lines(refs.value).map(l => l.split("\t")).filter(([ref, sha]) => ref?.startsWith("refs/heads/") && unremoted.has(sha ?? "")).map(([ref]) => ref);
  const names = cands.slice(0, BRANCH_CAP), out: { branch: string; count: number }[] = [];
  let next = 0, failed = false;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, names.length) }, async () => {
    while (next < names.length) {
      const ref = names[next++], l = await runGit(repo, ["log", "--format=%H", ref, "--not", "--remotes", "-n", String(cap + 1)]);
      if (!l.ok) { failed = true; continue; }
      const k = lines(l.value).length; if (k > 0) out.push({ branch: ref.slice("refs/heads/".length), count: Math.min(k, cap) });
    }
  }));
  return { branches: out, more: cands.length > BRANCH_CAP || setCapped || failed };
}

export async function readRepoHealth(repo: string, indexHead?: string, opts: Opts = {}): Promise<GitResult<RepoHealth>> {
  const v = await validateRepo(repo);
  if (!v.ok) return v;
  const r = v.value, cap = posInt(opts.cap, 500, 5000), scan = posInt(opts.scanSubjects, 500, 5000), pat = opts.wrapPattern ?? WRAP;
  const bound = ["-n", String(cap + 1)];
  const count = (out: string) => { const n = lines(out).length; return { count: Math.min(n, cap), capped: n > cap }; };
  const [head, st, unpushed, unrem, wts, wrapLog, behind] = await Promise.all([
    readHead(r), readStatus(r),
    runGit(r, ["log", "--format=%H", "HEAD", "--not", "--remotes", ...bound]),
    // Distinct commits on no remote across every branch (a commit shared by two branches counts once); per-branch counts follow.
    runGit(r, ["log", "--branches", "--not", "--remotes", "--format=%H", ...bound]),
    readWorktrees(r),
    runGit(r, ["log", "--format=%H%x09%ct%x09%s", "-n", String(scan), "HEAD"]),
    (async (): Promise<RepoHealth["behind"]> => {
      if (typeof indexHead !== "string" || !/^[0-9a-f]{7,40}$/.test(indexHead)) return null;
      const known = await runGit(r, ["rev-parse", "--verify", "--quiet", `${indexHead}^{commit}`], { timeoutMs: PROBE_MS });
      if (!known.ok) return null;
      const l = await runGit(r, ["log", "--format=%H", `${indexHead}..HEAD`, ...bound]);
      return l.ok ? { indexHead, ...count(l.value) } : null;
    })(),
  ]);
  if (!head.ok) return head;
  if (!st.ok) return st;
  if (!unpushed.ok) return unpushed;
  if (!unrem.ok) return unrem;
  const distinct = count(unrem.value);
  const { branches, more } = await perBranch(r, cap, new Set(lines(unrem.value).map(l => l.split("\t")[0])), distinct.capped);
  const e = st.value.entries;
  const wrap = wrapLog.ok ? (() => {
    for (const l of lines(wrapLog.value)) {
      const [sha, ct, ...s] = l.split("\t"), subject = s.join("\t"), t = Number(ct);
      if (SHA.test(sha ?? "") && Number.isFinite(t) && pat.test(subject)) return { sha, at: t * 1000, subject };
    }
    return null;
  })() : null;
  return { ok: true, value: {
    head: head.value.head, branch: head.value.branch, behind, unpushed: count(unpushed.value),
    uncommitted: { staged: e.filter(x => x.x !== " " && x.x !== "?" && x.x !== "!").length, unstaged: e.filter(x => x.y !== " " && x.x !== "?" && x.y !== "!").length, untracked: e.filter(x => x.x === "?").length, sample: e.slice(0, SAMPLE).map(x => x.path) },
    unremoted: branches.sort((a, b) => b.count - a.count || (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0)),
    unremotedCommits: distinct.count, unremotedCapped: more || distinct.capped, worktrees: wts.list, worktreeTotal: wts.total, wrap,
  } };
}
