// The agent inspector's rows (pure): what a click on an agent shows when the agent has no Herdr pane to jump to. Every text comes from the
// lane the fleet already holds (identity, model, state, what it is doing, why it waits); nothing new is read.
import type { FleetLane, FleetWaiting } from "./fleet-types.ts";
import { providerById } from "./providers/registry.ts";

export const WAITING_WHY: Readonly<Record<FleetWaiting, string>> = {
  question: "asked you a question and is blocked on the answer",
  permission: "is waiting for you to grant a permission",
  "your-turn": "finished its turn: it is your move",
  message: "has a message nobody has answered yet",
};
export interface AgentInspectorRow { label: string; value: string }
export interface AgentInspectorView { title: string; chip: string; state: string; waiting: string | null; rows: AgentInspectorRow[]; beadId: string | null }

export function agentInspectorView(l: FleetLane): AgentInspectorView {
  const p = providerById(l.runtime);
  return {
    title: l.label, chip: `${p?.chip ?? "??"}·${l.modelLetter}`, state: l.state, waiting: l.waiting ? WAITING_WHY[l.waiting] : null, beadId: l.beadId,
    rows: [
      { label: "Provider", value: p?.label ?? l.runtime }, { label: "Model", value: l.model ?? "unknown" }, { label: "Role", value: l.role },
      { label: "Doing", value: l.now ? `${l.now.tool}${l.now.running ? " (running)" : ""}` : "unknown" },
      { label: "Workspace", value: l.workspace ?? "unknown" }, { label: "Branch", value: l.branch ?? "unknown" }, { label: "Requests", value: String(l.requests) },
    ],
  };
}
