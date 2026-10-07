// Ported from BeadBoard (MIT, see third_party/beadboard-LICENSE.txt), src/lib/types.ts @ 9e3059d. A BeadIssue SUBSET: only the
// fields the ported graph reads. See third_party/NOTICE-beadboard.md.
export const BEAD_STATUSES = ["open", "in_progress", "blocked", "deferred", "closed", "tombstone", "pinned", "hooked"] as const;
export type BeadStatus = (typeof BEAD_STATUSES)[number];
export const BEAD_DEPENDENCY_TYPES = ["blocks", "parent", "relates_to", "duplicates", "supersedes", "replies_to"] as const;
export type BeadDependencyType = (typeof BEAD_DEPENDENCY_TYPES)[number];
export type BeadIssueType = "task" | "bug" | "feature" | "epic" | "chore" | (string & {});
export interface BeadDependency { type: BeadDependencyType; target: string }
export interface BeadIssue {
  id: string;
  title: string;
  status: BeadStatus;
  priority: number;
  issue_type: BeadIssueType;
  assignee: string | null;
  labels: string[];
  dependencies: BeadDependency[];
  created_at: string;
  updated_at: string;
}
