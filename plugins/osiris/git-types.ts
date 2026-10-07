// Shared contract between the READ-ONLY git reader (plugin server, git-feed.ts) and the Work graph / Changes / Overview UI.
// Every field is recorded by git itself; nothing here is inferred. Author e-mail is deliberately not carried.
export type GitRepoSource = "bb-project" | "scan" | "user";
export type GitRepo = { path: string; name: string; source: GitRepoSource; branch: string | null; head: string | null; dirty: number | null };
export type GitRefKind = "local" | "remote" | "tag" | "head";
export type GitRef = { name: string; kind: GitRefKind; sha: string; committedAt: number | null };
/** committedAt/authoredAt are epoch ms. refs = names of refs that point at this commit (short form, e.g. "main", "origin/main"). */
/** A commit trailer the reader asked git for (git-graph.ts TRAILER_KEYS); values are untrusted text. */
export type GitTrailer = { key: string; value: string };
export type GitCommit = { sha: string; parents: string[]; author: string; authoredAt: number; committedAt: number; subject: string; refs: string[]; /** Only the trailers named in TRAILER_KEYS; absent when the commit has none. */ trailers?: GitTrailer[] };
export type GitScope = "all" | "main";
/** limit = the hard bound requested; truncated = git had more commits than the bound. latestLocal = the local branch with
 * the newest commit ("what is in dev"), from for-each-ref --sort=-committerdate refs/heads. mainRef = the trunk used for
 * scope "main" (main, else master, else null). */
export type GitGraph = { repo: string; head: string | null; branch: string | null; mainRef: string | null; latestLocal: string | null; scope: GitScope; limit: number; truncated: boolean; commits: GitCommit[]; refs: GitRef[] };
/** One porcelain v1 entry: x = index status, y = worktree status ("?" for untracked). */
export type GitStatusEntry = { path: string; x: string; y: string; origPath?: string };
export type GitStatus = { repo: string; branch: string | null; upstream: string | null; ahead: number | null; behind: number | null; entries: GitStatusEntry[]; truncated: boolean };
/** additions/deletions null for binary files (numstat "-"). */
export type GitFileStat = { path: string; additions: number | null; deletions: number | null; binary: boolean };
export type GitCommitDetail = { sha: string; parents: string[]; author: string; authoredAt: number; committedAt: number; subject: string; body: string; files: GitFileStat[]; filesTruncated: boolean };
export type GitResult<T> = { ok: true; value: T } | { ok: false; reason: string };
/** One rendered graph row from the pure lane layout. lane/color are indices; edges connect this row's lanes to the next
 * row's lanes (from -> to). kind "straight" continues a lane, "merge" joins a second parent, "fork" starts a branch. */
export type LaneEdge = { from: number; to: number; color: number; kind: "straight" | "merge" | "fork" };
/** clamped = this row's commit or an edge sat beyond the visible lane cap and was folded into the last column (capLanes). */
export type LaneRow = { sha: string; lane: number; color: number; /** Branch name the commit's lane carries (a ref in the window), when known. */ branch?: string; edges: LaneEdge[]; width: number; clamped?: boolean };
/** Unified diff of ONE file in one commit, fetched only when the user expands that file (owner 01:08). Capped per file
 * (research L: 400 lines / 64 KB); `truncated` + `omittedLines` say how much was not shown. Binary, rename-only and
 * mode-only changes carry no hunks and are labelled by `kind`. */
export type DiffLineKind = "ctx" | "add" | "del";
export type DiffLine = { kind: DiffLineKind; text: string; oldNo: number | null; newNo: number | null; noNewlineAtEof?: boolean };
export type DiffHunk = { header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; section: string; lines: DiffLine[] };
export type FileDiffKind = "text" | "binary" | "mode-only" | "rename-only" | "empty";
export type FileDiff = { path: string; oldPath: string | null; kind: FileDiffKind; oldMode: string | null; newMode: string | null; hunks: DiffHunk[]; truncated: boolean; omittedLines: number };
/** A commit whose subject or body mentions a W-NNN thread id (git log --grep, fixed string, read-only). */
export type CommitMention = { sha: string; subject: string; author: string; committedAt: number };
/** Commits per LOCAL calendar day of the BB host (W-197 Git + Calendar). counts holds only days with commits; a missing
 * day is 0 within [from, to]. truncated = the bounded read hit its cap, so older days in range may be undercounted. */
export type DayCounts = { repo: string; from: string; to: string; days: number; counts: Record<string, number>; total: number; truncated: boolean };
/** A commit of one day, with the ref it was reached by (git log --source) for grouping by branch. */
export type DayCommit = GitCommit & { source: string | null };
export type DayCommits = { repo: string; date: string; commits: DayCommit[]; truncated: boolean; limit: number };
/** One markdown section of a spine doc (decision, log/wave entry), addressed by "path#Lnnn" from the spine index. */
export type DocSection = { path: string; line: number; heading: string; text: string; truncated: boolean; shas: string[] };
