// Calls full screen (mockup state 2), the pure model. ONE window state (the brush, else the last N hours) filters EVERY tile, and every tile
// is fed by an existing Calls model (tool-dashboard-model kpis / incidentRows / latencyRows, call-cost, cost-cache-model, message-flow-model,
// call-identity): nothing here recomputes a number those already own. PRIVACY: tool names, statuses, normalized error codes, lane labels,
// timestamps and numbers only (the same default-deny list as the dashboard); no arguments, output, ids or paths.
import type { Call } from "../analytics.ts";
import { callKey } from "../analytics.ts";
import { callContext } from "../live-observer.ts";
import { reduceIncidents } from "../triage.ts";
import { hitRate } from "../cache-economics.ts";
import { identityOf, fleetIndex, workspaceResolver } from "./call-identity.ts";
import { callCost, usdPerCallText } from "./call-cost.ts";
import { clockLabel } from "./call-timeline-model.ts";
import { compactCount } from "./telemetry-model.ts";
import { usdText } from "./cost-cache-model.ts";
import { HOUR_MS, incidentRows, inWindow, kpis, latencyRows, msText, pulse } from "./tool-dashboard-model.ts";
import type { IncidentRow, Pulse, TimeWindow } from "./tool-dashboard-model.ts";
import { modelTier } from "./model-tiers.ts";
import { providerOf, PROVIDERS } from "./providers/registry.ts";
import type { ProviderId } from "./providers/registry.ts";
import { matchedBy, TIER_GLYPH, tierExplanation, tierWords } from "./call-usage-join.ts";
import type { Tier } from "./call-usage-join.ts";
import type { FleetSnapshot, MessageEvent } from "./fleet-types.ts";

export type CallsTab = "Overview" | "Agents" | "All" | "Trace" | "Problems" | "Signals" | "Cost";
/** The Calls tab row: three clusters split by hairlines ("|"). */
export const FS_TABS: readonly (CallsTab | "|")[] = ["Overview", "Agents", "|", "All", "Trace", "Problems", "Signals", "|", "Cost"];
/** A tile's "→" link goes to its home tab. */
export const TILE_HOME: Readonly<Record<"spend" | "agents" | "problems" | "tools" | "models", CallsTab>> = { spend: "Cost", agents: "Agents", problems: "Problems", tools: "All", models: "Cost" };

export const WINDOW_PRESETS: readonly { id: string; ms: number; label: string; default?: true }[] = [
  { id: "1h", ms: HOUR_MS, label: "last 1h" }, { id: "6h", ms: 6 * HOUR_MS, label: "last 6h", default: true }, { id: "24h", ms: 24 * HOUR_MS, label: "last 24h" },
];
export const DEFAULT_PRESET_MS = 6 * HOUR_MS;
/** The brush strip always shows the last 24 hours. */
export const BRUSH_SPAN_MS = 24 * HOUR_MS;
export const SPEND_BUCKETS = 24, TOP_TILE_ROWS = 5, FLOW_ROWS = 6;

export const brushDomain = (now: number): { t0: number; t1: number } => ({ t0: now - BRUSH_SPAN_MS, t1: now });
/** THE window every tile reads: the brush when one is set, else the last `presetMs` ending now. */
export const effectiveWindow = (brush: TimeWindow, presetMs: number, now: number): { t0: number; t1: number } => (brush ? { t0: brush.t0, t1: brush.t1 } : { t0: now - presetMs, t1: now });
export const windowWords = (w: { t0: number; t1: number }, brushed: boolean, presetMs: number): string => {
  if (!brushed) return WINDOW_PRESETS.find(p => p.ms === presetMs)?.label ?? `last ${Math.round(presetMs / HOUR_MS)}h`;
  const mins = Math.round((w.t1 - w.t0) / 60_000);
  return mins >= 120 ? `${Math.round(mins / 60)}h selected` : `${mins} min selected`;
};

export interface FsInput { calls: readonly Call[]; fleet: FleetSnapshot | null; now: number; presetMs: number; brush: TimeWindow; selectedKey: string | null }
export type Tone = "run" | "fail" | "acc" | "muted";
export interface FsKpi { key: "agents" | "rate" | "errors" | "p95" | "perHour" | "matched"; label: string; value: string; sub: string; tone: Tone }

const rateText = (n: number | null): string => (n === null ? "—" : n >= 10 ? String(Math.round(n)) : n >= 1 ? n.toFixed(1) : n.toFixed(2));
/** The busiest minute inside the window (calls per minute). */
export function peakPerMinute(calls: readonly Call[]): number {
  const by = new Map<number, number>();
  for (const c of calls) { const t = c.endedAt ?? c.startedAt; if (t === null) continue; const m = Math.floor(t / 60_000); by.set(m, (by.get(m) ?? 0) + 1); }
  return Math.max(0, ...by.values());
}
export interface MatchCounts { matched: number; notMatched: number }
export const matchCounts = (calls: readonly Call[]): MatchCounts => { const matched = calls.filter(c => c.usageMatch && c.usageMatch.tier !== "none").length; return { matched, notMatched: calls.length - matched }; };

