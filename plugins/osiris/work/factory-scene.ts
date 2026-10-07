// The Factory's SEMANTIC layer (design v5 §2.2). `sceneOf` is the ONE place Factory semantics are derived: who stands where, who
// waits for whom, what is locked, pinned, lit or shipped. It is a phase-1 ADAPTER over today's floorAt (moved out of
// factory-floor.tsx, not rewritten); renderers (the Floor stage, Iso, the rail, the timeline) take values from it and compute
// nothing semantic themselves. Pure: no React, no DOM, no clocks (the caller passes `now`, and wall-time fx arrive as inputs).
// Hover is NOT an input: hoverCardOf / hoverChainOf are selectors, memoised by the caller on (scene, id).
import { allBlockEdges, blockChain, chainRoles, directBlocks, type BlockChain } from "./block-chain.ts";
import { shippedToday, sparkLanes, weatherOf } from "./factory-fx.ts";
import { floorAt, landedSince, trailOf, type FloorFrame, type FloorLock, type FloorOpts, type FloorToken, type FloorWorker, type StationId, type TrailStop } from "./factory-floor-model.ts";
import { logAt, reworkOf, type Journal, type SceneEvent } from "./factory-journal.ts";
import type { GraphModel } from "./graph/graph.ts";
import { stagesAt } from "./replay.ts";
import type { HistoryEvent, WorkSurfaceSnapshot } from "./surface-types.ts";
import type { WorkIssue } from "./types.ts";

export const STATION_ORDER: readonly StationId[] = ["intake", "claim", "build", "gate", "land"];
/** The newest lines ON THE FLOOR keeps. */
export const LOG_MAX = 9;
export type Role = "focus" | "up" | "down" | "dim";
/** `side` is relative to a focus ("up" = the focus waits on it, "down" = it waits on the focus) and null in all-chains mode. */
export type SceneEdge = { from: string; to: string; met: boolean; critical: boolean; side: "up" | "down" | null };
export type SelectedCard = { issue: WorkIssue; deps: { blockers: string[]; dependents: string[] }; chain: BlockChain };
export type SceneInput = {
  snap: WorkSurfaceSnapshot; events: readonly HistoryEvent[]; graph: GraphModel; t: number; now: number;
  /** floorAt's options (heat, thresholds, critical, costs, leases, transcriptLive, silos, chainIds, archivedIds, prev, reducedMotion). `graph` and `reworkSeen` are supplied here. */
  opts: FloorOpts; journal: Journal;
  ui: { selectedId: string | null; followId: string | null; spot: StationId | null; chainsOn: boolean };
  /** Wall-time fx the shell holds (journal.fxUntil via litOf, plus replay moments via momentsOf). */
  fx?: { bursts: ReadonlySet<string>; chainsLit: ReadonlySet<string> };
  /** Cap on the pinned-bead fixed point's passes (default PIN_PASSES). Exposed so a test can spend it. */
  pinPasses?: number;
};
/** Passes the pinned-bead fixed point may take; it settles in 1-2 on the adversarial sets, so this is headroom, never a working limit. */
export const PIN_PASSES = 8;
export type FactoryScene = {
  /** Phase 1: floorAt's frame, unchanged. Its 2D fields (x/y/w/h, density, caption, overflow, tweens, lift) are FLOOR-PROJECTION fields Iso must not read. */
  frame: FloorFrame;
  tokenAt: ReadonlyMap<string, FloorToken>; workerOf: ReadonlyMap<string, FloorWorker>; lockByKey: ReadonlyMap<string, FloorLock>;
  /** Live agents per station (the machines' working / waiting numerals). */
  liveAt: ReadonlyMap<StationId, number>;
  isDone(id: string): boolean;
  /** Every bead at each station in SEMANTIC order (what is drawn first); drawn ids then the overflow ids. */
  stations: readonly { id: StationId; count: number; queue: readonly string[] }[];
  /** Ids no renderer may hide behind a +N: selected, followed, critical, and every lock's bead and holders. */
  pinned: ReadonlySet<string>;
  /** False when the fixed point's passes ran out with some lock pin still unrouted (the cap was hit): visible, never silent. */
  pinsSettled: boolean;
  chains: { mode: "all" | "off"; edges: readonly SceneEdge[]; focus: BlockChain | null; roles: ReadonlyMap<string, Role>; focusEdges: readonly SceneEdge[] };
  selected: SelectedCard | null;
  spotList: readonly FloorToken[];
  fx: { sparks: ReadonlyMap<string, ReturnType<typeof sparkLanes>[number]>; shelf: ReturnType<typeof shippedToday>; weather: ReadonlyMap<StationId, NonNullable<ReturnType<typeof weatherOf>>>; unlocking: ReadonlySet<string>; fresh: ReadonlySet<string>; bursts: ReadonlySet<string>; chainsLit: ReadonlySet<string> };
  timeline: readonly SceneEvent[];
  stats: { landedToday: number; sentBack: number };
};

