import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { activePreset, cardView, chipView, DEFAULT_FILTERS, facetsNarrowed, filterPanel, listRows, PRESETS, presetLabel, PROVIDER_LABEL, showingText, wsHeaderText } from "../../work/fleet-view-model.ts";
import type { FleetFilters, FleetGroupBy, FleetRow, FleetSort, PanelGroup, Segment } from "../../work/fleet-view-model.ts";
import type { FleetSnapshot } from "../../work/fleet-types.ts";
import { ROLE_WORDS } from "../../work/model-tiers.ts";
import { cleanText } from "../../work/sanitize.ts";

/** Lets a child of the popover (a FLAGS row) ask the list to clear its filters and bring one agent's row into view. */
export const FleetFocusContext = createContext<((key: string) => void) | null>(null);
type Focus = { key: string | null; n: number };
type Common = { fleet?: FleetSnapshot | null; now: number };

/** The stacked per-model bar: widths are largest-remainder percentages that sum to exactly 100. */
function ModelBar({ segments, letters }: { segments: Segment[]; letters?: boolean }) {
  if (!segments.length) return <span className="oi-fc-bar oi-fc-bar-empty" aria-hidden="true" />;
  return <span className={`oi-fc-bar${letters ? " oi-fc-bar-big" : ""}`} role="img" aria-label={segments.map(s => `${s.label} ${s.live}`).join(", ")}>
    {segments.map(s => <span key={s.key} className="oi-fc-seg" style={{ width: `${s.pct}%`, background: s.colour }} title={`${s.label}: ${s.live} working (${s.pct}%)`}>{letters && s.pct >= 12 ? s.letter : null}</span>)}
  </span>;
}

/** Live agents per 5-minute bucket over the last hour (newest bar on the right), scaled to the busiest bucket. */
function LiveSpark({ values }: { values: number[] }) {
  if (!values.length) return null;
  return <svg className="oi-fc-livespark" viewBox="0 0 48 14" width="48" height="14" role="img" aria-label="Live agents over the last hour"><title>Live agents over the last hour, 5 minutes per bar</title>
    {values.map((v, i) => { const h = v > 0 ? Math.max(1.5, v * 14) : 0.8; return <rect key={i} x={i * 4} y={14 - h} width="3" height={h} />; })}
  </svg>;
}

