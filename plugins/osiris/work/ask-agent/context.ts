// "Ask an agent": PURE context builders, one per inspector selection kind. Each returns { title, prompt } built ONLY from data the inspector
// already holds (no readers, no raw transcript text). Every string is sealed (D-135): terminal escapes and secrets out, home paths -> "[path]",
// session/uuid-shaped ids -> "[id]". The prompt ends with one fixed read-only instruction block and is capped at ASK_CAP characters, lists
// shrinking with "+N more". Dispatch itself is work/herdr-dispatch (the ONE primitive); nothing here spawns or opens a dialog.
import type { AdrLink, SpineEvent, SpineHealth, SpineThread } from "../../spine-index.ts";
import type { GitCommitDetail } from "../../git-types.ts";
import type { HealthRow } from "../../health-types.ts";
import type { Call } from "../../analytics.ts";
import type { LedgerIncident } from "../fleet-ledger.ts";
import type { FleetLane } from "../fleet-types.ts";
import type { WorkSurfaceSnapshot } from "../surface-types.ts";
import { boardCards } from "../surface-model.ts";
import { redactForDisplay } from "../sanitize.ts";

export type AskContext = { title: string; prompt: string };
export const ASK_CAP = 6000;
export const ASK_INSTRUCTION = "Summarise this item, list the adjacent items and how they connect, and say what matters for today. Read-only: do not edit files or the tracker.";
/** Per-CTA instruction blocks (Home): same read-only fence, different job. */
export const CHECK_INSTRUCTION = "Check this risk against the repo as it is now: say whether it is real, find the cause, and propose the smallest fix. Read-only: do not edit files or the tracker.";
export const INVESTIGATE_INSTRUCTION = "Investigate why this tool keeps failing: find the likely cause from the details above and propose a fix or a route around it. Read-only: do not edit files or the tracker.";
export const EFFICIENCY_INSTRUCTION = "Work out why this costs so many tokens and propose the smallest change that cuts it (a capped read, a hand-off, a script, a cheaper model). Do not weaken any gate or test. Read-only: do not edit files or the tracker.";
export const ROUTE_AROUND_INSTRUCTION = "Check whether the pin named above still holds, then propose a route around this incident or a fix for it. Read-only: do not edit files or the tracker.";
const ITEM_MAX = 220, LIST_START = 25;

