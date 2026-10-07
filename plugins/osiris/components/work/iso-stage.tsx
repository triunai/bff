import { useLayoutEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { ptClass } from "../../work/priority-tone.ts";
import { glideMs, roadWaypoints, staggerMs, travelMs, type Waypoint } from "../../work/iso-travel.ts";
import type { ChainEdge } from "../../work/block-chain.ts";
import { fitId, type FloorFrame, type HeatMode, type StationId } from "../../work/factory-floor-model.ts";
import { HATCH_STEPS, hatchInkVar, hatchOpacity, heatColorVar } from "../../work/heat-ramps.ts";
import { BOT, BOT_FACES, NAME_PX, CRATE_FACES, CRATE_RING, CRATE_SILHOUETTE, ISO, NO_FX, TOP, beltFrame, beltPath, boxFaces, crateHeat, digitsOf, edgeLayers, isoScene, rectAnchor, reduceStageHover, type StageHover, isoViewBox, lanePath, proj, type IsoBot, type IsoCrate, type IsoFxInput, type IsoLabel, type IsoPart, type P, type PulseKind } from "../../work/iso-layout.ts";

/** The isometric Factory STAGE: a renderer, fed a finished frame. It projects and paints what the frame holds (every token and
 * worker, nothing added or dropped), draws the dependency arrows it is handed, dims by the roles it is handed, and reports
 * hover and selection upward. It draws NO toolbar, hover card or legend (the shell owns those) and derives no work state: it
 * never builds a chain, a trail or a weather line itself. Reduced motion: nothing moves (the state is still drawn).
 * Arrows: solid = waits on, dashed = waits on it. */
export type IsoRole = "focus" | "up" | "down" | "dim";
export type IsoHover = { id: string; x: number; y: number };
export type IsoStageProps = {
  frame: FloorFrame; selectedId: string | null; onSelect(id: string): void; onHover(h: IsoHover | null): void;
  /** The focus chain (drawn on top). */
  chainEdges: readonly ChainEdge[]; roles: ReadonlyMap<string, IsoRole> | null; reduced: boolean;
  /** Replay PLAYBACK (not scrub, not pause) at `speed`x: crates travel like live with durations divided by the speed (work/iso-travel.ts). */
  playing?: boolean; speed?: number;
  /** Effects (weather lines, sparking lanes) from the scene; absent = none are drawn. */
  fx?: IsoFxInput | null;
  /** Beads just sent back, to ride the return lane for a moment. */
  lane?: ReadonlySet<string> | null;
  /** The bead under the pointer, for its id tag and its holographic outline. */
  hoverId?: string | null;
  /** One-shot effects per bead (pulsesOf(frame), kept for a moment by the caller: ONE clock, no timers here). */
  pulses?: ReadonlyMap<string, PulseKind> | null;
  /** Machine hover: reported upward (the shell shows the number panel), and the machine under the pointer gets its scan line and lit crates. */
  onStation?(h: { id: StationId; x: number; y: number } | null): void;
  hoverStation?: StationId | null;
  /** Every chain on the floor, drawn faint under the focus chain (so a focus does not lose the unrelated ones). */
  allEdges?: readonly ChainEdge[] | null;
  /** The heat mode (null/absent = off): crates are painted from their frame heatStep with that mode's colour family. */
  heat?: HeatMode | null;
  /** The +N plate under the pointer or focus: who it hides (the frame's own overflowIds), so the shell can list them. */
  onPlate?(h: { id: StationId; ids: readonly string[]; x: number; y: number } | null): void;
  /** How many beads the Land archive vault holds (work/land-prune); absent = no vault is drawn. */
  archived?: number | null;
  /** How many went into the vault today ("archived N · today M"), and how many in the latest prune (their crates arc from the dock to the vault once, on mount of that value). */
  archivedToday?: number | null; archivedDelta?: number | null;
};

const GRID = { x0: -4, x1: 14, y0: -14, y1: 5 };
const gridLines = (() => {
  const out: { key: string; a: P; b: P }[] = [];
  for (let x = GRID.x0; x <= GRID.x1; x++) out.push({ key: `x${x}`, a: proj(x, GRID.y0), b: proj(x, GRID.y1) });
  for (let y = GRID.y0; y <= GRID.y1; y++) out.push({ key: `y${y}`, a: proj(GRID.x0, y), b: proj(GRID.x1, y) });
  return out;
})();
const FLOOR_PLATE = boxFaces({ x0: GRID.x0, x1: GRID.x1, y0: GRID.y0, y1: GRID.y1, z0: 0, z1: 0 }).top;
const w2 = ISO.BELT_W / 2;
/** The two belt arms as slabs (arm A, then arm B over it at the corner). */
const BELT_SLABS = [boxFaces({ x0: 0, x1: ISO.LA + w2, y0: -w2, y1: w2, z0: 0, z1: ISO.BELT_H }), boxFaces({ x0: ISO.LA - w2, x1: ISO.LA + w2, y0: -(ISO.END - ISO.LA), y1: w2, z0: 0, z1: ISO.BELT_H })];
const path = (ps: readonly P[]) => ps.map((p, k) => `${k ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
const BELT_D = path(beltPath());
const SPARK_D = "M0 -3L.8 -.8L3 0L.8 .8L0 3L-.8 .8L-3 0L-.8 -.8Z", SPARK_OFFSETS = [[-26, 2], [22, -3], [-8, 6], [12, 5], [-18, -4], [30, 3]];

const Faces = (q: { f: { top: string; left: string; right: string } }) => <><polygon className="oi-iso-fl" points={q.f.left} /><polygon className="oi-iso-fr" points={q.f.right} /><polygon className="oi-iso-ft" points={q.f.top} /></>;
const Padlock = (q: { y: number }) => <g className="oi-iso-lock" transform={`translate(0 ${q.y})`} aria-hidden="true"><path className="oi-iso-shackle" d="M-2.6 0V-2.4a2.6 2.6 0 0 1 5.2 0V0" /><rect className="oi-iso-lockbody" x="-3.8" y="0" width="7.6" height="5.6" rx="1.2" /></g>;
const roleClass = (r: IsoRole | undefined) => (r ? ` dep-${r}` : "");

function Part(q: { part: IsoPart; press: boolean; beam: boolean; claimBusy: boolean; swing: boolean; hot: boolean; frozen: boolean; slam: number }) {
  const { part: m } = q, on = m.role === "piston" ? q.press : m.role === "beam" ? q.beam : m.role === "claw" ? q.claimBusy : false, idle = m.idle ? " idle" : "";
  if (m.role === "beam") { // a thin plane: draw its wide face, with a scan line rising through it while a work item is in review
    const f = m.b, a = proj(f.x0, f.y1, f.z0), b = proj(f.x1, f.y1, f.z0);
    return <g className={`oi-iso-part oi-iso-s-${m.station} r-beam${on ? " on" : ""}${q.frozen ? " frozen" : ""}${idle}`} data-station={m.station} aria-hidden="true"><polygon className="oi-iso-beampane" points={m.faces.left} />{on && <line className="oi-iso-scan" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />}</g>;
  }
  return <g className={`oi-iso-part oi-iso-s-${m.station} r-${m.role}${on ? " live" : ""}${m.role === "claw" && q.swing ? " swing" : ""}${m.role === "head" && q.hot ? " hot" : ""}${idle}`} data-station={m.station} style={m.role === "piston" ? { ["--slam" as string]: `${q.slam.toFixed(2)}s` } : undefined} aria-hidden="true"><Faces f={m.faces} /></g>;
}

/** The marks that sit above a crate: padlock, priority dot, selection outline, hover hologram and id tag. A hovered or selected crate's marks are drawn in the top layer (so a nearer crate or agent cannot cover them); every other crate's stay with it. */
function CrateMarks(q: { c: IsoCrate; hovered: boolean }) {
  const { c, hovered } = q, k = c.token, lockedOrBlocked = k.blocked || k.lock !== null;
  return <>
    {lockedOrBlocked && <Padlock y={-ISO.CRATE_H - 9} />}
    {ptClass(k) && <circle className={`oi-iso-prio ${ptClass(k)}`} cx="0" cy={-ISO.CRATE_H - (lockedOrBlocked ? 16 : 5)} r="2.2" />}
    {c.selected && <polygon className="oi-iso-sil" points={CRATE_SILHOUETTE} />}
    {hovered && !c.selected && <polygon className="oi-iso-holo" points={CRATE_SILHOUETTE} aria-hidden="true" />}
    {(c.selected || hovered) && <text className="oi-iso-tag" y={-ISO.CRATE_H - (lockedOrBlocked ? 20 : 10)} textAnchor="middle">#{k.shortId}</text>}
  </>;
}

/** What a crate or agent reports about hover: its own focus and blur (the stage's reducer decides what a blur may clear). */
type HoverApi = { focus(id: string, el: Element): void; blur(id: string): void };
function Crate(q: { move: { ms: number; delay: number } | null; pathed: boolean; c: IsoCrate; heat: ReturnType<typeof crateHeat>; hovered: boolean; lit: boolean; tiny: boolean; role: IsoRole | undefined; onSelect(id: string): void; hover: HoverApi }) {
  const { c, hovered } = q, k = c.token, top = c.selected || hovered;
  const cls = ["oi-iso-crate", `oi-iso-s-${k.station}`, `oi-ln-${k.group}`, k.blocked && "blocked", k.lock && "locked", c.lane && "sentback", q.pathed && "pathed", k.critical && "crit", c.selected && "sel", hovered && "hov", q.lit && "lit", c.scanning && "scanning", c.pulse && `p-${c.pulse}`, q.heat && "heat", q.heat?.hatch && `hatch-${q.heat.step}`, ptClass(k)].filter(Boolean).join(" ") + roleClass(q.role);
  return <g data-tid={k.id} className={cls} style={{ transform: `translate(${c.at.x.toFixed(1)}px,${c.at.y.toFixed(1)}px)`, ...(q.move ? { ["--travel-ms" as string]: `${q.move.ms}ms`, ["--travel-delay" as string]: `${q.move.delay}ms` } : {}), ...(q.heat ? { ["--iso-heat" as string]: q.heat.fill, ["--iso-heat-ink" as string]: q.heat.ink } : {}) }} role="button" tabIndex={0} aria-pressed={c.selected}
    aria-label={`${k.shortId} ${k.title}${k.blocked ? ", waiting on another work item" : ""}${k.lock ? ", locked" : ""}${k.critical ? ", on the critical path" : ""}`}
    onClick={() => q.onSelect(k.id)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); q.onSelect(k.id); } }}
    onFocus={e => q.hover.focus(k.id, e.currentTarget)} onBlur={() => q.hover.blur(k.id)}>
    <g className="oi-iso-cbody" key={c.pulse ?? "-"}>
      {k.critical && <polygon className="oi-iso-ring" points={CRATE_RING} />}
      <polygon className="oi-iso-fl" points={CRATE_FACES.left} /><polygon className="oi-iso-fr" points={CRATE_FACES.right} /><polygon className="oi-iso-ft" points={CRATE_FACES.top} />
      {q.tiny ? <text className="oi-iso-qn" y={-ISO.CRATE_H + 1.5} textAnchor="middle" aria-hidden="true">{c.pos || ""}</text>
        : <text className="oi-iso-cid" transform={`translate(${-ISO.CRATE * ISO.U / 2} ${-ISO.CRATE_H}) skewY(26.565)`} x="1.5" y="9.6" aria-hidden="true">{fitId(k.shortId, 5)}</text>}
      {k.blocked && <text className="oi-iso-nogo" y={-ISO.CRATE_H + 5} textAnchor="middle" aria-hidden="true">⊘</text>}
      {c.lane && !k.blocked && <text className="oi-iso-nogo back" y={-ISO.CRATE_H + 5} textAnchor="middle" aria-hidden="true">↩</text>}
      {c.stamp && <text className="oi-iso-stamp" y={-ISO.CRATE_H - 4} textAnchor="middle" aria-hidden="true">{c.stamp}</text>}
      {c.scanning && <line className="oi-iso-cscan" x1={-ISO.CRATE * ISO.U / 2} y1={-ISO.CRATE_H} x2={ISO.CRATE * ISO.U / 2} y2={-ISO.CRATE_H} aria-hidden="true" />}
    </g>
    {!top && <CrateMarks c={c} hovered={hovered} />}
  </g>;
}

function Bot(q: { b: IsoBot; role: IsoRole | undefined; onSelect(id: string): void; hover: HoverApi; idx: number }) {
  const w = q.b.worker, id = w.beadId, tag = w.badge.glyph || "?";
  return <g className={`oi-iso-bot ${w.presence} oi-iso-m-${w.badge.model ?? "none"}${w.stale ? " stale" : ""}${w.critical ? " crit" : ""}${roleClass(q.role)}`} style={{ transform: `translate(${q.b.at.x.toFixed(1)}px,${q.b.at.y.toFixed(1)}px)` }} role="button" tabIndex={0}
    aria-label={`${w.badge.title} on ${id}. Select its work item`} onClick={() => q.onSelect(id)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); q.onSelect(id); } }}
    onFocus={e => q.hover.focus(id, e.currentTarget)} onBlur={() => q.hover.blur(id)}>
    <title>{`${w.badge.title}${w.presence === "live" ? " · working" : w.presence === "ghost" ? " · claimed, no sign of life" : ""}`}</title>
    <ellipse className="oi-iso-botshadow" cx="0" cy="1" rx="9" ry="4.5" />
    <g className="oi-iso-bobber" style={{ animationDelay: `-${(q.idx % 7) * 0.17}s` }}>
      <Faces f={BOT_FACES.body} /><Faces f={BOT_FACES.head} />
      <rect className="oi-iso-eye" x="-3" y={-BOT.torso - 4.5} width="6" height="1.8" rx=".9" />
      <g transform={`translate(0 ${-BOT.h - 8})`}><circle className="oi-iso-badge" r={w.badge.glyph.length > 1 ? 9.6 : 8} /><text className="oi-iso-letter" y="3.4" textAnchor="middle">{tag}</text><text className="oi-iso-num" x={w.badge.glyph.length > 1 ? 11.5 : 10} y="3.4" aria-hidden="true">{q.b.num}</text></g>
      {q.b.sparking && <g transform={`translate(9 ${-BOT.h - 14})`} aria-hidden="true"><path className="oi-iso-botspark" d={SPARK_D} /></g>}
    </g>
  </g>;
}

/** A rolling digit counter: each digit is a column of 0-9 that slides to its value (CSS transition; static under reduced motion). */
function Odo(q: { value: number; x: number; y?: number; className?: string }) {
  const ds = digitsOf(q.value);
  return <g className={`oi-iso-odo ${q.className ?? ""}`} transform={`translate(${q.x} ${q.y ?? -15.5})`} aria-hidden="true">
    {ds.map((d, i) => <svg key={`${ds.length}:${i}`} x={i * ODO.W} y="0" width={ODO.W} height={ODO.H} overflow="hidden"><g className="oi-iso-odocol" style={{ transform: `translateY(${-d * ODO.H}px)` }}>{Array.from({ length: 10 }, (_, n) => <text key={n} className="oi-iso-odod" x={ODO.W / 2} y={ODO.H * n + 16.5} textAnchor="middle">{n}</text>)}</g></svg>)}
  </g>;
}
const ODO = { W: 11, H: 21 };

function Label(q: { l: IsoLabel; onPlate?(h: { id: StationId; ids: readonly string[]; x: number; y: number } | null): void }) {
  const { l } = q, plate = l.more > 0 ? `+${l.more}${l.oldest ? ` · oldest ${l.oldest}` : ""}` : null, wTxt = plate ? Math.max(34, plate.length * 6.2 + 14) : 0;
  return <g className={`oi-iso-lbl oi-iso-s-${l.id}${l.over ? " over" : ""}${l.idle ? " idle" : ""}`}>
    <g transform={`translate(${l.at.x.toFixed(1)} ${l.at.y.toFixed(1)})`} aria-hidden="true">
      <line className="oi-iso-tick" x1="0" y1={l.showSub ? (l.showP50 ? 32 : 20) : 8} x2="0" y2={(l.showSub ? (l.showP50 ? 40 : 28) : 16) + l.lift} />
      <text className="oi-iso-label" x={-(l.text.length * NAME_PX + 7 + digitsOf(l.count).length * ODO.W) / 2} textAnchor="start">{l.text}</text>
      <Odo value={l.count} x={-(l.text.length * NAME_PX + 7 + digitsOf(l.count).length * ODO.W) / 2 + l.text.length * NAME_PX + 7} />
      {l.showSub && <text className="oi-iso-sub" y="14" textAnchor="middle">{l.sub}</text>}{l.showSub && l.showP50 && l.p50 && <text className="oi-iso-sub" y="26" textAnchor="middle">{l.p50}</text>}</g>
    <g transform={`translate(${l.plateAt.x.toFixed(1)} ${l.plateAt.y.toFixed(1)})`}>
      {plate && <g className="oi-iso-plate" tabIndex={0} role="img" aria-label={`${l.more} more ${l.text.toLowerCase()} work items not drawn${l.hiddenText ? `: ${l.hiddenText}` : ""}`} onPointerEnter={e => q.onPlate?.({ id: l.id, ids: l.hidden, x: e.clientX, y: e.clientY })} onPointerLeave={() => q.onPlate?.(null)} onFocus={e => { const r = (e.currentTarget as unknown as Element).getBoundingClientRect(); q.onPlate?.({ id: l.id, ids: l.hidden, x: r.left, y: r.bottom }); }} onBlur={() => q.onPlate?.(null)}><title>{`${l.more} more work item${l.more === 1 ? "" : "s"} here, not drawn${l.hiddenText ? `: ${l.hiddenText}` : ""}${l.oldest ? `. The oldest one drawn here has been here ${l.oldest}.` : ""}`}</title><rect x={-wTxt / 2} y="-9" width={wTxt} height="16" rx="8" /><text textAnchor="middle" y="3">{plate}</text></g>}
      {l.weather && <text className="oi-iso-weather" textAnchor="middle" y={plate ? 22 : 4}><title>{l.weather.title}</title>{l.weather.text}</text>}
    </g>
  </g>;
}

/** An arrow from the blocker to the bead it blocks, bowed upward. */
const arrowPath = (a: P, b: P) => { const m = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 24 - Math.abs(a.x - b.x) * 0.12 }; return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${m.x.toFixed(1)} ${m.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`; };

export function IsoStage(p: IsoStageProps) {
  const { frame } = p;
  const scene = useMemo(() => isoScene(frame, { selectedId: p.selectedId, lane: p.lane ?? null, fx: p.fx ?? NO_FX, pulses: p.pulses ?? null, archived: p.archived ?? null, archivedToday: p.archivedToday ?? null, archivedDelta: p.archivedDelta ?? null }), [frame, p.selectedId, p.lane, p.fx, p.pulses, p.archived, p.archivedToday, p.archivedDelta]);
  const vb = useMemo(() => isoViewBox(scene), [scene]);
  const anchor = useMemo(() => new Map(scene.items.flatMap(i => (i.kind === "crate" ? [[i.token.id, { x: i.at.x, y: i.at.y - ISO.CRATE_H / 2 }] as const] : []))), [scene]);
  const lanePts = useMemo(() => path(lanePath(scene.layout)), [scene.layout]);
  const bots = scene.items.filter((i): i is IsoBot => i.kind === "bot"), roleOf = (id: string) => p.roles?.get(id);
  const topCrates = scene.items.filter((i): i is IsoCrate => i.kind === "crate" && (i.selected || p.hoverId === i.token.id));
  const crowd = useMemo(() => { const n = new Map<StationId, number>(); for (const k of frame.tokens) n.set(k.station, (n.get(k.station) ?? 0) + 1); return n; }, [frame]); // past 24 at a station the crates show their queue number, not their id
  const travel = { reduced: p.reduced, live: frame.live, playing: p.playing, speed: p.speed };
  const moves = useMemo(() => { const m = new Map<string, { ms: number; delay: number }>(); let rank = 0; for (const i of scene.items) if (i.kind === "crate" && i.token.motion) m.set(i.key, { ms: travelMs(i.token.motion, travel), delay: staggerMs(rank++, travel) }); return m; }, [scene, p.reduced, frame.live, p.playing, p.speed]); // eslint-disable-line react-hooks/exhaustive-deps
  const prevPos = useRef(new Map<string, { at: P; station: StationId }>());
  /** Crates that changed station ride the road (the belt polyline, corner included) instead of a straight glide. */
  const roads = useMemo(() => { const m = new Map<string, { pts: Waypoint[]; ms: number; delay: number }>(); for (const i of scene.items) { if (i.kind !== "crate") continue; const mv = moves.get(i.key), was = prevPos.current.get(i.key); if (mv && mv.ms > 0 && was && was.station !== i.token.station && !i.lane) m.set(i.key, { pts: roadWaypoints(scene.layout[was.station].c, scene.layout[i.token.station].c, was.at, i.at), ms: mv.ms, delay: mv.delay }); } return m; }, [scene, moves]);
  const svgRef = useRef<SVGSVGElement>(null);
  // Pause freezes motion mid-travel: when playback stops, each crate keeps its CURRENT (computed) transform instead of finishing its glide;
  // the next frame (a scrub, a resume) hands it back to the normal render.
  const wasPlaying = useRef(false);
  useLayoutEffect(() => {
    const root = svgRef.current; if (!root) return;
    root.querySelectorAll<SVGGElement>(".oi-iso-crate[data-frozen]").forEach(el => { if (el.style.transform === el.dataset.frozen) el.style.transform = el.dataset.orig ?? ""; el.style.transition = ""; delete el.dataset.frozen; delete el.dataset.orig; });
    if (wasPlaying.current && !p.playing && !p.reduced) root.querySelectorAll<SVGGElement>(".oi-iso-crate").forEach(el => { const now = getComputedStyle(el).transform; if (!now || now === "none") return; el.dataset.orig = el.style.transform; el.style.transition = "none"; el.style.transform = now; el.dataset.frozen = now; });
    wasPlaying.current = !!p.playing;
  }, [frame, p.playing]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (typeof Element === "undefined" || typeof Element.prototype.animate !== "function") { for (const i of scene.items) if (i.kind === "crate") prevPos.current.set(i.key, { at: i.at, station: i.token.station }); return; }
    for (const [id, r] of roads) {
      const el = svgRef.current?.querySelector<SVGGElement>(`[data-tid="${CSS.escape(id)}"]`); if (!el) continue;
      el.animate(r.pts.map(w => ({ transform: `translate(${w.x.toFixed(1)}px,${w.y.toFixed(1)}px)`, offset: w.offset })), { duration: r.ms, delay: r.delay, easing: "ease-in-out", fill: "backwards" });
    }
    prevPos.current = new Map(scene.items.flatMap(i => (i.kind === "crate" ? [[i.key, { at: i.at, station: i.token.station }] as const] : [])));
  }, [scene, roads]);
  const slam = Math.max(0.45, 1.3 - scene.fx.press * 0.15);
  const scanLine = useMemo(() => { if (!p.hoverStation) return null; const bs = scene.items.filter((i): i is IsoPart => i.kind === "part" && i.station === p.hoverStation).map(i => i.b); if (!bs.length) return null; const x0 = Math.min(...bs.map(b => b.x0)), x1 = Math.max(...bs.map(b => b.x1)), y1 = Math.max(...bs.map(b => b.y1)); return { a: proj(x0, y1, 0), b: proj(x1, y1, 0), rise: TOP[p.hoverStation] }; }, [scene, p.hoverStation]);
  const claimBusy = (frame.stations.find(s => s.id === "claim")?.count ?? 0) > 0, press = scene.fx.press > 0, beamOn = scene.fx.beam;
  const buildC = scene.layout.build.c;
  const sparkBase = useMemo(() => { const f = beltFrame(buildC).g, o = proj(f.x, f.y, ISO.BELT_H + 4); return SPARK_OFFSETS.map(([dx, dy]) => ({ x: o.x + dx, y: o.y + dy })); }, [buildC]);
  const hoverRef = useRef<StageHover>(null);
  const step = (ev: Parameters<typeof reduceStageHover>[1], at: { x: number; y: number }) => { const r = reduceStageHover(hoverRef.current, ev); hoverRef.current = r.state; if (r.emit === "set" && "id" in ev && ev.id !== null) p.onHover({ id: ev.id, x: at.x, y: at.y }); else if (r.emit === "clear") p.onHover(null); };
  const hoverApi: HoverApi = { focus: (id, el) => step({ type: "focus", id }, rectAnchor(el.getBoundingClientRect())), blur: id => step({ type: "blur", id }, { x: 0, y: 0 }) };
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const el = (e.target as Element).closest?.("[data-tid]") as SVGGElement | null, id = el?.dataset.tid ?? null;
    step({ type: "pointer", id }, { x: e.clientX, y: e.clientY });
    const m = (e.target as Element).closest?.("[data-station]") as SVGGElement | null;
    p.onStation?.(m && id === null ? { id: m.dataset.station as StationId, x: e.clientX, y: e.clientY } : null);
  };
  const layers = edgeLayers(p.allEdges ?? [], p.chainEdges, useMemo(() => new Set(anchor.keys()), [anchor]));
  return <svg ref={svgRef} className="oi-iso-svg" viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} preserveAspectRatio="xMidYMid meet" role="group" aria-label="Factory floor, isometric view: work items moving from intake to landed"
    data-reduced={p.reduced ? "" : undefined} style={{ ["--travel-ms" as string]: `${glideMs(travel)}ms` }} onPointerMove={onMove} onPointerLeave={() => { step({ type: "leave" }, { x: 0, y: 0 }); p.onStation?.(null); }}>
    <defs>
      <radialGradient id="oi-iso-fade" gradientUnits="userSpaceOnUse" cx={vb.x + vb.w / 2} cy={vb.y + vb.h * 0.58} r={vb.w * 0.55}><stop offset="0.25" className="oi-iso-fadeA" /><stop offset="1" className="oi-iso-fadeB" /></radialGradient>
      {HATCH_STEPS.map(n => <pattern key={n} id={`oi-iso-hatch-${n}`} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(135)"><rect width="8" height="8" style={{ fill: `var(${heatColorVar("impact", n)})` }} /><rect width="2" height="8" style={{ fill: `var(${hatchInkVar(n)})`, opacity: hatchOpacity(n) }} /></pattern>)}
      <marker id="oi-iso-arrow-up" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path className="oi-iso-arrowhead up" d="M0 0L10 5L0 10Z" /></marker>
      <marker id="oi-iso-arrow-down" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path className="oi-iso-arrowhead down" d="M0 0L10 5L0 10Z" /></marker>
    </defs>
    <polygon className="oi-iso-floor" points={FLOOR_PLATE} />
    <g aria-hidden="true">{gridLines.map(l => <line key={l.key} className="oi-iso-gridline" x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} />)}</g>
    <g className={`oi-iso-lane${scene.fx.laneActive ? " active" : ""}`} aria-label={`Return lane: ${scene.fx.inRework} being fixed`}>
      <path className="oi-iso-lanebed" d={lanePts} /><path className="oi-iso-laneflow" d={lanePts} />
    </g>
    <g className="oi-iso-belt" aria-hidden="true">{BELT_SLABS.map((f, k) => <Faces key={k} f={f} />)}<path className="oi-iso-flow" d={BELT_D} /></g>
    {scene.items.map(i => i.kind === "part" ? <Part key={i.key} part={i} press={press} beam={beamOn} claimBusy={claimBusy} swing={scene.fx.claimSwing} hot={scene.fx.buildHot} frozen={scene.fx.gateFrozen} slam={slam} />
      : i.kind === "crate" ? <Crate key={i.key} move={moves.get(i.key) ?? null} pathed={roads.has(i.key)} c={i} heat={crateHeat(i.token, p.heat ?? null)} hovered={p.hoverId === i.token.id} lit={p.hoverStation === i.token.station} tiny={(crowd.get(i.token.station) ?? 0) > 24} role={roleOf(i.token.id)} onSelect={p.onSelect} hover={hoverApi} />
      : <Bot key={i.key} b={i} idx={bots.indexOf(i)} role={roleOf(i.worker.beadId)} onSelect={p.onSelect} hover={hoverApi} />)}
    {scanLine && <line className="oi-iso-mscan" x1={scanLine.a.x} y1={scanLine.a.y} x2={scanLine.b.x} y2={scanLine.b.y} style={{ ["--rise" as string]: `${scanLine.rise}px` }} aria-hidden="true" />}
    {(layers.faint.length > 0 || layers.focus.length > 0) && <g className={`oi-iso-deps${layers.focus.length ? " has-focus" : ""}`} aria-hidden="true">
      {layers.faint.map(e => <path key={`a:${e.from}>${e.to}`} className={`oi-iso-dep all ${e.side}${e.met ? " met" : ""}`} d={arrowPath(anchor.get(e.from)!, anchor.get(e.to)!)} markerEnd={`url(#oi-iso-arrow-${e.side})`} />)}
      {layers.focus.map(e => <path key={`${e.from}>${e.to}`} className={`oi-iso-dep ${e.side}${e.met ? " met" : ""}`} d={arrowPath(anchor.get(e.from)!, anchor.get(e.to)!)} markerEnd={`url(#oi-iso-arrow-${e.side})`} />)}</g>}
    {press && <g aria-hidden="true">{sparkBase.slice(0, scene.fx.press).map((s, k) => <g key={k} transform={`translate(${s.x.toFixed(1)} ${s.y.toFixed(1)})`}><path className="oi-iso-spark" d={SPARK_D} style={{ animationDelay: `-${(k * 0.19).toFixed(2)}s` }} /></g>)}</g>}
    {scene.fx.laneActive && (() => { const a = proj(ISO.LA + ISO.LANE_OFF + 0.6, ISO.LANE_OFF + 0.7, 0); return <g className="oi-iso-plate back" transform={`translate(${a.x.toFixed(1)} ${a.y.toFixed(1)})`}><title>{`${scene.fx.inRework} came back from review and are being fixed`}</title><rect x="-46" y="-9" width="92" height="16" rx="8" /><text textAnchor="middle" y="3">↩ {scene.fx.inRework} being fixed</text></g>; })()}
    {topCrates.length > 0 && <g className="oi-iso-top">{topCrates.map(c => <g key={c.key} className={`oi-iso-crate oi-ln-${c.token.group}${c.selected ? " sel" : ""}${p.hoverId === c.token.id ? " hov" : ""}`} style={{ transform: `translate(${c.at.x.toFixed(1)}px,${c.at.y.toFixed(1)}px)` }} aria-hidden="true"><CrateMarks c={c} hovered={p.hoverId === c.token.id} /></g>)}</g>}
    {scene.labels.map(l => <Label key={l.id} l={l} onPlate={p.onPlate} />)}
    {scene.vault && <g className="oi-iso-lbl oi-iso-s-land oi-iso-vaultlbl" transform={`translate(${scene.vault.at.x.toFixed(1)} ${scene.vault.at.y.toFixed(1)})`} role="img" aria-label={`Archive vault: ${scene.vault.n} archived${scene.vault.today === null ? "" : `, ${scene.vault.today} today`}`}><title>{`${scene.vault.n} work items archived out of Land${scene.vault.today === null ? "" : `, ${scene.vault.today} of them today`}`}</title>
      <text className="oi-iso-label" x={-(5 * NAME_PX + 7 + digitsOf(scene.vault.n).length * ODO.W) / 2} textAnchor="start">VAULT</text><Odo value={scene.vault.n} x={-(5 * NAME_PX + 7 + digitsOf(scene.vault.n).length * ODO.W) / 2 + 5 * NAME_PX + 7} />{scene.vault.today !== null && <text className="oi-iso-sub" y="12" textAnchor="middle">{`archived ${scene.vault.n} · today ${scene.vault.today}`}</text>}</g>}
    {scene.vault && scene.vault.delta > 0 && !p.reduced && <g aria-hidden="true" key={`arc:${scene.vault.n}`}>{Array.from({ length: scene.vault.delta }, (_, k) => <g key={k} transform={`translate(${scene.vault!.from.x.toFixed(1)} ${scene.vault!.from.y.toFixed(1)})`}><g className="oi-iso-arc" style={{ ["--dx" as string]: `${(scene.vault!.to.x - scene.vault!.from.x).toFixed(1)}px`, ["--dy" as string]: `${(scene.vault!.to.y - scene.vault!.from.y).toFixed(1)}px`, animationDelay: `${k * 0.25}s` }}><polygon className="oi-iso-fl" points={CRATE_FACES.left} /><polygon className="oi-iso-fr" points={CRATE_FACES.right} /><polygon className="oi-iso-ft" points={CRATE_FACES.top} /></g></g>)}</g>}
  </svg>;
}

