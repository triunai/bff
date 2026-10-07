// The Calendar's SPEND kind (pure view model). Day figures come from telemetry (WorkTelemetry.byDay, work/spend-days.ts): the same
// transcript rows and the one priceFor the Calls cost views use. This file only shapes them for the Lite dot, the Full chip, the day
// summary row, the Week bars, the Month header and the Day hourly strip, and decides what is honest to say about each day.
//   - priced: list-price estimate, never a bill. A day with an unpriced model reads "n/a" for dollars, never $0.
//   - older than the read window (7 days of transcripts): "not captured", never $0.
//   - the oldest captured day and any day read while history is still loading are marked partial.
import { compactCount } from "./work/telemetry-model.ts";
import { heatLevel } from "./day-ui.ts";
import { dayKey } from "./spine-calendar.ts";
import { localDay, type DaySpend, type SpendPart } from "./work/spend-days.ts";
import { PROVIDERS, type ProviderId } from "./work/providers/registry.ts";

export const SPEND_LABEL = "list-price est., not a bill";
export const NOT_CAPTURED = "not captured";

export type SpendStatus = "spent" | "none" | "not-captured";
export interface SpendIndex { byDate: ReadonlyMap<string, DaySpend>; /** first local day the transcripts cover */ capturedFrom: string; /** older history still being read */ catchingUp: boolean; todayKey: string }
export function buildSpendIndex(byDay: readonly DaySpend[] | undefined, now: number, windowMs: number, catchingUp = false): SpendIndex | null {
  if (!byDay) return null; // an older answer without the figures: the Calendar shows no spend at all rather than guessing
  return { byDate: new Map(byDay.map(d => [d.date, d])), capturedFrom: localDay(now - windowMs), catchingUp, todayKey: localDay(now) };
}
export function spendStatus(ix: SpendIndex, date: string): SpendStatus {
  if (ix.byDate.has(date)) return "spent";
  return date < ix.capturedFrom ? "not-captured" : "none";
}
/** Partial = the window edge cuts this day, or older history is still loading. */
export const spendPartial = (ix: SpendIndex, date: string): boolean => ix.byDate.has(date) && (date === ix.capturedFrom || ix.catchingUp);

