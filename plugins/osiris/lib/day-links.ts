// PURE: the day inspector's WORKSTREAMS and NEIGHBOURS. Workstreams = the threads the day's own events name (event.threadIds, the spine's own
// join); neighbours = the OTHER days that name any of those threads, with which ones they share. Nothing is inferred from text.
import type { SpineEvent, SpineThread } from "../spine-index.ts";

/** Section order of the day inspector (owner 2026-10-11): log, workstreams, neighbours, decisions, threads done, commits LAST. Kinds only; the two linked sections sit between "log" and "decision". */
export const DAY_INSPECTOR_ORDER: readonly string[] = ["log", "@workstreams", "@neighbours", "decision", "thread-done", "commit", "spend"];
export const kindRank = (kind: string): number => { const i = DAY_INSPECTOR_ORDER.indexOf(kind); return i < 0 ? DAY_INSPECTOR_ORDER.length : i; };

export type DayWorkstream = { id: string; title: string; events: number };
export type DayNeighbour = { date: string; shared: string[] };

export function dayWorkstreams(events: readonly SpineEvent[], date: string, threads: readonly SpineThread[]): DayWorkstream[] {
  const n = new Map<string, number>();
  for (const e of events) if (e.date === date) for (const id of new Set(e.threadIds)) n.set(id, (n.get(id) ?? 0) + 1);
  const title = new Map(threads.map(t => [t.id, t.title] as const));
  return [...n].map(([id, events]) => ({ id, title: title.get(id) ?? "", events })).sort((a, b) => b.events - a.events || a.id.localeCompare(b.id));
}

export const LINKED_CAP = 12;
/** What the app does when a neighbour (or any day link) is clicked: the calendar selection becomes that day. */
export const selectDay = (date: string): { kind: "day"; date: string } => ({ kind: "day", date });

/** Other days sharing >=1 of the day's workstreams: most shared first, then nearest in time, then date. `items` is capped; `total` is the uncapped count (D-138: the view says "+N more days"). */
export function dayNeighbours(events: readonly SpineEvent[], date: string, limit = LINKED_CAP): { items: DayNeighbour[]; total: number } {
  const mine = new Set(events.filter(e => e.date === date).flatMap(e => e.threadIds));
  if (!mine.size) return { items: [], total: 0 };
  const by = new Map<string, Set<string>>();
  for (const e of events) { if (e.date === date) continue; for (const id of e.threadIds) if (mine.has(id)) (by.get(e.date) ?? by.set(e.date, new Set()).get(e.date)!).add(id); }
  const dist = (d: string) => Math.abs(Date.parse(d) - Date.parse(date)) || 0;
  const all = [...by].map(([d, s]) => ({ date: d, shared: [...s].sort() })).sort((a, b) => b.shared.length - a.shared.length || dist(a.date) - dist(b.date) || a.date.localeCompare(b.date));
  return { items: all.slice(0, limit), total: all.length };
}
