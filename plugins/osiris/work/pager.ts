// KNOWN RISK (review LOW): the stall rule cannot tell a long test run or build from a hung lane, so it can page a healthy lane. The 30 min default was never tuned on real fleet data; the pager is off by default.
// Fleet pager core (build8 lane F, ideas-final #7). PURE: no fs, no network, no clock (takes `now`). OUTBOUND only: nothing in
// here reads a reply or turns a message into a prompt.
// One page per fleet EVENT, not per session. Five triggers, all edge-triggered (a condition that stays true pages once, when it
// becomes true): needs-you (count 0 -> N), lane-stalled (a lane newly quiet for stallMs), fleet-idle (the fleet went quiet after
// real work), seam-red (a guard newly crit), ci-red (CI newly red; nothing feeds it yet, see PagerInput.ciRed).
// Limits: at most one page per trigger per cooldownMs, and at most dailyCap pages per local day. Triggers that fire in the same
// tick are folded into ONE page (one phone buzz) that still spends each trigger's own cooldown.
// PRIVACY: page text is the trigger, counts and short lane names only. No prompt, path, branch, code or message body ever enters.
import type { FleetNow, FleetState, FleetWaiting } from "./fleet-types.ts";

/** The few lane facts the pager reads (a structural subset of FleetLane). */
export interface PagerLane { label: string; state: FleetState; lastAt: number | null; waiting?: FleetWaiting | null; now?: FleetNow | null }

export const PAGER_TRIGGERS = ["needs-you", "lane-stalled", "fleet-idle", "seam-red", "ci-red"] as const;
export type PagerTrigger = (typeof PAGER_TRIGGERS)[number];

export interface PagerConfig {
  /** A running lane with no write for this long is stalled. Clamped to [10, 55] min: past 60 min the fleet model calls a lane "done". */
  stallMs: number;
  /** live === 0 for this long after real work = the fleet is idle. */
  quietMs: number;
  /** At most one page per trigger inside this window. */
  cooldownMs: number;
  /** At most this many pages per local day (all triggers together). 0 = never page. */
  dailyCap: number;
}
export const PAGER_DEFAULTS: PagerConfig = { stallMs: 30 * 60_000, quietMs: 10 * 60_000, cooldownMs: 30 * 60_000, dailyCap: 12 };
export const STALL_MIN_MS = 10 * 60_000, STALL_MAX_MS = 55 * 60_000;

/** What the tick reads. `lanes` is the capped fleet lane list; counts come from the summary so a truncated list cannot under-count. */
export interface PagerInput {
  at: number;
  /** FleetSummary.needsYou: lanes waiting on a person (question / your-turn / permission). */
  needsYou: number;
  live: number;
  lanes: readonly PagerLane[];
  /** Ids of seam guards that are crit right now. Ids are fixed registry names, never user text. */
  seamCrits: readonly string[];
  /** true = CI is red, false = green, null = unknown. NOTHING FEEDS THIS YET (no CI reader exists, and CI is billing-blocked); null never pages. */
  ciRed: boolean | null;
}

export interface PagerState {
  prevNeeds: number;
  /** Labels stalled last tick. */
  stalled: string[];
  seamCrits: string[];
  ciRed: boolean;
  /** Fleet has had live lanes since the last fleet-idle page. */
  busy: boolean;
  /** When live first read 0 while busy; null while anything is live. */
  zeroSince: number | null;
  lastSent: Partial<Record<PagerTrigger, number>>;
  day: string;
  dayCount: number;
}
export const initialPagerState = (): PagerState => ({ prevNeeds: 0, stalled: [], seamCrits: [], ciRed: false, busy: false, zeroSince: null, lastSent: {}, day: "", dayCount: 0 });

export interface Page { trigger: PagerTrigger; line: string }
export interface Suppressed { trigger: PagerTrigger; reason: "cooldown" | "daily-cap" }
export interface PagerResult {
  state: PagerState;
  /** The folded page to send, or null. */
  page: { at: number; triggers: PagerTrigger[]; title: string; text: string } | null;
  suppressed: Suppressed[];
}

