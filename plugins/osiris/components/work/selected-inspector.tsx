import { capitalise, firstUse, termLabel } from "../../work/glossary.ts";
import { demoTitle, useDemoOn } from "../../demo/client.ts";
import type { WorkSurfaceSnapshot } from "../../work/surface-types.ts";
import { DecisionsPanel } from "./decisions-panel.tsx";
import { selectedModel } from "./selected-model.ts";

export const SELECTED_EMPTY_TEXT = "Select a work item to see what it waits on and to dispatch it.";

export type WorkRailProps = { snap: WorkSurfaceSnapshot; now: number; selectedId: string | null; onSelect(id: string): void; onOpenDispatch(): void };

/** Right rail: decisions waiting on the owner, then the selected work item with its Dispatch button (the ui-v2 mockup's right column). */
export function WorkRail(p: WorkRailProps) {
  const m = selectedModel(p.snap, p.selectedId, p.now);
  const tip = firstUse(), demo = useDemoOn();
  const none = (v: string[]) => (v.length ? v.join(", ") : "none");
  const selected = <section className="oi-sel" aria-label="Selected work item">
      <h3 className="oi-sel-h">Selected</h3>
      {!m ? <div className="oi-sel-empty">{SELECTED_EMPTY_TEXT}</div> : <>
        <p className="oi-sel-t">{m.title}</p>
        <div className="oi-sel-id"><code>{m.id}</code> · P{m.priority}</div>
        <dl className="oi-sel-dl">
          <dt>Stage</dt><dd>{m.stage}</dd>
          <dt title={tip("pane")}>{capitalise(termLabel("pane"))}</dt><dd>{m.pane ?? `no ${termLabel("pane")} attached`}</dd>
          <dt>Waiting on</dt><dd>{none(m.waitingOn)}</dd>
          <dt>Unblocks</dt><dd>{none(m.unblocks)}</dd>
          <dt>Age</dt><dd>{m.age}</dd>
        </dl>
        <button type="button" className="oi-sel-dispatch" disabled={m.blockReason !== null || demo} title={demoTitle(demo, m.blockReason ?? tip("dispatch"))} onClick={p.onOpenDispatch}>Dispatch…</button>
        {m.blockReason && <div className="oi-sel-why">{m.blockReason}</div>}
      </>}
    </section>;
  const decisions = <DecisionsPanel snap={p.snap} now={p.now} onSelect={p.onSelect} collapsed={!!m} />;
  // With a selection the details come FIRST (you never scroll past the decisions list to read what you clicked); with none, decisions lead.
  return <div className="oi-rail">{m ? <>{selected}{decisions}</> : <>{decisions}{selected}</>}</div>;
}

export const selectedInspectorStyles = `
.oi-rail{display:flex;flex-direction:column;gap:8px;min-width:0;padding:8px}
.oi-sel{min-width:0;font-size:11px;color:var(--oi-text)}
.oi-sel-h{margin:0 0 3px;font-size:10px;letter-spacing:.05em;font-weight:600;color:var(--oi-muted)}
.oi-sel-empty,.oi-sel-why{color:var(--oi-muted);font-size:10px}
.oi-sel-id{font-size:10px;color:var(--oi-muted)}
.oi-sel-t{margin:2px 0 6px;font-size:13px;overflow-wrap:anywhere}
.oi-sel-dl{display:grid;grid-template-columns:auto 1fr;gap:2px 8px;margin:0 0 6px}
.oi-sel-dl dt{color:var(--oi-muted)}
.oi-sel-dl dd{margin:0;min-width:0;overflow-wrap:anywhere}
.oi-sel-dispatch{padding:4px 12px;font:inherit;font-weight:600;color:var(--oi-on-accent);background:var(--oi-accent);border:1px solid var(--oi-accent);border-radius:4px;cursor:pointer}
.oi-sel-dispatch:disabled{color:var(--oi-muted);background:transparent;border-color:var(--oi-border);cursor:not-allowed}
`;
