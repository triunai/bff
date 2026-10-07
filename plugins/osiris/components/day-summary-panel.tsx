import type { CSSProperties } from "react";
import { clip, type DaySections } from "../lib/day-sections.ts";
import { cleanText } from "../work/sanitize.ts";
import { AgentAction } from "./agent-action.tsx";
import { spendAskLines, type SpendRow } from "../spend-calendar.ts";

const tone = (v: string) => ({ "--c": `var(${v})` }) as CSSProperties;
const Empty = () => <span className="mk-note">{"—"}</span>;

/** Port of the mockup's .daysum block (state 8): the day's title, then SHIPPED / DECISIONS / THREADS / NOTABLE rows. Plain text only. */
export function DaySummaryPanel({ s, spend, onOpenBead, onOpenThread, onOpenDecision, onOpenMerges }: { s: DaySections; spend?: { date: string; row: SpendRow } | null; onOpenBead?(id: string): void; onOpenThread?(id: string): void; onOpenDecision?(id: string): void; onOpenMerges?(shas: readonly string[]): void }) {
  const t = (x: string) => clip(cleanText(x, 400), 160);
  return <div className="mk-daysum" aria-label="Day summary">
    <h3>{t(s.title)}</h3>
    <div className="mk-dsrow"><span className="k">Shipped</span><span className="mk-chips">
      {s.shipped.beads.map(b => <button key={b} type="button" className="mk-chip mk-idc" disabled={!onOpenBead} onClick={() => onOpenBead?.(b)}>{b}</button>)}
      {s.shipped.merges > 0 && <button type="button" className="mk-chip mk-idc" style={tone("--oi-lane-3")} title="Show only the merges in the Day tab" disabled={!onOpenMerges} onClick={() => onOpenMerges?.(s.shipped.mergeShas)}>{s.shipped.merges} {s.shipped.merges === 1 ? "merge" : "merges"}</button>}
      {s.shipped.beads.length === 0 && s.shipped.merges === 0 && <Empty />}</span></div>
    <div className="mk-dsrow"><span className="k">Decisions</span><span className="mk-chips">
      {s.decisions.map(d => <button key={d} type="button" className="mk-chip mk-idc" style={tone("--oi-lane-2")} disabled={!onOpenDecision} onClick={() => onOpenDecision?.(d)}>{d}</button>)}
      {s.decisions.length === 0 && <Empty />}</span></div>
    <div className="mk-dsrow"><span className="k">Threads</span><span className="mk-chips">
      {s.threads.map(w => <button key={w.id} type="button" className="mk-chip mk-idc" style={tone("--oi-lane-1")} title={w.label} disabled={!onOpenThread} onClick={() => onOpenThread?.(w.id)}>{cleanText(w.label, 60)}</button>)}
      {s.threads.length > 0 ? <span className="mk-note">each links to its log entries and cited ADRs</span> : <Empty />}</span></div>
    <div className="mk-dsrow"><span className="k">Notable</span><span>{s.notable.items.length ? <details className="mk-notable"><summary title={s.notable.items.join("\n")}>{s.notable.summary}</summary><ul>{s.notable.items.map((x, i) => <li key={i}>{t(x)}</li>)}</ul></details> : <Empty />}</span></div>
    {spend && <div className="mk-dsrow" data-row="spend"><span className="k">Spend</span><span className="mk-spend">
      <span className="mk-chips"><b className="mk-chip" style={tone("--oi-kind-spend")} title={spend.row.note}>{spend.row.total}</b>{spend.row.partial && <span className="mk-chip" title="The read window or a still-loading history cuts this day">partial</span>}{spend.row.cache && <span className="mk-chip">{spend.row.cache}</span>}{spend.row.status === "spent" && <AgentAction kind="spend" item={{ date: spend.date, lines: spendAskLines(spend.date, spend.row) }} />}</span>
      {spend.row.status === "spent" && <><span className="mk-chips">{spend.row.providers.map(p => <span key={p.id} className="mk-chip" data-provider={p.id} title={`${p.label}: ${p.text}`}>{p.label} {p.text}</span>)}</span>
        {spend.row.agents.length > 0 && <span className="mk-chips"><span className="mk-note">top agents</span>{spend.row.agents.map(a => <span key={a.lane} className="mk-chip" style={tone("--oi-lane-1")} title={`${a.lane}: ${a.text}`}>{cleanText(a.lane, 40)} {a.text}</span>)}</span>}</>}
      <small className="mk-note">{spend.row.status === "spent" ? spend.row.note : spend.row.note || "list-price est., not a bill"}</small></span></div>}
  </div>;
}

/** Values ported from the mockup (.daysum .dsrow .chip .idc) onto the theme's --oi-* tokens. */
export const daySummaryStyles = `
.mk-daysum{margin-top:14px}
.mk-daysum h3{margin:0 0 4px;font:600 14px var(--oi-font-ui);overflow-wrap:anywhere}
.mk-dsrow{display:grid;grid-template-columns:90px minmax(0,1fr);gap:8px;padding:5px 0;border-bottom:1px solid var(--oi-border);font-size:12px}
.mk-dsrow .k{font:600 9.5px/18px var(--oi-font-head);letter-spacing:.1em;color:var(--oi-tone-muted);text-transform:uppercase}
.mk-chips{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.mk-idc{--c:var(--oi-tone-info);border:0;cursor:pointer}.mk-idc:hover:not(:disabled){text-decoration:underline}.mk-idc:disabled{cursor:default}
.mk-spend{display:flex;flex-direction:column;gap:4px;min-width:0}
.mk-notable summary{cursor:pointer}.mk-notable ul{margin:4px 0 0;padding-left:16px}.mk-notable li{overflow-wrap:anywhere}
.mk-idc:focus-visible{outline:1px solid var(--oi-focus)}
`;
