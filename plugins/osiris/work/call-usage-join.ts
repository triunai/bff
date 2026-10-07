// Call -> model-request usage join (pure and browser-safe: the server seals an index with it, the client joins with it).
// Every provider's transcript carries the usage of a model REQUEST, and a request can emit several tool calls at once, so a call gets one of
// three honest tiers (design complaint 4):
//   exact  - the request that emitted the call made only this call: the call shows the request's tokens and price.
//   shared - one request emitted N calls (parallel tool use), or the call could only be matched by its turn: the call shows ~1/N of the
//            request, labelled, and the request is counted ONCE in every total (never once per call).
//   none   - no transcript line was found; the reason is said (provider not read / transcript not read / call id not in transcript / no id).
// The join key per provider is the registry's joinKey (Claude tool_use id, Codex turn_id / response_id, Gemini toolCalls[].id); the index
// builders live in providers/call-usage-index.ts. PRICE: rowCost -> priceFor (cache-economics.ts), the ONE table; an unpriced provider or
// model is null ("n/a"), never $0. PRIVACY (D-135): the index that crosses the wire is sealed with opaqueKey, so it carries no session id,
// call id or path; only numbers, model ids and opaque keys.
import { rowCost } from "../cache-economics.ts";
import { callKey } from "../analytics.ts";
import type { Call, CallUsage } from "../analytics.ts";
import { opaqueKey } from "./opaque-key.ts";
import { providerById, providerOf } from "./providers/registry.ts";
import type { ProviderId } from "./providers/registry.ts";

export interface RequestUsage extends CallUsage { model: string | null }
/** One provider's transcript index. `calls` maps a call id to its request key, `turns` (Codex) a turn id to its turn-total key, `requests` a key to its usage. */
export interface ProviderIndex {
  /** Sessions (and agent ids) whose transcript was read: separates the reasons transcript-not-read and call-id-not-in-transcript. */
  sessions: string[];
  calls: Record<string, string>;
  turns?: Record<string, string>;
  requests: Record<string, RequestUsage>;
}
export type UsageIndexes = Partial<Record<ProviderId, ProviderIndex>>;

export type Tier = "exact" | "shared" | "none";
export type NoneReason = "no-provider" | "no-transcript" | "no-call" | "no-id";
export type MatchVia = "id" | "turn";
export interface UsageMatch {
  tier: Tier;
  via: MatchVia | null;
  reason: NoneReason | null;
  /** Calls the request emitted (1 for exact). */
  siblings: number;
  /** The WHOLE request's usage (not the per-call share), or null when not matched. */
  request: RequestUsage | null;
  requestUsd: number | null;
  /** requestUsd / siblings. */
  shareUsd: number | null;
  /** The registry's join key for this call's provider ("tool_use id"), said in the drawer. */
  keyName: string | null;
}
export interface UsageJoin { matches: Map<string, UsageMatch>; totals: UsageTotals }
export interface UsageTotals {
  matched: number;
  notMatched: number;
  /** Distinct requests, each counted once. */
  requests: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Sum over distinct requests, or null when any matched request was unpriced. */
  usd: number | null;
}

const NO_PROVIDER = "provider not read", NO_TRANSCRIPT = "transcript not read (older than 7 days)", NO_CALL = "call id not in transcript", NO_ID = "no turn id on this call";
export const REASON_TEXT: Readonly<Record<NoneReason, string>> = { "no-provider": NO_PROVIDER, "no-transcript": NO_TRANSCRIPT, "no-call": NO_CALL, "no-id": NO_ID };

/** Wire key: 13 chars of the opaque key (56 bits, no collision at these sizes), so a 3000-call index stays small. */
const wireKey = (raw: string, salt: string): string => opaqueKey(raw, salt).slice(0, 13);
const hasOwn = (o: object | undefined, k: string): boolean => !!o && Object.hasOwn(o, k);
const toRow = (r: RequestUsage, c: Call) => ({ source: c.source, sessionId: c.sessionId, agentId: null, model: r.model, messageId: null, requestId: null, timestamp: c.startedAt, input: r.input, output: r.output, cacheWrite5m: r.cacheWrite5m, cacheWrite1h: r.cacheWrite1h, cacheRead: r.cacheRead });
const finite = (n: number | null): number | null => (n !== null && Number.isFinite(n) ? n : null);

/** Seal a raw index for the wire: every id becomes an opaque key (opaque-key.ts), so no session id or call id leaves the server. */
export function sealUsageIndexes(idx: UsageIndexes, salt: string): UsageIndexes {
  const out: UsageIndexes = {};
  for (const [id, p] of Object.entries(idx) as [ProviderId, ProviderIndex][]) {
    const k = (s: string) => wireKey(s, salt), map = <V>(o: Record<string, V>, f: (v: V) => unknown = v => v) => Object.fromEntries(Object.entries(o).map(([key, v]) => [k(key), f(v)]));
    out[id] = {
      sessions: p.sessions.map(k), calls: map(p.calls, v => k(v as string)) as Record<string, string>,
      ...(p.turns ? { turns: map(p.turns, v => k(v as string)) as Record<string, string> } : {}),
      requests: map(p.requests) as Record<string, RequestUsage>,
    };
  }
  return out;
}

