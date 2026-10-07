import type { CalendarKind, SpineEvent } from "./spine-index.ts";

/** THE one calendar kind map (owner 01:13): filter tabs, month-cell pills and the day inspector all import this. */
export type CalendarKindId = CalendarKind | "spend";
export type CalendarKindDef = { kind: CalendarKindId; label: string; one: string; glyph: string; token: string };
export const CALENDAR_KINDS: readonly CalendarKindDef[] = [
  { kind: "commit", label: "commits", one: "commit", glyph: "●", token: "--oi-kind-commit" },
  { kind: "decision", label: "decisions", one: "decision", glyph: "◆", token: "--oi-kind-decision" },
  { kind: "log", label: "log", one: "log", glyph: "▤", token: "--oi-kind-log" },
  { kind: "thread-done", label: "threads done", one: "thread done", glyph: "✓", token: "--oi-kind-thread-done" },
  // Not a spine event: its per-day figures come from telemetry (spend-calendar.ts). Counts never carry it, so pills/dots skip it; the
  // Lite dot, the Full chip and the "Spend" tab are drawn from this one entry.
  { kind: "spend", label: "spend", one: "spend", glyph: "$", token: "--oi-kind-spend" },
];
export type KindFilter = "all" | CalendarKindId;
export type KindCounts = Partial<Record<CalendarKindId, number>>;
export type Pill = { kind: CalendarKindId; n: number; label: string };

export const kindDef = (kind: CalendarKindId): CalendarKindDef => CALENDAR_KINDS.find(k => k.kind === kind)!;
/** "1 commit" / "16 commits" / "1 log" / "2 threads done". */
export function kindLabel(kind: CalendarKindId, n: number): string {
  const d = kindDef(kind);
  return `${n} ${n === 1 ? d.one : d.label}`;
}
export function countKinds(events: readonly Pick<SpineEvent, "kind">[]): KindCounts {
  const c: KindCounts = {};
  for (const e of events) c[e.kind] = (c[e.kind] ?? 0) + 1;
  return c;
}
/** Top kinds by count (ties in CALENDAR_KINDS order); filtered-out kinds excluded; `more` = hidden kinds that still have events. */
export function pillsForDay(counts: KindCounts, filter: KindFilter = "all", maxPills = 2): { shown: Pill[]; more: number } {
  const all = CALENDAR_KINDS.filter(d => (filter === "all" || d.kind === filter) && (counts[d.kind] ?? 0) > 0)
    .map((d, i) => ({ kind: d.kind, n: counts[d.kind]!, label: kindLabel(d.kind, counts[d.kind]!), i }))
    .sort((a, b) => b.n - a.n || a.i - b.i);
  return { shown: all.slice(0, maxPills).map(({ kind, n, label }) => ({ kind, n, label })), more: Math.max(0, all.length - maxPills) };
}
/** Per-kind totals for the visible month (events dated YYYY-MM-DD, month0 is 0-based). */
export function monthKindTotals(events: readonly Pick<SpineEvent, "kind" | "date">[], year: number, month0: number): KindCounts {
  const prefix = `${year}-${String(month0 + 1).padStart(2, "0")}-`;
  return countKinds(events.filter(e => e.date.startsWith(prefix)));
}
export const filterTotal = (totals: KindCounts, filter: KindFilter): number =>
  filter === "all" ? CALENDAR_KINDS.reduce((s, d) => s + (totals[d.kind] ?? 0), 0) : totals[filter] ?? 0;

/** One coloured dot per kind that has activity on the day (state 8), in CALENDAR_KINDS order; `title` names the count for hover and screen readers. */
export type Dot = { kind: CalendarKindId; n: number; token: string; title: string };
export function dotsForDay(counts: KindCounts, filter: KindFilter = "all"): Dot[] {
  return CALENDAR_KINDS.filter(d => (filter === "all" || d.kind === filter) && (counts[d.kind] ?? 0) > 0)
    .map(d => ({ kind: d.kind, n: counts[d.kind]!, token: d.token, title: kindLabel(d.kind, counts[d.kind]!) }));
}
