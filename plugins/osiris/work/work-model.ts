// Pure work-graph model (no I/O). Single-writer rule: Osiris only READS beads; it never repairs or writes
// (beady-eye's rule). Input is the adapter's normalized issues/deps; output is the ONE model both the
// Engineer Overview and the Factory views read.
import type {WorkDep, WorkIssue, WorkStatus} from "./types.ts";

export const LABEL_OWNER_DECISION = "owner-decision";
export const LABEL_RECONCILED = "reconciled";
export const LABEL_LANE = "lane";
export const LABEL_NEEDS_DUAL_GATE = "needs-dual-gate";
export const DEFAULT_STALE_MS = 24 * 3600_000;

export interface WorkNode {
  id: string; title: string; type: string; status: WorkStatus; priority: number;
  parent: string | null; labels: string[]; assignee: string | null; externalRef: string | null;
  createdAt: string; updatedAt: string; ageMs: number;
  ownerDecision: boolean; lane: boolean; review: boolean;
}
export interface WorkEdge {kind: "blocks" | "parent-child"; from: string; to: string} // blocks: from blocks to. parent-child: from is the parent.
export interface BlockedEntry {id: string; blockers: string[]}
export interface WorkCounts {ready: number; active: number; blocked: number; review: number; stale: number}
export interface WorkGraph {
  nodes: WorkNode[];
  edges: WorkEdge[];
  readyFrontier: string[];
  blocked: BlockedEntry[];
  stale: string[];
  criticalPath: string[]; // root blocker -> ... -> last blocked item; [] when no open blocking chain exists
  counts: WorkCounts;
  cycleEdges: WorkEdge[]; // blocks edges ignored because they close a cycle
  danglingEdges: WorkEdge[]; // edges whose endpoint is not in the issue set (ignored)
}
export interface BuildOptions {staleMs?: number}

const isClosed = (s: WorkStatus) => s === "closed";
const ms = (iso: string | null) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function buildWorkGraph(issues: readonly WorkIssue[], deps: readonly WorkDep[], now: number, opts: BuildOptions = {}): WorkGraph {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const byKey = new Map<string, WorkIssue>();
  for (const i of issues) byKey.set(i.id, i);

  const edges: WorkEdge[] = [];
  const danglingEdges: WorkEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (e: WorkEdge) => {
    const k = `${e.kind}|${e.from}|${e.to}`;
    if (seen.has(k)) return;
    seen.add(k);
    (byKey.has(e.from) && byKey.has(e.to) ? edges : danglingEdges).push(e);
  };
  for (const d of deps) {
    if (d.type === "blocks") addEdge({kind: "blocks", from: d.dependsOnId, to: d.issueId});
    else if (d.type === "parent-child") addEdge({kind: "parent-child", from: d.dependsOnId, to: d.issueId});
  }
  for (const i of issues) if (i.parent) addEdge({kind: "parent-child", from: i.parent, to: i.id});

  const edgeKey = (e: WorkEdge) => `${e.kind}|${e.from}|${e.to}`;
  edges.sort((a, b) => byId(edgeKey(a), edgeKey(b)));
  danglingEdges.sort((a, b) => byId(edgeKey(a), edgeKey(b)));

  const nodes: WorkNode[] = issues.map((i) => {
    const created = ms(i.createdAt);
    const review = !isClosed(i.status) && (i.labels.includes(LABEL_NEEDS_DUAL_GATE) || i.labels.includes(LABEL_RECONCILED));
    return {
      id: i.id, title: i.title, type: i.type, status: i.status, priority: i.priority, parent: i.parent, labels: i.labels,
      assignee: i.assignee, externalRef: i.externalRef, createdAt: i.createdAt, updatedAt: i.updatedAt,
      ageMs: created === null ? 0 : Math.max(0, now - created),
      ownerDecision: i.labels.includes(LABEL_OWNER_DECISION), lane: i.labels.includes(LABEL_LANE), review,
    };
  }).sort((a, b) => byId(a.id, b.id));

  // Open blockers per item: a blocker counts only while it exists and is not closed.
  const blocks = edges.filter((e) => e.kind === "blocks");
  const openBlockers = new Map<string, string[]>();
  for (const e of blocks) {
    if (isClosed(byKey.get(e.from)!.status)) continue;
    (openBlockers.get(e.to) ?? openBlockers.set(e.to, []).get(e.to)!).push(e.from);
  }
  for (const v of openBlockers.values()) v.sort(byId);

  const readyFrontier = nodes.filter((n) => n.status === "open" && !openBlockers.has(n.id)).map((n) => n.id);
  const blocked: BlockedEntry[] = nodes
    .filter((n) => !isClosed(n.status) && (openBlockers.has(n.id) || n.status === "blocked"))
    .map((n) => ({id: n.id, blockers: openBlockers.get(n.id) ?? []}));
  const stale = nodes.filter((n) => {
    if (n.status !== "in_progress") return false;
    const src = byKey.get(n.id)!;
    const last = Math.max(ms(src.updatedAt) ?? 0, ms(src.heartbeatAt) ?? 0, ms(src.startedAt) ?? 0);
    return now - last > staleMs;
  }).map((n) => n.id);

  const {criticalPath, cycleEdges} = longestOpenChain(nodes.filter((n) => !isClosed(n.status)).map((n) => n.id), blocks.filter((e) => !isClosed(byKey.get(e.from)!.status) && !isClosed(byKey.get(e.to)!.status)));

  return {
    nodes, edges, readyFrontier, blocked, stale, criticalPath,
    counts: {ready: readyFrontier.length, active: nodes.filter((n) => n.status === "in_progress").length, blocked: blocked.length, review: nodes.filter((n) => n.review).length, stale: stale.length},
    cycleEdges, danglingEdges,
  };
}

// Longest chain over blocks edges between open items. Back edges found by DFS (in id order) are dropped first, so
// cycles can never loop and the result is deterministic; ties break toward the smaller id.
function longestOpenChain(ids: string[], blocks: WorkEdge[]): {criticalPath: string[]; cycleEdges: WorkEdge[]} {
  const out = new Map<string, string[]>();
  for (const id of ids) out.set(id, []);
  for (const e of blocks) out.get(e.from)!.push(e.to);
  for (const v of out.values()) v.sort(byId);
  const color = new Map<string, 0 | 1 | 2>();
  const cycleEdges: WorkEdge[] = [];
  const dag = new Map<string, string[]>();
  const visit = (u: string) => {
    color.set(u, 1);
    const keep: string[] = [];
    for (const v of out.get(u)!) {
      const c = color.get(v) ?? 0;
      if (c === 1) { cycleEdges.push({kind: "blocks", from: u, to: v}); continue; }
      keep.push(v);
      if (c === 0) visit(v);
    }
    dag.set(u, keep);
    color.set(u, 2);
  };
  for (const id of [...ids].sort(byId)) if (!color.has(id)) visit(id);
  const best = new Map<string, string[]>();
  const chain = (u: string): string[] => {
    const hit = best.get(u);
    if (hit) return hit;
    let tail: string[] = [];
    for (const v of dag.get(u)!) { const c = chain(v); if (c.length > tail.length) tail = c; }
    const r = [u, ...tail];
    best.set(u, r);
    return r;
  };
  let criticalPath: string[] = [];
  for (const id of [...ids].sort(byId)) { const c = chain(id); if (c.length > criticalPath.length) criticalPath = c; }
  return {criticalPath: criticalPath.length >= 2 ? criticalPath : [], cycleEdges};
}
