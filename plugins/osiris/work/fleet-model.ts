// Fleet model (pure, no fs, takes `now`): every agent lane on this machine -> a FleetSnapshot (contract: fleet-types.ts).
// Inputs are the Claude transcript sources (ALL files, including ones with no usage rows yet: a just-started agent is live) from
// transcript-feed.ts fleetSourcesFromState, the Codex sessions from codex-feed.ts, and the bead join (lane key -> bead id).
// PRIVACY: output is ids, lane names, model ids, short workspace names, timestamps and numbers. A cwd / worktreePath is
// reduced to workspaceName() (repo or repo/worktree) and never copied; every string passes cleanText.
import { rowCost } from "../cache-economics.ts";
import type { FleetSource } from "../transcript-feed.ts";
import type { CodexSession } from "./codex-feed.ts";
import type { GeminiSession } from "./providers/gemini-feed.ts";
import { providerLabel } from "./providers/registry.ts";
import { FLEET_IDLE_MS, FLEET_KINDS, FLEET_LIVE_MS, FLEET_MAX_LANES, FLEET_MAX_MESSAGES, FLEET_MAX_NAMES, FLEET_QUESTION_MS, FLEET_QUESTION_TOOLS, FLEET_SPARK_BUCKETS, FLEET_SPARK_MS, FLEET_WAITING } from "./fleet-types.ts";
import type { FleetCount, FleetKind, FleetLane, FleetNow, FleetWaiting, LastTool, LastTurn, MessageEvent, OpenTool, FleetRole, FleetRuntime, FleetSnapshot, FleetState, LabelFrom } from "./fleet-types.ts";
import { agentIdentity, type IdentitySource } from "./agent-identity.ts";
import { buildFlowModel } from "./message-flow-model.ts";
import { modelTier } from "./model-tiers.ts";
import { cleanText, redactForDisplay, redactSecrets } from "./sanitize.ts";

export interface FleetInput {
  files: readonly FleetSource[];
  codex: readonly CodexSession[];
  /** Gemini CLI sessions (providers/gemini-feed.ts). Optional: an older caller has none. */
  gemini?: readonly GeminiSession[];
  /** Lane key (agentId, else main session id, else Codex session id) -> the bead id its lane is assigned. */
  beadByKey?: ReadonlyMap<string, string>;
  /** The user's home directory, so a lane sitting in it reads "~". */
  home?: string;
  /** Agent message events (transcript-feed messageEventsFromState), carried through unchanged. */
  messages?: readonly MessageEvent[];
}

const LABEL_MAX = 64;
const trimSlash = (p: string) => p.replace(/[\\/]+$/, "");
const baseName = (p: string) => trimSlash(p).split(/[\\/]/).pop() ?? "";
/** Short display name for a working directory: `repo/worktree` for a `.claude/worktrees/<wt>` checkout, `owner/dir` for a `*-worktrees/<dir>`
 *  sibling checkout (osiris-worktrees/tooldash -> osiris/tooldash), `~` for home, else the directory's own name. Null when nothing is known. */
export function workspaceName(path: string | null | undefined, home?: string): string | null {
  const p = path ? trimSlash(path) : "";
  if (!p) return null;
  if (home && p === trimSlash(home)) return "~";
  const wt = /^(.*)\/\.claude\/worktrees\/([^/]+)/.exec(p);
  if (wt) { const repo = baseName(wt[1]); return repo ? `${repo}/${wt[2]}` : wt[2]; }
  const base = baseName(p), parent = baseName(p.slice(0, p.length - base.length));
  if (base && /-worktrees$/.test(parent)) return `${parent.replace(/-worktrees$/, "")}/${base}`;
  return base || null;
}

