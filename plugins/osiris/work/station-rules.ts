// Station rules (pure, data): ONE table of what each Factory station means and its entry / exit conditions. The floor model
// places beads with `stationByRules` (the same `is` predicates the popover explains), so the explanation cannot drift from
// what the floor does. Also the per-bead checklist against our conditions (claim, pane, Refs trailer, review labels, pins,
// done-confidence from the evidence lane), each item ✓ / ✗ / unknown / not connected.
import type { Stage } from "./replay.ts";
import type { WorkIssue } from "./types.ts";
import { LABEL_NEEDS_DUAL_GATE, LABEL_RECONCILED } from "./work-model.ts";
import { LABEL_READY_TO_LAND } from "./surface-model.ts";
import { termLabel } from "./glossary.ts";

// Words come from the ONE glossary (work/glossary.ts, lane fix-plain-words): "pane" reads as its label, "agent terminal".
const PANE = termLabel("pane"), ITEMS = `${termLabel("bead")}s`;

export type StationId = "intake" | "claim" | "build" | "gate" | "land";
/** The labels that put an open bead at the Gate (the same list surface-model's review lane uses). */
export const REVIEW_LABELS: readonly string[] = [LABEL_NEEDS_DUAL_GATE, LABEL_RECONCILED, LABEL_READY_TO_LAND];
/** What decides a station, given the bead's stage (factoryAt), its claim age, and (live only) whether a pane is attached. */
/** `live.attached`: an agent is attached: a Herdr pane, or (no pane, e.g. an in-process subagent) its lane's transcript
 * written within the liveness window (transcript-liveness.ts). Null in replay, where neither is known. */
export type RuleCtx = { stage: Stage; sinceMs: number | null; claimMs: number; live: { attached: boolean } | null };
export type StationRule = {
  id: StationId; label: string; meaning: string;
  /** Conditions to be here, and what moves a bead on, in plain English. */
  enter: readonly string[]; exit: readonly string[];
  /** Which stages can stand here (factoryAt's stage), and the exact predicate the floor uses. */
  stages: readonly Stage[]; is(c: RuleCtx): boolean;
};
const claimed = (c: RuleCtx) => (c.live ? !c.live.attached : c.sinceMs !== null && c.sinceMs < c.claimMs);
const review = REVIEW_LABELS.join(", ");

export const STATION_RULES: readonly StationRule[] = [
  { id: "intake", label: "Intake", meaning: "Work that exists but nobody has picked up yet.",
    enter: ["open and every blocker closed: ready for a worker", "or open with an open `blocks` dependency: waiting (striped, padlocked)"],
    exit: ["claimed by an agent (the one claim Dispatch makes) → Claim"],
    stages: ["waiting", "ready"], is: c => c.stage === "waiting" || c.stage === "ready" },
  { id: "claim", label: "Claim", meaning: "Claimed, but no agent is working on it yet.",
    enter: [`live: claimed (in progress) with no agent attached yet: no ${PANE}, and no transcript written in the last 5 min, however long ago`, `replay: started less than 15 min ago (${PANE}s and transcripts are unknown for the past)`],
    exit: [`live: an ${PANE} opens, or its lane writes its transcript → Build`, "replay: 15 min pass → Build"],
    stages: ["building"], is: c => c.stage === "building" && claimed(c) },
  { id: "build", label: "Build", meaning: "An agent is working on it in its worktree.",
    enter: [`live: claimed and an agent attached: an open ${PANE}, or (no ${PANE}) its lane's transcript written in the last 5 min`, "replay: claimed 15 min ago or more"],
    exit: [`a review label appears (${review}) → Gate`, "closed → Land"],
    stages: ["building"], is: c => c.stage === "building" && !claimed(c) },
  { id: "gate", label: "Gate", meaning: "Waiting for review, or under review.",
    enter: [`open with a review label: ${review}`, `up to as many ${ITEMS} as there are reviewers are assumed to be in review (there is no review-start signal yet); the rest are held`, `replay: review history is not recorded, so in the past the Gate is empty (hatched) and a ${termLabel("bead")} that was in review shows at Build`],
    exit: ["the review label goes while still in progress → back to Build on the return conveyor (rework)", "closed → Land"],
    stages: ["review"], is: c => c.stage === "review" },
  { id: "land", label: "Land", meaning: "Done: closed and landed.",
    enter: ["closed"], exit: ["reopened → Intake (new work, not rework)"],
    stages: ["done"], is: c => c.stage === "done" },
];
export const RULE_OF: Readonly<Record<StationId, StationRule>> = Object.fromEntries(STATION_RULES.map(r => [r.id, r])) as Record<StationId, StationRule>;

/** The station a bead stands at: the first rule whose predicate holds (exactly one does for every stage; tested). */
export function stationByRules(c: RuleCtx): StationId {
  for (const r of STATION_RULES) if (r.is(c)) return r.id;
  return "intake";
}
/** The bead-level review test behind the Gate rule (mirrors the review lane: open + one of REVIEW_LABELS). */
export const hasReviewLabel = (i: Pick<WorkIssue, "status" | "labels">) => i.status !== "closed" && REVIEW_LABELS.some(l => i.labels.includes(l));

