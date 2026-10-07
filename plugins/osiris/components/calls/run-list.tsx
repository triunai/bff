import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { callKey, type Call } from "../../analytics.ts";
import { CALL_PAGE_SIZE, humanDuration } from "../../live-observer.ts";
import { fleetIndex, identityOf } from "../../work/call-identity.ts";
import { foldRows } from "../../work/call-runs.ts";
import { callCost, runCost, usageText, usdPerCallText } from "../../work/call-cost.ts";
import type { CallRun } from "../../work/call-runs.ts";
import type { FleetLane, FleetName } from "../../work/fleet-types.ts";
import { toneForStatus } from "../../ui-tokens.ts";

export type RunListProps = {
  /** Newest-first or not: the list orders itself. */
  calls: readonly Call[];
  lanes?: readonly FleetLane[];
  names?: readonly FleetName[];
  now: number;
  selectedKey?: string | null;
  onSelect: (callKey: string) => void;
  /** Rows (a run is one row), not calls, per page. Default CALL_PAGE_SIZE. */
  page?: number;
  pageSize?: number;
  /** Draw one call yourself (the app's own row); the default row shows tool, status, duration. */
  renderCall?: (c: Call) => ReactNode;
};

/** Tone of a run: its worst call, so a failure stays visible while folded. */
const runTone = (r: CallRun) => r.failed > 0 ? "failure" : (r.statuses.cancelled || r.statuses.unknown) ? "attention" : r.statuses.running ? "running" : "success";

/** The All-calls list with runs of same-tool calls folded into one expandable row (Kimi Code's tool stack, as a list). */
export function RunList(p: RunListProps) {
  const index = useMemo(() => fleetIndex(p.lanes, p.names), [p.lanes, p.names]);
  const rows = useMemo(() => foldRows(p.calls, { now: p.now }), [p.calls, p.now]);
  const byKey = useMemo(() => new Map(p.calls.map(c => [callKey(c), c])), [p.calls]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // The run holding the selected call opens by itself; a manual fold of it is remembered until the selection moves.
  const selRun = p.selectedKey ? rows.find(r => r.kind === "run" && r.run.callKeys.includes(p.selectedKey!)) : undefined;
  const selRunKey = selRun && selRun.kind === "run" ? selRun.run.key : null;
  const [shut, setShut] = useState<{ sel: string | null; key: string | null }>({ sel: null, key: null });
  const size = p.pageSize ?? CALL_PAGE_SIZE, page = p.page ?? 0;
  const shown = rows.slice(page * size, (page + 1) * size);
  const isOpenRun = (k: string) => open.has(k) || (k === selRunKey && !(shut.sel === p.selectedKey && shut.key === k));
  const toggle = (k: string) => { if (k === selRunKey) setShut(isOpenRun(k) ? { sel: p.selectedKey ?? null, key: k } : { sel: null, key: null }); const wasOpen = isOpenRun(k); setOpen(prev => { const n = new Set(prev); if (wasOpen) n.delete(k); else n.add(k); return n; }); };
  const single = (c: Call) => p.renderCall ? p.renderCall(c) : <button key={callKey(c)} type="button" className={`oi-rl-call oi-tone-${toneForStatus(c.status)}${p.selectedKey === callKey(c) ? " is-sel" : ""}`} onClick={() => p.onSelect(callKey(c))}>
    <strong>{c.tool}</strong><span>{c.status}</span><span>{humanDuration(c.durationMs)}</span>
    {c.usage && <span className="oi-rl-cost" title={usageText(callCost(c).tokens)}>{usdPerCallText(callCost(c).usd)}</span>}
  </button>;
  return <div className="oi-rl" role="list" aria-label="Calls, runs folded">
    {shown.map(r => {
      if (r.kind === "call") return <div role="listitem" key={callKey(r.call)}>{single(r.call)}</div>;
      const run = r.run, cost = runCost(run.callKeys.map(k => byKey.get(k)).filter((c): c is Call => !!c)), isOpen = isOpenRun(run.key), hasSel = !!p.selectedKey && run.callKeys.includes(p.selectedKey), lane = identityOf({ sessionId: run.lane, provider: byKey.get(run.callKeys[0])?.provider ?? "" }, index).label;
      return <div role="listitem" key={run.key} className="oi-rl-run">
        <button type="button" className={`oi-rl-head oi-tone-${runTone(run)}${hasSel ? " is-sel" : ""}`} aria-expanded={isOpen} title={`${run.title}. Click to ${isOpen ? "fold" : "open"} the run.`} aria-label={`${run.title}, ${lane}`} onClick={() => toggle(run.key)}>
          <span className="oi-rl-caret" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
          <strong>{run.tool}</strong>
          <span className="oi-rl-count">×{run.count}</span>
          <span className="oi-rl-lane">{lane}</span>
          <span className="oi-rl-wall" title="Wall time from the first call to the last">{run.wall < 1000 ? "<1s" : humanDuration(run.wall)}</span>
          {cost.tokens && <span className="oi-rl-cost" title={`${usageText(cost.tokens)}${cost.complete ? "" : `. ${cost.uncounted} call(s) in this run recorded no usage and are not counted`}. Estimated from public list prices.`}>{cost.complete || cost.usd === null ? "" : "≥ "}{usdPerCallText(cost.usd)}</span>}
          {run.failed > 0 && <span className="oi-rl-failed" title="Errors and denials inside this run">✕ {run.failed}</span>}
        </button>
        {isOpen && <div className="oi-rl-body">{run.callKeys.map(k => byKey.get(k)).filter((c): c is Call => !!c).map(single)}</div>}
      </div>;
    })}
  </div>;
}

export const runListStyles = `
.oi-rl{display:flex;flex-direction:column;min-width:0}
.oi-rl-run{border-bottom:1px solid color-mix(in srgb,var(--oi-border) 50%,transparent)}
.oi-rl-head,.oi-rl-call{display:flex;align-items:center;gap:8px;width:100%;min-width:0;border:0;background:transparent;color:var(--oi-text);font:inherit;font-size:12px;text-align:left;padding:4px 8px;cursor:pointer}
.oi-rl-head:hover,.oi-rl-call:hover{background:var(--oi-hover)}
.oi-rl-head:focus-visible,.oi-rl-call:focus-visible{outline:2px solid var(--oi-accent);outline-offset:-2px}
.oi-rl-head{border-left:3px solid var(--oi-tone-success)}
.oi-rl-head.oi-tone-failure{border-left-color:var(--oi-tone-failure)}
.oi-rl-head.oi-tone-attention{border-left-color:var(--oi-tone-attention)}
.oi-rl-head.oi-tone-running{border-left-color:var(--oi-tone-running)}
.oi-rl-caret{color:var(--oi-muted);width:10px}
.oi-rl-count{font-variant-numeric:tabular-nums;font-weight:700}
.oi-rl-lane{color:var(--oi-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.oi-rl-cost{color:var(--oi-muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.oi-rl-wall{color:var(--oi-muted);font-variant-numeric:tabular-nums}
.oi-rl-failed{color:var(--oi-tone-failure);font-weight:700}
.oi-rl-body{padding-left:18px;border-left:1px solid var(--oi-border);margin-left:10px}
.oi-rl-call{border-bottom:1px solid color-mix(in srgb,var(--oi-border) 35%,transparent)}
.oi-rl-call.is-sel,.oi-rl-head.is-sel{background:var(--oi-selected)}
`;
