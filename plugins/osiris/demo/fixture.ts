// ONE synthetic fixture for demo mode. Everything here is invented: a fake repo ("demo-repo"), fake bead ids (demo-1...),
// fake agents, plausible costs, seven days of calls and commits. Pure data builders, no node imports and no I/O, so the same
// module can be read by the browser bundle, the server and the tests. Every builder takes `now` so a test is deterministic.
// The existing view models are fed by this data (merge, never reimplement): the server turns it into the same answers the real
// readers give, and the client cannot tell the difference.
import type { Call } from "../analytics.ts";
import type { WorkDep, WorkIssue } from "../work/types.ts";
import type { PaneRef, TreeNode, TreeRoot, UnattributedPane, WorkSurfaceSnapshot } from "../work/surface-types.ts";
import type { DayCommit, DayCommits, DayCounts, DocSection, FileDiff, GitCommit, GitCommitDetail, GitFileStat, GitGraph, GitRef, GitRepo, GitStatus } from "../git-types.ts";
import type { RepoHealth } from "../health-types.ts";
import type { CodexSession } from "../work/codex-feed.ts";
import { DEMO_REPO } from "./constants.ts";
import type { ProviderId } from "../work/providers/registry.ts";
import type { LedgerRead } from "../work/fleet-ledger.ts";

import { generateWorld, lcg, MODEL_IDS, SEED } from "./generate.ts";
import type { CommitSeed } from "./generate.ts";
import type { Profile } from "./profile-schema.ts";
import profile from "./profile.json" with { type: "json" };

/** The synthetic world: built from demo/profile.json (aggregate shape of real usage) and a fixed seed, so it is the same on every run. */
export const WORLD = generateWorld(profile as Profile, SEED);
export { lcg };
export const DAY = 86_400_000, HOUR = 3_600_000, MIN = 60_000;
export const DEMO_HEAD = "d3m0c0de5a1e0b7c4f21a98e6d5b3c2f10e9a8b7";
export const DEMO_BRANCH = "main";
const iso = (ms: number) => new Date(ms).toISOString();
const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const hex40 = (n: number) => { const r = lcg(n * 7919 + 13); let o = ""; while (o.length < 40) o += Math.floor(r() * 16).toString(16); return o; };

export const AGENTS = ["ada", "grace", "linus", "margaret", "ken"] as const;
export const AUTHORS = ["Demo Dev", "Sam Sample", "Alex Example"] as const;

// ---- beads -----------------------------------------------------------------------------------------------------------------
const SEEDS = WORLD.beads;
const PANE_OF: Record<string, PaneRef> = Object.fromEntries(WORLD.panes.map(p => [p.beadId, { paneId: p.paneId, session: "demo", state: "working", title: p.title, cwd: p.cwd } as PaneRef]));
export function demoIssues(now: number): WorkIssue[] {
  return SEEDS.map(s => ({
    id: s.id, title: s.title, type: s.type, status: s.status, priority: s.p, parent: s.parent, labels: s.labels ?? [], assignee: s.assignee ?? null, externalRef: null,
    createdAt: iso(now - s.created * DAY), updatedAt: iso(now - s.updated * DAY), startedAt: s.started == null ? null : iso(now - s.started * HOUR), heartbeatAt: s.status === "in_progress" && !s.anomaly ? iso(now - 2 * MIN) : null,
  }));
}
export const DEMO_DEPS: WorkDep[] = WORLD.deps.map(d => ({ issueId: d.issueId, dependsOnId: d.dependsOnId, type: d.type }));
const treeNode = (id: string, depth: number, o: Partial<TreeNode> = {}): TreeNode => ({ id, depth, edge: depth ? "parent-child" : null, ready: false, blockedBy: [], agent: PANE_OF[id] ?? null, anomalies: [], ...o });
function demoTree(): TreeRoot[] {
  const roots = SEEDS.filter(s => !s.parent && s.type === "epic");
  return roots.map(r => {
    const kids = SEEDS.filter(s => s.parent === r.id);
    const blockers = (id: string) => DEMO_DEPS.filter(d => d.issueId === id && d.type === "blocks").map(d => d.dependsOnId);
    const nodes = [treeNode(r.id, 0), ...kids.map(k => treeNode(k.id, 1, { ready: k.status === "open" && !blockers(k.id).length, blockedBy: blockers(k.id), anomalies: k.anomaly ? [k.anomaly] : [] }))];
    return { root: r.id, title: r.title, total: kids.length, finished: kids.filter(k => k.status === "closed").length, liveAgents: kids.filter(k => PANE_OF[k.id]).length, anomalyCount: nodes.reduce((n, x) => n + x.anomalies.length, 0), nodes };
  });
}
export function demoSurface(now: number): WorkSurfaceSnapshot {
  const unattributed: UnattributedPane[] = [{ paneId: `demo:w1.p${WORLD.panes.length + 1}`, cwd: "/demo/work/demo-repo", state: "idle", agent: "claude" }];
  return {
    source: "bdi", generatedAt: now, repo: DEMO_REPO, bdVersion: "demo", bdiVersion: "demo", issues: demoIssues(now), deps: DEMO_DEPS, tree: demoTree(), unattributed, conflicts: [],
    wraps: [now - 30 * HOUR, now - 54 * HOUR, now - 101 * HOUR], notes: ["Demo data: nothing here was read from your machine."],
  };
}