const LABEL_FROM: Record<IdentitySource, LabelFrom> = { name: "lane", description: "description", pane: "pane", tag: "id" };
const clean = (s: string | null | undefined, max = LABEL_MAX): string | null => { const o = cleanText(s ?? "", max).trim(); return o ? o : null; };
/** Free text that leaves the server (lane name, workspace, branch): secrets redacted BEFORE the length cap (review MED-1). */
const safe = (s: string | null | undefined, max = LABEL_MAX): string | null => { const o = redactForDisplay(s ?? "", max).trim(); return o ? o : null; }; // canonicalize BEFORE redact (td-osi.37 / Codex B2)
/** A lastAt more than a day ahead of `now` is a bogus clock, not "live forever" (review LOW-5). */
const SKEW_MS = 86_400_000;
const stateOf = (lastAt: number | null, now: number): FleetState => {
  if (lastAt === null) return "done";
  const age = now - Math.min(lastAt, now); // a future timestamp is "now"
  return age < FLEET_LIVE_MS ? "live" : age < FLEET_IDLE_MS ? "idle" : "done";
};
const WAITING_LABEL: Record<FleetWaiting, string> = { question: "Question", permission: "Permission", "your-turn": "Your turn", message: "Unread message" };
/** Why a lane needs a person, or null (td-osi.21.2). Never for a done lane (quiet over an hour: an orphaned prompt is not a need), so a
 *  waiting lane is never counted as done. Order: question, your-turn, message. `permission` is reserved: nothing on disk marks a pending
 *  permission prompt (it looks like a running tool), so it is never produced here. `unreadAt`: when the shared idle-unanswered flag
 *  (message-flow-model) found an unanswered inbound message for this lane. */
function waitingOf(r: Raw, state: FleetState, now: number, unreadAt: number | undefined): { waiting: FleetWaiting; since: number } | null {
  if (state === "done") return null;
  // A reader still catching up on a big file holds history, not the present: the question and your-turn reads wait for the tail (Codex M3).
  if (r.atTail) {
    // An open tool is open until ITS OWN tool_result arrives (an interrupt writes one). A sibling finishing is not evidence about it (Codex M2).
    const asks = r.open.filter(t => FLEET_QUESTION_TOOLS.includes(t.tool) && now - t.at > FLEET_QUESTION_MS);
    if (asks.length) return { waiting: "question", since: Math.min(...asks.map(t => t.at)) };
    if (r.isMain && r.runtime === "claude" && r.lastTurn && r.lastTurn.role === "assistant" && r.lastTurn.endTurn) return { waiting: "your-turn", since: Math.min(r.lastTurn.at, now) };
  }
  if (unreadAt !== undefined) return { waiting: "message", since: unreadAt };
  return null;
}
/** What a lane is doing now. Tool names and times only. Codex lanes have no open / lastTool (the session header feed has no per-call data),
 *  so they are null; a lane whose file the reader has not caught up on is null too (its tools are history).
 *  Evidence is per tool id: an open tool (no tool_result of its own) is running, and the NEWEST one wins; a closed sibling never cancels it.
 *  A DONE lane is never running: its open tool reads finished, since the lane's last write. An IDLE lane can still be running: a lead blocked
 *  on a long Agent call writes nothing for minutes. */
/** Fire-and-forget tools: their result is often never written (172 of 189 orphan opens on disk end on SendMessage), so past a short grace
 *  they read finished, not running (review-last MED-1). An expired one yields to a newer completed call (Codex N1). */
