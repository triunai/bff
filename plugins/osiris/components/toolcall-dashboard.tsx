import { useMemo, type ReactNode } from "react";
import type { Call } from "../analytics.ts";
import { callDashboard, fmtMs, MIN_TOOL_SAMPLES } from "../overview.ts";
import { cleanText } from "../work/sanitize.ts";
import { telemetryCards } from "../work/telemetry-model.ts";
import type { WorkTelemetry } from "../work/telemetry-model.ts";

export type ToolcallDashboardProps = {
  calls: Call[];
  freshness: { label: string; ageMs: number | null; stale: boolean } | null;
  coverage: { known: number; total: number } | null;
  telemetry: WorkTelemetry | null;
  /** Why cost data is missing: no tracker chosen, or the read failed. Shown as text, never as zeros. */
  telemetryNote: string | null;
  now: number;
};

const DASH = "—";
const dur = (ms: number | null) => (ms === null ? DASH : fmtMs(ms));
function Card(p: { title: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return <div className={`oi-ov-card${p.wide ? " oi-ov-wide" : ""}`} title={p.hint}><span className="oi-ov-title">{p.title}</span>{p.children}</div>;
}
const Num = (p: { value: string; sub?: string }) => <><span className="oi-ov-num">{p.value}</span>{p.sub && <span className="oi-ov-sub" title={p.sub}>{p.sub}</span>}</>;

/** Tool-call dashboard for the observer's Overview: outcomes, how long calls take (typical and slowest 10%, always with the sample
 *  size), slow calls, capture freshness, and the cost and cache cards from the workTelemetry answer. Every string is plain text. */
export function ToolcallDashboard(p: ToolcallDashboardProps) {
  const d = useMemo(() => callDashboard(p.calls), [p.calls]);
  const cards = p.telemetry ? telemetryCards(p.telemetry, p.now) : null;
  return <div className="oi-ov oi-tc" role="group" aria-label="Tool call dashboard">
    <Card title="Tool calls" hint="All calls in the current view"><Num value={String(d.total)} sub={`${d.success} succeeded · ${d.errors} failed · ${d.unknown} outcome unknown`} /></Card>
    <Card title="Failed" hint="Calls that ended in an error"><Num value={String(d.errors)} sub={d.total ? `${d.running} still running · ${d.other} denied or cancelled` : DASH} /></Card>
    <Card title="Outcome unknown" hint="Calls whose result was never recorded; they are not counted as failures"><Num value={String(d.unknown)} /></Card>
    <Card title="How long calls take" hint="Typical = half of calls are faster than this. Slowest 10% = nine in ten calls are faster. Only calls with a recorded duration count."><Num value={`typical ${dur(d.timing.p50)} · slowest 10% ${dur(d.timing.p90)}`} sub={`from ${d.timing.n} timed calls`} /></Card>
    <Card title="By tool" wide hint={`Typical and slowest-10% times need at least ${MIN_TOOL_SAMPLES} timed calls; below that the row says "too few".`}>
      {d.tools.length ? <table className="oi-ov-tools"><thead><tr><th>Tool</th><th>Calls</th><th>Failed</th><th>Typical</th><th>Slowest 10%</th></tr></thead><tbody>
        {d.tools.map(t => <tr key={t.tool}>
          <td className="oi-ov-tool" title={cleanText(t.tool)}>{cleanText(t.tool)}</td><td className="oi-ov-n">{t.n}</td><td className="oi-ov-n">{t.errors}</td>
          {t.p50 === null ? <td className="oi-ov-q" colSpan={2}>too few timed calls (n={t.timed})</td> : <><td className="oi-ov-q">{dur(t.p50)} (n={t.timed})</td><td className="oi-ov-q">{dur(t.p90)} (n={t.timed})</td></>}
        </tr>)}
      </tbody></table> : <span className="oi-ov-num">{DASH}</span>}
    </Card>
    <Card title="Slow calls" wide hint="Successful calls over the slow limit: 5 s for commands, 60 s for MCP tools, 10 s for the rest">
      <Num value={String(d.slow.count)} />
      {d.slow.worst.length > 0 && <ul className="oi-tc-slow">{d.slow.worst.map((s, i) => <li key={`${s.tool}-${i}`}><span className="oi-ov-tool" title={cleanText(s.tool)}>{cleanText(s.tool)}</span><span className="oi-ov-n">{dur(s.durationMs)}</span></li>)}</ul>}
    </Card>
    <Card title="Capture" hint="When this data was last read, and how many outcomes are known"><Num value={p.freshness ? `${p.freshness.label}${p.freshness.stale ? " (stale)" : ""}` : DASH} sub={p.coverage ? `${p.coverage.known} of ${p.coverage.total} outcomes known` : DASH} /></Card>
    {cards ? <>
      <Card title="Tokens" hint="Input tokens include cache writes and cache reads"><Num {...cards.tokens} /></Card>
      <Card title="Estimated cost" hint="Priced from a built-in price list, not from a bill"><Num {...cards.cost} /></Card>
      <Card title="Cache reuse" hint="Cache hit rate: how much of the input was read back from the cache instead of sent fresh"><Num {...cards.cache} /></Card>
      <Card title="Cache misses" hint="Calls that had to rewrite most of the cache (the first start-up of each agent is not counted)"><Num {...cards.misses} /></Card>
      <Card title="Cost data" wide><Num {...cards.freshness} /></Card>
    </> : <Card title="Cost and cache" wide><span className="oi-ov-num">{DASH}</span><span className="oi-ov-sub">{p.telemetryNote ?? "Choose a tracker in Work to see cost and cache numbers."}</span></Card>}
  </div>;
}

export const toolcallDashboardStyles = `
.oi-tc{padding-top:0}
.oi-ov-tools th{padding:1px 0 1px 8px;color:var(--oi-muted);font-weight:normal;font-size:10px;text-align:right}.oi-ov-tools th:first-child{padding-left:0;text-align:left}
.oi-tc-slow{list-style:none;margin:2px 0 0;padding:0;font-variant-numeric:tabular-nums}.oi-tc-slow li{display:flex;gap:8px;justify-content:space-between}
`;
