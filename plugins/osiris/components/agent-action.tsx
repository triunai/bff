import type { Call } from "../analytics.ts";
import type { GitCommitDetail } from "../git-types.ts";
import type { HealthRow } from "../health-types.ts";
import type { FleetLane } from "../work/fleet-types.ts";
import type { LedgerIncident } from "../work/fleet-ledger.ts";
import type { WorkSurfaceSnapshot } from "../work/surface-types.ts";
import { dispatchGuard } from "../work/dispatch-guard.ts";
import { AskAgentButton, ASK_LABEL } from "../work/ask-agent/button.tsx";
import { compose, seal, CHECK_INSTRUCTION, INVESTIGATE_INSTRUCTION, beadContext, callAskContext, commitContext, efficiencyContext, type EfficiencyAsk, fleetContext, healthContext, incidentContext, type AskContext } from "../work/ask-agent/context.ts";

/** The ONE call-to-action for "hand this item to an agent": every card or row drops in `<AgentAction kind=... item=... />`. It builds the prompt with the
 *  Ask-an-agent context builders (sealed, D-135) and sends it through the ONE dispatch dialog (HerdrDispatchDialog); nothing runs until the person confirms. */
export type AgentActionProps =
  | { kind: "health"; item: HealthRow }
  | { kind: "problem"; item: Call; neighbours?: readonly Call[] }
  | { kind: "incident"; item: LedgerIncident }
  | { kind: "fleet"; item: FleetLane; parent?: FleetLane | null; children?: readonly FleetLane[] }
  | { kind: "bead"; item: { snap: WorkSurfaceSnapshot; id: string; now: number } }
  | { kind: "commit"; item: GitCommitDetail }
  | { kind: "efficiency"; item: EfficiencyAsk }
  | { kind: "spend"; item: { date: string; lines: readonly string[] } };
export type AgentActionKind = AgentActionProps["kind"];

export const AGENT_ACTION_LABEL: Readonly<Record<AgentActionKind, string>> = {
  health: "Send an agent to check", problem: "Send an agent to investigate", incident: "Send an agent to route around / fix",
  fleet: ASK_LABEL, bead: ASK_LABEL, commit: ASK_LABEL, efficiency: ASK_LABEL, spend: ASK_LABEL,
};

/** Pure: the prompt for one action. null when the item is gone (a bead no longer in the snapshot). */
export function agentActionContext(p: AgentActionProps): AskContext | null {
  switch (p.kind) {
    case "health": return healthContext(p.item, CHECK_INSTRUCTION);
    case "problem": return callAskContext(p.item, p.neighbours ?? [], INVESTIGATE_INSTRUCTION);
    case "incident": return incidentContext(p.item);
    case "fleet": return fleetContext(p.item, p.parent ?? null, p.children ?? []);
    case "bead": return beadContext(p.item.snap, p.item.id, p.item.now);
    case "commit": return commitContext(p.item);
    case "efficiency": return efficiencyContext(p.item);
    case "spend": return compose(`Spend ${p.item.date}`, p.item.lines.map(l => seal(l, 400)), []);
  }
}

export function AgentAction(p: AgentActionProps & { className?: string }) {
  return <AskAgentButton className={p.className} label={AGENT_ACTION_LABEL[p.kind]} ask={() => agentActionContext(p)} guard={p.kind === "bead" ? () => dispatchGuard(p.item.snap, p.item.id, p.item.now) : undefined} />;
}
