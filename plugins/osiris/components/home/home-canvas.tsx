import type { Call } from "../../analytics.ts";
import type { FleetLane } from "../../work/fleet-types.ts";
import type { WorkSurfaceSnapshot } from "../../work/surface-types.ts";
import type { HomeView } from "../../work/home-model.ts";
import type { RangeId } from "../../work/calls-range.ts";
import { formatAge } from "../../work/surface-model.ts";
import { AgentAction } from "../agent-action.tsx";
import { PROVIDERS, PROVIDER_IDS } from "../../work/providers/registry.ts";
import { ptClass } from "../../work/priority-tone.ts";
import { LedgerCard } from "./ledger-card.tsx";

export type { HomeTarget } from "../../shell/routes.ts";
import type { HomeTarget } from "../../shell/routes.ts";
export interface HomeProps {
  view: HomeView; snap: WorkSurfaceSnapshot | null; now: number; range: RangeId; onRange(r: RangeId): void;
  /** The call a Problems row stands for (and its neighbours), or null when it has left the window. */
  callOf(key: string | null): { call: Call; neighbours: Call[] } | null;
  onOpen(t: HomeTarget): void; onOpenCommit(sha: string): void; onAnswer(beadId: string): void; onGoToPane(lane: FleetLane): void;
}

const PV = Object.fromEntries(PROVIDERS.map(p => [p.id, { code: p.chip, cls: p.id === "codex" ? " cx" : "" }])) as Record<FleetLane["runtime"], { code: string; cls: string }>;
const Pv = ({ lane }: { lane: FleetLane }) => <span className={`oi-hm-chip oi-hm-pv${PV[lane.runtime].cls}`}>{PV[lane.runtime].code}·{lane.modelLetter}</span>;
const Open = (p: { onClick(): void; label: string }) => <button type="button" className="oi-hm-open" aria-label={p.label} onClick={p.onClick}>Open ⤢</button>;
const Ask = (p: Parameters<typeof AgentAction>[0]) => <AgentAction {...p} className="oi-hm-ask" />;

function Needs(p: HomeProps) {
  const n = p.view.needs;
  return <section className="oi-hm-quad" aria-label="What needs me">
    <div className="oi-hm-qh"><h2>What needs me</h2><span className="oi-hm-big oi-hm-att oi-hm-glow">{n.count}</span><Open onClick={() => p.onOpen("needs")} label="Open Work: what needs me" /></div>
    {n.decisions.slice(0, 3).map(d => <div key={d.id} className={`oi-hm-dec ${ptClass({ kind: d.kind, priority: p.snap?.issues.find(i => i.id === d.id)?.priority })}`}><span className="oi-hm-l1"><span className="oi-hm-id">{d.shortId}</span><span className="oi-hm-tt" title={d.title}>{d.title}</span>{d.kind === "crit" && <span className="oi-hm-chip oi-hm-fail">crit</span>}</span>
      <span className="oi-hm-l2"><span className={d.waitingMs > 86_400_000 ? "oi-hm-att" : ""}>{formatAge(d.waitingMs)}</span>{d.deferredSessions > 0 ? ` · put off ${d.deferredSessions}×` : ""} · <button type="button" className="oi-hm-link" onClick={() => p.onAnswer(d.id)}>Answer</button>{p.snap && <> · <Ask kind="bead" item={{ snap: p.snap, id: d.id, now: p.now }} /></>}</span></div>)}
    {n.waiting.map(w => <div key={w.lane.key} className="oi-hm-dec"><span className="oi-hm-l1"><span className="oi-hm-wait">{w.lane.waiting === "question" ? "?" : "⏎"}</span><span className="oi-hm-tt">{w.lane.label} is waiting · {w.lane.waiting === "your-turn" ? "your turn" : w.lane.waiting}</span><Pv lane={w.lane} /></span>
      <span className="oi-hm-l2">{w.text} · <button type="button" className="oi-hm-link" onClick={() => p.onGoToPane(w.lane)}>Go to pane</button> · <Ask kind="fleet" item={w.lane} /></span></div>)}
    {n.health.map(h => <div key={h.id} className="oi-hm-dec"><span className="oi-hm-l1"><span className="oi-hm-id">health</span><span className="oi-hm-tt" title={h.why}>{h.title}</span></span><span className="oi-hm-l2">{h.figure} · <Ask kind="health" item={h} /></span></div>)}
    {n.problems.length > 0 && <div className="oi-hm-eyebrow">Problems</div>}
    {n.problems.map(r => { const c = p.callOf(r.callKey); return <div key={r.fingerprint} className="oi-hm-dec"><span className="oi-hm-l1"><span className="oi-hm-id">{r.count}×</span><span className="oi-hm-tt" title={r.title}>{r.title}</span></span>
      <span className="oi-hm-l2">last {r.lastText}{c && <> · <Ask kind="problem" item={c.call} neighbours={c.neighbours} /></>}</span></div>; })}
  </section>;
}

