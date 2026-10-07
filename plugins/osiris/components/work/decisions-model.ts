// Pure presentation model for the Decisions card (right sidebar). The DATA is decisionsWaiting() in work/surface-model.ts (one
// decisions model); this only orders, caps and splits the delay text. Critical first, then the oldest wait.
import type { DecisionRow, WorkSurfaceSnapshot } from "../../work/surface-types.ts";
import { shortAge } from "../../work/board-card-model.ts";
import type { FleetRow } from "../../work/fleet-view-model.ts";
import type { DriftFinding } from "../../work/drift.ts";
import { boardCards, decisionsWaiting, shortId } from "../../work/surface-model.ts";
import { cleanText } from "../../work/sanitize.ts";
import { isCriticalDecision } from "./selected-model.ts";

export const DECISIONS_CAP = 5;
export const OVERDUE_MS = 24 * 3_600_000;

export function orderDecisions<R extends DecisionRow>(rows: R[], isCritical: (r: R) => boolean): R[] {
  return [...rows].sort((a, b) => Number(isCritical(b)) - Number(isCritical(a)) || b.waitingMs - a.waitingMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The first `cap` rows, or all when expanded; `more` is how many are folded behind "+N more". */
export function capDecisions<R>(rows: R[], expanded: boolean, cap = DECISIONS_CAP): { shown: R[]; more: number } {
  if (expanded || rows.length <= cap) return { shown: rows, more: 0 };
  return { shown: rows.slice(0, cap), more: rows.length - cap };
}

/** "2d" + "put off 3×" (the mockup's words). `overdue` is the ONLY thing that earns the warning colour, and only on the age token. */
export function delayParts(r: Pick<DecisionRow, "waitingMs" | "deferredSessions">): { age: string; rest: string | null; overdue: boolean } {
  const s = r.deferredSessions;
  return { age: shortAge(r.waitingMs), rest: s > 0 ? `put off ${s}×` : null, overdue: r.waitingMs > OVERDUE_MS };
}

// ---- the pinned detail (Needs-you, mockup state 4) ----

export type DecisionOption = { text: string; suggested: boolean };
const OPTIONS_HEAD = /^\s*(?:#{1,6}\s*)?\**options\**\s*:?\**\s*$/i, ITEM = /^\s*(?:\d+[.)]|[-*])\s+(.+?)\s*$/, SUGGESTED = /\s*[([](?:suggested|recommended)[)\]]\s*$/i;
const MAX_OPTIONS = 6, MAX_OPTION_CHARS = 200;

/** OPTIONS only from a structured block: an "Options" heading followed by a numbered or bulleted list. Prose, or no heading, gives none: options are never invented. */
export function parseOptions(description: string | null | undefined): DecisionOption[] {
  if (!description) return [];
  const lines = description.split("\n"), at = lines.findIndex(l => OPTIONS_HEAD.test(l));
  if (at < 0) return [];
  const out: DecisionOption[] = [];
  for (const l of lines.slice(at + 1)) {
    const m = ITEM.exec(l);
    if (!m) { if (out.length > 0 || l.trim() !== "") break; continue; }
    const suggested = SUGGESTED.test(m[1]);
    out.push({ text: cleanText(m[1].replace(SUGGESTED, "")).slice(0, MAX_OPTION_CHARS), suggested });
    if (out.length === MAX_OPTIONS) break;
  }
  return out;
}

export type DecisionDetail = {
  id: string; shortId: string; title: string; critical: boolean;
  waitingMs: number; /** Wrap commits since creation; null when none (then the "put off" words are omitted). */ putOff: number | null;
  unblocks: string[]; askedBy: string | null; options: DecisionOption[];
};
/** Null when `id` is not a decision waiting on the owner. Every field is read from the tracker snapshot. */
export function decisionDetail(snap: WorkSurfaceSnapshot, id: string, now: number): DecisionDetail | null {
  const row = decisionsWaiting(snap, now).find(r => r.id === id);
  if (!row) return null;
  const issue = snap.issues.find(i => i.id === id), card = boardCards(snap, now).find(c => c.id === id);
  return {
    id, shortId: shortId(id), title: row.title, critical: isCriticalDecision(snap, row), waitingMs: row.waitingMs,
    putOff: row.deferredSessions > 0 ? row.deferredSessions : null,
    unblocks: (card?.unblocks ?? []).map(l => l.id), askedBy: issue?.assignee ?? null, options: parseOptions(issue?.description),
  };
}

/** The "Copy as prompt" / Dispatch text: the question, what it unblocks, and the options when the tracker has them. */
export function decisionPrompt(d: DecisionDetail): string {
  return [`Decision needed (${d.shortId}): ${d.title}`,
    ...(d.unblocks.length ? [`Deciding this unblocks: ${d.unblocks.map(shortId).join(", ")}.`] : []),
    ...(d.options.length ? ["Options:", ...d.options.map((o, i) => `${i + 1}. ${o.text}${o.suggested ? " (suggested)" : ""}`)] : []),
    "Summarise the trade-offs and recommend one option."].join("\n");
}

// ---- Agents waiting / Drift sections ----
export type WaitingRow = { key: string; name: string; shape: string; why: string; chip: string; runtime: string };
/** Agents blocked on a person (a question, your turn, a permission): the fleet's own needs-you rows, in the mockup's row shape. */
export function agentsWaiting(rows: readonly FleetRow[]): WaitingRow[] {
  return rows.filter(r => r.needsYou && !r.group).map(r => ({ key: r.key, name: cleanText(r.label), shape: r.waitingShape, why: r.waitingWord, chip: `${r.runtime === "codex" ? "CX" : "CL"}·${r.modelLetter}`, runtime: r.runtime }));
}
export type DriftRow = { key: string; badge: string; meta: string };
/** "errors only": the Needs-you tab lists drift findings of severity error; warnings stay on the Drift line. */
export function driftErrors(findings: readonly DriftFinding[], now: number): DriftRow[] {
  return findings.filter(f => f.severity === "error").map((f, i) => ({
    key: `${f.rule}:${f.beadId ?? f.paneId ?? i}`, badge: f.message,
    meta: [f.beadId ? shortId(f.beadId) : null, f.since !== undefined ? shortAge(Math.max(0, now - f.since)) : null].filter(Boolean).join(" · "),
  }));
}