/** Join every call to its request's usage. `salt` (when the index is sealed) derives the same opaque keys the server used. Pure. */
export function joinCallUsage(calls: readonly Call[], indexes: UsageIndexes | null | undefined, salt?: string): UsageJoin {
  const k = (s: string) => (salt === undefined ? s : wireKey(s, salt));
  const sets = new Map<ProviderId, Set<string>>(), transcriptN = new Map<string, number>(), feedN = new Map<string, number>();
  const rkOf = (id: ProviderId, rk: string) => `${id}\u0000${rk}`;
  for (const [id, p] of Object.entries(indexes ?? {}) as [ProviderId, ProviderIndex][]) {
    sets.set(id, new Set(p.sessions));
    for (const rk of Object.values(p.calls)) transcriptN.set(rkOf(id, rk), (transcriptN.get(rkOf(id, rk)) ?? 0) + 1);
  }
  type Hit = { id: ProviderId; rk: string; via: MatchVia } | { none: NoneReason; id: ProviderId | null };
  const hits = new Map<string, Hit>();
  for (const c of calls) {
    const meta = providerOf(c.provider), idx = meta ? indexes?.[meta.id] : undefined;
    if (!meta || !idx) { hits.set(callKey(c), { none: "no-provider", id: meta?.id ?? null }); continue; }
    let rk = hasOwn(idx.calls, k(c.callId)) ? idx.calls[k(c.callId)] : null, via: MatchVia = "id";
    if (rk === null && c.turnId && hasOwn(idx.turns, k(c.turnId))) { rk = idx.turns![k(c.turnId)]; via = "turn"; }
    if (rk === null || !hasOwn(idx.requests, rk)) { hits.set(callKey(c), { none: !c.turnId && meta.id === "codex" ? "no-id" : sets.get(meta.id)?.has(k(c.sessionId)) ? "no-call" : "no-transcript", id: meta.id }); continue; }
    hits.set(callKey(c), { id: meta.id, rk, via });
    feedN.set(rkOf(meta.id, rk), (feedN.get(rkOf(meta.id, rk)) ?? 0) + 1);
  }
  const matches = new Map<string, UsageMatch>(), counted = new Set<string>();
  const totals: UsageTotals = { matched: 0, notMatched: 0, requests: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usd: 0 };
  for (const c of calls) {
    const h = hits.get(callKey(c))!;
    if ("none" in h) {
      matches.set(callKey(c), { tier: "none", via: null, reason: h.none, siblings: 0, request: null, requestUsd: null, shareUsd: null, keyName: h.id ? providerById(h.id)?.joinKey ?? null : null });
      totals.notMatched++;
      continue;
    }
    const meta = providerById(h.id)!, req = indexes![h.id]!.requests[h.rk], key = rkOf(h.id, h.rk);
    const siblings = Math.max(1, transcriptN.get(key) ?? 0, feedN.get(key) ?? 0);
    const requestUsd = meta.priced ? finite(rowCost(toRow(req, c))) : null;
    matches.set(callKey(c), { tier: h.via === "id" && siblings === 1 ? "exact" : "shared", via: h.via, reason: null, siblings, request: req, requestUsd, shareUsd: requestUsd === null ? null : requestUsd / siblings, keyName: meta.joinKey });
    totals.matched++;
    if (!counted.has(key)) {
      counted.add(key); totals.requests++;
      totals.tokens.input += req.input; totals.tokens.output += req.output; totals.tokens.cacheRead += req.cacheRead; totals.tokens.cacheWrite += req.cacheWrite5m + req.cacheWrite1h;
      totals.usd = totals.usd !== null && requestUsd !== null ? totals.usd + requestUsd : null;
    }
  }
  if (!totals.requests) totals.usd = null;
  return { matches, totals };
}

/** The calls with `usage` (this call's share: the whole request when exact, request / N when shared) and `usageMatch` filled from the join.
 *  A call keeps any usage its source already recorded when the join found no line for it. */
export function attachUsage(calls: readonly Call[], join: UsageJoin): Call[] {
  return calls.map(c => {
    const m = join.matches.get(callKey(c));
    if (!m) return c;
    if (!m.request) return { ...c, usageMatch: m };
    const n = m.siblings, r = m.request;
    return { ...c, model: c.model ?? r.model, usage: { input: r.input / n, output: r.output / n, cacheRead: r.cacheRead / n, cacheWrite5m: r.cacheWrite5m / n, cacheWrite1h: r.cacheWrite1h / n }, usageMatch: m };
  });
}

export const TIER_GLYPH: Readonly<Record<Tier, string>> = { exact: "●", shared: "◐", none: "○" };
/** "shared by 3 calls" / "exact (own request)" / "not matched: <reason>". */
export function tierWords(m: UsageMatch): string {
  if (m.tier === "exact") return "exact (own request)";
  if (m.tier === "shared") return m.via === "turn" ? `turn total, shared by ${m.siblings} calls` : `shared by ${m.siblings} calls`;
  return `not matched: ${REASON_TEXT[m.reason ?? "no-call"]}`;
}
/** The drawer's explanation sentence. */
export function tierExplanation(m: UsageMatch): string {
  if (m.tier === "exact") return "This call made its own model request. The request's tokens and price are this call's.";
  if (m.tier === "shared") return m.via === "turn"
    ? `Only the turn could be matched: the turn's total is shared by ${m.siblings} calls and counted once in every total.`
    : `One model request made this call and ${m.siblings - 1} other${m.siblings === 2 ? "" : "s"} in parallel. The request is counted once in every total.`;
  return `No usage line was found for this call (${REASON_TEXT[m.reason ?? "no-call"]}). It is listed as not matched under every total.`;
}
/** "matched by tool_use id" / "matched by turn" / null. */
export const matchedBy = (m: UsageMatch): string | null => (m.tier === "none" ? null : m.via === "turn" ? "matched by turn" : `matched by ${m.keyName ?? "call id"}`);
