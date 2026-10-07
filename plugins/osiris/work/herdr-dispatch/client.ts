// Dispatch to Herdr: the ONE client primitive. Any surface (the Board's status, an inspector, a calendar day) calls dispatchToHerdr after the
// shared HerdrDispatchDialog has asked the human to confirm. app.tsx binds the RPC caller and the "open the Terminal tab" action once.
import type { HerdrCli, HerdrDispatchResult } from "./plan.ts";
import type { TeamPlan } from "../team-dispatch/plan.ts";
import type { HerdrTeamResult } from "./run.ts";

export type DispatchBinding = {
  call(name: "herdrDispatch", input: { prompt: string; cli: HerdrCli; title: string; repo?: string }): Promise<HerdrDispatchResult>;
  call(name: "herdrTeam", input: { repo?: string; epic?: string; lead: { cli: HerdrCli; model: string | null }; worker: { cli: HerdrCli; model: string | null }; cards: { id: string; title: string }[]; workers: number }): Promise<HerdrTeamResult>;
  call(name: "herdrClis", input: Record<string, never>): Promise<{ clis: HerdrCli[]; paths?: Partial<Record<HerdrCli, string>> }>;
  /** Shows the Terminal tab (the fallback when herdr cannot open a pane). */
  openTerminal(): void;
  copy(text: string): Promise<void>;
  repo?: string;
  /** The agent the human dispatched with last (persisted by the host, try/catch inside) and the one with the newest live activity; both optional. */
  lastCli?(): HerdrCli | null;
  rememberCli?(c: HerdrCli): void;
  liveCli?(): HerdrCli | null;
};
let bound: DispatchBinding | null = null;
export const bindHerdrDispatch = (b: DispatchBinding | null): void => { bound = b; };
export const herdrDispatchBinding = (): DispatchBinding | null => bound;

export type DispatchOutcome = { ok: true; paneId: string } | { ok: false; reason: string; fellBack: boolean; message: string };
/** Confirm FIRST (the dialog), then call this. If herdr cannot open a pane, the text is copied and the Terminal tab opens; the outcome says so in plain words. */
export async function dispatchToHerdr(req: { prompt: string; cli: HerdrCli; title: string }, b: DispatchBinding | null = bound): Promise<DispatchOutcome> {
  if (!b) return { ok: false, reason: "dispatch is not available here", fellBack: false, message: "Dispatch is not available here." };
  let r: HerdrDispatchResult;
  try { r = await b.call("herdrDispatch", { ...req, ...(b.repo ? { repo: b.repo } : {}) }); }
  catch (e) { r = { ok: false, reason: e instanceof Error ? e.message : String(e), fallback: true }; }
  if (r.ok) return { ok: true, paneId: r.paneId };
  if (!r.fallback) return { ok: false, reason: r.reason, fellBack: false, message: r.reason };
  let copied = false; try { await b.copy(req.prompt); copied = true; } catch { /* clipboard blocked */ }
  b.openTerminal();
  return { ok: false, reason: r.reason, fellBack: true, message: `${r.reason}. ${copied ? "The text is copied" : "The text could not be copied"} and the Terminal tab is open: start your agent there and paste it.` };
}

export type TeamOutcome = { ok: true; message: string } | { ok: false; message: string };
/** Confirm FIRST (the dialog), then call this: one new tab, the lead pane first, then the workers. Osiris opens panes only; the agents claim their own beads. */
export async function dispatchTeamToHerdr(plan: TeamPlan, b: DispatchBinding | null = bound): Promise<TeamOutcome> {
  if (!b) return { ok: false, message: "Dispatch is not available here." };
  let r: HerdrTeamResult;
  try { r = await b.call("herdrTeam", { ...(b.repo ? { repo: b.repo } : {}), ...(plan.epic ? { epic: plan.epic } : {}), lead: { cli: plan.lead.cli, model: plan.lead.model }, worker: { cli: plan.worker.cli, model: plan.worker.model }, cards: plan.cards.map(c => ({ id: c.id, title: c.title.slice(0, 200) })), workers: plan.workers.length }); }
  catch (e) { return { ok: false, message: `Team not started: ${e instanceof Error ? e.message : String(e)}` }; }
  if (r.ok) return { ok: true, message: `Team started: tab ${r.tab}, 1 lead + ${plan.workers.length} worker${plan.workers.length === 1 ? "" : "s"}` };
  return { ok: false, message: `Team not fully started (${r.started} of ${plan.workers.length + 1} panes): ${r.reason}.` };
}