/** Compact top-bar chip: the big live number, "+n idle", a mini model bar. Click opens the list in a popover (Esc or outside click closes). */
/** `extra`: rendered under the lane list in the popover (the message-flow panel). */
export function FleetChip({ fleet, now, onSelectLane, extra, onOpenList }: Common & { onSelectLane?: (key: string) => void; extra?: ReactNode; onOpenList?: () => void }) {
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<FleetFilters>(DEFAULT_FILTERS);
  const [focus, setFocus] = useState<Focus>({ key: null, n: 0 });
  const v = useMemo(() => chipView(fleet), [fleet]);
  const focusLane = (key: string | null) => setFocus(f => ({ key, n: f.n + 1 }));
  const toggle = (apply: FleetFilters) => setFilters(f => ({ ...f, ...apply }));
  const btn = useRef<HTMLButtonElement>(null), pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    pop.current?.focus();
    const away = (e: MouseEvent) => { if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  const close = () => { setOpen(false); btn.current?.focus(); };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); return; }
    if (e.key !== "Tab" || !pop.current) return;
    const items = Array.from(pop.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter(el => !el.hasAttribute("disabled"));
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1], at = document.activeElement;
    if (e.shiftKey && (at === first || at === pop.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
  };
  return <span className="oi-fc-chipwrap" onKeyDown={open ? onKey : undefined}>
    <button ref={btn} type="button" className={`oi-fc-chip${v.live > 0 ? " oi-fc-chip-live" : ""}`} title={v.title} aria-haspopup="dialog" aria-expanded={open}
      aria-label={v.empty ?? `${v.live} live in the last ${v.window}, ${v.sub}${v.needsText ? `, ${v.needsText}` : ""}`} onClick={() => { if (!open) { const first = fleet && v.needsYou > 0 ? listRows(fleet, { needs: true }, "state", now)[0] : undefined; setFilters(first && !first.live ? { preset: "everything" } : DEFAULT_FILTERS); focusLane(first?.key ?? null); } setOpen(o => !o); }}>
      <span className="oi-fc-chip-n">{v.big}</span>
      <span className="oi-fc-chip-meta"><span className="oi-fc-chip-word">{v.empty ? "agents" : "live"}{v.window && <span className="oi-fc-chip-win" title={v.definition}> {v.window.replace(/ min$/, "m")}</span>}</span>{v.sub && <span className="oi-fc-chip-sub">{v.sub}</span>}</span>
      <ModelBar segments={v.providerBar} />
    </button>
    {open && <div ref={pop} className="oi-fc-pop" role="dialog" aria-label="Live agents" tabIndex={-1}>
      <div className="oi-fc-pophead" title={v.definition}>
        <span className="oi-fc-sum" role="group" aria-label="Quick filters">
          <button type="button" className={`oi-fc-big${filters.preset === "working" ? " oi-fc-big-on" : ""}`} aria-pressed={filters.preset === "working"} title="Show only live agents (the Working now preset)" onClick={() => toggle({ preset: filters.preset === "working" ? "everything" : "working" })}>{v.big}</button>
          <span>live in the last {v.window} · {v.sub}{v.needsYou > 0 ? " · " : ""}</span>
          {v.needsYou > 0 && <button type="button" className={`oi-fc-needbtn${filters.preset === "needs" ? " oi-fc-needbtn-on" : ""}`} aria-pressed={filters.preset === "needs"} onClick={() => toggle({ preset: filters.preset === "needs" ? "working" : "needs" })}>{v.needsText}</button>}
        </span>
        <button type="button" className="oi-fc-close" aria-label="Close live agents" title="Close (Esc)" onClick={close}>×</button>
      </div>
      <div className="oi-fc-scroll">
        <FleetFocusContext.Provider value={k => { setFilters({ preset: "everything" }); focusLane(k); }}>
          <FleetList fleet={fleet} now={now} onSelectLane={k => { onSelectLane?.(k); }} filters={filters} onFilters={setFilters} focus={focus} onOpenList={onOpenList ? () => { close(); onOpenList(); } : undefined} />
          {extra}
        </FleetFocusContext.Provider>
      </div>
    </div>}
  </span>;
}

/** Overview card: big number, model bar with letters, role and runtime counts, $/h and an "open list" button. */
export function FleetCard({ fleet, now, onOpenList }: Common & { onOpenList?: () => void }) {
  const v = useMemo(() => cardView(fleet, now), [fleet, now]);
  return <div className="oi-ov-card oi-fc-card" title={v.title}>
    <span className="oi-ov-title" title={v.definition}>Live agents</span>
    <span className="oi-fc-card-n">{v.number}</span>
    {v.empty ? <span className="oi-ov-sub">{v.empty}</span> : <>
      <span className="oi-ov-sub">{v.sub}</span>
      {v.needYou > 0 && <span className="oi-fc-need" title="Agents blocked on a person: a question, your turn or a permission"><b>{v.needYouText}</b></span>}
      {v.unread > 0 && <span className="oi-fc-unread" title="Agents with a message nobody has answered yet. Not counted as needing you.">{v.unreadText}</span>}
      <span className="oi-fc-windows">{v.windows.map(w => <span key={w.id} title={w.title}><b>{w.n}</b> {w.label}</span>)}</span>
      <LiveSpark values={v.spark} />
      <span className="oi-ov-sub oi-fc-def">{v.definition}</span>
      <ModelBar segments={v.segments} letters />
      <span className="oi-fc-legend">{v.segments.map(s => <span key={s.key} title={s.label}><i style={{ background: s.colour }} />{s.letter} {s.live}</span>)}</span>
      <span className="oi-fc-counts">
        {v.roles.filter(r => r.live > 0).map(r => <span key={r.role} title={r.role === "lead" || r.role === "worker" ? ROLE_WORDS[r.role] : r.role}>{r.live} {r.role}</span>)}
        {v.runtimes.map(r => <span key={r.key}>{r.live} {r.label}</span>)}
      </span>
      <span className="oi-fc-counts" role="group" aria-label="By kind">{v.kinds.map(k => <span key={k.key} title={`${k.label}: ${k.live} live, ${k.idle} idle, ${k.total} seen in 7 days`}>{k.live}/{k.total} {k.label}</span>)}</span>
      <span className="oi-ov-sub" title={v.burnTitle}>{v.burnText} · list-price estimate</span>
      <span className="oi-ov-sub">{v.doneText}</span>
      {onOpenList && <button type="button" className="oi-fc-open" onClick={onOpenList}>Open list</button>}
    </>}
  </div>;
}

