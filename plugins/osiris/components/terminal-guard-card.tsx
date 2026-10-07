import { useEffect, useState } from "react";
import { CopyErrorButton } from "./ui/copy-error-button.tsx";
import type { GuardResult } from "../work/seam-guards/types.ts";

/** ONE compact alert card for a Terminal<->Herdr guard result (D-138: loud, never blocking). Red rule = verified break (crit), amber = couldn't check (warn).
 *  The terminal below stays usable; "Use this terminal anyway" folds the card to one line (the top-bar pill stays red/amber either way). */
export function TerminalGuardCard({ guard, canUse, busy, onSwitch }: { guard: Extract<GuardResult, { ok: false }>; canUse: boolean; busy: boolean; onSwitch(): void }) {
  const [folded, setFolded] = useState(false), [details, setDetails] = useState(false);
  useEffect(() => { setFolded(false); setDetails(false); }, [guard.what, guard.why]);
  const cls = `oi-guard-card ${guard.severity}`;
  if (folded) return <div role="alert" className={`${cls} folded`}><strong>{guard.what}</strong><button type="button" className="oi-term-btn" onClick={() => setFolded(false)}>Details</button></div>;
  return <div role="alert" className={cls} title="Seam guard: Terminal ↔ Herdr">
    <strong className="oi-guard-title">{guard.what}</strong>
    <div className="oi-guard-why">{guard.why}</div>
    <div className="oi-guard-fix"><i>Fix</i> {guard.fix}</div>
    {details && <div className="oi-guard-details">Seam: Terminal ↔ Herdr · severity: {guard.severity === "crit" ? "verified problem" : "could not verify"}</div>}
    <div className="oi-guard-actions">
      <button type="button" className="oi-term-btn" disabled={busy} onClick={onSwitch}>Switch to default</button>
      <CopyErrorButton what={guard.what} seam="Terminal ↔ Herdr" why={guard.why} fix={guard.fix} className="oi-term-btn" />
      <button type="button" className="oi-term-btn" aria-expanded={details} onClick={() => setDetails(d => !d)}>Details</button>
      {canUse && <button type="button" className="oi-term-btn" onClick={() => setFolded(true)}>Use this terminal anyway</button>}
    </div>
  </div>;
}

export const terminalGuardStyles = `
.oi-guard-card{user-select:text;-webkit-user-select:text;flex:none;margin:6px 8px;padding:8px 12px;background:var(--oi-panel);border-left:3px solid var(--oi-tone-attention);border-bottom:1px solid var(--oi-border);font-size:12px;color:var(--oi-text);overflow-wrap:anywhere}
.oi-guard-card.crit{border-left-color:var(--oi-tone-failure)}
.oi-guard-title{display:block;color:var(--oi-tone-attention)}.oi-guard-card.crit .oi-guard-title{color:var(--oi-tone-failure)}
.oi-guard-why,.oi-guard-fix,.oi-guard-details{margin-top:3px;color:var(--oi-muted)}
.oi-guard-fix i{font-style:normal;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-right:4px}
.oi-guard-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.oi-guard-card.folded{display:flex;align-items:center;gap:8px;padding:3px 12px}.oi-guard-card.folded strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;
