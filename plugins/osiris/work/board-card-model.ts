// Pure Board-card model: decides WHAT each card shows so the Board stays calm (no React, no colours: tones are names that map to --oi-tone-*).
// A VIEW over boardCards / boardQuests: lanes and quest states arrive already decided; nothing here re-derives a lane.
// Rule of thumb: a fact that is null or that the column already says is not shown.
import {LABEL_CRIT, laneLabel, plainTitle} from "./surface-model.ts";
import {capitalise, termLabel} from "./glossary.ts";
import {questLabel, type QuestState} from "./lane-state.ts";
import type {BoardCard, WorkSurfaceSnapshot} from "./surface-types.ts";
import type {Tone} from "../ui-tokens.ts";

const HOUR = 3_600_000, DAY = 24 * HOUR;
/** Labels that mark a work item a review sent back (none is guaranteed by the tracker; absent means no chip, never a guess). */
const SENT_BACK_LABELS: readonly string[] = ["rework", "sent-back", "needs-rework"];

/** "12m", "5h", "3d": compact age for the meta line. */
export function shortAge(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}
/** Age is shown when it is old news (over a day) or when the lane is about waiting (ready, review); never "5 hours old" on every card. */
export const showAge = (c: Pick<BoardCard, "lane" | "ageMs">): boolean => c.ageMs > DAY || c.lane === "ready" || c.lane === "review";

export type Chip = {text: string; tone: Tone};
/** At most ONE chip, and only information the column does not already carry: something wrong, critical, or sent back.
 *  "Needs your action" / "Ready to start" / "Running" are the lanes' own words, so they never become a chip. */
export function cardChip(c: Pick<BoardCard, "lane" | "labels">, quest: QuestState | undefined): Chip | null {
  let chip: Chip | null = null;
  if (quest === "error") chip = {text: questLabel("error"), tone: "failure"};
  else if (c.labels.includes(LABEL_CRIT)) chip = {text: "Critical", tone: "attention"};
  else if (c.labels.some(l => SENT_BACK_LABELS.includes(l))) chip = {text: capitalise(termLabel("rework")), tone: "attention"};
  return chip && chip.text.toLowerCase() !== laneLabel(c.lane).toLowerCase() ? chip : null;
}

export type CardView = {
  id: string; shortId: string; title: string; fullTitle: string;
  /** "P0".."P4": every card shows its priority (the approved mockup does). */
  pBadge: string;
  age: string | null;
  chip: Chip | null;
  /** The agent terminal label, only when there is one. */
  pane: string | null;
  /** The agent chip text: its pane when it has one, else its claimant; null when nobody holds the card. */
  agent: string | null;
  /** True only for a claimed, in-progress card with no terminal: the one place that fact is news. */
  noTerminal: boolean;
  waitsOn: number; blocks: number;
};
export function cardView(c: BoardCard, quest: QuestState | undefined): CardView {
  return {
    id: c.id, shortId: c.shortId, title: c.title, fullTitle: c.title,
    pBadge: `P${c.priority}`,
    age: shortAge(c.ageMs),
    chip: cardChip(c, quest),
    pane: c.pane, agent: c.pane ?? c.assignee,
    noTerminal: c.lane === "in_progress" && !c.pane,
    waitsOn: c.blockedBy.length, blocks: c.unblocks.length,
  };
}

export type EpicGroup = {
  /** Epic bead id, or null for cards with no epic. */
  epic: string | null; title: string | null;
  cards: BoardCard[];
  /** Every epic group is headed (the approved mockup shows the rule, name and count even for one card); cards with no epic stay loose. */
  headed: boolean;
};
/** The epic a card belongs to: the nearest ancestor of type "epic", else its direct parent, else null (a visited set breaks cycles). */
export function epicOf(snap: Pick<WorkSurfaceSnapshot, "issues">, id: string): string | null {
  const by = new Map(snap.issues.map(i => [i.id, i]));
  const seen = new Set<string>();
  let cur = by.get(id)?.parent ?? null, first: string | null = cur;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const p = by.get(cur);
    if (!p) return first;
    if (p.type === "epic") return cur;
    cur = p.parent;
  }
  return first;
}
/** Cards of ONE lane grouped by epic: headed groups first (largest, then by title), then the loose cards. Card order inside a group is kept. */
export function groupByEpic(snap: Pick<WorkSurfaceSnapshot, "issues">, cards: readonly BoardCard[]): EpicGroup[] {
  const by = new Map(snap.issues.map(i => [i.id, i]));
  const groups = new Map<string, BoardCard[]>(), loose: BoardCard[] = [];
  for (const c of cards) {
    const e = epicOf(snap, c.id);
    if (e === null) loose.push(c); else (groups.get(e) ?? groups.set(e, []).get(e)!).push(c);
  }
  const headed: EpicGroup[] = [];
  for (const [e, cs] of groups) headed.push({epic: e, title: plainTitle(by.get(e)?.title ?? e), cards: cs, headed: true});
  headed.sort((a, b) => b.cards.length - a.cards.length || a.title!.localeCompare(b.title!));
  const rest = loose;
  const order = new Map(cards.map((c, i) => [c.id, i]));
  rest.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return rest.length ? [...headed, {epic: null, title: null, cards: rest, headed: false}] : headed;
}

/** A stable workstream hue for an epic's left rule: one of the theme's eight lane colours, chosen from the epic id. */
export function epicHue(epic: string): string {
  let h = 0;
  for (const ch of epic) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `var(--oi-lane-${h % 8})`;
}
