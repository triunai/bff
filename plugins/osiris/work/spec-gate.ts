// Spec gate (Qoder "spec approved -> set as Goal", owner td-osi.9). Pure: Dispatch asks it BEFORE claiming, and it answers
// whether the bead may be dispatched and which text the agent should pin as its Goal. It never writes a label: approving a
// spec is the owner's act in bd (`bd label add <id> spec-approved`); Osiris only reads it.
import type {LaneBead} from "./prompt.ts";

export const SPEC_APPROVED_LABEL = "spec-approved";

/** WorkIssue has no acceptance field; LaneBead does (dispatch.ts readBead fills it from `bd show --json` acceptance_criteria). */
export type SpecGateIssue = Pick<LaneBead, "id" | "title" | "labels" | "acceptance">;
export type SpecGateOptions = {ownerOverride?: boolean};
export type GoalSource = "acceptance" | "title";
export type SpecGateResult =
  | {ok: true; goal: string; goalSource: GoalSource; approvedBy: "spec-label" | "owner-override"}
  | {ok: false; reason: string};

export function specGate(issue: SpecGateIssue, opts: SpecGateOptions = {}): SpecGateResult {
  const labelled = issue.labels.includes(SPEC_APPROVED_LABEL);
  if (!labelled && opts.ownerOverride !== true) return {ok: false, reason: `The spec for ${issue.id} is not approved yet. Add the ${SPEC_APPROVED_LABEL} label in bd, or dispatch with an owner override.`};
  // Acceptance criteria are the spec's "done when"; the title is only the fallback. Whitespace-only text counts as missing.
  const acceptance = issue.acceptance?.trim(), title = issue.title.trim();
  const goal: {goal: string; goalSource: GoalSource} | null = acceptance ? {goal: acceptance, goalSource: "acceptance"} : title ? {goal: title, goalSource: "title"} : null;
  if (!goal) return {ok: false, reason: `${issue.id} has no acceptance criteria and no title, so there is no Goal to give the agent.`};
  return {ok: true, ...goal, approvedBy: labelled ? "spec-label" : "owner-override"};
}