export const isoStageStyles = `
.oi-iso-svg{display:block;width:100%;height:auto;max-height:84vh;user-select:none}
.oi-iso-fadeA{stop-color:var(--oi-tone-running);stop-opacity:.4}.oi-iso-fadeB{stop-color:var(--oi-tone-running);stop-opacity:0}
.oi-iso-floor{fill:color-mix(in srgb,var(--oi-bg) 86%,var(--oi-raised))}
.oi-iso-gridline{stroke:url(#oi-iso-fade);stroke-width:1;fill:none}
.oi-iso-s-intake{--tone:var(--oi-station-intake,var(--oi-tone-info))}.oi-iso-s-claim{--tone:var(--oi-station-claim,var(--oi-tone-running))}.oi-iso-s-build{--tone:var(--oi-station-build,var(--oi-tone-attention))}.oi-iso-s-gate{--tone:var(--oi-station-gate,var(--oi-accent,var(--oi-lane-2)))}.oi-iso-s-land{--tone:var(--oi-station-land,var(--oi-tone-success))}
.oi-iso-svg{--tone:var(--oi-tone-running);--iso-accent:var(--oi-accent,var(--oi-tone-info))}
.oi-iso-ft{fill:color-mix(in srgb,var(--oi-text) 11%,var(--oi-raised))}
.oi-iso-fl{fill:color-mix(in srgb,var(--oi-text) 3%,var(--oi-panel))}
.oi-iso-fr{fill:color-mix(in srgb,black 38%,var(--oi-bg))}
.oi-iso-part polygon,.oi-iso-belt polygon{stroke:color-mix(in srgb,var(--tone) 78%,transparent);stroke-width:1;stroke-linejoin:round}
.oi-iso-part .oi-iso-ft{stroke-width:1.3;fill:var(--oi-machine-body,color-mix(in srgb,var(--oi-text) 11%,var(--oi-raised)))}
.oi-iso-part .oi-iso-fl{fill:color-mix(in srgb,black 18%,var(--oi-machine-body,color-mix(in srgb,var(--oi-text) 11%,var(--oi-raised))))}
.oi-iso-part .oi-iso-fr{fill:color-mix(in srgb,black 48%,var(--oi-machine-body,color-mix(in srgb,var(--oi-text) 11%,var(--oi-raised))))}
.oi-iso-part.r-vaultdoor .oi-iso-fl,.oi-iso-part.r-vaultdoor .oi-iso-fr,.oi-iso-part.r-vaultdoor .oi-iso-ft{fill:color-mix(in srgb,var(--tone) 30%,var(--oi-bg))}
.oi-iso-plate:focus-visible{outline:2px solid var(--oi-focus,var(--iso-accent))}
.oi-iso-part{filter:drop-shadow(0 0 2px color-mix(in srgb,var(--tone) 32%,transparent))}
.oi-iso-part.idle{opacity:.55}
.oi-iso-belt{--tone:var(--oi-border-strong)}
.oi-iso-belt .oi-iso-ft{fill:color-mix(in srgb,black 55%,var(--oi-bg))}.oi-iso-belt .oi-iso-fl,.oi-iso-belt .oi-iso-fr{fill:color-mix(in srgb,black 70%,var(--oi-bg))}
.oi-iso-flow{fill:none;stroke:var(--oi-tone-running);stroke-opacity:.9;stroke-width:2.2;stroke-dasharray:7 9;animation:oi-iso-flow 1.6s linear infinite}
.oi-iso-lanebed{fill:none;stroke:color-mix(in srgb,var(--oi-tone-muted) 40%,var(--oi-bg));stroke-width:5;stroke-linejoin:round;stroke-linecap:round;opacity:.55}
.oi-iso-laneflow{fill:none;stroke:var(--oi-tone-muted);stroke-opacity:.6;stroke-width:1.6;stroke-dasharray:4 8;animation:oi-iso-flowback 2.2s linear infinite}
.oi-iso-lane.active .oi-iso-lanebed{stroke:color-mix(in srgb,var(--oi-tone-attention) 55%,var(--oi-bg));opacity:.85}
.oi-iso-lane.active .oi-iso-laneflow{stroke:var(--oi-tone-attention);stroke-opacity:.95}
.r-beam .oi-iso-beampane{fill:color-mix(in srgb,var(--tone) 55%,transparent);stroke:none;opacity:.1}
.r-beam.on .oi-iso-beampane{opacity:.5;animation:oi-iso-pulse 1.6s ease-in-out infinite}
.oi-iso-scan{stroke:var(--tone);stroke-width:2.2;filter:drop-shadow(0 0 3px var(--tone));animation:oi-iso-scan 1.8s ease-in-out infinite}
.r-piston.live{animation:oi-iso-press var(--slam,.9s) cubic-bezier(.6,0,.9,.4) infinite}
.r-head.hot .oi-iso-ft{animation:oi-iso-shimmer .7s ease-in-out infinite}
.r-beam.frozen .oi-iso-beampane{fill:color-mix(in srgb,var(--oi-tone-failure) 45%,transparent);animation:none;opacity:.55;stroke:var(--oi-tone-failure);stroke-width:1;stroke-dasharray:3 3}
.r-beam.frozen .oi-iso-scan{animation:none;stroke:var(--oi-tone-failure)}
.oi-iso-part.r-claw.swing{animation:oi-iso-swing 1.2s ease-in-out}
.r-claw.live{animation:oi-iso-sway 2.2s ease-in-out infinite}
.oi-iso-spark,.oi-iso-botspark{fill:var(--oi-tone-attention);animation:oi-iso-spark 1.1s ease-out infinite;transform-box:fill-box;transform-origin:center;filter:drop-shadow(0 0 3px var(--oi-tone-attention))}
.oi-iso-crate{--lane:var(--oi-tone-muted);cursor:pointer;outline:none;transition:transform var(--travel-ms,520ms) cubic-bezier(.65,0,.35,1) var(--travel-delay,0ms),opacity 200ms}
${Array.from({ length: 8 }, (_, n) => `.oi-iso-svg .oi-ln-${n}{--lane:var(--oi-lane-${n})}`).join("")}
.oi-iso-crate.blocked,.oi-iso-crate.locked{--lane:var(--oi-tone-failure)}
.oi-iso-crate.sentback{--lane:var(--oi-tone-attention)}
.oi-iso-crate .oi-iso-ft{fill:color-mix(in srgb,var(--lane) 34%,var(--oi-raised))}
.oi-iso-crate .oi-iso-fl{fill:color-mix(in srgb,var(--lane) 16%,var(--oi-panel))}
.oi-iso-crate .oi-iso-fr{fill:color-mix(in srgb,black 30%,color-mix(in srgb,var(--lane) 10%,var(--oi-bg)))}
.oi-iso-crate polygon{stroke:var(--lane);stroke-opacity:.9;stroke-width:1.1;stroke-linejoin:round}
.oi-iso-crate.blocked polygon,.oi-iso-crate.locked polygon{stroke:var(--oi-tone-failure);stroke-width:1.9;stroke-opacity:1}
.oi-iso-crate.blocked .oi-iso-ft,.oi-iso-crate.locked .oi-iso-ft{fill:color-mix(in srgb,var(--oi-tone-failure) 46%,var(--oi-raised))}
.oi-iso-crate.heat .oi-iso-ft{fill:var(--iso-heat)}
.oi-iso-crate.heat .oi-iso-fl{fill:color-mix(in srgb,black 22%,var(--iso-heat))}
.oi-iso-crate.heat .oi-iso-fr{fill:color-mix(in srgb,black 46%,var(--iso-heat))}
${HATCH_STEPS.map(n => `.oi-iso-crate.heat.hatch-${n} .oi-iso-ft{fill:url(#oi-iso-hatch-${n})}`).join("\n")}
.oi-iso-crate.heat .oi-iso-qn{fill:var(--iso-heat-ink)}
.oi-iso-crate.pathed{transition:opacity 200ms}
.oi-iso-crate.hov,.oi-iso-crate:focus-visible{filter:brightness(1.28)}
.oi-iso-crate.sel{filter:drop-shadow(0 0 5px var(--oi-focus,var(--iso-accent)))}
.oi-iso-crate polygon.oi-iso-sil{fill:none;stroke:var(--oi-focus,var(--iso-accent));stroke-width:2.4;stroke-opacity:1}
.oi-iso-crate polygon.oi-iso-ring{fill:none;stroke:var(--iso-accent);stroke-width:2;stroke-dasharray:5 3}
.oi-iso-crate.dep-dim,.oi-iso-bot.dep-dim{opacity:.4}
.oi-iso-crate.dep-up{filter:drop-shadow(0 0 4px var(--oi-tone-running))}.oi-iso-crate.dep-down{filter:drop-shadow(0 0 4px var(--oi-tone-attention))}.oi-iso-crate.dep-focus{filter:drop-shadow(0 0 5px var(--oi-focus,var(--iso-accent)))}
.oi-iso-cbody{transform-box:fill-box}
.oi-iso-cid{font:700 6.2px ui-monospace,monospace;fill:var(--oi-text);pointer-events:none;paint-order:stroke;stroke:color-mix(in srgb,black 55%,transparent);stroke-width:1.1px}
.oi-iso-qn{font:800 7px ui-monospace,monospace;fill:var(--oi-text);pointer-events:none}
.oi-iso-num{font:700 7px ui-monospace,monospace;fill:var(--oi-tone-muted);opacity:.7;pointer-events:none}
.oi-iso-crate.lit{filter:brightness(1.25)}
.oi-iso-crate.p-arrive .oi-iso-cbody{animation:oi-iso-drop .85s cubic-bezier(.3,.7,.4,1) both}
.oi-iso-crate.p-claim .oi-iso-cbody{animation:oi-iso-claimflash 1s ease-out calc(var(--travel-delay,0ms) + var(--travel-ms,0ms)) both}
.oi-iso-crate.p-land .oi-iso-cbody{animation:oi-iso-landglow 1.2s ease-out calc(var(--travel-delay,0ms) + var(--travel-ms,0ms)) both}
.oi-iso-crate.p-back .oi-iso-cbody{animation:oi-iso-backpulse 1s ease-out both}
.oi-iso-cscan{stroke:var(--oi-tone-success);stroke-width:1.6;filter:drop-shadow(0 0 3px var(--oi-tone-success));animation:oi-iso-cscan 1.4s ease-in-out infinite alternate}
.oi-iso-mscan{stroke:var(--oi-tone-running);stroke-width:2.2;filter:drop-shadow(0 0 4px var(--oi-tone-running));pointer-events:none;animation:oi-iso-mscan 1.2s ease-in-out infinite alternate}
.oi-iso-crate polygon.oi-iso-holo{fill:color-mix(in srgb,var(--oi-tone-running) 18%,transparent);stroke:var(--oi-tone-running);stroke-width:1.6;stroke-dasharray:3 2;animation:oi-iso-holo .9s linear infinite;pointer-events:none}
.oi-iso-nogo{font:800 13px ui-monospace,monospace;fill:var(--oi-text);pointer-events:none}.oi-iso-nogo.back{fill:var(--oi-tone-attention)}
.oi-iso-shackle{fill:none;stroke:var(--oi-text);stroke-width:1.5}.oi-iso-lockbody{fill:var(--oi-tone-failure);stroke:var(--oi-bg);stroke-width:.8}
.oi-iso-prio{fill:var(--oi-tone-attention);stroke:var(--oi-bg);stroke-width:.6}
.oi-iso-tag{font:700 10px ui-monospace,monospace;fill:var(--oi-text);paint-order:stroke;stroke:var(--oi-bg);stroke-width:3px;pointer-events:none}
.oi-iso-dep{fill:none;stroke-width:1.8;pointer-events:none}
.oi-iso-dep.up{stroke:var(--oi-tone-running)}.oi-iso-dep.down{stroke:var(--oi-tone-attention);stroke-dasharray:5 4}
.oi-iso-dep.all{opacity:.32;stroke-width:1.2}
.oi-iso-deps.has-focus .oi-iso-dep.all{opacity:.16}
.oi-iso-dep.met{stroke:var(--oi-tone-success);opacity:.7}
.oi-iso-arrowhead.up{fill:var(--oi-tone-running)}.oi-iso-arrowhead.down{fill:var(--oi-tone-attention)}
.oi-iso-bot{--who:var(--oi-tone-running);--m:var(--who);cursor:pointer;outline:none;transition:transform var(--travel-ms,520ms) cubic-bezier(.65,0,.35,1),opacity 200ms}
.oi-iso-m-opus{--m:var(--oi-lane-2)}.oi-iso-m-sonnet{--m:var(--oi-lane-4)}.oi-iso-m-codex{--m:var(--oi-lane-3)}.oi-iso-m-haiku{--m:var(--oi-lane-6)}.oi-iso-m-gemini{--m:var(--oi-lane-5)}.oi-iso-m-other{--m:var(--oi-lane-7)}
.oi-iso-bot.ghost{--who:var(--oi-tone-attention);opacity:.6}.oi-iso-bot.ghost polygon{stroke-dasharray:3 2}
.oi-iso-bot.past{--who:var(--oi-tone-muted);opacity:.85}.oi-iso-bot.stale polygon{stroke:var(--oi-tone-attention)}
.oi-iso-bot .oi-iso-ft{fill:color-mix(in srgb,var(--m) 50%,var(--oi-raised))}
.oi-iso-bot .oi-iso-fl{fill:color-mix(in srgb,var(--m) 36%,var(--oi-panel))}
.oi-iso-bot .oi-iso-fr{fill:color-mix(in srgb,black 30%,color-mix(in srgb,var(--m) 22%,var(--oi-bg)))}
.oi-iso-bot polygon{stroke:var(--who);stroke-width:1;stroke-linejoin:round}
.oi-iso-bot:hover,.oi-iso-bot:focus-visible{filter:brightness(1.3)}
.oi-iso-botshadow{fill:color-mix(in srgb,black 45%,transparent)}
.oi-iso-eye{fill:var(--who)}
.oi-iso-badge{fill:var(--oi-bg);stroke:var(--m);stroke-width:1.8}
.oi-iso-letter{font:800 9.5px ui-monospace,monospace;fill:var(--oi-text);pointer-events:none}
.oi-iso-bot.live .oi-iso-bobber{animation:oi-iso-bob 1.1s ease-in-out infinite}
.oi-iso-lbl{pointer-events:none}
.oi-iso-lbl .oi-iso-plate{pointer-events:auto;cursor:help}
.oi-iso-top{pointer-events:none}
.oi-iso-bot:focus-visible{outline:2px solid var(--oi-focus,var(--iso-accent));outline-offset:2px;filter:drop-shadow(0 0 4px var(--oi-focus,var(--iso-accent))) brightness(1.3)}
.oi-iso-label{font:700 15px ui-monospace,monospace;letter-spacing:.14em;fill:var(--tone);filter:drop-shadow(0 0 3px color-mix(in srgb,var(--tone) 45%,transparent))}
.oi-iso-odod{font:800 18px ui-monospace,monospace;fill:var(--oi-text)}
.oi-iso-odocol{transition:transform 700ms cubic-bezier(.2,.8,.2,1)}
.oi-iso-stamp{font:800 12px ui-monospace,monospace;fill:var(--oi-tone-running);paint-order:stroke;stroke:var(--oi-bg);stroke-width:3px;transform-box:fill-box;transform-origin:center;animation:oi-iso-stamp 1.1s ease-out both;pointer-events:none}
.oi-iso-arc{animation:oi-iso-arc 1.3s cubic-bezier(.4,.1,.3,1) both}
.oi-iso-arc polygon{stroke:var(--oi-tone-success)}
.oi-iso-vaultlbl .oi-iso-sub{paint-order:stroke;stroke:var(--oi-bg);stroke-width:3px}
.oi-iso-lbl .oi-iso-sub{font:600 10.5px ui-monospace,monospace;fill:var(--oi-tone-muted)}
.oi-iso-tick{stroke:var(--tone);stroke-opacity:.6;stroke-width:1}
.oi-iso-lbl.idle{opacity:.6}
.oi-iso-lbl.over .oi-iso-label{fill:var(--oi-tone-failure);filter:drop-shadow(0 0 4px color-mix(in srgb,var(--oi-tone-failure) 80%,transparent))}
.oi-iso-plate rect{fill:var(--oi-panel);stroke:var(--tone);stroke-width:1}.oi-iso-plate text{font:700 10px ui-monospace,monospace;fill:var(--oi-text)}
.oi-iso-plate.back{--tone:var(--oi-tone-attention)}
.oi-iso-weather{font:600 9.5px ui-monospace,monospace;fill:var(--oi-tone-failure);pointer-events:auto}
@keyframes oi-iso-drop{0%{transform:translateY(-38px);opacity:0}50%{opacity:1;transform:translateY(0)}68%{transform:translateY(-7px)}84%{transform:translateY(0)}92%{transform:translateY(-2px)}100%{transform:translateY(0)}}
@keyframes oi-iso-claimflash{0%{filter:brightness(1.8) drop-shadow(0 0 9px var(--tone,var(--oi-tone-running)))}100%{filter:none}}
@keyframes oi-iso-landglow{0%{transform:translateY(-4px);filter:brightness(1.8) drop-shadow(0 0 10px var(--tone,var(--oi-tone-success)))}35%{transform:translateY(0) scaleY(.9)}55%{transform:translateY(0) scaleY(1.03)}100%{transform:none;filter:none}}
@keyframes oi-iso-backpulse{0%,40%,80%{filter:drop-shadow(0 0 9px var(--oi-tone-failure)) brightness(1.7)}20%,60%,100%{filter:none}}
@keyframes oi-iso-cscan{from{transform:translateY(0)}to{transform:translateY(14px)}}
@keyframes oi-iso-mscan{from{transform:translateY(0);opacity:.95}to{transform:translateY(calc(-1 * var(--rise,40px)));opacity:.35}}
@keyframes oi-iso-holo{to{stroke-dashoffset:-10}}
@keyframes oi-iso-shimmer{0%,100%{opacity:1}50%{opacity:.55}}
@keyframes oi-iso-swing{0%{transform:translate(0,0)}35%{transform:translate(-7px,9px)}65%{transform:translate(-7px,9px)}100%{transform:translate(0,0)}}
@keyframes oi-iso-stamp{0%{transform:scale(2.4);opacity:0}25%{transform:scale(1);opacity:1}80%{opacity:1}100%{transform:scale(1) translateY(-6px);opacity:0}}
@keyframes oi-iso-arc{0%{transform:translate(0,0);opacity:1}50%{transform:translate(calc(var(--dx) / 2),calc(var(--dy) / 2 - 34px));opacity:1}100%{transform:translate(var(--dx),var(--dy)) scale(.6);opacity:0}}
@keyframes oi-iso-flow{from{stroke-dashoffset:32}to{stroke-dashoffset:0}}
@keyframes oi-iso-flowback{from{stroke-dashoffset:0}to{stroke-dashoffset:24}}
@keyframes oi-iso-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2.6px)}}
@keyframes oi-iso-press{0%,100%{transform:translateY(0)}50%{transform:translateY(5px)}}
@keyframes oi-iso-sway{0%,100%{transform:translateY(0)}50%{transform:translateY(3px)}}
@keyframes oi-iso-pulse{0%,100%{opacity:.28}50%{opacity:.6}}
@keyframes oi-iso-scan{0%{transform:translateY(0);opacity:.95}100%{transform:translateY(-36px);opacity:.2}}
@keyframes oi-iso-spark{0%{opacity:0;transform:translateY(0) scale(.4)}25%{opacity:1}100%{opacity:0;transform:translateY(-9px) scale(1.5)}}
.oi-iso-svg[data-reduced] *,.oi-iso-svg[data-reduced] *::before{animation:none!important;transition:none!important}
.oi-iso-svg[data-reduced] .oi-iso-spark,.oi-iso-svg[data-reduced] .oi-iso-botspark{opacity:.9}
@media (prefers-reduced-motion:reduce){.oi-iso-svg *{animation:none!important;transition:none!important}.oi-iso-svg .oi-iso-spark,.oi-iso-svg .oi-iso-botspark{opacity:.9}}
`;
