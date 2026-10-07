// Home dashboard model (PURE): the four questions as four summaries, each MERGED from an existing model, never a second computation:
// needs me = decisionsWaiting + the fleet's waiting lanes + failing health rows + the Problems incidents; running = the fleet lanes + costView;
// cost = telemetry totals + spendByModel; changed = git status entries + today's commits. Every number is finite or an honest "n/a".
import type { DecisionRow } from "./surface-types.ts";
import type { FleetLane, FleetSnapshot } from "./fleet-types.ts";
import type { WorkTelemetry } from "./telemetry-model.ts";
import type { SidebarCommit } from "./sidebar-commits.ts";
import type { GitStatusEntry } from "../git-types.ts";
import type { HealthRow } from "../health-types.ts";
import type { IncidentRow } from "./tool-dashboard-model.ts";
import { PROVIDERS, PROVIDER_IDS, type ProviderId } from "./providers/registry.ts";
import { costView } from "./fleet-view-model.ts";
import { spendByModel, pctText, usdText, type ModelSpend } from "./cost-cache-model.ts";
import { compactCount } from "./telemetry-model.ts";
import { modelTier } from "./model-tiers.ts";
import { formatAge } from "./surface-model.ts";
import { openIncidents, statusCounts, incidentAge, type LedgerRead, type LedgerIncident, type IncidentStatus } from "./fleet-ledger.ts";

export const HOME_ROWS = 4, HOME_PROBLEMS = 3, HOME_HEALTH = 2, NA = "n/a";
export type ProviderKey = ProviderId | "other";
export const PROVIDER_LABEL: Readonly<Record<ProviderKey, string>> = { claude: "Claude", codex: "Codex", gemini: "Gemini", other: "Other" };
const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export const providerOfModel = (model: string): ProviderKey => PROVIDERS.find(p => p.id !== "claude" && p.id !== "codex" && p.match.test(model))?.id ?? ((p) => p === "anthropic" ? "claude" : p === "openai" ? "codex" : "other")(modelTier(model).provider);

export interface HomeInputs {
  now: number;
  decisions: readonly DecisionRow[];
  fleet: FleetSnapshot | null;
  telemetry: WorkTelemetry | null;
  /** "today" / "last 7 days": the window the telemetry actually covers. Never relabelled. */
  windowLabel: string;
  healthRows: readonly HealthRow[];
  /** Problems model rows (the top failing tools), newest first, with the callKey of one representative call. */
  problems: readonly (IncidentRow & { callKey: string | null })[];
  status: readonly GitStatusEntry[] | null;
  commits: readonly SidebarCommit[];
  beadIds: readonly string[];
  ledger: LedgerRead | null;
}

export interface NeedsView { count: number; decisions: DecisionRow[]; waiting: { lane: FleetLane; text: string }[]; health: HealthRow[]; problems: (IncidentRow & { callKey: string | null })[] }
export interface RunningView { live: number; idle: number; byProvider: { key: ProviderKey; label: string; live: number | null }[]; needYou: number; rows: { lane: FleetLane; sub: string; cost: string }[] }
export interface CostView { totalText: string; windowLabel: string; segments: { key: ProviderKey; label: string; usd: number; pct: number; text: string; tokensText: string }[]; /** The last hour of fleet activity (requests per 5 minutes, FLEET_SPARK_BUCKETS columns), 0..1 of the tallest, per provider. Empty when no fleet is read. */ bars: { claude: number; codex: number }[]; models: (ModelSpend & { label: string; hitText: string })[] }
export interface ChangedView { uncommitted: number; files: { path: string; state: string; code: string }[]; landed: { sha: string; subject: string; beads: string[] }[]; landedCount: number }
export interface LedgerView { state: "ok" | "missing" | "invalid"; reason: string | null; counts: Record<IncidentStatus, number>; open: { incident: LedgerIncident; age: string }[]; dropped: number }
export interface HomeView { needs: NeedsView; running: RunningView; cost: CostView; changed: ChangedView; ledger: LedgerView }

const waitingWord = (l: FleetLane, now: number): string => `${l.waiting === "question" ? "question" : l.waiting === "permission" ? "permission" : "your turn"}${l.waitingSince ? ` · ${formatAge(Math.max(0, now - l.waitingSince))}` : ""}`;
const isHuman = (l: FleetLane) => l.waiting === "question" || l.waiting === "permission" || l.waiting === "your-turn";

export function needsView(i: HomeInputs): NeedsView {
  const waiting = (i.fleet?.lanes ?? []).filter(isHuman).map(lane => ({ lane, text: waitingWord(lane, i.now) }));
  const health = i.healthRows.filter(r => r.status === "fail").slice(0, HOME_HEALTH);
  return { count: i.decisions.length + waiting.length, decisions: [...i.decisions], waiting, health, problems: i.problems.slice(0, HOME_PROBLEMS) };
}

