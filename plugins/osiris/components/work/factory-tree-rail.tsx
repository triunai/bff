import { useEffect, useMemo, useRef } from "react";
import type { WorkSurfaceSnapshot } from "../../work/surface-types.ts";
import { historyFromTimestamps } from "../../work/surface-model.ts";
import { buildGraphModel } from "../../work/graph/graph.ts";
import { toBeadIssues } from "../../work/graph/adapter.ts";
import { floorAt, type FloorFrame } from "../../work/factory-floor-model.ts";
import { treeFromSnapshot } from "../../work/tree-layout.ts";
import { STATION_ABBR, STATION_TONE, epicMixes, lockMark, railBeads, railTitle, railHover, showsChip, type EpicMix, type RailBead, type RailOwn } from "../../work/factory-tree-rail-model.ts";
import { BeadTree } from "./bead-tree.tsx";

// The arkham-parity WORK tree fused INTO the Factory (owner 2026-10-07: "combine arkham here with this somehow"; fg-lead design
// decision 7). A REGION component the shell renders in its "rail" grid area: the SAME BeadTree rows (work/tree-layout.ts, no
// fork), each decorated with its bead's current station chip, a live spark dot and a padlock, all read from the floor's own
// FloorFrame; an epic shows n/m and a stacked station-mix bar. The shell owns everything shared: `open` and key T, the one
// hover card (this reports `onHover({id,x,y})`), selection, and `roles` (chainRoles over blockChain, tinting rows: focus =
// accent band, up / down = tinted guide, dim = 40%). A card hovered on the floor passes `hoverId` and its row scrolls into view.

export type FactoryTreeRailProps = {
  snap: WorkSurfaceSnapshot; now: number; selectedId: string | null; onSelect(id: string): void;
  onHover(h: { id: string; x: number; y: number } | null): void;
  roles: ReadonlyMap<string, "focus" | "up" | "down" | "dim"> | null;
  open: boolean; onToggle(): void;
  /** The shell's frame (it computes floorAt once). Absent = the rail computes the live frame itself with the same floorAt. */
  frame?: FloorFrame | null;
  transcriptLive?: ReadonlyMap<string, { lane: string; lastAt: number }> | null;
  /** A bead hovered elsewhere (floor card, iso, timeline): its row scrolls into view. */
  hoverId?: string | null;
  onInspect?(id: string): void;
  /** The stage is scrubbed into the past: the tree stays LIVE, and says so (design 2.4). */
  scrubbed?: boolean;
};

const StationChip = ({ b }: { b: RailBead }) => {
  const mark = lockMark(b);
  return <span className={`oi-ftr-mark${b.group == null ? "" : ` oi-ln-${b.group}`}`} title={railTitle(b)}>
    {b.group != null && <i className="oi-ftr-ws" aria-hidden="true" />}
    <span className={`oi-ftr-chip oi-ftr-t-${STATION_TONE[b.station]} oi-ftr-s-${b.station}`}>{STATION_ABBR[b.station]}</span>
    {b.live && <span className={`oi-ftr-spark${b.spark ? " on" : ""}`} aria-label="agent working">●</span>}
    {mark && <span className="oi-ftr-lock" aria-label={mark.title}>{mark.glyph}</span>}
  </span>;
};

const MixBar = ({ mix, folded }: { mix: EpicMix; folded: boolean }) => <span className={`oi-ftr-mix${folded ? " folded" : ""}`} title={`${mix.done}/${mix.total} finished · ${mix.text || "no station yet"}`}>
  <span className="oi-ftr-bar" aria-hidden="true">{mix.segs.map(s => <i key={s.station} className={`oi-ftr-s-${s.station}`} style={{ width: `${s.pct}%` }} />)}</span>
</span>;

const EMPTY: ReadonlyMap<string, "focus" | "up" | "down" | "dim"> = new Map();

