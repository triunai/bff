// What the Graph shows at a scrubbed time, and what it says when there is nothing to show (pure, no React).
import type { HistoryEvent, WorkSurfaceSnapshot } from "../surface-types.ts";
import { stagesAt } from "../replay.ts";

/** The Graph opens at "now" (scrub null follows now) and paused. GraphTab seeds its state from this, and a test pins it. */
export const INITIAL_SCRUB: { scrub: number | null; playing: boolean } = { scrub: null, playing: false };
/** The time the Graph shows: the scrub position, or now when following; never past now. */
export const scrubTime = (scrub: number | null, now: number): number => Math.min(scrub ?? now, now);

/** Ids of the beads that exist at time t (t at or after now is the live model). Feeds the canvas and its empty note. */
export function graphNodesAt(snap: WorkSurfaceSnapshot, events: readonly HistoryEvent[], t: number, now: number): string[] {
  return [...stagesAt(snap, events, t, now).keys()];
}

const clock = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** One plain line for an empty canvas, or null when something is drawn. Never silent. */
export function graphEmptyNote(o: { total: number; existing: number; shown: number; t: number; now: number; hideDone: boolean }): string | null {
  if (o.shown > 0) return null;
  if (o.total === 0) return "No beads in this tracker yet.";
  if (o.t < o.now && o.existing === 0) return `Nothing existed yet at ${clock(o.t)} — press Back to now`;
  if (o.hideDone) return "Everything here is done — turn off Hide done to see it.";
  return "Nothing to show for this view.";
}
