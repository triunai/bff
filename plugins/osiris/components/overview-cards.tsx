import type { ReactNode } from "react";
import { captureText, fmtMs, overviewNote, type CallMetrics, type RepoStats } from "../overview.ts";
import { toolcallDashboardStyles } from "./toolcall-dashboard.tsx";

export type OverviewTarget = "problems" | "signals" | "trace" | "changes";
export type OverviewProps = {
  metrics: CallMetrics | null;
  freshness: { label: string; ageMs: number | null; stale: boolean } | null;
  coverage: { known: number; total: number } | null;
  repo: { name: string; stats: RepoStats; bounded: boolean } | null;
  onOpen(target: OverviewTarget): void;
};

const DASH = "—";
const num = (n: number | null | undefined) => n === null || n === undefined ? DASH : String(n);
// fmtMs maps null to "Unknown"; this view uses a dash for anything not recorded.
const dur = (ms: number | null) => ms === null ? DASH : fmtMs(ms);
const pct = (r: number | null) => r === null ? DASH : `${(r * 100).toFixed(1)}%`;

function Card(p: { title: string; tone?: "failure" | "attention" | null; onClick?: () => void; wide?: boolean; children: ReactNode }) {
  const cls = `oi-ov-card${p.tone ? ` oi-ov-${p.tone}` : ""}${p.wide ? " oi-ov-wide" : ""}`;
  const head = <span className="oi-ov-title">{p.title}</span>;
  return p.onClick
    ? <button type="button" className={cls} onClick={p.onClick}>{head}{p.children}</button>
    : <div className={cls}>{head}{p.children}</div>;
}

export function OverviewCards(p: OverviewProps) {
  const m = p.metrics, r = p.repo, note = overviewNote(m);
  return <div className="oi-ov" role="group" aria-label="Overview">
    {note ? <p className="oi-ov-note" role="status">{note}</p> : null}
    {m ? <>
    <Card title="Calls" onClick={() => p.onOpen("trace")}><span className="oi-ov-num">{num(m?.total)}</span></Card>
    <Card title="Problems" tone={m && m.problems > 0 ? "failure" : null} onClick={() => p.onOpen("problems")}><span className="oi-ov-num">{num(m?.problems)}</span></Card>
    <Card title="Signals" tone={m && m.signals > 0 ? "attention" : null} onClick={() => p.onOpen("signals")}><span className="oi-ov-num">{num(m?.signals)}</span></Card>
    <Card title="Error rate">
      <span className="oi-ov-num">{pct(m?.errorRate.rate ?? null)}</span>
      <span className="oi-ov-sub">{m ? `${m.errorRate.errors} / ${m.errorRate.denominator}` : DASH}</span>
    </Card>
    <Card title="Timing">
      <span className="oi-ov-num">{m ? `typical ${dur(m.timing.p50)} · slowest 10% ${dur(m.timing.p90)}` : DASH}</span>
      <span className="oi-ov-sub">{m ? `n=${m.timing.n}, ${m.timing.unknown} unknown` : DASH}</span>
    </Card>
    <Card title="Slow"><span className="oi-ov-num">{num(m?.slow)}</span></Card>
    <Card title="Top tools" wide>
      {m && m.topTools.length ? <table className="oi-ov-tools"><tbody>
        {m.topTools.map(t => <tr key={t.tool}>
          <td className="oi-ov-tool" title={t.tool}>{t.tool}</td><td className="oi-ov-n">{t.n}</td>
          <td className="oi-ov-q">{t.p50 === null && t.p90 === null ? DASH : `${dur(t.p50)} / ${dur(t.p90)}`}</td>
        </tr>)}
      </tbody></table> : <span className="oi-ov-num">{DASH}</span>}
    </Card>
    </> : null}
    <Card title="Capture">
      <span className="oi-ov-num">{captureText(p.freshness)}</span>
      <span className="oi-ov-sub">{p.coverage ? `${p.coverage.known} / ${p.coverage.total} outcomes known` : DASH}</span>
    </Card>
    <Card title="Repo" onClick={r ? () => p.onOpen("changes") : undefined} wide>
      <span className="oi-ov-num">{r ? r.name : DASH}</span>
      <span className="oi-ov-sub">
        {r ? `commits today ${num(r.stats.commitsToday)}${r.bounded && r.stats.commitsToday !== null ? "+" : ""} · active branches (14d) ${num(r.stats.activeBranches)} · dirty ${r.stats.dirty === null ? DASH : r.stats.dirtyTruncated ? `${r.stats.dirty}+` : r.stats.dirty}` : DASH}
      </span>
    </Card>
  </div>;
}

export const overviewStyles = toolcallDashboardStyles + `
.oi-ov{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;padding:8px;color:var(--oi-text);font-size:11px}
.oi-ov-card{display:flex;flex-direction:column;gap:2px;min-width:0;padding:5px 7px;text-align:left;font:inherit;color:inherit;border-bottom:1px solid var(--oi-border)}
button.oi-ov-card{cursor:pointer}button.oi-ov-card:hover{background:var(--oi-hover)}
.oi-ov-wide{grid-column:span 2}
.oi-ov-note{grid-column:1/-1;margin:0;padding:2px 0 6px;color:var(--oi-muted);font-size:11px;line-height:1.5}
.oi-ov-title{color:var(--oi-muted);font-size:10px;text-transform:uppercase;letter-spacing:.04em}
.oi-ov-num{font-size:14px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-ov-sub{color:var(--oi-muted);font-size:10px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-ov-failure{border-color:var(--oi-tone-failure)}.oi-ov-failure .oi-ov-num{color:var(--oi-tone-failure)}
.oi-ov-attention{border-color:var(--oi-tone-attention)}.oi-ov-attention .oi-ov-num{color:var(--oi-tone-attention)}
.oi-ov-tools{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.oi-ov-tools td{padding:1px 0;white-space:nowrap}
.oi-ov-tool{max-width:0;width:100%;overflow:hidden;text-overflow:ellipsis}
.oi-ov-n,.oi-ov-q{padding-left:8px!important;text-align:right;color:var(--oi-muted)}
`;
