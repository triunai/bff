// Osiris additions to the ported graph (not BeadBoard code): stage-driven status, the change-motion rule, and the waves overlay.
import type { Stage } from "../replay.ts";
import { STAGES } from "../replay.ts";
import { planWaves } from "../surface-model.ts";
import type { WorkSurfaceSnapshot } from "../surface-types.ts";
import type { BeadStatus } from "./types.ts";

/** Stage at the scrubbed time -> the BeadBoard status the ported analysis reads (review has no BeadBoard twin: it is still in progress). */
export const stageStatus = (s: Stage): BeadStatus => ({ waiting: "blocked", ready: "open", building: "in_progress", review: "in_progress", done: "closed" } as const)[s];

export type Motion = "pulse" | "rework";
/** One node's motion between two stage maps. `back` = the stage went backwards while time moved FORWARD (review -> building is rework);
 *  scrubbing backwards in time is a plain pulse, never "rework". */
export function motionFor(before: Stage | undefined, after: Stage | undefined, timeForward: boolean): Motion | null {
  if (!before || !after || before === after) return null;
  return timeForward && STAGES.indexOf(after) < STAGES.indexOf(before) ? "rework" : "pulse";
}

export type WaveOverlay = { waveOf: Map<string, number>; unschedulable: string[] };
/** `Wave N` is planWaves' 0-based level + 1 (wave 1 = can start now). */
export function waveOverlay(snap: WorkSurfaceSnapshot): WaveOverlay {
  const plan = planWaves(snap), waveOf = new Map<string, number>();
  for (const w of plan.waves) for (const id of w.ids) waveOf.set(id, w.index + 1);
  return { waveOf, unschedulable: plan.unschedulable };
}
