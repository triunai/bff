// Normalized work-item shapes. Single-writer rule: Osiris only READS beads; it never repairs or writes
// (beady-eye's rule). These types are bd-agnostic: only beads-adapter.ts knows how bd spells them.
export type WorkStatus = "open" | "in_progress" | "blocked" | "deferred" | "closed";
export const WORK_STATUSES: readonly WorkStatus[] = ["open","in_progress","blocked","deferred","closed"];
export const DESCRIPTION_CAP = 4000;
export interface WorkIssue {
  id: string;
  title: string;
  type: string;
  status: WorkStatus;
  priority: number;
  parent: string | null;
  labels: string[];
  assignee: string | null;
  externalRef: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  heartbeatAt: string | null;
  /** Read-only, capped at DESCRIPTION_CAP; present only when bd returned one. The Needs-you detail parses OPTIONS out of it (never invents them). */
  description?: string;
}
// issueId depends on dependsOnId. type "blocks" = hard blocker; "parent-child" = containment (dependsOnId is the parent).
export interface WorkDep {
  issueId: string;
  dependsOnId: string;
  type: string;
}
