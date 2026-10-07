import { useContext, useId, useMemo, useState } from "react";
import { FleetFocusContext } from "./fleet-count.tsx";
import { buildFlowModel, laneRefsOf } from "../../work/message-flow-model.ts";
import type { FlagKind, FlowFlag } from "../../work/message-flow-model.ts";
import type { FleetSnapshot } from "../../work/fleet-types.ts";
import { cleanText } from "../../work/sanitize.ts";

type Props = { fleet?: FleetSnapshot | null; now: number; onSelectLane?: (key: string) => void };
const FLAG_WORDS: Record<FlagKind, { label: string; tip: (f: FlowFlag) => string }> = {
  "lost-handback": { label: "Lost report", tip: f => `${f.other ?? "A helper"} finished but its report never reached ${f.lane}.` },
  "unacknowledged-done": { label: "No reply", tip: f => `${f.other ?? "A lane"} said done to ${f.lane} and got no answer within 15 minutes.` },
  "idle-unanswered": { label: "Idle, unread", tip: f => `${f.lane} has been idle for 5 minutes or more with a message from ${f.other ?? "another lane"} it has not answered.` },
  "unknown-recipient": { label: "Wrong address", tip: f => `${f.lane} sent a message to "${f.other ?? "?"}", which is not a lane on this machine.` },
};
const ago = (now: number, at: number): string => { const s = Math.max(0, Math.round((now - at) / 1000)); return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 129_600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86_400)}d`; };
const t = (s: string | null, max = 48) => cleanText(s ?? "", max);

/** Flow (who -> whom), Inbox (per lane, unanswered marked), Flags (misroutes and stalls). Read only: no send, no reply. */
export function MessageFlowPanel({ fleet, now, onSelectLane }: Props) {
  const events = fleet?.messages;
  const model = useMemo(() => buildFlowModel(events ?? [], laneRefsOf(fleet), now), [events, fleet?.lanes, fleet?.names, now]);
  const uid = useId();
  const focusLane = useContext(FleetFocusContext);
  const [pick, setPick] = useState<string | null>(null);
  const chosen = model.inbox.find(l => l.name === pick) ?? model.inbox.find(l => l.unanswered > 0) ?? model.inbox[0] ?? null;
  if (!events || !events.length) return <section className="oi-mf" aria-label="Message flow"><p className="oi-mf-empty">No messages yet</p></section>;
  return <section className="oi-mf" aria-label="Message flow">
    <h3 className="oi-mf-h">Flags <b>{model.flags.length}</b></h3>
    {model.flags.length === 0 ? <p className="oi-mf-empty">All clear</p> : <ul className="oi-mf-list">
      {model.flags.slice(0, 20).map((f, i) => <li key={`${f.kind}-${f.at}-${i}`} className={`oi-mf-flag oi-mf-${f.kind}${f.laneKey && focusLane ? " oi-mf-link" : ""}`} tabIndex={0} title={`${FLAG_WORDS[f.kind].tip(f)}${f.laneKey && focusLane ? " Click to show this agent." : ""}`} aria-describedby={`${uid}-f${i}`}
        {...(f.laneKey && focusLane ? { role: "button", onClick: () => focusLane(f.laneKey as string), onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); focusLane(f.laneKey as string); } } } : {})}>
        <span id={`${uid}-f${i}`} className="oi-mf-sr">{FLAG_WORDS[f.kind].tip(f)}</span><span className="oi-mf-tag">{FLAG_WORDS[f.kind].label}</span><span className="oi-mf-who">{t(f.lane)}</span><span className="oi-mf-dim">{f.other ? t(f.other) : ""}</span><span className="oi-mf-time">{ago(now, f.at)}</span>
      </li>)}
    </ul>}
    <h3 className="oi-mf-h">Flow <b>{model.edges.length}</b></h3>
    <ul className="oi-mf-list oi-mf-scroll">
      {model.edges.slice(0, 40).map(e => <li key={`${e.from}>${e.to}`} className="oi-mf-edge" title={`${e.from} to ${e.to}: ${e.hour} in the last hour, ${e.all} in all`}>
        <span className="oi-mf-who">{t(e.from)}</span><span className="oi-mf-arrow" aria-hidden="true">{"→"}</span><span className="oi-mf-who">{t(e.to)}</span>
        {e.protocol && <span className={`oi-mf-badge oi-mf-p-${e.protocol.toLowerCase()}`}>{e.protocol}</span>}
        <span className="oi-mf-count">{e.hour}/{e.all}</span><span className="oi-mf-time">{ago(now, e.lastAt)}</span>
      </li>)}
    </ul>
    <h3 className="oi-mf-h">Inbox <b>{model.inbox.reduce((n, l) => n + l.unanswered, 0)}</b></h3>
    <div className="oi-mf-lanes" role="group" aria-label="Pick a lane">
      {model.inbox.slice(0, 30).map(l => <button key={l.name} type="button" className={`oi-mf-lane${chosen?.name === l.name ? " oi-mf-lane-on" : ""}`} aria-pressed={chosen?.name === l.name} onClick={() => setPick(l.name)} title={`${l.total} received, ${l.unanswered} unanswered`}>
        {t(l.name, 24)}{l.unanswered > 0 && <b>{l.unanswered}</b>}
      </button>)}
    </div>
    {chosen && <ul className="oi-mf-list oi-mf-scroll" aria-label={`Inbox of ${t(chosen.name)}`}>
      {chosen.items.map((i, n) => <li key={`${i.at}-${n}`} className={`oi-mf-item${i.answered ? "" : " oi-mf-open"}`} title={i.answered ? "Answered" : "Not answered yet"}>
        <span className="oi-mf-who">{t(i.from)}</span>{i.protocol && <span className={`oi-mf-badge oi-mf-p-${i.protocol.toLowerCase()}`}>{i.protocol}</span>}
        <span className="oi-mf-sum">{i.kind === "handback-lost" ? "Report lost" : i.kind === "handback" ? "Report in" : t(i.summary, 80)}</span><span className="oi-mf-time">{ago(now, i.at)}</span>
      </li>)}
      {chosen.key && onSelectLane && <li><button type="button" className="oi-mf-open-lane" onClick={() => onSelectLane(chosen.key as string)}>Open lane</button></li>}
    </ul>}
  </section>;
}

export const messageFlowStyles = `
.oi-mf{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--oi-text);min-height:0}
.oi-mf-h{display:flex;gap:6px;align-items:baseline;margin:8px 0 2px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--oi-muted)}
.oi-mf-h b{font-variant-numeric:tabular-nums;color:var(--oi-text)}
.oi-mf-empty{margin:4px 0;color:var(--oi-muted)}
.oi-mf-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.oi-mf-scroll{max-height:220px;overflow:auto}
.oi-mf-flag,.oi-mf-edge,.oi-mf-item{display:flex;align-items:center;gap:8px;min-height:24px;border-bottom:1px solid color-mix(in srgb,var(--oi-border) 50%,transparent)}
.oi-mf-flag:focus-visible,.oi-mf-lane:focus-visible,.oi-mf-open-lane:focus-visible{outline:2px solid var(--oi-accent);outline-offset:1px}
.oi-mf-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.oi-mf-flag{position:relative}
.oi-mf-link{cursor:pointer}
.oi-mf-link:hover{background:var(--oi-selected)}
.oi-mf-who{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:20ch}
.oi-mf-dim,.oi-mf-time,.oi-mf-count{color:var(--oi-muted);font-variant-numeric:tabular-nums}
.oi-mf-time{margin-left:auto}
.oi-mf-sum{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--oi-muted)}
.oi-mf-arrow{color:var(--oi-muted)}
.oi-mf-tag{font-weight:700;color:var(--oi-tone-attention)}
.oi-mf-lost-handback .oi-mf-tag,.oi-mf-unknown-recipient .oi-mf-tag{color:var(--oi-tone-failure)}
.oi-mf-badge{padding:0 5px;border-radius:4px;font-size:10px;font-weight:700;color:var(--oi-bg);background:var(--oi-tone-muted)}
.oi-mf-p-done,.oi-mf-p-landable{background:var(--oi-tone-running)}
.oi-mf-p-blocked{background:var(--oi-tone-attention)}
.oi-mf-lanes{display:flex;flex-wrap:wrap;gap:4px;max-height:84px;overflow:auto}
.oi-mf-lane,.oi-mf-open-lane{padding:1px 8px;border:1px solid var(--oi-border);border-radius:999px;background:transparent;color:var(--oi-text);font:inherit;cursor:pointer}
.oi-mf-lane b{margin-left:4px;color:var(--oi-tone-attention)}
.oi-mf-lane-on{background:var(--oi-selected);border-color:var(--oi-accent)}
.oi-mf-open .oi-mf-who{font-weight:700}
.oi-mf-open{border-left:2px solid var(--oi-tone-attention);padding-left:6px}
@media (prefers-reduced-motion:reduce){.oi-mf-lane,.oi-mf-open-lane{transition:none}}
`;
