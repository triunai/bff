// Drift detector (pure, no I/O): where the three truths disagree: the tracker (bd), the live panes (Herdr via bdi) and git worktrees.
// Single-writer rule (beady-eye): this only REPORTS. It never repairs, closes, kills or writes anything.
// bdi already emits orphan-claim / stale-pane / stale-claim and conflicts: those are PASSED THROUGH, never recomputed. Added here:
// agent-no-bead, closed-agent-running, closed-worktree-dirty, agent-idle.
// The finished-lane shape (needs-dual-gate / reconciled / ready-to-land, pane detached, claim left in progress) is NORMAL: bdi calls it
// orphan-claim, but Osiris never closes beads (prompt.ts), so orphan-claim / stale-claim are excused on review beads (same call as lane-state.ts).
import type { GitState } from "./git-worktree-probe.ts";
import type { AnomalyRule, PaneRef, TreeNode, WorkSurfaceSnapshot } from "./surface-types.ts";
import type { WorkIssue } from "./types.ts";
import { LABEL_NEEDS_DUAL_GATE, LABEL_RECONCILED } from "./work-model.ts";
import { formatAge, LABEL_READY_TO_LAND, plainTitle, shortId } from "./surface-model.ts";

export type DriftSeverity = "error" | "warn" | "info";
export type DriftRule = "agent-no-bead" | "closed-agent-running" | "closed-worktree-dirty" | "agent-idle" | "conflict" | AnomalyRule;
export type DriftFinding = { rule: DriftRule; severity: DriftSeverity; beadId?: string; paneId?: string; worktree?: string; message: string; since?: number };
export type DriftOpts = {
  /** A pane idle at least this long while its bead is in progress is drift. Default 15 minutes. */
  idleMs?: number;
  /** When each pane was first seen idle (epoch ms), if an observer tracks it. Without it, the bead's last heartbeat/update stands in. */
  paneIdleSince?: ReadonlyMap<string, number>;
};

export const DEFAULT_IDLE_MS = 15 * 60_000;
const SEVERITY_RANK: Record<DriftSeverity, number> = { error: 0, warn: 1, info: 2 };
/** Plain-English text for bdi's own rules: SAME wording as surface-model's sidebar warnings (pinned by test). */
export const PASS_TEXT: Record<string, string> = { "orphan-claim": "claimed · no pane", "stale-pane": "pane gone", "stale-claim": "claim went quiet" };
const EXCUSED_ON_REVIEW = new Set(["orphan-claim", "stale-claim"]);

const ms = (iso: string | null) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
const isReview = (i: WorkIssue) => i.status !== "closed" && [LABEL_RECONCILED, LABEL_NEEDS_DUAL_GATE, LABEL_READY_TO_LAND].some((l) => i.labels.includes(l));
const live = (p: { state: string | null }) => { const s = p.state?.toLowerCase(); return s === "working" || s === "blocked"; }; // idle / done / unknown = a shell, not work
const paneName = (p: PaneRef) => (p.title ? `"${plainTitle(p.title)}"` : p.paneId);
const within = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/** Worktrees of a bead: dispatch names it `…/<beadId>` on branch `work/<beadId>-<slug>`; a pane sitting inside one also counts. */
function worktreesOf(id: string, node: TreeNode | undefined, git: GitState) {
  const cwd = node?.agent?.cwd ?? null;
  return [...git].filter(([path, w]) => path.split("/").pop() === id || w.branch === `work/${id}` || !!w.branch?.startsWith(`work/${id}-`) || (cwd !== null && within(cwd, path)));
}

export function driftFindings(s: WorkSurfaceSnapshot, git: GitState, now: number, opts: DriftOpts = {}): DriftFinding[] {
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS, out: DriftFinding[] = [];
  const by = new Map(s.issues.map((i) => [i.id, i]));
  const node = new Map<string, TreeNode>(); // first node per bead; one that carries an agent wins
  for (const r of s.tree) for (const n of r.nodes) { const p = node.get(n.id); if (!p || (!p.agent && n.agent)) node.set(n.id, n); }

  // 1. bdi's own rules, unchanged (one finding per bead + rule, however many tree paths show it).
  const seen = new Set<string>();
  for (const r of s.tree) for (const n of r.nodes) for (const rule of n.anomalies) {
    const i = by.get(n.id), k = `${n.id}\0${rule}`, at = i ? ms(i.updatedAt) : null;
    if (seen.has(k) || (i && isReview(i) && EXCUSED_ON_REVIEW.has(rule))) continue; seen.add(k);
    out.push({ rule, severity: "warn", beadId: n.id, ...(n.agent ? { paneId: n.agent.paneId } : {}), message: `${shortId(n.id)}: ${PASS_TEXT[rule] ?? `bdi reported "${rule}"`}`, ...(at !== null ? { since: at } : {}) });
  }
  for (const c of s.conflicts) out.push({ rule: "conflict", severity: "error", message: `Two claims collide on one pane: ${c}` });

  // 2. agent-no-bead: a live pane doing work that no bead claims (idle shells do not count).
  for (const u of s.unattributed) if (live(u)) out.push({ rule: "agent-no-bead", severity: "warn", paneId: u.paneId, message: `A pane is ${u.state?.toLowerCase() === "blocked" ? "waiting on a prompt" : "working"} but no bead claims it${u.cwd ? ` (in ${u.cwd})` : ""}.` });

  for (const i of s.issues) {
    const n = node.get(i.id), a = n?.agent ?? null, at = ms(i.updatedAt), since = at === null ? {} : { since: at };
    // 3. closed-agent-running: closed bead, pane still attached.
    if (i.status === "closed" && a) out.push({ rule: "closed-agent-running", severity: live(a) ? "error" : "warn", beadId: i.id, paneId: a.paneId, message: `${shortId(i.id)} is closed, but pane ${paneName(a)} is still ${live(a) ? "working" : "open"} on it.`, ...since });
    // 4. closed-worktree-dirty: closed bead, uncommitted changes left in its worktree.
    if (i.status === "closed") for (const [path, w] of worktreesOf(i.id, n, git)) if (w.dirty) out.push({ rule: "closed-worktree-dirty", severity: "error", beadId: i.id, worktree: path, message: `${shortId(i.id)} is closed, but its worktree still has ${w.dirty} uncommitted change${w.dirty === 1 ? "" : "s"}${w.branch ? ` on ${w.branch}` : ""}.`, ...since });
    // 5. agent-idle: in progress (not in review), pane attached but idle too long.
    if (i.status === "in_progress" && !isReview(i) && a && a.state?.toLowerCase() === "idle") {
      const idleAt = opts.paneIdleSince?.get(a.paneId) ?? ms(i.heartbeatAt) ?? at;
      if (idleAt !== null && now - idleAt >= idleMs) out.push({ rule: "agent-idle", severity: "warn", beadId: i.id, paneId: a.paneId, message: `${shortId(i.id)} is in progress, but its agent has been idle for ${formatAge(now - idleAt)}.`, since: idleAt });
    }
  }
  return out.sort(compare);
}

/** Severity, then age (oldest first; undated last), then id, then rule/message so the order is total and deterministic. */
function compare(a: DriftFinding, b: DriftFinding): number {
  const d = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]; if (d) return d;
  const sa = a.since ?? Infinity, sb = b.since ?? Infinity; if (sa !== sb) return sa < sb ? -1 : 1;
  const ia = a.beadId ?? a.paneId ?? a.worktree ?? "", ib = b.beadId ?? b.paneId ?? b.worktree ?? ""; if (ia !== ib) return ia < ib ? -1 : 1;
  return a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
}
