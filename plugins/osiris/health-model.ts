// Health rework — pure model: repo facts + spine index + agent capture -> ordered rows that say what to DO (why + fix + metric).
// No React, no colours (the view decides tone by status), no I/O. Contract: health-types.ts.
import { blockersText } from "./work/needs-you.ts";
import type { AgentFeed, HealthFix, HealthRow, RepoHealth, RowStatus } from "./health-types.ts";
import { healthBar, healthFigure, type SpineHealth, type SpineIndex } from "./spine-index.ts";

const MIN = 60_000, DAY = 86_400_000;
const BLOCKER_ORDER = ["git:unpushed", "git:uncommitted", "git:unremoted", "git:worktrees", "agents", "owner-decisions", "tech-debt", "herdr:capture"];
const RANK: Record<RowStatus, number> = { fail: 0, warn: 1, unknown: 2, pass: 3 };
/** The command that starts the agent capture; the Health fix, the Herdr note and the row command all say this one string. */
export const HERDR_START_COMMAND = "bff herdr";
/** What the Health nav badge shows: every row that is not a pass (unknown included), so the board and the badge agree. */
export const needsYouCount = (rows: HealthRow[]): number => rows.filter(r => r.status !== "pass").length;
export const needsYouTitle = (count: number): string => blockersText(count);
const n = (x: number) => x.toLocaleString("en-US");
const plural = (x: number, w: string) => `${n(x)} ${w}${x === 1 ? "" : "s"}`;
/** "3+ commits" when the count stopped at its bound. */
const pluralCap = (x: number, w: string, capped: boolean) => `${n(x)}${capped ? "+" : ""} ${w}${x === 1 && !capped ? "" : "s"}`;
/** A ref name safe to paste into a shell command: no metacharacters, never an option. */
const SAFE_REF = /^[A-Za-z0-9._\/-]+$/;
const safeRef = (b: string) => SAFE_REF.test(b) && !b.startsWith("-");

/** Compact age: "45s", "12m", "10h 7m", "3d 4h". */
export function compactAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const ADVICE: Record<string, { why: string; fix: HealthFix | null }> = {
  "hot-state-size": { why: "An oversized session file costs every new session context and hides the current state.", fix: { label: "Rotate older entries into the archive and keep only the live session" } },
  "board-size": { why: "A bloated board is skimmed, not read, so parked work and blockers go unseen.", fix: { label: "Move finished threads off the board into the archive" } },
  "router-paths-resolve": { why: "A router entry pointing at a missing file sends every reader to a dead end.", fix: { label: "Fix or remove the router paths that do not resolve" } },
  "memory-mirror-drift": { why: "Memory that exists only on one machine is lost when you switch machines.", fix: { label: "Copy into the mirror" } },
  "project-log-rotation": { why: "An unrotated project log grows without bound and slows every read of it.", fix: { label: "Rotate the log into its dated archive" } },
  "vault-index-conformance": { why: "Notes that miss the index conventions cannot be found or linked from the spine.", fix: { label: "Bring the flagged notes in line with the index conventions" } },
  "calendar-sources": { why: "Some calendar sources were skipped, so the calendar may be missing events.", fix: { label: "Check the skipped sources and fix their dates or format" } },
};
export function checkAdvice(check: string, detail?: string): { why: string; fix: HealthFix | null } {
  const a = ADVICE[check];
  if (a) return { why: a.why, fix: a.fix ? { ...a.fix } : null };
  // A producer check we have no advice for: point at its detail, or say there is none and where to look.
  return { why: "Reported by the spine producer.", fix: detail === "" ? { label: "No detail from the producer; run bff spine and read its output", command: "bff spine" } : { label: "Investigate using the producer's detail" } };
}

