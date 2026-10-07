// Health rework (owner +01:16) — the shared contract between the read-only repo reader (health-feed.ts), the pure row model
// (health-model.ts, health-trend.ts) and the view (components/health-view.tsx). Generic by construction: repo-level git
// facts and spine-file checks only; nothing here knows a particular repo, person or path.

/** Cheap probe the client polls so the view can refresh the moment HEAD moves. */
export type HeadInfo = { head: string; branch: string };

/** Read-only repo facts for the Health view. Every list is bounded; a `capped` flag says a count stopped at its bound. */
export type RepoHealth = {
  head: string; branch: string;
  /** Commits on HEAD that the spine index has not seen (`<indexHead>..HEAD`). null when no index head was given or it is
   * unknown to this repo (rewritten history, wrong repo). */
  behind: { indexHead: string; count: number; capped: boolean } | null;
  /** Commits on HEAD reachable from no remote-tracking ref (`HEAD --not --remotes`); works without an upstream. */
  unpushed: { count: number; capped: boolean };
  /** Working-tree state from `status`: counts plus the first few paths (repo-relative) for the inspector. */
  uncommitted: { staged: number; unstaged: number; untracked: number; sample: string[] };
  /** Local branches with commits on no remote, newest first; `count` is that branch's own commits on no remote (capped), so branches that share commits each list them. */
  unremoted: { branch: string; count: number }[];
  unremotedCapped: boolean;
  /** Distinct commits on no remote across all branches (a commit shared by two branches counts once); capped like the others. */
  unremotedCommits?: number;
  /** Linked worktrees (the main checkout excluded). `missing`: its directory is gone (prunable). `lastCommitAt`: epoch ms of
   * its HEAD commit, null when unreadable. */
  worktrees: { path: string; branch: string | null; missing: boolean; locked: boolean; lastCommitAt: number | null }[];
  /** All linked worktrees found; `worktrees` holds at most the first 200 (by admin-dir name). */
  worktreeTotal?: number;
  /** Newest commit on HEAD whose subject matches the wrap pattern (default WRAP in health-feed.ts: a wrap commit, not a mention): the "since last wrap" anchor. */
  wrap: { sha: string; at: number; subject: string } | null;
};

/** What the view needs from the Herdr capture (already polled by the app); null when the capture is unavailable. */
export type AgentFeed = {
  capturedAt: number | null; stale: boolean; available: boolean;
  /** Recorded calls, metadata only. */
  calls: { sessionId: string; status: string; startedAt: number | null; endedAt: number | null }[];
};

/** `unknown` = the model cannot tell (no fresh capture): it needs a look and is NEVER counted as a pass. */
export type RowStatus = "pass" | "unknown" | "warn" | "fail";
/** blocker = something the owner acts on (git, agents, decisions, debt, capture); hygiene = doc-spine checks. Blockers
 * always render first. */
export type HealthRowGroup = "blocker" | "hygiene";
export type HealthFix = { label: string; command?: string };
export type Trend = { delta: number; direction: "better" | "worse" | "same"; since: string };
export type HealthRow = {
  /** Stable id: `git:unpushed`, `git:uncommitted`, `git:unremoted`, `git:worktrees`, `git:behind`, `agents`,
   * `owner-decisions`, `tech-debt`, `herdr:capture`, or `spine:<check>` for producer checks. */
  id: string; group: HealthRowGroup; status: RowStatus;
  title: string;
  /** Lead figure, multiple first when over a limit ("17× limit · 2,539 lines"). */
  figure: string;
  /** One line: why this matters. Empty for passes. */
  why: string;
  fix: HealthFix | null;
  /** value/limit when the row has both, for the log-scale bar. */
  ratio?: number;
  /** The number the trend compares (lower is better for every row). */
  metric?: number;
  detail?: string;
  trend?: Trend | null;
};

/** One observation of every row's metric, kept per repo in the viewer's own browser storage (bounded). */
export type HealthSnapshot = { at: number; figures: Record<string, number> };
