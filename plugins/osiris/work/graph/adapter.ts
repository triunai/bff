// Osiris adapter for the BeadBoard graph port (BeadBoard MIT, src/lib/types.ts @ 9e3059d; see third_party/NOTICE-beadboard.md).
// Maps our WorkIssue/WorkDep onto BeadBoard's BeadIssue. A WorkDep reads "issueId depends on dependsOnId"; BeadBoard's
// `{type: "blocks", target}` on an issue reads the same way (target blocks the issue), so `target` = dependsOnId for both kinds.
import type { WorkSurfaceSnapshot } from "../surface-types.ts";
import type { BeadDependency, BeadIssue } from "./types.ts";

export function toBeadIssues(snap: WorkSurfaceSnapshot): BeadIssue[] {
  const deps = new Map<string, BeadDependency[]>();
  const add = (id: string, d: BeadDependency) => { const l = deps.get(id) ?? []; if (!l.some(x => x.type === d.type && x.target === d.target)) l.push(d); deps.set(id, l); };
  for (const d of snap.deps) {
    if (d.type === "blocks") add(d.issueId, { type: "blocks", target: d.dependsOnId });
    else if (d.type === "parent-child") add(d.issueId, { type: "parent", target: d.dependsOnId });
  }
  return snap.issues.map(i => {
    if (i.parent) add(i.id, { type: "parent", target: i.parent });
    return { id: i.id, title: i.title, status: i.status, priority: i.priority, issue_type: i.type, assignee: i.assignee, labels: i.labels, dependencies: deps.get(i.id) ?? [], created_at: i.createdAt, updated_at: i.updatedAt };
  });
}
