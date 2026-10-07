import type { LedgerView } from "../../work/home-model.ts";
import { AgentAction } from "../agent-action.tsx";

/** "Fleet incidents": the owner's run ledger, read-only, as a full-width section of the Home grid in the same quadrant language (head, big count, dec rows). */
export function LedgerCard(p: { view: LedgerView }) {
  const v = p.view, c = v.counts;
  return <section className="oi-hm-quad oi-hm-wide" aria-label="Fleet incidents">
    <div className="oi-hm-qh"><h2>Fleet incidents</h2>{v.state === "ok" && <><span className="oi-hm-big oi-hm-att oi-hm-glow">{c.open}</span><span className="oi-hm-muted oi-hm-sm">open · {c.pinned} pinned · {c.closed} closed</span></>}</div>
    {v.state === "missing" && <p className="oi-hm-muted oi-hm-sm">No run ledger in this repo.</p>}
    {v.state === "invalid" && <p className="oi-hm-muted oi-hm-sm" role="status">The run ledger could not be read ({v.reason}). Nothing was changed.</p>}
    {v.state === "ok" && v.open.length === 0 && <p className="oi-hm-muted oi-hm-sm">No open incidents.</p>}
    {v.state === "ok" && v.open.map(({ incident: i, age }) => <div key={i.id} className="oi-hm-dec"><span className="oi-hm-l1"><span className="oi-hm-id">{i.id}</span><span className="oi-hm-tt" title={i.title}>{i.title}</span></span>
      <span className="oi-hm-l2">{age}{i.rootCause ? ` · root cause: ${i.rootCause}` : ""} · <AgentAction kind="incident" item={i} className="oi-hm-ask" /></span></div>)}
    {v.state === "ok" && v.dropped > 0 && <p className="oi-hm-muted oi-hm-xs">{v.dropped} entr{v.dropped === 1 ? "y was" : "ies were"} skipped (no id, title or known status).</p>}
  </section>;
}
