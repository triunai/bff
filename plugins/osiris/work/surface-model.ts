// Pure Work-surface model (no I/O, no React, no colours): everything the Work surface shows is derived from ONE WorkSurfaceSnapshot.
// Readiness is never recomputed here: it comes from buildWorkGraph (proven equal to `bd ready`).
// Ported logic (MIT, licence texts in third_party/):
//   - BeadBoard src/lib/kanban.ts hasOpenBlockers/deriveBlockedIds: a blocker counts only while it exists and is not closed (third_party/beadboard-LICENSE.txt).
//   - Foolery src/lib/wave-planner.ts computeWaves: Kahn's algorithm with level tracking, cycle members are unschedulable (third_party/foolery-LICENSE.txt).
//   - Foolery src/lib/agent-pool.ts selectFromPool: weighted random pick with cross-agent exclusion (third_party/foolery-LICENSE.txt).
import type {WorkDep, WorkIssue} from "./types.ts";
import {cleanText} from "./sanitize.ts";
import {buildWorkGraph, LABEL_NEEDS_DUAL_GATE, LABEL_OWNER_DECISION, LABEL_RECONCILED} from "./work-model.ts";
import type {WorkGraph} from "./work-model.ts";
import type {BeadLink, BoardCard, DecisionRow, HistoryEvent, Kpis, Lane, PoolEntry, Pools, Runtime, SidebarGlyph, SidebarRow, TreeNode, Wave, WavePlan, WorkSurfaceSnapshot} from "./surface-types.ts";

export const LABEL_READY_TO_LAND = "ready-to-land";
export const LABEL_CRIT = "crit";
const CRIT_TITLE = /\bCRITS?-\d+\b/;
const MAX_TITLE = 48;

const ms = (iso: string | null) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const graphOf = (s: WorkSurfaceSnapshot, now: number) => buildWorkGraph(s.issues, s.deps, now);
const issueMap = (s: WorkSurfaceSnapshot) => new Map(s.issues.map((i) => [i.id, i]));
const isReview = (i: WorkIssue) => i.status !== "closed" && [LABEL_RECONCILED, LABEL_NEEDS_DUAL_GATE, LABEL_READY_TO_LAND].some((l) => i.labels.includes(l));

// ---- wording -------------------------------------------------------------------------------------------------------
/** `td-xyz.1.2` -> `xyz.1.2` (drop the tracker prefix before the first dash). */
export const shortId = (id: string) => { const k = id.indexOf("-"); return k >= 0 && k < id.length - 1 ? id.slice(k + 1) : id; };

// A leading jargon segment: ALLCAPS token | W-12 | CRITS-1, optionally followed by one more word, then " · ".
const JARGON = /^(?:[A-Z][A-Z0-9&]*(?:-\d+(?:\.\d+)*)?)(?:\s+[A-Za-z0-9._-]+)?\s+·\s+/;
/** Strip leading jargon segments (`LANE w75doc · `, `OWNER · `, `W-31 · `, `M&T · `); never returns empty. */
export function plainTitle(title: string): string {
  let t = cleanText(title).trim(); // titles are untrusted text: escapes and hidden characters never reach a surface
  for (let n = 0; n < 4; n++) { const m = JARGON.exec(t); if (!m || m[0].length >= t.length) break; t = t.slice(m[0].length).trim(); }
  return t || cleanText(title);
}
const clip = (t: string) => (t.length > MAX_TITLE ? t.slice(0, MAX_TITLE - 1).trimEnd() + "…" : t);

export function formatAge(msAge: number): string {
  const m = Math.floor(Math.max(0, msAge) / 60_000);
  const n = (v: number, u: string) => `${v} ${u}${v === 1 ? "" : "s"}`;
  if (m < 1) return "less than a minute";
  if (m < 60) return n(m, "minute");
  if (m < 48 * 60) return n(Math.floor(m / 60), "hour");
  return n(Math.floor(m / 1440), "day");
}

