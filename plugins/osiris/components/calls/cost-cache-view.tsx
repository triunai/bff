import { useMemo, useState } from "react";
import { costCacheView, fleetSummary, lastActivityText, nextSort, pctText, sortRows, spendByBead, spendByModel } from "../../work/cost-cache-model.ts";
import type { SortDir, SortKey } from "../../work/cost-cache-model.ts";
import type { WorkTelemetry } from "../../work/telemetry-model.ts";
import { cleanText, redactReason } from "../../work/sanitize.ts";
import type { WorkSurfaceSnapshot } from "../../work/surface-types.ts";
import { rangeLabel, rangeWords } from "../../work/calls-range.ts";
import type { RangeId } from "../../work/calls-range.ts";
import { RangeBar } from "./range-bar.tsx";
import { TokenEfficiencySection, TokenEfficiencyTile } from "./token-efficiency-view.tsx";

export type CostCacheViewProps = {
  telemetry: WorkTelemetry | null;
  /** Why there is no data: no tracker chosen, or the read failed. Text, never zeros. */
  note: string | null;
  now: number;
  /** The tracker snapshot, for the critical-path and agent-state panels. Optional: without it those two panels are left out. */
  snap?: WorkSurfaceSnapshot | null;
  /** The shared time range (Overview uses the same one) and how to change it. */
  range: RangeId;
  onRange: (r: RangeId) => void;
  /** Opens the tracker picker (Work). Without a tracker the tab offers it as a button. */
  onChooseTracker?: () => void;
};

const BEAD_ROWS = 15;
const COLUMNS: { key: SortKey; label: string; num?: boolean; hint?: string }[] = [
  { key: "lane", label: "Agent", hint: "The agent lane: its name is the name on the work item's claim." },
  { key: "bead", label: "Work item" }, { key: "model", label: "Model" },
  { key: "tokensIn", label: "In", num: true, hint: "Everything sent in: fresh input, cache writes and cache reads." },
  { key: "tokensOut", label: "Out", num: true },
  { key: "hitRate", label: "Reuse", num: true, hint: "Share of input read from the cache. Red below 60% once an agent has made 10 calls." },
  { key: "cost", label: "Est. $", num: true, hint: "Estimate at list price. Red at $5 or more." },
  { key: "lastAt", label: "Last active", num: true }, { key: "misses", label: "Misses", num: true, hint: "Calls that had to rewrite most of the cache (the first start-up is not counted)." },
];