export interface SpendBucket { t0: number; claudeUsd: number; tokens: Record<Exclude<ProviderId, "claude">, number>; claudeH: number; codexH: number; geminiH: number }
export interface SpendModel { buckets: SpendBucket[]; totalUsd: number | null; note: string }
const SPEND_NOTE = "Codex and Gemini bars show tokens scaled to the same axis; $ n/a until a price table is approved.";
const tokenSum = (c: Call): number => { const t = callCost(c).tokens; return t ? t.input + t.output + t.cacheRead + t.cacheWrite : 0; };
/** SPEND / HOUR: 24 buckets over the window. Claude bars are dollars (per-call shares, so a shared request is counted once); an unpriced provider's bars are tokens, each scaled to its own maximum. */
export function spendModel(calls: readonly Call[], w: { t0: number; t1: number }): SpendModel {
  const span = Math.max(1, w.t1 - w.t0), size = span / SPEND_BUCKETS;
  const buckets: SpendBucket[] = Array.from({ length: SPEND_BUCKETS }, (_, i) => ({ t0: w.t0 + i * size, claudeUsd: 0, tokens: { codex: 0, gemini: 0 }, claudeH: 0, codexH: 0, geminiH: 0 }));
  let usd = 0, priced = false;
  for (const c of calls) {
    const t = c.endedAt ?? c.startedAt, p = providerOf(c.provider)?.id;
    if (t === null || t < w.t0 || t > w.t1 || !c.usage || !p) continue;
    const b = buckets[Math.min(SPEND_BUCKETS - 1, Math.floor((t - w.t0) / size))];
    if (p === "claude") { const u = callCost(c).usd; if (u !== null) { b.claudeUsd += u; usd += u; priced = true; } }
    else b.tokens[p] += tokenSum(c);
  }
  const max = (f: (b: SpendBucket) => number) => Math.max(0, ...buckets.map(f));
  const mu = max(b => b.claudeUsd), mc = max(b => b.tokens.codex), mg = max(b => b.tokens.gemini);
  for (const b of buckets) { b.claudeH = mu ? b.claudeUsd / mu : 0; b.codexH = mc ? b.tokens.codex / mc : 0; b.geminiH = mg ? b.tokens.gemini / mg : 0; }
  return { buckets, totalUsd: priced ? usd : null, note: SPEND_NOTE };
}

export interface AgentsTile { live: number | null; sub: string; segments: { key: string; label: string; chip: string; live: number; pct: number }[]; roles: string; needs: string; note: string | null }
const ROLE_PLURAL: Record<string, string> = { lead: "lead", worker: "worker", reviewer: "reviewer", main: "main" };
export function agentsTile(fleet: FleetSnapshot | null): AgentsTile {
  if (!fleet) return { live: null, sub: "", segments: [], roles: "", needs: "", note: "no agent list from this server" };
  const s = fleet.summary, total = Math.max(1, s.byRuntime.reduce((n, r) => n + r.live, 0));
  const chip = (key: string) => PROVIDERS.find(p => p.id === key)?.chip ?? key.slice(0, 2).toUpperCase();
  const segments = s.byRuntime.filter(r => r.live > 0).map(r => ({ key: r.key, label: r.label, chip: chip(r.key), live: r.live, pct: (r.live / total) * 100 }));
  const roles = s.byRole.filter(r => r.live > 0).map(r => `${r.live} ${ROLE_PLURAL[r.key] ?? r.label}${r.live === 1 || r.key === "main" ? "" : "s"}`).join(" · ");
  const needs = [s.needsYou ? `${s.needsYou} need you` : null, s.unread ? `${s.unread} unread` : null].filter(Boolean).join(" · ");
  return { live: s.live, sub: `+${s.idle} idle`, segments, roles, needs, note: null };
}

