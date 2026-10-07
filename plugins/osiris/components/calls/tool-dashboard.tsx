import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Call } from "../../analytics.ts";
import { totals } from "../../analytics.ts";
import { reduceIncidents } from "../../triage.ts";
import { fleetIndex, identityOf, workspaceResolver } from "../../work/call-identity.ts";
import type { FleetSnapshot } from "../../work/fleet-types.ts";
import { usdText, pctText } from "../../work/cost-cache-model.ts";
import { cleanText } from "../../work/sanitize.ts";
import { filterByRange, rangeWords } from "../../work/calls-range.ts";
import type { RangeId } from "../../work/calls-range.ts";
import { RangeBar } from "./range-bar.tsx";
import type { WorkTelemetry } from "../../work/telemetry-model.ts";
import type { WorkSurfaceSnapshot } from "../../work/surface-types.ts";
import { HIST_LABELS, applyChips, chipCounts, domainOf, incidentRows, inWindow, kpis, latencyRows, msText, presetWindow, toolCostText, pulse, stepWindow, windowWords } from "../../work/tool-dashboard-model.ts";
import type { Chip, IncidentRow, IncidentSort, LatencyRow, TimeWindow } from "../../work/tool-dashboard-model.ts";

export type ToolDashboardProps = {
  calls: Call[];
  fleet?: FleetSnapshot | null;
  /** Shared time window (the lead syncs it with the timeline minimap). null = everything. */
  window: TimeWindow;
  onWindow: (w: TimeWindow) => void;
  telemetry: WorkTelemetry | null;
  telemetryNote: string | null;
  snap?: WorkSurfaceSnapshot | null;
  now: number;
  onSelectCall?: (key: string) => void;
  onOpenIncident?: (fingerprint: string) => void;
  /** Opens the ONE cost surface, the workbench's Cost & cache tab (CostCacheTab); the dashboard has no cost tab of its own. */
  onOpenCost?: () => void;
  /** The shared time range (Cost & cache uses the same one) and how to change it. */
  range: RangeId;
  onRange: (r: RangeId) => void;
};
type Tab = "overview" | "incidents" | "latency";
const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: "overview", label: "Overview", hint: "The headline numbers, the activity strip and the worst problems." },
  { id: "incidents", label: "Incidents", hint: "Failures grouped by tool and error, newest first, with who they hit." },
  { id: "latency", label: "Latency", hint: "How long each tool takes: typical, slowest 5%, and a spread." },
];
const SORTS: { id: IncidentSort; label: string }[] = [{ id: "last", label: "Last seen" }, { id: "first", label: "First seen" }, { id: "events", label: "Events" }];
const STATE_HINT = { new: "First seen less than an hour ago.", escalating: "More than twice as many in the last hour as the hour before (and at least 3).", ongoing: "Seen before and not speeding up." } as const;
const rateText = (n: number | null) => (n === null ? "—" : n >= 10 ? n.toFixed(0) : n.toFixed(1));

