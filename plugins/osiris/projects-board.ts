/**
 * Pure board model for the Projects tab (PRIVATE Osiris build): health that discriminates, PLAN (human horizon) vs EXECUTION
 * (machine state) columns, card pills and plain-English problem lines. No I/O, no React, no real project data. Every function
 * that depends on "now" takes `today` ("YYYY-MM-DD") so tests are deterministic.
 * Spine fields used: shipped[].date/verification, overview.waiting_on, work[].status/waiting_on/date{value,kind}/outcome/horizon,
 * project.freshness/health.level. The schema has NO field for "owner vs external waiting", "security item" or "inactive by choice":
 * those rules use the closest honest signal (see projectHealth).
 */
import { ageSinceVerified, badge, colOf, daysSince, STALE_DAYS, type Column, type SpineV2, type Work } from "./projects.ts";
import type { ProjectsRead } from "./projects-feed.ts";
import type { Lane } from "./work/surface-types.ts";

export type Tone = "green" | "yellow" | "red" | "grey";
export type ProjectHealth = { tone: Tone; reason: string };
export const HEALTH_RULES: readonly { tone: Tone; rule: string }[] = [
  { tone: "green", rule: "Verified delivery within 7 days and nothing waiting." },
  { tone: "yellow", rule: "Something is waiting, or the last verified delivery was 8-21 days ago." },
  { tone: "red", rule: "Work is blocked, no verified delivery for over 21 days, or a wait older than 14 days." },
  { tone: "grey", rule: "The spine has not been updated for over 14 days, or health is marked paused." },
];
export const GREY_AFTER_DAYS = STALE_DAYS, RED_NO_DELIVERY_DAYS = 21, RED_WAIT_DAYS = 14, GREEN_DELIVERY_DAYS = 7;
const PAUSED = new Set(["grey", "gray", "paused", "inactive", "archived"]);
const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** Days a work item has been waiting: only an OBSERVED date counts (a planned date is a future target, not a start). */
export function waitingDays(w: Work, today: string): number | null {
  if (w.date.kind !== "observed") return null;
  const d = daysSince(w.date.value, today);
  return d !== null && d >= 0 ? d : null;
}
/** Work that is stalled on someone: status waiting, or an active/next item that names what it waits on. Later/planned/suggested items are not scheduled, so they cannot be blocked. */
export function isBlocked(w: Work): boolean {
  const c = colOf(w);
  return c === "waiting" || (!!w.waiting_on && (c === "now" || c === "next"));
}

const NOT_WAITING = new Set(["", "none", "nothing", "-", "n/a", "na", "no", "nil"]);
/** overview.waiting_on is free text: "none", "Nothing", "-" and "n/a" say that nothing is waiting, so they do not count. */
export const isRealWait = (text: string | null | undefined): boolean => !!text && !NOT_WAITING.has(text.trim().toLowerCase().replace(/[.\s]+$/, ""));

export function projectHealth(s: SpineV2, today: string): ProjectHealth {
  const fresh = daysSince(s.project.freshness, today);
  const lvl = (s.project.health.level ?? "").toLowerCase();
  if (PAUSED.has(lvl)) return { tone: "grey", reason: `grey: health is marked ${lvl}` };
  if (fresh === null || fresh > GREY_AFTER_DAYS) return { tone: "grey", reason: fresh === null ? "grey: the spine has no update date" : `grey: spine not updated for ${days(fresh)}` };
  const open = s.work.filter(w => colOf(w) !== "done");
  const blocked = open.filter(isBlocked);
  const waitAges = blocked.map(w => waitingDays(w, today)).filter((n): n is number => n !== null);
  const oldest = waitAges.length ? Math.max(...waitAges) : null;
  const rawDelivery = ageSinceVerified(s, today), delivery = rawDelivery === null ? null : Math.max(0, rawDelivery); // a future-dated entry reads as today, never "-3 days ago"
  const waiting = blocked.length > 0 || isRealWait(s.overview.waiting_on);
  const stuck = open.filter(w => colOf(w) === "now" && isBlocked(w));
  if (lvl === "red") return { tone: "red", reason: "red: health is marked red" };
  if (stuck.length > 0) return { tone: "red", reason: `red: ${stuck.length} active ${stuck.length === 1 ? "item is" : "items are"} blocked` };
  if (oldest !== null && oldest > RED_WAIT_DAYS) return { tone: "red", reason: `red: waiting ${days(oldest)}` };
  if (delivery !== null && delivery > RED_NO_DELIVERY_DAYS) return { tone: "red", reason: `red: no verified delivery for ${days(delivery)}` };
  if (waiting) return { tone: "yellow", reason: oldest !== null ? `yellow: waiting ${days(oldest)}` : "yellow: something is waiting" };
  if (delivery === null) return { tone: "yellow", reason: "yellow: no verified delivery on record" };
  if (delivery > GREEN_DELIVERY_DAYS) return { tone: "yellow", reason: `yellow: last verified delivery ${days(delivery)} ago` };
  return { tone: "green", reason: delivery === 0 ? "green: verified delivery today" : `green: verified delivery ${days(delivery)} ago` };
}