/** The Calls panel's "Cost & cache" tab: the workTelemetry answer as header cards, a sortable per-agent table and the dated cache-miss list. */
export function CostCacheTab(p: CostCacheViewProps) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "cost", dir: "desc" });
  const v = useMemo(() => (p.telemetry ? costCacheView(p.telemetry, rangeLabel(p.range)) : null), [p.telemetry, p.now, p.range]);
  const fleet = useMemo(() => (p.snap ? fleetSummary(p.snap, p.now) : null), [p.snap, p.now]);
  const models = useMemo(() => spendByModel(p.telemetry?.byModel ?? []), [p.telemetry]);
  const allBeads = useMemo(() => spendByBead(p.telemetry?.beads ?? []), [p.telemetry]);
  const beads = allBeads.slice(0, BEAD_ROWS);
  const rows = useMemo(() => (v ? sortRows(v.rows, sort.key, sort.dir) : []), [v, sort]);
  if (!v) return <section className="oi-cc" aria-label="Cost and cache"><RangeBar range={p.range} onRange={p.onRange} polledAt={null} now={p.now} />{p.note ? <p className="oi-note">{redactReason(p.note)}</p> : <p className="oi-note">{p.onChooseTracker ? <button type="button" className="oi-cc-link" onClick={p.onChooseTracker}>Choose a tracker in Work</button> : "Choose a tracker in Work"} to see cost and cache numbers.</p>}</section>;
  return <section className="oi-cc" aria-label="Cost and cache">
    <RangeBar range={p.range} onRange={p.onRange} polledAt={p.telemetry?.freshness.polledAt} now={p.now} />
    <div className="oi-cc-cards">{v.cards.map(c => <div key={c.title} className="oi-ov-card" title={c.hint}><span className="oi-ov-title">{c.title}</span><span className="oi-ov-num">{c.value}</span><span className="oi-ov-sub" title={c.sub}>{c.sub}</span></div>)}</div>
    <div className="oi-cc-cards"><TokenEfficiencyTile eff={p.telemetry?.efficiency} /></div>
    {fleet && <div className="oi-cc-cards">
      {fleet.quests.map(q => <div key={q.state} className="oi-ov-card" title="Where every work item stands: running, waiting on you, ready to start, or something wrong."><span className="oi-ov-title">{q.label}</span><span className={`oi-ov-num${q.state === "error" && q.count ? " oi-cc-bad" : ""}`}>{q.count}</span></div>)}
      <div className="oi-ov-card" title="Critical path = the longest chain of dependent work in any one epic. Total work = all the time spent. If they are close, the work ran one task after another."><span className="oi-ov-title">Critical path</span>
        {fleet.critical ? <><span className="oi-ov-num">{fleet.critical.pathText} of {fleet.critical.totalText}</span><span className="oi-ov-sub">{fleet.critical.steps} steps · {fleet.critical.parallelism !== null ? `${fleet.critical.parallelism.toFixed(1)}x parallel` : "no parallel gain"}{fleet.critical.serialEpics > 0 ? ` · ${fleet.critical.serialEpics} of ${fleet.critical.epics} epics ran one task after another` : ""} · {fleet.critical.epics} epics</span></> : <span className="oi-ov-num">—</span>}</div>
    </div>}
    {v.readNote && <p className="oi-note oi-cc-bad" role="status">{v.readNote}</p>}
    <p className="oi-note">{v.coverageNote}{v.unpricedNote ? ` · ${v.unpricedNote}` : ""}</p>
    <h3 className="oi-cc-h">By agent{v.lanesNote ? <small> · {v.lanesNote}</small> : null}</h3>
    {v.noLaneData ? <p className="oi-note">This build of the server sends totals only; restart Osiris to see the per-agent table.</p> : rows.length ? <div className="oi-tools-table"><table className="oi-cc-table"><thead><tr>
      {COLUMNS.map(c => <th key={c.key} className={c.num ? "oi-cc-n" : undefined} aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} title={c.hint ? `${c.hint} Click to sort.` : "Click to sort."}>
        <button type="button" onClick={() => setSort(s => nextSort(s, c.key))}>{c.label}<span className={`oi-cc-arrow${sort.key === c.key ? " on" : ""}`} aria-hidden="true">{sort.key === c.key ? (sort.dir === "asc" ? " ▲" : " ▼") : " ↕"}</span></button></th>)}
    </tr></thead><tbody>
      {rows.map((r, i) => <tr key={`${r.lane}-${r.beadId ?? ""}-${i}`}>
        <td title={cleanText(r.lane)}>{cleanText(r.lane)}</td><td>{r.beadId ? cleanText(r.beadId) : "not matched"}</td><td>{r.model ? cleanText(r.model) : r.unpriced ? `unpriced model: ${cleanText(r.unpriced)}` : "—"}</td>
        <td className="oi-cc-n">{r.tokensInText}</td><td className="oi-cc-n">{r.tokensOutText}</td>
        <td className={`oi-cc-n${r.lowReuse ? " oi-cc-bad" : ""}`} title={`n=${r.requests} calls`}>{pctText(r.hitRate)}</td>
        <td className={`oi-cc-n${r.expensive ? " oi-cc-bad" : ""}`} title={r.unpriced ? `unpriced model: ${cleanText(r.unpriced)}` : undefined}>{r.costText}{r.unpriced ? ` (unpriced model: ${cleanText(r.unpriced)})` : ""}</td>
        <td className="oi-cc-n">{lastActivityText(r.lastAt, p.now)}</td>
        <td className="oi-cc-n" title={`${r.prefixBreaks} from the start of the prompt changing`}>{r.misses}</td>
      </tr>)}
    </tbody></table></div> : <p className="oi-note">{v.readNote ? "Nothing counted yet: the read is not finished." : `No agent transcripts ${rangeWords(p.range)}.`}</p>}
    {models.length > 0 && <><h3 className="oi-cc-h">By model</h3><div className="oi-tools-table"><table className="oi-cc-table"><thead><tr><th>Model</th><th className="oi-cc-n">Calls</th><th className="oi-cc-n">In</th><th className="oi-cc-n">Out</th><th className="oi-cc-n">Reuse</th><th className="oi-cc-n">Est. $</th></tr></thead><tbody>
      {models.map(m => <tr key={m.model}><td title={cleanText(m.model)}>{cleanText(m.model)}</td><td className="oi-cc-n">{m.requests}</td><td className="oi-cc-n">{m.tokensInText}</td><td className="oi-cc-n">{m.tokensOutText}</td><td className="oi-cc-n">{pctText(m.hitRate)}</td><td className="oi-cc-n">{m.costText}{m.unpriced ? ` (unpriced model: ${cleanText(m.model)})` : ""}</td></tr>)}</tbody></table></div></>}
    {beads.length > 0 && <><h3 className="oi-cc-h">By work item{allBeads.length > beads.length ? <small> · showing the {beads.length} biggest of {allBeads.length}</small> : null}</h3><div className="oi-tools-table"><table className="oi-cc-table"><thead><tr><th>Work item</th><th>Agent</th><th>Model</th><th className="oi-cc-n">Reuse</th><th className="oi-cc-n">Misses</th><th className="oi-cc-n">Est. $</th></tr></thead><tbody>
      {beads.map(b => <tr key={b.beadId}><td>{cleanText(b.beadId)}</td><td>{b.lane ? cleanText(b.lane) : "—"}</td><td>{b.model ? cleanText(b.model) : "—"}</td><td className="oi-cc-n">{pctText(b.hitRate)}</td><td className="oi-cc-n">{b.misses}</td><td className="oi-cc-n">{b.unpriced ? `${b.costText} (unpriced model)` : b.costText}</td></tr>)}</tbody></table></div></>}
    <TokenEfficiencySection eff={p.telemetry?.efficiency} />
    <h3 className="oi-cc-h">Cache misses{v.missesNote ? <small> · {v.missesNote}</small> : null}</h3>
    {v.misses.length ? <ul className="oi-cc-misses">{v.misses.map((m, i) => <li key={`${m.lane}-${m.at ?? i}-${i}`} title={m.explain}>
      <time>{m.at === null ? "—" : new Date(m.at).toLocaleString()}</time><b>{cleanText(m.lane)}</b><span className={m.cause === "prefix-break" ? "oi-cc-bad" : undefined}>{m.label}</span><small>{m.detail}</small></li>)}</ul>
      : <p className="oi-note">{v.readNote ? "None found so far: the read is not finished." : "No unexpected cache misses."}</p>}
  </section>;
}

