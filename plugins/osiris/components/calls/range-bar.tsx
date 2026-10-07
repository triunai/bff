import { RANGES, freshnessOf, rangeNote } from "../../work/calls-range.ts";
import type { RangeId } from "../../work/calls-range.ts";

/** The ONE time range control, shown by both Overview and Cost & cache, plus the freshness badge of the cost read. */
export function RangeBar(p: { range: RangeId; onRange: (r: RangeId) => void; polledAt?: number | null; now: number }) {
  const note = rangeNote(p.range), f = freshnessOf(p.polledAt, p.now);
  return <div className="oi-rb">
    <span className="oi-rb-segs" role="group" aria-label="Time range">{RANGES.map(r => <button key={r.id} type="button" className="oi-rb-seg" aria-pressed={p.range === r.id} title={r.hint} onClick={() => p.onRange(r.id)}>{r.label}</button>)}</span>
    <span className={`oi-rb-fresh oi-rb-${f.state}`} role="status" title="When the cost and cache numbers were last read from the agent transcripts.">{f.text}</span>
    {note && <span className="oi-note oi-rb-note">{note}</span>}
  </div>;
}
export const rangeBarStyles = `
.oi-rb{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:2px 0 4px;font-size:11px}
.oi-rb-segs{display:inline-flex;border:1px solid var(--oi-border)}
.oi-rb-seg{font:inherit;padding:1px 10px;color:var(--oi-muted);background:transparent;border:0;cursor:pointer}.oi-rb-seg+.oi-rb-seg{border-left:1px solid var(--oi-border)}
.oi-rb-seg:hover{color:var(--oi-text);background:var(--oi-raised)}.oi-rb-seg[aria-pressed=true]{color:var(--oi-text);background:var(--oi-selected)}
.oi-rb-fresh{color:var(--oi-muted)}.oi-rb-stale,.oi-rb-unread{color:var(--oi-tone-attention);font-weight:600}.oi-rb-fresh.oi-rb-fresh{white-space:nowrap}
`;
