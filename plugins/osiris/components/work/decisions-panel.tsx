import { useState } from "react";
import { ptClass } from "../../work/priority-tone.ts";
import { decisionsWaiting } from "../../work/surface-model.ts";
import type { WorkSurfaceSnapshot } from "../../work/surface-types.ts";
import { firstUse, termLabel } from "../../work/glossary.ts";
import { decisionKindText } from "../../work/ui-text.ts";
import { isCriticalDecision } from "./selected-model.ts";
import { DISPATCH_LABEL } from "../../work/herdr-dispatch/index.ts";
import { shortId } from "../../work/surface-model.ts";
import { cleanText } from "../../work/sanitize.ts";
import { shortAge } from "../../work/board-card-model.ts";
import type { DriftFinding } from "../../work/drift.ts";
import { capDecisions, decisionDetail, decisionPrompt, delayParts, driftErrors, orderDecisions, type DecisionDetail, type WaitingRow } from "./decisions-model.ts";

export type DecisionsPanelProps = { snap: WorkSurfaceSnapshot; now: number; onSelect(id: string): void;
  /** True while a work item is selected: the card folds to its header + count (the selection sits above it) and expands on demand. */
  collapsed?: boolean;
  /** The picked bead. When it is a decision, its detail pins on top of the list (mockup state 4). */
  selectedId?: string | null; onClear?(): void;
  /** Dispatch / Copy / Open: the host owns the ONE dispatch dialog, the clipboard toast and navigation. */
  onDispatch?(prompt: string, title: string): void; onCopyPrompt?(prompt: string): void; onOpenInWork?(id: string): void;
  waiting?: readonly WaitingRow[]; onGoToPane?(key: string): void; drift?: readonly DriftFinding[] };

/** The pinned detail: severity chip, id, ×, title, why you, what it unblocks, who asked, OPTIONS (only when the tracker has them) and the actions. */
function DecisionDetail(p: { d: DecisionDetail; onClear?(): void; onDispatch?(prompt: string, title: string): void; onCopyPrompt?(prompt: string): void; onOpenInWork?(id: string): void }) {
  const d = p.d, prompt = decisionPrompt(d);
  return <div className="oi-dec-detail" aria-label="Selected decision">
    {p.onClear && <button type="button" className="oi-dec-x" title="Clear (Esc)" aria-label="Clear the selected decision" onClick={p.onClear}>×</button>}
    <div className="oi-dec-eyebrow">{d.critical && <span className="oi-dec-chip oi-dec-chip-crit">{decisionKindText("crit").toLowerCase()}</span>}<span className="oi-dec-mono">{d.shortId}</span></div>
    <h3 className="oi-dec-dt">{d.title}</h3>
    <div className="oi-dec-why">Owner gate{d.putOff !== null && <> · put off <b className="oi-dec-overdue">{d.putOff} session{d.putOff === 1 ? "" : "s"}</b></>} · waiting {shortAge(d.waitingMs)}</div>
    <dl className="oi-dec-kv"><dt>If you decide</dt><dd>{d.unblocks.length === 0 ? "—" : <>Unblocks <span className="oi-dec-chips">{d.unblocks.map(u => <span key={u} className="oi-dec-chip oi-dec-idc">{shortId(u)}</span>)}</span></>}</dd>
      <dt>Asked by</dt><dd>{d.askedBy ? cleanText(d.askedBy) : "—"}</dd></dl>
    {d.options.length > 0 && <><div className="oi-dec-eyebrow oi-dec-eyebrow-opts">Options</div>
      <ol className="oi-dec-opts">{d.options.map((o, i) => <li key={i} className={o.suggested ? "rec" : undefined}>{o.text}{o.suggested && <span className="oi-dec-chip oi-dec-tag">suggested</span>}</li>)}</ol></>}
    <div className="oi-dec-acts">
      {p.onDispatch && <button type="button" className="oi-dec-btn pri" onClick={() => p.onDispatch!(prompt, "Decision")}>{DISPATCH_LABEL}…</button>}
      {p.onCopyPrompt && <button type="button" className="oi-dec-btn" onClick={() => p.onCopyPrompt!(prompt)}>Copy as prompt</button>}
      {p.onOpenInWork && <button type="button" className="oi-dec-btn ghost" onClick={() => p.onOpenInWork!(d.id)}>Open in Work</button>}</div>
  </div>;
}