export const laneLabel = (l: Lane) => ({action: "Action required", ready: "Ready to start", in_progress: "In progress", review: "Waiting for review", blocked: "Blocked"})[l];
export const emptyLaneText = (l: Lane) => ({action: "Nothing needs your decision", ready: "Nothing is ready to start", in_progress: "Nothing is in progress", review: "Nothing is waiting for review", blocked: "Nothing is blocked"})[l];
export const linkText = (c: BoardCard) => (c.blockedBy.length === 0 ? "Waiting on nothing" : `Waiting on ${c.blockedBy.length}`) + " · " + (c.unblocks.length === 0 ? "Not blocking anything" : `Blocking ${c.unblocks.length}`);

// ---- shared helpers ------------------------------------------------------------------------------------------------
const paneLabel = (n: TreeNode | undefined) => (n?.agent ? n.agent.title ?? n.agent.paneId : null);
/** First tree node per bead id (a bead appears once per path). Prefers a node that carries an agent. */
function nodesById(s: WorkSurfaceSnapshot) {
  const m = new Map<string, TreeNode>();
  for (const r of s.tree) for (const n of r.nodes) { const p = m.get(n.id); if (!p || (!p.agent && n.agent)) m.set(n.id, n); }
  return m;
}
const parentIds = (s: WorkSurfaceSnapshot) => {
  const p = new Set<string>();
  for (const i of s.issues) if (i.parent) p.add(i.parent);
  for (const d of s.deps) if (d.type === "parent-child") p.add(d.dependsOnId);
  return p;
};
/** Open blockers per bead (BeadBoard hasOpenBlockers): `blocks` deps only, endpoint must exist, blocker not closed. */
function linkMaps(s: WorkSurfaceSnapshot) {
  const by = issueMap(s);
  const blockedBy = new Map<string, BeadLink[]>(), unblocks = new Map<string, BeadLink[]>();
  const seen = new Set<string>();
  const push = (m: Map<string, BeadLink[]>, k: string, i: WorkIssue) => (m.get(k) ?? m.set(k, []).get(k)!).push({id: i.id, title: plainTitle(i.title), status: i.status});
  for (const d of s.deps as readonly WorkDep[]) {
    if (d.type !== "blocks") continue;
    const k = `${d.dependsOnId}>${d.issueId}`; if (seen.has(k)) continue; seen.add(k);
    const blocker = by.get(d.dependsOnId), blocked = by.get(d.issueId);
    if (!blocker || !blocked || blocker.status === "closed" || blocked.status === "closed") continue;
    push(blockedBy, blocked.id, blocker); push(unblocks, blocker.id, blocked);
  }
  for (const m of [blockedBy, unblocks]) for (const v of m.values()) v.sort((a, b) => byId(a.id, b.id));
  return {blockedBy, unblocks};
}
const reviewIds = (s: WorkSurfaceSnapshot) => new Set(s.issues.filter(isReview).map((i) => i.id));

// ---- KPIs ----------------------------------------------------------------------------------------------------------
export function kpis(s: WorkSurfaceSnapshot, now: number, opts: {activeCap?: number} = {}): Kpis {
  // ONE definition (review W-1B M4): blocked and review are the Board's lane counts, so a tile and its lane can never disagree.
  const g = graphOf(s, now), by = issueMap(s), nodes = nodesById(s), cards = boardCards(s, now);
  const active = s.issues.filter((i) => i.status === "in_progress");
  const stale = new Set(g.stale);
  for (const r of s.tree) for (const n of r.nodes) if (n.anomalies.includes("stale-claim") || n.anomalies.includes("stale-pane")) stale.add(n.id);
  const blockedCards = cards.filter((c) => c.lane === "blocked"), rv = cards.filter((c) => c.lane === "review");
  const ages = blockedCards.map((b) => now - (ms(by.get(b.id)!.updatedAt) ?? now));
  return {
    ready: g.counts.ready,
    active: active.length, activeCap: opts.activeCap ?? 8,
    activeNoPane: s.source === "bd" ? 0 : active.filter((i) => !nodes.get(i.id)?.agent).length,
    blocked: blockedCards.length, blockedOldestMs: ages.length ? Math.max(0, ...ages) : null,
    review: rv.length, reviewUrgent: rv.filter((i) => i.priority <= 1).length, reviewTopP: rv.length ? Math.min(...rv.map((i) => i.priority)) : null,
    stale: stale.size,
    collision: s.conflicts.length,
  };
}

