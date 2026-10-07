import type { HealthRow } from "./health-types.ts";
import { agentTask } from "./health-ui.ts";

/** Health answers "is my work safe, and is my fleet healthy?": every check lands in exactly one of these, in this order. */
export const HEALTH_GROUPS = [
  { id: "unsaved", title: "Unsaved work" },
  { id: "backup", title: "Not backed up" },
  { id: "stale", title: "Stale / abandoned" },
  { id: "waiting", title: "Waiting on you" },
  { id: "fleet", title: "Fleet" },
] as const;
export type HealthGroupId = (typeof HEALTH_GROUPS)[number]["id"];

const GROUP_BY_ID: Record<string, HealthGroupId> = {
  "git:uncommitted": "unsaved",
  "git:unpushed": "backup", "git:unremoted": "backup",
  "git:worktrees": "stale", "git:behind": "stale",
  "owner-decisions": "waiting", "tech-debt": "waiting",
  agents: "fleet", "herdr:capture": "fleet",
};

/** Unlisted ids (every `spine:*` doc-hygiene check, and any future one) are staleness checks. */
export function groupOf(row: HealthRow): HealthGroupId { return GROUP_BY_ID[row.id] ?? "stale"; }

export type HealthGroup = { id: HealthGroupId; title: string; rows: HealthRow[]; open: HealthRow[]; verdict: string; collapsed: boolean };

/** Non-empty groups in display order. `unknown` counts as a risk: it is never a quiet pass. */
export function groupRows(rows: HealthRow[]): HealthGroup[] {
  return HEALTH_GROUPS.map(g => {
    const mine = rows.filter(r => groupOf(r) === g.id), open = mine.filter(r => r.status !== "pass");
    return { id: g.id, title: g.title, rows: mine, open, verdict: open.length ? `${open.length} ${open.length === 1 ? "risk" : "risks"}` : "all clear", collapsed: open.length === 0 };
  }).filter(g => g.rows.length > 0);
}

const ACTION_LABEL: Record<string, string> = {
  "git:uncommitted": "Review changes", "git:unpushed": "Push commits", "git:unremoted": "Back up branches",
  "git:worktrees": "Review worktrees", "git:behind": "Refresh index", "owner-decisions": "Open decisions",
  agents: "Check agents", "herdr:capture": "Check capture",
};
/** The one button an open item gets. */
export function primaryActionLabel(row: HealthRow): string { return ACTION_LABEL[row.id] ?? "Fix this"; }

/** Every open item as one prompt; "" when nothing is open. */
export function copyAllTask(rows: HealthRow[]): string {
  const open = rows.filter(r => r.status !== "pass");
  if (!open.length) return "";
  return `Osiris Health — ${open.length} open item${open.length === 1 ? "" : "s"}. Work through them one at a time.\n${open.map((r, i) => `${i + 1}. ${agentTask(r)}`).join("\n")}`;
}

export type FileGroups = { total: number; shown: number; more: number; groups: { dir: string; count: number; files: string[] }[] };
/** A ", "-joined path list as top-level-dir groups with full counts; only the first `limit` paths are listed. */
export function fileGroups(list: string, limit = 10): FileGroups {
  const files = list.split(", ").map(f => f.trim()).filter(Boolean);
  const by = new Map<string, { dir: string; count: number; files: string[] }>();
  files.forEach((f, i) => {
    const dir = f.includes("/") ? f.slice(0, f.indexOf("/")) : ".";
    const g = by.get(dir) ?? by.set(dir, { dir, count: 0, files: [] }).get(dir)!;
    g.count++;
    if (i < limit) g.files.push(f);
  });
  const shown = Math.min(limit, files.length);
  return { total: files.length, shown, more: files.length - shown, groups: [...by.values()] };
}
