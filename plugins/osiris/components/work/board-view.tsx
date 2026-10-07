import { useEffect, useMemo, useRef, useState } from "react";
import { teamGuard } from "../../work/dispatch-guard.ts";
import { ptClass } from "../../work/priority-tone.ts";
import type { BeadLink, BoardCard, Lane, WorkSurfaceSnapshot } from "../../work/surface-types.ts";
import { cleanText } from "../../work/sanitize.ts";
import { copyWithToast } from "../../work/copy-toast.ts";
import { headlineCounts, statusText } from "../../work/status-text.ts";
import { boardQuests } from "../../work/lane-state.ts";
import { firstUse, termLabel } from "../../work/glossary.ts";
import { demoTitle, useDemoOn } from "../../demo/client.ts";
import { laneHelp } from "../../work/ui-text.ts";
import { cardView, epicHue, epicOf, groupByEpic } from "../../work/board-card-model.ts";
import { TimeLensBar, timeLensBarStyles, useTimeLens } from "./time-lens-bar.tsx";
import { stagesAt, type Stage } from "../../work/replay.ts";
import { DISPATCH_LABEL, TEAM_LABEL, HerdrDispatchDialog, herdrDispatchStyles } from "../../work/herdr-dispatch/index.ts";
import { MenuSelect } from "../ui/menu-select.tsx";
import { useFlip } from "./use-flip.ts";
import { CAS_MESSAGE, EDIT_KEY, droppable, planMove, readEditSetting, undoOf, type MovePlan, type MoveResult, type MoveStatus } from "../../work/tracker-write.ts";
import { boardCards, emptyLaneText, historyFromTimestamps, formatAge, laneLabel, shortId } from "../../work/surface-model.ts";

// The approved mockup's four columns. "Action required" is not a column: those cards are the Decisions panel's list (right rail), and a card is in ONE place.
const LANES: readonly Lane[] = ["ready", "in_progress", "review", "blocked"];
const COLUMN_TITLE: Record<Lane, string> = { action: "Action required", ready: "Ready", in_progress: "In progress", review: "Review", blocked: "Blocked" };
/** Replay: the lane a card was in at the scrubbed time, from the SAME stagesAt the Factory replays with ("done" cards leave the board). */
const STAGE_LANE: Record<Stage, Lane | null> = { waiting: "blocked", ready: "ready", building: "in_progress", review: "review", done: null };
const LANE_TONE: Record<Lane, string> = { action: "attention", ready: "info", in_progress: "running", review: "attention", blocked: "failure" };

function Links(p: { title: string; links: BeadLink[]; onSelect(id: string): void }) {
  return <div className="oi-bd-links"><span>{p.title}</span>{p.links.map(l => <button type="button" key={l.id} className="oi-bd-link" title={cleanText(l.title)} onClick={e => { e.stopPropagation(); p.onSelect(l.id); }}>{shortId(l.id)} · {cleanText(l.title)}</button>)}</div>;
}

