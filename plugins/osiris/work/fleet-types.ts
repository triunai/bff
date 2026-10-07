// Fleet contract (types only, no logic): what the server's transcript telemetry says about EVERY agent on this machine, so the UI can
// answer "how many agents are working right now, which ones, on what" and put a name on every tool call. Built by work/fleet-model.ts
// (pure) from transcript-feed.ts units + work/codex-feed.ts sessions, carried on WorkTelemetry.fleet, read by call-identity.ts and the
// fleet / tool-dashboard components. PRIVACY (default-deny): ids, lane names, model ids, timestamps and numbers only. NO free text from
// a message or a meta.json `workflowPhase` ever leaves the server; the one exception is an agent label: the FIRST LINE of a meta.json `description`,
// sealed by work/agent-identity.ts (paths, ids and secrets stripped, 48 chars). `workspace` is a short display name (repo, or
// repo/worktree), never a full path.

export type FleetRuntime = ProviderId;
/** main = a top-level session; lead = a lane that spawned other lanes (or is named lead/captain); reviewer = a review/verify lane. */
import type { ProviderId } from "./providers/registry.ts";
import type { ProviderStatus } from "./providers/status.ts";
import type { UsageIndexes } from "./call-usage-join.ts";
export type FleetRole = "main" | "lead" | "worker" | "reviewer";
/** live = wrote within FLEET_LIVE_MS; idle = within FLEET_IDLE_MS; done = older (still inside the 7-day read window). */
export type FleetState = "live" | "idle" | "done";
/** Where the label came from, best first: the lane name, the description / task line, the pane title, else a short tag ("workspace" only in an older answer). */
export type LabelFrom = "lane" | "description" | "pane" | "workspace" | "id";
/** What kind of agent a lane is: a top-level session, a named teammate, a plain subagent, a workflow agent, or a Codex session. */
export type FleetKind = "main" | "teammate" | "subagent" | "workflow" | "codex";
export const FLEET_KINDS: readonly FleetKind[] = ["main", "teammate", "subagent", "workflow", "codex"];

export const FLEET_LIVE_MS = 5 * 60_000;
export const FLEET_IDLE_MS = 60 * 60_000;
/** Spark buckets: FLEET_SPARK_BUCKETS x FLEET_SPARK_MS ending at `summary.at` (12 x 5 min = the last hour). */
export const FLEET_SPARK_BUCKETS = 12;
export const FLEET_SPARK_MS = 5 * 60_000;
export const FLEET_MAX_LANES = 200;
/** Why a lane needs the human (td-osi.21.2). question = an open AskUserQuestion / ExitPlanMode call; permission = a permission prompt (reserved:
 *  no transcript record exists while one is pending, so fleet-model never produces it); your-turn = a main session whose last turn ended;
 *  message = an idle lane with an unanswered inbound message. */
export type FleetWaiting = "question" | "permission" | "your-turn" | "message";
export const FLEET_WAITING: readonly FleetWaiting[] = ["question", "permission", "your-turn", "message"];
/** Tool calls that block on a person. Names only; the question text is never read. */
export const FLEET_QUESTION_TOOLS: readonly string[] = ["AskUserQuestion", "ExitPlanMode"];
/** An open question tool call younger than this is a prompt being rendered, not yet a lane that needs you. */
export const FLEET_QUESTION_MS = 15_000;
/** A tool_use id with no tool_result yet (transcript-feed): id, tool NAME, time. Never the input. */
export interface OpenTool { id: string; tool: string; at: number }
/** The newest user / assistant record of a transcript: time, role, and whether an assistant record ended its turn. Metadata only. */
export interface LastTurn { at: number; role: "assistant" | "user"; endTurn: boolean }
/** The newest CLOSED tool call of a transcript (closed by its tool_result): tool NAME, start, end. Metadata only. */
export interface LastTool { tool: string; at: number; endedAt: number }
/** What a lane is doing now (td-osi.21.2): the newest open tool (running, since = its start), else the last closed tool (since = its end). */
export interface FleetNow { tool: string; since: number; running: boolean }
export const FLEET_OPEN_MAX = 32;
export const FLEET_MAX_MESSAGES = 300;
/** Compact name index bound: every lane (newest first) up to this many, so a call from an older, finished lane still gets its name. */
export const FLEET_MAX_NAMES = 2000;

