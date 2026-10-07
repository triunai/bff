// LAND prune (owner 01:41): display only, no doc or tracker writes. Land keeps today's landings and a bounded tail; the older
// landed beads roll into an "Archived · N" vault. Pure: the view owns the animation and the per-user `prunedAt` stamp.

export const LAND_VISIBLE_MAX = 150;
export type Landed = { id: string; at: number };

const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);

/** Split landed beads (any order; the input order is kept) into those that stay on Land and those that go to the vault.
 *  - Today's beads ALWAYS stay (even past the cap).
 *  - A bead from before today that landed at or before `prunedAt` (the viewer's last Prune press) is archived.
 *  - Past LAND_VISIBLE_MAX the oldest pre-today beads are archived until the rest fit (ties by id, so it is deterministic).
 *  Idempotent: pruning `stay` again with the same arguments archives nothing more. */
export function prune<T extends Landed>(landed: readonly T[], now: number, prunedAt: number | null, max = LAND_VISIBLE_MAX): { stay: T[]; archived: T[] } {
  const midnight = startOfDay(now), gone = new Set<string>();
  const older = landed.filter(x => x.at < midnight);
  if (prunedAt !== null) for (const x of older) if (x.at <= prunedAt) gone.add(x.id);
  const kept = landed.filter(x => !gone.has(x.id)), excess = kept.length - max;
  if (excess > 0) for (const x of kept.filter(y => y.at < midnight).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)).slice(0, excess)) gone.add(x.id);
  return { stay: landed.filter(x => !gone.has(x.id)), archived: landed.filter(x => gone.has(x.id)) };
}

/** The Land head's counts: today, this week (7 days back from today's midnight, today included), and archived. */
export function landCounts(landed: readonly Landed[], archivedCount: number, now: number): { today: number; week: number; archived: number } {
  const midnight = startOfDay(now), weekStart = midnight - 6 * 86_400_000;
  return { today: landed.filter(x => x.at >= midnight).length, week: landed.filter(x => x.at >= weekStart).length, archived: archivedCount };
}

/** The beads the vault actually holds: `archived` minus the pinned ones (selected, followed, critical, lock holders), which bypass the
 *  archive and are drawn on Land (floorAt). The vault's count, the Land head and the ids the archive opens with all read THIS list. */
export function vaultOf<T extends Landed>(archived: readonly T[], pinned: ReadonlySet<string>): T[] {
  return archived.filter(x => !pinned.has(x.id));
}