export const costCacheStyles = `
.oi-cc{padding:8px;color:var(--oi-text);font-size:11px}
.oi-cc-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}
.oi-cc-h{margin:10px 0 4px;font-size:11px;font-weight:600}
.oi-cc-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.oi-cc-table th{padding:1px 0 1px 8px;font-weight:normal;font-size:10px;text-align:left;white-space:nowrap}.oi-cc-table th button{all:unset;cursor:pointer;color:var(--oi-muted)}.oi-cc-table th button:hover{color:var(--oi-text);text-decoration:underline}.oi-cc-table th button:focus-visible{outline:2px solid var(--oi-accent)}.oi-cc-arrow{opacity:.35}.oi-cc-arrow.on{opacity:1}.oi-cc-table th button:hover .oi-cc-arrow{opacity:.8}
.oi-cc-link{all:unset;cursor:pointer;color:var(--oi-accent);text-decoration:underline}.oi-cc-link:focus-visible{outline:2px solid var(--oi-accent)}
.oi-cc-table td{padding:2px 0 2px 8px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-cc-table .oi-cc-n{text-align:right}
.oi-cc-bad{color:var(--oi-tone-failure);font-weight:600}
.oi-cc-misses{list-style:none;margin:0;padding:0}.oi-cc-misses li{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;padding:2px 0;border-bottom:1px solid var(--oi-border);cursor:help}
.oi-cc-misses time,.oi-cc-misses small{color:var(--oi-muted)}
`;