// ---- herdr panes + calls ---------------------------------------------------------------------------------------------------
export function demoPanes() {
  const mk = (n: number, title: string, agent: ProviderId | null, status: string, cwd: string) => ({ paneId: `demo:w1.p${n}`, terminalId: `term_demo_${n}`, title, cwd, agent, status, workspaceId: "w1", focused: n === 1 });
  const lanes = WORLD.panes.map((p, i) => mk(i + 1, p.title, "claude", "working", p.cwd)), k = lanes.length;
  return { state: "live" as const, panes: [...lanes, mk(k + 1, "scratch", "claude", "idle", "/demo/work/demo-repo"), mk(k + 2, "review lane", "codex", "idle", "/demo/work/demo-repo-review"), mk(k + 3, "shell", null, "unknown", "/demo/work/demo-repo")], note: null };
}
export function demoPaneTail(paneId: string, now: number) {
  return { paneId, lines: ["$ npm test -- export", "  PASS  export/add-format", "  PASS  export/remove-format", "  PASS  export/retry-policy", "  RUN   export/resume-after-failure", "Editing src/export/Pipeline.tsx", "Reading src/export/usePipeline.ts"], truncated: false, at: now };
}
const TOOLS: [string, string | null, number][] = [["Bash", null, 38], ["Read", null, 30], ["Edit", null, 22], ["Grep", null, 14], ["Write", null, 8], ["Task", null, 5], ["search_docs", "demo-docs", 7]];
const MODELS = [MODEL_IDS.opus, MODEL_IDS.sonnet];
const CALL_MODELS = WORLD.modelWeights.map(m => m.id), CALL_WEIGHTS = WORLD.modelWeights.map(m => m.w);
/** Seven days of tool calls, newest last. `source` differs between the BB snapshot and the Herdr capture, nothing else.
 *  Volume, model mix and token scale come from the world (the profile): busy days, a Claude/Codex mix, costs near the usual daily spend. */
