// Factory tree rail (pure, no React, no colours): the arkham-parity WORK tree fused into the Factory. This file derives NO work
// state of its own: a bead's station, padlock and live agent all come from the floor's own FloorFrame (floorAt: tokens, locks,
// workers), the spark from factory-fx.ts sparkLanes, the dependency chain from block-chain.ts, the rows from tree-layout.ts.
// It only joins those outputs per bead id, folds an epic's descendants into a station mix, and owns the one two-way hover rule.
// APPROXIMATIONS, stated:
//   - Intake and Land keep a cap on the floor ("+N"), so a bead past the cap has no token. Its station then comes from its
//     stage (waiting/ready = Intake, done = Land): the only two stages that can overflow. A bead in a hidden work group has
//     neither token nor card and gets no chip (null), never a guess.
//   - Live = a Herdr pane or a recent transcript write (the floor's own FloorWorker.presence), not "the tracker says in progress".
import type { FloorFrame, FloorLock, LockKind } from "./factory-floor-model.ts";
import { STATIONS, type StationId } from "./factory-floor-model.ts";
import { cardsOf } from "./factory-model.ts";
import { sparkLanes } from "./factory-fx.ts";
import { chainRoles, type BlockChain } from "./block-chain.ts";
import type { TreeLine } from "./tree-layout.ts";

/** The Factory's own station tones (the floor's STATION_TONE, exported here so the rail and the floor cannot disagree). */
export const STATION_TONE: Readonly<Record<StationId, "info" | "running" | "attention" | "success">> = { intake: "info", claim: "running", build: "running", gate: "attention", land: "success" };
/** Three letters on a chip; the full station name rides the tooltip. */
export const STATION_ABBR: Readonly<Record<StationId, string>> = { intake: "INT", claim: "CLM", build: "BLD", gate: "GTE", land: "LND" };
const STATION_NAME: Readonly<Record<StationId, string>> = { intake: "Intake", claim: "Claim", build: "Build", gate: "Gate", land: "Land" };

export type RailBead = {
  id: string; station: StationId;
  /** A live agent works on it (pane or transcript); `spark` = lit enough to animate (sparkLanes caps how many pulse). */
  live: boolean; spark: boolean;
  /** The workstream hue index (0-7) of the bead's parent: the same number the Floor and Iso crates carry as `oi-ln-N`. */
  group?: number | null;
  /** Waits on an unmet dependency, a scope lease or a Gate hold; `lock` says which, null when only blocked by its edges. */
  blocked: boolean; lock: LockKind | null;
};

const stageStation = (stage: string): StationId | null => (stage === "waiting" || stage === "ready" ? "intake" : stage === "done" ? "land" : null);

/** One entry per bead the floor knows, from the floor's own frame. */
export function railBeads(frame: FloorFrame, now: number): Map<string, RailBead> {
  const out = new Map<string, RailBead>();
  const groupOf = new Map<string, number>(); for (const r of frame.factory.rows) for (const cs of frame.factory.cells.get(r.key)?.values() ?? []) for (const c of cs) groupOf.set(c.id, r.toneIndex);
  for (const [id, g] of frame.factory.hiddenTone) groupOf.set(id, g);
  const lockByKey = new Map<string, FloorLock>(frame.locks.map(l => [l.key, l]));
  const lit = new Map(sparkLanes(frame.workers, now).map(l => [l.beadId, l.animated]));
  const liveIds = new Set(frame.workers.filter(w => w.presence === "live").map(w => w.beadId));
  for (const k of frame.tokens) {
    const lock = k.lock ? lockByKey.get(k.lock)?.kind ?? null : null;
    out.set(k.id, { id: k.id, station: k.station, live: liveIds.has(k.id) || lit.has(k.id), spark: lit.get(k.id) === true, blocked: k.blocked || lock !== null, lock, group: k.group });
  }
  for (const c of cardsOf(frame.factory)) { // overflow past the Intake / Land cap: no token, the stage still places it
    if (out.has(c.id)) continue;
    const station = stageStation(c.stage);
    if (station) out.set(c.id, { id: c.id, station, live: false, spark: false, blocked: station === "intake" && c.stage === "waiting", lock: null, group: groupOf.get(c.id) ?? null });
  }
  return out;
}

/** Does a row draw its own station chip? A leaf always does. A parent (it has an epic mix bar) only when it is itself in motion:
 * claimed, building or at the Gate, locked or blocked, or has a live agent; a pure container sitting at Intake or Land shows
 * just its kids' bar. */
export const showsChip = (b: RailBead | undefined, isParent: boolean): b is RailBead => !!b && (!isParent || b.station === "claim" || b.station === "build" || b.station === "gate" || b.live || b.blocked || b.lock !== null);

/** The padlock glyph and its words: ⊘ for a dependency (matches the tree's own blocked glyph), 🔒 for a lease or a Gate hold. */
export function lockMark(b: Pick<RailBead, "blocked" | "lock">): { glyph: string; title: string } | null {
  if (b.lock === "scope") return { glyph: "🔒", title: "Locked: files another work item holds" };
  if (b.lock === "gate") return { glyph: "🔒", title: "Locked: waiting at the Gate for a free reviewer" };
  if (b.lock === "blocked" || b.blocked) return { glyph: "⊘", title: "Blocked: waits on another work item" };
  return null;
}

