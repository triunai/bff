import { useState } from "react";
import type { DriftFinding } from "../../work/drift.ts";
import { DRIFT_DEFAULT_OPEN, driftLineModel } from "../../lib/drift-ui.ts";

/** "DRIFT n": one hairline row per finding where the tracker, the panes and git disagree; the first three, then "+n more". Renders nothing
 * when there is no drift. Drift has its own hue (--oi-drift), never failure red: it asks for a look, it does not say something broke. */
export function DriftLine(p: { findings: readonly DriftFinding[]; now: number }) {
  const [open, setOpen] = useState(DRIFT_DEFAULT_OPEN);
  const [all, setAll] = useState(false); // hooks first: the early return below must not change the hook order
  if (p.findings.length === 0) return null;
  const m = driftLineModel(p.findings, p.now, all);
  if (!open) return <section className="oi-drift oi-drift-shut" aria-label="Drift">
    <button type="button" className="oi-drift-sum" aria-expanded={false} onClick={() => setOpen(true)} title="Show where the tracker, the panes and git disagree">Drift <b>{m.count}</b> ▸</button>
  </section>;
  return <section className="oi-drift" aria-label="Drift">
    <h3 className="oi-drift-h"><button type="button" className="oi-drift-sum" aria-expanded={true} onClick={() => setOpen(false)}>Drift <b>{m.count}</b> ▾</button></h3>
    {m.rows.map(r => <div key={r.key} className={`oi-drift-row${r.edge ? " oi-drift-edge" : ""}`}>
      <span className={`oi-drift-badge oi-drift-${r.volume}`}>{r.badge}</span>
      <span className="oi-drift-msg" title={r.message}>{r.message}</span>
      {r.worktree && <code className="oi-drift-wt" title={r.worktree}>{r.worktree}</code>}
      {r.age && <small className="oi-drift-age">{r.age}</small>}
    </div>)}
    {(m.more > 0 || all) && <button type="button" className="oi-drift-more" aria-expanded={all} onClick={() => setAll(v => !v)}>{all ? "Show fewer" : `+${m.more} more`}</button>}
  </section>;
}

export const driftLineStyles = `
.oi-drift{display:flex;flex-direction:column;min-width:0;flex:none;padding:4px 10px 6px;border-bottom:1px solid var(--oi-border)}
.oi-drift-sum{all:unset;cursor:pointer;font:600 12px var(--oi-font-head,system-ui,sans-serif);color:var(--oi-text);padding:2px 0}.oi-drift-sum:focus-visible{outline:1px solid var(--oi-accent)}.oi-drift-shut{padding-top:2px;padding-bottom:2px}
.oi-drift-h{margin:0 0 2px;font:600 10px var(--oi-font-head,system-ui,sans-serif);letter-spacing:.08em;color:var(--oi-muted)}
.oi-drift-h b{color:var(--oi-drift);text-shadow:var(--oi-glow)}
.oi-drift-row{display:flex;align-items:baseline;gap:8px;min-width:0;padding:2px 0;border-top:1px solid var(--oi-border);font-size:11px}
.oi-drift-row:first-of-type{border-top:0}
.oi-drift-edge{box-shadow:inset 2px 0 0 var(--oi-drift);padding-left:8px}
.oi-drift-badge{flex:none;padding:0 7px;border-radius:9px;font-size:10px;white-space:nowrap}
.oi-drift-solid{background:var(--oi-drift);color:var(--oi-on-drift)}
.oi-drift-tint{color:var(--oi-drift);background:color-mix(in srgb,var(--oi-drift) var(--oi-tint,16%),transparent)}
.oi-drift-text{color:var(--oi-drift)}
.oi-drift-msg{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--oi-text-2,var(--oi-text))}
.oi-drift-wt{flex:none;max-width:30%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:10px var(--oi-font-mono,ui-monospace,monospace);color:var(--oi-muted)}
.oi-drift-age{flex:none;color:var(--oi-muted);font-variant-numeric:tabular-nums}
.oi-drift-more{align-self:flex-start;margin-top:2px;padding:0;border:0;background:transparent;font:inherit;font-size:10px;color:var(--oi-accent);cursor:pointer}
`;
