// The Blast silos and the agent cap: ONE definition, dependency-free so the client model, the plan builder and the server schema share it.
// (Kept out of plan.ts, which team-dispatch.test.ts keeps free of anything that looks like the claim command.)
export const BLAST_SILOS = ["intake", "claim", "gate", "locks"] as const;
export type BlastSilo = (typeof BLAST_SILOS)[number];
export const isBlastSilo = (x: unknown): x is BlastSilo => typeof x === "string" && (BLAST_SILOS as readonly string[]).includes(x);
/** The owner's standing routing for every blast, ENFORCED server-side in buildTeamPlan (whatever a client sends is ignored): a Sonnet lead who also judges, Haiku 5.5 pinned for the bounded per-bead steps. */
export const BLAST_LEAD = { cli: "claude", model: "sonnet" } as const;
export const BLAST_WORKER = { cli: "claude", model: "claude-haiku-5-5" } as const;
/** Hard cap on a blast: ten agents, one lead and up to nine workers (one worker per bead). The rest wait for the next blast. */
export const BLAST_MAX_AGENTS = 10;
export const BLAST_MAX_TARGETS = BLAST_MAX_AGENTS - 1;