export function runningView(i: HomeInputs): RunningView {
  const lanes = i.fleet?.lanes ?? [], live = lanes.filter(l => l.state === "live");
  const sum = i.fleet?.summary;
  const rt = (r: FleetLane["runtime"]) => sum?.byRuntime?.find(c => c.key === r)?.live ?? live.filter(l => l.runtime === r).length;
  const byProvider = [{ key: "claude" as const, label: PROVIDER_LABEL.claude, live: rt("claude") }, { key: "codex" as const, label: PROVIDER_LABEL.codex, live: rt("codex") }, ...PROVIDERS.filter(p => p.id !== "claude" && p.id !== "codex").map(p => ({ key: p.id, label: PROVIDER_LABEL[p.id], live: null }))];
  return {
    live: fin(sum?.live) ? sum.live : live.length, idle: fin(sum?.idle) ? sum.idle : lanes.filter(l => l.state === "idle").length, byProvider,
    needYou: fin(sum?.needsYou) ? sum.needsYou : lanes.filter(isHuman).length,
    rows: [...live].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)).slice(0, HOME_ROWS).map(lane => ({ lane, sub: lane.now ? `${lane.now.tool} ${formatAge(Math.max(0, i.now - lane.now.since))}` : "", cost: costView(lane).text })),
  };
}

export function homeCost(i: HomeInputs): CostView {
  const t = i.telemetry, by = spendByModel(t?.byModel ?? []);
  const usdOf = (list: readonly ModelSpend[]) => list.reduce((a, m) => a + (fin(m.usd) ? m.usd : 0), 0);
  const total = t ? t.totals.costUsd : null, priced = usdOf(by);
  const segs = ([...PROVIDER_IDS, "other"] as const).map(key => {
    const list = by.filter(m => providerOfModel(m.model) === key), usd = usdOf(list);
    const laneTok = key === "codex" ? (i.fleet?.lanes ?? []).filter(l => l.runtime === "codex").reduce((a, l) => a + (fin(l.tokensIn) ? l.tokensIn : 0) + (fin(l.tokensOut) ? l.tokensOut : 0), 0) : 0;
    const tok = list.reduce((a, m) => a + (fin(m.tokensIn) ? m.tokensIn : 0) + (fin(m.tokensOut) ? m.tokensOut : 0), 0) + laneTok;
    return { key, label: PROVIDER_LABEL[key], usd, pct: priced > 0 ? (usd / priced) * 100 : 0, text: usd > 0 ? usdText(usd) : NA, tokensText: tok > 0 ? `${compactCount(tok)} tok` : "", present: list.length > 0 || laneTok > 0 };
  }).filter(s => s.key !== "other" || s.present).map(({ present: _p, ...s }) => s);
  const lanes = i.fleet?.lanes ?? [], n = lanes.reduce((a, l) => Math.max(a, Array.isArray(l.spark) ? l.spark.length : 0), 0);
  const col = (rt: FleetLane["runtime"], k: number) => lanes.filter(l => l.runtime === rt).reduce((a, l) => a + (fin(l.spark?.[k]) ? l.spark[k] : 0), 0);
  const raw = Array.from({ length: n }, (_, k) => ({ claude: col("claude", k), codex: col("codex", k) })), top = Math.max(0, ...raw.map(r => r.claude + r.codex));
  return {
    totalText: !t || !fin(total) ? NA : t.totals.costComplete ? usdText(total) : `${usdText(total)}+`, windowLabel: i.windowLabel,
    segments: segs, bars: top > 0 ? raw.map(r => ({ claude: r.claude / top, codex: r.codex / top })) : [],
    models: by.slice(0, 3).map(m => ({ ...m, costText: m.unpriced && !(m.usd > 0) ? NA : m.costText, label: modelTier(m.model).label === "Unknown model" ? m.model : modelTier(m.model).label, hitText: pctText(m.hitRate) })),
  };
}

const STATE_WORD = (e: GitStatusEntry): string => e.x === "?" ? "untracked" : e.y !== " " && e.y !== "" ? (e.x !== " " && e.x !== "" ? "staged + unstaged" : "unstaged") : "staged";
/** Bead ids a commit subject mentions, from the tracker's known ids only (never a guess from shape). */
export const beadsIn = (subject: string, ids: readonly string[]): string[] => ids.filter(id => id.length > 2 && new RegExp(`(^|[^A-Za-z0-9_-])${id.replace(/[^A-Za-z0-9_-]/g, "\\$&")}($|[^A-Za-z0-9_-])`).test(subject));

export function changedView(i: HomeInputs): ChangedView {
  const d = new Date(i.now); d.setHours(0, 0, 0, 0);
  const today = i.commits.filter(c => c.at >= d.getTime() && c.at < d.getTime() + 86_400_000);
  const st = i.status ?? [];
  return {
    uncommitted: st.length, files: st.slice(0, 3).map(e => ({ path: e.path, state: STATE_WORD(e), code: (e.x === "?" ? "?" : (e.x.trim() || e.y.trim() || "M")) })),
    landed: today.slice(0, 3).map(c => ({ sha: c.sha, subject: c.subject, beads: beadsIn(c.subject, i.beadIds) })), landedCount: today.length,
  };
}

export function ledgerView(l: LedgerRead | null, now: number): LedgerView {
  const none = { open: 0, pinned: 0, closed: 0 };
  if (!l || l.state === "missing") return { state: "missing", reason: null, counts: none, open: [], dropped: 0 };
  if (l.state === "invalid") return { state: "invalid", reason: l.reason, counts: none, open: [], dropped: 0 };
  return { state: "ok", reason: null, counts: statusCounts(l.incidents), open: openIncidents(l.incidents).map(incident => ({ incident, age: incidentAge(incident, now) })), dropped: l.dropped };
}

export const homeView = (i: HomeInputs): HomeView => ({ needs: needsView(i), running: runningView(i), cost: homeCost(i), changed: changedView(i), ledger: ledgerView(i.ledger, i.now) });