export function demoCalls(now: number, source: "bb" | "claude-transcript" = "bb"): Call[] {
  const r = lcg(42), out: Call[] = [], pick = () => { let t = r() * TOOLS.reduce((a, x) => a + x[2], 0); for (const x of TOOLS) { t -= x[2]; if (t <= 0) return x; } return TOOLS[0]; };
  const scale = Math.max(0.6, Math.min(3, WORLD.costScalePerDay / 70)), pickModel = () => { let t = r() * CALL_WEIGHTS.reduce((a, b) => a + b, 0); for (let i = 0; i < CALL_MODELS.length; i++) { t -= CALL_WEIGHTS[i]; if (t <= 0) return CALL_MODELS[i]; } return CALL_MODELS[0]; };
  const CODEX_TOOLS = ["shell", "apply_patch", "read_file"];
  for (let d = 6; d >= 0; d--) {
    const sessions = WORLD.sessionsPerDay[d % WORLD.sessionsPerDay.length];
    for (let s = 0; s < sessions; s++) {
      const sessionId = `demo-session-${d}-${s}`, start = now - d * DAY - (3 + s * 4) * HOUR - Math.floor(r() * 40) * MIN, n = Math.round(WORLD.callsPerSession * (0.5 + r() * 0.7)), codex = (d + s) % 6 === 5, model = codex ? "gpt-5-codex" : pickModel();
      for (let i = 0; i < n; i++) {
        const [tool, server] = codex ? [CODEX_TOOLS[i % 3], null] as [string, null] : pick(), startedAt = start + i * (WORLD.callSeconds / 3 + 1 + Math.floor(r() * 5)) * MIN, durationMs = 200 + Math.floor(r() * (tool === "Bash" || tool === "shell" ? 22000 : 3000)), roll = r();
        const status = roll < 0.08 ? "error" : roll < 0.1 ? "denied" : roll < 0.11 ? "cancelled" : "success";
        const big = (tool === "Task" ? 6 : 1) * scale, keep = Math.round(WORLD.cacheHit * 100) / 100;
        out.push({ source, provider: codex ? "codex" : "claude", sessionId, callId: `demo-call-${d}-${s}-${i}`, turnId: `demo-turn-${d}-${s}-${Math.floor(i / 3)}`, parentCallId: null, model, tool, server, status, startedAt, endedAt: startedAt + durationMs, durationMs, durationKind: "provider", errorCode: status === "error" ? (r() < 0.5 ? "exit_1" : "timeout") : null,
          usage: { input: Math.round(400 * big + r() * 900), output: Math.round(120 * big + r() * 700), cacheRead: Math.round((9000 * big + r() * 30000) * keep), cacheWrite5m: Math.round(r() * 4000 * (1.2 - keep)), cacheWrite1h: r() < 0.2 ? Math.floor(r() * 3000) : 0 } });
      }
    }
  }
  // two calls still running so the Calls tab shows live rows
  for (let i = 0; i < 2; i++) out.push({ source, provider: "claude", sessionId: "demo-session-live", callId: `demo-call-live-${i}`, turnId: "demo-turn-live", parentCallId: null, model: MODELS[1], tool: i ? "Edit" : "Bash", server: null, status: "running", startedAt: now - (i + 1) * 20_000, endedAt: null, durationMs: null, durationKind: "unknown", errorCode: null });
  return out;
}