/** "$0.42" / "$12.40" / "$1,774"; null (unpriced) is "n/a". */
export const spendUsdText = (n: number | null): string => n === null || !Number.isFinite(n) ? "n/a" : n >= 1000 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`;
export const spendTokText = (n: number): string => `${compactCount(n)} tok`;
/** The Full cell chip: cost first, tokens only when the cost is n/a. "$12.40 · 3.1M tok" / "3.1M tok". */
export const spendChipText = (d: Pick<DaySpend, "usd" | "tokens">): string => d.usd === null ? spendTokText(d.tokens) : `${spendUsdText(d.usd)} · ${spendTokText(d.tokens)}`;
/** Dot / chip hover and screen-reader title. */
export function spendTitle(ix: SpendIndex, date: string): string {
  const d = ix.byDate.get(date);
  if (!d) return spendStatus(ix, date) === "not-captured" ? `spend ${NOT_CAPTURED}` : "no spend recorded";
  return `spend ${spendChipText(d)} (${SPEND_LABEL})${spendPartial(ix, date) ? " · partial day" : ""}${d.usd === null ? " · some models have no price" : ""}`;
}

/** Heat step 1..4 of a day against the busiest day in `dates`; 0 when the day has no priced spend (a tokens-only day still gets step 1). */
export function spendLevel(ix: SpendIndex, date: string, dates: readonly string[]): 0 | 1 | 2 | 3 | 4 {
  const d = ix.byDate.get(date);
  if (!d) return 0;
  const max = dates.reduce((m, k) => Math.max(m, ix.byDate.get(k)?.pricedUsd ?? 0), 0);
  return d.pricedUsd > 0 ? heatLevel(d.pricedUsd, max) : 1;
}

export interface SpendTotal { /** sum of the priced days; a lower bound when !complete */ pricedUsd: number; complete: boolean; tokens: number; /** days with data */ days: number; notCaptured: number; partial: boolean }
export function sumSpend(ix: SpendIndex, dates: readonly string[]): SpendTotal {
  let pricedUsd = 0, tokens = 0, days = 0, notCaptured = 0, complete = true, partial = false;
  for (const k of dates) {
    const d = ix.byDate.get(k);
    if (!d) { if (spendStatus(ix, k) === "not-captured") notCaptured++; continue; }
    days++; pricedUsd += d.pricedUsd; tokens += d.tokens; if (d.usd === null) complete = false; if (spendPartial(ix, k)) partial = true;
  }
  return { pricedUsd, complete, tokens, days, notCaptured, partial };
}
const totalText = (t: SpendTotal) => `${t.complete ? "" : "at least "}${spendUsdText(t.pricedUsd)} est. · ${spendTokText(t.tokens)}`;

export const monthDates = (year: number, month0: number): string[] => Array.from({ length: new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate() }, (_, i) => dayKey(year, month0, i + 1));
export interface MonthSpend { total: SpendTotal; /** "$1,774 est. · 5.7B tok" */ text: string; note: string; bars: { date: string; pricedUsd: number; level: 0 | 1 | 2 | 3 | 4; status: SpendStatus }[] }
export function monthSpend(ix: SpendIndex, year: number, month0: number): MonthSpend {
  const dates = monthDates(year, month0), total = sumSpend(ix, dates);
  const note = total.days === 0 ? (total.notCaptured > 0 ? `${NOT_CAPTURED} (transcripts are read for 7 days)` : "no spend recorded") : [SPEND_LABEL, total.notCaptured > 0 ? `${total.notCaptured} ${total.notCaptured === 1 ? "day" : "days"} ${NOT_CAPTURED}` : "", total.partial ? "partial data" : ""].filter(Boolean).join(" · ");
  return { total, text: total.days === 0 ? "" : totalText(total), note, bars: dates.map(date => ({ date, pricedUsd: ix.byDate.get(date)?.pricedUsd ?? 0, level: spendLevel(ix, date, dates), status: spendStatus(ix, date) })) };
}
export interface WeekSpend { total: SpendTotal; text: string; note: string; days: { date: string; pricedUsd: number; usd: number | null; tokens: number; /** 0..1 against the week's busiest day */ ratio: number; status: SpendStatus; partial: boolean; label: string }[] }
export function weekSpend(ix: SpendIndex, dates: readonly string[]): WeekSpend {
  const total = sumSpend(ix, dates), max = dates.reduce((m, k) => Math.max(m, ix.byDate.get(k)?.pricedUsd ?? 0), 0);
  const days = dates.map(date => { const d = ix.byDate.get(date); return { date, pricedUsd: d?.pricedUsd ?? 0, usd: d ? d.usd : null, tokens: d?.tokens ?? 0, ratio: d && max > 0 ? d.pricedUsd / max : 0, status: spendStatus(ix, date), partial: spendPartial(ix, date), label: spendTitle(ix, date) }; });
  const note = total.days === 0 ? (total.notCaptured > 0 ? NOT_CAPTURED : "no spend recorded") : [SPEND_LABEL, total.notCaptured > 0 ? `${total.notCaptured} ${NOT_CAPTURED}` : "", total.partial ? "partial data" : ""].filter(Boolean).join(" · ");
  return { total, text: total.days === 0 ? "" : totalText(total), note, days };
}
export interface HourStrip { hours: { hour: number; pricedUsd: number; tokens: number; ratio: number }[]; text: string; note: string; status: SpendStatus }
export function hourStrip(ix: SpendIndex, date: string): HourStrip {
  const d = ix.byDate.get(date), status = spendStatus(ix, date);
  const max = d ? Math.max(0, ...d.hours) : 0, maxTok = d ? Math.max(0, ...d.hoursTokens) : 0;
  return {
    status, text: d ? spendChipText(d) : "",
    note: d ? `${SPEND_LABEL}${spendPartial(ix, date) ? " · partial day" : ""}` : status === "not-captured" ? NOT_CAPTURED : "no spend recorded",
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, pricedUsd: d?.hours[hour] ?? 0, tokens: d?.hoursTokens[hour] ?? 0, ratio: d ? (max > 0 ? d.hours[hour] / max : maxTok > 0 ? d.hoursTokens[hour] / maxTok : 0) : 0 })),
  };
}

/** The day summary's SPEND row. */
export interface SpendRow {
  status: SpendStatus; total: string; partial: boolean; note: string;
  providers: { id: ProviderId; label: string; text: string }[];
  agents: { lane: string; text: string }[];
  cache: string | null;
}
export function spendRow(ix: SpendIndex, date: string): SpendRow {
  const d = ix.byDate.get(date), status = spendStatus(ix, date);
  if (!d) return { status, total: status === "not-captured" ? NOT_CAPTURED : "no spend recorded", partial: false, note: status === "not-captured" ? "transcripts are read for 7 days only" : "", providers: [], agents: [], cache: null };
  const part = (p: SpendPart | undefined) => !p ? "n/a" : p.usd === null ? `price n/a · ${spendTokText(p.tokens)}` : spendChipText(p);
  const partial = spendPartial(ix, date);
  return {
    status, partial, total: `${spendChipText(d)} est.`, note: `${SPEND_LABEL}${partial ? " · partial day" : ""}`,
    providers: PROVIDERS.map(p => ({ id: p.id, label: p.label, text: part(d.byProvider[p.id]) })),
    agents: d.topAgents.map(a => ({ lane: a.lane, text: part(a) })),
    cache: d.hitRate === null ? null : `${Math.round(d.hitRate * 100)}% cache hit`,
  };
}
/** Plain-text prompt body for "Ask an agent" on the spend row. */
export const spendAskLines = (date: string, r: SpendRow): string[] => r.status !== "spent" ? [`Spend on ${date}: ${r.total}.`] : [
  `Spend on ${date}: ${r.total} (${r.note}).`, `By provider: ${r.providers.map(p => `${p.label} ${p.text}`).join("; ")}.`,
  r.agents.length ? `Top agents: ${r.agents.map(a => `${a.lane} ${a.text}`).join("; ")}.` : "Top agents: none.", r.cache ? `Cache: ${r.cache}.` : "Cache: no input tokens.",
];