function Spark({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(1, ...values), w = 6;
  return <svg className="oi-td-spark" viewBox={`0 0 ${values.length * w} 16`} role="img" aria-label={label}><title>{label}</title>
    {values.map((v, i) => <rect key={i} x={i * w} width={w - 1} y={16 - (v / max) * 16} height={(v / max) * 16} className={v ? "oi-td-fill-failure" : "oi-td-fill-quiet"} />)}
    {/* a quiet bucket still draws a 1px baseline so the strip never looks broken */}
    {values.map((v, i) => !v && <rect key={`q${i}`} x={i * w} width={w - 1} y={15} height={1} className="oi-td-fill-quiet" />)}
  </svg>;
}
function Histogram({ bins, label }: { bins: number[]; label: string }) {
  const max = Math.max(1, ...bins), w = 8;
  return <svg className="oi-td-hist" viewBox={`0 0 ${bins.length * w} 16`} role="img" aria-label={label}><title>{label}</title>
    {bins.map((v, i) => <rect key={i} x={i * w} width={w - 1} y={16 - (v / max) * 15 - 1} height={(v / max) * 15 + 1} className={v ? "oi-td-fill-info" : "oi-td-fill-quiet"} />)}
  </svg>;
}
const heat = (share: number, tone: "failure" | "info") => ({ background: `color-mix(in srgb, var(--oi-tone-${tone}) ${Math.round(Math.min(1, share) * 45)}%, transparent)` });
const histLabel = (bins: number[]) => `Calls by time taken: ${HIST_LABELS.map((l, i) => `${l} ${bins[i]}`).join(", ")}`;

function Kpi(p: { title: string; value: string; sub?: string; hint: string; tone?: string; onOpen?: () => void }) {
  const body = <><span className="oi-td-kt">{p.title}{p.onOpen ? " →" : ""}</span><span className={`oi-td-kv${p.tone ? ` oi-td-${p.tone}` : ""}`}>{p.value}</span>{p.sub && <span className="oi-td-ks" title={p.sub}>{p.sub}</span>}</>;
  // A tile with onOpen is a summary that opens its full view (the cost tile opens the ONE Cost & cache view).
  return p.onOpen ? <button type="button" className="oi-td-kpi oi-td-kpi-link" title={p.hint} onClick={p.onOpen}>{body}</button> : <div className="oi-td-kpi" title={p.hint}>{body}</div>;
}
function IncidentList({ rows, onOpen, limit }: { rows: IncidentRow[]; onOpen?: (fp: string) => void; limit?: number }) {
  const shown = limit ? rows.slice(0, limit) : rows;
  if (!shown.length) return <p className="oi-note">No failures in this view.</p>;
  return <ul className="oi-td-inc">{shown.map(r => <li key={r.fingerprint}>
    <button type="button" className="oi-td-incbtn" onClick={() => onOpen?.(r.fingerprint)} title={`${r.title}. Click to see the calls.`}>
      <span className={`oi-td-state oi-td-state-${r.state}`} title={STATE_HINT[r.state]}>{r.state}</span>
      <span className="oi-td-title">{cleanText(r.title)}</span>
      <Spark values={r.spark} label={`Last 24 hours: ${r.spark.join(", ")} events per 2 hours`} />
      <span className="oi-td-n" title="Total events">{r.count}</span>
      <span className="oi-td-agents" title={`Agents affected: ${r.agentNames.join(", ")}${r.agentsMore ? ` and ${r.agentsMore} more` : ""}`}>{r.agentCount} agent{r.agentCount === 1 ? "" : "s"}: {r.agentNames.map(cleanText).join(", ")}{r.agentsMore ? ` +${r.agentsMore}` : ""}</span>
      <span className="oi-td-ws" title="Workspace">{cleanText(r.workspace)}</span>
      <span className="oi-td-seen" title={`First seen ${r.firstText}`}>{r.lastText}</span>
    </button></li>)}</ul>;
}
function LatencyTable({ rows, limit }: { rows: LatencyRow[]; limit?: number }) {
  const shown = limit ? rows.slice(0, limit) : rows;
  if (!shown.length) return <p className="oi-note">No tool calls in this view.</p>;
  return <div className="oi-tools-table"><table className="oi-td-table"><thead><tr>
    <th>Tool</th><th className="oi-td-r" title="Calls. Tint = share of all calls.">Calls</th><th className="oi-td-r" title="Calls that failed. Tint = share of all failures.">Failed</th>
    <th className="oi-td-r" title="Half of calls finish faster than this.">Typical</th><th className="oi-td-r" title="95 of 100 calls finish faster than this. Needs 20 timed calls.">Slowest 5%</th><th className="oi-td-r" title="List-price estimate from the calls that carry token counts. n/a when none do. Not a bill.">Est. $</th><th title={`Spread: ${HIST_LABELS.join(" | ")}`}>Spread</th></tr></thead><tbody>
    {shown.map(r => <tr key={r.tool}><td title={cleanText(r.tool)}>{cleanText(r.tool)}</td>
      <td className="oi-td-r" style={heat(r.callShare, "info")}>{r.calls}</td><td className="oi-td-r" style={r.errors ? heat(r.errorShare, "failure") : undefined}>{r.errors}</td>
      <td className="oi-td-r" title={`${r.samples} timed calls`}>{msText(r.p50Ms)}</td>
      <td className="oi-td-r" title={r.p95TooFew ? `Only ${r.samples} timed calls; needs 20.` : `${r.samples} timed calls`}>{r.p95TooFew ? "too few" : msText(r.p95Ms)}</td>
      <td className="oi-td-r" title={r.costPartial ? "Only some calls of this tool carried token counts, so this is a lower bound." : r.costUsd === null ? "No call of this tool carried priced token counts yet." : "Estimate at list price."}>{toolCostText(r)}</td>
      <td>{r.samples ? <Histogram bins={r.histogram} label={histLabel(r.histogram)} /> : <span className="oi-note">no timing</span>}</td></tr>)}
  </tbody></table></div>;
}

/** The Calls panel's full dashboard: filter chips, then Overview / Incidents / Latency / Cost. Every panel reads the same chip-filtered,
 * window-scoped calls; the pulse strip shows the chip-filtered calls over ALL time and drags out the shared window. */
export function ToolDashboard(p: ToolDashboardProps) {
  const [tab, setTab] = useState<Tab>("overview");
  const [chips, setChips] = useState<Chip[]>([]);
  const [sort, setSort] = useState<IncidentSort>("last");
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const index = useMemo(() => fleetIndex(p.fleet?.lanes, p.fleet?.names), [p.fleet]);
  // ONE range filter (calls-range.ts) in front of every panel; the minute bucket keeps the memo from rebuilding on every render.
  const minute = Math.floor(p.now / 60_000);
  const calls = useMemo(() => filterByRange(p.calls, p.range, p.now), [p.calls, p.range, minute]);
  const chipOptions = useMemo(() => chipCounts(calls, index), [calls, index]);
  const filtered = useMemo(() => applyChips(calls, index, chips), [calls, index, chips]);
  const scoped = useMemo(() => inWindow(filtered, p.window), [filtered, p.window]);
  const domain = useMemo(() => domainOf(filtered), [filtered]);
  const strip = useMemo(() => (domain ? pulse(filtered, domain) : null), [filtered, domain]);
  const k = useMemo(() => kpis(filtered, p.window, p.fleet), [filtered, p.window, p.fleet]);
  const rows = useMemo(() => incidentRows(reduceIncidents(scoped, workspaceResolver(index), c => identityOf(c, index).label), scoped, p.now, sort), [scoped, index, p.now, sort]);
  const tools = useMemo(() => latencyRows(scoped), [scoped]);
  const toggle = (c: Chip) => setChips(cur => cur.some(x => x.kind === c.kind && x.value === c.value) ? cur.filter(x => !(x.kind === c.kind && x.value === c.value)) : [...cur, c]);
  const frac = (e: { clientX: number }) => { const r = stripRef.current?.getBoundingClientRect(); return r && r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0; };
  const finishDrag = () => {
    if (drag && domain && Math.abs(drag.b - drag.a) > 0.01) {
      const [lo, hi] = drag.a < drag.b ? [drag.a, drag.b] : [drag.b, drag.a], span = domain.t1 - domain.t0;
      p.onWindow({ t0: Math.round(domain.t0 + lo * span), t1: Math.round(domain.t0 + hi * span) });
    }
    setDrag(null);
  };
  const onStripKey = (e: KeyboardEvent) => {
    if (!domain || !strip) return;
    if (e.key === "Escape") { if (p.window) { e.preventDefault(); p.onWindow(null); } return; }
    const dir = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (!dir) return;
    e.preventDefault(); { const w = stepWindow(p.window, domain, strip.bucketMs, dir, e.shiftKey); p.onWindow({ t0: Math.round(w.t0), t1: Math.round(w.t1) }); }
  };
  const win = p.window && domain ? { l: Math.max(0, (p.window.t0 - domain.t0) / (domain.t1 - domain.t0)), r: Math.min(1, (p.window.t1 - domain.t0) / (domain.t1 - domain.t0)) } : null;
  const sel = drag ? { l: Math.min(drag.a, drag.b), r: Math.max(drag.a, drag.b) } : win;
  const t = totals(scoped);
  return <section className="oi-td" aria-label="Tool dashboard">
    <div className="oi-td-chips" role="group" aria-label="Filters">
      {chipOptions.map(c => { const on = chips.some(x => x.kind === c.kind && x.value === c.value); return <button key={`${c.kind}:${c.value}`} type="button" className={`oi-td-chip oi-td-chip-${c.kind}`} aria-pressed={on} onClick={() => toggle(c)} title={`Show only ${c.kind} "${cleanText(c.value)}" (${c.count} calls)`}>{cleanText(c.label)} <b>{c.count}</b></button>; })}
      {chips.length > 0 && <button type="button" className="oi-td-chip oi-td-clear" onClick={() => setChips([])}>Clear filters</button>}
      {p.window && <button type="button" className="oi-td-chip oi-td-clear" onClick={() => p.onWindow(null)} title="Stop zooming into one stretch of time">Clear time</button>}
      {!p.fleet && <span className="oi-note" title="Model, role and workspace need the agent list from the server.">Agent list not available: model, role and workspace read “unknown”.</span>}
    </div>
    <div className="oi-td-tabs" role="tablist" aria-label="Dashboard views">
      {TABS.map(x => <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} className="oi-td-tab" title={x.hint} onClick={() => setTab(x.id)}>{x.label}{x.id === "incidents" && rows.length ? ` ${rows.length}` : ""}</button>)}
    </div>
    {tab === "overview" && <div role="tabpanel">
      <RangeBar range={p.range} onRange={p.onRange} polledAt={p.telemetry?.freshness.polledAt} now={p.now} />
      <div className="oi-td-kpis">
        <Kpi title="Live agents" value={k.liveAgents === null ? "—" : String(k.liveAgents)} sub={k.liveAgents === null ? "no agent list from this server" : "wrote in the last 5 min"} hint="Agents that wrote to their log in the last 5 minutes (a guess from activity, not a heartbeat)." />
        <Kpi title="Calls / min" value={rateText(k.callsPerMin)} sub={`${k.calls} calls`} hint="Tool calls per minute over the chosen time." />
        <Kpi title="Error rate" value={k.errorRate === null ? "—" : pctText(k.errorRate)} sub={`${k.errors} of ${k.decided}`} tone={k.errorRate !== null && k.errorRate > 0.1 ? "bad" : undefined} hint="Failed calls out of calls that finished one way or the other. Unknown and cancelled are left out." />
        <Kpi title="Typical time" value={msText(k.p50Ms)} sub={`${k.samples} timed calls`} hint="Half of calls finish faster than this." />
        <Kpi title="Slowest 5%" value={k.p95TooFew ? "too few" : msText(k.p95Ms)} sub={`${k.samples} timed calls`} hint="95 of 100 calls finish faster than this. Needs 20 timed calls, otherwise it is just the maximum." />
        <Kpi title="Spend / hour" value={k.burnUsdPerHour === null ? "—" : usdText(k.burnUsdPerHour)} sub={p.telemetry ? `${usdText(p.telemetry.totals.costUsd)}${p.telemetry.totals.costComplete ? "" : "+"} ${rangeWords(p.range)}` : k.burnNote}
          hint="List-price estimate of the last hour's spend, and the 7-day total. Not a bill. Opens the Cost & cache tab for spend by model, work item and cache reuse." onOpen={p.onOpenCost} />
      </div>
      {strip && domain && <div className="oi-td-presets" role="group" aria-label="Time window">
        <button type="button" className="oi-td-chip" onClick={() => p.onWindow(presetWindow(domain, 15 * 60_000))}>15 min</button>
        <button type="button" className="oi-td-chip" onClick={() => p.onWindow(presetWindow(domain, 60 * 60_000))}>1 h</button>
        <button type="button" className="oi-td-chip" onClick={() => p.onWindow(null)}>All</button>
      </div>}
      {strip && domain ? <div className="oi-td-strip" ref={stripRef} tabIndex={0} role="slider" aria-label="Time window" aria-orientation="horizontal" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((win ? win.l : 0) * 100)} aria-valuetext={windowWords(p.window)} onKeyDown={onStripKey} onPointerDown={e => { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); const f = frac(e); setDrag({ a: f, b: f }); }} onPointerMove={e => drag && setDrag({ a: drag.a, b: frac(e) })} onPointerUp={finishDrag} onPointerCancel={() => setDrag(null)} title="Calls over time. Drag across it, or use the arrow keys (Shift resizes, Esc clears), to zoom every panel into that stretch.">
        <svg viewBox={`0 0 ${strip.buckets.length * 10} 40`} preserveAspectRatio="none" role="img" aria-label={`Calls over time, ${strip.max} at the busiest moment`}>
          {strip.buckets.map((b, i) => { let y = 40; const h = (n: number) => (strip.max ? (n / strip.max) * 38 : 0);
            return <g key={i}><title>{`${b.total} calls (${b.failure} failed)`}</title>{(["success", "attention", "running", "failure"] as const).map(o => { const ht = h(b[o]); y -= ht; return ht > 0 ? <rect key={o} x={i * 10} width={9} y={y} height={ht} className={`oi-td-fill-${o}`} /> : null; })}
              {!b.total && <rect x={i * 10} width={9} y={39} height={1} className="oi-td-fill-quiet" />}</g>; })}
        </svg>
        {sel && <span className="oi-td-brush" style={{ left: `${sel.l * 100}%`, width: `${(sel.r - sel.l) * 100}%` }} />}
      </div> : <p className="oi-note">No timed calls to chart yet.</p>}
      <div className="oi-td-legend" aria-hidden="true"><span className="oi-td-lg-success">Succeeded</span><span className="oi-td-lg-failure">Failed</span><span className="oi-td-lg-attention">Needs a look</span><span className="oi-td-lg-running">Running</span></div>
      <h3 className="oi-td-h">Worst problems</h3><IncidentList rows={rows} onOpen={p.onOpenIncident} limit={5} />
      <h3 className="oi-td-h">Busiest tools</h3><LatencyTable rows={tools} limit={5} />
      <p className="oi-note">{t.calls} calls in view · {t.error} failed · {t.running} running</p>
    </div>}
    {tab === "incidents" && <div role="tabpanel">
      <div className="oi-td-sorts" role="group" aria-label="Sort incidents">{SORTS.map(s => <button key={s.id} type="button" className="oi-td-chip" aria-pressed={sort === s.id} onClick={() => setSort(s.id)}>{s.label}</button>)}</div>
      <IncidentList rows={rows} onOpen={p.onOpenIncident} />
    </div>}
    {tab === "latency" && <div role="tabpanel"><RangeBar range={p.range} onRange={p.onRange} polledAt={p.telemetry?.freshness.polledAt} now={p.now} /><LatencyTable rows={tools} /></div>}
  </section>;
}