function Running(p: HomeProps) {
  const r = p.view.running;
  return <section className="oi-hm-quad" aria-label="What's running">
    <div className="oi-hm-qh"><h2>What's running</h2><span className="oi-hm-big oi-hm-run oi-hm-glow">{r.live}</span><span className="oi-hm-muted oi-hm-sm">live · +{r.idle} idle</span><Open onClick={() => p.onOpen("agents")} label="Open the fleet" /></div>
    <div className="oi-hm-statline">{r.byProvider.map(b => <div key={b.key}><div className="oi-hm-v">{b.live ?? "n/a"}</div><div className="oi-hm-k">{b.label}</div></div>)}<div><div className="oi-hm-v oi-hm-att">{r.needYou}</div><div className="oi-hm-k">need you</div></div></div>
    {r.rows.map(x => <div key={x.lane.key} className="oi-hm-lrow"><span className="oi-hm-run">●</span><span>{x.lane.label} {x.sub && <span className="oi-hm-muted oi-hm-mono oi-hm-xs">· {x.sub}</span>}</span><span><Pv lane={x.lane} /></span><span className="oi-hm-muted oi-hm-mono oi-hm-sm">{x.lane.beadId ?? ""}</span><span className="oi-hm-r">{x.cost}</span><Ask kind="fleet" item={x.lane} /></div>)}
  </section>;
}

function Cost(p: HomeProps) {
  const c = p.view.cost, seg = (k: string) => c.segments.find(s => s.key === k);
  const H = 56;
  return <section className="oi-hm-quad" aria-label="What did it cost">
    <div className="oi-hm-qh"><h2>What did it cost</h2><span className="oi-hm-big oi-hm-acc oi-hm-glow">{c.totalText}</span><span className="oi-hm-muted oi-hm-sm">{c.windowLabel} · est.</span><Open onClick={() => p.onOpen("cost")} label="Open Calls: Cost" /></div>
    <div className="oi-hm-bars" role="img" aria-label="Fleet activity over the last hour, requests per 5 minutes, stacked by provider (not spend: no per-hour spend is read)">{c.bars.map((b, i) => <span key={i}><i style={{ height: b.claude * H, background: "var(--oi-provider-claude)" }} /><i style={{ height: b.codex * H, background: "var(--oi-provider-codex)" }} /></span>)}</div>
    <div className="oi-hm-legend">{PROVIDER_IDS.map(k => { const s = seg(k); return <span key={k}><i style={{ background: `var(--oi-provider-${k})` }} />{s?.label ?? k} {s?.text ?? "n/a"}{s?.tokensText ? ` · ${s.tokensText}` : ""}</span>; })}</div>
    <div className="oi-hm-gap">{c.models.length > 0 && <div className="oi-hm-eyebrow oi-hm-eb2"><span>Cost by model</span><span className="oi-hm-lpnote">at list price, an estimate</span></div>}{c.models.map(m => <div key={m.model} className="oi-hm-trow"><span>{m.label} <span className="oi-hm-muted oi-hm-mono oi-hm-xs">cache hit {m.hitText}</span></span><span className="oi-hm-r">{m.costText}</span></div>)}</div>
  </section>;
}