/** The one sealing step: secrets and escapes out, then home paths, uuids and long session-like ids masked. */
export const seal = (s: unknown, max = ITEM_MAX): string => redactForDisplay(String(s ?? ""), max)
  .replace(/(?:~|\/(?:Users|home))(?:\/[^\s'"`)\]>,;]*)+/g, "[path]")
  .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]")
  .replace(/\b(?:agent-|session[-_ ]?)?[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\b/g, w => (w.length >= 24 && /[A-Za-z]/.test(w) ? "[id]" : w))
  .replace(/\s+/g, " ").trim();

type Section = { label: string; items: string[] };
const render = (head: string[], sections: Section[], limit: number): string => [
  ...head,
  ...sections.map(s => s.items.length === 0 ? `${s.label}: none` : `${s.label} (${s.items.length}):\n${s.items.slice(0, limit).map(i => `- ${i}`).join("\n")}${s.items.length > limit ? `\n- +${s.items.length - limit} more` : ""}`),
].join("\n");

/** head lines + lists -> prompt. Lists are cut with "+N more" until the body fits; the instruction block is never cut. */
export function compose(title: string, head: string[], sections: Section[], instruction: string = ASK_INSTRUCTION): AskContext {
  const tail = `\n\n${instruction}`, room = ASK_CAP - tail.length;
  let limit = LIST_START, body = render(head, sections, limit);
  while (body.length > room && limit > 1) { limit = Math.max(1, Math.floor(limit / 2)); body = render(head, sections, limit); }
  if (body.length > room) body = `${body.slice(0, room - 12).trimEnd()}\n[truncated]`;
  return { title: seal(title, 60), prompt: body + tail };
}

const ev = (e: SpineEvent) => seal(`${e.kind}: ${e.title}${e.threadIds.length ? ` [${e.threadIds.join(", ")}]` : ""}`);

export type DayAsk = { date: string; today: string; commits: { sha: string; subject: string; source?: string | null }[]; events: readonly SpineEvent[]; threads: readonly SpineThread[] };
/** A calendar day: its commits, threads, decisions and log, plus the active threads it touched that still carry over to today. */
export function dayContext(d: DayAsk): AskContext {
  const kind = (k: SpineEvent["kind"]) => d.events.filter(e => e.kind === k).map(ev);
  const touched = new Set(d.events.flatMap(e => e.threadIds));
  const carry = d.threads.filter(t => touched.has(t.id) && t.status !== "done").map(t => seal(`${t.id} ${t.title} (${t.status})`));
  return compose(`Day ${d.date}`, [`Calendar day ${seal(d.date, 12)}. Today is ${seal(d.today, 12)}${d.date === d.today ? " (this is today)" : ""}.`], [
    { label: "Commits", items: d.commits.map(c => seal(`${c.sha.slice(0, 8)} ${c.subject}${c.source ? ` [${c.source}]` : ""}`)) },
    { label: "Threads finished", items: kind("thread-done") }, { label: "Decisions", items: kind("decision") }, { label: "Log entries", items: kind("log") },
    { label: "Still open and carried to today", items: carry },
  ]);
}

/** A bead: itself, its parent/epic and siblings, blockers both ways, claim/agent, and any commits the caller already holds that reference it. */
export function beadContext(snap: WorkSurfaceSnapshot, id: string, now: number, commits: { sha: string; subject: string }[] = []): AskContext | null {
  const i = snap.issues.find(x => x.id === id); if (!i) return null;
  const card = boardCards(snap, now).find(c => c.id === id), parent = i.parent ? snap.issues.find(x => x.id === i.parent) : null;
  const node = snap.tree.flatMap(r => r.nodes).find(n => n.id === id && n.agent) ?? null;
  const link = (l: { id: string; title: string; status: string }) => seal(`${l.id} ${l.title} (${l.status})`);
  return compose(`Bead ${i.id}`, [seal(`Bead ${i.id}: ${i.title}`), `Status ${seal(i.status, 20)}, priority ${i.priority}, type ${seal(i.type, 20)}.`, `Claimed by: ${i.assignee ? seal(i.assignee, 60) : "nobody"}.`,
    `Agent pane: ${node?.agent ? seal([node.agent.title, node.agent.state].filter(Boolean).join(" ")) : "none"}.`, `Parent / epic: ${parent ? link(parent) : "none"}.`, i.labels.length ? `Labels: ${seal(i.labels.join(", "))}.` : "Labels: none."], [
    { label: "Waiting on", items: (card?.blockedBy ?? []).map(link) }, { label: "Unblocks", items: (card?.unblocks ?? []).map(link) },
    { label: "Siblings under the same parent", items: i.parent ? snap.issues.filter(x => x.parent === i.parent && x.id !== id).map(link) : [] },
    { label: "Recent commits that reference it", items: commits.map(c => seal(`${c.sha.slice(0, 8)} ${c.subject}`)) },
  ]);
}

const REF_LINE = /^(?:Refs?|Closes|Fixes|Bead|Wrap)\s*:\s*(.+)$/gim;
/** A commit: message, the thread/bead references in subject and body, and the files it changed. */
export function commitContext(d: GitCommitDetail): AskContext {
  const refs = [...`${d.subject}\n${d.body}`.matchAll(/\b(?:W-\d+|[a-z]{2,6}-[a-z0-9]{2,5}(?:\.\d+)?)\b/g)].map(m => m[0]).filter(r => /\d/.test(r));
  const lines = [...d.body.matchAll(REF_LINE)].map(m => seal(m[1], 120));
  return compose(`Commit ${d.sha.slice(0, 8)}`, [seal(`Commit ${d.sha.slice(0, 8)} by ${d.author}: ${d.subject}`), `Parents: ${d.parents.length}.`, d.body.trim() ? `Message body: ${seal(d.body, 700)}` : "Message body: none."], [
    { label: "Thread and bead references", items: [...new Set([...refs, ...lines])].map(r => seal(r)) },
    { label: "Files changed", items: d.files.map(f => seal(`${f.path}${f.binary ? " (binary)" : ` +${f.additions ?? "?"} -${f.deletions ?? "?"}`}`)) },
  ]);
}

/** A Spine thread: status, resume line, refs, ADRs and its calendar events. */
export function threadContext(t: SpineThread, events: readonly SpineEvent[]): AskContext {
  return compose(`Thread ${t.id}`, [seal(`Thread ${t.id}: ${t.title}`), `Status ${t.status}.`, t.resume ? seal(`Resume line: ${t.resume}`, 400) : "Resume line: none."], [
    { label: "Decisions and ADRs", items: t.adrs.map(a => seal(`${a.id} ${a.title}`)) }, { label: "Refs", items: t.refs.map(r => seal(r)) },
    { label: "Calendar entries", items: events.filter(e => e.threadIds.includes(t.id)).map(e => seal(`${e.date} ${ev(e)}`)) },
  ]);
}

/** An ADR / decision and the threads that cite it. */
export function adrContext(a: AdrLink, threads: readonly SpineThread[]): AskContext {
  return compose(`Decision ${a.id}`, [seal(`Decision ${a.id}: ${a.title}`), `Lives in the ${a.where === "vault" ? "vault" : "repo"}.`], [
    { label: "Threads that cite it", items: threads.filter(t => t.adrs.some(x => x.id === a.id)).map(t => seal(`${t.id} ${t.title} (${t.status})`)) },
  ]);
}

/** An agent / fleet row. The lane key (a session id) is deliberately NOT included. */
export function fleetContext(l: FleetLane, parent: FleetLane | null = null, children: readonly FleetLane[] = []): AskContext {
  return compose(`Agent ${l.label}`, [seal(`Agent ${l.label}: ${l.runtime} ${l.kind}, role ${l.role}, state ${l.state}.`), `Model: ${seal(l.model ?? "unknown", 60)}. Requests: ${l.requests}.`,
    `Workspace: ${seal(l.workspace ?? "unknown", 80)}, branch ${seal(l.branch ?? "unknown", 80)}. Bead: ${seal(l.beadId ?? "none", 60)}.`,
    l.waiting ? `Waiting for a person: ${l.waiting}.` : "Not waiting on a person.", l.now ? `Now: ${seal(l.now.tool, 60)}${l.now.running ? " (running)" : ""}.` : "Now: unknown.", `Spawned by: ${parent ? seal(parent.label) : "none recorded"}.`], [
    { label: "Sub-agents", items: children.map(c => seal(`${c.label} (${c.state})`)) },
  ]);
}

/** One tool call: identity-free (no call/session id, no input). Neighbours are the calls the inspector already lists as context. */
export function callAskContext(c: Call, neighbours: readonly Call[] = [], instruction: string = ASK_INSTRUCTION): AskContext {
  const n = (x: Call) => seal(`${x.tool} ${x.status}${x.durationMs === null ? "" : ` ${x.durationMs}ms`}`);
  return compose(`Call ${c.tool}`, [seal(`Tool call ${c.tool}: ${c.status}, ${c.server ?? c.provider}.`), `Duration: ${c.durationMs === null ? "unknown" : `${c.durationMs} ms (${c.durationKind})`}. Model: ${seal(c.model ?? "unknown", 60)}.`, c.errorCode ? `Error category: ${seal(c.errorCode, 60)}.` : "No error recorded."], [
    { label: "Neighbouring calls in the same lane", items: neighbours.map(n) },
  ], instruction);
}

/** A Health row (board) or a Spine health check. */
export function healthContext(r: HealthRow, instruction: string = ASK_INSTRUCTION): AskContext {
  return compose(`Health ${r.title}`, [seal(`Health item: ${r.title} (${r.status}, ${r.group}).`), seal(`Figure: ${r.figure}`), r.why ? seal(`Why it matters: ${r.why}`, 400) : "Why it matters: not stated.",
    r.fix ? seal(`Suggested fix: ${r.fix.label}${r.fix.command ? ` (${r.fix.command})` : ""}`, 400) : "Suggested fix: none.", r.trend ? `Trend: ${r.trend.direction} since ${seal(r.trend.since, 20)}.` : "Trend: none."], [
    { label: "Detail lines", items: (r.detail ?? "").split("\n").filter(Boolean).map(l => seal(l)) },
  ], instruction);
}
export function healthCheckContext(h: SpineHealth): AskContext {
  return compose(`Health ${h.check}`, [seal(`Health check ${h.check}: ${h.status}.`), seal(`Measured: ${h.measured || "n/a"}. Detail: ${h.detail || "n/a"}`, 500), h.limit !== undefined ? `Limit: ${h.limit}${h.unit ? ` ${seal(h.unit, 12)}` : ""}.` : "Limit: not set."], []);
}

/** A run-ledger incident (docs/ai/state/fleet-incidents.json): title, root cause, evidence and the pin's path. Every field sealed; the agent is told to check the pin. */
export function incidentContext(i: LedgerIncident): AskContext {
  return compose(`Incident ${i.id}`, [seal(`Fleet incident ${i.id}: ${i.title} (${i.status}, ${i.date}).`), seal(`Root cause: ${i.rootCause || "not recorded"}`, 500),
    seal(`Pin: ${i.pin ? `${i.pin.kind} at ${i.pin.path}${i.pin.pattern ? ` matching ${i.pin.pattern}` : ""}, owner ${i.pin.owner}` : "none recorded"}`, 400)], [
    { label: "Evidence", items: i.evidence.map(e => seal(e)) },
  ], ROUTE_AROUND_INSTRUCTION);
}

/** A Token efficiency row (D-140): sizes, counts, lane/tool/model names and file basenames only, all sealed. */
export type EfficiencyAsk = { topic: string; facts: readonly string[]; why: string };
export function efficiencyContext(e: EfficiencyAsk): AskContext {
  return compose(`Token cost: ${e.topic}`, [seal(`Token efficiency finding: ${e.topic}.`), seal(`Why it costs: ${e.why}`, 400)], [{ label: "Numbers", items: e.facts.map(f => seal(f)) }], EFFICIENCY_INSTRUCTION);
}
