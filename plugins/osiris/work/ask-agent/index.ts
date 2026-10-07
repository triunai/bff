// Ask an agent: pure context builders + the shared button. Dispatch is work/herdr-dispatch; import from here, never the parts.
export * from "./context.ts";
export { AskAgentButton, ASK_LABEL, askAgentStyles } from "./button.tsx";
export { AgentAction, AGENT_ACTION_LABEL, agentActionContext, type AgentActionProps, type AgentActionKind } from "../../components/agent-action.tsx";