const SORTS: { id: FleetSort; label: string }[] = [{ id: "state", label: "Newest" }, { id: "cost", label: "Cost" }, { id: "name", label: "Name" }];

const GROUPS: { id: FleetGroupBy; label: string; title: string }[] = [
  { id: "tree", label: "Tree", title: "Coordinator, then leads, then workers" },
  { id: "workspace", label: "Workspace", title: "Group agents by the project folder they work in; the most recently active group comes first" },
];
const GROUP_KEY = "osiris.fleet.groupBy";
const readGroupBy = (): FleetGroupBy => { try { return localStorage.getItem(GROUP_KEY) === "workspace" ? "workspace" : "tree"; } catch { return "tree"; } };
const saveGroupBy = (g: FleetGroupBy) => { try { localStorage.setItem(GROUP_KEY, g); } catch { /* storage blocked: the choice just is not remembered */ } };

/** One labelled filter group: an "All" chip (selected by default, resets the group), the value chips with counts, and "+k more" for long groups. */
function FilterGroup({ g, onPick, onMore, expanded }: { g: PanelGroup; onPick: (apply: FleetFilters) => void; onMore: () => void; expanded: boolean }) {
  if (!g.chips.length && !g.all.on) return null;
  return <div className={`oi-fc-fgroup${g.id === "state" || g.id === "role" ? " oi-fc-cap" : ""}`} role="group" aria-label={g.label}>
    <span className="oi-fc-flabel">{g.label}</span>
    <span className="oi-fc-chips">
      <button type="button" className={`oi-fc-fchip${g.all.on ? " oi-fc-fchip-on" : ""}`} aria-pressed={g.all.on} onClick={() => onPick(g.all.apply)}>All <b>{g.all.count}</b></button>
      {g.chips.map((c, i) => <Fragment key={c.id}>{c.provider && c.provider !== g.chips[i - 1]?.provider && <span className={`oi-fc-eyebrow oi-fc-eyebrow-${c.provider}`}>{PROVIDER_LABEL[c.provider]}</span>}<button type="button" className={`oi-fc-fchip${c.on ? " oi-fc-fchip-on" : ""}${c.count === 0 ? " oi-fc-zero" : ""}`} aria-pressed={c.on} onClick={() => onPick(c.apply)} title={c.title}>{cleanText(c.label)} <b>{c.count}</b></button></Fragment>)}
      {g.more > 0 && <button type="button" className="oi-fc-fchip oi-fc-fmore" aria-expanded={false} onClick={onMore}>+{g.more} more</button>}
      {expanded && g.chips.length > 6 && <button type="button" className="oi-fc-fchip oi-fc-fmore" aria-expanded={true} onClick={onMore}>Show fewer</button>}
    </span>
  </div>;
}

/** A workspace header: collapsible, with live / need-you / total counts and the newest activity. Not an agent. */
function WsHeader({ r, shut, onToggle }: { r: FleetRow; shut: boolean; onToggle: () => void }) {
  const g = r.wsGroup!, text = cleanText(r.label);
  return <li className={`oi-fc-row oi-fc-group oi-fc-wshead oi-fc-${r.state}`} style={{ paddingLeft: 8 + r.depth * 14 }}>
    <span className="oi-fc-shape" aria-hidden="true">{shut ? "▸" : "▾"}</span>
    <button type="button" className="oi-fc-name" aria-expanded={!shut} onClick={onToggle}
      title={`${text}: ${g.live} live, ${g.needYou} need you, ${g.total} total. Counts cover this group's own agents. Click to ${shut ? "open" : "close"}.`}>
      {text} <em>· {wsHeaderText(g)}</em>
    </button>
  </li>;
}

