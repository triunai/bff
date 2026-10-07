// Per-call token usage and estimated price (pure). The price is cache-economics' priceFor via rowCost: the SAME function the Cost & cache
// tab uses, never a second table. PRIVACY: counts and dollars only. An unknown model is "n/a", never $0 (the ccusage $0 bug).
import type { Call } from "../analytics.ts";
import { rowCost, type UsageRow } from "../cache-economics.ts";

export interface CallTokens { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface CallCostView { tokens: CallTokens | null; usd: number | null }
export interface RunCostView { tokens: CallTokens | null; usd: number | null; /** calls in the run that carried no usage */ uncounted: number; /** every call in the run carried usage */ complete: boolean }

const asRow = (c: Call): UsageRow => ({ source: c.source, sessionId: c.sessionId, agentId: null, model: c.model, messageId: null, requestId: null, timestamp: c.startedAt, input: c.usage!.input, output: c.usage!.output, cacheWrite5m: c.usage!.cacheWrite5m, cacheWrite1h: c.usage!.cacheWrite1h, cacheRead: c.usage!.cacheRead });
const tokensOf = (c: Call): CallTokens | null => c.usage ? { input: c.usage.input, output: c.usage.output, cacheRead: c.usage.cacheRead, cacheWrite: c.usage.cacheWrite5m + c.usage.cacheWrite1h } : null;
const finite = (n: number | null): number | null => n !== null && Number.isFinite(n) ? n : null;

export function callCost(c: Call): CallCostView {
  return c.usage ? { tokens: tokensOf(c), usd: finite(rowCost(asRow(c))) } : { tokens: null, usd: null };
}
/** A run's totals. Dollars are null when ANY counted call is unpriced (a partial sum would read as the whole price); calls with no usage are
 * left out of both sums and reported in `uncounted`. */
export function runCost(calls: readonly Call[]): RunCostView {
  let tokens: CallTokens | null = null, usd: number | null = 0, uncounted = 0;
  for (const c of calls) {
    const v = callCost(c);
    if (!v.tokens) { uncounted++; continue; }
    tokens = tokens ? { input: tokens.input + v.tokens.input, output: tokens.output + v.tokens.output, cacheRead: tokens.cacheRead + v.tokens.cacheRead, cacheWrite: tokens.cacheWrite + v.tokens.cacheWrite } : { ...v.tokens };
    usd = usd !== null && v.usd !== null ? usd + v.usd : null;
  }
  return { tokens, usd: tokens ? usd : null, uncounted, complete: uncounted === 0 && calls.length > 0 };
}

const NA = "n/a";
/** Per-call prices are small: 4 decimals under a cent so "$0.0042" does not round to a misleading "$0.00". */
export const usdPerCallText = (n: number | null): string => n === null || !Number.isFinite(n) ? NA : n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : n < 10 ? `$${n.toFixed(2)}` : `$${n.toFixed(0)}`;
const k = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
/** "in 1.2k · out 340 · cache read 52k · cache write 800" in plain words; null tokens read "tokens n/a". */
export const usageText = (t: CallTokens | null): string => t ? `in ${k(t.input)} · out ${k(t.output)} · cache read ${k(t.cacheRead)} · cache write ${k(t.cacheWrite)}` : "tokens n/a";