const midnight = (t: number) => new Date(t).setHours(0, 0, 0, 0);
const toEdge = (e: { from: string; to: string; met: boolean; side?: "up" | "down" }, critical: ReadonlySet<string> | null | undefined, side: "up" | "down" | null): SceneEdge => ({ from: e.from, to: e.to, met: e.met, critical: !!(critical?.has(e.from) && critical?.has(e.to)), side });

export function sceneOf(i: SceneInput): FactoryScene {
  const { snap, events, graph, t, now, opts, journal, ui } = i;
  const pin = new Set<string>([...(ui.selectedId ? [ui.selectedId] : []), ...(ui.followId ? [ui.followId] : []), ...(opts.critical ?? [])]);
  // Pinned = selected, followed, critical AND every lock's bead and holders. The locks are only known once a frame exists, so lock pins
  // are routed through floorAt's pinned option by the fixed point below.
  const build = (p: ReadonlySet<string>) => floorAt(snap, events, t, now, { ...opts, graph, reworkSeen: reworkOf(journal, t), pinned: p });
  const lockPins = (fr: FloorFrame) => fr.locks.flatMap(l => [l.beadId, ...l.holders]);
  let frame = build(pin);
  // FIXED POINT: route EVERY lock pin (not only the folded ones: rebuilding for one could displace another holder that was drawn but
  // never routed) and rebuild until the pin set stops growing. Pins only ever grow and are bounded by the beads, so this terminates.
  let settled = false;
  for (let pass = 0; pass < (i.pinPasses ?? PIN_PASSES); pass++) {
    const before = pin.size; for (const id of lockPins(frame)) pin.add(id);
    if (pin.size === before) { settled = true; break; }
    frame = build(pin);
  }
  // Cap spent: still route what the last frame showed (one guaranteed rebuild), so a pinned bead is never left behind +N; then report whether that sufficed.
  if (!settled) { for (const id of lockPins(frame)) pin.add(id); frame = build(pin); settled = lockPins(frame).every(id => pin.has(id)); }
  const tokenAt = new Map(frame.tokens.map(k => [k.id, k])), workerOf = new Map(frame.workers.map(w => [w.beadId, w])), lockByKey = new Map(frame.locks.map(l => [l.key, l]));
  const liveAt = new Map<StationId, number>(); for (const w of frame.workers) if (w.presence === "live") liveAt.set(w.station, (liveAt.get(w.station) ?? 0) + 1);
  const isDone = (id: string) => tokenAt.get(id)?.station === "land" || (!tokenAt.has(id) && graph.nodes.find(n => n.id === id)?.status === "closed");
  const stations = STATION_ORDER.map(id => { const st = frame.stations.find(s => s.id === id)!; return { id, count: st.count, queue: [...frame.tokens.filter(k => k.station === id).map(k => k.id), ...st.overflowIds] }; });
  const pinned = new Set<string>();
  for (const id of [ui.selectedId, ui.followId]) if (id) pinned.add(id);
  for (const k of frame.tokens) if (k.critical) pinned.add(k.id);
  for (const l of frame.locks) { pinned.add(l.beadId); for (const h of l.holders) pinned.add(h); }
  const crit = opts.critical, closed = new Set(graph.nodes.filter(n => n.status === "closed").map(n => n.id));
  const focusId = ui.selectedId && tokenAt.has(ui.selectedId) ? ui.selectedId : null;
  const focus = focusId ? blockChain(graph, focusId, isDone) : null;
  const edges = ui.chainsOn ? allBlockEdges(graph, id => closed.has(id)).filter(e => tokenAt.has(e.from) && tokenAt.has(e.to)).map(e => toEdge(e, crit, null)) : [];
  const issue = ui.selectedId ? snap.issues.find(x => x.id === ui.selectedId) ?? null : null;
  const st = stagesAt(snap, events, t, now), day = midnight(t), lit = i.fx ?? { bursts: new Set<string>(), chainsLit: new Set<string>() };
  return {
    frame, tokenAt, workerOf, lockByKey, liveAt, isDone, stations, pinned, pinsSettled: settled,
    chains: { mode: ui.chainsOn ? "all" : "off", edges, focus, roles: chainRoles(focus, frame.tokens.map(k => k.id)), focusEdges: (focus?.edges ?? []).filter(e => tokenAt.has(e.from) && tokenAt.has(e.to)).map(e => toEdge(e, crit, e.side)) },
    selected: issue ? { issue, deps: directBlocks(graph, issue.id), chain: blockChain(graph, issue.id, isDone) } : null,
    spotList: ui.spot ? frame.tokens.filter(k => k.station === ui.spot) : [],
    fx: {
      sparks: new Map(sparkLanes(frame.workers, now).map(l => [l.beadId, l])),
      shelf: shippedToday(snap.issues, events, day, t, id => st.get(id), opts.costs ?? null),
      weather: new Map(frame.stations.flatMap(s => { const w = weatherOf(s, frame.thresholdsWired); return w ? [[s.id, w] as const] : []; })),
      unlocking: new Set(frame.lockMoments.unlocked.map(l => l.beadId).filter(id => tokenAt.has(id) && !tokenAt.get(id)!.lock)),
      fresh: new Set(frame.lockMoments.locked.map(l => l.beadId)),
      bursts: lit.bursts, chainsLit: lit.chainsLit,
    },
    timeline: logAt(snap, events, journal, t, LOG_MAX, { graph, thresholds: opts.thresholds ?? null }, now),
    stats: { landedToday: landedSince(events, day, t), sentBack: [...reworkOf(journal, t).values()].reduce((a, b) => a + b, 0) },
  };
}

