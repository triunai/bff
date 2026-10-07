// PURE model for History > Working tree. No DOM, no IO. Groups `git status --porcelain=v1` entries into the three areas the
// owner asked for (Staged / Unstaged / Untracked) and joins the `diff --numstat` counts. Nothing here is inferred: a letter is git's own.
import type { GitFileStat, GitStatusEntry } from "./git-types.ts";

export type WorktreeArea = "staged" | "unstaged" | "untracked";
export const WORKTREE_AREAS: readonly WorktreeArea[] = ["staged", "unstaged", "untracked"];
export const AREA_LABEL: Record<WorktreeArea, string> = { staged: "Staged", unstaged: "Unstaged", untracked: "Untracked" };

export type WorktreeStats = { staged: GitFileStat[]; unstaged: GitFileStat[] };
export type WorktreeRow = { key: string; area: WorktreeArea; path: string; origPath?: string; letter: string; additions: number | null; deletions: number | null; binary: boolean };
export type WorktreeGroup = { area: WorktreeArea; label: string; rows: WorktreeRow[] };

const none = (c: string) => c === " " || c === "";
/** One row per (area, path): a file changed both in the index and in the worktree appears in both areas, as every git UI shows it. */
export function worktreeGroups(entries: readonly GitStatusEntry[], stats?: WorktreeStats | null): WorktreeGroup[] {
  const by = (list: GitFileStat[] | undefined) => new Map((list ?? []).map(s => [s.path, s] as const));
  const sm = { staged: by(stats?.staged), unstaged: by(stats?.unstaged) };
  const rows: Record<WorktreeArea, WorktreeRow[]> = { staged: [], unstaged: [], untracked: [] };
  for (const e of entries) {
    const mk = (area: WorktreeArea, letter: string): WorktreeRow => {
      const s = area === "untracked" ? undefined : sm[area].get(e.path);
      return { key: `${area}:${e.path}`, area, path: e.path, ...(e.origPath !== undefined ? { origPath: e.origPath } : {}), letter, additions: s ? s.additions : null, deletions: s ? s.deletions : null, binary: !!s?.binary };
    };
    if (e.x === "?" && e.y === "?") { rows.untracked.push(mk("untracked", "?")); continue; }
    if (e.x === "!" ) continue; // ignored files never come from a default status; refuse them anyway
    if (!none(e.x)) rows.staged.push(mk("staged", e.x));
    if (!none(e.y)) rows.unstaged.push(mk("unstaged", e.y));
  }
  return WORKTREE_AREAS.map(area => ({ area, label: AREA_LABEL[area], rows: rows[area] }));
}

/** The flat, display-ordered row list (Staged, Unstaged, Untracked) that j/k walks. */
export const flatRows = (groups: readonly WorktreeGroup[]): WorktreeRow[] => groups.flatMap(g => g.rows);

/** j / ArrowDown = next, k / ArrowUp = previous, clamped (no wrap); Home / End jump. Returns the new index, or null when the key is not a move. */
export function moveIndex(key: string, i: number, n: number): number | null {
  if (n <= 0) return null;
  const at = Math.min(Math.max(i, 0), n - 1);
  if (key === "j" || key === "ArrowDown") return Math.min(n - 1, at + 1);
  if (key === "k" || key === "ArrowUp") return Math.max(0, at - 1);
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return null;
}

/** "+12 −4", "−88", "+3", "new" (untracked), "binary". Empty when counts are unknown. */
export function rowCounts(r: Pick<WorktreeRow, "area" | "additions" | "deletions" | "binary">): string {
  if (r.area === "untracked") return "new";
  if (r.binary) return "binary";
  if (r.additions === null || r.deletions === null) return "";
  return [r.additions > 0 || r.deletions === 0 ? `+${r.additions}` : "", r.deletions > 0 ? `−${r.deletions}` : ""].filter(Boolean).join(" ");
}

/** "N uncommitted": distinct paths with any change (a file both staged and modified counts once). */
export const uncommittedCount = (entries: readonly GitStatusEntry[]): number => new Set(entries.filter(e => e.x !== "!").map(e => e.path)).size;