/** The glow limit in words, e.g. "glows above 2 (the reviewer count)". `wired` = the caller passed real thresholds; when it did
 * not, the number is a DEFAULT and the text says so (FAC-7: it used to present the default as "the reviewer count"). */
export function limitText(id: StationId, limit: number, wired = true): string {
  if (!Number.isFinite(limit)) return "never glows (finished work is not a queue)";
  const what = id === "gate" ? "the reviewer count" : id === "build" ? "the worker cap" : null;
  const why = !wired ? ` (default limit${what ? `: ${what} is not connected yet` : ""})` : what ? ` (${what})` : "";
  return `glows above ${limit}${id === "intake" ? " ready" : ""}${why}${id === "intake" ? ` · blocked ${ITEMS} are not waiting for an agent` : ""}`;
}

// ---- the checklist ----------------------------------------------------------------------------------------------------
/** From the evidence lane (bff evidence explain <id>): done-confidence 0..100, flags, explanation lines; optional facts. */
export type EvidenceInfo = { score: number; flags: readonly string[]; lines: readonly string[]; refsCommit?: boolean | null; pins?: boolean | null };
export type CheckState = "yes" | "no" | "unknown" | "not-connected";
export type CheckItem = { id: string; label: string; state: CheckState; detail: string };
export const CHECK_MARK: Record<CheckState, string> = { yes: "✓", no: "✗", unknown: "?", "not-connected": "–" };
const LIKELY_DONE_AT = 70, CLAIMED_WEAK = "CLAIMED-DONE-WEAK";

/** The bead against our conditions. `pane`: true / false when live, null when not known (past frames); `transcriptLive`: no pane
 * but the lane's transcript is being written (not ✗: an agent is working). `evidence`: the lane's
 * map (undefined = not connected; a map without this bead = unknown). */
export function beadChecklist(i: Pick<WorkIssue, "status" | "labels" | "startedAt" | "assignee">, pane: boolean | null, evidence?: ReadonlyMap<string, EvidenceInfo> | null, id?: string, transcriptLive = false): CheckItem[] {
  const ev = evidence ? (id ? evidence.get(id) ?? null : null) : undefined;
  const fromEv = (v: boolean | null | undefined, what: string): Pick<CheckItem, "state" | "detail"> =>
    ev === undefined ? { state: "not-connected", detail: "evidence lane not connected" } : ev === null ? { state: "unknown", detail: "no evidence for this bead" }
      : v === true ? { state: "yes", detail: what } : v === false ? { state: "no", detail: `no ${what}` } : { state: "unknown", detail: `${what}: not reported` };
  const claim = i.status === "in_progress" || i.startedAt !== null || i.assignee !== null || i.status === "closed";
  const score: Pick<CheckItem, "state" | "detail"> = ev === undefined ? { state: "not-connected", detail: "evidence lane not connected" }
    : ev === null ? { state: "unknown", detail: "no evidence for this bead" }
    : { state: ev.flags.includes(CLAIMED_WEAK) || ev.score < 50 ? "no" : ev.score >= LIKELY_DONE_AT ? "yes" : "unknown", detail: `${ev.score}/100${ev.flags.length ? ` · ${ev.flags.join(", ")}` : ""}` };
  return [
    { id: "claim", label: "Has a claim", state: claim ? "yes" : "no", detail: claim ? (i.assignee ? `claimed by ${i.assignee}` : "claimed") : "nobody has claimed it" },
    { id: "pane", label: `Has a worktree / ${PANE}`, ...(pane === null ? { state: "unknown" as const, detail: `${PANE}s are only known live` } : pane ? { state: "yes" as const, detail: `its ${PANE} is open` } : transcriptLive ? { state: "unknown" as const, detail: `no ${PANE} · transcript live (an agent is working, e.g. an in-process subagent)` } : { state: "no" as const, detail: `no ${PANE} open` }) },
    { id: "refs", label: "Commit with a Refs: trailer", ...fromEv(ev?.refsCommit, "Refs: commit") },
    { id: "dual-gate", label: `Dual-gate review label (${LABEL_NEEDS_DUAL_GATE})`, state: i.labels.includes(LABEL_NEEDS_DUAL_GATE) ? "yes" : "no", detail: i.labels.includes(LABEL_NEEDS_DUAL_GATE) ? "labelled" : "not labelled" },
    { id: "reconciled", label: `Reconciled (${LABEL_RECONCILED})`, state: i.labels.includes(LABEL_RECONCILED) ? "yes" : "no", detail: i.labels.includes(LABEL_RECONCILED) ? "labelled" : "not labelled" },
    { id: "pins", label: "Tests / pins evidence", ...fromEv(ev?.pins, "pin or test") },
    { id: "confidence", label: "Done-confidence", ...score },
  ];
}