export interface FleetLane {
  /** The join key a tool call carries in `Call.sessionId`: a Claude subagent's agentId, a Claude main session id, a Codex session id. */
  key: string;
  runtime: FleetRuntime;
  label: string;
  labelFrom: LabelFrom;
  kind: FleetKind;
  /** The lane that spawned this one (a subagent's main session or parentAgentId), as a `key`; null for a top-level session. */
  parentKey: string | null;
  role: FleetRole;
  /** Most-used model id, and its modelTier() key/letter (S/H/O/F/C/So/?). */
  model: string | null;
  modelKey: string;
  modelLetter: string;
  /** "webshop", "osiris/tooldash", "webshop/wf_81e90f3f-11d-34". Null when no cwd was recorded. */
  workspace: string | null;
  branch: string | null;
  beadId: string | null;
  firstAt: number | null;
  lastAt: number | null;
  state: FleetState;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  /** Dollars at list price, null when a model had no price (never a silent 0); pricedUsd is the priced part. Codex: null / 0. */
  costUsd: number | null;
  pricedUsd: number;
  /** Requests per spark bucket, oldest first, FLEET_SPARK_BUCKETS long. */
  spark: number[];
  /** Needs a person (see FleetWaiting) and since when; null / null when the lane is working or finished. Absent in an older server answer. */
  waiting?: FleetWaiting | null;
  waitingSince?: number | null;
  /** What the lane is doing now; null when unknown (always for Codex: its header feed has no per-call data). Absent in an older answer. */
  now?: FleetNow | null;
}
/** The identity half of a FleetLane: what a tool call needs to show a name, a workspace and a place in the lane tree. */
export interface FleetName {
  key: string; label: string; kind: FleetKind; parentKey: string | null; role: FleetRole; modelLetter: string;
  workspace: string | null; branch: string | null; beadId: string | null; state: FleetState;
  waiting?: FleetWaiting | null; waitingSince?: number | null; now?: FleetNow | null;
}
export interface FleetCount { key: string; label: string; letter?: string; live: number; idle: number; total: number }
export interface FleetSummary {
  /** The `now` the states were computed against. */
  at: number;
  liveWindowMs: number;
  idleWindowMs: number;
  live: number; idle: number; done: number; total: number;
  byModel: FleetCount[];
  byRole: FleetCount[];
  byRuntime: FleetCount[];
  /** Every kind, fixed order (FLEET_KINDS); live = FLEET_LIVE_MS, idle = up to FLEET_IDLE_MS, total = everything seen. */
  byKind: FleetCount[];
  /** Lanes active per bucket over the last hour (FLEET_SPARK_BUCKETS x FLEET_SPARK_MS), oldest first; the newest bucket counts live lanes. */
  liveSpark: number[];
  /** Priced spend over the last hour, $/h; null when nothing was priced in that hour. */
  burnUsdPerHour: number | null;
  /** Lanes blocked on a person right now (waiting question, your-turn or permission; NOT a message-only lane), and the split per reason in FLEET_WAITING order (zero reasons omitted). Absent in an older answer. */
  needsYou?: number;
  /** Lanes whose only reason is an unanswered message (waiting "message"): shown as a separate small figure, never in needsYou. Absent in an older answer. */
  unread?: number;
  byWaiting?: FleetCount[];
}
/** One agent-to-agent message as METADATA only (td-osi.21.2): who, to whom, the one-line summary, the protocol word. Never a body. */
export type MessageKind = "send" | "receive" | "spawn" | "handback" | "handback-lost";
export type MessageProtocol = "DONE" | "HANDOFF" | "BLOCKED" | "DECISION" | "LANDABLE";
export interface MessageEvent {
  at: number; kind: MessageKind; from: string; to: string;
  /** SendMessage summary / teammate-message summary (redacted, <= 80 chars); for a spawn the subagent_type; else null. */
  summary: string | null;
  protocol: MessageProtocol | null;
  /** The fleet key of the lane whose transcript the event was read from. */
  laneKey: string;
}
export interface FleetSnapshot {
  summary: FleetSummary;
  /** live first, then idle, then done; newest lastAt first inside each; at most FLEET_MAX_LANES (summary counts cover ALL). */
  lanes: FleetLane[];
  truncated: boolean;
  /** Names for EVERY lane up to FLEET_MAX_NAMES (lanes above is the capped detail list). Optional: an older answer lacks it. */
  names?: FleetName[];
  /** Newest agent messages across all lanes (<= 300). Optional: an older answer lacks it. */
  messages?: MessageEvent[];
  /** Set on every payload the server returns (opaque-key.ts sealFleet): keys are opaque, and the client re-keys with this per-process salt. */
  keySalt?: string;
  /** Provider coverage (providers/status.ts): which providers are installed and have sessions. Set by the telemetry service, not buildFleet. */
  providers?: ProviderStatus[];
  /** The call -> model-request usage index per provider, SEALED (opaque keys, no ids or paths): the client joins its own calls with it (call-usage-join.ts). Absent in an older answer. */
  callUsage?: UsageIndexes;
}
