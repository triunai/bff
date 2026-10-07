// Where a click goes (pure). ONE table per question, so a call to action can never open a generic overview by accident. app.tsx applies a
// route through the breadcrumb `navTo` (a location), the panel opener (a panel) or the agent opener (a pane or the agent inspector).
import type { Loc } from "./nav-history.ts";

export type HomeTarget = "needs" | "agents" | "cost" | "changes";
export type Route = { kind: "loc"; loc: Loc } | { kind: "panel"; panel: string };

/** Home's four "Open" buttons. Needs-you is a panel (the same one the header chip opens); the rest are breadcrumb locations. */
export const HOME_ROUTES: Readonly<Record<HomeTarget, Route>> = {
  needs: { kind: "panel", panel: "work.decisions" },
  agents: { kind: "loc", loc: { view: "calls", sub: "Agents" } },
  cost: { kind: "loc", loc: { view: "calls", sub: "Cost & cache" } },
  changes: { kind: "loc", loc: { view: "history", sub: "working-tree" } },
};
export const homeRoute = (t: HomeTarget): Route => HOME_ROUTES[t];
/** A landed commit on Home opens the commit inspector (History > Commits with that commit selected). */
export const commitLoc = (sha: string): Loc => ({ view: "history", sub: "commits", item: sha });
/** A calendar thread chip or a W-NNN link opens Work > Threads with that thread selected, never the Commits graph. */
export const threadLoc = (id: string): Loc => ({ view: "work", sub: "threads", item: id });

export type AgentRoute = { kind: "pane"; terminalId: string } | { kind: "inspector"; key: string };
/** A click on an agent goes TO that agent: its Herdr pane in the Terminal tab when it is joined to one, else the agent inspector. Never an overview.
 *  Joined = a terminal titled like the lane, or like the pane the agent's bead is dispatched into. */
export function agentRoute(lane: { key: string; label: string }, terminals: readonly { id: string; label: string }[] | null | undefined, beadPaneTitle?: string | null): AgentRoute {
  const t = terminals?.find(x => x.label === lane.label) ?? (beadPaneTitle ? terminals?.find(x => x.label === beadPaneTitle) : undefined);
  return t ? { kind: "pane", terminalId: t.id } : { kind: "inspector", key: lane.key };
}
