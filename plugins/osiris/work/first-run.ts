// First-run / no-tracker picker model (pure). Candidates come from the existing `workTrackers` reader: repos that already hold a .beads folder.
import { FIRST_RUN_INTRO } from "../shell/help-content.ts";

export const BD_INIT_COMMAND = "bd init";
export type TrackerCandidate = { path: string; name: string; kind: string };
export function trackerPickerModel(trackers: readonly TrackerCandidate[]) {
  const seen = new Set<string>(), candidates: { path: string; label: string }[] = [];
  for (const t of trackers) if (!seen.has(t.path)) { seen.add(t.path); candidates.push({ path: t.path, label: t.kind === "sandbox" ? `${t.name} (sandbox)` : t.name }); }
  return { empty: candidates.length === 0, candidates, beadsLine: FIRST_RUN_INTRO.beads, herdrLine: FIRST_RUN_INTRO.herdr, initCommand: BD_INIT_COMMAND, pickLabel: "Pick a folder" };
}
