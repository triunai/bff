// The dispatch guard (pure). Some items should not be handed to a new agent without a second look: one that is already locked (a scope lease or a
// claimed, in-progress item some agent holds), one only the owner may decide, one that is blocked, and a critical one. The state and its REASON are read
// from data the app already holds (the work snapshot, and the Factory's lock list when the caller has it); nothing is invented. The one dispatch dialog
// shows the warning, makes "double-check first" (a READ-ONLY review prompt) the default, and keeps "Dispatch anyway" disabled until the person ticks
// "I understand this item is <state>". An unguarded item gets no guard at all: its dialog is unchanged.
import type { WorkSurfaceSnapshot } from "./surface-types.ts";
import { LABEL_CRIT, boardCards, shortId } from "./surface-model.ts";
import { LABEL_OWNER_DECISION } from "./work-model.ts";
import { priorityTone } from "./priority-tone.ts";
import type { FloorLock } from "./factory-floor-model.ts";

/** In the order they are checked: the first that applies is THE state (a locked item is locked even if it is also critical). */
export const GUARD_STATES = ["locked", "owner-gate", "blocked", "critical"] as const;
export type GuardState = (typeof GUARD_STATES)[number];
export interface DispatchGuard { state: GuardState; /** "locked", "an owner gate", ...: fills "I understand this item is <word>". */ word: string; reason: string }

export const GUARD_WORD: Readonly<Record<GuardState, string>> = { locked: "locked", "owner-gate": "an owner gate", blocked: "blocked", critical: "critical" };
const list = (ids: readonly string[]) => ids.slice(0, 4).map(shortId).join(", ") + (ids.length > 4 ? ` and ${ids.length - 4} more` : "");
const make = (state: GuardState, reason: string): DispatchGuard => ({ state, word: GUARD_WORD[state], reason });

/** The guard for one work item, or null when it is a plain item. `locks` is the Factory's lock list when the caller has one (scope leases, gate holds). */
export function dispatchGuard(snap: WorkSurfaceSnapshot, id: string, now: number, locks: readonly FloorLock[] = []): DispatchGuard | null {
  const issue = snap.issues.find(i => i.id === id); if (!issue) return null;
  const card = boardCards(snap, now).find(c => c.id === id);
  const lock = locks.find(l => l.beadId === id && (l.kind === "scope" || l.kind === "gate"));
  if (lock) return make("locked", lock.kind === "scope" ? `a scope lease is held${lock.holders.length ? ` by ${list(lock.holders)}` : ""}${lock.holderAgent ? ` (${lock.holderAgent})` : ""}, so another agent could edit the same files` : "it is held at the Gate while every reviewer is busy");
  if (issue.status === "in_progress" && (issue.assignee || card?.pane)) return make("locked", `it is claimed${issue.assignee ? ` by ${issue.assignee}` : ""} and in progress${card?.pane ? ` in pane ${card.pane}` : ""}, so a second agent would collide with it`);
  if (issue.labels.includes(LABEL_OWNER_DECISION) || issue.type === "decision") return make("owner-gate", "only the owner can decide this; an agent cannot settle it");
  if (card && card.blockedBy.length) return make("blocked", `it waits on ${card.blockedBy.length} other item${card.blockedBy.length === 1 ? "" : "s"} (${list(card.blockedBy.map(b => b.id))}) that must finish first`);
  if (priorityTone({ priority: issue.priority, kind: issue.labels.includes(LABEL_CRIT) ? "crit" : null }) === "failure") return make("critical", issue.priority === 0 ? "it is priority P0, so a mistake here is expensive" : "it is marked critical, so a mistake here is expensive");
  return null;
}

/** A team dispatch is guarded by its most serious card (GUARD_STATES order); the reason names how many cards are guarded. */
export function teamGuard(snap: WorkSurfaceSnapshot, ids: readonly string[], now: number, locks: readonly FloorLock[] = []): DispatchGuard | null {
  const gs = ids.map(i => ({ i, g: dispatchGuard(snap, i, now, locks) })).filter((x): x is { i: string; g: DispatchGuard } => x.g !== null);
  if (!gs.length) return null;
  const top = gs.reduce((a, b) => GUARD_STATES.indexOf(b.g.state) < GUARD_STATES.indexOf(a.g.state) ? b : a).g;
  return gs.length === 1 ? top : make(top.state, `${gs.length} of the ${ids.length} selected items need a second look (${list(gs.map(x => x.i))}); the most serious: ${top.reason}`);
}

export const DOUBLE_CHECK_LABEL = "Ask an agent to double-check first";
export const ANYWAY_LABEL = "Dispatch anyway";
export const understandText = (g: DispatchGuard): string => `I understand this item is ${g.word}`;
/** The warning line the dialog shows. */
export const warningText = (g: DispatchGuard): string => `This item is ${g.word}: ${g.reason}.`;
/** "Dispatch anyway" is live only once the box is ticked. */
export const anywayEnabled = (g: DispatchGuard | null, ticked: boolean): boolean => !g || ticked;
/** The READ-ONLY review prompt the default button sends: inspect, explain, list risks, propose next steps, change nothing. */
export const doubleCheckPrompt = (g: DispatchGuard, itemText: string): string => [
  `Before anyone works on the item below, double-check it. It is ${g.word}: ${g.reason}.`,
  "Do these, in order, and change nothing:",
  "1. Inspect the item and the code or work around it as it is now.",
  `2. Explain why it is ${g.word}, in plain words.`,
  "3. List the risks of dispatching an agent onto it.",
  "4. Propose the next steps, and say who should do each one.",
  "Read-only: do not edit files, the tracker or any branch, and do not claim or move the item.",
  "", "The item:", itemText,
].join("\n");
