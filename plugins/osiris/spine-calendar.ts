/** Pure month-grid arithmetic (Monday-first, UTC Date math only for weekday/length). Dates are local YYYY-MM-DD strings; never `new Date("YYYY-MM-DD")`. */
export type YearMonth = { year: number; month0: number };
const pad = (n: number) => String(n).padStart(2, "0");

/** Leading nulls then day numbers; Monday first. */
export function monthCells(year: number, month0: number): Array<number | null> {
  const first = new Date(Date.UTC(year, month0, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const lead = (first + 6) % 7;
  return [...Array.from({ length: lead }, () => null), ...Array.from({ length: days }, (_, i) => i + 1)];
}
export const dayKey = (year: number, month0: number, day: number) => `${year}-${pad(month0 + 1)}-${pad(day)}`;
export function monthOf(date: string): YearMonth | null {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
  return m ? { year: Number(m[1]), month0: Number(m[2]) - 1 } : null;
}
export function shiftMonth({ year, month0 }: YearMonth, delta: number): YearMonth {
  const t = year * 12 + month0 + delta;
  return { year: Math.floor(t / 12), month0: ((t % 12) + 12) % 12 };
}
const NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthLabel = ({ year, month0 }: YearMonth) => `${NAMES[month0]} ${year}`;
/** Today in the machine's local zone, as YYYY-MM-DD. */
export const localDayKey = (d = new Date()) => dayKey(d.getFullYear(), d.getMonth(), d.getDate());
export function eventsByDay<T extends { date: string }>(events: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const e of events) m.set(e.date, [...(m.get(e.date) ?? []), e]);
  return m;
}
/** Commits whose local calendar day (the machine's zone, same as the grid's day keys) is `date`. Boundaries are local midnights built from
 * Y/M/D parts, so a 23h or 25h DST day is still one day; 23:59:59 belongs to `date`, 00:00:00 to the next day. */
export function commitsOnDay<T extends { committedAt: number }>(commits: readonly T[], date: string): T[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return [];
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const start = new Date(y, mo, d).getTime(), end = new Date(y, mo, d + 1).getTime();
  return commits.filter(c => c.committedAt >= start && c.committedAt < end);
}

/** The Monday-first week (7 local YYYY-MM-DD keys) containing `date`; [] for an unparseable date. UTC math is only a DST-free day counter. */
export function weekOf(date: string): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return [];
  const t0 = Date.UTC(+m[1], +m[2] - 1, +m[3]), lead = (new Date(t0).getUTCDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(t0 + (i - lead) * 86_400_000); return dayKey(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); });
}