/** The chip's tooltip: station, plus live / lock in words. */
export const railTitle = (b: RailBead): string => [STATION_NAME[b.station], b.live ? "agent working" : null, lockMark(b)?.title ?? null].filter(Boolean).join(" · ");

export type MixSeg = { station: StationId; count: number; pct: number };
export type EpicMix = { total: number; done: number; segs: MixSeg[]; text: string };

/** Every bead row's DESCENDANTS folded into a station mix (arkham n/m × Factory). `lines` must come from an UNFOLDED layout
 * (a folded row hides its kids). Depth is guide.length / 4 (every guide cell is four characters). A bead drawn twice under one
 * epic counts once; a descendant with no station (hidden group) is skipped, so the bar can be shorter than n. */
export function epicMixes(lines: readonly TreeLine[], stationOf: (id: string) => StationId | null): Map<string, EpicMix> {
  const beads = lines.filter((l): l is Extract<TreeLine, { kind: "bead" }> => l.kind === "bead");
  const depth = (l: { guide: string }) => l.guide.length / 4;
  const out = new Map<string, EpicMix>();
  beads.forEach((head, i) => {
    const d = depth(head), seen = new Set<string>([head.id]), count = new Map<StationId, number>();
    let total = 0, done = 0;
    for (let j = i + 1; j < beads.length && depth(beads[j]) > d; j++) {
      const b = beads[j]; if (seen.has(b.id)) continue; seen.add(b.id); total++;
      if (b.state === "done") done++;
      const s = stationOf(b.id); if (s) count.set(s, (count.get(s) ?? 0) + 1);
    }
    if (total === 0) return;
    const placed = [...count.values()].reduce((a, n) => a + n, 0);
    const segs = STATIONS.filter(s => count.has(s)).map(s => ({ station: s, count: count.get(s)!, pct: placed ? (count.get(s)! / placed) * 100 : 0 }));
    out.set(head.id, { total, done, segs, text: segs.map(s => `${s.count} ${STATION_NAME[s.station]}`).join(" · ") });
  });
  return out;
}

export type RailHover = { id: string; source: "tree" | "floor" } | null;
/** The ONE two-way hover rule. A leave (id null) only clears hover its own side set: the floor leaving must not wipe a hover the
 * pointer in the tree is holding (and the reverse), because the two events arrive in either order as the pointer crosses. */
export function reduceHover(prev: RailHover, ev: { id: string | null; source: "tree" | "floor" }): RailHover {
  if (ev.id !== null) return prev && prev.id === ev.id && prev.source === ev.source ? prev : { id: ev.id, source: ev.source };
  return prev && prev.source === ev.source ? null : prev;
}

/** How each tree row reads while `hover` is in focus: the focus row itself, upstream, downstream, or dimmed (chainRoles, block-chain.ts).
 * A bead with no `blocks` edges has an empty chain, so only the focus row is marked and nothing dims. */
export function railRoles(chain: BlockChain | null, ids: readonly string[], focus: string | null): Map<string, "focus" | "up" | "down" | "dim"> {
  if (!focus) return new Map();
  const roles = chainRoles(chain, ids);
  roles.set(focus, "focus");
  return roles;
}

/** The rail's hover ownership: which row's hover the RAIL set, and how. `via` is "pointer" (mouse over the row) or "focus"
 * (keyboard focus with no pointer on it). */
export type RailOwn = { id: string; via: "pointer" | "focus" } | null;
export type RailHoverEvent = { kind: "enter" | "focus" | "leave" | "blur"; id: string; /** a card hovered elsewhere (the floor): its hover is not the rail's to clear */ floorHoverId?: string | null };
/** What the rail tells the shell: set this hover, clear it, or nothing. */
export type RailHoverStep = { next: RailOwn; emit: { set: string } | "clear" | null };
/** The ONE rule for the rail's hover ownership (pinned behaviourally):
 *  - enter and focus set the hover; a focus on the row the pointer already holds keeps the pointer as owner (a click focuses the
 *    row it is over, and its leave must still clear it);
 *  - leave clears only a pointer hover, blur only a focus hover, and only of the row that set it: a stale leave or blur arriving
 *    after another row took over is ignored (the pointer crossing rows fires leave(A) after enter(B));
 *  - when the floor holds a hover (floorHoverId) the rail lets go silently: the shell's hover is not the rail's to clear. */
export function railHover(prev: RailOwn, ev: RailHoverEvent): RailHoverStep {
  if (ev.kind === "enter") return { next: { id: ev.id, via: "pointer" }, emit: { set: ev.id } };
  if (ev.kind === "focus") return prev && prev.id === ev.id && prev.via === "pointer" ? { next: prev, emit: null } : { next: { id: ev.id, via: "focus" }, emit: { set: ev.id } };
  const via = ev.kind === "leave" ? "pointer" : "focus";
  if (!prev || prev.id !== ev.id || prev.via !== via) return { next: prev, emit: null };
  return { next: null, emit: ev.floorHoverId ? null : "clear" };
}
