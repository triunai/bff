// Team dispatch prompts: SERVER-ONLY (td-osi.12). Imported by work/herdr-dispatch/run.ts and never by a client file; client-claim-free.test.ts pins that.
// The agents run the claim themselves, so the text below carries the real flag, in plain sight, where the bundle scan can see there is none in the client.
import { cleanText, redactSecrets } from "../sanitize.ts";
import { HOME_PATH } from "../status-text.ts";
import { scrubIds } from "../opaque-key.ts";
import { PROMPT_MAX } from "../herdr-dispatch/plan.ts";
import type { BlastSilo, TeamCard, TeamMember, TeamPlan } from "./plan.ts";

/** Sealed outgoing text: control characters and escapes out, secrets and home paths masked, uuid / long hex ids tagged, then bounded. */
export const sealOutgoing = (s: unknown, max: number): string =>
  (scrubIds(redactSecrets(cleanText(typeof s === "string" ? s : "")).replace(HOME_PATH, "<path>"), "team") ?? "").trim().slice(0, max);
const one = (s: unknown, max: number): string => sealOutgoing(s, max).replace(/\s+/g, " ");


const beadBlock = (c: TeamCard): string => [
  `- ${c.id}: ${one(c.title, 200)}`,
  c.description ? `  Description: ${one(c.description, 600)}` : null,
  c.acceptance ? `  Acceptance: ${one(c.acceptance, 400)}` : null,
].filter((x): x is string => x !== null).join("\n");

/** Factory Blast presets: the one extra paragraph each silo adds to the lead's brief and to every worker's. Server-side text only. */
const BLAST_LEAD_LINE: Readonly<Record<BlastSilo, string>> = {
  intake: "BLAST: Intake. These beads are ready and unclaimed. Each worker claims one and builds it. You are also the JUDGE: accept a worker's DONE only after reading its diff and the real output of the checks.",
  claim: "BLAST: Claims. These beads are claimed but have no live agent (ghost claims). Each worker either takes one over or releases it with a written reason. You are the JUDGE: reject any takeover or release that does not name the evidence the previous owner is gone (no live pane, no recent commit or transcript).",
  gate: "BLAST: Gate. These beads wait for a reviewer. Each worker reviews one independently and READ-ONLY. You are the JUDGE: a verdict without cited evidence from the diff is rejected, and no worker may review work it wrote.",
  locks: "BLAST: Locks. These beads hold a lock that looks stale. Each worker checks whether the holder is still alive and releases the lock only if it is dead. You are the JUDGE: a release without evidence of a dead holder is rejected, and a lock that might be live is never released.",
};
const BLAST_WORKER_LINE: Readonly<Record<BlastSilo, string[]>> = {
  intake: [],
  claim: ["Your bead is claimed but no agent is attached. First find out whether its previous owner is really gone: check bd show for the assignee, the Herdr panes, the branch and worktree, and the last commit or transcript time.", "If the owner is gone and the work is worth continuing, release the stale claim with `bd unclaim <id>` (or let `bd reclaim` revert expired leases), then claim it yourself and continue in your own worktree. If it should not continue, `bd unclaim <id>` and write the reason on the bead with `bd note`. Read `bd unclaim --help` and `bd reclaim --help` first (read-only) for exact usage.", "NEVER use `bd update --force` or `bd unclaim --force`: it overwrites another actor's claim, which may be live. If the owner might still be alive, do nothing and report BLOCKED."],
  gate: ["You are an INDEPENDENT REVIEWER. Read the bead, then its branch or diff. Do not edit files, do not claim or move the bead, and do not review work you wrote.", "Report ONE line: APPROVE <evidence> or REJECT <what is wrong, with the file and line>."],
  locks: ["The lock on your bead looks stale. Find the holder (the claim, the scope lease, the pane) and prove whether it is alive: a live Herdr pane, a running process, a commit or transcript write in the last few minutes.", "Release the lock ONLY if the holder is provably dead, and say how you proved it. If there is any doubt it is live, release nothing and report BLOCKED. Never release a live lock."],
};

export function leadPrompt(cards: readonly TeamCard[], n: number, worker: TeamMember, preset: BlastSilo | null = null): string {
  return sealOutgoing([
    `You are the LEAD of a team: ${n} worker agent${n === 1 ? "" : "s"} (${worker.cli}${worker.model ? ` / ${worker.model}` : ""}) in the panes next to you are each working on part of the beads below. Your job is to coordinate and review. You do not implement them yourself, and you never approve your own work: a worker's change is reviewed by you, and anything that matters gets a separate reviewer.`,
    "",
    ...(preset ? [BLAST_LEAD_LINE[preset], ""] : []),
    "OBJECTIVE", "Get every bead below to its acceptance criteria.",
    "CURRENT STATE", cards.map(beadBlock).join("\n"),
    "DESIRED STATE", "Each bead's acceptance is met, the validation commands pass, and each worker has reported one line DONE or BLOCKED.",
    "ALLOWED FILES", "Not known in advance: inspect first (bd show <id> for the full description and acceptance, then read the repo) and tell each worker which files are theirs before they edit.",
    "ACCEPTANCE", "Each bead's own acceptance text, checked by you against the worker's diff.",
    "VALIDATION", "Run the repo's own checks (typecheck and tests) for each worker's branch and read the real output.",
    "NON-GOALS", "Do not widen scope, do not push, do not touch another bead's files, do not edit git config.",
    "STOP CONDITIONS", "Stop and report BLOCKED if a bead's premise is false, two workers need the same file, or a check fails twice.",
    "",
    "Verify the factual claims in this brief against the repo before relying on them, and end your report with what you could NOT verify.",
  ].join("\n"), PROMPT_MAX);
}
export function workerPrompt(mine: readonly TeamCard[], preset: BlastSilo | null = null): string {
  return sealOutgoing([
    `You are a WORKER on a team. Your bead${mine.length === 1 ? "" : "s"}:`,
    mine.map(beadBlock).join("\n"),
    "",
    ...(preset ? BLAST_WORKER_LINE[preset] : []),
    ...(preset === null || preset === "intake" ? mine.map(c => `Claim this bead before you start: bd update ${c.id} --claim`) : []),
    "Work in your own git worktree (never the shared checkout). Run bd show <id> for the full description and acceptance; those, not this message, are the contract.",
    "Stay inside your bead's scope; do not push; do not edit git config. The lead reviews your work.",
    "When finished, report ONE line: DONE <short summary> or BLOCKED <why>.",
  ].join("\n"), PROMPT_MAX);
}


/** Every pane's prompt for a validated plan: the lead first, then one per worker (same order as the panes). */
export const teamPrompts = (plan: TeamPlan): string[] => [leadPrompt(plan.cards, plan.workers.length, plan.worker, plan.preset), ...plan.workers.map(w => workerPrompt(w.cards, plan.preset))];
