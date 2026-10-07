import { capitalise, firstUse, termLabel } from "../../work/glossary.ts";
import { demoTitle, useDemoOn } from "../../demo/client.ts";
import { boardCards, formatAge, laneLabel, linkText, plainTitle, shortId } from "../../work/surface-model.ts";
import type { BeadLink, PaneTail, WorkSurfaceSnapshot } from "../../work/surface-types.ts";
import { dispatchGuard } from "../../work/dispatch-guard.ts";
import { AskAgentButton, beadContext } from "../../work/ask-agent/index.ts";
import { anomalyTerm, anomalyText, dispatchBlockReason, SANDBOX_HINT } from "../../work/ui-text.ts";

export type BeadInspectorProps = { snap: WorkSurfaceSnapshot; now: number; id: string; tail: PaneTail | null; tailError: string | null; onSelect(id: string): void; onOpenDispatch(): void; sandboxHint?: boolean };

function Links(p: { label: string; items: BeadLink[]; onSelect(id: string): void }) {
  return <div className="oi-bi-kv"><span className="oi-bi-k">{p.label}</span>
    {p.items.length === 0 ? <span className="oi-bi-v">none</span>
      : <span className="oi-bi-v oi-bi-links">{p.items.map(l => <button type="button" key={l.id} className="oi-bi-link" title={`${l.title} (${l.status})`} onClick={() => p.onSelect(l.id)}>{shortId(l.id)} {l.title}</button>)}</span>}
  </div>;
}

/** Right-pane bead inspector: details, plain-English anomalies, blockers (clickable), the Herdr terminal tail and the assign button. */
export function BeadInspector(p: BeadInspectorProps) {
  const demo = useDemoOn();
  const issue = p.snap.issues.find(i => i.id === p.id);
  if (!issue) return <div className="oi-bi"><div className="oi-bi-empty">That {termLabel("bead")} is no longer in the tracker.</div></div>;
  const card = boardCards(p.snap, p.now).find(c => c.id === p.id) ?? null;
  const node = p.snap.tree.flatMap(r => r.nodes).find(n => n.id === p.id && n.agent) ?? p.snap.tree.flatMap(r => r.nodes).find(n => n.id === p.id) ?? null;
  const anomalies = node?.anomalies ?? [];
  const pane = node?.agent ?? null;
  const created = Date.parse(issue.createdAt);
  const blockReason = dispatchBlockReason(p.snap, p.id, p.now);
  const canDispatch = blockReason === null;
  const tip = firstUse(); // the first place each term appears in this inspector carries its definition
  // the same lane names as the Board; a closed item has no card, so it says so
  const statusName = card ? laneLabel(card.lane) : issue.status === "closed" ? "Closed" : issue.status.replace("_", " ");
  return <div className="oi-bi">
    <h3 className="oi-bi-title" title={issue.title}>{plainTitle(issue.title)}</h3>
    <div className="oi-bi-full"><code>{issue.id}</code></div>
    <AskAgentButton className="oi-bi-ask" ask={() => beadContext(p.snap, p.id, p.now)} guard={() => dispatchGuard(p.snap, p.id, p.now)} />
    <div className="oi-bi-kv"><span className="oi-bi-k">Status</span><span className="oi-bi-v">{statusName} · <span title={`Priority ${issue.priority} (lower numbers are more urgent)`}>priority {issue.priority}</span></span></div>
    <div className="oi-bi-kv"><span className="oi-bi-k" title={tip("claim")}>Claimed by</span><span className="oi-bi-v">{issue.assignee ?? "nobody yet"}</span></div>
    <div className="oi-bi-kv"><span className="oi-bi-k">Age</span><span className="oi-bi-v">{Number.isFinite(created) ? `${formatAge(Math.max(0, p.now - created))} old` : "unknown"}</span></div>
    <div className="oi-bi-kv"><span className="oi-bi-k">Labels</span><span className="oi-bi-v">{issue.labels.length ? <span className="oi-bi-chips">{issue.labels.map(l => <span key={l} className="oi-bi-chip">{l}</span>)}</span> : "none"}</span></div>
    {card && <div className="oi-bi-sub">{linkText(card)}</div>}
    <Links label="Waiting on" items={card?.blockedBy ?? []} onSelect={p.onSelect} />
    <Links label="Unblocks" items={card?.unblocks ?? []} onSelect={p.onSelect} />
    <div className="oi-bi-kv"><span className="oi-bi-k" title={tip("pane")}>{capitalise(termLabel("pane"))}</span><span className="oi-bi-v">{pane ? [pane.title ?? pane.paneId, pane.state && `(${pane.state})`].filter(Boolean).join(" ") : `no ${termLabel("pane")} attached`}</span></div>
    {anomalies.length > 0 && <ul className="oi-bi-warns" aria-label="Problems">{anomalies.map(a => { const t = anomalyTerm(a); return <li key={a} title={t ? tip(t) : undefined}>⚠ {anomalyText(a)}</li>; })}</ul>}
    <div className="oi-bi-tailh">{capitalise(termLabel("pane"))} output</div>
    {p.tailError ? <div className="oi-bi-tail oi-bi-err" role="alert">{p.tailError}</div>
      : p.tail && p.tail.lines.length > 0 ? <pre className="oi-bi-tail" aria-label={`Last lines from the ${termLabel("pane")}`}>{p.tail.lines.join("\n")}{p.tail.truncated ? "\n…" : ""}</pre>
      : <div className="oi-bi-tail oi-bi-none">{pane ? "No output yet." : `No ${termLabel("pane")} attached.`}</div>}
    <button type="button" className="oi-bi-dispatch" disabled={!canDispatch || demo} title={demoTitle(demo, blockReason ?? tip("dispatch"))} onClick={p.onOpenDispatch}>{capitalise(termLabel("dispatch"))}…</button>
    {blockReason && <div className="oi-bi-why">{blockReason}</div>}
    {p.sandboxHint && canDispatch && <div className="oi-bi-why">{SANDBOX_HINT}</div>}
  </div>;
}

