import { useMemo, useState } from "react";
import type { NextUpItem } from "../../sidebar-model.ts";
import type { WorkSurfaceSnapshot } from "../../work/surface-types.ts";
import { decisionsWaiting } from "../../work/surface-model.ts";
import { delayText, delayTone } from "../../work/ui-text.ts";
import { cleanText } from "../../work/sanitize.ts";
import { epicOf, miniGraphLayout, type MiniGraph as MiniGraphT } from "../../work/mini-graph.ts";
import { commitsToday, type SidebarCommit } from "../../work/sidebar-commits.ts";
import { relativeAge, shortSha } from "../../git-ui.ts";
import { currentStages, type Stage } from "../../work/replay.ts";
import { dotLabel, labelledIds, miniBadge, miniCaption, miniLegend } from "../../work/graph/mini-legend.ts";
import { GRAPH_ENABLED } from "../../shell/panel-registry.ts";
import { stageColorCss } from "./graph/graph-styles.ts";

export type BottomTab = "nextup" | "commits" | "graph";
/** Every prop after `nextUp` is optional: with all of them absent this is today's NEXT UP list, with no pill tabs. */
export type SidebarBottomProps = {
  nextUp: NextUpItem[] | null; nextUpNote?: string | null; onNextUp?(item: NextUpItem): void;
  /** Work snapshot: pins the decisions waiting on you to the top of Next up (the same decisionsWaiting source as the panel and Health) and feeds the Graph tab. */
  snap?: WorkSurfaceSnapshot | null; now?: number; selectedId?: string | null; onSelectBead?(id: string): void; onOpenGraph?(id: string): void;
  /** Recent commits, mapped from the existing git graph by work/sidebar-commits.ts toSidebarCommits. */
  commits?: SidebarCommit[]; onOpenCommit?(sha: string): void;
};

const STORE = "osiris-sidebar-bottom-tab", NEXT_UP_LIMIT = 8, MINI_W = 240, MINI_H = 150;
const loadTab = (): BottomTab => { try { const v = localStorage.getItem(STORE); if (v === "nextup" || v === "commits" || v === "graph") return v; } catch { /* storage unavailable: default */ } return "nextup"; };
const saveTab = (t: BottomTab) => { try { localStorage.setItem(STORE, t); } catch { /* best effort */ } };
const laneVar = (i: number) => `var(--oi-lane-${((i % 8) + 8) % 8})`;

function MiniGraph(p: { g: MiniGraphT; stages: ReadonlyMap<string, Stage>; selectedId: string | null; onOpenGraph?(id: string): void }) {
  const { g, stages } = p;
  if (g.nodes.length === 0) return <div className="oi-sb-note">No open work to draw</div>;
  const at = new Map(g.nodes.map(n => [n.id, n])), named = labelledIds(g.nodes, stages, p.selectedId);
  return <svg className="oi-sbb-mini" viewBox={`0 0 ${g.width} ${g.height}`} role="group" aria-label="Dependency graph of open work">
    <defs><marker id="oi-sbb-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L6 3L0 6z" className="oi-sbb-arrowhead" /></marker></defs>
    {g.edges.map(e => { const a = at.get(e.source), b = at.get(e.target); return a && b ? <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={e.kind === "blocks" ? "oi-sbb-edge oi-sbb-blocks" : "oi-sbb-edge oi-sbb-sub"} markerEnd={e.kind === "blocks" ? "url(#oi-sbb-arrow)" : undefined} /> : null; })}
    {g.nodes.map(n => { const st = stages.get(n.id), sel = n.id === p.selectedId; return <g key={n.id}>
      <circle cx={n.x} cy={n.y} r={sel ? 5 : 3.5} tabIndex={0} role="button" aria-label={dotLabel(n, st)} aria-pressed={sel}
        className={`oi-sbb-dot oi-wg-s-${st ?? "waiting"}${sel ? " sel" : ""}`}
        onClick={() => p.onOpenGraph?.(n.id)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.onOpenGraph?.(n.id); } }}><title>{dotLabel(n, st)}</title></circle>
      {named.has(n.id) && <text x={n.x + 6} y={n.y + 3} className="oi-sbb-dlabel">{n.shortId}</text>}
    </g>; })}
  </svg>;
}

/** GRAPH-2: what the colours and lines mean, in the canvas's words. */
function MiniLegend({ g, stages }: { g: MiniGraphT; stages: ReadonlyMap<string, Stage> }) {
  const drawn = new Set<Stage>(g.nodes.map(n => stages.get(n.id)).filter((x): x is Stage => !!x));
  const items = miniLegend(drawn, g.edges.some(e => e.kind === "blocks"), g.edges.some(e => e.kind === "subtask"));
  return <ul className="oi-sbb-legend" aria-label="Legend">{items.map(i => <li key={i.key}>
    {i.kind === "stage" ? <i className={`oi-sbb-ldot oi-wg-s-${i.stage}`} aria-hidden="true" />
      : i.kind === "blocks" ? <svg width="16" height="8" aria-hidden="true"><line x1="0" y1="4" x2="12" y2="4" className="oi-sbb-edge oi-sbb-blocks" /><path d="M10 1L15 4L10 7z" className="oi-sbb-arrowhead" /></svg>
      : i.kind === "part" ? <svg width="16" height="8" aria-hidden="true"><line x1="0" y1="4" x2="16" y2="4" className="oi-sbb-edge oi-sbb-sub" /></svg>
      : <i className="oi-sbb-ldot oi-sbb-ring" aria-hidden="true" />}{i.label}</li>)}</ul>;
}

