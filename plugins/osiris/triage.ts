import type {Call} from "./analytics.ts";
import {callKey} from "./analytics.ts";
import {isSlow} from "./live-observer.ts";
export type Lane = "problem" | "signal";
export type TriageKind = "error" | "denied" | "unknown" | "cancelled" | "slow" | "missing-timing";
export const TRIAGE_KINDS: readonly TriageKind[] = ["error","denied","unknown","cancelled","slow","missing-timing"];
// Precedence (a call lands in AT MOST one lane): outcome first, then timing.
// error/denied -> problem. unknown/cancelled -> signal (unknown is a capture gap, never a failure).
// success: slow -> signal, durationMs===null -> signal (missing-timing), else null. running -> null.
export function triage(call: Call): {lane: Lane | null; kind: TriageKind | null} {
  switch (call.status) {
    case "error": case "denied": return {lane: "problem", kind: call.status};
    case "unknown": case "cancelled": return {lane: "signal", kind: call.status};
    case "success":
      if (isSlow(call)) return {lane: "signal", kind: "slow"};
      if (call.durationMs === null) return {lane: "signal", kind: "missing-timing"};
      return {lane: null, kind: null};
    default: return {lane: null, kind: null};
  }
}
export function triageCounts(calls: Call[]) {
  const byKind = Object.fromEntries(TRIAGE_KINDS.map(k => [k, 0])) as Record<TriageKind, number>;
  let problems = 0, signals = 0;
  for (const c of calls) { const t = triage(c); if (!t.kind) continue; byKind[t.kind]++; if (t.lane === "problem") problems++; else signals++; }
  return {problems, signals, byKind};
}
export function normalizeErrorCode(code: string | null, status: Call["status"]): string {
  if (code === null) return `status:${status}`;
  return code.trim().toLowerCase()
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<str>")
    .replace(/(^|[\s=:(\[])\/[^\s'"`]+/g, "$1<path>")
    // Identifiers vary per occurrence and must not split one failure into many incidents: whole UUIDs first, then
    // hex runs that contain a digit (so words like "defaced" survive). Status-like numbers below 5 digits are MEANING
    // (exit 137 = SIGKILL/OOM vs exit 143 = SIGTERM, http 404 vs 500) and are kept; only 5+ digit counters/ids fold.
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/g, "<hex>")
    .replace(/\d{5,}/g, "<n>")
    .replace(/\s+/g, " ").trim();
}
export type Incident = {fingerprint: string; agent: string; tool: string; error: string; workspace: string; /** Distinct agent labels (labelOf), sorted. */ agents: string[]; count: number; firstSeen: number | null; lastSeen: number | null; callKeys: string[]};
const when = (c: Call) => c.endedAt ?? c.startedAt ?? null;
export function reduceIncidents(calls: Call[], workspaceOf: (c: Call) => string | null, labelOf: (c: Call) => string = c => c.provider): Incident[] {
  const groups = new Map<string, {inc: Incident; items: {t: number | null; k: string}[]; agents: Set<string>}>();
  for (const c of calls) {
    if (triage(c).lane !== "problem") continue;
    const error = normalizeErrorCode(c.errorCode, c.status), workspace = workspaceOf(c) ?? "workspace:unmapped";
    const fingerprint = JSON.stringify([c.provider, c.tool, error, workspace]);
    let g = groups.get(fingerprint);
    if (!g) groups.set(fingerprint, g = {inc: {fingerprint, agent: c.provider, tool: c.tool, error, workspace, agents: [], count: 0, firstSeen: null, lastSeen: null, callKeys: []}, items: [], agents: new Set()});
    g.agents.add(labelOf(c));
    g.items.push({t: when(c), k: callKey(c)});
  }
  const out: Incident[] = [];
  for (const {inc, items, agents} of groups.values()) {
    inc.agents = [...agents].sort();
    items.sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
    const ts = items.map(i => i.t).filter((t): t is number => t !== null);
    inc.count = items.length; inc.callKeys = items.map(i => i.k);
    inc.firstSeen = ts.length ? Math.min(...ts) : null; inc.lastSeen = ts.length ? Math.max(...ts) : null;
    out.push(inc);
  }
  return out.sort((a, b) => (b.lastSeen ?? -Infinity) - (a.lastSeen ?? -Infinity) || b.count - a.count || (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));
}

/** Signals group by triage KIND as well as tool/outcome, so a slow success and a success with no recorded duration
 * never share a group or a label (review passA-1 M3). Deterministic: count desc, then key. */
export const signalKey = (c: Call) => JSON.stringify([triage(c).kind, c.provider, c.tool, c.server, c.status, c.errorCode]);
export function groupSignals(calls: Call[]): {key: string; kind: TriageKind; calls: Call[]}[] {
  const groups = new Map<string, Call[]>();
  for (const c of calls) { if (triage(c).lane !== "signal") continue; const k = signalKey(c); groups.set(k, [...(groups.get(k) ?? []), c]); }
  return [...groups].map(([key, cs]) => ({key, kind: triage(cs[0]).kind as TriageKind, calls: cs}))
    .sort((a, b) => b.calls.length - a.calls.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The ONE kind table: the classifier's kinds, the lane chips and the Signals legend all read it. */
export const TRIAGE_KIND_INFO: readonly {kind: TriageKind; lane: Lane; label: string; meaning: string}[] = [
  {kind: "error", lane: "problem", label: "Errors", meaning: "The call finished and reported an error."},
  {kind: "denied", lane: "problem", label: "Denied", meaning: "The call was refused by a permission or policy."},
  {kind: "unknown", lane: "signal", label: "Unknown outcome", meaning: "No result was recorded, usually a capture gap rather than a failure."},
  {kind: "cancelled", lane: "signal", label: "Cancelled", meaning: "The call was stopped before it finished."},
  {kind: "slow", lane: "signal", label: "Slow", meaning: "It succeeded but took longer than its slow threshold (commands 5 s, MCP calls 60 s, other tools 10 s)."},
  {kind: "missing-timing", lane: "signal", label: "No timing", meaning: "It succeeded but no duration was recorded, so it cannot be judged slow."},
];
export const kindsForLane = (lane: Lane) => TRIAGE_KIND_INFO.filter(k => k.lane === lane);
