import { useMemo, useState } from "react";
import { badge, daysSince, HORIZON_LABEL, HORIZONS, outcomeRollups, recentlyShipped, topUnknowns, type Outcome, type SpineV2, type Work } from "../../projects.ts";
import { cardPills, modeColumn, modeColumns, modeLabel, nextAction, problemLine, projectHealth, stripeOf, type BoardMode } from "../../projects-board.ts";
import { MenuSelect } from "../ui/menu-select.tsx";
import { TONE_WORD } from "./portfolio.tsx";

export type ProjectSelection = { kind: "card"; project: string; work: Work } | { kind: "outcome"; project: string; outcome: Outcome } | null;
const dash = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));
const TABS = [["board", "Board"], ["outcomes", "Outcomes"], ["graph", "Graph"], ["activity", "Activity"]] as const;
type Tab = (typeof TABS)[number][0];
const agoText = (date: string | null, today: string) => { const d = daysSince(date, today); return d === null ? "date unknown" : d <= 0 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`; };

/** One project: Board (Plan | Execution) · Outcomes · Graph · Activity, with a collapsible PROJECT CONTEXT drawer (closed by default). */
export function Board(p: { spine: SpineV2; today: string; dim: string | null; setDim(v: string | null): void; selection: ProjectSelection; onSelect(s: ProjectSelection): void; onBack(): void }) {
  const s = p.spine, h = projectHealth(s, p.today), id = s.project.id;
  const [tab, setTab] = useState<Tab>("board"), [mode, setMode] = useState<BoardMode>("plan"), [level, setLevel] = useState("all"), [ctx, setCtx] = useState(false);
  const rollups = useMemo(() => outcomeRollups(s), [s]);
  const selCard = p.selection?.kind === "card" && p.selection.project === id ? p.selection.work.id : null;
  const selOut = p.selection?.kind === "outcome" && p.selection.project === id ? p.selection.outcome.id : null;
  const pickOutcome = (o: Outcome) => { const off = p.dim === o.id; p.setDim(off ? null : o.id); p.onSelect(off ? null : { kind: "outcome", project: id, outcome: o }); };
  const items = s.work.filter(w => (level === "all" || (w.horizon || "short") === level) && (p.dim === null || w.outcome === p.dim));
  const cols = modeColumns(mode);
  const hidden = mode === "execution" ? items.filter(w => modeColumn(mode, w) === null).length : 0;
  const shipped = recentlyShipped(s), unknowns = topUnknowns(s);

  const board = (
    <>
      <div className="oi-pj-bar2">
        <div className="oi-pj-seg" role="group" aria-label="Board mode">
          <button type="button" aria-pressed={mode === "plan"} title="Plan: when it should happen (Now, Next, Later, Waiting, Done)" onClick={() => setMode("plan")}>Plan</button>
          <button type="button" aria-pressed={mode === "execution"} title="Execution: what state the work is in (Ready, Active, Blocked, Review, Done)" onClick={() => setMode("execution")}>Execution</button>
        </div>
        <label className="oi-pj-flt">Level <MenuSelect value={level} onChange={setLevel} ariaLabel="Filter by level" options={[{ value: "all", label: "All" }, ...HORIZONS.map(hz => ({ value: hz, label: HORIZON_LABEL[hz] }))]} /></label>
        <label className="oi-pj-flt">Outcome <MenuSelect value={p.dim ?? ""} onChange={v => p.setDim(v || null)} ariaLabel="Filter by outcome" options={[{ value: "", label: "All" }, ...s.outcomes.map(o => ({ value: o.id, label: `${o.id.toUpperCase()} · ${dash(o.title)}` }))]} /></label>
        {hidden > 0 ? <span className="oi-pj-dim" title="Later, planned and suggested items have no execution state yet; see Plan mode.">{hidden} unscheduled hidden</span> : null}
      </div>
      <div className="oi-pj-kan" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(180px, 1fr))` }}>
        {cols.map(c => {
          const cards = items.filter(w => modeColumn(mode, w) === c);
          return (
            <div key={c} className="oi-pj-col">
              <div className="oi-pj-colh">{modeLabel(mode, c)} <span className="oi-pj-pc">{cards.length}</span></div>
              {cards.length === 0 ? <div className="oi-pj-dot">·</div> : cards.map(w => {
                const prob = problemLine(w, p.today), next = nextAction(w), b = badge(w);
                return (
                  <div key={w.id} role="button" tabIndex={0} className={`oi-pj-card s-${stripeOf(w, p.today)}${selCard === w.id ? " sel" : ""}`}
                    onClick={() => p.onSelect({ kind: "card", project: id, work: w })}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.onSelect({ kind: "card", project: id, work: w }); } }}>
                    <div className="oi-pj-ct">{dash(w.title)}</div>
                    {prob ? <div className="oi-pj-pr">{prob}</div> : null}
                    {next ? <div className="oi-pj-cn"><small>Next →</small> {next}</div> : null}
                    <div className="oi-pj-pills2">{cardPills(w, p.today).map(pl => <span key={pl.text} className={`oi-pj-tag k-${pl.tone}`} title={pl.tip}>{pl.text}</span>)}{b === "V" ? <span className="oi-pj-tag k-success" title="Verified by evidence">VERIFIED</span> : null}</div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );

  const outcomes = rollups.length === 0 ? <p className="oi-pj-note">No outcomes recorded for this project.</p> : (
    <div className="oi-pj-ol">{rollups.map(r => (
      <button type="button" key={r.outcome.id} className={`oi-pj-oc${selOut === r.outcome.id ? " insp" : ""}`} onClick={() => pickOutcome(r.outcome)}>
        <span className="oi-pj-ot"><span className="oi-pj-tag k-info">{r.outcome.id.toUpperCase()}</span> {dash(r.outcome.title)}</span>
        {r.outcome.summary ? <span className="oi-pj-os">{r.outcome.summary}</span> : null}
        <span className="oi-pj-dim">{r.text}</span>
      </button>))}</div>
  );
  const activity = shipped.length === 0 ? <p className="oi-pj-note">Nothing shipped is recorded yet. This tab lists deliveries from the spine, newest first.</p> : (
    <ul className="oi-pj-act">{recentlyShipped(s, 30).map((x, i) => <li key={i}><b>{dash(x.title)}</b> <span className={`oi-pj-tag k-${x.verification === "verified" ? "success" : "muted"}`}>{x.verification === "verified" ? "VERIFIED" : "CLAIMED"}</span> <span className="oi-pj-dim">{agoText(x.date, p.today)}</span></li>)}</ul>
  );
  const graph = <p className="oi-pj-note">Graph will show how outcomes connect to work items and what blocks what. It is empty because the project spine has no dependency links yet; nothing is drawn rather than guessing.</p>;

  return (
    <section className="oi-pj-board">
      <div className="oi-pj-bh">
        <button type="button" className="oi-pj-btn" onClick={p.onBack}>← Projects</button>
        <h2 className="oi-pj-title">{s.project.name}</h2>
        <span className={`oi-pj-chip t-${h.tone}`} title={h.reason}>{TONE_WORD[h.tone]}</span>
        <span className="oi-pj-dim oi-pj-grow">{h.reason.replace(/^\w+: /, "")}{s.project.one_liner ? ` · ${s.project.one_liner}` : ""}</span>
        <button type="button" className="oi-pj-btn" aria-expanded={ctx} aria-controls="oi-pj-ctx" onClick={() => setCtx(o => !o)} title="Outcomes, recently shipped, reconciled and unknowns">{ctx ? "Hide context" : "Context"}</button>
      </div>
      <div className="oi-pj-tabs" role="tablist" aria-label="Project views">
        {TABS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className="oi-pj-tab" onClick={() => setTab(k)}>{label}</button>)}
      </div>
      <div className="oi-pj-bw">
        <div className="oi-pj-main">{tab === "board" ? board : tab === "outcomes" ? outcomes : tab === "graph" ? graph : activity}</div>
        {ctx ? (
          <aside id="oi-pj-ctx" className="oi-pj-drawer" aria-label="Project context">
            <div className="oi-pj-gl">OUTCOMES</div>
            {rollups.length === 0 ? <div className="oi-pj-dim">none recorded</div> : rollups.map(r => (
              <button type="button" key={r.outcome.id} className={`oi-pj-oc${p.dim === r.outcome.id ? " sel" : ""}${selOut === r.outcome.id ? " insp" : ""}`} title={r.outcome.summary ?? ""} onClick={() => pickOutcome(r.outcome)}>
                <span className="oi-pj-ot"><span className="oi-pj-tag k-info">{r.outcome.id.toUpperCase()}</span> {dash(r.outcome.title)}</span><span className="oi-pj-dim">{r.text}</span>
              </button>))}
            <div className="oi-pj-gl">RECENTLY SHIPPED</div>
            {shipped.length === 0 ? <div className="oi-pj-dim">—</div> : <ul>{shipped.map((x, i) => <li key={i}>{dash(x.title)} <span className="oi-pj-dim">{agoText(x.date, p.today)}</span></li>)}</ul>}
            {s.reconciled.length > 0 ? <><div className="oi-pj-gl">RECONCILED</div><ul>{s.reconciled.map((r, i) => <li key={i}><b>{dash(r.conflict)}</b> → {dash(r.truth)}</li>)}</ul></> : null}
            {unknowns.length > 0 ? <><div className="oi-pj-gl">UNKNOWN</div><ul className="oi-pj-dim">{unknowns.map((u, i) => <li key={i}>{u}</li>)}</ul></> : null}
          </aside>
        ) : null}
      </div>
    </section>
  );
}
