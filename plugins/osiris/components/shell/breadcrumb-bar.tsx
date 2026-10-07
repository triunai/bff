import type { Crumb } from "../../shell/crumbs.ts";
import type { Loc } from "../../shell/nav-history.ts";
// The ONE breadcrumb bar (owner-approved harmony mockup, .crumb): ‹ › history buttons, then the trail, the last crumb bold and not a link.
// Pure view over (crumbs, can-go flags): the host owns the history and applies a clicked target through its single navigate.
export type BreadcrumbBarProps = { crumbs: Crumb[]; canBack: boolean; canForward: boolean; onBack: () => void; onForward: () => void; onCrumb: (target: Loc) => void; chords?: { back: string; forward: string } };

export function BreadcrumbBar({ crumbs, canBack, canForward, onBack, onForward, onCrumb, chords }: BreadcrumbBarProps) {
  return <nav className="oi-crumb" aria-label="Breadcrumb">
    <button type="button" className="oi-crumb-arr" disabled={!canBack} title={`Back${chords ? ` (${chords.back})` : ""}`} aria-label="Back" onClick={onBack}>‹</button>
    <button type="button" className="oi-crumb-arr" disabled={!canForward} title={`Forward${chords ? ` (${chords.forward})` : ""}`} aria-label="Forward" onClick={onForward}>›</button>
    {crumbs.map((c, i) => c.target
      ? <span key={i} className="oi-crumb-part"><button type="button" className="oi-crumb-link" onClick={() => onCrumb(c.target as Loc)}>{c.label}</button><span className="oi-crumb-sep" aria-hidden="true">›</span></span>
      : <b key={i} aria-current="location">{c.label}</b>)}
  </nav>;
}

export const breadcrumbBarStyles = `
.oi-crumb{display:flex;align-items:center;gap:6px;height:28px;flex:none;padding:0 12px;font:11px var(--oi-font-mono);color:var(--oi-muted,var(--oi-text-2));border-bottom:1px solid var(--oi-border);min-width:0;overflow:hidden;white-space:nowrap}
.oi-root .oi-crumb button{background:transparent;border:0;padding:0;font:inherit;color:inherit;cursor:pointer}
.oi-root .oi-crumb .oi-crumb-arr{width:20px;height:20px;border-radius:4px;color:var(--oi-text-2)}
.oi-root .oi-crumb .oi-crumb-arr:hover:not(:disabled){background:var(--oi-hover)}
.oi-root .oi-crumb .oi-crumb-arr:disabled{opacity:.35;cursor:default}
.oi-crumb-part{display:inline-flex;align-items:center;gap:6px}
.oi-root .oi-crumb .oi-crumb-link:hover{background:transparent;color:var(--oi-text)}
.oi-crumb b{color:var(--oi-text);font-weight:600;overflow:hidden;text-overflow:ellipsis}
.oi-crumb .oi-crumb-sep{opacity:.5}
`;