// ---- sidebar -------------------------------------------------------------------------------------------------------
/** Plain-English text for bdi's own drift rules: THE one definition (the sidebar tree and the drift badges both read it). */
export const WARN: Record<string, string> = {"orphan-claim": "claimed · no pane", "stale-pane": "pane gone", "stale-claim": "claim went quiet"};
const warnOf = (n: TreeNode | undefined) => { for (const r of ["orphan-claim", "stale-pane", "stale-claim"]) if (n?.anomalies.includes(r)) return WARN[r]; return null; };

export function sidebarRows(s: WorkSurfaceSnapshot, now: number): SidebarRow[] {
  const g: WorkGraph = graphOf(s, now), by = issueMap(s), nodes = nodesById(s);
  const blocked = new Set(g.blocked.map((b) => b.id));
  const kids = new Map<string, string[]>();
  for (const e of g.edges) if (e.kind === "parent-child") (kids.get(e.from) ?? kids.set(e.from, []).get(e.from)!).push(e.to);
  const row = (id: string, depth: number, key: string, node: TreeNode | undefined): SidebarRow => {
    const i = by.get(id), ch = kids.get(id) ?? [];
    const closed = i?.status === "closed";
    const glyph: SidebarGlyph = closed ? "✓" : blocked.has(id) || (node?.blockedBy.length ?? 0) > 0 ? "⊘" : i?.status === "in_progress" ? "◐" : "○";
    const full = cleanText(i?.title ?? id);
    return {key, id, shortId: shortId(id), title: clip(plainTitle(full)), fullTitle: full, glyph, depth, done: ch.filter((c) => by.get(c)?.status === "closed").length, total: ch.length, pane: paneLabel(node), warn: warnOf(node), dim: closed};
  };
  if (s.tree.some((r) => r.nodes.length)) {
    const out: SidebarRow[] = [], path: string[] = [];
    // Containment only (owner image 120): bdi draws a bead once per PATH, including under `blocks` edges, so the dogfood run
    // showed one contract bead nine times. A node reached through a blocks edge, and everything under it, is skipped.
    for (const r of s.tree) { path.length = 0; let skip = -1; r.nodes.forEach((n, k) => {
      if (skip >= 0 && n.depth > skip) return; skip = -1;
      if (n.edge === "blocks") { skip = n.depth; return; }
      path.length = n.depth; path[n.depth] = n.id; out.push(row(n.id, n.depth, `${r.root}/${k}:${path.join(">")}`, n)); }); }
    return out;
  }
  // bd-only: no tree projection, so walk the parent links (roots sorted by id; a visited set breaks cycles).
  const out: SidebarRow[] = [], seen = new Set<string>();
  const walk = (id: string, depth: number, key: string) => {
    if (seen.has(id)) return; seen.add(id);
    out.push(row(id, depth, key, nodes.get(id)));
    for (const c of [...(kids.get(id) ?? [])].sort(byId)) walk(c, depth + 1, `${key}>${c}`);
  };
  for (const i of [...s.issues].sort((a, b) => byId(a.id, b.id))) if (!i.parent && !seen.has(i.id)) walk(i.id, 0, i.id);
  for (const i of [...s.issues].sort((a, b) => byId(a.id, b.id))) walk(i.id, 0, i.id); // orphaned cycles/dangling parents
  return out;
}
export const unattributedLine = (s: WorkSurfaceSnapshot): string | null => (s.unattributed.length ? `⚠ ${s.unattributed.length} unattributed pane${s.unattributed.length === 1 ? "" : "s"}` : null);

// ---- board ---------------------------------------------------------------------------------------------------------
/**
 * Lane precedence (one card, one lane): action required (an open owner decision or CRIT, the decisionsWaiting rule) > review label >
 * blocked > in progress > ready. The kpis() blocked and review tiles are these lane counts (one definition, W-1B M4), so a claimed
 * bead with an open blocker shows as BLOCKED and a reviewed one counts only under review.
 */
