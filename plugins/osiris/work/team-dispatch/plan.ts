// Team dispatch (td-osi.12 lane AF): PURE planning for "an Opus lead and Sonnet workers" started from selected Board cards. No I/O, no React.
// One Herdr tab, one LEAD pane and one pane per WORKER. Osiris only opens the panes; the agents claim their own beads (no bd write here).
// CLIENT-SAFE: this file carries structure only (cards, members, labels). The agent prompts are built and sealed SERVER-SIDE in prompts.ts.
import { BEAD_ID_RE, MODEL_RE } from "../runtime-models.ts";
import { isHerdrCli, type HerdrCli } from "../herdr-dispatch/plan.ts";

/** The product name of the team action; the Board's button uses this one label. */
export const TEAM_LABEL = "Dispatch team";
export const TEAM_MAX_WORKERS = 6;
export type TeamMember = { cli: HerdrCli; model: string | null };
/** The defaults only: the CLI/model choices themselves come from data (HERDR_CLIS, the dialog's availability list). */
export const TEAM_DEFAULT_LEAD: TeamMember = { cli: "claude", model: "opus" };
export const TEAM_DEFAULT_WORKER: TeamMember = { cli: "claude", model: "sonnet" };
export type TeamCard = { id: string; title: string; description?: string; acceptance?: string };
export type TeamPane = TeamMember & { role: "lead" | "worker"; label: string; cards: TeamCard[] };
export type TeamPlan = { tab: string; lead: TeamPane; workers: TeamPane[]; beadIds: string[]; cards: TeamCard[]; worker: TeamMember; epic: string | null };
export type TeamInput = { cards: readonly TeamCard[]; lead?: TeamMember; worker?: TeamMember; workers?: number; epic?: string | null };
export type TeamResult = { ok: true; plan: TeamPlan } | { ok: false; reason: string };

const tabName = (epicOrFirst: string): string => `team-${epicOrFirst.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)}`;
export const clampWorkers = (n: number | undefined, cards: number): number => Math.max(1, Math.min(TEAM_MAX_WORKERS, Math.floor(typeof n === "number" && Number.isFinite(n) ? n : cards)));

export function buildTeamPlan(input: TeamInput): TeamResult {
  const cards = input.cards ?? [];
  if (!cards.length) return { ok: false, reason: "select at least one card" };
  for (const c of cards) if (!BEAD_ID_RE.test(String(c?.id))) return { ok: false, reason: "a selected card has an id Osiris will not pass to an agent" };
  if (new Set(cards.map(c => c.id)).size !== cards.length) return { ok: false, reason: "the same card was selected twice" };
  const lead = input.lead ?? TEAM_DEFAULT_LEAD, worker = input.worker ?? TEAM_DEFAULT_WORKER;
  for (const m of [lead, worker]) {
    if (!isHerdrCli(m.cli)) return { ok: false, reason: "that agent is not one Osiris can start (claude, codex or gemini)" };
    if (m.model !== null && !MODEL_RE.test(m.model)) return { ok: false, reason: "a model id may only use letters, digits and . _ : -" };
  }
  const n = clampWorkers(input.workers, cards.length);
  const buckets: TeamCard[][] = Array.from({ length: n }, () => []);
  cards.forEach((c, i) => buckets[i % n].push(c));
  const used = buckets.filter(b => b.length > 0); // fewer cards than workers: no idle worker
  const epic = input.epic && BEAD_ID_RE.test(input.epic) ? input.epic : null;
  return { ok: true, plan: {
    tab: tabName(epic ?? cards[0].id), beadIds: cards.map(c => c.id), cards: [...cards], worker, epic,
    lead: { ...lead, role: "lead", label: "Lead", cards: [...cards] },
    workers: used.map((b, i) => ({ ...worker, role: "worker" as const, label: `Worker ${i + 1}: ${b.map(c => c.id).join(" ")}`.slice(0, 60), cards: b })),
  } };
}