// ---- git -------------------------------------------------------------------------------------------------------------------
export const demoRepos = (): GitRepo[] => [{ path: DEMO_REPO, name: "demo-repo", source: "bb-project", branch: DEMO_BRANCH, head: DEMO_HEAD.slice(0, 8), dirty: 3 }];
let commitCache: { now: number; commits: GitCommit[] } | null = null;
const SIDE_TIPS = (() => { const tips = new Map<number, number>(); WORLD.commits.forEach((c, i) => { if (c.side >= 0 && !tips.has(c.side)) tips.set(c.side, i); }); return tips; })();
const TAG_AT = Math.floor(WORLD.commits.length * 0.6);
const shaAt = (i: number) => (i === 0 ? DEMO_HEAD : hex40(i + 100));
/** The month of commits from the world, newest first: a trunk, short side branches that merge back (the profile sets how many), each with its parents. */
export function demoCommits(now: number): GitCommit[] {
  if (commitCache?.now === now) return commitCache.commits;
  const cs: CommitSeed[] = WORLD.commits, n = cs.length, commits: GitCommit[] = cs.map((c, i) => {
    let nm = i + 1; while (nm < n && cs[nm].side >= 0) nm++; // next trunk commit
    const parents = c.side >= 0 ? (i + 1 < n ? [shaAt(i + 1)] : []) : c.merge ? [...(nm < n ? [shaAt(nm)] : []), ...(i + 1 < n ? [shaAt(i + 1)] : [])] : nm < n ? [shaAt(nm)] : [];
    const at = now - Math.round(c.daysAgo * DAY), refs: string[] = i === 0 ? ["HEAD -> main", "origin/main"] : [];
    for (const [side, tip] of SIDE_TIPS) if (tip === i) refs.push(WORLD.sideBranches[side]);
    if (i === TAG_AT) refs.push("tag: v0.1.0");
    return { sha: shaAt(i), parents, author: AUTHORS[i % 3], authoredAt: at, committedAt: at, subject: c.subject, refs };
  });
  commitCache = { now, commits };
  return commits;
}
export function demoGraph(now: number, scope: "all" | "main", limit = 300): GitGraph {
  const commits = demoCommits(now).slice(0, limit), refs: GitRef[] = [{ name: "main", kind: "local", sha: DEMO_HEAD, committedAt: now }, { name: "origin/main", kind: "remote", sha: DEMO_HEAD, committedAt: now }, { name: "v0.1.0", kind: "tag", sha: commits[TAG_AT]?.sha ?? DEMO_HEAD, committedAt: commits[TAG_AT]?.committedAt ?? now }];
  for (const [side, tip] of SIDE_TIPS) refs.push({ name: WORLD.sideBranches[side], kind: "local", sha: commits[tip]?.sha ?? DEMO_HEAD, committedAt: commits[tip]?.committedAt ?? now });
  return { repo: DEMO_REPO, head: DEMO_HEAD, branch: DEMO_BRANCH, mainRef: "main", latestLocal: "main", scope, limit, truncated: false, commits, refs };
}
export const demoStatus = (): GitStatus => ({ repo: DEMO_REPO, branch: DEMO_BRANCH, upstream: "origin/main", ahead: 2, behind: 0, entries: [{ path: "src/export/Pipeline.tsx", x: " ", y: "M" }, { path: "src/export/usePipeline.ts", x: "M", y: " " }, { path: "notes/ideas.md", x: "?", y: "?" }], truncated: false });
export function demoCommitDetail(now: number, sha: string): GitCommitDetail {
  const c = demoCommits(now).find(x => x.sha === sha || x.sha.startsWith(sha)) ?? demoCommits(now)[0];
  return { sha: c.sha, parents: c.parents, author: c.author, authoredAt: c.authoredAt, committedAt: c.committedAt, subject: c.subject, body: "Demo commit body.\n\nThis text is part of the demo data and was not read from any repository.", files: [{ path: "src/export/Pipeline.tsx", additions: 42, deletions: 7, binary: false }, { path: "src/export/usePipeline.ts", additions: 18, deletions: 3, binary: false }, { path: "docs/export.md", additions: 9, deletions: 0, binary: false }], filesTruncated: false };
}
export function demoFileDiff(path: string): FileDiff {
  return { path, oldPath: null, kind: "text", oldMode: null, newMode: null, truncated: false, omittedLines: 0, hunks: [{ header: "@@ -1,4 +1,6 @@", oldStart: 1, oldLines: 4, newStart: 1, newLines: 6, section: "Pipeline", lines: [
    { kind: "ctx", text: "export function Pipeline() {", oldNo: 1, newNo: 1 }, { kind: "del", text: "  const items = [];", oldNo: 2, newNo: null }, { kind: "add", text: "  const { items, total } = usePipeline();", oldNo: null, newNo: 2 }, { kind: "add", text: "  if (!items.length) return <EmptyState />;", oldNo: null, newNo: 3 }, { kind: "ctx", text: "  return <List items={items} />;", oldNo: 3, newNo: 4 }, { kind: "ctx", text: "}", oldNo: 4, newNo: 5 }] }] };
}
export function demoDayCounts(now: number, days = 90): DayCounts {
  const counts: Record<string, number> = {}; let total = 0;
  for (const c of demoCommits(now)) { const k = dayKey(c.committedAt); counts[k] = (counts[k] ?? 0) + 1; total++; }
  return { repo: DEMO_REPO, from: dayKey(now - (days - 1) * DAY), to: dayKey(now), days, counts, total, truncated: false };
}
export function demoDayCommits(now: number, date: string, limit = 200): DayCommits {
  const commits: DayCommit[] = demoCommits(now).filter(c => dayKey(c.committedAt) === date).slice(0, limit).map(c => ({ ...c, source: "main" }));
  return { repo: DEMO_REPO, date, commits, truncated: false, limit };
}
export function demoMentions(now: number) { return demoCommits(now).filter(c => /demo-/.test(c.subject)).slice(0, 8).map(c => ({ sha: c.sha, subject: c.subject, author: c.author, committedAt: c.committedAt })); }
export function demoRepoHealth(now: number): RepoHealth {
  return { head: DEMO_HEAD, branch: DEMO_BRANCH, behind: { indexHead: hex40(1), count: 4, capped: false }, unpushed: { count: 2, capped: false }, uncommitted: { staged: 1, unstaged: 1, untracked: 1, sample: ["src/export/Pipeline.tsx", "src/export/usePipeline.ts", "notes/ideas.md"] },
    unremoted: [{ branch: "demo-2-cache", count: 3 }], unremotedCapped: false, unremotedCommits: 3,
    worktrees: [...WORLD.panes.slice(0, 2).map((p, i) => ({ path: p.cwd.split("/").pop()!, branch: WORLD.team.find(t => t.bead === p.beadId)?.branch ?? "main", missing: false, locked: i === 0, lastCommitAt: now - (2 + i * 3) * HOUR })), { path: "demo-repo-old", branch: "demo-spike-old", missing: true, locked: false, lastCommitAt: now - 9 * DAY }], worktreeTotal: 3,
    wrap: { sha: hex40(9), at: now - 30 * HOUR, subject: "docs(state): wrap the session" } };
}

