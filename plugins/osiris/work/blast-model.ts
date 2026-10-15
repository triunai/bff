// Blast (owner 23:30): a button at each Factory silo (Intake, Claim, Gate) and on the Locks stat that opens the ONE team-dispatch dialog
// PREFILLED with the stuck beads of that silo. PURE: target selection, the cap, the estimate and the changed-since-open check.
// It dispatches nothing; work/herdr-dispatch (dispatchTeamToHerdr + HerdrDispatchDialog) is the only dispatch path, and its guard, Herdr
// binding and demo gates stay in force. CLIENT-SAFE: the agent prompts live server-side in team-dispatch/prompts.ts, keyed by the preset.
import type { FloorLock, FloorToken, FloorWorker, HeatMode } from "./factory-floor-model.ts";
import { heatLegend } from "./heat-ramps.ts";
import { BLAST_LEAD, BLAST_MAX_AGENTS, BLAST_MAX_TARGETS, BLAST_SILOS, BLAST_WORKER, isBlastSilo, type BlastSilo, type TeamMember } from "./team-dispatch/plan.ts";

// ONE definition of the silos and the cap (team-dispatch/plan.ts, where the server validates them); re-exported here for the client.
export { BLAST_LEAD, BLAST_WORKER, BLAST_MAX_AGENTS, BLAST_MAX_TARGETS, BLAST_SILOS, isBlastSilo };
export type { BlastSilo };
/** The owner's standing routing: a Sonnet lead who also judges, Haiku 5.5 (pinned) for the bounded per-bead steps. */

export const BLAST_LABEL: Readonly<Record<BlastSilo, string>> = { intake: "Blast intake", claim: "Blast claims", gate: "Blast gate", locks: "Blast locks" };
export const BLAST_ROLE: Readonly<Record<BlastSilo, { who: string; does: string; noun: string }>> = {
  intake: { who: "Builders", does: "One agent per ready item claims it and builds it in its own worktree.", noun: "ready item" },
  claim: { who: "Takers", does: "One agent per ghost claim either takes the item over or releases it, writing down the reason.", noun: "ghost claim" },
  gate: { who: "Reviewers", does: "One independent reviewer per waiting item; nobody reviews work they wrote.", noun: "waiting item" },
  locks: { who: "Lock checkers", does: "One agent per stale lock checks whether its holder is still alive and releases only the dead ones, never a live one.", noun: "lock" },
};

export type BlastTarget = { id: string; title: string; sinceMs: number | null; heatStep: number | null };
/** The slice of a FloorFrame the selection reads (structural, so tests need no full frame). */
export type BlastFrame = {
  heatMode: HeatMode;
  tokens: readonly Pick<FloorToken, "id" | "title" | "station" | "stage" | "blocked" | "waitingOn" | "sinceMs" | "heatStep" | "gateRole" | "built">[];
  workers: readonly Pick<FloorWorker, "beadId" | "presence" | "cost">[];
  locks: readonly Pick<FloorLock, "key" | "beadId" | "sinceMs">[];
};

/** THE ghost-claim definition: a worker whose agent terminal and transcript are gone. The floor header count and the Claim blast both read this. */
export const ghostWorkers = <W extends { presence: string }>(workers: readonly W[]): W[] => workers.filter(w => w.presence === "ghost");

const oldestFirst = (a: BlastTarget, b: BlastTarget): number => (b.sinceMs ?? -1) - (a.sinceMs ?? -1) || a.id.localeCompare(b.id);

/** Every bead a silo's Blast could act on, oldest first (no band, no cap). Ready = Intake and nothing unmet blocks it; a ghost claim = a bead
 * at Claim, or whose agent is a ghost, with no live agent; waiting = held at the Gate for a reviewer AND built (in_progress; an open bead with only a review label has nothing to review); locks = the bead each lock holds. */
