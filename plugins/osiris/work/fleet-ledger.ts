// The owner's run ledger ("Fleet incidents"): a JSON list at docs/ai/state/fleet-incidents.json in the tracker repo. PURE and browser-safe:
// parse an untrusted value into typed incidents (bad entries dropped, never thrown), count by status, filter the open ones, say their age.
// The file read lives in ledger-feed.ts. Nothing here writes; outgoing text is sealed by work/ask-agent/context.ts (incidentContext).
export const LEDGER_PATH = "docs/ai/state/fleet-incidents.json";
export const LEDGER_MAX_BYTES = 512 * 1024;
export const LEDGER_MAX_INCIDENTS = 500;
export type IncidentStatus = "open" | "pinned" | "closed";
export const INCIDENT_STATUSES: readonly IncidentStatus[] = ["open", "pinned", "closed"];
export type LedgerPin = { kind: string; path: string; pattern?: string; owner: string };
export type LedgerIncident = { id: string; title: string; date: string; evidence: string[]; rootCause: string; pin: LedgerPin | null; status: IncidentStatus };
export type LedgerRead =
  | { state: "ok"; incidents: LedgerIncident[]; dropped: number }
  | { state: "missing" }
  | { state: "invalid"; reason: string };

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The top-level value is a list, or an object with an `incidents` list. Entries without an id and a title, or with an unknown status, are dropped and counted. */
export function parseLedger(value: unknown): LedgerRead {
  const list = Array.isArray(value) ? value : isObj(value) && Array.isArray(value.incidents) ? value.incidents : null;
  if (!list) return { state: "invalid", reason: "The ledger is not a list of incidents." };
  const incidents: LedgerIncident[] = []; let dropped = 0;
  for (const raw of list.slice(0, LEDGER_MAX_INCIDENTS)) {
    if (!isObj(raw)) { dropped++; continue; }
    const id = str(raw.id, 40), title = str(raw.title, 300), status = raw.status;
    if (!id || !title || !INCIDENT_STATUSES.includes(status as IncidentStatus)) { dropped++; continue; }
    const pin = isObj(raw.pin) && typeof raw.pin.path === "string" ? { kind: str(raw.pin.kind, 40) || "unknown", path: str(raw.pin.path, 300), ...(typeof raw.pin.pattern === "string" ? { pattern: raw.pin.pattern.slice(0, 200) } : {}), owner: str(raw.pin.owner, 80) || "unknown" } : null;
    incidents.push({ id, title, date: str(raw.date, 40), evidence: Array.isArray(raw.evidence) ? raw.evidence.filter((e): e is string => typeof e === "string").slice(0, 20).map(e => e.slice(0, 300)) : [], rootCause: str(raw.rootCause, 600), pin, status: status as IncidentStatus });
  }
  dropped += Math.max(0, list.length - LEDGER_MAX_INCIDENTS);
  return { state: "ok", incidents, dropped };
}

export const statusCounts = (list: readonly LedgerIncident[]): Record<IncidentStatus, number> =>
  ({ open: list.filter(i => i.status === "open").length, pinned: list.filter(i => i.status === "pinned").length, closed: list.filter(i => i.status === "closed").length });

const dateMs = (d: string): number | null => { const t = Date.parse(d); return Number.isFinite(t) ? t : null; };
/** Open incidents, oldest first (the longest-standing leads). */
export const openIncidents = (list: readonly LedgerIncident[]): LedgerIncident[] =>
  list.filter(i => i.status === "open").sort((a, b) => (dateMs(a.date) ?? Infinity) - (dateMs(b.date) ?? Infinity) || (a.id < b.id ? -1 : 1));
export function incidentAge(i: Pick<LedgerIncident, "date">, now: number): string {
  const t = dateMs(i.date); if (t === null) return "age unknown";
  const d = Math.max(0, Math.floor((now - t) / 86_400_000));
  return d === 0 ? "today" : d === 1 ? "1d" : `${d}d`;
}
