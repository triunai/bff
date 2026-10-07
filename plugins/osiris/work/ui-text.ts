// Pure wording + tone helpers for the Work surface components (no React, no colours: tones are names that map to --oi-tone-*).
import type {Tone} from "../ui-tokens.ts";
import {boardCards, formatAge, shortId} from "./surface-model.ts";
import {capitalise, termDef, termLabel, type TermKey} from "./glossary.ts";
import type {AnomalyRule, DecisionRow, DispatchResult, Kpis, Runtime, WorkSurfaceSnapshot} from "./surface-types.ts";

/** Browser-safe copy of runtimes.ts RUNTIMES / SUGGESTED_MODELS: runtimes.ts imports node:fs, which the app bundle cannot resolve
 *  (verified: bb plugin build fails). ui-text.test.ts pins this copy equal to the original so it cannot drift. */

export type KpiKey = "ready" | "active" | "blocked" | "review" | "stale" | "collision";
/** Blocked and collision above zero are real problems (failure); stale above zero needs a look (attention); everything else is calm. */
export function kpiTone(key: KpiKey, k: Kpis): Tone {
  if ((key === "blocked" && k.blocked > 0) || (key === "collision" && k.collision > 0)) return "failure";
  if (key === "stale" && k.stale > 0) return "attention";
  return "muted";
}
const n = (v: number, u: string) => `${v} ${u}${v === 1 ? "" : "s"}`;
/** Plain-English sub-line under each KPI number. */
export function kpiSub(key: KpiKey, k: Kpis): string {
  switch (key) {
    case "ready": return k.ready === 0 ? "Nothing is ready to start" : "Ready to start";
    case "active": return k.active === 0 ? "Nobody is working" : k.activeNoPane > 0 ? `${k.activeNoPane} claimed, no ${termLabel("pane")}` : `Every ${termLabel("claim")} has an ${termLabel("pane")}`;
    case "blocked": return k.blockedOldestMs === null ? "Nothing is blocked" : `oldest ${formatAge(k.blockedOldestMs)}`;
    case "review": return k.review === 0 ? "Nothing is waiting for review" : k.reviewTopP == null ? `${k.reviewUrgent} urgent` : `highest P${k.reviewTopP}`;
    case "stale": return k.stale === 0 ? `Nothing has ${termLabel("stale")}` : `${termLabel("claim")} or ${termLabel("pane")} ${termLabel("stale")}`;
    case "collision": return k.collision === 0 ? `No ${termLabel("collision")}s` : `${n(k.collision, termLabel("pane"))} claimed twice`;
  }
}

/** "waiting 3 days · carried over 4 sessions"; the carried-over part is dropped when no session has ended since. */
export function delayText(r: Pick<DecisionRow, "waitingMs" | "deferredSessions">): string {
  const w = `waiting ${formatAge(r.waitingMs)}`;
  return r.deferredSessions > 0 ? `${w} · carried over ${n(r.deferredSessions, "session")}` : w;
}
/** Two sessions carried over is worth a look; five means it is being avoided. */
export function delayTone(r: Pick<DecisionRow, "deferredSessions">): Tone {
  return r.deferredSessions >= 5 ? "failure" : r.deferredSessions >= 2 ? "attention" : "muted";
}
export const decisionKindText = (k: DecisionRow["kind"]) => (k === "crit" ? "Critical" : "Your decision");

const ANOMALY: Record<string, () => string> = {
  "orphan-claim": () => `Claimed, but no ${termLabel("pane")} is attached: a ${termLabel("ghost")}.`,
  "stale-pane": () => `The ${termLabel("pane")} is gone.`,
  "stale-claim": () => `The ${termLabel("claim")} has ${termLabel("stale")}: no sign of life within its ${termLabel("lease")}.`,
};
export const anomalyText = (rule: AnomalyRule): string => ANOMALY[rule]?.() ?? `Flagged by the tracker: ${rule}.`;
/** The glossary term an anomaly is about (its first appearance in a view carries the definition), or null for an unknown rule. */
const ANOMALY_TERM: Record<string, TermKey> = {"orphan-claim": "ghost", "stale-pane": "stale", "stale-claim": "lease"};
export const anomalyTerm = (rule: AnomalyRule): TermKey | null => ANOMALY_TERM[rule] ?? null;
/** Board lane tooltips that explain a lane in glossary terms; only the review lane has one. */
export const laneHelp = (lane: string): string | null => lane === "review" ? `${termDef("gate")} ${termDef("rework")}` : null;

/** The sentence the assign dialog shows before the confirm button. `branch` is null until the preview has loaded. */
export function dispatchStatement(o: {shortId: string; branch: string | null; runtime: Runtime; model: string | null}): string {
  return `Assigning ${o.shortId} to an agent claims it in the tracker (the only change Osiris makes there), creates a separate working copy on branch ${o.branch ?? "(shown once the preview loads)"}, and starts ${o.runtime} ${o.model ?? "(default model)"} in a new ${termLabel("pane")} in Herdr.`;
}
const STAGE: Record<string, string> = {validate: "checking the request", claim: `claiming the ${termLabel("bead")}`, worktree: "creating the working copy", pane: `opening the ${termLabel("pane")}`, launch: "starting the agent"};
/** Plain-English result: a headline plus one detail line. */
export function dispatchResultText(r: DispatchResult): {ok: boolean; headline: string; detail: string} {
  if (r.ok) return {ok: true, headline: "Assigned", detail: `Working on branch ${r.branch} in ${termLabel("pane")} ${r.paneId} (claimed by ${r.actor}).`};
  const headline = r.takenBy ? `${r.takenBy} already has it` : `Could not assign it while ${STAGE[r.stage] ?? r.stage}`;
  return {ok: false, headline, detail: r.reason};
}

/** Why assigning is disabled for a work item, as one plain sentence; null when it can be assigned (open, not waiting, not an epic). */
export function dispatchBlockReason(snap: WorkSurfaceSnapshot, id: string, now: number): string | null {
  const issue = snap.issues.find(i => i.id === id);
  const item = capitalise(termLabel("bead"));
  if (!issue) return `${item} is not in the tracker any more.`;
  if (issue.status === "closed") return `${item} is closed, so it cannot be assigned.`;
  if (issue.type === "epic") return `This is an epic, a group of ${termLabel("bead")}s: pick one of its child items instead.`;
  const card = boardCards(snap, now).find(c => c.id === id) ?? null;
  if (card?.workLane === "review") return `${item} is waiting for ${termLabel("gate")}, so it cannot be assigned.`;
  if (issue.status === "in_progress" || issue.assignee) return `${issue.assignee ?? "Someone"} has already claimed this ${termLabel("bead")}.`; // the server refuses any assigned bead
  if (card && card.blockedBy.length > 0) return `${item} is waiting on ${card.blockedBy.map(b => shortId(b.id)).join(", ")} to finish first.`;
  if (issue.status !== "open" || !card) return `${item} is not ready to be assigned yet.`;
  return null;
}
export const SANDBOX_HINT = "Try it on the sandbox tracker first";

/** The throttled-preview reason starts "preview again in ..."; the dialog retries by itself, and says so instead of going quiet. */
export const isThrottledPreview = (reason: string): boolean => /^preview again/.test(reason);
export function previewErrorText(reason: string): string {
  return isThrottledPreview(reason) ? `Cannot assign yet: ${reason}. This is a short pause between previews; the dialog tries again by itself, so you do not need to close it.` : `Cannot assign yet: ${reason}`;
}