function Changed(p: HomeProps) {
  const c = p.view.changed, tone = (code: string) => code === "A" || code === "?" ? "oi-hm-ok" : "oi-hm-att";
  return <section className="oi-hm-quad" aria-label="What changed">
    <div className="oi-hm-qh"><h2>What changed</h2><span className="oi-hm-big">{c.uncommitted}</span><span className="oi-hm-muted oi-hm-sm">uncommitted · {c.landedCount} commit{c.landedCount === 1 ? "" : "s"} today</span><Open onClick={() => p.onOpen("changes")} label="Open History: changes" /></div>
    {c.files.map(f => <button key={f.path} type="button" className="oi-hm-chg oi-hm-full" onClick={() => p.onOpen("changes")}><span className={`oi-hm-cd ${tone(f.code)}`}>{f.code}</span><span className="oi-hm-p">{f.path}</span><span className="oi-hm-muted oi-hm-mono oi-hm-xs">{f.state}</span></button>)}
    <div className="oi-hm-eyebrow oi-hm-eb2">Landed today</div>
    {c.landed.map(l => <button key={l.sha} type="button" className="oi-hm-chg oi-hm-full" title="Open this commit in History" onClick={() => p.onOpenCommit(l.sha)}><span className="oi-hm-mono oi-hm-muted oi-hm-sm">{l.sha.slice(0, 7)}</span><span className="oi-hm-tt">{l.subject}</span>{l.beads.map(b => <span key={b} className="oi-hm-chip oi-hm-idc">{b}</span>)}</button>)}
  </section>;
}

const TABS: readonly { id: RangeId; label: string }[] = [{ id: "today", label: "Today" }, { id: "7d", label: "This week" }];
export function HomeCanvas(p: HomeProps) {
  return <div className="oi-hm" aria-label="Home">
    <div className="oi-hm-ctabs" role="tablist">{TABS.map(t => <button key={t.id} type="button" role="tab" className="oi-hm-ct" aria-selected={p.range === t.id} onClick={() => p.onRange(t.id)}>{t.label}</button>)}</div>
    <div className="oi-hm-body"><div className="oi-hm-grid"><Needs {...p} /><Running {...p} /><Cost {...p} /><Changed {...p} /><LedgerCard view={p.view.ledger} /></div></div>
  </div>;
}

