// Per-LOCAL-day spend for the Calendar (pure). It aggregates the SAME transcript units the Calls cost views use, priced by the one
// priceFor (via aggregate/rowCost): list-price estimates, null (shown "n/a") when any model that day is unpriced, never a silent $0.
// PRIVACY: numbers and lane names only (the caller seals the names). Rows with no timestamp cannot be dated and are left out.
import { aggregate, rowCost } from "../cache-economics.ts";
import type { Call } from "../analytics.ts";
import type { UsageRow } from "../cache-economics.ts";
import type { TelemetryUnit } from "../telemetry-join.ts";
import { providerOf } from "./providers/registry.ts";
import type { ProviderId } from "./providers/registry.ts";
export type { ProviderId };

// Provider of a usage row = the ONE registry's providerOf(model). Only Claude transcripts carry per-call usage today, so codex/gemini read "n/a".

export interface SpendPart { /** dollars, null when any model in the part is unpriced */ usd: number | null; pricedUsd: number; tokens: number; requests: number }
export interface AgentSpend extends SpendPart { lane: string }
export interface DaySpend extends SpendPart {
  date: string;
  input: number; output: number; cacheRead: number; cacheWrite: number;
  /** cache_read / (cache_read + input + cache_creation), null with no input-side tokens */
  hitRate: number | null;
  byProvider: Partial<Record<ProviderId, SpendPart>>;
  /** Biggest priced spend first, at most MAX_AGENTS. */
  topAgents: AgentSpend[];
  /** 24 local-hour buckets of priced dollars. */
  hours: number[];
  hoursTokens: number[];
}
export const MAX_AGENTS = 5;
const pad = (n: number) => String(n).padStart(2, "0");
export const localDay = (ms: number): string => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const tokensOf = (u: { input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number }) => u.input + u.output + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead;
function part(rows: UsageRow[]): SpendPart & { input: number; output: number; cacheRead: number; cacheWrite: number; hitRate: number | null } {
  const u = aggregate(rows, () => "all")[0];
  return u
    ? { usd: u.cost, pricedUsd: u.pricedCost, tokens: tokensOf(u), requests: u.requests, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite5m + u.cacheWrite1h, hitRate: u.hitRate }
    : { usd: 0, pricedUsd: 0, tokens: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, hitRate: null };
}
const slim = (p: ReturnType<typeof part>): SpendPart => ({ usd: p.usd, pricedUsd: p.pricedUsd, tokens: p.tokens, requests: p.requests });

/** Oldest day first. `units` are already deduplicated (dedupeUnits); `laneOf` names a unit (the caller's sanitizer). */
export function buildSpendDays(units: readonly TelemetryUnit[], now: number, windowMs: number, laneOf: (u: TelemetryUnit) => string): DaySpend[] {
  type Bucket = { rows: UsageRow[]; hour: UsageRow[][]; prov: Map<ProviderId, UsageRow[]>; unit: Map<number, UsageRow[]> };
  const days = new Map<string, Bucket>();
  units.forEach((u, ui) => {
    for (const r of u.rows) {
      if (r.timestamp === null || !Number.isFinite(r.timestamp) || now - r.timestamp > windowMs) continue;
      const k = localDay(r.timestamp);
      const b = days.get(k) ?? days.set(k, { rows: [], hour: Array.from({ length: 24 }, () => []), prov: new Map(), unit: new Map() }).get(k)!;
      b.rows.push(r); b.hour[new Date(r.timestamp).getHours()].push(r);
      const p = providerOf(r.model)?.id;
      if (p) (b.prov.get(p) ?? b.prov.set(p, []).get(p)!).push(r);
      (b.unit.get(ui) ?? b.unit.set(ui, []).get(ui)!).push(r);
    }
  });
  return [...days].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, b]) => {
    const t = part(b.rows), byProvider: DaySpend["byProvider"] = {};
    for (const [p, rows] of b.prov) byProvider[p] = slim(part(rows));
    // One lane name can span several units (a lane re-spawned): merge by name so a chip is one agent, not one transcript file.
    const lanes = new Map<string, UsageRow[]>();
    for (const [ui, rows] of b.unit) { const n = laneOf(units[ui]); lanes.set(n, [...(lanes.get(n) ?? []), ...rows]); }
    const topAgents = [...lanes].map(([lane, rows]) => ({ lane, ...slim(part(rows)) })).sort((x, y) => y.pricedUsd - x.pricedUsd || y.tokens - x.tokens || (x.lane < y.lane ? -1 : 1)).slice(0, MAX_AGENTS);
    const hp = b.hour.map(rows => part(rows));
    return { date, ...slim(t), input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, hitRate: t.hitRate, byProvider, topAgents, hours: hp.map(h => h.pricedUsd), hoursTokens: hp.map(h => h.tokens) };
  });
}

/** Calendar glue: the call -> usage join (work/call-usage-join.ts) prices what the telemetry rows do not carry, i.e. Codex and Gemini.
 *  Adds every NON-Claude call's joined usage share to its local day (Claude is already counted from the transcript rows, so it is skipped
 *  here, never twice). A provider the registry does not price stays tokens-only (usd null, "price n/a"), never $0. Days outside the read
 *  window are left out. Returns a copy. */
export function withJoinedSpend(byDay: readonly DaySpend[] | undefined, calls: readonly Call[], now: number, windowMs: number): DaySpend[] | undefined {
  if (!byDay) return byDay;
  const days = new Map(byDay.map(d => [d.date, { ...d, byProvider: { ...d.byProvider }, hours: [...d.hours], hoursTokens: [...d.hoursTokens] }]));
  const from = localDay(now - windowMs);
  for (const c of calls) {
    const u = c.usage, p = providerOf(c.provider);
    if (!u || !c.usageMatch?.request || !p || p.id === "claude" || c.startedAt === null || !Number.isFinite(c.startedAt)) continue;
    const date = localDay(c.startedAt);
    if (date < from) continue;
    const d = days.get(date) ?? days.set(date, { date, usd: 0, pricedUsd: 0, tokens: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, hitRate: null, byProvider: {}, topAgents: [], hours: Array.from({ length: 24 }, () => 0), hoursTokens: Array.from({ length: 24 }, () => 0) }).get(date)!;
    const tokens = tokensOf(u), n = Math.max(1, c.usageMatch.siblings);
    const usd = p.priced ? rowCost({ model: c.model, input: u.input, output: u.output, cacheWrite5m: u.cacheWrite5m, cacheWrite1h: u.cacheWrite1h, cacheRead: u.cacheRead } as UsageRow) : null;
    const prev = d.byProvider[p.id] ?? { usd: 0, pricedUsd: 0, tokens: 0, requests: 0 };
    d.byProvider[p.id] = { usd: prev.usd === null || usd === null ? null : prev.usd + usd, pricedUsd: prev.pricedUsd + (usd ?? 0), tokens: prev.tokens + tokens, requests: prev.requests + 1 / n };
    d.usd = d.usd === null || usd === null ? null : d.usd + usd; d.pricedUsd += usd ?? 0; d.tokens += tokens; d.requests += 1 / n;
    const h = new Date(c.startedAt).getHours(); d.hours[h] += usd ?? 0; d.hoursTokens[h] += tokens;
  }
  return [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}