export function boardCards(s: WorkSurfaceSnapshot, now: number): BoardCard[] {
  const g = graphOf(s, now), nodes = nodesById(s), {blockedBy, unblocks} = linkMaps(s);
  const ready = new Set(g.readyFrontier), blocked = new Set(g.blocked.map((b) => b.id)), review = reviewIds(s), action = new Set(decisionBeads(s).map((i) => i.id));
  const cards: BoardCard[] = [];
  for (const i of s.issues) {
    if (i.status === "closed") continue;
    const workLane: Exclude<Lane, "action"> | null = review.has(i.id) ? "review" : blocked.has(i.id) ? "blocked" : i.status === "in_progress" ? "in_progress" : ready.has(i.id) ? "ready" : null;
    const lane: Lane | null = action.has(i.id) ? "action" : workLane;
    if (!lane) continue;
    const created = ms(i.createdAt);
    cards.push({id: i.id, shortId: shortId(i.id), title: plainTitle(i.title), lane, workLane, priority: i.priority, blockedBy: blockedBy.get(i.id) ?? [], unblocks: unblocks.get(i.id) ?? [], pane: paneLabel(nodes.get(i.id)), assignee: i.assignee, ageMs: created === null ? 0 : Math.max(0, now - created), labels: i.labels});
  }
  return cards.sort((a, b) => a.priority - b.priority || b.ageMs - a.ageMs || byId(a.id, b.id));
}

// ---- decisions waiting on the owner --------------------------------------------------------------------------------
const decisionKind = (i: WorkIssue): DecisionRow["kind"] | null =>
  i.labels.includes(LABEL_OWNER_DECISION) || i.type === "decision" ? "owner-decision" : i.labels.includes(LABEL_CRIT) || CRIT_TITLE.test(i.title) ? "crit" : null;
function decisionBeads(s: WorkSurfaceSnapshot) {
  const parents = parentIds(s); // containers (beads with children) are not decisions: their children are
  return s.issues.filter((i) => (i.status === "open" || i.status === "in_progress") && !parents.has(i.id) && decisionKind(i) !== null);
}
/** The ONE source of the decisions count (Health reads this too). */
export const decisionsCount = (s: WorkSurfaceSnapshot) => decisionBeads(s).length;
export function decisionsWaiting(s: WorkSurfaceSnapshot, now: number): DecisionRow[] {
  return decisionBeads(s).map((i) => {
    const created = ms(i.createdAt);
    // Each wrap commit after creation is a session that ended with this still undecided.
    const deferredSessions = created === null ? 0 : s.wraps.filter((w) => w > created).length;
    return {id: i.id, shortId: shortId(i.id), title: plainTitle(i.title), kind: decisionKind(i)!, waitingMs: created === null ? 0 : Math.max(0, now - created), since: i.createdAt, deferredSessions};
  }).sort((a, b) => b.deferredSessions - a.deferredSessions || b.waitingMs - a.waitingMs || byId(a.id, b.id));
}

// ---- waves (Foolery computeWaves port) -------------------------------------------------------------------------------
/** Kahn levels over non-closed beads and `blocks` deps. Cycle members, and anything stuck behind them, are `unschedulable`
 *  (Foolery also lists partly-unblocked cycle dependants in a wave; we only wave what truly got processed). */