/** Producer check id -> row title, same rule as the spine view ("hot-state-size" -> "Hot state size"). */
export const checkTitle = (c: string): string => { const s = c.replace(/[-_]+/g, " ").trim(); return s ? s[0].toUpperCase() + s.slice(1) : c; };
/** Blockers before hygiene; fail, warn, pass within a group; fixed id order within a status (stable otherwise). */
export function orderRows(rows: HealthRow[]): HealthRow[] {
  const pos = (r: HealthRow) => { const i = BLOCKER_ORDER.indexOf(r.id); return r.group === "blocker" ? (i < 0 ? BLOCKER_ORDER.length : i) : r.id === "git:behind" ? -1 : 0; };
  return rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.group === b.r.group ? 0 : a.r.group === "blocker" ? -1 : 1) || RANK[a.r.status] - RANK[b.r.status] || pos(a.r) - pos(b.r) || a.i - b.i).map(x => x.r);
}
/** The one thing to do next: the FIRST non-pass row of the ordered list. Blockers come first, so a blocker WARN beats a hygiene FAIL.
 * owner (g): what blocks the owner first; the leader's earlier contract (fail-beats-warn across groups) was wrong, review H-1 M2. */
export function topFix(rows: HealthRow[]): HealthRow | null {
  return orderRows(rows).find(r => r.status !== "pass") ?? null;
}

const mult = (x: number) => `${x < 10 ? String(Math.round(x * 10) / 10) : String(Math.round(x))}×`;

function spineRow(h: SpineHealth): HealthRow {
  const adv = checkAdvice(h.check, h.detail ?? "");
  let status: RowStatus = h.status, metric = h.value;
  if (h.check === "calendar-sources") {
    // The ONLY text parse in the model: the producer reports skipped sources solely inside `measured` ("N log + M thread-done skipped").
    let skipped = 0; for (const m of h.measured.matchAll(/(\d+)\s+[\w-]+\s+skipped/g)) skipped += Number(m[1]);
    if (status === "pass" && ((h.value ?? 0) > 0 || skipped > 0)) status = "warn"; // raise only, never lower
    metric = h.value ?? skipped;
  }
  const bar = healthBar(h), fig = healthFigure(h);
  const figure = bar && bar.ratio >= 1.5 ? `${mult(bar.ratio)} limit · ${(fig as string).split(" · ")[0]}` : fig ?? h.measured;
  const fix = adv.fix && h.check === "memory-mirror-drift" && h.detail ? { label: `${adv.fix.label} — ${h.detail}` } : adv.fix;
  const row: HealthRow = { id: `spine:${h.check}`, group: "hygiene", status, title: checkTitle(h.check), figure, why: status === "pass" ? "" : adv.why, fix: status === "pass" ? null : fix };
  if (bar) row.ratio = bar.ratio;
  if (metric !== undefined) row.metric = metric;
  if (h.detail) row.detail = h.detail;
  return row;
}

function agentRows(a: AgentFeed | null, now: number): HealthRow[] {
  const out: HealthRow[] = [];
  const age = a?.available && a.capturedAt !== null ? now - a.capturedAt : null;
  const fresh = a?.available && a.capturedAt !== null && age !== null && age <= 10 * MIN;
  if (a && !fresh) {
    // An old or missing capture proves nothing about what is running now, so it claims nothing (H-1 M4).
    out.push({ id: "agents", group: "blocker", status: "unknown", title: "Agents", figure: age === null ? "status unknown — no capture" : `status unknown — last capture ${compactAge(age)} ago`,
      why: "Agent status is not known until there is a fresh capture; see Agent capture for how to start one.", fix: null });
  } else if (a && a.capturedAt !== null) {
    const at = a.capturedAt;
    // Measured against the capture time, not now: the capture is the moment the statuses were true.
    const running = new Set(a.calls.filter(c => c.status === "running").map(c => c.sessionId));
    const recent = new Set(a.calls.filter(c => c.startedAt !== null && at - c.startedAt <= 30 * MIN).map(c => c.sessionId));
    const longRun = a.calls.filter(c => c.status === "running" && c.startedAt !== null && at - c.startedAt > 30 * MIN);
    const warn = longRun.length > 0;
    // Never claims idle or stuck: absence of output proves nothing, so only an old RUNNING call is flagged.
    out.push({ id: "agents", group: "blocker", status: warn ? "warn" : "pass", title: "Agents", figure: `${running.size} running · ${recent.size} active in the last 30 min`,
      why: warn ? "A call has been running over 30 minutes; it may be waiting on input." : "", fix: warn ? { label: "Check that session's pane" } : null, ...(warn ? { metric: longRun.length, detail: "long-running call" } : {}) });
  }
  const bad = !a?.available || age === null || age > 10 * MIN;
  out.push({ id: "herdr:capture", group: "blocker", status: bad ? "warn" : "pass", title: "Agent capture", figure: !a?.available ? "No agent capture" : age === null ? "No agent capture" : age > 10 * MIN ? `Capture is ${compactAge(age)} old` : `Captured ${compactAge(age)} ago`,
    why: bad ? "The agent rows are only as fresh as the capture." : "", fix: bad ? { label: `Run \`${HERDR_START_COMMAND}\` in a terminal to start or restart the capture`, command: HERDR_START_COMMAND } : null });
  return out;
}

