import type { FleetLane } from "../../work/fleet-types.ts";
import { agentInspectorView } from "../../work/agent-inspector-model.ts";
import { AgentAction } from "../agent-action.tsx";

/** The right-panel inspector for ONE agent: where a click on an agent lands when it has no Herdr pane to jump to. */
export function AgentInspector(p: { lane: FleetLane; parent?: FleetLane | null; children?: readonly FleetLane[]; onOpenBead(id: string): void; onClose(): void }) {
  const v = agentInspectorView(p.lane);
  return <aside className="oi-ai" aria-label="Selected agent inspector">
    <div className="oi-section-heading"><h2>Agent</h2><AgentAction kind="fleet" item={p.lane} parent={p.parent} children={p.children} /><button type="button" onClick={p.onClose} aria-label="Close agent inspector">×</button></div>
    <h3 className="oi-ai-t">{v.title} <span className="oi-ai-chip">{v.chip}</span></h3>
    <p className={`oi-note ${v.waiting ? "oi-ai-wait" : ""}`}>{v.state}{v.waiting ? ` · ${v.waiting}` : ""}</p>
    <dl className="oi-ai-kv">{v.rows.map(r => <div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}
      {v.beadId && <div><dt>Work item</dt><dd><button type="button" className="oi-hm-link" onClick={() => p.onOpenBead(v.beadId!)}>{v.beadId}</button></dd></div>}</dl>
  </aside>;
}
export const agentInspectorStyles = `
.oi-ai{padding:10px 12px;font-size:12px}.oi-ai-t{margin:6px 0;font:600 14px var(--oi-font-head)}
.oi-ai-chip{font:600 10.5px var(--oi-font-mono);padding:0 6px;border-radius:9px;background:var(--oi-hover);color:var(--oi-text-2)}
.oi-ai-wait{color:var(--oi-tone-attention)}.oi-ai-kv{margin:8px 0 0}.oi-ai-kv>div{display:grid;grid-template-columns:90px minmax(0,1fr);gap:8px;border-bottom:1px solid var(--oi-border);padding:3px 0}
.oi-ai-kv dt{color:var(--oi-tone-muted)}.oi-ai-kv dd{margin:0;overflow:hidden;text-overflow:ellipsis}
`;