// ---- spine (threads, calendar, health, projects) -----------------------------------------------------------------------------
/** Raw JSON (the parsers in spine-index.ts and projects.ts validate it). */
export function demoSpineIndexJson(now: number) {
  const d = (ago: number) => dayKey(now - Math.round(ago) * DAY), W = WORLD;
  const adrLink = (x: (typeof W.decisions)[number]) => ({ id: x.id, title: `${x.id} · ${x.title}`, where: "repo" as const, path: `docs/decisions.md#L${x.line}` });
  const GLYPH = { active: "▶", parked: "⏸", emergency: "!", debt: "◇", done: "✓", other: "·" } as const;
  const commitEvents = demoCommits(now).filter(c => !/^merge/.test(c.subject)).map(c => ({ date: dayKey(c.committedAt), kind: "commit" as const, title: c.subject, ref: c.sha, threadIds: [] as string[], source: "hot" as const }));
  return {
    schemaVersion: 1, generatedAt: iso(now), repo: { path: DEMO_REPO, head: DEMO_HEAD, branch: DEMO_BRANCH },
    router: { path: "hygiene.md", artifacts: [
      { name: "Hot state", path: "docs/hot-state.md", question: "What did I touch this session?", exists: true }, { name: "Workstreams", path: "docs/workstreams.md", question: "What am I juggling?", exists: true },
      { name: "Project log", path: "docs/project-log.md", question: "What happened?", exists: true }, { name: "Decisions", path: "docs/decisions.md", question: "Why is it this way?", exists: true }] },
    threads: W.threads.map(t => ({ id: t.id, title: `${t.id} · ${t.title}`, status: t.status, statusGlyph: GLYPH[t.status], line: t.line, ...(t.resume ? { resume: t.resume } : {}), refs: ["docs/project-log.md"], adrs: W.decisions.filter(x => x.thread === t.id).map(adrLink) })),
    calendar: [
      ...commitEvents,
      ...W.logs.map((l, k) => ({ date: d(l.daysAgo), kind: "log" as const, title: l.title, ref: `docs/project-log.md#L${5 + k * 7}`, threadIds: [l.thread], source: l.daysAgo > 21 ? "cold" as const : "hot" as const })),
      ...W.decisions.map(x => ({ date: d(x.daysAgo), kind: "decision" as const, title: `${x.id} · ${x.title}`, ref: `docs/decisions.md#L${x.line}`, threadIds: [x.thread], source: x.daysAgo > 21 ? "cold" as const : "hot" as const })),
      ...W.threads.filter(t => t.status === "done").map(t => ({ date: d(t.doneDaysAgo ?? 5), kind: "thread-done" as const, title: `${t.title} shipped`, ref: `docs/workstreams.md#L${t.line}`, threadIds: [t.id], source: "hot" as const }))],
    health: [
      { check: "hot-state-size", status: "pass", detail: "hot-state.md is a per-session file; warn above 150 lines", measured: "24 lines", value: 24, limit: 150, unit: "lines" },
      { check: "board-size", status: "warn", detail: "workstreams.md line count; warn above 100", measured: `${W.threads.length * 14 + 12} lines, ${W.threads.length} threads`, value: W.threads.length * 14 + 12, limit: 100, unit: "lines", total: W.threads.length },
      { check: "decisions-index", status: "pass", detail: "every decision has a date", measured: `${W.decisions.length} decisions`, value: W.decisions.length },
      { check: "stale-threads", status: "fail", detail: "a parked thread older than 14 days is a decision to make", measured: `${W.threads.filter(t => t.status === "parked").length} parked`, value: W.threads.filter(t => t.status === "parked").length, limit: 1 },
      { check: "emergency-open", status: W.threads.some(t => t.status === "emergency") ? "warn" : "pass", detail: "an emergency thread should be closed within a week", measured: `${W.threads.filter(t => t.status === "emergency").length} open`, value: W.threads.filter(t => t.status === "emergency").length, limit: 1 }],
    cold: [], adrs: W.decisions.map(adrLink),
  };
}
export function demoDocSection(ref: string): DocSection {
  const [path, line] = ref.split("#L"), x = WORLD.decisions.find(y => y.line === Number(line)) ?? WORLD.decisions[0];
  return { path: path || "docs/decisions.md", line: x.line, heading: `${x.id} · ${x.title}`, text: `## ${x.id} · ${x.title}\n\nStatus: ${x.status}.\n\nWhy: ${x.why}\n\nOptions:\n- A. ${x.options[0]}\n- B. ${x.options[1]}\n- C. ${x.options[2]}\n`, truncated: false, shas: [] };
}
export function demoProjectsJson(now: number) {
  const today = dayKey(now), proj = (id: string, name: string, group: string, level: string, one: string) => ({
    schema_version: 2, project: { id, name, domain: group, one_liner: one, health: { level, why: level === "green" ? "On track" : "A decision is waiting" }, freshness: today },
    overview: { current_outcome: "First release", next_milestone: "Checkout works end to end", next_action: "Finish the export pipeline", waiting_on: level === "green" ? null : "Owner decision", latest_delivery: "Export prototype" },
    outcomes: [{ id: `${id}-o1`, title: "First release", summary: "Ship a usable storefront", horizon: "medium", status: "active", provenance: "demo", verification: null, evidence: [], source: null }],
    work: [{ id: `${id}-w1`, outcome: `${id}-o1`, standalone_reason: null, title: "Build the export pipeline", state_line: "In progress", next_action: "Wire the retry policy", status: "now", horizon: "short", waiting_on: null, date: { value: today, kind: "due" }, provenance: "demo", verification: null, evidence: [], refs: [], detail: null, source: null },
      { id: `${id}-w2`, outcome: `${id}-o1`, standalone_reason: null, title: "Write the setup guide", state_line: "Done", next_action: null, status: "done", horizon: "short", waiting_on: null, date: { value: today, kind: "done" }, provenance: "demo", verification: null, evidence: [], refs: [], detail: null, source: null }],
    shipped: [{ title: "Setup guide", date: today, verification: null, evidence: [] }], reconciled: [], unknowns: [] });
  return [proj("demo-store", "Demo Store", "SaaS", "green", "A small storefront used for the demo"), proj("demo-site", "Demo Site", "Clients", "amber", "A marketing site for a made-up client"), proj("demo-notes", "Demo Notes", "Personal", "green", "A notes app experiment")];
}

