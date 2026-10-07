// Pure view model for the drift line (ui-v2 W14). Input is driftFindings() output, ALREADY sorted (severity, then oldest): this never
// re-sorts or re-filters, so a review bead with a detached pane (excused inside driftFindings) can never reappear here. No DOM, no clock.
import type { DriftFinding, DriftRule, DriftSeverity } from "../work/drift.ts";
import { formatAge, WARN } from "../work/surface-model.ts";

export const DRIFT_SHOWN = 3;
/** The drift list starts collapsed to one summary line ("Drift 9"); the owner could not reach the Board under nine open rows. */
export const DRIFT_DEFAULT_OPEN = false;
/** Badge words. bdi's own rules reuse surface-model's WARN (the same words the work tree used to print), never a copy. */
const OWN: Record<string, string> = {
  "agent-no-bead": "agent · no bead", "closed-agent-running": "closed · agent running", "closed-worktree-dirty": "closed · worktree dirty",
  "agent-idle": "agent idle", conflict: "collision",
};
export const driftKindText = (rule: DriftRule | string): string => OWN[rule] ?? WARN[rule] ?? String(rule);

/** Volume by severity, always in the drift hue: error = solid badge + row edge; warn = tinted badge + edge; info = coloured text. */
export type DriftVolume = "solid" | "tint" | "text";
export const driftVolume = (s: DriftSeverity): DriftVolume => (s === "error" ? "solid" : s === "warn" ? "tint" : "text");

export type DriftRow = { key: string; badge: string; volume: DriftVolume; edge: boolean; message: string; worktree: string | null; age: string | null; beadId: string | null; paneId: string | null };
export type DriftLineModel = { count: number; rows: DriftRow[]; more: number };

export function driftLineModel(findings: readonly DriftFinding[], now: number, expanded = false): DriftLineModel {
  const shown = expanded ? findings : findings.slice(0, DRIFT_SHOWN);
  return {
    count: findings.length,
    more: findings.length - shown.length,
    rows: shown.map((f, i) => ({
      key: `${f.rule}:${f.beadId ?? f.paneId ?? f.worktree ?? ""}:${i}`, badge: driftKindText(f.rule), volume: driftVolume(f.severity), edge: f.severity !== "info",
      message: f.message, worktree: f.worktree ?? null, age: f.since === undefined ? null : formatAge(now - f.since), beadId: f.beadId ?? null, paneId: f.paneId ?? null,
    })),
  };
}
