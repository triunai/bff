// How the Iso floor MOVES (pure; the stage turns these numbers into CSS transition durations and delays, so the repo's existing
// animation stack is reused: no library, no timers). A crate that changes station travels for TRAVEL.MIN_MS..MAX_MS with an
// ease-in-out; several moves in one frame are staggered STAGGER_MS apart so the floor reads as flow. Nothing animates when the
// user prefers reduced motion, and nothing animates while a replay is scrubbed (the frame is not live): positions jump to the
// scrubbed state. Motion kinds are the frame's own (`FloorToken.motion`).
export const TRAVEL = { MIN_MS: 900, MAX_MS: 1400, STAGGER_MS: 120, MAX_STAGGER: 8, PLAY_FLOOR_MS: 120, STAGGER_FLOOR_MS: 24 } as const;
/** `playing`: a replay is PLAYING (not scrubbed, not paused) at `speed`x. Playback moves like live, with durations divided by the speed (floor PLAY_FLOOR_MS so 16x never teleports); a scrub, a jump-to-time or a pause is instant. */
export type TravelOpts = { reduced: boolean; live: boolean; playing?: boolean; speed?: number };
const instant = (o: TravelOpts) => o.reduced || (!o.live && !o.playing);
const speedOf = (o: TravelOpts) => (o.playing && !o.live ? Math.max(1, o.speed ?? 1) : 1);
const scaled = (ms: number, o: TravelOpts) => (speedOf(o) === 1 ? ms : Math.max(TRAVEL.PLAY_FLOOR_MS, ms / speedOf(o)));
/** Any base duration (a floor flight, a bay tween) at this speed: 0 when instant, else scaled. */
export const moveMs = (base: number, o: TravelOpts): number => (instant(o) ? 0 : scaled(base, o));
const clamp = (n: number) => Math.max(TRAVEL.MIN_MS, Math.min(TRAVEL.MAX_MS, n));
/** A crate that just arrived drops in fast; a forward move takes the middle; one sent back rides the whole lane. */
export const travelMs = (kind: string | null, o: TravelOpts): number => (instant(o) ? 0 : scaled(clamp(kind === "rework" || kind === "back" || kind === "reopened" ? TRAVEL.MAX_MS : kind === "enter" ? TRAVEL.MIN_MS : 1100), o));
/** The k-th move of a frame starts k * STAGGER_MS after the first (capped so a 50-lane burst never waits seconds). */
export const staggerMs = (rank: number, o: TravelOpts): number => (instant(o) ? 0 : Math.min(Math.max(0, rank), TRAVEL.MAX_STAGGER) * (speedOf(o) === 1 ? TRAVEL.STAGGER_MS : Math.max(TRAVEL.STAGGER_FLOOR_MS, TRAVEL.STAGGER_MS / speedOf(o))));
/** The default glide for crates the queue merely shuffles, and for agent markers. */
export const glideMs = (o: TravelOpts): number => (instant(o) ? 0 : scaled(1100, o));

// ---- the road ---------------------------------------------------------------------------------------------------------------
import { ISO, proj, type P } from "./iso-layout.ts";
export type Waypoint = P & { /** 0..1: how far along the whole road this point is (by length), the keyframe offset. */ offset: number };
/** The road a crate rides between two belt positions (`fromC`, `toC`: cells along the belt) and the two slots it leaves and reaches. When the belt's corner lies between the stations the corner is a waypoint, so the crate turns with the conveyor instead of cutting across the floor. */
export function roadWaypoints(fromC: number, toC: number, from: P, to: P): Waypoint[] {
  const lo = Math.min(fromC, toC), hi = Math.max(fromC, toC), corner = proj(ISO.LA, 0, ISO.BELT_H);
  const pts: P[] = lo < ISO.LA && ISO.LA < hi ? [from, corner, to] : [from, to];
  const len = pts.map((p, i) => (i ? Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0)), total = len.reduce((a, b) => a + b, 0);
  let run = 0;
  return pts.map((p, i) => { run += len[i]; return { x: p.x, y: p.y, offset: total === 0 ? (i === 0 ? 0 : 1) : run / total }; });
}
