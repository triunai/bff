// Transcript liveness (pure, injectable): a second "an agent is working" signal for lanes with no Herdr pane, such as
// in-process Agent-tool subagents. A lane counts as WORKING when its transcript was written within `windowMs` (default 5
// min). It discovers NOTHING itself and joins nothing itself: transcript discovery and the lane → bead join are
// yb-cachetel's (td-osi.21, wip/yb-cachetel: transcript-feed.ts `pollTranscripts` / `unitsFromState`, telemetry-join.ts
// `joinUnitsToWork`, whose join key is lane name = bead claim actor). This module only takes their outputs (shaped
// structurally, so it does not import the unmerged branch), keeps the newest write per lane, and applies the time window.
// Read-only: only lane names, bead ids and timestamps pass through; transcript content never does.

export const TRANSCRIPT_LIVE_MS = 5 * 60_000;
/** A lane's newest transcript write (epoch ms). */
export type LaneActivity = { lane: string; lastAt: number };
/** What the floor needs per bead: which lane is writing for it, and when it last did. */
export type TranscriptLive = { lane: string; lastAt: number };

/** Newest write per lane from yb-cachetel's units (`unitsFromState`): the max usage-row timestamp. Units with no lane name
 * (the main session, anonymous subagents) and rows without a timestamp are skipped. */
export function activityFromUnits(units: readonly { lane: string | null; rows: readonly { timestamp: number | null }[] }[]): LaneActivity[] {
  const last = new Map<string, number>();
  for (const u of units) {
    if (!u.lane) continue;
    for (const r of u.rows) if (r.timestamp !== null && Number.isFinite(r.timestamp) && r.timestamp > (last.get(u.lane) ?? -Infinity)) last.set(u.lane, r.timestamp);
  }
  return [...last].map(([lane, lastAt]) => ({ lane, lastAt })).sort((a, b) => (a.lane < b.lane ? -1 : 1));
}

/** Beads whose lane wrote within the window, from yb-cachetel's join (`joinUnitsToWork(...).byLane`: lane → beadId) and the
 * activity above. A future write (clock skew) counts as now; an unmatched lane or one past the window is not live. When two
 * lanes write for one bead, the newest write wins. */
export function transcriptLiveByBead(byLane: readonly { lane: string; beadId: string | null }[], activity: readonly LaneActivity[], now: number, windowMs = TRANSCRIPT_LIVE_MS): Map<string, TranscriptLive> {
  const lastOf = new Map(activity.map(a => [a.lane, a.lastAt])), out = new Map<string, TranscriptLive>();
  for (const l of byLane) {
    const at = lastOf.get(l.lane);
    if (!l.beadId || at === undefined || now - Math.min(at, now) > windowMs) continue;
    const had = out.get(l.beadId);
    if (!had || at > had.lastAt) out.set(l.beadId, { lane: l.lane, lastAt: Math.min(at, now) });
  }
  return out;
}