export function FactoryTreeRail(p: FactoryTreeRailProps) {
  const box = useRef<HTMLElement>(null), pointer = useRef({ x: 0, y: 0 }), mine = useRef<RailOwn>(null);
  const events = useMemo(() => historyFromTimestamps(p.snap), [p.snap]);
  const graph = useMemo(() => buildGraphModel(toBeadIssues(p.snap)), [p.snap]);
  const frame = useMemo(() => p.frame ?? floorAt(p.snap, events, p.now, p.now, { graph, transcriptLive: p.transcriptLive ?? null }), [p.frame, p.snap, events, p.now, graph, p.transcriptLive]);
  const beads = useMemo(() => railBeads(frame, p.now), [frame, p.now]);
  // an UNFOLDED layout, so an epic's mix still counts the kids its folded row hides
  const mixes = useMemo(() => epicMixes(treeFromSnapshot(p.snap, p.now, { showDone: true }).lines, id => beads.get(id)?.station ?? null), [p.snap, p.now, beads]);
  const liveN = useMemo(() => [...beads.values()].filter(b => b.live).length, [beads]);
  useEffect(() => { // a card hovered on the floor brings its row into view
    if (!p.open || !p.hoverId) return;
    Array.from(box.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []).find(r => r.dataset.id === p.hoverId)?.scrollIntoView({ block: "nearest" });
  }, [p.open, p.hoverId]);
  if (!p.open) return <aside className="oi-ftr oi-ftr-shut" ref={box} aria-label="Work tree rail, hidden">
    <button type="button" className="oi-ftr-sliver" title={`Show the work tree${liveN ? ` · ${liveN} agent${liveN === 1 ? "" : "s"} working` : ""} (T)`} aria-expanded="false" onClick={p.onToggle}>
      <span aria-hidden="true">▸</span><span className="oi-ftr-count">{liveN > 0 ? `◍ ${liveN}` : "tree"}</span>
    </button>
  </aside>;
  return <aside className="oi-ftr" ref={box} aria-label="Work tree rail" onMouseMove={e => { pointer.current = { x: e.clientX, y: e.clientY }; }}
    onKeyDown={e => { if (e.key !== " " && e.key !== "ArrowLeft" && e.key !== "ArrowRight") return; e.stopPropagation(); const t = (e.target as HTMLElement).tagName; if (t !== "BUTTON" && t !== "INPUT") e.preventDefault(); }}>
    {p.scrubbed && <span className="oi-ftr-live" title="The stage shows the past; this tree is always live">live</span>}
    <button type="button" className="oi-ftr-toggle" title="Hide the work tree (T)" aria-expanded="true" onClick={p.onToggle}>◂</button>
    <BeadTree snap={p.snap} now={p.now} selectedId={p.selectedId} onSelect={p.onSelect} onInspect={p.onInspect} roles={p.roles ?? EMPTY}
      onHoverRow={(id, anchor, via) => {
        if (!via) return;
        const step = railHover(mine.current, { kind: id !== null ? (via.kind === "pointer" ? "enter" : "focus") : (via.kind === "pointer" ? "leave" : "blur"), id: via.origin, floorHoverId: p.hoverId ?? null });
        mine.current = step.next;
        if (step.emit === "clear") p.onHover(null); else if (step.emit) p.onHover({ id: step.emit.set, ...(anchor ?? pointer.current) });
      }}
      lead={id => { const b = beads.get(id); return showsChip(b, mixes.has(id)) ? <StationChip b={b} /> : null; }}
      trail={(id, folded) => { const m = mixes.get(id); return m ? <MixBar mix={m} folded={folded} /> : null; }} />
  </aside>;
}