/** NEEDS YOU: the selected decision pinned on top, then DECISIONS n (critical first then oldest, top 5 and a quiet "+N more"), AGENTS WAITING n and DRIFT n "errors only". */
export function DecisionsPanel(p: DecisionsPanelProps) {
  const [more, setMore] = useState(false), [open, setOpen] = useState(false);
  const rows = orderDecisions(decisionsWaiting(p.snap, p.now), r => isCriticalDecision(p.snap, r));
  const tip = firstUse();
  const folded = !!p.collapsed && !open;
  const { shown, more: hidden } = capDecisions(rows, more);
  const detail = p.selectedId ? decisionDetail(p.snap, p.selectedId, p.now) : null;
  const waiting = p.waiting ?? [], drift = driftErrors(p.drift ?? [], p.now);
  return <section className="oi-dec" aria-label="Decisions waiting on you">
    {detail && <DecisionDetail d={detail} onClear={p.onClear} onDispatch={p.onDispatch} onCopyPrompt={p.onCopyPrompt} onOpenInWork={p.onOpenInWork} />}
    <h3 className="oi-dec-h">{p.collapsed && rows.length > 0
      ? <button type="button" className="oi-dec-toggle" aria-expanded={!folded} onClick={() => setOpen(o => !o)}><span aria-hidden="true">{folded ? "▸" : "▾"}</span> Decisions <span className="oi-dec-n">{rows.length}</span></button>
      : <>Decisions <span className="oi-dec-n">{rows.length}</span></>}</h3>
    {rows.length === 0 ? <div className="oi-dec-empty">Nothing is waiting on you.</div>
      : folded ? null
      : <><ul className="oi-dec-list">{shown.map(r => { const d = delayParts(r), sel = r.id === p.selectedId; return <li key={r.id}>
          <button type="button" className={`oi-dec-row ${ptClass({ kind: r.kind, priority: p.snap.issues.find(i => i.id === r.id)?.priority })}${sel ? " sel" : ""}`} aria-current={sel ? "true" : undefined} title={r.title} onClick={() => p.onSelect(r.id)}>
            <span className="oi-dec-l1"><code className="oi-dec-id" title={tip("bead")}>{r.shortId}</code><span className="oi-dec-title">{r.title}</span>{isCriticalDecision(p.snap, r) && <span className="oi-dec-chip oi-dec-chip-crit">crit</span>}</span>
            <span className="oi-dec-delay" title={`How long this ${termLabel("bead")} has waited, and how many working sessions it has been put off.`}><span className={d.overdue ? "oi-dec-overdue" : undefined}>{d.age}</span>{d.rest ? ` · ${d.rest}` : ""}</span>
          </button>
        </li>; })}</ul>
        {hidden > 0 && <button type="button" className="oi-dec-more" onClick={() => setMore(true)}>+{hidden} more</button>}
        {more && rows.length > 5 && <button type="button" className="oi-dec-more" onClick={() => setMore(false)}>Show fewer</button>}</>}
    {!folded && <>
      <h3 className="oi-dec-h oi-dec-sec">Agents waiting <span className="oi-dec-n">{waiting.length}</span></h3>
      {waiting.length === 0 ? <div className="oi-dec-empty">No agent is waiting on you.</div>
        : <ul className="oi-dec-list">{waiting.map(w => <li key={w.key}><div className="oi-dec-row">
          <span className="oi-dec-l1"><span className="oi-dec-wait" aria-hidden="true">{w.shape}</span><span className="oi-dec-title">{w.name}</span><span className={`oi-dec-chip oi-dec-pv oi-dec-pv-${w.runtime}`}>{w.chip}</span></span>
          <span className="oi-dec-delay">{w.why}{p.onGoToPane && <> · <button type="button" className="oi-dec-go" onClick={() => p.onGoToPane!(w.key)}>Go to {termLabel("pane")}</button></>}</span></div></li>)}</ul>}
      <h3 className="oi-dec-h oi-dec-sec">Drift <span className="oi-dec-n oi-dec-drift-n">{drift.length}</span> <span className="oi-dec-soft">errors only</span></h3>
      {drift.length > 0 && <ul className="oi-dec-list">{drift.map(f => <li key={f.key}><div className="oi-dec-row oi-dec-drift"><span className="oi-dec-l1"><span className="oi-dec-chip oi-dec-chip-drift">{f.badge}</span></span>{f.meta && <span className="oi-dec-delay">{f.meta}</span>}</div></li>)}</ul>}
    </>}
  </section>;
}