export function planWaves(s: WorkSurfaceSnapshot): WavePlan {
  const open = s.issues.filter((i) => i.status !== "closed").sort((a, b) => a.priority - b.priority || byId(a.id, b.id));
  const ids = new Set(open.map((i) => i.id)), prio = new Map(open.map((i) => [i.id, i.priority]));
  const inDeg = new Map<string, number>(), adj = new Map<string, string[]>(), seen = new Set<string>();
  for (const i of open) { inDeg.set(i.id, 0); adj.set(i.id, []); }
  for (const d of s.deps) {
    if (d.type !== "blocks" || !ids.has(d.dependsOnId) || !ids.has(d.issueId)) continue;
    const k = `${d.dependsOnId}>${d.issueId}`; if (seen.has(k)) continue; seen.add(k);
    adj.get(d.dependsOnId)!.push(d.issueId); inDeg.set(d.issueId, inDeg.get(d.issueId)! + 1);
  }
  const level = new Map<string, number>(), done = new Set<string>();
  let queue = open.filter((i) => inDeg.get(i.id) === 0).map((i) => i.id);
  for (const id of queue) level.set(id, 0);
  while (queue.length) {
    const next: string[] = [];
    for (const id of queue) {
      done.add(id);
      for (const nb of adj.get(id)!) {
        level.set(nb, Math.max(level.get(nb) ?? 0, level.get(id)! + 1));
        const d = inDeg.get(nb)! - 1; inDeg.set(nb, d);
        if (d === 0) next.push(nb);
      }
    }
    queue = next;
  }
  const waves: Wave[] = [];
  for (const id of done) { const l = level.get(id)!; (waves[l] ??= {index: l, ids: []}).ids.push(id); }
  const out = waves.filter(Boolean);
  for (const w of out) w.ids.sort((a, b) => prio.get(a)! - prio.get(b)! || byId(a, b));
  return {waves: out, unschedulable: open.filter((i) => !done.has(i.id)).map((i) => i.id).sort(byId)};
}

// ---- history -------------------------------------------------------------------------------------------------------
/** created/started/closed from timestamps. APPROXIMATION: WorkIssue has no closedAt, so a closed bead's close time is its updatedAt. Oldest first. */
export function historyFromTimestamps(s: WorkSurfaceSnapshot): HistoryEvent[] {
  const ev: HistoryEvent[] = [];
  for (const i of s.issues) {
    const c = ms(i.createdAt), st = ms(i.startedAt), u = ms(i.updatedAt);
    if (c !== null) ev.push({at: c, id: i.id, kind: "created", source: "timestamps"});
    if (st !== null) ev.push({at: st, id: i.id, kind: "started", source: "timestamps"});
    if (i.status === "closed" && u !== null) ev.push({at: u, id: i.id, kind: "closed", source: "timestamps"});
  }
  return ev.sort((a, b) => a.at - b.at || byId(a.id, b.id));
}
/** Status changes seen between two snapshots (beads present in both). */
export function observeTransitions(prev: WorkSurfaceSnapshot, next: WorkSurfaceSnapshot, at: number): HistoryEvent[] {
  const before = issueMap(prev), ev: HistoryEvent[] = [];
  for (const i of next.issues) { const p = before.get(i.id); if (p && p.status !== i.status) ev.push({at, id: i.id, kind: "status", from: p.status, to: i.status, source: "observed"}); }
  return ev.sort((a, b) => byId(a.id, b.id));
}

// ---- pools (display only; Foolery selectFromPool port) ---------------------------------------------------------------
export const DEFAULT_POOLS: Pools = {
  implement: [{runtime: "claude", model: "sonnet", weight: 60}, {runtime: "codex", model: "gpt-5.5", weight: 30}, {runtime: "claude", model: "opus", weight: 10}],
  review: [{runtime: "claude", model: "opus", weight: 50}, {runtime: "codex", model: "gpt-5.5", weight: 50}],
};
/** Weighted random pick. With `excludeRuntime` (cross-agent review) the implementer's runtime is removed; null when nothing else is left. */
export function pickFromPool(pool: readonly PoolEntry[], excludeRuntime?: Runtime | ReadonlySet<Runtime>, rnd: () => number = Math.random): PoolEntry | null {
  const ex = excludeRuntime === undefined ? new Set<Runtime>() : typeof excludeRuntime === "string" ? new Set([excludeRuntime]) : excludeRuntime;
  const valid = pool.filter((e) => e.weight > 0 && !ex.has(e.runtime));
  const total = valid.reduce((a, e) => a + e.weight, 0);
  if (!valid.length || total <= 0) return null;
  let roll = rnd() * total;
  for (const e of valid) { roll -= e.weight; if (roll <= 0) return e; }
  return valid[valid.length - 1];
}