// Tokens only (ui-tokens.test.ts scans .tsx). Region sizing (28px sliver, ~260 normal / 300 full screen) is the shell's grid
// column (--ff-rail); the rail just fills it. Chips use the floor's station tones. The toggles are flat (nesting fitness test).
export const factoryTreeRailStyles = `
${Array.from({ length: 8 }, (_, n) => `.oi-ftr .oi-ln-${n}{--lane:var(--oi-lane-${n})}`).join("")}
.oi-ftr-ws{display:inline-block;width:3px;height:11px;margin-right:3px;border-radius:1px;background:var(--lane);vertical-align:-1px}
.oi-ftr{position:relative;min-width:0;min-height:0;height:100%;overflow:auto;background:var(--oi-panel);box-shadow:inset -1px 0 0 var(--oi-border)}
.oi-ftr-shut{overflow:hidden}
.oi-ftr-toggle,.oi-ftr-sliver{padding:0;border:0;background:transparent;color:var(--oi-text);cursor:pointer;font:inherit;line-height:1}
.oi-ftr-toggle{position:absolute;top:4px;right:4px;z-index:1;width:20px;height:20px;border-radius:3px}
.oi-ftr-toggle:hover,.oi-ftr-sliver:hover{background:var(--oi-hover)}
.oi-ftr-sliver{display:flex;flex-direction:column;align-items:center;gap:8px;width:100%;height:100%;padding-top:8px}
.oi-ftr-count{writing-mode:vertical-rl;font:700 10px/1 var(--oi-font-mono,ui-monospace,monospace);color:var(--oi-tone-success);letter-spacing:.06em}
.oi-ftr .oi-bt-root{padding-right:30px}
.oi-ftr-live{position:absolute;top:7px;right:30px;z-index:1;font:700 9px/1 var(--oi-font-mono,ui-monospace,monospace);letter-spacing:.06em;text-transform:uppercase;color:var(--oi-muted)}
.oi-ftr-mark{flex:none;display:inline-flex;align-items:center;gap:3px}
.oi-ftr-chip{padding:0 3px;border-radius:2px;font:700 9px/13px var(--oi-font-mono,ui-monospace,monospace);letter-spacing:.04em;color:var(--oi-bg);background:var(--ftr-c)}
.oi-ftr-t-info{--ftr-c:var(--oi-tone-info)}.oi-ftr-t-running{--ftr-c:var(--oi-tone-running)}.oi-ftr-t-attention{--ftr-c:var(--oi-tone-attention)}.oi-ftr-t-success{--ftr-c:var(--oi-tone-success)}
.oi-ftr-chip.oi-ftr-s-claim{background:transparent;color:var(--ftr-c);box-shadow:inset 0 0 0 1px var(--ftr-c)}
.oi-ftr-spark{font-size:8px;line-height:1;color:var(--oi-tone-success)}
.oi-ftr-spark.on{animation:oi-ftr-spark 1.1s ease-in-out infinite}
@keyframes oi-ftr-spark{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.7)}}
.oi-ftr-lock{font-size:10px;line-height:1;color:var(--oi-tone-failure)}
.oi-ftr-mix{flex:none;display:inline-flex;align-items:center}
.oi-ftr-bar{display:flex;width:48px;height:6px;overflow:hidden;border-radius:3px;background:var(--oi-border)}
.oi-ftr-mix.folded .oi-ftr-bar{width:72px;height:8px}
.oi-ftr-bar i{display:block;height:100%;background:var(--ftr-c,var(--oi-muted))}
.oi-ftr-bar .oi-ftr-s-intake{--ftr-c:var(--oi-tone-info)}.oi-ftr-bar .oi-ftr-s-claim{--ftr-c:var(--oi-tone-running);opacity:.6}.oi-ftr-bar .oi-ftr-s-build{--ftr-c:var(--oi-tone-running)}
.oi-ftr-bar .oi-ftr-s-gate{--ftr-c:var(--oi-tone-attention)}.oi-ftr-bar .oi-ftr-s-land{--ftr-c:var(--oi-tone-success)}
@media (prefers-reduced-motion:reduce){.oi-ftr-spark.on{animation:none}}
`;