export const beadInspectorStyles = `
.oi-bi{display:flex;flex-direction:column;gap:3px;min-width:0;padding:8px;font-size:11px;color:var(--oi-text)}
.oi-bi-empty{color:var(--oi-muted)}
.oi-bi-title{margin:0;font-size:13px;overflow-wrap:anywhere}
.oi-bi-full{color:var(--oi-muted);font-size:10px;overflow-wrap:anywhere}
.oi-bi-chips{display:flex;flex-wrap:wrap;gap:3px}
.oi-bi-chip{padding:0 6px;font-size:9px;line-height:15px;border-radius:8px;color:var(--oi-muted);border:1px solid var(--oi-border-strong,var(--oi-border))}
.oi-bi-sub{color:var(--oi-muted);font-size:10px}
.oi-bi-kv{display:flex;gap:6px;min-width:0}
.oi-bi-k{flex:none;width:68px;color:var(--oi-muted)}
.oi-bi-v{min-width:0;overflow-wrap:anywhere}
.oi-bi-links{display:flex;flex-direction:column;align-items:flex-start}
.oi-bi-link{padding:0;font:inherit;color:var(--oi-tone-info);text-align:left;background:transparent;border:0;cursor:pointer;overflow-wrap:anywhere}
.oi-bi-link:hover{text-decoration:underline}
.oi-bi-warns{margin:0;padding:0;list-style:none;color:var(--oi-tone-attention)}
.oi-bi-tailh{margin-top:4px;font-size:10px;letter-spacing:.05em;color:var(--oi-muted)}
.oi-bi-tail{margin:0;max-height:180px;overflow:auto;padding:4px 6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;white-space:pre-wrap;overflow-wrap:anywhere;border-left:2px solid var(--oi-border-strong,var(--oi-border));background:var(--oi-input,transparent)}
.oi-bi-none{color:var(--oi-muted);font-family:inherit}
.oi-bi-why{color:var(--oi-muted);font-size:10px}
.oi-bi-err{color:var(--oi-tone-failure)}
.oi-bi-ask{align-self:flex-start;margin:2px 0}
.oi-bi-dispatch{align-self:flex-start;margin-top:6px;padding:3px 10px;font:inherit;color:var(--oi-text);background:var(--oi-selected);border:1px solid var(--oi-tone-info);border-radius:4px;cursor:pointer}
.oi-bi-dispatch:disabled{color:var(--oi-muted);background:transparent;border-color:var(--oi-border);cursor:not-allowed}
`;
