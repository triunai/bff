// Wrap counter (td-osi.10) — how many times the owner ran the end-of-session wrap ritual. Pure: no git, no clock, no storage.
//
// Going forward the count is EXACT: the wrap-session skill stamps its commit with a trailer `Wrap: <YYYY-MM-DD>#<N>`
// (N = that day's sequence number, owner timezone). Before the stamp existed, wraps are ESTIMATED from commit subjects.
//
// Read the log with exactly this format (one line per commit, tab-separated, trailers unfolded onto the line):
//   git log --format='%H%x09%ad%x09%s%x09%(trailers:key=Wrap,valueonly,separator=%x2C)' --date=iso-strict
// i.e. `<sha> TAB <iso-strict author date> TAB <subject> TAB <Wrap trailer values, comma-separated, or empty>`.
import type { HealthSnapshot } from "./health-types.ts";

export const WRAP_TRAILER = "Wrap";
/** The owner's timezone (+08, no DST), used to decide which calendar day a wrap belongs to. */
export const WRAP_TZ = "Asia/Kuala_Lumpur";

export type WrapSource = "trailer" | "heuristic";
export type Wrap = {
  sha: string;
  /** epoch ms of the commit. */
  at: number;
  subject: string;
  source: WrapSource;
  /** `YYYY-MM-DD#N` for trailer wraps; null for heuristic ones. */
  stamp: string | null;
};
export type WrapDay = { day: string; exact: number; heuristic: number; total: number };
export type WrapCounts = {
  today: number;
  /** Monday-start week containing `now`, through today. */
  week: number;
  /** The last 14 days, oldest first, ending with today (zero-filled). */
  series: WrapDay[];
  /** Over every wrap given, not just the 14-day window. */
  exact: number;
  heuristic: number;
};

const STAMP = /^(\d{4}-\d{2}-\d{2})#(\d+)$/;

/**
 * Subject heuristic, tuned on the webshop log (see YB-REPORT). A wrap COMMIT is a `docs` commit whose description opens with
 * the word `wrap` (`docs(state): wrap 2026-10-07 - ...`, `docs: wrap the multicard wave`, `docs(state): WRAP pass`), or says
 * `+ wrap the ...` / `round 5 wrap`, or uses the `docs(wrap):` scope. Rejects: other commit types (`refactor: ...Wrapper`,
 * `feat: ...client wrapper`), `docs(reviews):`, merges that merely mention a wrap, `wrap-session` skill edits, `wrapper`,
 * `wraps` (the verb: "the studio cluster wraps on step two") and subjects about the counter itself.
 */
export const WRAP_SUBJECT = new RegExp(
  "^docs(?:\\((?:state|docs)\\))?!?:\\s*(?:" +
    "wrap(?![\\w-])(?!\\s+(?:counter|skill|trailer|stamp)\\b)" + // `wrap 2026-..`, `wrap the ..`, `wrap - ..`
    "|round\\s+\\S+\\s+wrap(?![\\w-])" + // `round 5 wrap`, `round 6+7 wrap`
    "|.*\\s\\+\\s+wrap\\s+the\\b" + // `fold final thermo findings + wrap the afternoon`
  ")|^docs\\(wrap\\)!?:",
  "i",
);
/** Heuristic wraps closer together than this are one ritual that landed as several commits (e.g. board + spine). */
export const HEURISTIC_MERGE_MS = 30 * 60 * 1000;

export function parseWrapLog(lines: string[]): Wrap[] {
  const out: Wrap[] = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const [sha = "", date = "", subject = "", trailers = ""] = raw.replace(/\r$/, "").split("\t");
    const at = Date.parse(date);
    if (!sha || Number.isNaN(at)) continue;
    const stamp = trailers.split(",").map(s => s.trim()).find(s => STAMP.test(s)) ?? null;
    if (stamp) out.push({ sha, at, subject, source: "trailer", stamp });
    else if (WRAP_SUBJECT.test(subject)) out.push({ sha, at, subject, source: "heuristic", stamp: null });
  }
  out.sort((a, b) => a.at - b.at);
  // Collapse heuristic runs (several commits of one ritual) onto the first; trailer wraps are exact and never merged.
  const merged: Wrap[] = [];
  let lastHeuristic = -Infinity;
  for (const w of out) {
    if (w.source === "heuristic") {
      if (w.at - lastHeuristic <= HEURISTIC_MERGE_MS) { lastHeuristic = w.at; continue; }
      lastHeuristic = w.at;
    }
    merged.push(w);
  }
  return merged;
}

/** `YYYY-MM-DD` of an instant in `tz`. */
export function dayKey(at: number, tz: string = WRAP_TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const shiftDay = (day: string, by: number) => new Date(dayMs(day) + by * 86_400_000).toISOString().slice(0, 10);
/** Monday of the week containing `day`. */
const weekStart = (day: string) => shiftDay(day, -((new Date(dayMs(day)).getUTCDay() + 6) % 7));

export function countWraps(wraps: Wrap[], opts: { now: number; tz?: string }): WrapCounts {
  const tz = opts.tz ?? WRAP_TZ;
  const today = dayKey(opts.now, tz);
  const perDay = new Map<string, { exact: number; heuristic: number }>();
  let exact = 0, heuristic = 0;
  for (const w of wraps) {
    // A trailer's own date is the owner's word for which day this wrap belongs to; fall back to the commit instant.
    const day = (w.stamp && STAMP.exec(w.stamp)?.[1]) || dayKey(w.at, tz);
    const e = perDay.get(day) ?? { exact: 0, heuristic: 0 };
    if (w.source === "trailer") { e.exact++; exact++; } else { e.heuristic++; heuristic++; }
    perDay.set(day, e);
  }
  const series: WrapDay[] = [];
  for (let i = 13; i >= 0; i--) {
    const day = shiftDay(today, -i), e = perDay.get(day) ?? { exact: 0, heuristic: 0 };
    series.push({ day, ...e, total: e.exact + e.heuristic });
  }
  const ws = weekStart(today);
  let week = 0;
  for (const [day, e] of perDay) if (day >= ws && day <= today) week += e.exact + e.heuristic;
  const t = perDay.get(today);
  return { today: t ? t.exact + t.heuristic : 0, week, series, exact, heuristic };
}

/** The `Wrap:` trailer VALUE for the next wrap: `<today>#<N>`, N one past the highest stamp already used today. */
export function nextWrapStamp(wraps: Wrap[], today: string): string {
  let max = 0;
  for (const w of wraps) {
    const m = w.stamp ? STAMP.exec(w.stamp) : null;
    if (m && m[1] === today) max = Math.max(max, Number(m[2]));
  }
  return `${today}#${max + 1}`;
}

/** Health-trend shape: one observation whose figures are the wrap counts (`wraps:today`, `wraps:week`). */
export function wrapSnapshot(counts: WrapCounts, at: number): HealthSnapshot {
  return { at, figures: { "wraps:today": counts.today, "wraps:week": counts.week } };
}