export const toolDashboardStyles = `
.oi-td{display:flex;flex-direction:column;gap:6px;min-width:0}
.oi-td-chips,.oi-td-sorts,.oi-td-tabs,.oi-td-legend{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.oi-td-chip,.oi-td-tab{font:inherit;font-size:11px;padding:2px 7px;border:1px solid var(--oi-border);background:transparent;color:var(--oi-text);border-radius:10px;cursor:pointer}
.oi-td-chip b{color:var(--oi-muted);font-weight:500}
.oi-td-chip[aria-pressed=true],.oi-td-tab[aria-selected=true]{background:var(--oi-selected);border-color:var(--oi-accent)}
.oi-td-chip:hover,.oi-td-tab:hover{background:var(--oi-raised)}
.oi-td-clear{border-style:dashed}
.oi-td-tabs{border-bottom:1px solid var(--oi-border);padding-bottom:4px}
.oi-td-tab{border-radius:4px;font-size:12px}
.oi-td-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:4px}
.oi-td-kpi{display:flex;flex-direction:column;min-width:0;padding:5px 7px;border-bottom:1px solid var(--oi-border)}
.oi-td-kpi-link{font:inherit;color:inherit;text-align:left;background:transparent;border:0;border-bottom:1px solid var(--oi-border);cursor:pointer}.oi-td-kpi-link:hover{background:var(--oi-hover)}.oi-td-kpi-link:focus-visible{outline:2px solid var(--oi-accent);outline-offset:-2px}
.oi-td-kt,.oi-td-ks{font-size:10px;color:var(--oi-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oi-td-kv{font-size:18px;font-variant-numeric:tabular-nums}.oi-td-bad{color:var(--oi-tone-failure)}
.oi-td-strip{position:relative;height:44px;border-bottom:1px solid var(--oi-border);cursor:crosshair;touch-action:none;user-select:none}
.oi-td-strip:focus-visible{outline:2px solid var(--oi-accent);outline-offset:1px}
.oi-td-presets{display:flex;gap:4px}
.oi-td-strip svg{display:block;width:100%;height:100%}
.oi-td-brush{position:absolute;top:0;bottom:0;background:var(--oi-selected);border-left:1px solid var(--oi-accent);border-right:1px solid var(--oi-accent);opacity:.55;pointer-events:none}
.oi-td-fill-success{fill:var(--oi-tone-success)}.oi-td-fill-failure{fill:var(--oi-tone-failure)}.oi-td-fill-attention{fill:var(--oi-tone-attention)}.oi-td-fill-running{fill:var(--oi-tone-running)}.oi-td-fill-info{fill:var(--oi-tone-info)}.oi-td-fill-quiet{fill:var(--oi-tone-muted)}
.oi-td-legend{font-size:10px;color:var(--oi-muted)}
.oi-td-legend span::before{content:"";display:inline-block;width:8px;height:8px;margin-right:3px;background:currentColor}
.oi-td-lg-success::before{color:var(--oi-tone-success)}.oi-td-lg-failure::before{color:var(--oi-tone-failure)}.oi-td-lg-attention::before{color:var(--oi-tone-attention)}.oi-td-lg-running::before{color:var(--oi-tone-running)}
.oi-td-h{margin:6px 0 2px;font-size:12px;font-weight:600}
.oi-td-inc{list-style:none;margin:0;padding:0}
.oi-td-incbtn{display:grid;grid-template-columns:76px minmax(120px,2fr) 74px 36px minmax(100px,2fr) minmax(70px,1fr) 56px;gap:8px;align-items:center;width:100%;text-align:left;font:inherit;font-size:12px;color:inherit;background:transparent;border:0;border-bottom:1px solid var(--oi-border);padding:4px 2px;cursor:pointer}
.oi-td-incbtn:hover{background:var(--oi-raised)}
.oi-td-incbtn>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-td-title{font-weight:600}.oi-td-n,.oi-td-seen,.oi-td-r{text-align:right;font-variant-numeric:tabular-nums}
.oi-td-agents,.oi-td-ws{color:var(--oi-muted)}
.oi-td-state{font-size:10px;text-transform:uppercase;text-align:center;border:1px solid currentColor;border-radius:3px;padding:0 3px}
.oi-td-state-new{color:var(--oi-tone-info)}.oi-td-state-escalating{color:var(--oi-tone-failure)}.oi-td-state-ongoing{color:var(--oi-tone-muted)}
.oi-td-spark{width:72px;height:16px}.oi-td-hist{width:48px;height:16px}
.oi-td-table{width:100%;border-collapse:collapse;font-size:12px}.oi-td-table th{text-align:left;font-weight:500;color:var(--oi-muted);padding:2px 6px}
.oi-td-table th.oi-td-r{text-align:right}.oi-td-table td{padding:2px 6px;border-top:1px solid var(--oi-border)}
@media (max-width:720px){.oi-td-incbtn{grid-template-columns:70px 1fr 40px}.oi-td-incbtn>:nth-child(n+3):not(.oi-td-n){display:none}}
`;
