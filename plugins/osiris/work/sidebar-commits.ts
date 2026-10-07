// Pure mapper from the EXISTING git graph data (GitGraph + its LaneRow layout, both already read for the Work graph) to the
// sidebar's compact commit rows. No second git reader. A row's lane colour index is the layout row's `color`.
import type { GitGraph, LaneRow } from "../git-types.ts";
import { cleanText } from "./sanitize.ts";

export type SidebarCommit = { sha: string; subject: string; at: number; lane: number; branch: string; author: string };
export const SIDEBAR_COMMITS = 20;

/** Newest first, at most `limit`. `rows` may be absent or shorter than the commits: a commit without a row gets lane 0. */
export function toSidebarCommits(graph: GitGraph | null | undefined, rows: readonly LaneRow[] | null | undefined, limit = SIDEBAR_COMMITS): SidebarCommit[] {
  if (!graph) return [];
  const color = new Map((rows ?? []).map(r => [r.sha, r.color]));
  return graph.commits.slice(0, Math.max(0, limit)).map(c => ({
    sha: c.sha, subject: cleanText(c.subject).trim() || "(no subject)", at: c.committedAt, lane: color.get(c.sha) ?? 0,
    branch: c.refs.find(r => !r.includes("/") && r !== "HEAD") ?? c.refs[0] ?? graph.branch ?? "", author: cleanText(c.author),
  }));
}

/** Commits on the same local calendar day as `now`. */
export function commitsToday(commits: readonly SidebarCommit[], now: number): number {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  const start = d.getTime(), end = start + 86_400_000;
  return commits.filter(c => c.at >= start && c.at < end).length;
}
