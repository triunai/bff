// Factory effects (pure, no React, no colours): what makes the floor feel alive, derived ONLY from data the floor already has.
// "Cooler" without inventing anything: sparks come from the lane's real transcript-write time (FloorWorker.transcriptAt, fed
// by transcriptLive), landing bursts from a diff of two successive frames, the shelf from the same history events the
// "Landed today" cell counts, the weather line from the stations' own counts and limit. The component only renders these.
// APPROXIMATIONS, stated:
//   - Sparks: the feed gives the time of a lane's LAST transcript write, not a per-call stream, so cadence follows how
//     recent that write is (fresher = faster, capped, still after STILL_MS). One neutral colour: no edit / test / fail kinds.
//   - Weather: "in review" at the Gate is the floor's own ASSUMPTION (the first R beads, no review-start signal).
import type { HistoryEvent, WorkSurfaceSnapshot } from "./surface-types.ts";
import type { Stage } from "./replay.ts";
import { closeTimes, logTitle, STATION_TEXT, type FloorFrame, type FloorStation, type FloorWorker } from "./factory-floor-model.ts";
import { limitText } from "./station-rules.ts";

// ---- 1. live sparks ---------------------------------------------------------------------------------------------------
/** FAST_MS: the quickest cadence (a write just now); SLOW_MS: the slowest, reached as a write nears STILL_MS; a lane quiet for
 * STILL_MS goes still. MAX_LIT: how many lanes animate at once (the rest show the same mark, static), so 30-50 lanes stay readable. */
export const SPARK = { STILL_MS: 3 * 60_000, FAST_MS: 1200, SLOW_MS: 5000, MAX_LIT: 12 } as const;
export type SparkLane = { beadId: string; ageMs: number; intervalMs: number; delayMs: number; animated: boolean };
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
/** Spark cadence in ms for a write `ageMs` ago, or null when the lane is still. Linear from FAST_MS (just now) to SLOW_MS. */
export const sparkCadence = (ageMs: number): number | null => (ageMs >= SPARK.STILL_MS ? null : Math.round(SPARK.FAST_MS + (SPARK.SLOW_MS - SPARK.FAST_MS) * (Math.max(0, ageMs) / SPARK.STILL_MS)));
/** The lanes to mark, freshest first. A lane with no transcript time (no data, or a past frame) gets nothing. The delay is a
 * stable hash of the bead id inside one cycle, so sparks do not pulse in unison and do not jump on re-render. */
export function sparkLanes(workers: readonly Pick<FloorWorker, "beadId" | "transcriptAt" | "presence">[], now: number, maxLit: number = SPARK.MAX_LIT): SparkLane[] {
  const out: Omit<SparkLane, "animated">[] = [];
  for (const w of workers) {
    if (w.transcriptAt === null) continue;
    const ageMs = Math.max(0, now - w.transcriptAt), intervalMs = sparkCadence(ageMs);
    if (intervalMs !== null) out.push({ beadId: w.beadId, ageMs, intervalMs, delayMs: hash(w.beadId) % intervalMs });
  }
  out.sort((a, b) => a.ageMs - b.ageMs || (a.beadId < b.beadId ? -1 : a.beadId > b.beadId ? 1 : 0));
  return out.map((l, i) => ({ ...l, animated: i < maxLit }));
}

// ---- 2. landing burst + shipped-today shelf ---------------------------------------------------------------------------
/** MAX: bursts per step (a 16x replay can land many at once); MS: how long a burst stays on its card. */
export const BURST = { MAX: 6, MS: 1600 } as const;
/** Bead ids that moved INTO Land between two successive frames (forward time only; a bead that was not in the previous frame,
 * or was already landed, is not a move; a reopen leaves Land and is not one either). Capped at BURST.MAX. */
export function landingMoments(prev: Pick<FloorFrame, "t" | "tokens"> | null, next: Pick<FloorFrame, "t" | "tokens">): string[] {
  if (!prev || next.t < prev.t) return [];
  const was = new Map(prev.tokens.map(k => [k.id, k.station]));
  return next.tokens.filter(k => k.station === "land" && was.has(k.id) && was.get(k.id) !== "land").map(k => k.id).slice(0, BURST.MAX);
}

/** CHARS: characters one shelf line holds in the Land bay (at its font size); ROWS: lines drawn under the shelf title. */
export const SHELF = { CHARS: 34, ROWS: 5 } as const;
export type ShelfItem = { id: string; shortId: string; title: string; at: number; cost: number | null };
/** Beads that landed in (from, t] and are still done at t, newest first, at most `max` rows; `total` counts them all. `from` is
 * local midnight, as in the "Landed today" cell. (That cell counts every close in the window, so after a reopen it can read
 * one higher than the shelf: the shelf lists only what is landed now.) Cost comes from `costs` by bead id, else null. */
export function shippedToday(issues: readonly { id: string; title: string }[], events: readonly HistoryEvent[], from: number, t: number, stageOf: (id: string) => Stage | undefined, costs: ReadonlyMap<string, number> | null, max: number = SHELF.ROWS): { items: ShelfItem[]; total: number } {
  const title = new Map(issues.map(i => [i.id, i.title])), all: ShelfItem[] = [];
  for (const [id, at] of closeTimes(events, t)) if (at > from && stageOf(id) === "done") all.push({ id, shortId: id, title: title.get(id) ?? id, at, cost: costs?.get(id) ?? null });
  all.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
  return { items: all.slice(0, max), total: all.length };
}
const costText = (c: number) => `$${c < 10 ? c.toFixed(2) : c < 100 ? c.toFixed(1) : String(Math.round(c))}`;
/** One shelf line, "09:05 Fix the diff viewer $4.50", fitted to SHELF.CHARS by shortening the title only. */
export function shelfLine(i: Pick<ShelfItem, "title" | "cost">, clock: string): string {
  const cost = i.cost === null ? "" : ` ${costText(i.cost)}`;
  return `${clock} ${logTitle(i.title, Math.max(8, SHELF.CHARS - clock.length - 1 - cost.length))}${cost}`;
}

// ---- 3. bottleneck weather --------------------------------------------------------------------------------------------
/** The one-line cause for a station over its limit, from its own counts, e.g. "7 waiting · 2 in review · default limit 2"
 * (`text`, for the bay header) and the full sentence (`title`). Null while the station is within its limit. */
export function weatherOf(s: Pick<FloorStation, "id" | "count" | "queue" | "threshold" | "bottleneck">, wired: boolean): { text: string; title: string } | null {
  if (!s.bottleneck) return null;
  const limit = `${wired ? "" : "default "}limit ${s.threshold}`, label = STATION_TEXT[s.id].label;
  let counts: string, note = "";
  if (s.id === "gate") { const review = Math.min(s.count, s.threshold); counts = `${s.count - review} waiting · ${review} in review`; note = " Which ones are in review is assumed: there is no review-start signal yet."; }
  else if (s.id === "intake") { const blocked = s.count - s.queue; counts = `${s.queue} ready${blocked > 0 ? ` · ${blocked} waiting on blockers` : ""}`; }
  else if (s.id === "claim") counts = `${s.count} claimed, no agent yet`;
  else counts = `${s.count} being built`;
  return { text: `${counts} · ${limit}`, title: `${label} is over its limit: ${counts}. It ${limitText(s.id, s.threshold, wired)}.${note}` };
}
