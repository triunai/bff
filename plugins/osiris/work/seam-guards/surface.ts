// Loud surfacing of a SeamReport (pure; the client renders from this). Rules: a crit is NEVER a quiet state (it always shows the red
// top-bar indicator, the Seams panel row and the top Health group); warns are amber; ok guards are quiet. A report that could not be
// fetched at all is itself a crit (fail closed on the client too).
import type { GuardEntry, SeamReport } from "./types.ts";

export type SeamTone = "crit" | "warn";
export type BrokenEntry = GuardEntry & { result: Extract<GuardEntry["result"], { ok: false }> };

const isBroken = (e: GuardEntry): e is BrokenEntry => !e.result.ok;
/** Broken entries, crits first, each keeping registry order. */
export function brokenEntries(r: SeamReport | null): BrokenEntry[] {
  const b = (r?.entries ?? []).filter(isBroken);
  return [...b.filter(e => e.result.severity === "crit"), ...b.filter(e => e.result.severity === "warn")];
}
export const critCount = (r: SeamReport | null): number => brokenEntries(r).filter(e => e.result.severity === "crit").length;
export const warnCount = (r: SeamReport | null): number => brokenEntries(r).filter(e => e.result.severity === "warn").length;

/** The top-bar indicator: null only when every guard is ok (or none has run yet). Any crit is red and says "N seams broken". */
export function indicator(r: SeamReport | null): { tone: SeamTone; text: string } | null {
  const c = critCount(r), w = warnCount(r);
  if (c > 0) return { tone: "crit", text: `${c} seam${c === 1 ? "" : "s"} broken` };
  if (w > 0) return { tone: "warn", text: `${w} seam warning${w === 1 ? "" : "s"}` };
  return null;
}
/** Quiet means "draws nothing". Only an ok entry is quiet; a crit can never be. */
export const isQuiet = (e: GuardEntry): boolean => e.result.ok;

/** The report to show when the guards themselves could not be fetched or run. */
export function unreachableReport(reason: string, at: number): SeamReport {
  const why = reason.replace(/\/Users\/[^/\s]+/g, "~").replace(/\s+/g, " ").slice(0, 120);
  return { at, entries: [{ id: "seam-guards", seam: "The seam guards themselves", result: { ok: false, severity: "crit", what: "The seam guards could not be run", why: `Nothing is verifying Osiris's seams right now: ${why}`, fix: "Reload Osiris; if it persists run `node scripts/check-seams.mjs` and check the plugin log." } }] };
}

/** Ids that are crit now and were not crit in the previous report: log each ONCE per transition, never every poll. */
export function newCrits(prev: SeamReport | null, next: SeamReport): BrokenEntry[] {
  const was = new Set(brokenEntries(prev).filter(e => e.result.severity === "crit").map(e => e.id));
  return brokenEntries(next).filter(e => e.result.severity === "crit" && !was.has(e.id));
}
export const logLine = (e: BrokenEntry): string => `[osiris seam broken] ${e.id}: ${e.result.what} — ${e.result.why} Fix: ${e.result.fix}`;

/** The `seamReport` RPC answer -> a report. Anything that is not a well-formed report (refusal, wrong shape, a thrown call) is the unreachable crit. */
export function parseSeamAnswer(a: unknown, now: number): SeamReport {
  const x = a as { ok?: unknown; report?: { at?: unknown; entries?: unknown }; reason?: unknown } | null;
  if (!x || x.ok !== true) return unreachableReport(typeof x?.reason === "string" ? x.reason : "the server refused or sent no answer", now);
  const es = x.report?.entries;
  if (!Array.isArray(es) || es.length === 0) return unreachableReport("the server sent an empty or malformed report", now);
  const good = es.every(e => e && typeof e.id === "string" && typeof e.seam === "string" && e.result && (e.result.ok === true || ((e.result.severity === "crit" || e.result.severity === "warn") && typeof e.result.what === "string" && typeof e.result.why === "string" && typeof e.result.fix === "string")));
  return good ? { at: typeof x.report?.at === "number" ? x.report.at : now, entries: es as SeamReport["entries"] } : unreachableReport("the server sent a malformed guard result", now);
}

/** The plain text a "Copy" button puts on the clipboard for ANY error surface: what · seam · why · fix. */
export const errorCopyText = (what: string, seam: string, why: string, fix: string): string => [what, seam, why, fix].map(x => x.trim()).filter(Boolean).join(" · ");