const INSTANT_TOOLS: readonly string[] = ["SendMessage", "SubagentHandback"], INSTANT_GRACE_MS = 60_000;
function nowOf(r: Raw, state: FleetState, lastAt: number | null, now: number): FleetNow | null {
  if (!r.atTail) return null;
  const expired = (t: OpenTool) => INSTANT_TOOLS.includes(t.tool) && now - t.at > INSTANT_GRACE_MS, newest = (ts: readonly OpenTool[]) => ts.reduce<OpenTool | null>((m, t) => (m === null || t.at >= m.at ? t : m), null);
  const o = newest(r.open.filter(t => !expired(t))), e = newest(r.open.filter(expired)), c = r.lastTool;
  if (o) return state !== "done" ? { tool: o.tool, since: o.at, running: true } : { tool: o.tool, since: lastAt ?? o.at, running: false };
  if (e && (!c || e.at >= c.endedAt)) return { tool: e.tool, since: e.at, running: false };
  return c ? { tool: c.tool, since: c.endedAt, running: false } : null;
}
const REVIEWER = /review|verif|critic|audit|codex-rescue/i, LEAD = /lead|captain/i;
const ROLE_LABEL: Record<FleetRole, string> = { main: "Main session", lead: "Lead", worker: "Worker", reviewer: "Reviewer" };
const STATE_RANK: Record<FleetState, number> = { live: 0, idle: 1, done: 2 };
const KIND_LABEL: Record<FleetKind, string> = { main: "Main sessions", teammate: "Teammates", subagent: "Subagents", workflow: "Workflow agents", codex: "Codex" };
/** Kind from the shapes on disk: no agent id = a main session; meta taskKind / a lane name (meta.name or the `a<name>-<16hex>` id) = a
 *  teammate; a workflow-subagent agentType or a workflowPhase = a workflow agent; any other agent file = a plain subagent. */
function kindOf(f: FleetSource): FleetKind {
  if (f.agentId === null) return "main";
  if (f.meta.agentType === "workflow-subagent" || f.meta.workflowPhase !== null) return "workflow";
  if (f.meta.taskKind === "in_process_teammate" || f.meta.name !== null || /^a.+-[0-9a-f]{16}$/.test(f.agentId)) return "teammate";
  return "subagent";
}