/** Five lanes (Action required first) straight from boardCards (the model owns lane membership; nothing is recomputed here). */
export function BoardView(p: { snap: WorkSurfaceSnapshot; now: number; selectedId: string | null; onSelect(id: string): void; /** The tracker write (undefined = this host cannot write). */ onMove?(id: string, status: MoveStatus, ifStatus: string, note?: string): Promise<MoveResult>; onChanged?(): void }) {
  const live = useMemo(() => boardCards(p.snap, p.now), [p.snap, p.now]);
  const events = useMemo(() => historyFromTimestamps(p.snap), [p.snap]);
  const lens = useTimeLens(events, p.now);
  const cards = useMemo(() => {
    if (lens.live) return live;
    const st = stagesAt(p.snap, events, lens.t, p.now);
    return live.flatMap(c => { const s = st.get(c.id), l = s ? STAGE_LANE[s] : null; return l ? [{ ...c, lane: l }] : []; });
  }, [live, lens.live, lens.t, p.snap, events, p.now]);
  const quests = useMemo(() => boardQuests(p.snap, cards, p.now), [p.snap, p.now, cards]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => setOpen(o => { const n = new Set(o); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [copy, setCopy] = useState<"idle" | "copied" | "manual">("idle");
  const manual = useRef<HTMLTextAreaElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => { if (copy === "manual") { manual.current?.focus(); manual.current?.select(); } }, [copy]);
  const text = useMemo(() => statusText(p.snap, p.now), [p.snap, p.now]);
  const doCopy = async () => {
    try { if (!(await copyWithToast(text, p.snap.issues.length))) throw new Error("clipboard"); setCopy("copied"); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setCopy("idle"), 1500); }
    catch { setCopy("manual"); } // clipboard blocked: show the text, selected, so Cmd/Ctrl+C works
  };
  const [edit, setEdit] = useState(() => readEditSetting(k => { try { return localStorage.getItem(k); } catch { return null; } }));
  const canEdit = edit && !!p.onMove && lens.live;
  const toggleEdit = () => setEdit(v => { try { localStorage.setItem(EDIT_KEY, v ? "off" : "on"); } catch { /* not persisted */ } return !v; });
  type Pending = { plan: Extract<MovePlan, { ok: true }>; title: string; from: Lane; to: Lane };
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [moveErr, setMoveErr] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ id: string; status: MoveStatus; ifStatus: MoveStatus; text: string } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [over, setOver] = useState<Lane | null>(null);
  const [dispatchOpen, setDispatchOpen] = useState(false), demo = useDemoOn();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [teamOpen, setTeamOpen] = useState(false);
  const anchor = useRef<string | null>(null);
  // Render order (lane, then epic group, then card): shift-click selects the run between the last pick and this one in exactly what is on screen.
  const order = useMemo(() => LANES.flatMap(l => groupByEpic(p.snap, cards.filter(c => c.lane === l)).flatMap(g => g.cards.map(c => c.id))), [cards, p.snap]);
  useEffect(() => { setPicked(s => { const live = new Set(order); const n = new Set([...s].filter(id => live.has(id))); return n.size === s.size ? s : n; }); }, [order]);
  const pick = (id: string, shift: boolean) => setPicked(s => {
    const n = new Set(s), a = anchor.current ? order.indexOf(anchor.current) : -1, b = order.indexOf(id);
    if (shift && a >= 0 && b >= 0) order.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => n.add(x));
    else if (n.has(id)) n.delete(id); else n.add(id);
    anchor.current = id; return n;
  });
  const selectEpic = (ids: string[]) => setPicked(s => { const n = new Set(s), all = ids.every(i => n.has(i)); ids.forEach(i => all ? n.delete(i) : n.add(i)); return n; });
  const teamPlan = useMemo(() => {
    const sel = order.filter(id => picked.has(id)).map(id => cards.find(c => c.id === id)!).filter(Boolean);
    const epics = new Set(sel.map(c => epicOf(p.snap, c.id)));
    return { cards: sel.map(c => ({ id: c.id, title: cleanText(c.title) })), epic: epics.size === 1 ? [...epics][0] : null };
  }, [picked, order, cards, p.snap]);
  const team = teamOpen && teamPlan.cards.length > 0 ? teamPlan : undefined;
  const boardRef = useRef<HTMLDivElement | null>(null);
  useFlip(boardRef, [cards, folded]);
  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);
  const ask = (id: string, to: Lane) => {
    const c = cards.find(x => x.id === id); if (!c || !canEdit) return;
    const plan = planMove(c, to, p.snap.issues.find(i => i.id === id)?.status);
    if (!plan.ok) { setMoveErr(plan.reason); return; }
    setMoveErr(null); setReason(""); setPending({ plan, title: cleanText(c.title), from: c.lane, to });
  };
  const write = async (id: string, status: MoveStatus, ifStatus: string, note?: string): Promise<MoveResult> => {
    setBusy(true);
    try { return await p.onMove!(id, status, ifStatus, note); } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) }; } finally { setBusy(false); }
  };
  const confirmMove = async () => {
    if (!pending || busy) return;
    const { plan } = pending; if (plan.needsReason && !reason.trim()) return;
    const r = await write(plan.id, plan.status, plan.from, plan.needsReason ? reason.trim() : undefined);
    if (!r.ok) { setMoveErr(`Not moved: ${r.reason}. The card is back where it was.`); setPending(null); if (r.reason === CAS_MESSAGE) p.onChanged?.(); return; }
    setPending(null); setMoveErr(null);
    const u = undoOf(plan);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(u ? { ...u, text: `Moved ${shortId(plan.id)} to ${COLUMN_TITLE[pending.to]}.` } : null);
    if (u) undoTimer.current = setTimeout(() => setUndo(null), 8000);
    p.onChanged?.();
  };
  const doUndo = async () => {
    if (!undo || busy) return; const u = undo; setUndo(null); if (undoTimer.current) clearTimeout(undoTimer.current);
    const r = await write(u.id, u.status, u.ifStatus);
    if (!r.ok) setMoveErr(`Undo failed: ${r.reason}`); else p.onChanged?.();
  };
  const tip = firstUse(); // the first place each term appears on this board carries its definition
  return <><TimeLensBar {...lens} speeds={[1, 4, 16]} />
  <div className="oi-bd-head" aria-live="polite"><span className="oi-bd-counts">{headlineCounts(p.snap, p.now)}</span>
    {p.onMove && <label className="oi-bd-edit" title="Allow dragging cards between columns (changes the card's status in the tracker)"><input type="checkbox" checked={edit} onChange={toggleEdit} /> Edit board</label>}
    <span className="oi-bd-split" role="group" aria-label="Status actions">
      <button type="button" className="oi-bd-copy" onClick={() => void doCopy()} title="Copy a plain-text status report to paste anywhere">{copy === "copied" ? "Copied" : "Copy status"}</button>
      <button type="button" className="oi-bd-copy oi-bd-dispatch" disabled={demo} onClick={() => setDispatchOpen(true)} title={demoTitle(demo, "Open a new Herdr terminal and start an agent with this status")}>{DISPATCH_LABEL}<span className="oi-bd-caret" aria-hidden="true">▾</span></button></span>
    {picked.size > 0 && <><button type="button" className="oi-bd-copy oi-bd-dispatch oi-bd-team" onClick={() => setTeamOpen(true)} title="Open a Herdr tab with a lead agent and worker agents for the selected cards">{TEAM_LABEL} ({picked.size})</button>
      <button type="button" className="oi-bd-copy oi-bd-dispatch" onClick={() => { setPicked(new Set()); anchor.current = null; }}>Clear selection</button></>}</div>
  {(dispatchOpen || team) && <HerdrDispatchDialog title={team ? TEAM_LABEL : "Board status"} prompt={team ? "" : `Here is the current project status from the Osiris board. Summarise where things stand and what needs attention first.\n\n${text}`} team={team} guard={team ? teamGuard(p.snap, team.cards.map(c => c.id), p.now) : null} onClose={() => { setDispatchOpen(false); setTeamOpen(false); }} />}
  {pending && <div className="oi-bd-confirm" role="alertdialog" aria-label="Confirm move"><span>Move <b>{shortId(pending.plan.id)}</b> “{pending.title.slice(0, 60)}” from {COLUMN_TITLE[pending.from]} to <b>{COLUMN_TITLE[pending.to]}</b>? This changes its status in the tracker.</span>
    {pending.plan.needsReason && <input aria-label="Why is it blocked?" placeholder="Why is it blocked? (required)" value={reason} maxLength={300} onChange={e => setReason(e.target.value)} />}
    <button type="button" className="oi-bd-copy" disabled={busy || (pending.plan.needsReason && !reason.trim())} onClick={() => void confirmMove()}>{busy ? "Moving…" : "Move"}</button>
    <button type="button" className="oi-bd-copy" disabled={busy} onClick={() => setPending(null)}>Cancel</button></div>}
  {undo && <div className="oi-bd-confirm" role="status"><span>{undo.text}</span><button type="button" className="oi-bd-copy" disabled={busy} onClick={() => void doUndo()}>Undo</button></div>}
  {moveErr && <div className="oi-bd-confirm oi-bd-err" role="alert"><span>{moveErr}</span><button type="button" className="oi-bd-copy" onClick={() => setMoveErr(null)}>Dismiss</button></div>}
  {copy === "manual" && <div className="oi-bd-manual"><p>Your browser blocked copying. The text is selected below: press Cmd+C (Ctrl+C), then close this.</p>
    <textarea ref={manual} readOnly value={text} rows={10} aria-label="Status text" />
    <button type="button" className="oi-bd-copy" onClick={() => setCopy("idle")}>Close</button></div>}
  <div className="oi-bd" ref={boardRef}>{LANES.map(l => {
    const cs = cards.filter(c => c.lane === l), groups = groupByEpic(p.snap, cs);
    const renderCard = (c: BoardCard) => {
      const v = cardView(c, quests.get(c.id)), w = `${c.id}:w`, b = `${c.id}:b`;
      const rel = (key: string, links: BeadLink[], glyph: string, text: string, title: string) => links.length === 1
        ? <button type="button" className="oi-bd-rel" title={`${title}: ${cleanText(links[0].title)}`} onClick={e => { e.stopPropagation(); p.onSelect(links[0].id); }}>{glyph} {links.length}<span className="oi-sr"> {text}</span></button>
        : <button type="button" className="oi-bd-rel" aria-expanded={open.has(key)} title={title} onClick={e => { e.stopPropagation(); toggle(key); }}>{glyph} {links.length}<span className="oi-sr"> {text}</span></button>;
      return <div key={c.id} data-flip-id={c.id} draggable={canEdit} onDragStart={e => { e.dataTransfer.setData("text/plain", c.id); e.dataTransfer.effectAllowed = "move"; }} className={`oi-bd-card ${ptClass(c)}${picked.has(c.id) ? " picked" : ""}${p.selectedId === c.id ? " sel" : ""}${v.noTerminal ? " drift" : ""}`} onClick={() => p.onSelect(c.id)}>
        <div className="oi-bd-top"><input type="checkbox" className="oi-bd-pick" aria-label={`Select ${v.shortId} for a team`} checked={picked.has(c.id)} onClick={e => { e.stopPropagation(); pick(c.id, e.shiftKey); }} onChange={() => undefined} /><span className="oi-bd-id" title={tip("bead")}>{v.shortId}</span>
          {v.pBadge && <span className={`oi-bd-p ${ptClass(c)}`} title={`Priority ${c.priority} (lower numbers are more urgent)`}>{v.pBadge}</span>}
          {v.age && <span className="oi-bd-age" title={`Created ${formatAge(c.ageMs)} ago`}>{v.age}</span>}
          {v.chip ? <span className={`oi-bd-state oi-bt-${v.chip.tone}`} title={v.chip.text === "Something is wrong" ? "The tracker flagged this card, or it has been blocked for a long time" : v.chip.text}>{v.chip.text}</span> : null}
          {v.noTerminal && <span className="oi-drift-badge oi-drift-tint oi-bd-nopane" role="img" aria-label={`Claimed, but no ${termLabel("pane")}`} title={`Claimed, but no ${termLabel("pane")} is attached (drift: claimed · no ${termLabel("pane")})`}>claimed · no {termLabel("pane")}</span>}</div>
        <button type="button" className="oi-bd-title" title={v.fullTitle} onClick={e => { e.stopPropagation(); p.onSelect(c.id); }}>{v.title}</button>
        <div className="oi-bd-relrow">
          {v.waitsOn > 0 && rel(w, c.blockedBy, "⧖", "waits on", `Waits on ${v.waitsOn} ${termLabel("bead")}${v.waitsOn === 1 ? "" : "s"}`)}
          {v.waitsOn > 0 && v.blocks > 0 && <span aria-hidden="true">·</span>}
          {v.blocks > 0 && rel(b, c.unblocks, "⇢", "blocks", `Blocks ${v.blocks} ${termLabel("bead")}${v.blocks === 1 ? "" : "s"}`)}
          {v.agent && <span className="oi-bd-agent" title={v.pane ? tip("pane") : "Claimed by"}>◍ {v.agent}</span>}</div>
        {canEdit && <MenuSelect className="oi-bd-move" ariaLabel={`Move ${v.shortId} to…`} value="" placeholder="Move to…" onClick={e => e.stopPropagation()} onChange={to => ask(c.id, to as Lane)} options={LANES.filter(x => x !== c.lane && droppable(x)).map(x => ({ value: x, label: COLUMN_TITLE[x] }))} />}
        {open.has(w) && c.blockedBy.length > 1 && <Links title="Waiting on" links={c.blockedBy} onSelect={p.onSelect} />}
        {open.has(b) && c.unblocks.length > 1 && <Links title="Unblocks" links={c.unblocks} onSelect={p.onSelect} />}
      </div>;
    };
    const target = canEdit && droppable(l); // review is derived, not a status: it is never a drop target
    return <section key={l} className={`oi-bd-lane${over === l ? " drop" : ""}`} aria-label={laneLabel(l)} data-droppable={target ? "true" : "false"}
      onDragOver={target ? e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (over !== l) setOver(l); } : undefined} onDragLeave={target ? () => setOver(o => (o === l ? null : o)) : undefined}
      onDrop={target ? e => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/plain"); if (id) ask(id, l); } : undefined}>
      <h3 className={`oi-bd-h oi-bt-${LANE_TONE[l]}`} title={laneHelp(l) ? [tip("gate"), tip("rework")].filter(Boolean).join(" ") || undefined : undefined}>{COLUMN_TITLE[l]} <span>{cs.length}</span></h3>
      {cs.length === 0 ? <div className="oi-bd-empty">{emptyLaneText(l)}</div> : groups.map(g => {
        if (!g.headed) return <div key="loose" className="oi-bd-group">{g.cards.map(renderCard)}</div>;
        const key = `${l}|${g.epic}`, shut = folded.has(key);
        return <div key={key} className="oi-bd-group" style={{ "--epic": epicHue(g.epic!) } as React.CSSProperties}>
          <div className="oi-bd-epic-row">
            <button type="button" className="oi-bd-epic" aria-expanded={!shut} title={`${g.title} (${tip("epic") ?? termLabel("epic")})`} onClick={() => setFolded(f => { const n = new Set(f); n.has(key) ? n.delete(key) : n.add(key); return n; })}>
              <i aria-hidden="true" /><span className="oi-bd-epic-t">{g.title}</span></button>
            <span className="oi-bd-epic-side"><span className="oi-bd-epic-n" title={`${g.cards.length} cards in this epic`}>{g.cards.length}</span>
              <button type="button" className="oi-bd-epic-all" title="Select every card of this epic in this column, then start a team" onClick={() => selectEpic(g.cards.map(c => c.id))}>Select epic</button></span></div>
          {!shut && g.cards.map(renderCard)}
        </div>;
      })}
    </section>;
  })}</div></>;
}

