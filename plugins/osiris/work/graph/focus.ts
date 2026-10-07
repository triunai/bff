// First-open framing and node chips for the graph (pure, no React).
import type { WorkSurfaceSnapshot } from "../surface-types.ts";
import { buildWorkGraph } from "../work-model.ts";
import { cleanText } from "../sanitize.ts";

/** Bead ids the graph should frame on first open: in-progress beads first, then ready ones (the readiness frontier), else every bead.
 *  Never empty while the snapshot has beads. Closed beads are only ever included by the "else all" fallback. */
/** GRAPH-7: a large ready frontier must not crop the first view; only this many ready beads join the in-progress ones in the framing. */
export const MAX_READY_FOCUS = 3;
export function initialFocus(snap: WorkSurfaceSnapshot, now: number = snap.generatedAt): string[] {
  const active = snap.issues.filter((i) => i.status === "in_progress").map((i) => i.id);
  const ready = new Set(buildWorkGraph(snap.issues, snap.deps, now).readyFrontier);
  const out = [...active, ...snap.issues.filter((i) => ready.has(i.id) && i.status !== "in_progress").map((i) => i.id).slice(0, MAX_READY_FOCUS)];
  return out.length ? out : snap.issues.map((i) => i.id);
}

export const MAX_CHIPS = 4;
export type LabelChip = { text: string; title: string };
/** Chip text for a bead's labels: `role:lead` -> `lead`, `model:opus` -> `opus` (the full label stays in `title`); other labels show as they are.
 *  At most MAX_CHIPS chips; `more` is how many were left out. Labels are untrusted text, so they are cleaned first. Order is kept. */
export function labelChips(labels: readonly string[]): { chips: LabelChip[]; more: number } {
  const all = labels.map((l) => cleanText(String(l ?? "")).trim()).filter(Boolean).map((full) => ({ text: full.replace(/^(?:role|model):/i, "") || full, title: full }));
  return { chips: all.slice(0, MAX_CHIPS), more: Math.max(0, all.length - MAX_CHIPS) };
}
