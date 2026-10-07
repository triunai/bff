import { useEffect, useRef, useState } from "react";
import { SEAM_PERIOD_MS } from "../work/seam-guards/registry.ts";
import { brokenEntries, critCount, indicator, logLine, newCrits, parseSeamAnswer, unreachableReport } from "../work/seam-guards/surface.ts";
import { CopyErrorButton } from "./ui/copy-error-button.tsx";
import type { BrokenEntry } from "../work/seam-guards/surface.ts";
import type { SeamReport, ViewFacts } from "../work/seam-guards/types.ts";

export type SeamCaller = { call(name: "seamReport", args: ViewFacts): Promise<unknown> };

/** Runs the guards 400 ms after load, every SEAM_PERIOD_MS, whenever what the owner is looking at changes, and when the window regains focus.
 *  A failed or refused call is the unreachable crit, never silence. console.error fires once per ok/warn -> crit transition. */
export function useSeamReport(rpc: SeamCaller, facts: ViewFacts, enabled = true): SeamReport | null {
  const [report, setReport] = useState<SeamReport | null>(null), prev = useRef<SeamReport | null>(null);
  const key = JSON.stringify(facts);
  useEffect(() => {
    if (!enabled) return;
    let off = false;
    const load = () => {
      const got = (r: SeamReport) => { if (off) return; for (const e of newCrits(prev.current, r)) console.error(logLine(e)); prev.current = r; setReport(r); };
      rpc.call("seamReport", JSON.parse(key) as ViewFacts).then(a => got(parseSeamAnswer(a, Date.now())), e => got(unreachableReport(String((e as Error)?.message ?? e), Date.now())));
    };
    // Debounced: switching repos updates the tracker a render before the snapshot is cleared, and that one-render mismatch must not be judged.
    const first = setTimeout(load, 400);
    const t = setInterval(() => { if (!document.hidden) load(); }, SEAM_PERIOD_MS), onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => { off = true; clearTimeout(first); clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [rpc, key, enabled]);
  return report;
}

/** One broken seam: what / why / fix. Crit rows are red, warn rows amber. */
function SeamRow({ e }: { e: BrokenEntry }) {
  return <li className={`oi-seam-row ${e.result.severity}`}>
    <b className="oi-seam-what">{e.result.what}</b>
    <span className="oi-seam-seam">{e.seam}</span>
    <p className="oi-seam-why"><i>Why it matters</i> {e.result.why}</p>
    <p className="oi-seam-fix"><i>Fix</i> {e.result.fix}</p>
    <CopyErrorButton what={e.result.what} seam={e.seam} why={e.result.why} fix={e.result.fix} className="oi-seam-copy" />
  </li>;
}

/** The top-bar indicator: absent when every guard is ok; red "N seams broken" with any crit; amber for warns only. */
export function SeamsIndicator({ report, open, onToggle }: { report: SeamReport | null; open: boolean; onToggle(): void }) {
  const ind = indicator(report);
  if (!ind) return null;
  return <button type="button" className={`oi-seam-ind ${ind.tone}`} aria-haspopup="dialog" aria-expanded={open} title="Open the Seams panel: what broke, why it matters, how to fix it" onClick={onToggle}><span aria-hidden="true">{ind.tone === "crit" ? "●" : "▲"}</span> {ind.text}</button>;
}

/** The Seams panel: every broken seam, what / why / fix. Escape closes it. */
export function SeamsPanel({ report, onClose }: { report: SeamReport | null; onClose(): void }) {
  const rows = brokenEntries(report);
  return <div className="oi-seam-pop" role="dialog" aria-label="Seams" onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
    <button type="button" className="oi-seam-x" aria-label="Close the Seams panel" onClick={onClose}>×</button>
    <h2 className="oi-seam-h">Seams</h2>
    {rows.length === 0 ? <p className="oi-seam-ok">Every seam is verified.</p> : <ul className="oi-seam-list">{rows.map(e => <SeamRow key={e.id} e={e} />)}</ul>}
  </div>;
}

/** The crit group at the very top of Health: renders nothing unless something is crit, and then it is impossible to miss. */
export function SeamsHealthGroup({ report }: { report: SeamReport | null }) {
  const crits = brokenEntries(report).filter(e => e.result.severity === "crit");
  if (crits.length === 0) return null;
  return <section className="oi-seam-health" aria-label="Broken seams"><h3 className="oi-seam-hh">Broken seams <i>{critCount(report)} critical</i></h3><ul className="oi-seam-list">{crits.map(e => <SeamRow key={e.id} e={e} />)}</ul></section>;
}

export const seamsStyles = `
.oi-seam-ind{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:3px;font:inherit;font-size:10px;font-weight:700;cursor:pointer;background:transparent}
.oi-seam-ind.crit{border:1px solid var(--oi-tone-failure);color:var(--oi-tone-failure);background:color-mix(in srgb,var(--oi-tone-failure) 16%,transparent)}
.oi-seam-ind.warn{border:1px solid var(--oi-tone-attention);color:var(--oi-tone-attention)}
.oi-seam-ind:focus-visible,.oi-seam-x:focus-visible{outline:1px solid var(--oi-focus,var(--oi-accent));outline-offset:1px}
.oi-seam-pop{position:fixed;right:8px;top:30px;z-index:60;box-sizing:border-box;width:min(480px,calc(100vw - 16px));max-height:min(70vh,560px);overflow:auto;padding:10px 12px;background:var(--oi-panel);border:1px solid var(--oi-border-strong,var(--oi-border));color:var(--oi-text);font-size:12px}
.oi-seam-x{position:absolute;right:6px;top:4px;border:0;background:transparent;color:var(--oi-muted);font:inherit;font-size:16px;cursor:pointer}
.oi-seam-h{margin:0 0 6px;font-size:13px;font-weight:600}.oi-seam-ok{margin:6px 0;color:var(--oi-tone-success)}
.oi-seam-list{list-style:none;margin:0;padding:0}
.oi-seam-copy{margin-top:4px;font:inherit;font-size:11px;color:var(--oi-accent);background:transparent;border:0;padding:0;text-decoration:underline;cursor:pointer}
.oi-seam-pop,.oi-seam-row,.oi-seam-health{user-select:text;-webkit-user-select:text}
.oi-seam-row{margin:6px 0;padding:4px 8px;border-left:3px solid var(--oi-tone-attention);overflow-wrap:anywhere}.oi-seam-row.crit{border-left-color:var(--oi-tone-failure)}
.oi-seam-what{display:block}.oi-seam-seam{display:block;font-size:10px;color:var(--oi-muted)}
.oi-seam-why,.oi-seam-fix{margin:3px 0 0}.oi-seam-why i,.oi-seam-fix i{font-style:normal;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-right:4px;color:var(--oi-muted)}
.oi-seam-health{margin:8px 0;padding:6px 8px;border:1px solid var(--oi-tone-failure);background:color-mix(in srgb,var(--oi-tone-failure) 10%,transparent)}
.oi-seam-hh{margin:0 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--oi-tone-failure)}.oi-seam-hh i{font-style:normal;font-weight:400;margin-left:6px}
`;