export interface ProblemRow { fingerprint: string; /** The newest call of the problem: what a click opens in the drawer. */ lastCallKey: string | null; count: string; title: string; lanes: string; workspace: string; state: IncidentRow["state"]; tone: Tone | "att"; age: string }
const STATE_TONE: Record<IncidentRow["state"], ProblemRow["tone"]> = { escalating: "fail", new: "att", ongoing: "muted" };
export interface ToolRow { tool: string; pct: number; count: string; p50: string }
export interface ModelRow { model: string; chip: string; name: string; usd: string; detail: string; unpriced: boolean }
export interface FlowRow { at: number; time: string; text: string; chip: string; tone: "fail" | "info" }
export interface ContextRow { key: string; time: string; tool: string; dur: string; glyph: string; tier: Tier | null; current: boolean }
export interface DrawerModel {
  key: string; tool: string; status: string; exit: string | null; lane: string; chip: string;
  timing: string; workItem: string | null; workspace: string | null;
  tokens: { line1: string; line2: string } | null; price: { request: string; each: string | null; unpriced: boolean } | null;
  tier: { glyph: string; words: string; explanation: string; matchedBy: string | null; tier: Tier } | null;
  context: ContextRow[];
}
export interface FsModel {
  window: { t0: number; t1: number }; brushed: boolean; windowLabel: string; brushLabel: string;
  domain: { t0: number; t1: number }; strip: Pulse; windowFrac: { left: number; width: number };
  scoped: Call[]; kpis: FsKpi[]; match: MatchCounts; spend: SpendModel; agents: AgentsTile;
  problems: ProblemRow[]; tools: ToolRow[]; models: ModelRow[]; flow: FlowRow[]; drawer: DrawerModel | null;
}

const flowChip = (e: MessageEvent): { chip: string; tone: FlowRow["tone"] } => e.protocol ? { chip: e.protocol, tone: "info" } : e.kind === "handback-lost" ? { chip: "lost hand-back", tone: "fail" } : e.kind === "spawn" ? { chip: "spawn", tone: "info" } : e.kind === "handback" ? { chip: "hand-back", tone: "info" } : { chip: "message", tone: "info" };
const chipOf = (provider: string, model: string | null): string => { const p = providerOf(provider), l = modelTier(model).letter; return `${p?.chip ?? "??"}·${l}`; };

export function callsFsModel(input: FsInput): FsModel {
  const { calls, fleet, now } = input, brushed = !!input.brush, w = effectiveWindow(input.brush, input.presetMs, now), index = fleetIndex(fleet?.lanes, fleet?.names);
  const scoped = inWindow(calls, w), label = (c: Call) => identityOf(c, index).label;
  // The brush strip: every call over 24 h, with the selected window drawn on it.
  const domain = brushDomain(now), strip = pulse(calls, domain), span = domain.t1 - domain.t0;
  const windowFrac = { left: Math.max(0, (w.t0 - domain.t0) / span), width: Math.min(1, Math.max(0, (Math.min(w.t1, domain.t1) - Math.max(w.t0, domain.t0)) / span)) };
  const k = kpis(calls, w, fleet), match = matchCounts(scoped), peak = peakPerMinute(scoped);
  const ks: FsKpi[] = [
    { key: "agents", label: "live agents", value: k.liveAgents === null ? "—" : String(k.liveAgents), sub: fleet ? `+${fleet.summary.idle} idle` : "no agent list", tone: "run" },
    { key: "rate", label: "calls / min", value: rateText(k.callsPerMin), sub: `peak ${peak}`, tone: "muted" },
    { key: "errors", label: "error rate", value: k.errorRate === null ? "—" : `${(k.errorRate * 100).toFixed(1)}%`, sub: `${k.errors} failures`, tone: "fail" },
    { key: "p95", label: "p95", value: k.p95Ms === null ? "—" : msText(k.p95Ms), sub: `${k.p95TooFew ? `too few · ` : ""}p50 ${msText(k.p50Ms)}`, tone: "muted" },
    { key: "perHour", label: "per hour", value: k.burnUsdPerHour === null ? "n/a" : usdText(k.burnUsdPerHour), sub: "list-price est.", tone: "acc" },
    { key: "matched", label: "calls matched", value: String(match.matched), sub: `${match.notMatched} not matched`, tone: "muted" },
  ];
  const failed = scoped.filter(c => c.status === "error" || c.status === "denied");
  const incidents = reduceIncidents(failed, workspaceResolver(index), label);
  const problems = incidentRows(incidents, failed, now, "events").slice(0, TOP_TILE_ROWS).map((r): ProblemRow => ({
    fingerprint: r.fingerprint, lastCallKey: incidents.find(i => i.fingerprint === r.fingerprint)?.callKeys.at(-1) ?? null, count: `${r.count}×`, title: r.title, lanes: [...r.agentNames, ...(r.agentsMore ? [`+${r.agentsMore}`] : [])].join(", "), workspace: r.workspace, state: r.state, tone: STATE_TONE[r.state], age: r.lastText,
  }));
  const lat = latencyRows(scoped).slice(0, TOP_TILE_ROWS), top = Math.max(1, ...lat.map(r => r.calls));
  const tools = lat.map((r): ToolRow => ({ tool: r.tool, pct: (r.calls / top) * 100, count: r.calls.toLocaleString("en-US"), p50: msText(r.p50Ms) }));
  // Cost by model: the joined calls' per-call shares, grouped by model (a shared request is counted once because the shares add back to it).
  const groups = new Map<string, { provider: string; calls: Call[] }>();
  for (const c of scoped) { if (!c.usage) continue; const m = c.model ?? c.usageMatch?.request?.model ?? "unknown", g = groups.get(m); if (g) g.calls.push(c); else groups.set(m, { provider: c.provider, calls: [c] }); }
  const models = [...groups].map(([model, g]): ModelRow & { sort: number } => {
    let usd: number | null = 0, tok = 0, inp = 0, cw = 0, cr = 0;
    for (const c of g.calls) { const v = callCost(c); usd = usd !== null && v.usd !== null ? usd + v.usd : null; tok += tokenSum(c); inp += v.tokens?.input ?? 0; cw += v.tokens?.cacheWrite ?? 0; cr += v.tokens?.cacheRead ?? 0; }
    const hit = hitRate({ input: inp, cacheWrite5m: cw, cacheWrite1h: 0, cacheRead: cr });
    return { model, chip: chipOf(g.provider, model), name: modelTier(model).label === "Unknown model" ? model : modelTier(model).label, usd: usd === null ? "n/a" : usdText(usd), unpriced: usd === null, detail: usd !== null && hit !== null ? `${Math.round(hit * 100)}%` : `${compactCount(tok)} tok`, sort: usd ?? -1 };
  }).sort((a, b) => b.sort - a.sort || a.model.localeCompare(b.model)).slice(0, TOP_TILE_ROWS).map(({ sort: _s, ...r }) => r);
  const nameOf = (s: string) => index.get(s)?.label ?? s;
  const flow = (fleet?.messages ?? []).filter(e => e.at >= w.t0 && e.at <= w.t1).sort((a, b) => b.at - a.at).slice(0, FLOW_ROWS).map((e): FlowRow => ({ at: e.at, time: clockLabel(e.at, false), text: `${nameOf(e.from)} ${e.kind === "spawn" ? "⇢" : "→"} ${nameOf(e.to)}`, ...flowChip(e) }));
  return { window: w, brushed, windowLabel: windowWords(w, brushed, input.presetMs), brushLabel: brushed ? `drag to set the window · ${windowWords(w, true, input.presetMs)}` : `drag to set the window · ${Math.round(input.presetMs / HOUR_MS)}h selected`, domain, strip, windowFrac, scoped, kpis: ks, match, spend: spendModel(scoped, w), agents: agentsTile(fleet), problems, tools, models, flow, drawer: drawerOf(input, calls, index) };
}