/** ONE agent row, two densities (td-osi.12): "compact" in the top-bar popover, "full" in Calls > Agents. The same component, so they look the same. */
export type FleetDensity = "compact" | "full";
export function FleetAgentRow({ r, onSelectLane, focused, density = "compact" }: { r: FleetRow; onSelectLane?: (key: string) => void; focused?: boolean; density?: FleetDensity }) {
  const text = cleanText(r.label);
  if (r.group) return <li className={`oi-fc-row oi-fc-group oi-fc-${r.state}`} style={{ paddingLeft: 8 }} title={`${r.childCount} agents named ${text}…, grouped because no parent is known. Not an agent itself.`}>
    <span className="oi-fc-shape" role="img" aria-label={r.stateWord}>{r.shape}</span>
    <span className="oi-fc-gname">{text} <em>{r.childCount}</em></span>
  </li>;
  return <li data-lane={r.key} className={`oi-fc-row oi-fc-${r.state}${r.needsYou ? " oi-fc-rowneed" : ""}${focused ? " oi-fc-rowfocus" : ""}${density === "full" ? " oi-fc-row-full" : ""}`} style={{ paddingLeft: 12 + r.depth * 14 }} title={r.needsYou ? `Needs you. ${r.kind}` : r.kind}>
    <span className="oi-fc-shape" title={r.live ? "Working now (wrote in the last 5 min)" : r.state === "idle" ? "Idle (quiet for 5 to 60 min)" : "Done (quiet for over an hour)"} role="img" aria-label={r.stateWord}>{r.shape}</span>
    <span className="oi-fc-nm">
      <button type="button" className="oi-fc-name" onClick={() => onSelectLane?.(r.key)} title={r.childCount ? `${text}, ${r.childCount} sub-agents` : text}>{r.depth > 0 ? "↳ " : ""}{text}{r.childCount ? <em> +{r.childCount}</em> : null}</button>
      <small className={`oi-fc-act${r.activityLong ? " oi-fc-act-long" : ""}`} title={r.activity ? (r.activityRunning ? "Running now" : "Finished") : "No tool activity seen"}>{r.activityRunning ? <i className="oi-fc-dot" aria-hidden="true" /> : null}{r.activity}</small>
    </span>
    {r.waiting ? <span className="oi-fc-wait" title={r.waitingTitle}><span aria-hidden="true">{r.waitingShape}</span> {r.waitingWord}</span> : <span />}
    <span className="oi-fc-bead">{r.beadId ? cleanText(r.beadId) : ""}</span>
    <span><span className={`oi-fc-pv oi-fc-pv-${r.provider}`} title={r.modelTitle} aria-label={r.modelTitle}>{r.modelChip}</span></span>
    <span className="oi-fc-role" title={`${r.kind} · ${r.role}`}>{r.role}</span>
    <span className="oi-fc-ws" title={r.branch ? `branch ${cleanText(r.branch)}` : undefined}>{r.workspace ? cleanText(r.workspace) : ""}</span>
    <span className="oi-fc-tok" title={r.tokensTitle}>{r.tokensText}</span>
    <span className="oi-fc-cost" title={`${r.costTitle} Last activity ${r.lastText}.`}>{r.costText}</span>
  </li>;
}

