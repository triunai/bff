// PURE helpers for the day strip + day panel (W-197 Git + Calendar). No DOM, no IO, no clock, no locale: every date here is a
// plain "YYYY-MM-DD" calendar string already resolved to the BB host's local day by the reader, so nothing shifts by UTC.
import type { DayCommit, DayCounts } from "./git-types.ts";

export type StripDay = { date: string; n: number; level: 0 | 1 | 2 | 3 | 4 };
export type SourceGroup = { source: string; commits: DayCommit[] };

export const UNATTRIBUTED = "unattributed";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Safety bound on a strip: a malformed range must not allocate an unbounded array. */
const MAX_STRIP_DAYS = 400;

/** Parses a strict "YYYY-MM-DD" into parts and rejects impossible dates ("2026-02-30"). */
export function parseDate(date: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? { y, m: mo, d } : null;
}
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Heat level 0..4. 0 ONLY for n <= 0; any commit day is at least 1. Scale is logarithmic, log(1+n)/log(1+max) bucketed into
 * quarters, so one 300-commit day does not flatten every 3-commit day to level 1. Monotone non-decreasing in n; n >= max is 4.
 */
export function heatLevel(n: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (!(n > 0)) return 0;
  const top = Math.max(max, n);
  const ratio = Math.log1p(n) / Math.log1p(top);
  return Math.min(4, Math.max(1, Math.ceil(ratio * 4))) as 1 | 2 | 3 | 4;
}

/** Every day between the range start and end, inclusive, zero days included, oldest first. Calendar arithmetic runs on Y/M/D parts (UTC used
 * only as a DST-free day counter), so a 23h or 25h local day is still exactly one entry. Invalid or reversed range -> []. */
export function stripDays(c: { from: string; to: string; counts: Record<string, number> }): StripDay[] {
  const a = parseDate(c.from), b = parseDate(c.to);
  if (!a || !b) return [];
  const start = Date.UTC(a.y, a.m - 1, a.d), end = Date.UTC(b.y, b.m - 1, b.d);
  if (end < start) return [];
  const span = Math.min(Math.round((end - start) / 86_400_000) + 1, MAX_STRIP_DAYS);
  const raw: { date: string; n: number }[] = [];
  for (let i = 0; i < span; i++) {
    const t = new Date(start + i * 86_400_000);
    const date = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
    const n = c.counts[date];
    raw.push({ date, n: Number.isFinite(n) && n > 0 ? n : 0 });
  }
  const max = raw.reduce((m, d) => Math.max(m, d.n), 0);
  return raw.map(d => ({ ...d, level: heatLevel(d.n, max) }));
}

/** "2026-10-06" -> "Tue 6 Oct 2026". English, fixed, locale-independent; an unparseable input is returned unchanged. */
export function humanDate(date: string): string {
  const p = parseDate(date);
  if (!p) return date;
  return `${WEEKDAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()]} ${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}

/** Local wall-clock "HH:MM" of an epoch-ms instant (the viewer's zone, which is the BB host's day for a local plugin). */
export function clockTime(ms: number): string {
  if (!Number.isFinite(ms)) return "--:--";
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Commits grouped by the ref they were reached by: larger groups first, ties by name; a null/empty source is "unattributed".
 * Commit order inside a group is the reader's order (newest first) and is not changed. */
export function groupBySource(commits: readonly DayCommit[]): SourceGroup[] {
  const by = new Map<string, DayCommit[]>();
  for (const c of commits) {
    const key = c.source && c.source.trim() ? c.source : UNATTRIBUTED;
    const list = by.get(key);
    if (list) list.push(c); else by.set(key, [c]);
  }
  return [...by].map(([source, list]) => ({ source, commits: list }))
    .sort((x, y) => y.commits.length - x.commits.length || (x.source < y.source ? -1 : x.source > y.source ? 1 : 0));
}

export function dayTotals(commits: readonly DayCommit[]): { commits: number; branches: number } {
  return { commits: commits.length, branches: groupBySource(commits).length };
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One entry of a repo/branch legend row: its own key, the FULL name (for the hover title) and a lane colour index (the dot). */
export type LegendItem = { key: string; name: string; color: number; /** position in the input list */ index: number };
/** One item per name, in order, each with its own dot colour (cycles through the 8 lane colours). Blank names are dropped. The row renders
 * every item as its own element with a gap, so names can never run together as one string. */
export function legendItems(names: readonly string[]): LegendItem[] {
  return names.map((n, i) => ({ n: String(n ?? "").trim(), i })).filter(x => x.n).map(x => ({ key: `${x.i}:${x.n}`, name: x.n, color: x.i % 8, index: x.i }));
}
