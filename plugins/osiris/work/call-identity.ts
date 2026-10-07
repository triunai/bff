// Call identity (pure): put a lane name and a workspace on a tool call instead of its raw session hash. The ONE join is
// Call.sessionId == FleetLane.key (the capture feed writes a Claude subagent's agentId, a Claude main session id or a Codex session id
// there, the same ids transcript-feed.ts / codex-feed.ts key their lanes by). Nothing is guessed: no lane means `known: false` and a
// short-id label, said plainly.
import { providerOf } from "./providers/registry.ts";
import type { Call } from "../analytics.ts";
import type { FleetKind, FleetName, FleetRole } from "./fleet-types.ts";

export interface CallIdentity {
  label: string;
  workspace: string | null;
  branch: string | null;
  role: FleetRole | null;
  modelLetter: string | null;
  beadId: string | null;
  kind: FleetKind | null;
  /** False when no transcript lane carries this id. */
  known: boolean;
}
export type FleetIndex = ReadonlyMap<string, FleetName>;

/** Key -> name, from the compact `names` index (every lane) overlaid by the detailed `lanes` (capped). */
export const fleetIndex = (lanes: readonly FleetName[] | null | undefined, names?: readonly FleetName[] | null): FleetIndex =>
  new Map([...(names ?? []), ...(lanes ?? [])].map(l => [l.key, l]));

/** `a94b1d1f9a1d0e3ff` -> `a94b1d1f`, `01a107e7-a467-…` -> `01a107e7`. */
export const shortKey = (id: string) => id.replace(/^agent-/, "").slice(0, 8);

export function identityOf(call: Pick<Call, "sessionId" | "provider">, index: FleetIndex): CallIdentity {
  const l = index.get(call.sessionId) ?? index.get(call.sessionId.replace(/^agent-/, ""));
  if (l) return { label: l.label, workspace: l.workspace, branch: l.branch, role: l.role, modelLetter: l.modelLetter, beadId: l.beadId, kind: l.kind, known: true };
  const runtime = providerOf(call.provider)?.label ?? call.provider;
  return { label: `${runtime} ${shortKey(call.sessionId)}`, workspace: null, branch: null, role: null, modelLetter: null, beadId: null, kind: null, known: false };
}

/** The `workspaceOf` resolver triage.reduceIncidents takes: the lane's workspace, else null (it then says "workspace unmapped"). */
export const workspaceResolver = (index: FleetIndex) => (c: Call): string | null => identityOf(c, index).workspace;