export const decisionsPanelStyles = `
.oi-dec{min-width:0;padding:10px 12px;border-top:1px solid var(--oi-border-strong,var(--oi-border));font-size:12px;color:var(--oi-text)}
.oi-dec-h{margin:0 0 4px;display:flex;align-items:center;gap:8px;font:600 10px var(--oi-font-head,ui-monospace,monospace);letter-spacing:.09em;text-transform:uppercase;color:var(--oi-muted)}
.oi-dec-sec{margin-top:14px}
.oi-dec-n{font-variant-numeric:tabular-nums;color:var(--oi-accent);font-weight:700;text-shadow:var(--oi-glow)}
.oi-dec-drift-n{color:var(--oi-drift)}.oi-dec-soft{letter-spacing:0;text-transform:none;font-weight:400}
.oi-root .oi-dec-toggle{display:inline-flex;gap:4px;align-items:baseline;padding:2px 0;border:0;background:transparent;font:inherit;letter-spacing:inherit;text-transform:inherit;color:inherit;cursor:pointer}
.oi-dec-empty{color:var(--oi-muted);font-size:11px}
.oi-dec-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column}
.oi-dec-row{display:flex;flex-direction:column;gap:1px;width:100%;min-width:0;box-sizing:border-box;padding:6px 8px;border:0;border-bottom:1px solid var(--oi-border);border-radius:3px;font:inherit;color:inherit;text-align:left;background:transparent;cursor:pointer}
div.oi-dec-row{cursor:default}
.oi-dec-row:hover{background:var(--oi-hover)}
.oi-dec-row.sel{background:var(--oi-selected);box-shadow:inset 2px 0 0 var(--oi-accent)}
.oi-dec-drift{box-shadow:inset 2px 0 0 var(--oi-drift)}
.oi-dec-row:focus-visible,.oi-dec-more:focus-visible,.oi-dec-toggle:focus-visible{outline:1px solid var(--oi-focus,var(--oi-accent));outline-offset:-1px}
.oi-dec-l1{display:flex;align-items:baseline;gap:6px;min-width:0}
.oi-dec-id{flex:none;font:10.5px var(--oi-font-mono,ui-monospace,monospace);color:var(--oi-muted)}
.oi-dec-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--oi-text)}
.oi-dec-chip{display:inline-flex;align-items:center;gap:4px;flex:none;padding:0 6px;border-radius:9px;font:600 10.5px/17px var(--oi-font-mono,ui-monospace,monospace);white-space:nowrap;color:var(--c,var(--oi-text-2,var(--oi-text)));background:color-mix(in srgb,var(--c,var(--oi-muted)) 16%,transparent)}
.oi-dec-chip-crit{--c:var(--oi-tone-failure)}.oi-dec-chip-drift{--c:var(--oi-drift);white-space:normal}.oi-dec-idc{--c:var(--oi-tone-info)}
.oi-dec-pv{--c:var(--oi-tone-running)}
.oi-dec-wait{color:var(--oi-tone-attention);font:600 10.5px var(--oi-font-mono,ui-monospace,monospace)}
.oi-dec-delay{font:10.5px var(--oi-font-mono,ui-monospace,monospace);font-variant-numeric:tabular-nums;color:var(--oi-muted)}
.oi-dec-overdue{color:var(--oi-tone-attention)}
.oi-root .oi-dec-go{padding:0;border:0;background:transparent;font:inherit;color:var(--oi-tone-info);cursor:pointer}
.oi-root .oi-dec-more{align-self:flex-start;padding:4px 8px;border:0;background:transparent;font:11px var(--oi-font-mono,ui-monospace,monospace);color:var(--oi-muted)}
.oi-root .oi-dec-more:hover{color:var(--oi-text)}
.oi-dec-detail{padding:10px 12px 12px;margin:-10px -12px 12px;border-bottom:1px solid var(--oi-border-strong,var(--oi-border));background:color-mix(in srgb,var(--oi-accent) 6%,var(--oi-panel))}
.oi-dec-eyebrow{display:flex;align-items:center;gap:8px;font:600 10px var(--oi-font-head,ui-monospace,monospace);letter-spacing:.09em;text-transform:uppercase;color:var(--oi-muted)}
.oi-dec-eyebrow .oi-dec-mono{letter-spacing:0;font-family:var(--oi-font-mono,ui-monospace,monospace)}.oi-dec-eyebrow-opts{margin-bottom:2px}
.oi-dec-dt{margin:4px 0 6px;font:600 14px/1.35 var(--oi-font-ui,system-ui,sans-serif);text-transform:none;letter-spacing:0;color:var(--oi-text)}
.oi-dec-why{font:11px var(--oi-font-mono,ui-monospace,monospace);color:var(--oi-text-2,var(--oi-text));margin-bottom:8px}
.oi-dec-kv{display:grid;grid-template-columns:76px 1fr;gap:4px 10px;font-size:11.5px;margin:6px 0 8px}
.oi-dec-kv dt{color:var(--oi-muted)}.oi-dec-kv dd{margin:0;min-width:0}
.oi-dec-chips{display:inline-flex;flex-wrap:wrap;gap:4px}
.oi-dec-opts{margin:6px 0 10px;padding:0;list-style:none;counter-reset:o}
.oi-dec-opts li{counter-increment:o;display:flex;gap:8px;padding:5px 6px;border-radius:4px;font-size:12px}
.oi-dec-opts li:before{content:counter(o);font:700 10px/18px var(--oi-font-mono,ui-monospace,monospace);width:18px;height:18px;border-radius:50%;text-align:center;background:var(--oi-hover);color:var(--oi-text-2,var(--oi-text));flex:none}
.oi-dec-opts li.rec{background:color-mix(in srgb,var(--oi-tone-success,var(--oi-tone-running)) 9%,transparent)}
.oi-dec-tag{--c:var(--oi-tone-success,var(--oi-tone-running));margin-left:auto}
.oi-dec-acts{display:flex;flex-wrap:wrap;gap:6px}
.oi-root .oi-dec-btn{font:12px var(--oi-font-ui,system-ui,sans-serif);padding:5px 11px;border:0;border-radius:6px;background:var(--oi-hover);color:var(--oi-text);cursor:pointer}
.oi-root .oi-dec-btn:hover{background:color-mix(in srgb,var(--oi-text) 12%,transparent)}
.oi-root .oi-dec-btn.pri{background:var(--oi-accent);color:var(--oi-on-accent);font-weight:600;box-shadow:var(--oi-glow-active)}
.oi-root .oi-dec-btn.ghost{background:transparent;color:var(--oi-text-2,var(--oi-text))}
.oi-root .oi-dec-x{float:right;width:22px;height:22px;border:0;border-radius:4px;background:transparent;font-size:14px;color:var(--oi-muted);cursor:pointer}
.oi-root .oi-dec-x:hover{background:var(--oi-hover);color:var(--oi-text)}
`;
