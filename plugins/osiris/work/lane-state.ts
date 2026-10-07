// Quest states (Qoder Quest taxonomy, owner td-osi.9): every Board card resolves to exactly ONE of Running / Action Required /
// Ready / Error. A VIEW over the existing model, never a second taxonomy: the lane comes in already decided by boardCards
// (surface-model.ts), anomalies are beady-eye's verbatim, labels are the existing constants. Nothing here re-derives a lane.
// Pure: no I/O, no clock (the caller passes the blocked age, measured the way kpis measures blockedOldestMs).
import {LABEL_CRIT} from "./surface-model.ts";
import {DEFAULT_STALE_MS, LABEL_OWNER_DECISION} from "./work-model.ts";
import type {AnomalyRule, BoardCard, Lane, WorkSurfaceSnapshot} from "./surface-types.ts";

export type QuestState = "running" | "action_required" | "ready" | "error";
/** Display order for a Board grouped by quest state: what needs fixing first, what is idle last. */
export const QUEST_STATES: readonly QuestState[] = ["error", "action_required", "running", "ready"];

export type QuestInput = {
  /** BoardCard.lane, as boardCards decided it. */
  lane: Lane;
  labels: readonly string[];
  /** TreeNode.anomalies for this bead ([] on a bd-only snapshot: no join, so no anomalies). */
  anomalies: readonly AnomalyRule[];
  /** How long a blocked card has been blocked: now - updatedAt (kpis' blockedOldestMs measure). null = unknown, read as fresh. */
  blockedForMs: number | null;
};
export type QuestOptions = {staleMs?: number};
export type QuestRule = {id: string; state: QuestState; why: string; when: (i: QuestInput, staleMs: number) => boolean};

/**
 * Claim-shaped anomalies that a CORRECT hand-off leaves behind. The lane prompt (prompt.ts) tells a finishing agent to unset
 * agent_pane and add needs-dual-gate, and Osiris never closes a bead, so a finished lane is in_progress with no pane: exactly
 * beady-eye's orphan-claim (and, if review waits long enough, stale-claim). On a review card they are the protocol, not a fault.
 */
export const HANDOFF_ANOMALIES: readonly AnomalyRule[] = ["orphan-claim", "stale-claim"];
const faults = (i: QuestInput) => (i.lane === "review" ? i.anomalies.filter((a) => !HANDOFF_ANOMALIES.includes(a)) : i.anomalies);

/** Terminal rule per lane. A Record, so a new Lane member cannot compile without a quest state: totality by construction. */
const LANE_RULE: Record<Lane, {state: QuestState; why: string}> = {
  action: {state: "action_required", why: "Waiting on an owner decision (Action required)"},
  review: {state: "action_required", why: "Waiting for review (needs-dual-gate, reconciled or ready-to-land)"},
  blocked: {state: "action_required", why: "Blocked, but not for long yet"},
  in_progress: {state: "running", why: "Claimed and being worked on"},
  ready: {state: "ready", why: "Nothing in the way; can be dispatched"},
};

/** Precedence, first match wins. Overrides first, then exactly one terminal rule per lane (so some rule always matches). */
export const QUEST_RULES: readonly QuestRule[] = [
  {id: "anomaly", state: "error", why: "The tracker flagged the claim or pane", when: (i) => faults(i).length > 0},
  {id: "blocked-too-long", state: "error", why: "Blocked for longer than the stale window", when: (i, staleMs) => i.lane === "blocked" && i.blockedForMs !== null && i.blockedForMs > staleMs},
  {id: "crit", state: "action_required", why: "Marked critical: the owner decides", when: (i) => i.labels.includes(LABEL_CRIT)},
  {id: "owner-decision", state: "action_required", why: "Waiting on an owner decision", when: (i) => i.labels.includes(LABEL_OWNER_DECISION)},
  ...(Object.entries(LANE_RULE) as [Lane, {state: QuestState; why: string}][]).map(([lane, r]): QuestRule => ({id: `lane-${lane}`, ...r, when: (i) => i.lane === lane})),
];

/** The rule that decides this card (for a "why is it here" tooltip). */
export function questRule(input: QuestInput, opts: QuestOptions = {}): QuestRule {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  for (const r of QUEST_RULES) if (r.when(input, staleMs)) return r;
  throw new Error(`no quest rule for lane ${String(input.lane)}`); // unreachable for a valid Lane: LANE_RULE covers every member
}
export const questState = (input: QuestInput, opts: QuestOptions = {}): QuestState => questRule(input, opts).state;

export const questLabel = (s: QuestState) => ({running: "Running", action_required: "Needs your action", ready: "Ready to start", error: "Something is wrong"})[s];
export const emptyQuestText = (s: QuestState) => ({running: "Nothing is running", action_required: "Nothing needs you", ready: "Nothing is ready to start", error: "Nothing is wrong"})[s];

/**
 * Quest state per Board card: the card's lane and labels (boardCards) joined to the bead's tree anomalies and blocked age.
 * Anomalies are per bead in beady-eye, so the union over every path a bead appears on is taken. A bd-only snapshot has no
 * tree, hence no anomalies. Blocked age is now - updatedAt (kpis' measure); an unparseable updatedAt reads as fresh.
 */
export function boardQuests(s: Pick<WorkSurfaceSnapshot, "issues" | "tree">, cards: readonly Pick<BoardCard, "id" | "lane" | "labels">[], now: number, opts: QuestOptions = {}): Map<string, QuestState> {
  const anomalies = new Map<string, Set<AnomalyRule>>();
  for (const r of s.tree) for (const n of r.nodes) for (const a of n.anomalies) (anomalies.get(n.id) ?? anomalies.set(n.id, new Set()).get(n.id)!).add(a);
  const updated = new Map(s.issues.map((i) => [i.id, Date.parse(i.updatedAt)]));
  return new Map(cards.map((c) => {
    const u = updated.get(c.id);
    const blockedForMs = u !== undefined && Number.isFinite(u) ? Math.max(0, now - u) : null;
    return [c.id, questState({lane: c.lane, labels: c.labels, anomalies: [...(anomalies.get(c.id) ?? [])], blockedForMs}, opts)];
  }));
}
