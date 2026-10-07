// The demo world generator. Input: demo/profile.json (aggregate numbers of real usage, nothing else) + a seed. Output: the synthetic world
// the fixture serves: beads with statuses, priorities, epics and a blocking chain; a month of commits (per-day volume, type mix and side
// branches follow the profile); decisions D-01.. with dates, options and calendar entries; threads; the agent team; call volume and cost.
// Every string comes from the neutral word lists below. Pure and deterministic: the same profile and seed always give the same world
// (demo.test.ts pins that), and there is no clock, no Math.random, no node import and no I/O, so the browser bundle can read it too.
import type { Profile } from "./profile-schema.ts";

export const SEED = 20261007;
/** Small deterministic generator (no Math.random): the same seed always gives the same demo. */
export function lcg(seed: number): () => number { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

// ---- neutral vocabulary (invented, product-like, nothing from any real project) ---------------------------------------------
const NOUNS = ["export pipeline", "settings page", "retry policy", "search index", "billing summary", "notification digest", "audit log", "onboarding checklist", "rate limiter", "import wizard", "session timeout", "dashboard filters", "team invites", "webhook delivery", "image resizer", "report scheduler", "password reset", "dark theme", "keyboard shortcuts", "usage chart", "file uploader", "status page", "profile editor", "email templates", "API tokens", "activity feed", "bulk actions", "cart totals", "feature flags", "release notes", "role permissions", "data backup", "language picker", "invoice download", "comment threads", "saved views", "offline mode", "health checks", "tag manager", "calendar sync", "mobile menu", "error pages"];
const VERBS = ["Build", "Add", "Wire", "Design", "Refactor", "Document", "Test", "Cache", "Fix", "Trim", "Migrate", "Profile", "Harden", "Polish", "Speed up", "Review"];
const EPICS = ["Launch the reporting suite", "Reliability and speed", "Docs and onboarding", "Team collaboration", "Billing and plans", "Mobile polish"];
const DECISIONS: { title: string; options: [string, string, string]; why: string }[] = [
  { title: "Keep exports as CSV only for now", options: ["CSV only", "CSV and Excel", "CSV, Excel and PDF"], why: "Most requests so far are for CSV; the other formats double the test surface." },
  { title: "Retry failed webhooks three times", options: ["Three retries", "Five retries", "Retry until it works"], why: "Three covers a short outage without hammering a customer endpoint." },
  { title: "Soft-delete records for thirty days", options: ["Delete at once", "Thirty days", "Ninety days"], why: "A grace period is cheap and removes a whole class of support requests." },
  { title: "One shared error type for every route", options: ["One shared type", "A type per route", "Keep as is"], why: "A single shape lets the client show one consistent message." },
  { title: "Dark theme ships as the default", options: ["Dark by default", "Follow the system", "Light by default"], why: "Most of the audience works in dark editors; the system setting still wins when set." },
  { title: "Cache the catalogue for five minutes", options: ["Two minutes", "Five minutes", "Fifteen minutes"], why: "Five minutes keeps the page fast while a price change still lands quickly." },
  { title: "Paginate with cursors, never offsets", options: ["Cursors", "Offsets", "Both"], why: "Cursors stay correct while rows are added; offsets skip and repeat." },
  { title: "Invite links expire after seven days", options: ["One day", "Seven days", "Never"], why: "A week matches how long invitations usually sit unread." },
  { title: "Feature flags live in one config file", options: ["One file", "A flag service", "Environment variables"], why: "A file is reviewable in a pull request and needs no new service." },
  { title: "Support two languages at launch", options: ["One language", "Two languages", "Five languages"], why: "Two proves the pipeline; more can follow once strings are stable." },
  { title: "Run load tests before every release", options: ["Every release", "Monthly", "Only on request"], why: "A failing run is cheaper than a slow release." },
  { title: "Keep the changelog in the repository", options: ["In the repository", "In a wiki", "Generated from commits"], why: "It travels with the code and shows up in review." },
];
const THREAD_TITLES = ["Reporting suite", "Reliability and speed", "Docs and onboarding", "Team collaboration", "Billing and plans", "Image upload timeout", "Dependency upgrades", "First design pass", "Search suggestions", "Mobile polish", "Release checklist", "Accessibility sweep"];
const SCOPES = ["search", "export", "billing", "docs", "settings", "api", "ui", "auth", "cache", "email", "upload", "reports"];
const COMMIT_VERBS: Record<string, string[]> = {
  feat: ["introduce", "support", "build"], fix: ["fix", "repair", "stop"], docs: ["document", "explain", "update notes for"], chore: ["bump", "tidy", "clean up"], test: ["cover", "add tests for", "pin"],
  refactor: ["simplify", "extract", "rename"], perf: ["speed up", "cache", "trim"], style: ["tidy", "align", "format"], other: ["adjust", "revisit", "touch up"],
};
export const MODEL_IDS = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", fable: "claude-fable-5-1", haiku: "claude-haiku-4-5", other: "claude-sonnet-5-5" } as const;
const CODEX_MODEL = "gpt-5-codex";
export const TEAM_NAMES = ["lane-export", "lane-search", "lane-billing", "lane-docs", "lane-upload", "lane-reports", "lane-mobile"];
export const LEAD_NAME = "lead-alpha";
export const REVIEWER_NAMES = ["review-beta", "review-gamma"];

// ---- types ------------------------------------------------------------------------------------------------------------------
export type BeadStatus = "open" | "in_progress" | "closed" | "blocked" | "deferred";
/** Times are offsets before `now`: created/updated in days, started in hours. */
export interface BeadSeed { id: string; title: string; type: string; status: BeadStatus; p: number; parent: string | null; labels?: string[]; assignee?: string | null; created: number; updated: number; started?: number | null; anomaly?: string }
export interface DepSeed { issueId: string; dependsOnId: string; type: "parent-child" | "blocks" }
export interface PaneSeed { paneId: string; title: string; cwd: string; beadId: string }
export interface DecisionSeed { id: string; title: string; daysAgo: number; status: "active" | "superseded"; options: [string, string, string]; why: string; line: number; thread: string }
export interface ThreadSeed { id: string; title: string; status: "active" | "parked" | "emergency" | "debt" | "done" | "other"; line: number; resume?: string; doneDaysAgo?: number }
export interface LogSeed { daysAgo: number; title: string; thread: string }
export interface CommitSeed { daysAgo: number; subject: string; kind: string; side: number; merge: boolean }
export interface LaneSeed { name: string; role: "lead" | "worker" | "reviewer"; bead: string; model: string; branch: string; startedMinAgo: number; lastWriteSecAgo: number; desc: string; asks?: boolean }
export interface CodexSeed { id: string; name: string; model: string; branch: string; startedMinAgo: number; lastWriteMinAgo: number }
export interface World {
  seed: number;
  beads: BeadSeed[]; deps: DepSeed[]; panes: PaneSeed[];
  decisions: DecisionSeed[]; threads: ThreadSeed[]; logs: LogSeed[];
  commits: CommitSeed[]; sideBranches: string[];
  team: LaneSeed[]; codex: CodexSeed[]; modelWeights: { id: string; w: number }[];
  /** Finished main sessions per day (index 0 = yesterday), calls per session, and the dollar scale the transcripts are tuned to. */
  sessionsPerDay: number[]; callsPerSession: number; costScalePerDay: number; cacheHit: number;
  /** Typical durations from the profile, used to pace sessions and calls. */
  sessionMinutes: number; callSeconds: number;
}

// ---- helpers ----------------------------------------------------------------------------------------------------------------
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
/** Largest-remainder rounding: integer counts that follow `weights` and add up to `total`. */
function apportion(weights: readonly number[], total: number): number[] {
  const w = sum(weights) || 1, raw = weights.map(x => (x / w) * total), out = raw.map(Math.floor);
  let left = total - sum(out);
  raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]).forEach(([, i]) => { if (left-- > 0) out[i]++; });
  return out;
}
function shuffle<T>(xs: readonly T[], r: () => number): T[] { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const weighted = <T>(items: readonly T[], weights: readonly number[], r: () => number): T => { let t = r() * (sum(weights) || 1); for (let i = 0; i < items.length; i++) { t -= weights[i]; if (t <= 0) return items[i]; } return items[items.length - 1]; };

// ---- the world --------------------------------------------------------------------------------------------------------------
export function generateWorld(profile: Profile, seed: number = SEED): World {
  const r = lcg(seed);
  const total = clamp(Math.round(profile.beads.total / 4), 36, 48);

  // epics: sizes sampled from the profile's size buckets, scaled so the epics hold about 85% of the beads
  const epicCount = clamp(Math.round(profile.epics.count / 4), 3, 6), buckets = profile.epics.sizeBuckets, bw = [buckets.s1to3, buckets.s4to7, buckets.s8to15, buckets.s16plus];
  const base = Array.from({ length: epicCount }, () => weighted([2, 5, 8, 11], bw.some(x => x > 0) ? bw : [1, 1, 1, 1], r));
  const kidsTotal = Math.round((total - epicCount) * 0.85), sizes = apportion(base, kidsTotal).map(x => Math.max(2, x));
  const standalone = Math.max(1, total - epicCount - sum(sizes));

  // titles, drawn once each so no two beads share one
  const titlePool = shuffle(NOUNS.flatMap(n => [n]), r).map((n, i) => `${VERBS[(i * 5 + Math.floor(r() * 3)) % VERBS.length]} the ${n}`);
  const nextTitle = (() => { let i = 0; return () => titlePool[i++ % titlePool.length]; })();

  const nonEpic = sum(sizes) + standalone;
  const statusKeys: BeadStatus[] = ["open", "in_progress", "closed", "blocked", "deferred"], sw = statusKeys.map(k => profile.beads.byStatus[k]);
  // the profile is mostly open/closed; keep that shape but guarantee a working board (some in progress, some blocked, one deferred)
  const wanted = apportion(sw.map((x, i) => x + [0.08, 0, 0, 0.05, 0.03][i] * (sum(sw) || 1)), nonEpic);
  const statusPool = shuffle(statusKeys.flatMap((k, i) => Array<BeadStatus>(wanted[i]).fill(k)), r);
  const pw = ["p0", "p1", "p2", "p3", "p4"].map((k, i) => (profile.beads.byPriority as Record<string, number>)[k] / (sum(Object.values(profile.beads.byPriority)) || 1) * 0.5 + [0.06, 0.2, 0.5, 0.18, 0.06][i] * 0.5);
  const prio = () => weighted([0, 1, 2, 3, 4], pw, r);

  const beads: BeadSeed[] = [], deps: DepSeed[] = [];
  const day = (lo: number, hi: number) => Math.round((lo + r() * (hi - lo)) * 10) / 10;
  const mk = (id: string, parent: string | null, type: string): BeadSeed => {
    const status = statusPool.pop() ?? "open", created = day(2, 24);
    const updated = status === "closed" ? day(0.5, Math.max(0.6, created - 0.2)) : day(0.1, Math.min(created, 8));
    return { id, title: nextTitle(), type, status, p: prio(), parent, created, updated: Math.max(0.05, Math.min(updated, created)), started: status === "in_progress" || status === "closed" ? day(1, Math.max(2, Math.min(created * 24 - 2, 90))) : null };
  };
  EPICS.slice(0, epicCount).forEach((title, e) => {
    const id = `demo-${e + 1}`, created = day(18, 26);
    beads.push({ id, title, type: "epic", status: "in_progress", p: e === 0 ? 1 : 2, parent: null, created, updated: day(0.1, 2), started: day(24, 60) });
    for (let k = 1; k <= sizes[e]; k++) { const b = mk(`${id}.${k}`, id, "task"); beads.push(b); deps.push({ issueId: b.id, dependsOnId: id, type: "parent-child" }); }
  });
  for (let k = 0; k < standalone; k++) beads.push(mk(`demo-${epicCount + 1 + k}`, null, "task"));

  // types: bugs, a chore and features follow the profile; decisions are placed below
  const kids = beads.filter(b => b.type === "task"), tk = ["bug", "feature", "chore"] as const, tw = tk.map(k => profile.beads.byType[k] + 1);
  const typeCounts = apportion(tw, clamp(Math.round(kids.length * 0.18), 3, 9));
  shuffle(kids, r).slice(0, sum(typeCounts)).forEach((b, i) => { b.type = tk[typeCounts.findIndex((_, j) => i < sum(typeCounts.slice(0, j + 1)))]; });

  // guarantees the surfaces need, applied to open work only
  const open = () => kids.filter(b => b.status === "open");
  const take = (n: number, f: (b: BeadSeed) => boolean = () => true) => shuffle(kids.filter(f), r).slice(0, n);
  const ensure = (b: BeadSeed | undefined, f: (b: BeadSeed) => void) => { if (b) f(b); return b; };
  // owner decisions (Needs you) and one CRIT
  take(3, b => b.status === "open" && b.type !== "bug").forEach((b, i) => { b.type = "decision"; b.title = ["Decide: ship dark theme as the default?", "Decide: keep exports as CSV only?", "Decide: allow guest checkout?"][i]; b.labels = ["owner-decision"]; b.p = i === 0 ? 1 : 2; b.created = day(3, 12); b.updated = b.created; });
  ensure(take(1, b => b.status === "open" && b.type === "bug")[0] ?? take(1, b => b.status === "open" && b.type === "task")[0], b => { b.type = "bug"; b.title = "Fix the image upload timeout"; b.p = 0; b.labels = ["crit"]; b.created = day(1, 4); b.updated = b.created; });
  // two beads waiting on review, one deferred
  take(2, b => b.status === "open" && !b.labels?.length).forEach(b => { b.labels = ["needs-dual-gate"]; b.updated = day(0.2, 1); });
  ensure(take(1, b => b.status === "deferred")[0] ?? take(1, b => b.status === "open" && !b.labels?.length)[0], b => { b.status = "deferred"; b.p = 4; });
  // the agent team holds the first in-progress beads (a pane each), then two more claims that show as warnings
  const doing = shuffle(kids.filter(b => b.status === "in_progress"), r), spare = shuffle(open().filter(b => !b.labels?.length), r);
  while (doing.length < 6 && spare.length) { const b = spare.pop()!; b.status = "in_progress"; b.started = day(1, 20); doing.push(b); }
  const teamSize = clamp(Math.round(profile.agents.byRole.worker / Math.max(1, profile.agents.byRole.worker + profile.agents.byRole.lead + profile.agents.byRole.reviewer) * 7), 4, 5);
  const workers = doing.slice(0, teamSize), lanes = TEAM_NAMES.slice(0, teamSize);
  workers.forEach((b, i) => { b.assignee = lanes[i]; b.updated = day(0.05, 0.4); });
  const stale = doing.slice(teamSize, teamSize + 2);
  stale.forEach((b, i) => { b.assignee = ["lane-old", "lane-spike"][i]; b.anomaly = i === 0 ? "orphan-claim" : "stale-claim"; b.updated = day(1, 3); });
  // closed beads keep a finished look
  beads.filter(b => b.status === "closed").forEach(b => { b.assignee = null; });

  // a blocking chain as deep as the profile's, plus fan-in edges up to its edge density
  const depthWanted = clamp(profile.deps.maxDepth, 2, 3), chain = [workers[0], ...shuffle(open().filter(b => !b.labels?.length && b.type === "task"), r).slice(0, depthWanted)].filter((b): b is BeadSeed => !!b);
  for (let i = 1; i < chain.length; i++) deps.push({ issueId: chain[i].id, dependsOnId: chain[i - 1].id, type: "blocks" });
  const edgesWanted = clamp(Math.round(profile.deps.blockEdgesPerBead * total) + 3, 4, 9), seen = new Set(deps.map(d => `${d.issueId}>${d.dependsOnId}`));
  for (const b of shuffle(open().filter(x => !chain.includes(x)), r)) {
    if (deps.filter(d => d.type === "blocks").length >= edgesWanted) break;
    const by = weighted(workers, workers.map(() => 1), r), k = `${b.id}>${by.id}`;
    if (!seen.has(k)) { seen.add(k); deps.push({ issueId: b.id, dependsOnId: by.id, type: "blocks" }); }
  }
  // one explicitly blocked-status bead for the board's blocked colour
  ensure(beads.find(b => b.status === "blocked"), b => { b.updated = day(0.5, 3); if (!deps.some(d => d.issueId === b.id && d.type === "blocks")) deps.push({ issueId: b.id, dependsOnId: workers[0].id, type: "blocks" }); });
  const panes: PaneSeed[] = workers.map((b, i) => ({ paneId: `demo:w1.p${i + 1}`, title: `${lanes[i]} · ${b.title.replace(/^[A-Za-z ]+? the /, "")}`, cwd: `/demo/work/demo-repo-${lanes[i].replace("lane-", "")}`, beadId: b.id }));

  // ---- commits: a month, per-day volume and type mix from the profile ------------------------------------------------------
  const perDay = profile.commits.perDay, commitTotal = clamp(Math.round(sum(perDay) / 25), 60, 130), counts = apportion(perDay.map(x => x + 0.0001), commitTotal);
  const tkeys = ["feat", "fix", "docs", "chore", "test", "refactor", "perf", "style", "other"], tweights = tkeys.map(k => (profile.commits.typeMix as Record<string, number>)[k] + 0.02);
  const commits: CommitSeed[] = [];
  counts.forEach((n, i) => { const ago = perDay.length - 1 - i; for (let k = 0; k < n; k++) commits.push({ daysAgo: ago + ((k + 0.5) / n) * 0.9, subject: "", kind: "", side: -1, merge: false }); });
  commits.sort((a, b) => a.daysAgo - b.daysAgo); // newest first
  const sideShare = clamp(1 - profile.commits.branchShare.top1, 0.1, 0.3), sideBranches = ["demo-2-cache", "demo-1-cart"];
  // side runs of 2..3 commits, each ending in a merge commit just above it on the trunk
  let i = 4, run = 0;
  while (i < commits.length - 6 && run < sideBranches.length * 3) {
    const len = 2 + Math.floor(r() * 2);
    if (r() < sideShare * 2.2) { commits[i - 1].merge = true; for (let k = 0; k < len; k++) commits[i + k].side = run % sideBranches.length; run++; i += len + 4; } else i += 3;
  }
  commits.forEach((c, idx) => {
    c.kind = c.merge ? "merge" : weighted(tkeys, tweights, r);
    const scope = SCOPES[Math.floor(r() * SCOPES.length)], noun = NOUNS[Math.floor(r() * NOUNS.length)];
    if (c.merge) c.subject = `merge: ${sideBranches[Math.max(0, commits[idx + 1]?.side ?? 0)] ?? "side branch"}`;
    else { const v = COMMIT_VERBS[c.kind] ?? COMMIT_VERBS.other; c.subject = `${c.kind}(${scope}): ${v[Math.floor(r() * v.length)]} ${noun}`; }
  });
  // a few subjects name a bead, so Mentions has rows
  commits.filter(c => !c.merge).forEach((c, k) => { if (k % 9 === 4) c.subject += ` (${beads[1 + (k % (beads.length - 1))].id})`; });

  // ---- decisions, threads, logs --------------------------------------------------------------------------------------------
  const decisionCount = clamp(sum(profile.decisions.perWeek) || 8, 8, 12), weekly = apportion(profile.decisions.perWeek.map(x => x + 0.5), decisionCount);
  const decisions: DecisionSeed[] = [];
  weekly.forEach((n, w) => { for (let k = 0; k < n; k++) decisions.push({ id: "", title: "", daysAgo: (profile.decisions.perWeek.length - 1 - w) * 7 + Math.floor(r() * 6), status: "active", options: ["", "", ""], why: "", line: 0, thread: "" }); });
  decisions.sort((a, b) => b.daysAgo - a.daysAgo); // oldest first so D-01 is the oldest
  const dpool = shuffle(DECISIONS, r);
  const threadCount = 10, tkeysS = ["active", "parked", "other", "debt", "done"] as const;
  const tcounts = apportion(tkeysS.map(k => profile.threads.byStatus[k] + 1), threadCount);
  const threadStatus = tkeysS.flatMap((k, j) => Array(tcounts[j]).fill(k)) as ThreadSeed["status"][];
  threadStatus.splice(Math.min(2, threadStatus.length - 1), 1, "emergency"); // one thread on fire
  const tt = shuffle(THREAD_TITLES, r);
  const threads: ThreadSeed[] = threadStatus.slice(0, threadCount).map((status, j) => ({ id: `W-${j + 1}`, title: tt[j % tt.length], status, line: 12 + j * 14, resume: status === "parked" ? "Waiting on the next planning session." : status === "active" ? "Next step is written in the thread." : undefined, doneDaysAgo: status === "done" ? 3 + Math.floor(r() * 10) : undefined }));
  decisions.forEach((d, j) => { const p = dpool[j % dpool.length]; Object.assign(d, { id: `D-${String(j + 1).padStart(2, "0")}`, title: p.title, options: p.options, why: p.why, line: 8 + j * 9, thread: threads[j % threads.length].id, status: j < 2 && decisions.length > 6 ? "superseded" : "active" }); });
  const logPool = ["Prototype demoed to the team", "Error tracking switched on", "Load test passed with headroom", "First customer feedback collected", "Release candidate tagged", "Support rota agreed", "Staging environment refreshed", "Backlog trimmed and re-ordered"];
  const perThreadDay = profile.threads.perDay, logCount = 9, logs: LogSeed[] = Array.from({ length: logCount }, (_, k) => ({ daysAgo: Math.floor((1 - Math.pow(r(), 1.4)) * (perThreadDay.length - 1)), title: logPool[k % logPool.length], thread: threads[Math.floor(r() * threads.length)].id })).sort((a, b) => a.daysAgo - b.daysAgo);

  // ---- agents --------------------------------------------------------------------------------------------------------------
  const mk5 = ["opus", "sonnet", "fable", "haiku"] as const, mw = mk5.map(k => profile.agents.byModel[k] + 0.5);
  const pickModel = () => MODEL_IDS[weighted(mk5, mw, r)];
  const codexShare = profile.agents.byRuntime.codex / Math.max(1, profile.agents.byRuntime.claude + profile.agents.byRuntime.codex);
  const codexN = clamp(Math.round(codexShare * 12), 1, 2);
  const team: LaneSeed[] = [{ name: LEAD_NAME, role: "lead", bead: "demo-1", model: MODEL_IDS.opus, branch: "main", startedMinAgo: 55, lastWriteSecAgo: 40, desc: "Coordinate the first epic" }];
  workers.forEach((b, j) => team.push({ name: lanes[j], role: "worker", bead: b.id, model: j === 0 ? MODEL_IDS.sonnet : pickModel(), branch: `feat/${b.id}-${lanes[j].replace("lane-", "")}`, startedMinAgo: 42 - j * 7, lastWriteSecAgo: 15 + j * 11, desc: b.title }));
  const reviewTarget = beads.find(b => b.labels?.includes("needs-dual-gate")) ?? workers[0];
  REVIEWER_NAMES.forEach((name, j) => team.push({ name, role: "reviewer", bead: reviewTarget.id, model: j === 0 ? MODEL_IDS.sonnet : MODEL_IDS.opus, branch: `review/${reviewTarget.id}`, startedMinAgo: j === 0 ? 40 : 20, lastWriteSecAgo: j === 0 ? 20 * 60 : 33, desc: `Review ${reviewTarget.title.toLowerCase()}`, asks: j === 0 }));
  const codex: CodexSeed[] = Array.from({ length: codexN }, (_, j) => ({ id: `demo-codex-${j + 1}`, name: ["lane-export", "lane-search"][j] ?? "lane-export", model: CODEX_MODEL, branch: `review/${workers[j % workers.length].id}`, startedMinAgo: 25 - j * 8, lastWriteMinAgo: 2 + j * 9 }));
  const mws = mk5.map(k => ({ id: MODEL_IDS[k], w: profile.cost.byModelShare[k] + 0.02 }));

  // ---- calls and cost --------------------------------------------------------------------------------------------------------
  const sessionsPerDay = Array.from({ length: 6 }, () => 2 + Math.floor(r() * 3));
  const costScalePerDay = clamp(profile.cost.perDayUsd.median, 20, 400);
  return { seed, beads, deps, panes, decisions, threads, logs, commits, sideBranches, team, codex, modelWeights: mws, sessionsPerDay, callsPerSession: clamp(Math.round(profile.durations.sessionMinutes.p90 / 2), 8, 24), costScalePerDay, cacheHit: clamp((profile.cost.cacheHit.lo + profile.cost.cacheHit.hi) / 2, 0.6, 0.95), sessionMinutes: clamp(profile.durations.sessionMinutes.p50, 3, 40), callSeconds: clamp(profile.durations.callSeconds.p50, 3, 40) };
}