export const boardViewStyles = `${timeLensBarStyles}${herdrDispatchStyles}
.oi-bd-card.drift{box-shadow:inset 2px 0 0 var(--oi-drift)}.oi-bd-card.drift.sel{box-shadow:inset 2px 0 0 var(--oi-accent,var(--oi-tone-info))}.oi-bd-nopane{margin-left:auto}
.oi-bd-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px 0;font:13px system-ui,sans-serif;color:var(--oi-text);border-bottom:1px solid var(--oi-border);padding-bottom:8px}
.oi-bd-copy{all:unset;cursor:pointer;font:12px system-ui,sans-serif;color:var(--oi-tone-info);padding:4px 8px;border-radius:6px}
.oi-bd-copy:hover{background:var(--oi-hover)}.oi-bd-copy:focus-visible{outline:1px solid var(--oi-tone-info)}
.oi-bd-manual{display:flex;flex-direction:column;gap:6px;padding:8px 12px;font:12px system-ui,sans-serif;color:var(--oi-text);border-bottom:1px solid var(--oi-border)}
.oi-bd-manual p{margin:0;color:var(--oi-tone-muted)}
.oi-bd-manual textarea{width:100%;box-sizing:border-box;font:12px ui-monospace,monospace;color:var(--oi-text);background:var(--oi-panel);border:1px solid var(--oi-border);border-radius:6px;padding:6px}
/* The board fills the height the host leaves (never less than 320px) and each column scrolls inside itself, so the cards are always reachable. */
.oi-bd{display:grid;grid-template-columns:repeat(4,minmax(240px,1fr));gap:0;padding:0 12px 10px;font:14px var(--oi-font-ui,system-ui,sans-serif);color:var(--oi-text);align-items:stretch;flex:1 1 0;min-height:320px;overflow-x:auto;overflow-y:hidden}
.oi-bd-lane{display:flex;flex-direction:column;gap:0;min-width:0;min-height:0;overflow-y:auto;padding:0 8px;border-left:1px solid var(--oi-border)}.oi-bd-lane:first-child{border-left:0;padding-left:0}
.oi-bd-lane.drop{background:var(--oi-hover);outline:1px dashed var(--oi-tone-info)}
.oi-bd-lane>.oi-bd-h{position:sticky;top:0;z-index:1;background:var(--oi-panel,inherit)}
.oi-bd-lane>.oi-bd-h{padding:4px 2px 8px;border-bottom:1px solid var(--oi-border-strong,var(--oi-border))}
.oi-bd-h{margin:0;display:flex;align-items:center;gap:6px;font:700 10.5px var(--oi-font-head,ui-monospace,monospace);letter-spacing:.1em}
.oi-bd-lane>.oi-bd-h{text-transform:uppercase}
.oi-bd-h span{font:600 10.5px var(--oi-font-head,ui-monospace,monospace);color:var(--oi-muted)}
.oi-bd-state{font-size:10px;line-height:1;padding:2px 5px;border:1px solid currentColor;border-radius:8px;white-space:nowrap;max-width:9em;overflow:hidden;text-overflow:ellipsis}
.oi-bt-info{color:var(--oi-tone-info)}.oi-bt-running{color:var(--oi-tone-running)}.oi-bt-attention{color:var(--oi-tone-attention)}.oi-bt-failure{color:var(--oi-tone-failure)}
.oi-bd-empty{font-size:12px;color:var(--oi-tone-muted);padding:6px 2px}
.oi-bd-group{display:flex;flex-direction:column;position:relative}
.oi-bd-counts{flex:1 1 auto;min-width:0;font-weight:600}
.oi-bd-split{margin-left:auto;display:inline-flex;border-radius:6px;overflow:hidden;background:var(--oi-hover)}
.oi-bd-split .oi-bd-copy{border-radius:0;padding:5px 10px;font-size:12px;color:var(--oi-text)}.oi-bd-split .oi-bd-copy+.oi-bd-copy{border-left:1px solid var(--oi-border-strong,var(--oi-border))}.oi-bd-split .oi-bd-copy:hover{background:color-mix(in srgb,var(--oi-text) 10%,transparent)}
.oi-bd-split .oi-bd-dispatch{color:var(--oi-accent);font-weight:600}
.oi-bd-caret{margin-left:4px}
.oi-bd-agent{margin-left:auto;color:var(--oi-tone-running);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.oi-bd-epic-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:start}.oi-bd-epic-side{display:flex;flex-direction:column;align-items:flex-end;gap:2px;padding-top:6px;flex:none}
.oi-bd-epic{all:unset;box-sizing:border-box;cursor:pointer;display:grid;grid-template-columns:3px minmax(0,1fr);gap:8px;min-width:0;align-items:start;padding:6px 2px 4px;font:600 11px/1.3 var(--oi-font-ui,system-ui,sans-serif);color:var(--oi-text-2,var(--oi-text))}.oi-bd-epic i{align-self:stretch;border-radius:2px;background:var(--epic)}
.oi-bd-epic-all{all:unset;cursor:pointer;white-space:nowrap;font:11px system-ui,sans-serif;color:var(--oi-tone-info);padding:1px 6px;border-radius:6px;opacity:0}
.oi-bd-group:hover .oi-bd-epic-all,.oi-bd-epic-all:focus-visible{opacity:1}.oi-bd-epic-all:hover{background:var(--oi-hover)}.oi-bd-epic-all:focus-visible{outline:1px solid var(--oi-tone-info)}
.oi-bd-pick{margin:0;width:14px;height:14px;cursor:pointer;opacity:0;flex:none}.oi-bd-card:hover .oi-bd-pick,.oi-bd-pick:focus-visible,.oi-bd-card.picked .oi-bd-pick,.oi-bd:has(.oi-bd-card.picked) .oi-bd-pick{opacity:1}
.oi-bd-card.picked{background:var(--oi-selected)}
.oi-bd-epic:hover{color:var(--oi-text)}.oi-bd-epic:focus-visible{outline:1px solid var(--oi-tone-info)}
.oi-bd-epic-t{min-width:0;white-space:normal;overflow-wrap:anywhere;line-height:1.3;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.oi-bd-epic-n{font:600 10.5px var(--oi-font-mono,ui-monospace,monospace);color:var(--oi-muted)}
.oi-bd-card{display:grid;grid-template-rows:auto auto auto;grid-auto-rows:auto;gap:3px;min-height:84px;padding:6px 8px;margin:0 0 4px 5px;border-radius:4px;border-bottom:1px solid var(--oi-border);cursor:pointer;min-width:0;position:relative}
.oi-bd-card:hover{background:var(--oi-hover)}
.oi-bd-card.sel{box-shadow:inset 2px 0 0 var(--oi-accent,var(--oi-tone-info));background:var(--oi-selected)}
.oi-bd-top{display:flex;gap:6px;align-items:center;font:10.5px var(--oi-font-mono,ui-monospace,monospace);color:var(--oi-muted);min-width:0;white-space:nowrap;overflow:hidden}
.oi-bd-id{color:var(--oi-text-2,var(--oi-text))}.oi-bd-p{padding:0 6px;border-radius:9px;font:600 10.5px/17px var(--oi-font-mono,ui-monospace,monospace);background:color-mix(in srgb,currentColor 16%,transparent)}
.oi-bd-pane{margin-left:auto;color:var(--oi-tone-running);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.oi-bd-pane.none{color:var(--oi-tone-attention)}
.oi-bd-state+.oi-bd-pane{flex:none}.oi-bd-state{flex:0 1 auto;min-width:0}.oi-bd-state{margin-left:auto}.oi-bd-state+.oi-bd-pane{margin-left:6px}
.oi-bd-title{all:unset;box-sizing:border-box;cursor:pointer;font:600 12.5px/1.4 var(--oi-font-ui,system-ui,sans-serif);color:var(--oi-text);max-height:2.8em;min-width:0;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:break-word;word-break:normal}
.oi-bd-title:focus-visible,.oi-bd-rel:focus-visible,.oi-bd-link:focus-visible{outline:1px solid var(--oi-tone-info)}
.oi-bd-relrow{display:flex;gap:6px;align-items:center;font:10.5px var(--oi-font-mono,ui-monospace,monospace);color:var(--oi-muted);min-width:0;white-space:nowrap;overflow:hidden}
.oi-bd-rel{all:unset;position:relative;cursor:pointer;color:var(--oi-tone-muted)}.oi-bd-rel:hover{color:var(--oi-text)}
.oi-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.oi-bd-links{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--oi-tone-muted);padding-left:8px;border-left:2px solid var(--oi-border)}
.oi-bd-link{all:unset;cursor:pointer;color:var(--oi-tone-info);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.oi-bd-link:hover{text-decoration:underline}
.oi-bd-card[draggable="true"]{cursor:grab}
.oi-bd-edit{font:12px system-ui,sans-serif;color:var(--oi-muted);display:flex;gap:4px;align-items:center;margin-left:auto}.oi-bd-edit+.oi-bd-split{margin-left:0}
.oi-bd-move{align-self:flex-start}
.oi-bd-confirm{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:6px 12px;font:13px system-ui,sans-serif;color:var(--oi-text);border-bottom:1px solid var(--oi-border);background:var(--oi-hover)}
.oi-bd-confirm input{flex:1;min-width:160px;font:13px system-ui,sans-serif;color:var(--oi-text);background:var(--oi-panel);border:1px solid var(--oi-border);border-radius:6px;padding:4px 6px}
.oi-bd-confirm .oi-bd-copy{margin-left:0}.oi-bd-err{color:var(--oi-tone-failure)}
`;