// ---- transcripts (fed to the REAL telemetry and fleet pipeline through an in-memory file system) -------------------------------------
export const DEMO_TRANSCRIPT_ROOT = "/demo/claude-projects";
/** Token size multiplier for the transcript rows: real agent requests carry large cached contexts, so the demo spend lands near a believable day. */
const USAGE_X = 4;
const hex16 = (n: number) => hex40(n).slice(0, 16);
/** path -> text. Main sessions per bead plus named teammate sub-agents, over seven days; the newest rows are within the last minutes so a few lanes read live. */
export function demoTranscripts(now: number): { files: Map<string, string>; mtimes: Map<string, number> } {
  const files = new Map<string, string>(), mtimes = new Map<string, number>(), r = lcg(99), proj = `${DEMO_TRANSCRIPT_ROOT}/-demo-repo`;
  const rowsFor = (sessionId: string, cwd: string, branch: string, startAt: number, count: number, gapMs: number, model: string, user: string, tools: boolean, asks = false) => {
    const lines: string[] = [JSON.stringify({ type: "user", sessionId, cwd, gitBranch: branch, timestamp: iso(startAt), message: { role: "user", content: user } })];
    let last = startAt;
    for (let i = 0; i < count; i++) {
      const at = startAt + (i + 1) * gapMs, cold = i === 0, uid = `tool-${sessionId.slice(-6)}-${i}`; last = at;
      const content: unknown[] = [{ type: "text", text: "demo" }];
      if (tools && i % 2 === 0) content.push({ type: "tool_use", id: uid, name: i % 4 === 0 ? "Bash" : "Edit", input: {} });
      lines.push(JSON.stringify({ type: "assistant", sessionId, cwd, gitBranch: branch, timestamp: iso(at), requestId: `req-${sessionId.slice(-6)}-${i}`, message: { id: `msg-${sessionId.slice(-6)}-${i}`, model, stop_reason: i === count - 1 ? "end_turn" : "tool_use", content,
        usage: { input_tokens: 300 + Math.floor(r() * 900), output_tokens: Math.floor((150 + r() * 900) * USAGE_X), cache_creation_input_tokens: cold ? 18000 : Math.floor(r() * 2500 * USAGE_X), cache_read_input_tokens: cold ? 0 : Math.floor((20000 + r() * 60000) * USAGE_X * WORLD.cacheHit), cache_creation: { ephemeral_5m_input_tokens: cold ? 18000 : Math.floor(r() * 2500 * USAGE_X), ephemeral_1h_input_tokens: 0 } } } }));
      if (tools && i % 2 === 0 && i < count - 1) lines.push(JSON.stringify({ type: "user", sessionId, cwd, gitBranch: branch, timestamp: iso(at + 4000), message: { role: "user", content: [{ type: "tool_result", tool_use_id: uid, content: "ok" }] } }));
    }
    // a lane that ended on a question to the owner: an AskUserQuestion with no answer yet reads as "waiting for you"
    if (asks) { last += 2000; lines.push(JSON.stringify({ type: "assistant", sessionId, cwd, gitBranch: branch, timestamp: iso(last), requestId: `req-${sessionId.slice(-6)}-ask`, message: { id: `msg-${sessionId.slice(-6)}-ask`, model, stop_reason: "tool_use", content: [{ type: "tool_use", id: `tool-${sessionId.slice(-6)}-ask`, name: "AskUserQuestion", input: {} }], usage: { input_tokens: 300, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 40000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } } })); }
    return { text: lines.join("\n") + "\n", last };
  };
  const put = (path: string, text: string, mtime: number) => { files.set(path, text); mtimes.set(path, mtime); };
  // finished main sessions, a few per day (the profile sets how many and how long), each tagged to a bead
  const beads = WORLD.beads.filter(b => b.type !== "epic" && b.status !== "open").map(b => b.id);
  for (let d = 6; d >= 1; d--) for (let s = 0; s < WORLD.sessionsPerDay[d % WORLD.sessionsPerDay.length]; s++) {
    const id = `demo-main-${d}-${s}`, start = now - d * DAY - (2 + s * 5) * HOUR, bead = beads[(d * 3 + s) % beads.length], model = (d + s) % 3 === 0 ? MODELS[0] : MODELS[1];
    const x = rowsFor(id, "/demo/work/demo-repo", `feat/${bead}`, start, 30 + Math.floor(WORLD.sessionMinutes * 4 * (0.6 + r())), 90_000, model, `Work on bead=${bead} in the demo repo`, false);
    put(`${proj}/${id}.jsonl`, x.text, x.last);
  }
  // today: live lanes. The lead is the main session; every other lane is a named teammate under it.
  const lead = WORLD.team[0];
  const mainLive = rowsFor("demo-main-live", "/demo/work/demo-repo", lead.branch, now - lead.startedMinAgo * MIN, 22, ((lead.startedMinAgo * 60 - lead.lastWriteSecAgo) / 22) * 1000, lead.model, `Coordinate the first epic bead=${lead.bead}`, true);
  put(`${proj}/demo-main-live.jsonl`, mainLive.text, now - lead.lastWriteSecAgo * 1000);
  WORLD.team.slice(1).forEach((t, i) => {
    const agentId = `a${t.name}-${hex16(i + 5)}`, base = `${proj}/demo-main-live/subagents/agent-${agentId}`, cwd = `/demo/work/demo-repo-${t.name.replace(/^(lane|review)-/, "")}`;
    const rows = 8 + (i % 4) * 3, x = rowsFor("demo-main-live", cwd, t.branch, now - t.startedMinAgo * MIN, rows, ((t.startedMinAgo * 60 - t.lastWriteSecAgo - (t.asks ? 2 : 0)) / rows) * 1000, t.model, `${t.desc} bead=${t.bead}`, true, t.asks);
    put(`${base}.jsonl`, x.text, now - t.lastWriteSecAgo * 1000);
    put(`${base}.meta.json`, JSON.stringify({ name: t.name, agentType: "general-purpose", description: `${t.desc} bead=${t.bead}`, model: t.model.includes("opus") ? "opus" : "sonnet", worktreePath: cwd }), now);
  });
  return { files, mtimes };
}
export const DEMO_MODEL_USE = MODELS;

