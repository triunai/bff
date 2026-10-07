// Read-only git for `osiris worktrees`. Every call goes through `guarded`, which refuses any argv that is not one of the exact read
// shapes below (status, log -n 5, worktree list, diff --stat, and diff --no-color -- <a file inside the worktree>), so the app can not run a mutating git command even by a future edit to the collector: the spy test pins it.
// status/log reuse git-feed's hardened runGit (execFile, shell:false, fixed env); `worktree list` is the one read runGit does not carry, so it
// gets its own tiny call here through the same spawnGit with the SAME hardening args and env (no change to git-feed's allowlist).
import { lstat, open, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { discoverRepos, HARDEN_ARGS, runGit, spawnGit } from "../git-feed.ts";
import { LOG_FORMAT, parseLog, parseStatus } from "../git-graph.ts";
import type { GitResult } from "../git-types.ts";
import { parseWorktreeList, WORKTREE_LIST_ARGS } from "../work/git-worktree-probe.ts";
import { beadOf, type WtDiffKey, type WtFileDiff, type WtRow } from "./worktrees-model.ts";

export type ReadGit = (cwd: string, args: string[]) => Promise<GitResult<string>>;
export const STATUS_READ: readonly string[] = Object.freeze(["status", "--porcelain=v1", "-z", "--branch", "--ignore-submodules=all"]);
export const LOG_READ: readonly string[] = Object.freeze(["log", "-n", "5", `--format=${LOG_FORMAT}`]);
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
export const DIFF_STAT_READ: readonly string[] = Object.freeze(["diff", "--stat"]);
export const DIFF_FILE_PREFIX: readonly string[] = Object.freeze(["diff", "--no-color", "--"]);
/** The one argv that reads a file's diff. */
export const diffFileArgv = (file: string): string[] => [...DIFF_FILE_PREFIX, file];
/** A file argument is a RELATIVE path that stays inside the worktree: no NUL or newline, no absolute path, no `..` segment, and (with a cwd) its resolved
 * path is under that cwd. After `--` git reads it as a path, and the runner sets GIT_LITERAL_PATHSPECS=1 so it is never a glob or :(magic) either. */
export function isInsideWorktree(file: string, cwd?: string): boolean {
  if (typeof file !== "string" || !file || file.length > 1024 || /[\0\n\r]/.test(file) || isAbsolute(file)) return false;
  if (file.split("/").some(seg => seg === ".." || seg === "")) return false;
  return cwd === undefined || resolve(cwd, file).startsWith(`${resolve(cwd)}${sep}`);
}
/** A commit's stat + patch: `show` with every external-program option off, and a full hex object id (never a ref, never a path). */
export const SHOW_PREFIX: readonly string[] = Object.freeze(["show", "--no-color", "--no-ext-diff", "--no-textconv", "--stat", "--patch", "--end-of-options"]);
/** A FULL 40-hex id peeled with `^{commit}`: a short hex can be shadowed by a hex-named ref (git warns and takes the ref), a full id cannot. */
export const showArgv = (sha: string): string[] => [...SHOW_PREFIX, `${sha}^{commit}`];
const isShowArgv = (args: readonly string[]) => args.length === SHOW_PREFIX.length + 1 && same(args.slice(0, SHOW_PREFIX.length), SHOW_PREFIX) && /^[0-9a-f]{40}\^\{commit\}$/.test(args[SHOW_PREFIX.length]);
const isDiffFileArgv = (args: readonly string[], cwd?: string) => args.length === DIFF_FILE_PREFIX.length + 1 && same(args.slice(0, DIFF_FILE_PREFIX.length), DIFF_FILE_PREFIX) && isInsideWorktree(args[DIFF_FILE_PREFIX.length], cwd);
/** True only for the exact argv shapes this app issues (`log -n 5` feeds the tip commit AND the detail pane's last five). Never `--no-index`, never any
 * other diff option, never a path outside the worktree. */
export const isReadArgv = (args: readonly string[], cwd?: string): boolean => same(args, WORKTREE_LIST_ARGS) || same(args, STATUS_READ) || same(args, LOG_READ) || same(args, DIFF_STAT_READ) || isDiffFileArgv(args, cwd) || isShowArgv(args);

/** Wrap any runner so a non-read argv is refused before it reaches the runner. */
export const guarded = (inner: ReadGit): ReadGit => (cwd, args) => (isReadArgv(args, cwd) ? inner(cwd, args) : Promise.resolve({ ok: false, reason: "git subcommand not permitted (worktrees is read-only)" }));

const listWorktrees = async (cwd: string): Promise<GitResult<string>> => {
  const r = await spawnGit(["-C", cwd, "--no-optional-locks", ...HARDEN_ARGS, ...WORKTREE_LIST_ARGS], { timeoutMs: 5000, maxBytes: 1 << 20 });
  return r.kind === "exit" && r.code === 0 ? { ok: true, value: r.stdout } : { ok: false, reason: "git worktree list failed" };
};
/** Diffs are the one read with unbounded output, so they get their own runner (same hardening as git-feed's runGit) and a hard size bound: output past it is
 * CUT and marked, not failed, so a huge diff still shows its head. */
export const DIFF_MAX_BYTES = 256 * 1024;
/** HARDEN_ARGS sets `diff.external=` (empty) to switch an external diff off, but git then tries to RUN the empty program for `git diff`; so for a diff the
 * runner drops that one pair and turns external diff and textconv off with their flags instead (inserted after the verb, so the argv the guard saw is unchanged). */
const diffHardening = (): string[] => HARDEN_ARGS.filter((a, i, all) => a !== "diff.external=" && all[i + 1] !== "diff.external=");
const diffArgs = (args: string[]): string[] => [args[0], ...["--no-ext-diff", "--no-textconv"].filter(f => !args.includes(f)), ...args.slice(1)];
const runDiff = async (cwd: string, args: string[]): Promise<GitResult<string>> => {
  const r = await spawnGit(["-C", cwd, "--no-optional-locks", ...diffHardening(), ...diffArgs(args)], { timeoutMs: 5000, maxBytes: DIFF_MAX_BYTES });
  if (r.kind === "exit" && r.code === 0) return { ok: true, value: r.stdout };
  if (r.kind === "overflow") return { ok: true, value: `${r.stdout}\n… output cut at ${DIFF_MAX_BYTES / 1024} KB` };
  return { ok: false, reason: "git diff failed" };
};
export const realGit: ReadGit = guarded((cwd, args) => (args[0] === "worktree" ? listWorktrees(cwd) : args[0] === "diff" || args[0] === "show" ? runDiff(cwd, args) : runGit(cwd, args, { timeoutMs: 5000 })));

/** `git diff --stat` text -> the per-file `N +++---` tails and the summary line. Paths git abbreviates (`.../x`) are matched by suffix. */
export function parseStat(text: string): { files: { path: string; tail: string }[]; summary: string } {
  const files: { path: string; tail: string }[] = []; let summary = "";
  for (const l of text.split("\n")) {
    const m = /^ (.+?)\s+\|\s+(.*\S)\s*$/.exec(l);
    if (m) files.push({ path: m[1].replace(/^\.\.\./, ""), tail: m[2] }); else if (/ files? changed/.test(l)) summary = l.trim();
  }
  return { files, summary };
}
/** The diff of one changed file (or one recent commit's stat + patch via `git show`): `git diff --no-color -- <file>` for a tracked file; for an untracked one the head of its content (bounded, binary refused,
 * a symlink is named never followed). A staged-only change has no unstaged diff, which is said, not hidden. */
export async function readDiff(git: ReadGit, row: Pick<WtRow, "path" | "files" | "commits">, key: WtDiffKey): Promise<WtFileDiff> {
  const base = { path: row.path, file: key.file, sha: key.sha };
  if (key.sha !== undefined) {
    if (!row.commits.some(c => c.sha === key.sha)) return { ...base, lines: [], note: "not a recent commit of this worktree" };
    const r = await git(row.path, showArgv(key.sha));
    return r.ok ? { ...base, lines: r.value.split("\n") } : { ...base, lines: [], note: r.reason };
  }
  const file = key.file ?? "", f = row.files.find(x => x.path === file);
  if (!f || !isInsideWorktree(file.replace(/\/$/, ""), row.path)) return { ...base, lines: [], note: "not a changed file of this worktree" };
  if (f.code === "??") return { ...base, ...(await readUntrackedHead(row.path, file)) };
  const r = await git(row.path, diffFileArgv(file));
  if (!r.ok) return { ...base, lines: [], note: r.reason };
  return { ...base, lines: r.value ? r.value.split("\n") : [], note: r.value ? undefined : "no unstaged changes in this file (it is staged: git diff --cached)" };
}
export const UNTRACKED_HEAD_BYTES = 8192, UNTRACKED_HEAD_LINES = 80;
async function readUntrackedHead(wt: string, file: string): Promise<Pick<WtFileDiff, "lines" | "note">> {
  if (file.endsWith("/")) return { lines: [], note: "untracked directory" };
  const p = resolve(wt, file);
  try {
    const st = await lstat(p);
    if (st.isSymbolicLink()) return { lines: [], note: `untracked symlink -> ${await readlink(p)}` };
    if (!st.isFile()) return { lines: [], note: "untracked, not a regular file" };
    const h = await open(p, "r");
    try {
      const buf = Buffer.alloc(Math.min(UNTRACKED_HEAD_BYTES, st.size)), { bytesRead } = await h.read(buf, 0, buf.length, 0), head = buf.subarray(0, bytesRead);
      if (head.includes(0)) return { lines: [], note: `untracked binary file (${st.size} bytes)` };
      const all = head.toString("utf8").split("\n"), cut = all.length > UNTRACKED_HEAD_LINES || st.size > bytesRead;
      return { lines: [`untracked: the first ${Math.min(all.length, UNTRACKED_HEAD_LINES)} lines of ${file}`, ...all.slice(0, UNTRACKED_HEAD_LINES).map(x => `+${x}`), ...(cut ? ["… (rest of the file not shown)"] : [])] };
    } finally { await h.close(); }
  } catch { return { lines: [], note: "untracked file unreadable" }; }
}

/** A pane (from the work feed's bdi join) whose cwd is a worktree: its pane id is the agent on that worktree. */
export type PaneAt = { cwd: string; label: string };
const agentOn = (path: string, panes: readonly PaneAt[]): string | null => panes.find(p => p.cwd === path || p.cwd.startsWith(`${path}/`))?.label ?? null;

/** Every worktree of the repo at `repo` (the first entry git lists is the main worktree), with status, tip commit and the linked bead. */
export async function collectRepo(repo: string, git: ReadGit, panes: readonly PaneAt[] = []): Promise<WtRow[]> {
  const l = await git(repo, [...WORKTREE_LIST_ARGS]);
  if (!l.ok) return [];
  const list = parseWorktreeList(l.value), main = list[0]?.path ?? repo;
  return Promise.all(list.map(async (w, i): Promise<WtRow> => {
    const [st, lg] = await Promise.all([git(w.path, [...STATUS_READ]), git(w.path, [...LOG_READ])]);
    const s = st.ok ? parseStatus(st.value) : null, stat = s && s.entries.length ? await git(w.path, [...DIFF_STAT_READ]) : null, cs = lg.ok ? parseLog(lg.value) : [], c = cs[0];
    return { repo: main, path: w.path, name: w.path.split("/").filter(Boolean).pop() ?? w.path, branch: s?.branch ?? w.branch, upstream: s?.upstream ?? null, ahead: s?.ahead ?? null, behind: s?.behind ?? null,
      dirty: s ? s.entries.length : null, lastAt: c?.committedAt ?? null, subject: c?.subject ?? null, bead: beadOf(s?.branch ?? w.branch, c?.trailers), agent: agentOn(w.path, panes), main: i === 0,
      files: (s?.entries ?? []).map(e => ({ code: `${e.x === " " ? "" : e.x}${e.y === " " ? "" : e.y}` || "··", path: e.path })), commits: cs.map(x => ({ sha: x.sha, at: x.committedAt, subject: x.subject })), beadTitle: null, stat: stat?.ok ? parseStat(stat.value) : null };
  }));
}
/** The current repo, or with `all` every repo Osiris discovers (git-feed's own ~/Repos scan); a worktree already listed under another repo is skipped. */
export async function collectAll(repo: string, all: boolean, git: ReadGit, panes: readonly PaneAt[] = [], home = homedir()): Promise<WtRow[]> {
  const repos = all ? [repo, ...(await discoverRepos([], home)).map(r => r.path)] : [repo], seen = new Set<string>(), rows: WtRow[] = [];
  for (const r of repos) {
    if (seen.has(r)) continue;
    for (const row of await collectRepo(r, git, panes)) if (!seen.has(row.path)) { seen.add(row.path); rows.push(row); }
  }
  return rows;
}