// ---- two board modes: horizon (PLAN) and state (EXECUTION) are SEPARATE fields, never mixed --------------------------------
export type BoardMode = "plan" | "execution";
/** PLAN = the human horizon the author chose (spine `status`). */
export const PLAN_COLUMNS: readonly Column[] = ["now", "next", "later", "waiting", "done"];
export const PLAN_LABEL: Record<Column, string> = { now: "Now", next: "Next", later: "Later", waiting: "Waiting", done: "Done" };
export const planColumn = (w: Work): Column => colOf(w);

/** EXECUTION = machine state, the same words and lane order as the Work surface (ready, in_progress=Active, blocked, review) plus done. */
/** The Work surface's machine-state lanes minus its "action" lane (owner decisions are bead-level; spine items have no
 * decision state), plus Done. Sharing Lane keeps the words and order in step with the Work board. */
export type ExecColumn = Exclude<Lane, "action"> | "done";
export const EXEC_COLUMNS: readonly ExecColumn[] = ["ready", "in_progress", "blocked", "review", "done"];
export const EXEC_LABEL: Record<ExecColumn, string> = { ready: "Ready", in_progress: "Active", blocked: "Blocked", review: "Review", done: "Done" };
/** Derived from spine fields, not stored: blocked beats active beats ready; done but not verified is Review; later/planned/suggested are not scheduled (null). */
export function execColumn(w: Work): ExecColumn | null {
  const c = colOf(w);
  if (c === "done") return badge(w) === "V" ? "done" : "review";
  if (isBlocked(w)) return "blocked";
  return c === "now" ? "in_progress" : c === "next" ? "ready" : null;
}
export const modeColumns = (m: BoardMode): readonly string[] => (m === "plan" ? PLAN_COLUMNS : EXEC_COLUMNS);
export const modeColumn = (m: BoardMode, w: Work): string | null => (m === "plan" ? planColumn(w) : execColumn(w));
export const modeLabel = (m: BoardMode, c: string): string => (m === "plan" ? PLAN_LABEL[c as Column] : EXEC_LABEL[c as ExecColumn]) ?? c;

// ---- stripe colour meaning (green ready/healthy, yellow attention, red blocked, grey later, purple review) ---------------------
export type Stripe = "green" | "yellow" | "red" | "grey" | "purple";
export function stripeOf(w: Work, today: string): Stripe {
  const e = execColumn(w);
  if (e === "blocked") return "red";
  if (e === "review") return "purple";
  if (e === null) return "grey";
  if (e === "done") return "green";
  return isStale(w, today) ? "yellow" : "green";
}

// ---- pills and the one problem line ------------------------------------------------------------------------------------
export const STALE_ITEM_DAYS = STALE_DAYS;
/** An open scheduled item whose OBSERVED date is older than two weeks. */
export function isStale(w: Work, today: string): boolean {
  const c = colOf(w);
  if (c === "done" || c === "later" || w.date.kind !== "observed") return false;
  const d = daysSince(w.date.value, today);
  return d !== null && d > STALE_ITEM_DAYS;
}
export type Pill = { text: string; tip: string; tone: "info" | "attention" | "failure" | "muted" };
const HZ_PILL: Record<string, string> = { long: "DIRECTION", medium: "OUTCOME", short: "SLICE" };
const HZ_TIP: Record<string, string> = { long: "Long horizon: a direction", medium: "Medium horizon: an outcome", short: "Short horizon: a slice of work" };
/** Readable pills instead of glyph soup. At most four; order is outcome, horizon, then what needs attention. */
export function cardPills(w: Work, today: string): Pill[] {
  const out: Pill[] = [];
  if (w.outcome) out.push({ text: w.outcome.toUpperCase(), tip: `Serves outcome ${w.outcome}`, tone: "info" });
  const hz = w.horizon === "long" || w.horizon === "medium" ? w.horizon : "short";
  out.push({ text: HZ_PILL[hz], tip: HZ_TIP[hz], tone: "muted" });
  if (isStale(w, today)) out.push({ text: "STALE", tip: `Not updated for more than ${STALE_ITEM_DAYS} days`, tone: "attention" });
  if (isBlocked(w)) out.push({ text: "BLOCKED", tip: w.waiting_on ? `Waiting on ${w.waiting_on}` : "Waiting on something outside this item", tone: "failure" });
  const b = badge(w);
  if (b === "I") out.push({ text: "INFERRED", tip: "Inferred or suggested, not confirmed by anyone", tone: "muted" });
  return out.slice(0, 4);
}
const ago = (n: number) => (n === 0 ? "today" : n === 1 ? "1 day" : `${n} days`);
/** What is wrong with this card, in plain words and computed (never a raw date). null when nothing is wrong. */
export function problemLine(w: Work, today: string): string | null {
  const c = colOf(w);
  if (isBlocked(w)) { const d = waitingDays(w, today); return d !== null ? `BLOCKED · ${ago(d)}` : w.waiting_on ? `BLOCKED · waiting on ${w.waiting_on}` : "BLOCKED"; }
  if (c === "done") return badge(w) === "V" ? null : "DONE · not verified";
  if (isStale(w, today)) return `STALE · ${ago(daysSince(w.date.value, today) ?? 0)}`;
  if (c === "later" && badge(w) === "I") return "SUGGESTED · not confirmed";
  return null;
}
/** The one next action, when there is one and the card is not done. */
export const nextAction = (w: Work): string | null => (colOf(w) !== "done" && w.next_action ? w.next_action : null);