/** GRAPH-4: the picture rescopes to the selected bead's epic, so say what it shows and let the reader widen it. */
function MiniCaption({ snap, epic, onAll }: { snap: WorkSurfaceSnapshot; epic: string | null; onAll(): void }) {
  const c = miniCaption(snap, epic);
  return <div className="oi-sbb-cap"><span title={c.text}>{c.text}</span>{c.scoped && <button type="button" className="oi-sbb-capbtn" onClick={onAll}>show all</button>}</div>;
}

/** The sidebar's bottom panel: ONE panel with pill tabs [ Next up N ] [ Commits N ] [ Graph N ]. It scrolls inside its own max height. */
export function SidebarBottom(p: SidebarBottomProps) {
  const [tab, setTab] = useState<BottomTab>(loadTab);
  const [all, setAll] = useState(false), [wholeTracker, setWholeTracker] = useState(false);
  const now = p.now ?? 0;
  const decisions = useMemo(() => (p.snap ? decisionsWaiting(p.snap, now) : []), [p.snap, now]);
  const epic = useMemo(() => (p.snap && !wholeTracker ? epicOf(p.snap, p.selectedId ?? null) : null), [p.snap, p.selectedId, wholeTracker]);
  const stages = useMemo(() => (p.snap ? currentStages(p.snap, now || Date.now()) : new Map<string, Stage>()), [p.snap, now]);
  const mini = useMemo(() => (p.snap ? miniGraphLayout(p.snap, epic, MINI_W, MINI_H) : null), [p.snap, epic]);
  const items = p.nextUp ?? [];
  const hasCommits = !!p.commits, hasGraph = GRAPH_ENABLED && !!p.snap;
  const tabs: { id: BottomTab; label: string; n: number | null; unit?: string; tip: string }[] = [
    { id: "nextup", label: "Next up", n: p.nextUp ? items.length + decisions.length : null, tip: "What is next, with decisions waiting on you pinned to the top" },
    ...(hasCommits ? [{ id: "commits" as const, label: "Commits", n: commitsToday(p.commits!, now || Date.now()), tip: "Commits made today; the list shows the latest ones" }] : []),
    ...(hasGraph ? [{ id: "graph" as const, label: "Graph", n: miniBadge(mini!).n, unit: miniBadge(mini!).unit, tip: "Beads in the graph below that are blocked by another open bead" }] : []),
  ];
  const active: BottomTab = tabs.some(t => t.id === tab) ? tab : "nextup";
  const choose = (t: BottomTab) => { setTab(t); saveTab(t); };
  const shown = all ? items : items.slice(0, NEXT_UP_LIMIT);
  const nextUpBody = <>
    {decisions.map(d => <button type="button" key={d.id} className="oi-sb-row oi-sbb-pin" title={`${d.title} (${d.shortId})`} onClick={() => p.onSelectBead?.(d.id)}>
      <span className="oi-sb-l1"><span className="oi-sb-attention" aria-hidden="true">●</span> {cleanText(d.title)}</span>
      <span className={`oi-sb-l2 oi-sbb-t-${delayTone(d)}`}>{delayText(d)}</span>
    </button>)}
    {p.nextUp === null ? <div className="oi-sb-note">{p.nextUpNote ?? "…"}</div>
      : items.length === 0 && decisions.length === 0 ? <div className="oi-sb-note">Nothing now or waiting</div>
      : <>
        {shown.map(i => <button type="button" key={`${i.projectId}/${i.workId}`} className="oi-sb-row" onClick={() => p.onNextUp?.(i)}>
          <span className="oi-sb-l1">{i.projectName} · {i.nextAction || i.title || i.workId}</span>
          {i.status === "waiting" && <span className={`oi-sb-l2${i.ownerWaiting ? " oi-sb-attention" : ""}`}>waiting on {i.waitingOn ?? "—"}</span>}
        </button>)}
        {items.length > NEXT_UP_LIMIT && <button type="button" className="oi-sb-more" onClick={() => setAll(a => !a)}>{all ? "show fewer" : `show all ${items.length}`}</button>}
      </>}
  </>;
  if (tabs.length === 1) return <div className="oi-sbb-body">{nextUpBody}</div>; // today's list, no tabs
  return <div className="oi-sbb">
    <div className="oi-sbb-tabs" role="tablist" aria-label={GRAPH_ENABLED ? "Next up, commits and graph" : "Next up and commits"}>
      {tabs.map(t => <button type="button" key={t.id} role="tab" aria-selected={active === t.id} title={t.tip} className={`oi-sbb-tab${active === t.id ? " on" : ""}`} onClick={() => choose(t.id)}>
        {t.label}{t.n !== null && <span className="oi-sbb-n">{t.n}{t.unit ? ` ${t.unit}` : ""}</span>}
      </button>)}
    </div>
    <div className="oi-sbb-body" role="tabpanel">
      {active === "nextup" ? nextUpBody
        : active === "commits" ? (p.commits!.length === 0 ? <div className="oi-sb-note">No commits to show</div>
          : p.commits!.map(c => <button type="button" key={c.sha} className="oi-sbb-commit" title={`${shortSha(c.sha)} · ${c.branch || "no branch"} · ${c.author}`} onClick={() => p.onOpenCommit?.(c.sha)}>
            <span className="oi-sbb-cdot" style={{ background: laneVar(c.lane) }} aria-hidden="true" /><span className="oi-sbb-subj">{c.subject}</span><span className="oi-sbb-age">{relativeAge(c.at, now || Date.now())}</span>
          </button>))
        : <><MiniCaption snap={p.snap!} epic={epic} onAll={() => setWholeTracker(true)} /><MiniGraph g={mini!} stages={stages} selectedId={p.selectedId ?? null} onOpenGraph={p.onOpenGraph} /><MiniLegend g={mini!} stages={stages} /></>}
    </div>
  </div>;
}

