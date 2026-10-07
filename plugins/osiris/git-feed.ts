// READ-ONLY, bounded git reader (server-only). Never writes, never hooks, never fetches, never uses a shell.
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";
import type { CommitMention, DayCommits, DayCounts, FileDiff, GitCommitDetail, GitGraph, GitFileStat, GitRepo, GitResult, GitScope, GitStatus } from "./git-types.ts";
import { resolveTrustedPath, trustedSpawn, type SpawnOutcome } from "./work/trusted-bin.ts";
import { parseFileDiff } from "./git-diff.ts";
import { DAY_LOG_FORMAT, LOG_FORMAT, parseDayLog, REF_FORMAT, parseLog, parseNumstat, parseRefs, parseStatus } from "./git-graph.ts";

/** The ONLY git subcommands this module can issue (`diff` joined for History > Working tree: a read verb; `--output`, `--ext-diff`, `--textconv` and `--no-index` stay refused). Pinned by test; adding a write verb here is a contract break. */
export const READ_ONLY: readonly string[] = Object.freeze(["log", "for-each-ref", "status", "show", "rev-parse", "diff"]);
/** The graph log alone gets 8 MB: 3000 busy-repo records (long subject, 8 refs, 5 trailers) measure ~2.8 MB, so 4 MB left only 1.4x headroom and an
 * overflow fails the WHOLE read ("output exceeded the size bound"), not just the tail. Everything else keeps 4 MB. */
export const GRAPH_MAX_BYTES = 8 * 1024 * 1024;
const MAX_BYTES = 4 * 1024 * 1024, SLOW_MS = 5000, STATUS_MS = 2000;
const REPO_CAP = 60, FILE_CAP = 500, DEFAULT_LIMIT = 300, MIN_LIMIT = 50, MAX_LIMIT = 3000;
// Options that make a read verb write a file or run external programs.
const FORBIDDEN_ARG = /^--(output|ext-diff|textconv|open-files-in-pager|exec-path|no-index)/;

export const isReadOnlyArgs = (args: readonly string[]): boolean => args.length > 0 && READ_ONLY.includes(args[0]) && !args.some(a => FORBIDDEN_ARG.test(a));

/** Hardening shared with the git-write runner (work/git-write.ts) so there is ONE definition: no fsmonitor, no hooks, no external diff/attributes, no submodule recursion. */
export const HARDEN_ARGS: readonly string[] = Object.freeze(["-c", "core.fsmonitor=false", "-c", "color.ui=false", "-c", "core.attributesFile=/dev/null", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "submodule.recurse=false"]);
/** What a git child may see (ADR D-139): the primitive's minimal base (PATH of fixed dirs, HOME, LANG) plus the fixed safe GIT_* below. NOTHING is inherited, so no GIT_DIR, GIT_WORK_TREE,
 * GIT_INDEX_FILE, GIT_EXTERNAL_DIFF, GIT_EXEC_PATH or GIT_CONFIG_* can redirect or extend git. `extra` is applied last. */
export const GIT_FIXED_ENV: Readonly<Record<string, string>> = Object.freeze({ GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_ATTR_NOSYSTEM: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_LITERAL_PATHSPECS: "1", GIT_NO_LAZY_FETCH: "1", LC_ALL: "C" });
export const gitChildEnv = (extra: Record<string, string> = {}): { env: Record<string, string> } => ({ env: { ...GIT_FIXED_ENV, ...extra } });
/** The ONE git program: absolute, from the fixed trusted directories, re-vetted on every spawn. Null when git is missing or untrusted. */
export const resolveGit = (): string | null => resolveTrustedPath("git");
/** `git <argv>` through the primitive with the env above: THE git spawn for every reader and writer, so no caller builds its own. `bin` is a test seam. */
export const spawnGit = (argv: readonly string[], o: { cwd?: string; timeoutMs?: number; maxBytes?: number; extraEnv?: Record<string, string>; bin?: string | null } = {}): Promise<SpawnOutcome> => {
  const bin = o.bin === undefined ? resolveGit() : o.bin;
  if (!bin) return Promise.resolve({ kind: "refused", reason: "not-found", detail: "git was not found in a trusted location" });
  return trustedSpawn(bin, argv, { ...gitChildEnv(o.extraEnv), cwd: o.cwd, timeoutMs: o.timeoutMs, maxBuffer: o.maxBytes ?? MAX_BYTES });
};

