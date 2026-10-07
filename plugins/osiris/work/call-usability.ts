// Pure helpers for the Calls surface (AH3): trace empty state, sealed call copy text, call -> context breadcrumb, incident grouping line.
import type {Call} from "../analytics.ts";
import {opaqueKey,scrubIds} from "./opaque-key.ts";

/** No data at all vs a filter hiding what exists: two different sentences. */
export const emptyCallsMessage = (p: {total: number; filtered: number}): string => p.total === 0 ? "No calls recorded in this range" : "No calls match this search";

const HOME = /\/(?:Users|home)\/[^/\s"']+/g;
/** D-135 sealing for text that leaves the app: ids become short per-process tags (same id, same tag), home paths become ~. */
const seal = (s: string, salt: string) => scrubIds(s.replace(HOME, "~"), salt) ?? "";
const idTag = (id: string, salt: string) => `#${opaqueKey(id.replace(/^agent-/, ""), salt).slice(1, 9)}`;
const sealId = (id: string | null, salt: string) => (id === null ? null : idTag(id, salt));

export type CopyKind = "input" | "output" | "json";
/** What Osiris holds is metadata only (arguments and output are never captured), so "input" is the recorded invocation and "output" the recorded outcome. */
export function callCopyText(c: Call, kind: CopyKind, salt: string): string {
  if (kind === "input") return seal([`tool: ${c.tool}`, c.server ? `server: ${c.server}` : null, `provider: ${c.provider}`, c.model ? `model: ${c.model}` : null].filter(Boolean).join("\n"), salt);
  if (kind === "output") return seal([`status: ${c.status}`, c.errorCode ? `error: ${c.errorCode}` : null, c.durationMs === null ? "duration: not recorded" : `duration: ${c.durationMs} ms (${c.durationKind})`].filter(Boolean).join("\n"), salt);
  const sealed = {...c, sessionId: sealId(c.sessionId, salt), callId: sealId(c.callId, salt), turnId: sealId(c.turnId, salt), parentCallId: sealId(c.parentCallId, salt), errorCode: c.errorCode === null ? null : seal(c.errorCode, salt)};
  return JSON.stringify(sealed, null, 2);
}

/** "Agent: <lane> · Bead: <id>": the bead only when the fleet join gives one. */
export const breadcrumbOf = (id: {label: string; beadId: string | null}): {agent: string; bead: string | null} => ({agent: id.label, bead: id.beadId});

/** The row's own grouping key, said in words (the incident fingerprint is tool + error + workspace, per agent runtime). */
export const incidentGroupedBy = (i: {tool: string; error: string; workspace: string}): string => `grouped by tool ${i.tool} · error ${i.error} · workspace ${i.workspace === "workspace:unmapped" ? "unmapped" : i.workspace}`;