/** Every agent as a tree, one ~28px row each: state shape, name, work item, model letter, role, workspace, last activity, tokens, cost, spark. */
export function FleetList({ fleet, now, onSelectLane, filters: given, onFilters, focus, onOpenList, density = "compact" }: Common & { density?: FleetDensity; onSelectLane?: (key: string) => void; filters?: FleetFilters; onFilters?: (f: FleetFilters) => void; focus?: Focus; onOpenList?: () => void }) {
  const [own, setOwn] = useState<FleetFilters>(DEFAULT_FILTERS);
  const filters = given ?? own;
  const setFilters = (fn: (f: FleetFilters) => FleetFilters) => (onFilters ? onFilters(fn(filters)) : setOwn(fn));
  const root = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState<FleetSort>("state");
  const [groupBy, setGroupBy] = useState<FleetGroupBy>(readGroupBy);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => (fleet ? listRows(fleet, filters, sort, now, groupBy) : []), [fleet, filters, sort, now, groupBy]);
  const visible = useMemo(() => {
    const out: FleetRow[] = [];
    let hideBelow: number | null = null;
    for (const r of rows) {
      if (hideBelow !== null && r.depth > hideBelow) continue;
      hideBelow = r.wsGroup && collapsed.has(r.key) ? r.depth : null;
      out.push(r);
    }
    return out;
  }, [rows, collapsed]);
  useEffect(() => {
    if (!focus?.key) return;
    Array.from(root.current?.querySelectorAll<HTMLElement>("[data-lane]") ?? []).find(e => e.dataset.lane === focus.key)?.scrollIntoView?.({ block: "nearest" });
  }, [focus?.n, focus?.key]);
  const pickGroup = (g: FleetGroupBy) => { setGroupBy(g); saveGroupBy(g); };
  const toggle = (key: string) => setCollapsed(c => { const n = new Set(c); if (!n.delete(key)) n.add(key); return n; });
  const [more, setMore] = useState<ReadonlySet<string>>(new Set());
  const groups = useMemo(() => (fleet ? filterPanel(fleet, filters, more) : null), [fleet, filters, more]);
  if (!fleet || !groups) return <div className="oi-fc-list"><p className="oi-note">Fleet count is not available yet. Restart Osiris, or choose a tracker in Work.</p></div>;
  const pick = (apply: FleetFilters) => setFilters(f => ({ ...f, ...apply }));
  const preset = activePreset(filters), shownCount = rows.filter(r => !r.group).length;
  const toggleMore = (id: string) => setMore(m => { const n = new Set(m); if (!n.delete(id)) n.add(id); return n; });
  return <div className={`oi-fc-list${density === "full" ? " oi-fc-list-full" : ""}`} ref={root}>
    <div className="oi-fc-head">
      <div className="oi-fc-filters">
      <div className="oi-fc-presets" role="group" aria-label="Presets">
        {PRESETS.map(p => <button key={p.id} type="button" className={`oi-fc-pre${preset === p.id ? " oi-fc-fchip-on" : ""}`} aria-pressed={preset === p.id} onClick={() => pick(p.apply)}>{p.label}</button>)}
        <button type="button" className={`oi-fc-pre oi-fc-custom${facetsNarrowed(filters) ? " oi-fc-fchip-on" : ""}`} aria-pressed={facetsNarrowed(filters)} disabled={!facetsNarrowed(filters)} title="Lights up when a facet below narrows the preset further">Custom</button>
      </div>
      {groups.map(g => <FilterGroup key={g.id} g={g} onPick={pick} expanded={more.has(g.id)} onMore={() => toggleMore(g.id)} />)}
      </div>
      <div className="oi-fc-bar2">
      <span className="oi-fc-showing" role="status" aria-label={showingText(shownCount, fleet.lanes.length, filters)}>Showing <b>{shownCount} of {fleet.lanes.length}</b> · {presetLabel(preset)}</span>
      <span>Group <span className="oi-fc-sorts" role="group" aria-label="Group by">{GROUPS.map(g => <button key={g.id} type="button" className="oi-fc-txt" aria-pressed={groupBy === g.id} title={g.title} onClick={() => pickGroup(g.id)}>{g.label}</button>)}</span></span>
      <span>Sort <span className="oi-fc-sorts oi-fc-sorts-after" role="group" aria-label="Sort">{SORTS.map(x => <button key={x.id} type="button" className="oi-fc-txt" aria-pressed={sort === x.id} onClick={() => setSort(x.id)}>{x.label}</button>)}</span></span>
      </div>
    </div>
    <ul className="oi-fc-rows">
      {visible.map(r => r.wsGroup ? <WsHeader key={r.key} r={r} shut={collapsed.has(r.key)} onToggle={() => toggle(r.key)} /> : <FleetAgentRow key={r.key} r={r} onSelectLane={onSelectLane} focused={focus?.key === r.key} density={density} />)}
      {!rows.length && <li className="oi-note">No agents match these filters.</li>}
    </ul>
    <p className="oi-fc-foot"><span>"Working" = wrote in the last 5 min (a guess from transcripts){fleet.truncated ? ` · list capped, counts cover all ${fleet.summary.total}` : ""}</span>{onOpenList && density === "compact" && <button type="button" className="oi-fc-btn" onClick={onOpenList}>Open full list ↗</button>}</p>
  </div>;
}