export function runGit(repo: string, args: string[], opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<GitResult<string>> {
  if (!isReadOnlyArgs(args)) return Promise.resolve({ ok: false, reason: "git subcommand not permitted (read-only reader)" });
  // Hardening (review C-1 MED-1): no fsmonitor daemon, no global/system attribute files, no hooks path, no external diff or
  // textconv, no submodule recursion. Residual: in-tree .gitattributes filter drivers configured in the repo's own
  // .git/config can still run when `status` re-hashes a racy file — the same exposure as the owner's shell prompt running
  // `git status` in that repo. Osiris therefore assumes the repos it reads are the owner's own (see ESCALATIONS).
  const full = ["-C", repo, "--no-optional-locks", ...HARDEN_ARGS, ...args];
  return spawnGit(full, { timeoutMs: opts.timeoutMs ?? SLOW_MS, maxBytes: opts.maxBytes ?? MAX_BYTES }).then((r): GitResult<string> => {
    switch (r.kind) {
      case "exit": return r.code === 0 ? { ok: true, value: r.stdout } : { ok: false, reason: `git exited with status ${r.code}` };
      case "overflow": return { ok: false, reason: "git output exceeded the size bound" };
      case "timeout": return { ok: false, reason: "git timed out" };
      case "refused": return { ok: false, reason: r.reason === "not-found" ? "git executable not found" : `git is not a trusted program (${r.reason})` };
      default: return { ok: false, reason: r.code === "ENOENT" ? "git executable not found" : "git failed" };
    }
  });
}

export async function validateRepo(path: string): Promise<GitResult<string>> {
  if (typeof path !== "string" || !path || path.includes("\0")) return { ok: false, reason: "invalid repository path" };
  if (!isAbsolute(path)) return { ok: false, reason: "repository path must be absolute" };
  try {
    const real = await realpath(path);
    const s = await stat(join(real, ".git"));
    if (!s.isDirectory() && !s.isFile()) return { ok: false, reason: "not a git repository" };
    return { ok: true, value: real };
  } catch { return { ok: false, reason: "not a git repository" }; }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
}

const hasGit = async (dir: string): Promise<boolean> => { try { await stat(join(dir, ".git")); return true; } catch { return false; } };
const subdirs = async (dir: string): Promise<string[]> => {
  try { return (await readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules").map(d => join(dir, d.name)).sort(); } catch { return []; }
};

export async function discoverRepos(extra: string[] = [], home = homedir()): Promise<GitRepo[]> {
  const found = new Map<string, GitRepo["source"]>();
  const root = join(home, "Repos");
  for (const a of await subdirs(root)) {
    if (await hasGit(a)) found.set(a, "scan");
    for (const b of await subdirs(a)) if (await hasGit(b)) found.set(b, "scan");
  }
  for (const e of extra.slice(0, 20)) { const v = await validateRepo(e); if (v.ok) found.set(v.value, found.get(v.value) ? "scan" : "user"); }
  const paths = [...found.entries()].slice(0, REPO_CAP);
  return pool(paths, 4, async ([path, source]): Promise<GitRepo> => {
    // Branch comes from the status header (also correct for a repo with no commits, where rev-parse --abbrev-ref fails).
    const [head, st] = await Promise.all([runGit(path, ["rev-parse", "HEAD"], { timeoutMs: STATUS_MS }), runGit(path, ["status", "--porcelain=v1", "-z", "--branch", "--ignore-submodules=all"], { timeoutMs: STATUS_MS })]);
    const parsed = st.ok ? parseStatus(st.value) : null;
    return { path, name: basename(path), source, branch: parsed?.branch ?? null, head: head.ok ? head.value.trim() || null : null, dirty: parsed ? parsed.entries.length : null };
  });
}

export async function readGraph(repo: string, scope: GitScope = "all", limit = DEFAULT_LIMIT): Promise<GitResult<GitGraph>> {
  const v = await validateRepo(repo);
  if (!v.ok) return v;
  const lim = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_LIMIT));
  const refsRes = await runGit(v.value, ["for-each-ref", `--format=${REF_FORMAT}`, "refs/heads", "refs/remotes", "refs/tags"]);
  if (!refsRes.ok) return refsRes;
  const refs = parseRefs(refsRes.value);
  const locals = refs.filter(r => r.kind === "local");
  const mainRef = locals.some(r => r.name === "main") ? "main" : locals.some(r => r.name === "master") ? "master" : null;
  const latestLocal = locals.reduce<typeof locals[number] | null>((best, r) => (best === null || (r.committedAt ?? 0) > (best.committedAt ?? 0) || ((r.committedAt ?? 0) === (best.committedAt ?? 0) && r.name === mainRef) ? r : best), null)?.name ?? null;
  if (scope === "main" && !mainRef) return { ok: false, reason: "no main or master branch" };
  const logArgs = ["log", "--no-ext-diff", "--no-textconv", ...(scope === "all" ? ["--exclude=refs/stash", "--all"] : [`refs/heads/${mainRef!}`]), "--topo-order", "-n", String(lim + 1), `--format=${LOG_FORMAT}`];
  if (scope === "main") logArgs.push("--");
  const [logRes, headRes, branchRes] = await Promise.all([
    runGit(v.value, logArgs, { maxBytes: GRAPH_MAX_BYTES }), runGit(v.value, ["rev-parse", "HEAD"], { timeoutMs: STATUS_MS }), runGit(v.value, ["rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: STATUS_MS }),
  ]);
  if (!logRes.ok) return logRes;
  const all = parseLog(logRes.value), truncated = all.length > lim;
  return { ok: true, value: {
    repo: v.value, head: headRes.ok ? headRes.value.trim() || null : null, branch: branchRes.ok ? branchRes.value.trim() || null : null,
    mainRef, latestLocal, scope, limit: lim, truncated, commits: truncated ? all.slice(0, lim) : all, refs,
  } };
}

export async function readStatus(repo: string): Promise<GitResult<GitStatus>> {
  const v = await validateRepo(repo);
  if (!v.ok) return v;
  const r = await runGit(v.value, ["status", "--porcelain=v1", "-z", "--branch", "--ignore-submodules=all"], { timeoutMs: STATUS_MS });
  return r.ok ? { ok: true, value: parseStatus(r.value, v.value) } : r;
}

export async function readCommit(repo: string, sha: string): Promise<GitResult<GitCommitDetail>> {
  if (typeof sha !== "string" || !/^[0-9a-f]{7,40}$/.test(sha)) return { ok: false, reason: "invalid commit id" };
  const v = await validateRepo(repo);
  if (!v.ok) return v;
  const [meta, stats] = await Promise.all([
    runGit(v.value, ["show", "--no-ext-diff", "--no-textconv", "-s", "--format=%H%x00%P%x00%an%x00%at%x00%ct%x00%s%x00%b", sha, "--"]),
    runGit(v.value, ["show", "--no-ext-diff", "--no-textconv", "--numstat", "--format=", "-z", sha, "--"]),
  ]);
  if (!meta.ok) return meta;
  if (!stats.ok) return stats;
  const f = meta.value.split("\0");
  if (f.length < 6 || !/^[0-9a-f]{40}$/.test(f[0])) return { ok: false, reason: "unexpected git output" };
  const files = parseNumstat(stats.value);
  const ms = (s: string) => { const n = Number(s); return Number.isFinite(n) ? n * 1000 : 0; };
  return { ok: true, value: {
    sha: f[0], parents: f[1] ? f[1].split(" ").filter(Boolean) : [], author: f[2], authoredAt: ms(f[3]), committedAt: ms(f[4]), subject: f[5],
    body: f.slice(6).join("\0").trim(), files: files.slice(0, FILE_CAP), filesTruncated: files.length > FILE_CAP,
  } };
}

/** Repo-relative path safe to hand to git as a pathspec after `--`: no NUL, no leading "-", no absolute, no ".." segment. */
export const isSafeRelPath = (p: unknown): p is string =>
  typeof p === "string" && p.length > 0 && p.length <= 4096 && !p.includes("\0") && !p.startsWith("-") && !p.startsWith("/") && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes("..");

/** Old path when `path` was the destination of a rename in `sha` (first-parent view), else null. A pathspec-limited
 * `show` cannot see the rename source, so it is looked up first from the (tiny) name-status list. */
function renameSource(nameStatusZ: string, path: string): string | null {
  const f = nameStatusZ.split("\0");
  for (let i = 0; i < f.length; i++) {
    const st = f[i];
    if (!st) continue;
    if (st[0] === "R" || st[0] === "C") { if (f[i + 2] === path) return f[i + 1] || null; i += 2; } else i += 1;
  }
  return null;
}

/** One file's unified diff in one commit, capped (see git-diff.ts). Merge commits are shown against their FIRST parent
 * (what the merge brought in). If git's output for the file exceeds the 4 MiB read bound the read fails ("git output
 * exceeded the size bound") rather than returning a partial parse. */
export async function readFileDiff(repo: string, sha: string, path: string): Promise<GitResult<FileDiff>> {
  if (typeof sha !== "string" || !/^[0-9a-f]{7,40}$/.test(sha)) return { ok: false, reason: "invalid commit id" };
  if (!isSafeRelPath(path)) return { ok: false, reason: "invalid file path" };
  const v = await validateRepo(repo);
  if (!v.ok) return v;
  const base = ["show", "--no-ext-diff", "--no-textconv", "--no-color", "--first-parent", "--format=", "-M"];
  const ns = await runGit(v.value, [...base, "--name-status", "-z", sha, "--"]);
  if (!ns.ok) return ns;
  const from = renameSource(ns.value, path);
  const r = await runGit(v.value, [...base, "--patch", sha, "--", path, ...(from && isSafeRelPath(from) ? [from] : [])]);
  return r.ok ? { ok: true, value: parseFileDiff(r.value, path) } : r;
}

const MENTION_FETCH = 500;
/** Commits (any ref, newest first) whose message mentions thread `id` (W-NNN) as a whole token: git's fixed-string grep
 * is a substring match, so W-1 would also hit W-12; the body is re-checked here. No network, no writes. */
export async function readMentions(repo: string, id: string, limit = 50): Promise<GitResult<CommitMention[]>> {
  if (typeof id !== "string" || !/^W-\d{1,6}$/.test(id)) return { ok: false, reason: "invalid thread id" };
  const v = await validateRepo(repo);
  if (!v.ok) return v;
  const lim = Math.min(200, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50));
  const r = await runGit(v.value, ["log", "--no-ext-diff", "--no-textconv", "--exclude=refs/stash", "--all", "--fixed-strings", `--grep=${id}`, "-n", String(MENTION_FETCH), "--format=%H%x00%B%x00%an%x00%ct%x1e", "--"]);
  if (!r.ok) return r;
  const word = new RegExp(`(?<![A-Za-z0-9])${id}(?!\\d)`);
  const out: CommitMention[] = [];
  for (const rec of r.value.split("\x1e")) {
    const f = rec.replace(/^\n+/, "").split("\0");
    if (f.length < 4 || !/^[0-9a-f]{40}$/.test(f[0]) || !word.test(f[1])) continue;
    const ct = Number(f[3]);
    out.push({ sha: f[0], subject: f[1].split("\n")[0].trim(), author: f[2], committedAt: Number.isFinite(ct) ? ct * 1000 : 0 });
    if (out.length >= lim) break;
  }
  return { ok: true, value: out };
}

// ---- Day reads (W-197 Git + Calendar). Day boundaries are LOCAL time of the host running this server (the BB host). ----
const pad = (n: number) => String(n).padStart(2, "0");
const localKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** ISO-8601 local time with numeric offset, e.g. 2026-10-06T00:00:00+08:00 (git approxidate understands it). */
function isoLocal(d: Date): string {
  const off = -d.getTimezoneOffset(), a = Math.abs(off);
  return `${localKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off < 0 ? "-" : "+"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
const startOfDay = (y: number, m: number, d: number) => new Date(y, m, d, 0, 0, 0, 0);

export const DAY_COUNT_CAP = 20000;
// --since-as-filter (not --since): plain --since STOPS walking at the first too-old commit, so a rebased or clock-skewed
// history (non-monotonic dates) silently loses commits. The filter form keeps walking; it costs a full-history walk, hence the longer timeout.
const DAY_TIMEOUT_MS = 15000;
const MIN_DAYS = 7, MAX_DAYS = 366, DEFAULT_DAYS = 84;
const DAY_MIN_LIMIT = 1, DAY_MAX_LIMIT = 2000, DAY_DEFAULT_LIMIT = 1000;

/** Commits per local calendar day over the last `days` days (clamped 7..366, today included), all refs except stash.
 * Bounded: at most `cap` (default 20000) commits are read; `truncated` means older days may be undercounted.
 * Git's --since uses the COMMITTER date, so a commit is counted on the local day of its committer timestamp. */
export async function readDayCounts(repo: string, days = DEFAULT_DAYS, now = Date.now(), cap = DAY_COUNT_CAP): Promise<GitResult<DayCounts>> {
  const v = await validateRepo(repo);
  if (!v.ok) return v;
  const n = Math.min(MAX_DAYS, Math.max(MIN_DAYS, Number.isFinite(days) ? Math.floor(days) : DEFAULT_DAYS));
  const today = new Date(Number.isFinite(now) ? now : Date.now());
  const start = startOfDay(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1));
  const from = localKey(start), to = localKey(today);
  // One second early: git's --since boundary is not guaranteed inclusive; the bucket filter below is the authority.
  const r = await runGit(v.value, ["log", "--no-ext-diff", "--no-textconv", "--exclude=refs/stash", "--all", `--since-as-filter=${isoLocal(new Date(start.getTime() - 1000))}`, "--format=%ct", "-n", String(cap + 1), "--"], { timeoutMs: DAY_TIMEOUT_MS });
  if (!r.ok) return r;
  const lines = r.value.split("\n").filter(Boolean), truncated = lines.length > cap;
  const counts: Record<string, number> = {};
  let total = 0;
  for (const line of truncated ? lines.slice(0, cap) : lines) {
    const t = Number(line);
    if (!Number.isFinite(t)) continue;
    const key = localKey(new Date(t * 1000));
    if (key < from || key > to) continue;
    counts[key] = (counts[key] ?? 0) + 1; total++;
  }
  return { ok: true, value: { repo: v.value, from, to, days: n, counts, total, truncated } };
}

/** One local day's commits (all refs except stash), newest-topology first, each with the ref it was reached by.
 * `date` is YYYY-MM-DD in the host's local time zone. Day membership is by COMMITTER date (what git --since/--until use). */
export async function readDayCommits(repo: string, date: string, limit = DAY_DEFAULT_LIMIT): Promise<GitResult<DayCommits>> {
  const m = typeof date === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!m) return { ok: false, reason: "invalid date" };
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const start = startOfDay(y, mo, d), end = startOfDay(y, mo, d + 1);
  if (start.getFullYear() !== y || start.getMonth() !== mo || start.getDate() !== d) return { ok: false, reason: "invalid date" };
  const v = await validateRepo(repo);
  if (!v.ok) return v;
  const lim = Math.min(DAY_MAX_LIMIT, Math.max(DAY_MIN_LIMIT, Number.isFinite(limit) ? Math.floor(limit) : DAY_DEFAULT_LIMIT));
  const r = await runGit(v.value, ["log", "--no-ext-diff", "--no-textconv", "--exclude=refs/stash", "--all", "--source", `--since-as-filter=${isoLocal(new Date(start.getTime() - 1000))}`, `--until=${isoLocal(new Date(end.getTime() + 1000))}`, "--topo-order", "-n", String(lim + 1), `--format=${DAY_LOG_FORMAT}`, "--"], { timeoutMs: DAY_TIMEOUT_MS });
  if (!r.ok) return r;
  const all = parseDayLog(r.value).filter(c => c.committedAt >= start.getTime() && c.committedAt < end.getTime());
  const truncated = all.length > lim;
  return { ok: true, value: { repo: v.value, date, commits: truncated ? all.slice(0, lim) : all, truncated, limit: lim } };
}

const PATCH_MAX_BYTES = 1024 * 1024;
/** One commit as a mailbox-style patch (header + diff), for the menu's "Copy as Patch". READ-ONLY: `show` is on the allowlist, the text
 * is only returned (the UI puts it on the clipboard), nothing is written. Merges are shown against their FIRST parent. Bounded to 1 MiB:
 * over that the read fails with git's size-bound reason instead of returning a cut-off patch. */
export async function readCommitPatch(repo: string, sha: string): Promise<GitResult<string>> {
  if (typeof sha !== "string" || !/^[0-9a-f]{7,40}$/.test(sha)) return { ok: false, reason: "invalid commit id" };
  const v = await validateRepo(repo);
  if (!v.ok) return v;
  return runGit(v.value, ["show", "--no-ext-diff", "--no-textconv", "--no-color", "--first-parent", "--format=email", "--patch", sha, "--"], { maxBytes: PATCH_MAX_BYTES });
}

// ---- Working tree reads (History > Working tree). Read-only: `diff` and one bounded file read; nothing is staged, written or fetched. ----
export type WorktreeArea = "staged" | "unstaged" | "untracked";
const UNTRACKED_MAX_BYTES = 1024 * 1024;
const DIFF_ARGS = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];

/** Per-file +/- counts of the index (staged) and of the worktree (unstaged), from `diff --numstat`. Untracked files have no counts. */
export async function readWorktreeStats(repo: string): Promise<GitResult<{ staged: GitFileStat[]; unstaged: GitFileStat[] }>> {
  const v = await validateRepo(repo);
  if (!v.ok) return v;
  const [staged, unstaged] = await Promise.all([
    runGit(v.value, [...DIFF_ARGS, "--cached", "--numstat", "-z", "-M", "--"], { timeoutMs: STATUS_MS }),
    runGit(v.value, [...DIFF_ARGS, "--numstat", "-z", "--"], { timeoutMs: STATUS_MS }),
  ]);
  if (!staged.ok) return staged;
  if (!unstaged.ok) return unstaged;
  return { ok: true, value: { staged: parseNumstat(staged.value).slice(0, FILE_CAP), unstaged: parseNumstat(unstaged.value).slice(0, FILE_CAP) } };
}

/** One file's unified diff in the working tree. staged = index vs HEAD; unstaged = worktree vs index; untracked = a synthetic all-added diff built
 * from a bounded read of the file (text only; refused when it is a symlink, not a regular file, or resolves outside the repo). `git diff --no-index`
 * is never used (it takes two arbitrary paths). Returns the same FileDiff shape as readFileDiff, so the client viewer does not change. */
export async function readWorktreeDiff(repo: string, path: string, area: WorktreeArea): Promise<GitResult<FileDiff>> {
  if (area !== "staged" && area !== "unstaged" && area !== "untracked") return { ok: false, reason: "invalid area" };
  if (!isSafeRelPath(path)) return { ok: false, reason: "invalid file path" };
  const v = await validateRepo(repo);
  if (!v.ok) return v;
  if (area !== "untracked") {
    const r = await runGit(v.value, [...DIFF_ARGS, ...(area === "staged" ? ["--cached", "-M"] : []), "--", path]);
    return r.ok ? { ok: true, value: parseFileDiff(r.value, path) } : r;
  }
  const full = join(v.value, path);
  try {
    const l = await lstat(full);
    if (l.isSymbolicLink() || !l.isFile()) return { ok: false, reason: "not a regular file" };
    if (l.size > UNTRACKED_MAX_BYTES) return { ok: false, reason: "file is larger than the read bound" };
    const real = await realpath(full);
    // v.value is taken as already real; a symlinked repo root would fail CLOSED here ("outside the repository"), never open.
    if (!real.startsWith(v.value + sep)) return { ok: false, reason: "path is outside the repository" };
    const fh = await open(real, "r");
    let buf: Buffer;
    try { const got = await fh.read(Buffer.alloc(l.size), 0, l.size, 0); buf = got.buffer.subarray(0, got.bytesRead); } finally { await fh.close(); }
    if (buf.includes(0)) return { ok: true, value: parseFileDiff(`diff --git a/${path} b/${path}\nnew file mode 100644\nBinary files /dev/null and b/${path} differ\n`, path) };
    const text = buf.toString("utf8");
    if (text === "") return { ok: true, value: parseFileDiff(`diff --git a/${path} b/${path}\nnew file mode 100644\n`, path) };
    const lines = text.split("\n"), endsNl = lines[lines.length - 1] === "";
    if (endsNl) lines.pop();
    const body = lines.map(x => `+${x}`).join("\n") + (endsNl ? "" : "\n\\ No newline at end of file") + "\n";
    return { ok: true, value: parseFileDiff(`diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}`, path) };
  } catch { return { ok: false, reason: "could not read the file" }; }
}