function drawerOf(input: FsInput, calls: readonly Call[], index: ReturnType<typeof fleetIndex>): DrawerModel | null {
  const sc = input.selectedKey === null ? undefined : calls.find(c => callKey(c) === input.selectedKey);
  if (!sc) return null;
  const id = identityOf(sc, index), m = sc.usageMatch, cost = callCost(sc), req = m?.request ?? null;
  const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
  const tokens = req ? { line1: `in ${k(req.input)} · out ${k(req.output)}`, line2: `cache read ${k(req.cacheRead)} · write ${k(req.cacheWrite5m + req.cacheWrite1h)}` } : cost.tokens ? { line1: `in ${k(cost.tokens.input)} · out ${k(cost.tokens.output)}`, line2: `cache read ${k(cost.tokens.cacheRead)} · write ${k(cost.tokens.cacheWrite)}` } : null;
  const price = m?.request ? { request: usdPerCallText(m.requestUsd), each: m.tier === "shared" ? (m.shareUsd === null ? "n/a each" : `≈ ${usdPerCallText(m.shareUsd)} each (÷${m.siblings})`) : null, unpriced: m.requestUsd === null } : cost.tokens ? { request: usdPerCallText(cost.usd), each: null, unpriced: cost.usd === null } : null;
  const wall = sc.durationMs;
  const context = callContext(sc, calls as Call[]).map((c): ContextRow => ({ key: callKey(c), time: clockLabel(c.startedAt ?? c.endedAt ?? 0, true), tool: c.tool, dur: msText(c.durationMs), glyph: c.usageMatch ? TIER_GLYPH[c.usageMatch.tier] : TIER_GLYPH.none, tier: c.usageMatch?.tier ?? null, current: callKey(c) === callKey(sc) }));
  return {
    key: callKey(sc), tool: sc.tool, status: sc.status, exit: sc.errorCode, lane: id.label, chip: chipOf(sc.provider, sc.model ?? req?.model ?? null),
    timing: `${wall === null ? "unknown" : msText(wall)} · ${sc.durationKind}`, workItem: id.beadId, workspace: id.workspace ? `${id.workspace}${id.branch ? ` · ${id.branch}` : ""}` : null,
    tokens, price, tier: m ? { glyph: TIER_GLYPH[m.tier], words: tierWords(m), explanation: tierExplanation(m), matchedBy: matchedBy(m), tier: m.tier } : null, context,
  };
}