export const clampStallMs = (ms: number): number => Math.min(STALL_MAX_MS, Math.max(STALL_MIN_MS, Number.isFinite(ms) ? ms : PAGER_DEFAULTS.stallMs));
/** Local calendar day key; the daily cap resets when it changes. */
export const dayKey = (at: number): string => { const d = new Date(at); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

/** A lane name safe to put on a lock screen: short, plain characters only. A label is user-influenced text, so anything odd is dropped. */
export function safeName(label: string | null | undefined): string {
  const s = String(label ?? "").replace(/[^A-Za-z0-9 ._:+-]/g, "").replace(/\s+/g, " ").trim().slice(0, 32);
  return s || "lane";
}
const names = (xs: readonly string[], max = 3): string => { const u = [...new Set(xs.map(safeName))]; return u.slice(0, max).join(", ") + (u.length > max ? ` +${u.length - max} more` : ""); };
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

/** A lane is stalled when it is not done, nobody is waiting on it (that is needs-you), it has a tool still running, and it wrote nothing for stallMs. */
export function stalledLabels(lanes: PagerInput["lanes"], at: number, stallMs: number): string[] {
  return lanes.filter(l => l.state !== "done" && !l.waiting && l.now?.running === true && l.lastAt != null && at - l.lastAt >= stallMs).map(l => safeName(l.label));
}

/** One tick. Pure: the same state + input always gives the same answer. */
export function evaluatePager(prev: PagerState, input: PagerInput, cfg: PagerConfig = PAGER_DEFAULTS): PagerResult {
  const at = input.at, stallMs = clampStallMs(cfg.stallMs);
  const s: PagerState = { ...prev, lastSent: { ...prev.lastSent } };
  const day = dayKey(at);
  if (s.day !== day) { s.day = day; s.dayCount = 0; }

  const cand: Page[] = [];
  // needs-you: 0 -> N only. N -> M stays quiet (the owner already knows), and N -> 0 -> N pages again (after the cooldown).
  const needs = Math.max(0, Math.floor(input.needsYou) || 0);
  if (prev.prevNeeds === 0 && needs > 0) cand.push({ trigger: "needs-you", line: `${plural(needs, "lane")} waiting on you` });
  s.prevNeeds = needs;

  // lane-stalled: a lane that was not stalled last tick and is now. Anything still stalled stays quiet until it recovers.
  const stalled = [...new Set(stalledLabels(input.lanes, at, stallMs))];
  const fresh = stalled.filter(l => !prev.stalled.includes(l));
  if (fresh.length) cand.push({ trigger: "lane-stalled", line: `${plural(fresh.length, "lane")} stalled over ${Math.round(stallMs / 60_000)} min: ${names(fresh)}` });
  s.stalled = stalled;

  // fleet-idle: busy -> live 0 held for quietMs. Re-arms only after work resumes, so a quiet night is zero pages.
  if (input.live > 0) { s.busy = true; s.zeroSince = null; }
  else if (s.busy) {
    s.zeroSince = prev.zeroSince ?? at;
    if (at - s.zeroSince >= cfg.quietMs) { cand.push({ trigger: "fleet-idle", line: "fleet idle, no lane working" }); s.busy = false; s.zeroSince = null; }
  }

  // seam-red: a guard id that was not crit last tick.
  const crits = [...new Set(input.seamCrits)];
  const newCrits = crits.filter(c => !prev.seamCrits.includes(c));
  if (newCrits.length) cand.push({ trigger: "seam-red", line: `${plural(newCrits.length, "seam")} red: ${names(newCrits, 4)}` });
  s.seamCrits = crits;

  // ci-red: false/unknown -> true.
  const ci = input.ciRed === true;
  if (ci && !prev.ciRed) cand.push({ trigger: "ci-red", line: "CI is red" });
  s.ciRed = ci;

  // Rate limits. A suppressed candidate is dropped (state above already advanced), so it can never replay later as a stale page.
  const suppressed: Suppressed[] = [], ok: Page[] = [];
  for (const c of cand) {
    const last = s.lastSent[c.trigger];
    if (last !== undefined && at - last < cfg.cooldownMs) suppressed.push({ trigger: c.trigger, reason: "cooldown" });
    else ok.push(c);
  }
  if (ok.length && s.dayCount >= cfg.dailyCap) { for (const c of ok) suppressed.push({ trigger: c.trigger, reason: "daily-cap" }); return { state: s, page: null, suppressed }; }
  if (!ok.length) return { state: s, page: null, suppressed };

  for (const c of ok) s.lastSent[c.trigger] = at;
  s.dayCount++;
  return { state: s, page: { at, triggers: ok.map(c => c.trigger), title: ok.length === 1 ? `Osiris: ${ok[0].trigger}` : "Osiris: fleet needs a look", text: ok.map(c => c.line).join("\n") }, suppressed };
}
