// The Archive canvas's "Archived beads" section (display only): closed beads from the bd snapshot, newest first, optionally scoped
// to the ids the Land vault holds. No bead<->W-NNN join exists or is invented; this is its own list above the spine's months.
import { closeTimes } from "./factory-floor-model.ts";
import { stageLabel, stagesAt } from "./replay.ts";
import { shortId } from "./surface-model.ts";
import type { HistoryEvent, WorkSurfaceSnapshot } from "./surface-types.ts";

export type ArchivedBeadRow = { id: string; shortId: string; title: string; at: number | null; from: string | null };

/** `ids` null = every closed bead; an array = exactly those that are closed (an empty array is zero rows, never "all").
 * `from` is the stage the replay shows one millisecond before the close ("Being built", "Ready"...); null when the bead did not exist
 * yet or its close time is unknown, never guessed. Beads with no known close time sort last. */
export function archivedBeads(snap: WorkSurfaceSnapshot, events: readonly HistoryEvent[], now: number, ids: readonly string[] | null): ArchivedBeadRow[] {
  const want = ids === null ? null : new Set(ids), closed = closeTimes(events, now);
  return snap.issues
    .filter(i => i.status === "closed" && (want === null || want.has(i.id)))
    .map(i => {
      const at = closed.get(i.id) ?? null, st = at === null ? undefined : stagesAt(snap, events, at - 1, now).get(i.id);
      return { id: i.id, shortId: shortId(i.id), title: i.title, at, from: st ? stageLabel(st) : null };
    })
    .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity) || (a.id < b.id ? -1 : 1));
}

/** The vault's id filter, kept until the user clears it or opens the archive fresh. It must survive ONE round trip: picking a bead row
 * makes the shell jump the centre to Work, and coming back should still be scoped. `keep` is armed by the vault (entering) and by a
 * select made while on the archive (leaving); the next entry to the archive consumes it, otherwise that entry is "fresh" and clears. */
export type ArchiveFilter = { ids: readonly string[] | null; keep: boolean; selFromArchive: boolean };
export const ARCHIVE_FILTER_INIT: ArchiveFilter = { ids: null, keep: false, selFromArchive: false };
export type ArchiveFilterAction =
  | { type: "vault"; ids: readonly string[]; canvas: string } // `canvas` = where the user is when they click the vault
  | { type: "select"; canvas: string }
  | { type: "canvas"; from: string; to: string }
  | { type: "clear" };

export function archiveFilterReduce(s: ArchiveFilter, a: ArchiveFilterAction): ArchiveFilter {
  switch (a.type) {
    case "clear": return s.ids === null && !s.keep && !s.selFromArchive ? s : ARCHIVE_FILTER_INIT;
    case "vault": return { ids: [...a.ids], keep: a.canvas !== "archive", selFromArchive: false }; // already there: no entry will follow, so arm nothing
    case "select": return a.canvas === "archive" && !s.selFromArchive ? { ...s, selFromArchive: true } : s;
    case "canvas":
      if (a.from === a.to) return s;
      if (a.to === "archive") return s.keep ? { ...s, keep: false } : s.ids === null && !s.selFromArchive ? s : { ids: null, keep: false, selFromArchive: false };
      if (a.from === "archive") return { ...s, keep: s.selFromArchive, selFromArchive: false };
      return s;
  }
}