export const sidebarBottomStyles = `
.oi-sbb{display:flex;flex-direction:column;min-width:0}
.oi-sbb-tabs{display:flex;flex-wrap:wrap;gap:3px;padding:3px 6px}
.oi-sbb-tab{display:inline-flex;align-items:baseline;gap:4px;padding:1px 7px;font:inherit;font-size:10px;color:var(--oi-muted);background:transparent;border:1px solid var(--oi-border);border-radius:10px;cursor:pointer}
.oi-sbb-tab:hover{background:var(--oi-hover)}
.oi-sbb-tab.on{color:var(--oi-text);background:var(--oi-selected);border-color:var(--oi-tone-info)}
.oi-sbb-tab:focus-visible{outline:1px solid var(--oi-tone-info)}
.oi-sbb-n{font-variant-numeric:tabular-nums;font-size:9px;color:var(--oi-tone-muted)}
.oi-sbb-body{display:flex;flex-direction:column;min-width:0;max-height:min(260px,38vh);overflow-y:auto;overflow-x:hidden}
.oi-sbb-pin{border-left:2px solid var(--oi-tone-attention);padding-left:12px}
.oi-sbb-t-muted{color:var(--oi-muted)}.oi-sbb-t-attention{color:var(--oi-tone-attention)}.oi-sbb-t-failure{color:var(--oi-tone-failure)}
.oi-sbb-commit{display:flex;align-items:center;gap:6px;min-width:0;width:100%;padding:2px 6px 2px 10px;font:inherit;color:inherit;text-align:left;background:transparent;border:0;cursor:pointer}
.oi-sbb-commit:hover{background:var(--oi-hover)}
.oi-sbb-commit:focus-visible{outline:1px solid var(--oi-tone-info);outline-offset:-1px}
.oi-sbb-cdot{flex:none;width:7px;height:7px;border-radius:50%}
.oi-sbb-subj{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-sbb-age{flex:none;font-size:10px;font-variant-numeric:tabular-nums;color:var(--oi-muted)}
.oi-sbb-mini{display:block;width:100%;height:auto;max-height:100%;padding:2px 4px}
.oi-sbb-edge{stroke-width:1.2}
.oi-sbb-blocks{stroke:var(--oi-tone-failure)}
.oi-sbb-sub{stroke:var(--oi-tone-muted);stroke-dasharray:3 2;opacity:.55}
${stageColorCss}
.oi-sbb-dot{fill:var(--oi-wg-c);stroke:var(--oi-bg);stroke-width:1;cursor:pointer}
.oi-sbb-dot.sel{stroke:var(--oi-text);stroke-width:2}
.oi-sbb-arrowhead{fill:var(--oi-tone-failure)}
.oi-sbb-dlabel{font-size:8px;fill:var(--oi-text);pointer-events:none}
.oi-sbb-cap{display:flex;align-items:baseline;gap:6px;padding:2px 8px;font-size:10px;color:var(--oi-muted)}
.oi-sbb-cap span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-sbb-capbtn{font:inherit;font-size:10px;color:var(--oi-tone-info);background:none;border:0;cursor:pointer;text-decoration:underline}
.oi-sbb-legend{display:flex;flex-wrap:wrap;gap:2px 10px;margin:0;padding:2px 8px 4px;list-style:none;font-size:10px;color:var(--oi-muted)}
.oi-sbb-legend li{display:inline-flex;align-items:center;gap:4px}
.oi-sbb-ldot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--oi-wg-c)}
.oi-sbb-ring{background:transparent;border:2px solid var(--oi-text);box-sizing:border-box}
.oi-sbb-dot:hover,.oi-sbb-dot:focus-visible{stroke:var(--oi-text);outline:none}
`;