// ---- portfolio row -----------------------------------------------------------------------------------------------------
export type PortfolioRow = {
  id: string; name: string; goal: string | null; health: ProjectHealth;
  counts: { ready: number; active: number; blocked: number; stale: number };
  /** Planned items only (now/next/waiting/done); `later` is counted apart so un-committed ideas cannot drag the percentage down. */
  progress: { done: number; total: number; pct: number; later: number };
  next: string | null; waiting: string | null;
};
export function portfolioRow(s: SpineV2, today: string): PortfolioRow {
  const ex = s.work.map(execColumn), done = s.work.filter(w => colOf(w) === "done").length, later = s.work.filter(w => colOf(w) === "later").length, total = s.work.length - later;
  return {
    id: s.project.id, name: s.project.name, goal: s.project.one_liner ?? s.overview.current_outcome, health: projectHealth(s, today),
    counts: { ready: ex.filter(e => e === "ready").length, active: ex.filter(e => e === "in_progress").length, blocked: ex.filter(e => e === "blocked").length, stale: s.work.filter(w => isStale(w, today)).length },
    progress: { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100), later },
    next: s.overview.next_action, waiting: isRealWait(s.overview.waiting_on) ? s.overview.waiting_on : null,
  };
}
export const countsLine = (r: PortfolioRow): string => `${r.counts.ready} ready · ${r.counts.active} active · ${r.counts.blocked} blocked · ${r.counts.stale} stale`;

// ---- header: the folder path lives ONLY in the button's tooltip ------------------------------------------------------------
export function headerModel(count: number | null, dir: string | null): { label: string; folderTitle: string } {
  return { label: count === null ? "Projects" : `${count} project${count === 1 ? "" : "s"}`, folderTitle: dir ? `Reading ${dir}. Click to change the folder.` : "No folder picked yet. Click to pick your projects folder." };
}

/** Headline word per health tone: says what the data shows (a status file's age, a delivery cadence), not that work stopped or is fine. */
export const TONE_WORD: Record<Tone, string> = { green: "on track", yellow: "attention", red: "at risk", grey: "not updated" };
export const progressLabel = (p: PortfolioRow["progress"]): string => `${p.total === 0 ? "nothing planned yet" : `${p.done} of ${p.total} planned done`}${p.later > 0 ? ` · +${p.later} later` : ""}`;
/** The legend sentence about staleness; reads the same constants the rules use, so it cannot disagree with them. */
export const staleLegend = (): string => `A spine not updated for over ${GREY_AFTER_DAYS} days is greyed; a card with no update for over ${STALE_ITEM_DAYS} days shows STALE.`;

// ---- what the Projects tab says when it has no portfolio to show ---------------------------------------------------------------
export type ProjectsBodyState = { kind: "error" | "empty" | "loading" | "pick" | "ok"; text: string };
/** Read failure and an empty folder are different facts: one says "could not read", the other says "none found". No folder yet asks the user to pick one. */
export function projectsBodyState(i: { error: string | null; result: ProjectsRead | null; dir: string | null }): ProjectsBodyState {
  if (i.error) return { kind: "error", text: `could not read ${i.dir ?? "the projects folder"}: ${i.error}` };
  if (!i.result) return i.dir ? { kind: "loading", text: "Loading projects…" } : { kind: "pick", text: "Pick your projects folder: choose Folder… and select the folder that holds your *.spine.json files." };
  if (i.result.state === "ok") return { kind: "ok", text: "" };
  if (i.result.state === "empty") return { kind: "empty", text: `no project spine files found in ${i.result.dir}` };
  return { kind: "error", text: `could not read ${i.result.dir}: ${i.result.reason}` };
}
