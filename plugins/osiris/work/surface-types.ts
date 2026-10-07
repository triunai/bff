// Work surface contract (owner td-osi.1, 2026-10-07). ONE model, fed by two READ-ONLY sources:
//   - bdi --json (beady-eye): the Herdr pane join, anomaly rules, the tree projection, unattributed panes, conflicts;
//   - bd --readonly list --all --json (work/beads-adapter.ts): timestamps, labels, assignee, deps (bdi carries none of them).
// Osiris NEVER writes beads, with ONE exception: dispatch's claim (`bd update <id> --claim`, bd's own atomic
// compare-and-set). The agent tags its own join (`bd update <id> --set-metadata agent_pane=$HERDR_PANE_ID`, beady-eye's
// agent protocol, told to it in the prompt); Osiris only names the pane and reports Herdr display metadata.
import type { WorkDep, WorkIssue } from "./types.ts";

// ---- feed (server) ------------------------------------------------------------------------------------------------
/** beady-eye anomaly rule names, verbatim. Unknown rules pass through as strings. */
export type AnomalyRule = "orphan-claim" | "stale-pane" | "stale-claim" | (string & {});
export type PaneRef = { paneId: string; session: string | null; state: string | null; title: string | null; cwd: string | null };
/** One bead in bdi's tree (a bead appears once per path; `edge` is how it hangs under its parent row). */
export type TreeNode = { id: string; depth: number; edge: "parent-child" | "blocks" | null; ready: boolean; blockedBy: string[]; agent: PaneRef | null; anomalies: AnomalyRule[] };
export type TreeRoot = { root: string; title: string; total: number; finished: number; liveAgents: number; anomalyCount: number; nodes: TreeNode[] };
/** A live Herdr pane whose cwd is in the project but which no bead claims (bdi `unattributed`). */
export type UnattributedPane = { paneId: string; cwd: string | null; state: string | null; agent: string | null };
export type WorkSurfaceSnapshot = {
  /** "bdi": full join; "bd": bdi missing or failed, so no join/anomalies/tree (the notes say why). */
  source: "bdi" | "bd";
  generatedAt: number; // epoch ms, server clock
  repo: string;
  bdVersion: string; bdiVersion: string | null;
  issues: WorkIssue[]; deps: WorkDep[];
  tree: TreeRoot[];
  unattributed: UnattributedPane[];
  /** Pane ids claimed by more than one bead/session (bdi `conflicts`), as plain strings. */
  conflicts: string[];
  /** Epoch ms of wrap commits on HEAD (newest first, bounded): "sessions that ended" for the deferral counter. */
  wraps: number[];
  /** Degradations, plain English ("bdi is not installed: no pane join"). */
  notes: string[];
  /** True when the sandbox tracker exists and this snapshot is of another (real) tracker: the inspector suggests trying Dispatch there first. Set by the server RPC, not by the feed. */
  sandboxElsewhere?: boolean;
};
export type PaneTail = { paneId: string; lines: string[]; truncated: boolean; at: number };

// ---- surface model (pure) -----------------------------------------------------------------------------------------
export type Kpis = {
  ready: number;
  active: number; activeCap: number; activeNoPane: number;
  blocked: number; blockedOldestMs: number | null;
  review: number; reviewUrgent: number; // urgent = priority 0/1
  /** Most urgent priority (lowest number) among the review cards, or null/absent when none: the mockup's "highest P0". */
  reviewTopP?: number | null;
  stale: number;
  collision: number;
};
export type SidebarGlyph = "○" | "◐" | "✓" | "⊘";
/** One compact sidebar tree row: glyph · short id · plain short title · n/m · pane badge or warning. */
export type SidebarRow = {
  key: string; // unique per tree path
  id: string; shortId: string;
  title: string; fullTitle: string;
  glyph: SidebarGlyph; depth: number; done: number; total: number;
  pane: string | null; // short pane label when joined
  warn: string | null; // plain-English anomaly, e.g. "claimed · no pane"
  dim: boolean; // finished
};
/** `action` = "Action required": open owner decisions and CRITs (the same rule as decisionsWaiting), the FIRST lane. */
export type Lane = "action" | "ready" | "in_progress" | "review" | "blocked";
export type BeadLink = { id: string; title: string; status: string };
export type BoardCard = {
  id: string; shortId: string; title: string; lane: Lane;
  /** The lane this card would sit in without the action lane (null = none); stages and the graph side panel read this. */
  workLane: Exclude<Lane, "action"> | null;
  priority: number;
  blockedBy: BeadLink[]; unblocks: BeadLink[];
  pane: string | null; assignee: string | null; ageMs: number; labels: string[];
};
export type DecisionRow = {
  id: string; shortId: string; title: string;
  kind: "owner-decision" | "crit";
  waitingMs: number; since: string; // since = created_at (labels carry no timestamp)
  /** Wrap commits (ended sessions) since `since`: each one is a session that ended without deciding. */
  deferredSessions: number;
};
export type Wave = { index: number; ids: string[] };
export type WavePlan = { waves: Wave[]; unschedulable: string[] };
export type HistoryEvent = { at: number; id: string; kind: "created" | "started" | "closed" | "status"; from?: string; to?: string; source: "timestamps" | "observed" };

// ---- dispatch (server; the ONE write path is the claim) -----------------------------------------------------------
export type Runtime = "claude" | "codex" | "cursor-agent" | "stub";
export type PoolEntry = { runtime: Runtime; model: string; weight: number };
/** Read-only display of weighted pools per stage (Foolery agent-pool shape); cross-agent review excludes the implementer. */
export type Pools = Record<"implement" | "review", PoolEntry[]>;
/** `token` is the single-use token the PREVIEW returned; workDispatch refuses without it (server-enforced). */
export type DispatchRequest = { repo: string; beadId: string; runtime: Runtime; model: string | null; base?: string; token?: string; /** the owner ticked "I trust this repo's hooks" for the hooks the preview listed */ trustHooks?: boolean };
export type DispatchPreview = { ok: true; prompt: string; argv: string[]; branch: string; worktree: string; paneTitle: string; token?: string; /** plain names of the repo hooks that would run during dispatch, e.g. "bd on_update", "git post-checkout" (empty/absent = none) */ hooks?: string[] } | { ok: false; reason: string };
export type ClaimOutcome = { ok: true; actor: string } | { ok: false; takenBy: string | null; reason: string };
export type DispatchResult =
  | { ok: true; branch: string; worktree: string; paneId: string; actor: string }
  | { ok: false; stage: "validate" | "claim" | "worktree" | "pane" | "launch"; reason: string; takenBy?: string | null; worktree?: string; paneId?: string };