/** The scene with a different set of lit fx (bursts, chains): everything else, the frame included, is the same object. */
export const withFx = (s: FactoryScene, lit: { bursts: ReadonlySet<string>; chainsLit: ReadonlySet<string> }): FactoryScene => (s.fx.bursts === lit.bursts && s.fx.chainsLit === lit.chainsLit ? s : { ...s, fx: { ...s.fx, bursts: lit.bursts, chainsLit: lit.chainsLit } });

export type HoverCard = { token: FloorToken; trail: TrailStop[]; ringed: ReadonlySet<string>; lock: FloorLock | null; worker: FloorWorker | null };
/** The one hover card's data for a bead, or null when it is not drawn. Cheap and memoised by the caller on (scene, id). */
export function hoverCardOf(scene: FactoryScene, snap: WorkSurfaceSnapshot, events: readonly HistoryEvent[], id: string, t: number, now: number): HoverCard | null {
  const token = scene.tokenAt.get(id); if (!token) return null;
  const lock = token.lock ? scene.lockByKey.get(token.lock) ?? null : null;
  return { token, trail: trailOf(snap, events, id, t, now), ringed: new Set([...token.waitingOn, ...(lock?.holders ?? [])]), lock, worker: scene.workerOf.get(id) ?? null };
}
/** The chain of a hovered bead: roles for dimming and the edges to draw (solid = it waits on, dashed = waits on it). */
export function hoverChainOf(scene: FactoryScene, graph: GraphModel, id: string, critical?: ReadonlySet<string> | null): { chain: BlockChain; roles: ReadonlyMap<string, Role>; edges: readonly SceneEdge[] } | null {
  if (!scene.tokenAt.has(id)) return null;
  const chain = blockChain(graph, id, scene.isDone);
  return { chain, roles: chainRoles(chain, scene.frame.tokens.map(k => k.id)), edges: chain.edges.filter(e => scene.tokenAt.has(e.from) && scene.tokenAt.has(e.to)).map(e => toEdge(e, critical, e.side)) };
}

/** The beads that SHOULD be on the floor at t, derived independently of floorAt/factoryAt: every issue that is nobody's parent
 * (an epic is a row, not a card) and exists at t. The completeness check compares the stations' queues against this. */
export function eligible(snap: WorkSurfaceSnapshot, events: readonly HistoryEvent[], t: number, now: number = t): string[] {
  const parents = new Set<string>();
  for (const d of snap.deps) if (d.type === "parent-child") parents.add(d.dependsOnId);
  for (const x of snap.issues) if (x.parent) parents.add(x.parent);
  const stage = stagesAt(snap, events, t, now);
  return snap.issues.filter(x => !parents.has(x.id) && stage.has(x.id)).map(x => x.id).sort();
}
/** Parity check 2 for a renderer: what it drew plus what it listed as overflow must be exactly the queue, disjoint, and every
 * pinned id in the queue must be drawn. Returns the problems (empty = fine). */
export function partitionProblems(queue: readonly string[], drawn: readonly string[], overflow: readonly string[], pinned: ReadonlySet<string>): string[] {
  const out: string[] = [], d = new Set(drawn), o = new Set(overflow), q = new Set(queue);
  if (d.size !== drawn.length || o.size !== overflow.length) out.push("an id appears twice");
  for (const id of drawn) if (o.has(id)) out.push(`${id} is both drawn and overflowed`);
  for (const id of queue) if (!d.has(id) && !o.has(id)) out.push(`${id} is neither drawn nor overflowed`);
  for (const id of [...d, ...o]) if (!q.has(id)) out.push(`${id} is not in the queue`);
  for (const id of pinned) if (q.has(id) && !d.has(id)) out.push(`pinned ${id} is hidden`);
  return out;
}