interface Raw {
  key: string; runtime: FleetRuntime; name: string | null; kind: FleetKind; agentType: string | null; parentKey: string | null; isMain: boolean;
  model: string | null; workspace: string | null; branch: string | null; firstAt: number | null; lastAt: number | null;
  rows: FleetSource["rows"]; description?: string | null;
  open: readonly OpenTool[]; lastTurn: LastTurn | null; lastTool: LastTool | null;
  /** False while the transcript reader has not reached the file's tail: open / lastTurn / lastTool describe history (td-osi.37 / Codex M3). */
  atTail: boolean;
}
function mostUsed(models: (string | null)[]): string | null {
  const c = new Map<string, number>();
  for (const m of models) if (m) c.set(m, (c.get(m) ?? 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;
}

/** Every lane, counted, then sorted (live, idle, done; newest first) and capped at FLEET_MAX_LANES. Summary counts cover ALL lanes. */
export function buildFleet(input: FleetInput, now: number): FleetSnapshot {
  const raws: Raw[] = [];
  for (const f of input.files) {
    const key = f.agentId ?? f.sessionId;
    raws.push({
      key, runtime: "claude", name: f.lane, description: f.meta.description, kind: kindOf(f), agentType: f.meta.agentType,
      parentKey: f.agentId === null ? null : f.meta.parentAgentId ?? f.sessionId, isMain: f.agentId === null,
      model: mostUsed(f.rows.map(r => r.model)) ?? f.meta.model, workspace: workspaceName(f.meta.worktreePath ?? f.cwd, input.home), branch: f.gitBranch,
      firstAt: f.firstAt, lastAt: f.rows.reduce<number | null>((m, r) => (r.timestamp !== null && r.timestamp <= (f.lastAt ?? now) + SKEW_MS && (m === null || r.timestamp > m) ? r.timestamp : m), f.lastAt), rows: f.rows,
      open: f.open ?? [], lastTurn: f.lastTurn ?? null, lastTool: f.lastTool ?? null, atTail: f.atTail ?? true,
    });
  }
  for (const c of input.codex)
    raws.push({
      key: c.id, runtime: "codex", name: c.nickname, kind: "codex", agentType: null, parentKey: c.parentId, isMain: c.parentId === null,
      model: c.model, workspace: workspaceName(c.cwd, input.home), branch: c.branch, firstAt: c.startedAt, lastAt: c.lastAt, rows: [], open: [], lastTurn: null, lastTool: null, atTail: true,
    });
  for (const g of input.gemini ?? [])
    raws.push({
      key: g.id, runtime: g.runtime, name: null, kind: g.kind === "subagent" ? "subagent" : "main", agentType: null, parentKey: g.parentId, isMain: g.parentId === null,
      model: g.model, workspace: g.projectId ? `gemini/${g.projectId}` : null, branch: null, firstAt: g.startedAt, lastAt: g.lastAt, rows: [], open: [], lastTurn: null, lastTool: null, atTail: true,
    });
  // One lane per key (review MED-2): the same agentId can sit under two session dirs (measured: 29 of 711 agent files). Keep the file
  // with the most rows (ties: newest), widen first/last to cover both, so counts, React keys, the name index and bead join stay 1:1.
  const byKey = new Map<string, Raw>();
  for (const r of raws) {
    const had = byKey.get(r.key);
    if (!had) { byKey.set(r.key, r); continue; }
    const keep = r.rows.length > had.rows.length || (r.rows.length === had.rows.length && (r.lastAt ?? -Infinity) > (had.lastAt ?? -Infinity)) ? r : had;
    const min = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b)), max = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));
    byKey.set(r.key, { ...keep, firstAt: min(had.firstAt, r.firstAt), lastAt: max(had.lastAt, r.lastAt) });
  }
  raws.length = 0; raws.push(...byKey.values());
  const parents = new Set(raws.flatMap(r => (r.parentKey ? [r.parentKey] : [])));
  const hourAgo = now - FLEET_SPARK_BUCKETS * FLEET_SPARK_MS;
  let burn = 0, burnPriced = false;

  const lanes: FleetLane[] = raws.map(r => {
    const workspace = safe(r.workspace), lastAt = r.lastAt !== null && r.lastAt > now + SKEW_MS ? r.rows.reduce<number | null>((m, x) => (x.timestamp !== null && x.timestamp <= now + SKEW_MS && (m === null || x.timestamp > m) ? x.timestamp : m), null) : r.lastAt;
    const role: FleetRole = r.isMain ? "main" : parents.has(r.key) || (r.name && LEAD.test(r.name)) ? "lead" : REVIEWER.test(`${r.name ?? ""} ${r.agentType ?? ""}`) ? "reviewer" : "worker";
    // WHO the agent is (work/agent-identity.ts), never the workspace: lane name, else description, else a short tag.
    const idn = agentIdentity({ key: r.key, name: r.name, description: r.description, provider: r.runtime });
    const label = idn.label, labelFrom: LabelFrom = LABEL_FROM[idn.source];
    const spark = new Array<number>(FLEET_SPARK_BUCKETS).fill(0);
    let tokensIn = 0, tokensOut = 0, priced = 0, unpriced = false;
    for (const row of r.rows) {
      tokensIn += row.input + row.cacheWrite5m + row.cacheWrite1h + row.cacheRead; tokensOut += row.output;
      const c = rowCost(row);
      if (c === null) unpriced = true; else priced += c;
      if (row.timestamp !== null && row.timestamp >= hourAgo) {
        spark[Math.max(0, Math.min(FLEET_SPARK_BUCKETS - 1, Math.floor((Math.min(row.timestamp, now) - hourAgo) / FLEET_SPARK_MS)))]++;
        if (c !== null) { burn += c; burnPriced = true; }
      }
    }
    const tier = modelTier(r.model), bead = input.beadByKey?.get(r.key) ?? null;
    return {
      key: clean(r.key, 128) ?? r.key, runtime: r.runtime, label, labelFrom, kind: r.kind, parentKey: r.parentKey ? safe(r.parentKey, 128) : null, role,
      model: clean(r.model, 40), modelKey: tier.key, modelLetter: tier.letter, workspace, branch: safe(r.branch, 80), beadId: clean(bead),
      firstAt: r.firstAt, lastAt, state: stateOf(lastAt, now), requests: r.rows.length, tokensIn, tokensOut,
      costUsd: r.runtime !== "claude" || unpriced ? null : priced, pricedUsd: priced, spark,
    };
  });

  // Waiting: the "message" reason reuses the flow model's idle-unanswered flag (ONE definition of "idle with an unanswered message").
  const unreadAt = new Map<string, number>();
  if (input.messages?.length)
    for (const f of buildFlowModel(input.messages, lanes.map(l => ({ key: l.key, label: l.label, state: l.state, lastAt: l.lastAt })), now).flags)
      if (f.kind === "idle-unanswered" && f.laneKey) unreadAt.set(f.laneKey, f.at);
  lanes.forEach((l, i) => { const w = waitingOf(raws[i], l.state, now, unreadAt.get(l.key)); l.waiting = w?.waiting ?? null; l.waitingSince = w?.since ?? null; l.now = nowOf(raws[i], l.state, l.lastAt, now); });
  const tally = (keyOf: (l: FleetLane) => { key: string; label: string; letter?: string }): FleetCount[] => {
    const m = new Map<string, FleetCount>();
    for (const l of lanes) {
      const k = keyOf(l), c = m.get(k.key) ?? { ...k, live: 0, idle: 0, total: 0 };
      c.total++; if (l.state === "live") c.live++; else if (l.state === "idle") c.idle++;
      m.set(k.key, c);
    }
    return [...m.values()].sort((a, b) => b.live - a.live || b.total - a.total || (a.key < b.key ? -1 : 1));
  };
  const count = (s: FleetState) => lanes.filter(l => l.state === s).length;
  const labelOfModel = (l: FleetLane) => modelTier(l.model).label;
  const sorted = [...lanes].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || (b.lastAt ?? 0) - (a.lastAt ?? 0) || (a.key < b.key ? -1 : 1));
  return {
    summary: {
      at: now, liveWindowMs: FLEET_LIVE_MS, idleWindowMs: FLEET_IDLE_MS, live: count("live"), idle: count("idle"), done: count("done"), total: lanes.length,
      byModel: tally(l => ({ key: l.modelKey, label: labelOfModel(l), letter: l.modelLetter })),
      byRole: tally(l => ({ key: l.role, label: ROLE_LABEL[l.role] })),
      byRuntime: tally(l => ({ key: l.runtime, label: providerLabel(l.runtime) })),
      byKind: FLEET_KINDS.map(k => ({ key: k, label: KIND_LABEL[k], live: lanes.filter(l => l.kind === k && l.state === "live").length, idle: lanes.filter(l => l.kind === k && l.state === "idle").length, total: lanes.filter(l => l.kind === k).length })),
      liveSpark: Array.from({ length: FLEET_SPARK_BUCKETS }, (_, i) => lanes.filter(l => l.spark[i] > 0 || (i === FLEET_SPARK_BUCKETS - 1 && l.state === "live")).length),
      burnUsdPerHour: burnPriced ? burn : null,
      needsYou: lanes.filter(l => l.waiting && l.waiting !== "message").length, // human blockers only: an unread agent message is not a person's job
      unread: lanes.filter(l => l.waiting === "message").length,
      byWaiting: FLEET_WAITING.flatMap(k => { const m = lanes.filter(l => l.waiting === k); return m.length ? [{ key: k, label: WAITING_LABEL[k], live: m.filter(l => l.state === "live").length, idle: m.filter(l => l.state === "idle").length, total: m.length }] : []; }),
    },
    ...(input.messages ? { messages: input.messages.slice(0, FLEET_MAX_MESSAGES) } : {}),
    lanes: sorted.slice(0, FLEET_MAX_LANES), truncated: sorted.length > FLEET_MAX_LANES,
    names: sorted.slice(0, FLEET_MAX_NAMES).map(l => ({ key: l.key, label: l.label, kind: l.kind, parentKey: l.parentKey, role: l.role, modelLetter: l.modelLetter, workspace: l.workspace, branch: l.branch, beadId: l.beadId, state: l.state, waiting: l.waiting, waitingSince: l.waitingSince, now: l.now })),
  };
}
