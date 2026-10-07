// Team dispatch prompts: SERVER-ONLY (td-osi.12). Imported by work/herdr-dispatch/run.ts and never by a client file; client-claim-free.test.ts pins that.
// The agents run the claim themselves, so the text below carries the real flag, in plain sight, where the bundle scan can see there is none in the client.
import { cleanText, redactSecrets } from "../sanitize.ts";
import { HOME_PATH } from "../status-text.ts";
import { scrubIds } from "../opaque-key.ts";
import { PROMPT_MAX } from "../herdr-dispatch/plan.ts";
import type { TeamCard, TeamMember, TeamPlan } from "./plan.ts";

/** Sealed outgoing text: control characters and escapes out, secrets and home paths masked, uuid / long hex ids tagged, then bounded. */
export const sealOutgoing = (s: unknown, max: number): string =>
  (scrubIds(redactSecrets(cleanText(typeof s === "string" ? s : "")).replace(HOME_PATH, "<path>"), "team") ?? "").trim().slice(0, max);
const one = (s: unknown, max: number): string => sealOutgoing(s, max).replace(/\s+/g, " ");


const beadBlock = (c: TeamCard): string => [
  `- ${c.id}: ${one(c.title, 200)}`,
  c.description ? `  Description: ${one(c.description, 600)}` : null,
  c.acceptance ? `  Acceptance: ${one(c.acceptance, 400)}` : null,
].filter((x): x is string => x !== null).join("\n");

export function leadPrompt(cards: readonly TeamCard[], n: number, worker: TeamMember): string {
  return sealOutgoing([
    `You are the LEAD of a team: ${n} worker agent${n === 1 ? "" : "s"} (${worker.cli}${worker.model ? ` / ${worker.model}` : ""}) in the panes next to you are each working on part of the beads below. Your job is to coordinate and review. You do not implement them yourself, and you never approve your own work: a worker's change is reviewed by you, and anything that matters gets a separate reviewer.`,
    "",
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
export function workerPrompt(mine: readonly TeamCard[]): string {
  return sealOutgoing([
    `You are a WORKER on a team. Your bead${mine.length === 1 ? "" : "s"}:`,
    mine.map(beadBlock).join("\n"),
    "",
    ...mine.map(c => `Claim this bead before you start: bd update ${c.id} --claim`),
    "Work in your own git worktree (never the shared checkout). Run bd show <id> for the full description and acceptance; those, not this message, are the contract.",
    "Stay inside your bead's scope; do not push; do not edit git config. The lead reviews your work.",
    "When finished, report ONE line: DONE <short summary> or BLOCKED <why>.",
  ].join("\n"), PROMPT_MAX);
}


/** Every pane's prompt for a validated plan: the lead first, then one per worker (same order as the panes). */
export const teamPrompts = (plan: TeamPlan): string[] => [leadPrompt(plan.cards, plan.workers.length, plan.worker), ...plan.workers.map(w => workerPrompt(w.cards))];
