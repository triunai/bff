// WHO an agent is, in one pure function (td-osi.12 / lane UXF). A fleet row, the Calls agent list and the terminal app all name an agent
// through this, so "webshop" (the workspace) is never an agent's name. Best source first: the lane name, the subagent description / task's
// first line, the Herdr pane title, else "<Provider> · agent·3f2a" (a short session tag). SEALED (D-135): the output carries no path, no raw session id
// (a 4-hex hash at most) and no secret; the workspace is secondary text, never the label. No node imports: server and client both use it.
import { cleanText, redactForDisplay } from "./sanitize.ts";
import { providerById } from "./providers/registry.ts";

export const AGENT_LABEL_MAX = 48;
export type IdentitySource = "name" | "description" | "pane" | "tag";
export interface AgentIdentityInput {
  /** The fleet lane key (a session / agent id). Only a 4-hex hash of it ever leaves this function. */
  key: string;
  name?: string | null;
  /** Subagent description or the task's first line ("Lane MK2: Calls full screen"). Only its first line is used. */
  description?: string | null;
  /** The Herdr pane title. */
  paneTitle?: string | null;
  beadId?: string | null;
  role?: string | null;
  workspace?: string | null;
  /** The provider id (claude, codex, gemini). Only used for the fallback label, so an unnamed lane still says whose agent it is. */
  provider?: string | null;
}
export interface AgentIdentity { label: string; source: IdentitySource; beadId: string | null; role: string; workspace: string | null; tag: string }

/** FNV-1a 32-bit, 4 hex digits: a short stable tag that cannot be turned back into the id. */
export const agentTag = (key: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `agent·${h.toString(16).padStart(8, "0").slice(0, 4)}`;
};

// Path-looking runs (absolute, home-relative, or two+ segments), UUIDs, agent ids and long hex runs: gone before a label is shown.
const PATHISH = /(?:~|\.{1,2})?\/[^\s"'`)]*|\b[\w.-]+(?:\/[\w.-]+)+/g, UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, AGENT_ID = /\bagent-a?[0-9a-f]{8,}\b/gi, LONG_HEX = /\b[0-9a-f]{12,}\b/gi;
/** The sealed one-line form of free text, or null when nothing readable is left. */
export const sealLabel = (s: string | null | undefined, max = AGENT_LABEL_MAX): string | null => {
  const first = cleanText(String(s ?? ""), 400).split(/\r?\n/).find(l => l.trim()) ?? "";
  const o = redactForDisplay(first.replace(UUID, " ").replace(AGENT_ID, " ").replace(PATHISH, " ").replace(LONG_HEX, " ").replace(/\s+/g, " ").trim(), max).trim();
  return /[\p{L}\p{N}]/u.test(o) ? o : null;
};

/** The label of a lane nothing else names: "<Provider> · agent·3f2a" (provider label from the registry), else just the tag. */
export const fallbackLabel = (key: string, provider?: string | null): string => { const p = providerById(provider); return p ? `${p.label} · ${agentTag(key)}` : agentTag(key); };

export function agentIdentity(i: AgentIdentityInput): AgentIdentity {
  const tag = agentTag(i.key);
  const picks: [IdentitySource, string | null][] = [["name", sealLabel(i.name)], ["description", sealLabel(i.description)], ["pane", sealLabel(i.paneTitle)]];
  const hit = picks.find(([, v]) => v !== null);
  return { label: hit ? hit[1]! : fallbackLabel(i.key, i.provider), source: hit ? hit[0] : "tag", beadId: sealLabel(i.beadId, 24), role: sealLabel(i.role, 16) ?? "agent", workspace: sealLabel(i.workspace, 40), tag };
}