export function buildHealthRows(input: { repo: RepoHealth | null; repoError?: string | null; index: SpineIndex | null; agents: AgentFeed | null; now: number }): HealthRow[] {
  const { repo, repoError, index, agents, now } = input;
  const rows: HealthRow[] = [];
  if (repoError) rows.push({ id: "git:unpushed", group: "blocker", status: "warn", title: "Repo facts", figure: "repo facts unavailable", why: "Without repo facts, unpushed or uncommitted work cannot be checked.", fix: null, detail: repoError });
  else if (repo) {
    const u = repo.unpushed, branch = repo.branch;
    rows.push({ id: "git:unpushed", group: "blocker", status: u.count > 0 ? "warn" : "pass", title: "Unpushed commits", figure: u.count > 0 ? `${plural(u.count, "commit")} not on any remote${u.capped ? "+" : ""}` : "everything is on a remote",
      why: u.count > 0 ? "These commits exist only on this machine and are lost if it is." : "", fix: u.count > 0 ? (branch === "HEAD" ? { label: "Detached HEAD: create or switch to a branch before pushing" } : safeRef(branch) ? { label: `Push ${branch} (explicit refspec)`, command: `git push origin HEAD:${branch}` } : { label: "Push this branch to a remote (its name has shell-special characters, so no command is offered)" }) : null, metric: u.count });
    const c = repo.uncommitted, tot = c.staged + c.unstaged + c.untracked;
    rows.push({ id: "git:uncommitted", group: "blocker", status: tot > 0 ? "warn" : "pass", title: "Uncommitted changes",
      figure: tot > 0 ? ([[c.staged, "staged"], [c.unstaged, "modified"], [c.untracked, "untracked"]] as const).filter(p => p[0] > 0).map(p => `${n(p[0])} ${p[1]}`).join(" · ") : "working tree is clean",
      why: tot > 0 ? "Uncommitted work is not saved anywhere else and can be overwritten." : "", fix: tot > 0 ? { label: "Review the changes", command: "git status --short" } : null, metric: tot, ...(c.sample.length ? { detail: c.sample.join(", ") } : {}) });
    const ub = repo.unremoted, uc = repo.unremotedCommits ?? ub.reduce((s, b) => s + b.count, 0);
    // Never a silent pass while the distinct count says work is on no remote, even if no branch could be named (H-2 N1).
    const anyU = ub.length > 0 || uc > 0;
    rows.push({ id: "git:unremoted", group: "blocker", status: anyU ? "warn" : "pass", title: "Branches on no remote",
      figure: ub.length > 0 ? `${n(ub.length)} ${ub.length === 1 ? "branch" : "branches"}${repo.unremotedCapped ? "+" : ""} · ${pluralCap(uc, "commit", repo.unremotedCapped)} on no remote` : uc > 0 ? `${pluralCap(uc, "commit", repo.unremotedCapped)} on no remote (branches not listed)` : "every branch is on a remote",
      why: anyU ? "Work on these branches has no copy off this machine." : "", fix: anyU ? { label: "List them", command: "git log --branches --not --remotes --oneline" } : null, metric: uc, ...(ub.length ? { detail: ub.map(b => `${b.branch} (${b.count})`).join(", ") } : {}) });
    const missing = repo.worktrees.filter(w => w.missing).length;
    const stale = repo.worktrees.filter(w => !w.missing && w.lastCommitAt !== null && now - w.lastCommitAt > 14 * DAY).length;
    rows.push({ id: "git:worktrees", group: "blocker", status: missing + stale > 0 ? "warn" : "pass", title: "Worktrees",
      figure: missing + stale > 0 ? [missing ? `${n(missing)} missing` : "", stale ? `${n(stale)} stale (no commit in 14+ days)` : ""].filter(Boolean).join(" · ") : `${plural(repo.worktreeTotal ?? repo.worktrees.length, "linked worktree")}${(repo.worktreeTotal ?? 0) > repo.worktrees.length ? ` (first ${n(repo.worktrees.length)} checked)` : ""}`,
      why: [missing ? "Worktrees whose directory is gone leave dangling entries in the repo." : "", stale ? "Worktrees with no commit for over 14 days are likely abandoned." : ""].filter(Boolean).join(" "),
      fix: missing ? { label: "Preview what prune would remove", command: "git worktree prune --dry-run" } : stale ? { label: "List worktrees", command: "git worktree list" } : null, metric: missing + stale });
    if (repo.behind) {
      const b = repo.behind, offHistory = b.count === 0 && !repo.head.startsWith(b.indexHead) && !b.indexHead.startsWith(repo.head);
      if (offHistory) rows.push({ id: "git:behind", group: "hygiene", status: "warn", title: "Spine index freshness", figure: "index was built from a commit not on HEAD's history",
        why: "The index's figures were measured on a different line of history than HEAD.", fix: { label: "Regenerate the spine index", command: "bff spine" }, metric: 1 });
      else rows.push({ id: "git:behind", group: "hygiene", status: b.count > 0 ? "warn" : "pass", title: "Spine index freshness", figure: b.count > 0 ? `${plural(b.count, "commit")} behind HEAD${b.capped ? "+" : ""}` : "index is current with HEAD",
        why: b.count > 0 ? `The index's figures predate the last ${plural(b.count, "commit")}.` : "", fix: b.count > 0 ? { label: "Regenerate the spine index", command: "bff spine" } : null, metric: b.count });
    }
  }
  rows.push(...agentRows(agents, now));
  // No `focus` means the index recorded no goal: unknown is not "none", so no row is emitted (H-1 M3), never a pass.
  const f = index?.focus, gates = f ? f.ownerGates.map(g => g.label).concat(f.items.filter(i => i.status === "owner-gate").map(i => i.label)) : null;
  if (gates) rows.push({ id: "owner-decisions", group: "blocker", status: gates.length > 0 ? "warn" : "pass", title: "Owner decisions", figure: gates.length > 0 ? `${plural(gates.length, "decision")} waiting on you` : "none recorded",
    why: gates.length > 0 ? "Work gated on the owner cannot move until a decision is made." : "", fix: gates.length > 0 ? { label: "Open the owner gates on the board" } : null, metric: gates.length, ...(gates.length ? { detail: gates.slice(0, 5).map(l => l.slice(0, 160)).join("\n") } : {}) });
  if (index) {
    const debt = index.threads.filter(t => t.status === "debt").length;
    rows.push({ id: "tech-debt", group: "blocker", status: "pass", title: "Tech debt", figure: debt > 0 ? `${plural(debt, "debt thread")} recorded` : "no debt threads",
      why: "", fix: null, metric: debt }); // recorded debt is a count, not an alarm: a standing warning on every debt-carrying repo teaches dismissal (UB-HE-2)
    rows.push(...index.health.map(spineRow));
  }
  return orderRows(rows);
}