/** The Codex sessions the fleet reads next to the Claude transcripts: shaped like the real feed's headers, with invented ids. */
export function demoCodex(now: number): CodexSession[] {
  return WORLD.codex.map(c => ({ id: c.id, startedAt: now - c.startedMinAgo * MIN, cwd: `/demo/work/demo-repo-${c.name.replace("lane-", "")}`, branch: c.branch, model: c.model, parentId: null, nickname: c.name, lastAt: now - c.lastWriteMinAgo * MIN }));
}

/** The fleet-incidents ledger the Home surface reads: one open, one closed, so both states draw. */
export function demoIncidents(now: number): LedgerRead {
  return { state: "ok", dropped: 0, incidents: [
    { id: "demo-inc-1", title: "A demo agent stopped without releasing its claim", date: dayKey(now - 2 * DAY), evidence: ["demo-3"], rootCause: "The pretend agent was closed mid-task, so its claim stayed on the work item.", pin: null, status: "open" },
    { id: "demo-inc-2", title: "A pretend build gate ran twice", date: dayKey(now - 5 * DAY), evidence: ["demo-7"], rootCause: "Two demo lanes picked the same work item.", pin: { kind: "test", path: "demo/__tests__/demo.test.ts", owner: "demo-lane" }, status: "closed" },
  ] };
}
/** Local changes for the History > Worktree tab. */
export function demoWorktreeStats(): { staged: GitFileStat[]; unstaged: GitFileStat[] } {
  return { staged: [{ path: "src/export/Pipeline.tsx", additions: 12, deletions: 3, binary: false }], unstaged: [{ path: "src/export/EmptyState.tsx", additions: 8, deletions: 0, binary: false }, { path: "README.md", additions: 2, deletions: 1, binary: false }] };
}
