import { kpis } from "../../work/surface-model.ts";
import type { WorkSurfaceSnapshot } from "../../work/surface-types.ts";
import { kpiTone } from "../../work/ui-text.ts";
import { kpiChips } from "./kpi-model.ts";

/** One compact row: READY n · ACTIVE n/m · BLOCKED n (oldest) · REVIEW n · STALE n (the Drift chip is the DriftLine just below). */
export function KpiStrip(p: { snap: WorkSurfaceSnapshot; now: number; activeCap?: number }) {
  const k = kpis(p.snap, p.now, { activeCap: p.activeCap });
  return <div className="oi-kpi" role="group" aria-label="Work summary">
    {kpiChips(k).map(t => <div key={t.key} className={`oi-kpi-tile oi-kpi-${kpiTone(t.key, k)}`}>
      <div className="oi-kpi-value">{t.value.includes("/") ? <>{t.value.split("/")[0]}<small>/{t.value.split("/")[1]}</small></> : t.value}</div>
      <div className="oi-kpi-label">{t.label}</div>
      {t.note && <div className="oi-kpi-sub">{t.note}</div>}
    </div>)}
  </div>;
}

// ONE ruled stat row (ui-v2 W6): no tile frames, no fills; a hairline rule between the stats. The DOM is unchanged.
export const kpiStripStyles = `
.oi-kpi{display:flex;flex-wrap:wrap;min-width:0}
.oi-kpi-tile{flex:0 1 auto;min-width:0;padding:0 14px;border-left:1px solid var(--oi-border)}
.oi-kpi-tile:first-child{border-left:0;padding-left:0}
.oi-kpi-label{font:600 9.5px var(--oi-font-head,system-ui,sans-serif);letter-spacing:.08em;color:var(--oi-muted)}
.oi-kpi-value{font:700 18px/1.1 var(--oi-font-mono,ui-monospace,monospace);font-variant-numeric:tabular-nums;color:var(--oi-tone-muted)}
.oi-kpi-value small{font-size:12px;color:var(--oi-muted)}
.oi-kpi-sub{font:10px var(--oi-font-mono,ui-monospace,monospace);color:var(--oi-muted);overflow-wrap:anywhere}
.oi-kpi-failure .oi-kpi-value{color:var(--oi-tone-failure);text-shadow:var(--oi-glow)}
.oi-kpi-attention .oi-kpi-value{color:var(--oi-tone-attention);text-shadow:var(--oi-glow)}
.oi-kpi-muted .oi-kpi-value{color:var(--oi-text)}
`;
