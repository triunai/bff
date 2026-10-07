// The ONE time range the Calls views share (Overview and Cost & cache): the ids, the span, the filter and the freshness wording (pure).
// The range only chooses which events are DISPLAYED and summed. Cache-miss classification keeps reading the full history
// (telemetry-model.ts), so narrowing the range never turns a real prefix break into a "cold start".
export type RangeId = "today" | "7d" | "30d";
export const DEFAULT_RANGE: RangeId = "7d";
export const RANGES: readonly { id: RangeId; label: string; hint: string }[] = [
  { id: "today", label: "Today", hint: "Since midnight, this computer's time." },
  { id: "7d", label: "7 days", hint: "The last 7 days." },
  { id: "30d", label: "30 days", hint: "The last 30 days, as far back as Osiris reads transcripts." },
];
const DAY = 86_400_000;
/** Osiris reads agent transcripts no older than this (TELEMETRY_LIMITS.maxAgeMs): a longer range cannot show more cost than this. */
export const READ_CAP_MS = 7 * DAY;
export const isRangeId = (v: unknown): v is RangeId => v === "today" || v === "7d" || v === "30d";
/** How far back the range reaches from `now`, in ms. Today = since local midnight (at least 1 ms). */
export function rangeSpanMs(id: RangeId, now: number): number {
  if (id === "7d") return 7 * DAY;
  if (id === "30d") return 30 * DAY;
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  return Math.max(1, now - d.getTime());
}
/** Items started inside the range. An item with no usable time cannot be dated and is kept (the same rule the cost window uses). */
export function filterByRange<T extends { startedAt: number | null }>(items: readonly T[], id: RangeId, now: number): T[] {
  const span = rangeSpanMs(id, now);
  return items.filter(c => c.startedAt === null || !Number.isFinite(c.startedAt) || now - c.startedAt <= span);
}
/** Said under the control when the range is longer than the transcripts Osiris reads; null when the range is fully covered. */
export const rangeNote = (id: RangeId): string | null => (id === "30d" ? "Cost covers the last 7 days: Osiris does not read older agent transcripts." : null);
export const rangeWords = (id: RangeId): string => (id === "today" ? "today" : id === "7d" ? "in 7 days" : "in 7 days (the most that is read)");

export interface FreshnessView { state: "fresh" | "stale" | "unread"; text: string }
/** Fresh while the last read is younger than 2 minutes (the tab re-reads every 10 s, so older means the reads stopped). */
export const STALE_MS = 120_000;
export function freshnessOf(polledAt: number | null | undefined, now: number): FreshnessView {
  if (!polledAt) return { state: "unread", text: "Not read yet" };
  const age = Math.max(0, now - polledAt);
  const words = age < 1000 ? "just now" : age < 60_000 ? `${Math.round(age / 1000)}s ago` : age < 3_600_000 ? `${Math.round(age / 60_000)} min ago` : `${Math.round(age / 3_600_000)} h ago`;
  return age < STALE_MS ? { state: "fresh", text: `Fresh: read ${words}` } : { state: "stale", text: `Stale: last read ${words}` };
}
/** The label the cost cards print for the range the answer was built for (30 days is capped by what is read). */
export const rangeLabel = (id: RangeId): string => (id === "today" ? "today" : id === "7d" ? "last 7 days" : "last 7 days (the most that is read)");