export const fleetCountStyles = `
.oi-fc-list-full{max-width:none}.oi-fc-row-full{grid-template-rows:44px;height:44px;font-size:13px}.oi-fc-row-full .oi-fc-name{font-size:13px}
.oi-fc-chipwrap{position:relative;display:inline-flex}
.oi-fc-chip{display:inline-flex;align-items:center;gap:8px;min-height:28px;padding:2px 10px;border:1px solid var(--oi-border);border-radius:999px;background:transparent;color:var(--oi-text);font:inherit;cursor:pointer}
.oi-fc-chip:hover,.oi-fc-chip[aria-expanded="true"]{background:var(--oi-selected)}
.oi-fc-chip:focus-visible,.oi-fc-name:focus-visible,.oi-fc-fchip:focus-visible,.oi-fc-open:focus-visible{outline:2px solid var(--oi-accent);outline-offset:1px}
.oi-fc-chip-n{font-size:18px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;color:var(--oi-tone-muted)}
.oi-fc-chip-live .oi-fc-chip-n{color:var(--oi-tone-running);text-shadow:var(--oi-glow,none)}
.oi-fc-chip-meta{display:flex;flex-direction:column;line-height:1.1;font-size:10px;color:var(--oi-muted);text-align:left}
.oi-fc-chip-word,.oi-fc-chip-sub{text-transform:uppercase;letter-spacing:.04em}
.oi-fc-bar{display:inline-flex;width:44px;height:6px;border-radius:3px;overflow:hidden;background:color-mix(in srgb,var(--oi-text) 12%,transparent)}
.oi-fc-bar-big{display:flex;width:100%;height:20px;border-radius:5px}
.oi-fc-seg{display:flex;align-items:center;justify-content:center;min-width:2px;font-size:11px;font-weight:700;color:var(--oi-bg);overflow:hidden}
.oi-fc-pop{position:absolute;right:0;top:calc(100% + 6px);z-index:1000;isolation:isolate;overflow:hidden;width:min(880px,92vw);max-height:min(70vh,calc(100vh - 72px));display:flex;flex-direction:column;border-radius:8px;background-color:Canvas;background-image:linear-gradient(var(--oi-raised,var(--oi-panel)),var(--oi-raised,var(--oi-panel)));color:var(--oi-text);box-shadow:var(--oi-shadow-raised,0 0 0 1px var(--oi-border),0 8px 24px var(--oi-shadow));outline:none}
.oi-fc-card{display:flex;flex-direction:column;gap:6px}
.oi-fc-card-n{font-size:48px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums;color:var(--oi-tone-running);text-shadow:var(--oi-glow,none)}
.oi-fc-legend,.oi-fc-counts{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--oi-muted)}
.oi-fc-legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px}
.oi-fc-open{align-self:flex-start;margin-top:2px;padding:3px 10px;border:1px solid var(--oi-border);border-radius:6px;background:transparent;color:var(--oi-text);font:inherit;cursor:pointer}
.oi-fc-open:hover{background:var(--oi-selected)}
.oi-fc-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}
.oi-fc-scroll .oi-fc-list,.oi-fc-scroll .oi-fc-rows{overflow:visible}
.oi-fc-list{display:flex;flex-direction:column;min-height:0;overflow:hidden}
.oi-fc-head{position:sticky;top:0;z-index:1;background-color:Canvas;background-image:linear-gradient(var(--oi-raised,var(--oi-panel)),var(--oi-raised,var(--oi-panel)))}
.oi-fc-filters{padding:2px 12px 8px;border-bottom:1px solid var(--oi-border-strong,var(--oi-border));display:flex;flex-direction:column;gap:6px}
.oi-fc-bar2{display:flex;align-items:center;gap:14px;padding:6px 12px;font-size:11.5px;color:var(--oi-muted);border-bottom:1px solid var(--oi-border)}
.oi-fc-bar2 b{color:var(--oi-text);font-weight:700}
.oi-fc-txt{padding:1px 2px;border:0;background:transparent;color:var(--oi-muted);font:inherit;cursor:pointer}
.oi-fc-txt[aria-pressed="true"]{color:var(--oi-text);box-shadow:inset 0 -2px 0 var(--oi-accent)}
.oi-fc-txt:focus-visible,.oi-fc-pre:focus-visible,.oi-fc-big:focus-visible,.oi-fc-needbtn:focus-visible,.oi-fc-btn:focus-visible{outline:2px solid var(--oi-focus,var(--oi-accent));outline-offset:1px}
.oi-fc-fgroup{display:grid;grid-template-columns:86px minmax(0,1fr);gap:8px;align-items:start}
.oi-fc-cap .oi-fc-fchip{text-transform:capitalize}
.oi-fc-flabel{font:600 9.5px/22px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--oi-muted)}
.oi-fc-sum{display:inline-flex;align-items:center;gap:8px}
.oi-fc-close{margin-left:auto;width:22px;height:22px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--oi-muted);font-size:14px;line-height:1;cursor:pointer}
.oi-fc-close:hover{background:var(--oi-hover);color:var(--oi-text)}
.oi-fc-close:focus-visible{outline:2px solid var(--oi-accent);outline-offset:1px}
.oi-fc-rowneed{border-left:3px solid var(--oi-warning)}
.oi-fc-rowfocus{background:var(--oi-selected);box-shadow:inset 0 0 0 1px var(--oi-accent)}
.oi-fc-fmore{border-style:dashed;color:var(--oi-muted)}
.oi-fc-chips,.oi-fc-sorts{display:inline-flex;flex-wrap:wrap;gap:3px 4px;align-items:center}
.oi-fc-sorts{margin-left:0}
.oi-fc-sorts-after{margin-left:0}
.oi-fc-fchip{padding:2px 8px;border:0;border-radius:5px;background:transparent;color:var(--oi-text-2,var(--oi-text));font:inherit;font-size:11.5px;line-height:18px;cursor:pointer}
.oi-fc-fchip:hover,.oi-fc-pre:hover{background:var(--oi-hover)}
.oi-fc-zero{opacity:.45}
.oi-fc-pre{padding:3px 10px;border:0;border-radius:999px;background:transparent;color:var(--oi-text-2,var(--oi-text));font:inherit;font-size:12px;cursor:pointer}
.oi-fc-pre.oi-fc-fchip-on{background:var(--oi-selected);color:var(--oi-selected-text,var(--oi-text));box-shadow:inset 0 0 0 1px var(--oi-selected-border,var(--oi-accent))}
.oi-fc-custom:disabled{opacity:.6;cursor:default}
.oi-fc-fchip b{font:600 10.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--oi-muted);margin-left:3px}
.oi-fc-fchip-on{background:var(--oi-selected);color:var(--oi-selected-text,var(--oi-text));box-shadow:inset 0 0 0 1px var(--oi-selected-border,var(--oi-accent))}
.oi-fc-rows{list-style:none;margin:0;padding:0;overflow:auto;min-height:0}
.oi-fc-row{display:grid;grid-template-columns:16px minmax(140px,1.6fr) 66px 70px 46px 62px minmax(90px,1fr) 64px 54px;grid-template-rows:34px;gap:8px;align-items:center;height:34px;padding-right:12px;font-size:12px;border-bottom:1px solid var(--oi-border)}
.oi-fc-row>*{min-width:0}
.oi-fc-row>span,.oi-fc-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-fc-nm{display:flex;flex-direction:column;justify-content:center;overflow:hidden}
.oi-fc-nm>.oi-fc-name{text-align:left}
.oi-fc-name{padding:0;border:0;background:transparent;color:var(--oi-text);font:inherit;text-align:left;cursor:pointer}
.oi-fc-name:hover{text-decoration:underline}
.oi-fc-name em{color:var(--oi-muted);font-style:normal}
.oi-fc-shape{text-align:center;color:var(--oi-tone-muted)}
.oi-fc-live .oi-fc-shape{color:var(--oi-tone-running);text-shadow:var(--oi-glow,none)}
.oi-fc-idle .oi-fc-shape{color:var(--oi-tone-attention)}
.oi-fc-done{color:var(--oi-muted)}
.oi-fc-pv{display:inline-flex;align-items:center;padding:0 6px;border-radius:9px;font:600 10.5px/17px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap;--c:var(--oi-lane-3);background:color-mix(in srgb,var(--c) 16%,transparent);color:var(--c)}
.oi-fc-pv-codex{--c:var(--oi-lane-1)}
.oi-fc-pv-gemini{--c:var(--oi-lane-0)}
.oi-fc-tok,.oi-fc-cost{text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
.oi-fc-tok{color:var(--oi-muted)}
.oi-fc-wait{color:var(--oi-warning);font:600 10.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap}
.oi-fc-chip-need{display:inline-flex;gap:4px;align-items:center;font-size:11px;font-weight:700;color:var(--oi-warning);white-space:nowrap}
.oi-fc-need{color:var(--oi-warning);font-size:12px}
.oi-fc-unread{color:var(--oi-text-dim);font-size:11px}
.oi-fc-group{grid-template-columns:16px 1fr;grid-template-rows:26px;height:26px;padding-left:12px;font:600 11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--oi-text-2,var(--oi-text));background:color-mix(in srgb,var(--oi-text) 3%,transparent)}
.oi-fc-act{display:block;font:10.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--oi-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oi-fc-act-long{color:var(--oi-warning)}
.oi-fc-dot{display:inline-block;width:6px;height:6px;margin-right:6px;border-radius:50%;background:var(--oi-tone-running);vertical-align:middle}
.oi-fc-act-long .oi-fc-dot{background:var(--oi-warning)}
.oi-fc-gname em{font-style:normal;color:var(--oi-muted);font-weight:400}
.oi-fc-pophead{display:flex;align-items:center;gap:10px;padding:10px 12px 8px;font-size:12px;color:var(--oi-text-2,var(--oi-text))}
.oi-fc-big{padding:0;border:0;background:transparent;font:800 22px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--oi-tone-running);text-shadow:var(--oi-glow,none);cursor:pointer}
.oi-fc-needbtn{padding:0;border:0;background:transparent;font:inherit;color:var(--oi-tone-attention);cursor:pointer}
.oi-fc-needbtn-on,.oi-fc-big-on{text-decoration:underline}
.oi-fc-windows{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--oi-muted)}
.oi-fc-windows b{color:var(--oi-text);font-variant-numeric:tabular-nums}
.oi-fc-def{font-size:11px}
.oi-fc-chip-win{text-transform:none;letter-spacing:0;color:var(--oi-muted)}
.oi-fc-livespark rect{fill:var(--oi-tone-running)}
.oi-fc-role,.oi-fc-bead,.oi-fc-ws,.oi-fc-last{color:var(--oi-muted)}
.oi-fc-cost{text-align:right;font-variant-numeric:tabular-nums}
.oi-fc-spark rect{fill:var(--oi-tone-running)}
.oi-fc-done .oi-fc-spark rect,.oi-fc-idle .oi-fc-spark rect{fill:var(--oi-tone-muted)}
.oi-fc-foot{position:sticky;bottom:0;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;margin:0;font-size:11.5px;color:var(--oi-muted);border-top:1px solid var(--oi-border-strong,var(--oi-border));background-color:Canvas;background-image:linear-gradient(var(--oi-raised,var(--oi-panel)),var(--oi-raised,var(--oi-panel)))}
.oi-fc-btn{padding:5px 11px;border:0;border-radius:6px;background:var(--oi-hover);color:var(--oi-text);font:12px inherit;cursor:pointer}
.oi-fc-presets{display:flex;flex-wrap:wrap;gap:4px}
.oi-fc-fchip:disabled{opacity:.6;cursor:default}
.oi-fc-eyebrow{align-self:center;margin-left:2px;padding:0 2px 0 8px;border-left:1px solid var(--oi-border);font:600 9px/22px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.12em;color:var(--oi-lane-3)}
.oi-fc-chips>.oi-fc-eyebrow:first-of-type{border-left:0;margin-left:0}
.oi-fc-chips>.oi-fc-eyebrow-codex{color:var(--oi-lane-1)}
.oi-fc-chips>.oi-fc-eyebrow-gemini{color:var(--oi-lane-0)}
.oi-fc-showing{flex:1}
@media (prefers-reduced-motion:no-preference){.oi-fc-dot{animation:oi-fc-pulse 1.6s ease-in-out infinite}@keyframes oi-fc-pulse{50%{opacity:.35}}}
@media (prefers-reduced-motion:reduce){.oi-fc-chip,.oi-fc-open,.oi-fc-fchip{transition:none}}
`;