export function blastSilo(f: BlastFrame, silo: BlastSilo): BlastTarget[] {
  const tok = new Map(f.tokens.map(t => [t.id, t]));
  const live = new Set(f.workers.filter(w => w.presence === "live").map(w => w.beadId));
  const ghost = new Set(ghostWorkers(f.workers).map(w => w.beadId));
  const of = (t: BlastFrame["tokens"][number]): BlastTarget => ({ id: t.id, title: t.title, sinceMs: t.sinceMs, heatStep: t.heatStep });
  let out: BlastTarget[];
  if (silo === "intake") out = f.tokens.filter(t => t.station === "intake" && t.stage === "ready" && !t.blocked && t.waitingOn.length === 0).map(of);
  else if (silo === "claim") out = f.tokens.filter(t => !live.has(t.id) && ((t.station === "claim") || ((t.station === "build") && ghost.has(t.id)))).map(of);
  else if (silo === "gate") out = f.tokens.filter(t => t.station === "gate" && t.gateRole === "held" && t.built).map(of);
  else {
    const seen = new Set<string>();
    out = f.locks.filter(l => !seen.has(l.beadId) && (seen.add(l.beadId), true)).map(l => { const t = tok.get(l.beadId); return { id: l.beadId, title: t?.title ?? l.beadId, sinceMs: l.sinceMs ?? t?.sinceMs ?? null, heatStep: t?.heatStep ?? null }; });
  }
  return out.sort(oldestFirst);
}

export type BlastPlan = {
  silo: BlastSilo; band: number | null; bandLabel: string | null;
  /** What this blast will act on (capped, oldest first) and how many more wait for the next blast. */
  targets: BlastTarget[]; waiting: number; matching: number;
  lead: TeamMember; worker: TeamMember; agents: number; cap: number;
  /** The header's "ghost claims" count (ghostWorkers). The Claim blast is wider (it also takes claimed beads that never had an agent), so the dialog shows both. */
  ghostClaims: number;
  /** A dollar estimate from per-bead costs the floor already holds, or null when there is no cost data. Always an ESTIMATE. */
  estimateUsd: number | null; estimateBasis: string;
};

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** The prefilled plan. An active heat `band` (0..4, the legend swatch) narrows the blast to that band of the CURRENT heat mode; no band = every
 * bead of the silo, oldest first. */
export function blastPlan(f: BlastFrame, silo: BlastSilo, band: number | null): BlastPlan {
  const all = blastSilo(f, silo), usable = band !== null && Number.isInteger(band) && band >= 0 && band <= 4 ? band : null;
  const matching = usable === null ? all : all.filter(t => t.heatStep === usable);
  const targets = matching.slice(0, BLAST_MAX_TARGETS);
  const costs = f.workers.map(w => w.cost).filter((c): c is number => c !== null && Number.isFinite(c) && c > 0);
  const per = costs.length ? median(costs) : null;
  return {
    silo, band: usable, bandLabel: usable === null ? null : `${f.heatMode === "impact" ? "Blocking" : f.heatMode[0].toUpperCase() + f.heatMode.slice(1)} ${heatLegend(f.heatMode)[usable].label}`,
    targets, waiting: matching.length - targets.length, matching: matching.length,
    lead: BLAST_LEAD, worker: BLAST_WORKER, agents: targets.length ? targets.length + 1 : 0, cap: BLAST_MAX_AGENTS, ghostClaims: ghostWorkers(f.workers).length,
    estimateUsd: per === null || !targets.length ? null : Math.round(per * targets.length * 100) / 100,
    estimateBasis: per === null ? "no per-bead cost data yet" : `about $${per.toFixed(2)} per bead (median of ${costs.length} bead${costs.length === 1 ? "" : "s"} with cost data); Haiku workers usually cost less`,
  };
}

export type BlastSkip = { id: string; reason: string };
/** D-138: a target whose bead left the silo since the blast opened (someone claimed it, it landed, it was released) is SKIPPED, and said so. `current` is the
 * silo's membership NOW (blastSilo on the latest frame). Never silent: the caller shows every skip. */
export function reconcileBlast(opened: readonly BlastTarget[], silo: BlastSilo, current: readonly { id: string }[]): { go: BlastTarget[]; skipped: BlastSkip[] } {
  const now = new Set(current.map(c => c.id)), go: BlastTarget[] = [], skipped: BlastSkip[] = [];
  for (const t of opened) {
    if (now.has(t.id)) go.push(t);
    else skipped.push({ id: t.id, reason: `no longer ${silo === "locks" ? "locked" : `in ${silo}`}: it changed state after you opened this blast` });
  }
  return { go, skipped };
}
export const skippedText = (s: readonly BlastSkip[]): string => s.length ? `Skipped ${s.length}: ${s.map(x => `${x.id} (${x.reason})`).join("; ")}.` : "";