// Ported from docs/design/2026-10-07-osiris-dashboard-harmony.html (the Home section). Mockup var -> theme token: --border -> --oi-border, --muted -> --oi-tone-muted,
// --text -> --oi-text, --text2 -> --oi-text-2, --head/--mono -> --oi-font-head/mono, --running/--attention/--success/--failure/--info -> --oi-tone-*, --p-* -> --oi-provider-*.
export const homeStyles = `
.oi-hm{container-type:inline-size;display:flex;flex-direction:column;height:100%;min-height:0;color:var(--oi-text);font-size:13px;line-height:1.4}
.oi-hm button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}.oi-hm button:focus-visible{outline:2px solid var(--oi-focus);outline-offset:1px}
.oi-hm-ctabs{display:flex;align-items:center;gap:2px;height:36px;padding:0 10px;border-bottom:1px solid var(--oi-border-strong);flex:none}
.oi-hm-ct{height:36px;padding:0 10px!important;font-size:12.5px;color:var(--oi-tone-muted)!important}.oi-hm-ct:hover{color:var(--oi-text)!important}.oi-hm-ct[aria-selected="true"]{color:var(--oi-text)!important;box-shadow:var(--oi-tab-underline)}
.oi-hm-body{flex:1;min-height:0;overflow:auto;padding:14px 16px}
.oi-hm-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:minmax(260px,auto);gap:0;border:1px solid var(--oi-border);border-radius:2px}
.oi-hm-quad{padding:14px 16px;min-width:0;border-right:1px solid var(--oi-border);border-bottom:1px solid var(--oi-border)}
.oi-hm-quad:nth-child(2n){border-right:0}.oi-hm-quad:nth-child(n+3){border-bottom:0}
.oi-hm-qh{display:flex;align-items:baseline;flex-wrap:wrap;gap:10px;margin-bottom:10px}
.oi-hm-qh h2{margin:0;font:600 13px var(--oi-font-head);letter-spacing:.02em}
.oi-hm-open{margin-left:auto;font:11px var(--oi-font-mono)!important;color:var(--oi-tone-muted)!important;padding:2px 6px!important;border-radius:4px}.oi-hm-open:hover{color:var(--oi-text)!important;background:var(--oi-hover)!important}
.oi-hm-big{font:800 40px/1 var(--oi-font-mono);font-variant-numeric:tabular-nums}
.oi-hm-glow{text-shadow:var(--oi-glow)}.oi-hm-att{color:var(--oi-tone-attention)}.oi-hm-run{color:var(--oi-tone-running)}.oi-hm-acc{color:var(--oi-accent)}.oi-hm-ok{color:var(--oi-tone-success)}.oi-hm-fail{--c:var(--oi-tone-failure)}
.oi-hm-muted{color:var(--oi-tone-muted)}.oi-hm-mono{font-family:var(--oi-font-mono)}.oi-hm-sm{font-size:11px}.oi-hm-xs{font-size:10.5px}
.oi-hm-chip{display:inline-flex;align-items:center;gap:4px;padding:0 6px;border-radius:9px;font:600 10.5px/17px var(--oi-font-mono);white-space:nowrap;background:color-mix(in srgb,var(--c,var(--oi-tone-muted)) 16%,transparent);color:var(--c,var(--oi-text-2))}
.oi-hm-pv{--c:var(--oi-provider-claude)}.oi-hm-pv.cx{--c:var(--oi-provider-codex)}.oi-hm-idc{--c:var(--oi-tone-info)}
.oi-hm-dec{display:flex;flex-direction:column;gap:1px;width:100%;padding:6px 8px;border-bottom:1px solid var(--oi-border);text-align:left;border-radius:3px}.oi-hm-dec:hover{background:var(--oi-hover)}
.oi-hm-l1{display:flex;gap:6px;align-items:baseline;min-width:0}
.oi-hm-id{font:10.5px var(--oi-font-mono);color:var(--oi-tone-muted);flex:none}
.oi-hm-tt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.oi-hm-l2{font:10.5px var(--oi-font-mono);color:var(--oi-tone-muted)}
.oi-hm-wait{color:var(--oi-tone-attention);font:600 10.5px var(--oi-font-mono)}
.oi-hm-link,.oi-hm-ask{color:var(--oi-tone-info)!important;font:10.5px var(--oi-font-mono)!important;background:none!important;border:0!important;padding:0!important}.oi-hm-link:hover,.oi-hm-ask:hover{text-decoration:underline}
.oi-hm-eyebrow{font:600 10px var(--oi-font-head);letter-spacing:.09em;text-transform:uppercase;color:var(--oi-tone-muted);display:flex;align-items:center;gap:8px;margin:10px 0 4px}
.oi-hm-statline{display:flex;flex-wrap:wrap;gap:0;margin-bottom:10px}.oi-hm-statline>div{padding:0 14px;border-left:1px solid var(--oi-border)}.oi-hm-statline>div:first-child{padding-left:0;border-left:0}
.oi-hm-v{font:700 18px/1.1 var(--oi-font-mono);font-variant-numeric:tabular-nums}
.oi-hm-k{font:600 9.5px var(--oi-font-head);letter-spacing:.08em;text-transform:uppercase;color:var(--oi-tone-muted)}
.oi-hm-lrow{display:grid;grid-template-columns:14px minmax(0,1.6fr) 54px minmax(0,1fr) 62px auto;gap:8px;align-items:center;height:26px;border-bottom:1px solid var(--oi-border);font-size:12px}
.oi-hm-lrow>*{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-hm-r{text-align:right;font-family:var(--oi-font-mono);font-variant-numeric:tabular-nums}
.oi-hm-bars{display:flex;align-items:flex-end;gap:3px;height:70px;margin:6px 0 4px}.oi-hm-bars span{flex:1;display:flex;flex-direction:column-reverse;min-width:0}.oi-hm-bars i{display:block}
.oi-hm-legend{display:flex;flex-wrap:wrap;gap:12px;font:10.5px var(--oi-font-mono);color:var(--oi-tone-muted)}.oi-hm-legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px}
.oi-hm-gap{margin-top:8px}
.oi-hm-trow{display:grid;grid-template-columns:minmax(0,1fr) 90px;gap:8px;height:24px;align-items:center;border-bottom:1px solid var(--oi-border);font-size:12px}
.oi-hm-chg{display:flex;gap:8px;align-items:center;height:24px;border-bottom:1px solid var(--oi-border);font-size:12px;min-width:0}.oi-hm-full{width:100%}
.oi-hm-cd{font:700 11px var(--oi-font-mono);width:12px;text-align:center}
.oi-hm-p{font-family:var(--oi-font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:left}
.oi-hm-eb2{margin:10px 0 4px}.oi-hm-lpnote{margin-left:auto;white-space:nowrap;text-transform:none;letter-spacing:0;font:10.5px var(--oi-font-mono);color:var(--oi-tone-muted)}
.oi-hm-wide{grid-column:1/-1;border-right:0!important;border-top:1px solid var(--oi-border);border-bottom:0!important}
@container (max-width:820px){.oi-hm-grid{grid-template-columns:minmax(0,1fr)}.oi-hm-quad{border-right:0!important;border-bottom:1px solid var(--oi-border)!important}}
`;
