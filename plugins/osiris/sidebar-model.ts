import { PROVIDER_IDS, providerLabel as registryLabel } from "./work/providers/registry.ts";
import type { ProviderId } from "./work/providers/registry.ts";
/** Pure model for the left sidebar (GOAL / TERMINALS / NEXT UP / SESSIONS). No I/O, no React. */
import type { Call } from "./analytics.ts";
import type { SpineV2 } from "./projects.ts";
import type { FocusItemStatus, SpineFocus } from "./spine-index.ts";

/** The live goal title arrives wrapped in literal quotes; strip exactly one surrounding pair. */
export function stripOuterQuotes(s: string): string {
  const t = s.trim();
  return t.length >= 2 && /^["“'‘]/.test(t) && /["”'’]$/.test(t) ? t.slice(1, -1).trim() : t;
}

export type FocusView = {
  title: string; status: "active" | "met"; since: string; line: number;
  items: { id: string; label: string; status: FocusItemStatus; ref: string | null }[];
  /** owner-gate items plus the OWNER DECISIONS WAITING list. */
  ownerWaiting: number;
  /** Labels of the OWNER DECISIONS WAITING list (GoalInspector shows them). */
  ownerGates: string[];
  fleet: { title: string; line: number } | null;
};
export function focusView(focus: SpineFocus | undefined): FocusView | null {
  if (!focus) return null;
  return {
    title: stripOuterQuotes(focus.goal.title), status: focus.goal.status, since: focus.goal.since, line: focus.goal.line,
    items: focus.items.map(i => ({ id: i.id, label: i.label, status: i.status, ref: i.ref ?? null })),
    ownerWaiting: focus.items.filter(i => i.status === "owner-gate").length + focus.ownerGates.length,
    ownerGates: focus.ownerGates.map(g => g.label),
    fleet: focus.fleet ? { title: focus.fleet.title, line: focus.fleet.line } : null,
  };
}

/** Owner-blocked = the wait begins with the word "Owner" ("Owner decision", "Owner: ..."); "Ownership" does not match. */
export const isOwnerWaiting = (waitingOn: string | null | undefined): boolean => typeof waitingOn === "string" && /^\s*owner\b/i.test(waitingOn);

export type NextUpItem = {
  projectId: string; projectName: string; workId: string; title: string | null; nextAction: string | null;
  waitingOn: string | null; status: "now" | "waiting"; ownerWaiting: boolean;
};
const rank = (i: NextUpItem) => (i.ownerWaiting ? 0 : i.status === "now" ? 1 : 2);
/** Work items with status now|waiting. Order: owner-waiting, then now, then other waiting; ties by case-folded project
 * name then the item's order in its file. Project name ties (two projects, one name) fall back to project id. */
export function nextUp(spines: SpineV2[]): NextUpItem[] {
  const rows: { item: NextUpItem; order: number }[] = [];
  for (const s of spines) s.work.forEach((w, order) => {
    if (w.status !== "now" && w.status !== "waiting") return;
    rows.push({ order, item: { projectId: s.project.id, projectName: s.project.name, workId: w.id, title: w.title, nextAction: w.next_action, waitingOn: w.waiting_on, status: w.status, ownerWaiting: isOwnerWaiting(w.waiting_on) } });
  });
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return rows.sort((a, b) => rank(a.item) - rank(b.item) || cmp(a.item.projectName.toLowerCase(), b.item.projectName.toLowerCase()) || cmp(a.item.projectId, b.item.projectId) || a.order - b.order).map(r => r.item);
}

export type SessionRow = {
  key: string; id: string; source: string; provider: string; providerLabel: string;
  start: number | null; last: number | null; durationMs: number | null; calls: number; errors: number;
  line1: string; line2: string; tooltip: string;
};
export const providerLabel = (p: string) => (p === "claude" || p === "claude-code" ? "Claude Code" : registryLabel(p));
const pad = (n: number) => String(n).padStart(2, "0");
export const clockLabel = (ms: number | null) => { if (ms === null) return "—"; const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export function durationLabel(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
/** One row per (source, provider, sessionId). The capture is metadata-only, so repo/branch/first prompt do not exist:
 * line1 is `<Provider> session · <HH:MM start>`, and line2 OMITS the unknown repo/branch parts (it never prints "— · —")
 * while keeping a "—" for an unknown start or duration. The opaque id lives only in the tooltip. A running call extends
 * the session to `now`. Sorted by last activity desc, then key. */
export function sessionRows(calls: Call[], now: number): SessionRow[] {
  const groups = new Map<string, Call[]>();
  for (const c of calls) { const k = JSON.stringify([c.source, c.provider, c.sessionId]); const g = groups.get(k); if (g) g.push(c); else groups.set(k, [c]); }
  const rows: SessionRow[] = [];
  for (const [key, cs] of groups) {
    const first = cs[0], stamps = cs.flatMap(c => [c.startedAt, c.endedAt]).filter((n): n is number => n !== null);
    const start = cs.map(c => c.startedAt ?? c.endedAt).filter((n): n is number => n !== null).reduce<number | null>((m, n) => (m === null || n < m ? n : m), null);
    let last = stamps.reduce<number | null>((m, n) => (m === null || n > m ? n : m), null);
    if (cs.some(c => c.status === "running") && start !== null) last = Math.max(last ?? start, now);
    const durationMs = start !== null && last !== null && last >= start ? last - start : null;
    const errors = cs.filter(c => c.status === "error" || c.status === "denied").length;
    const label = providerLabel(first.provider);
    rows.push({
      key, id: first.sessionId, source: first.source, provider: first.provider, providerLabel: label, start, last, durationMs, calls: cs.length, errors,
      line1: `${label} session · ${clockLabel(start)}`,
      line2: [clockLabel(start), durationLabel(durationMs), `${cs.length} ${cs.length === 1 ? "call" : "calls"}`, `${errors} ${errors === 1 ? "error" : "errors"}`].join(" · "),
      tooltip: `${first.sessionId} · ${first.source}`,
    });
  }
  return rows.sort((a, b) => (b.last ?? -1) - (a.last ?? -1) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export type AgentKind = "herdr" | ProviderId;
/** Case-insensitive word match over title, cwd and ANSI-stripped tail. herdr wins over claude over codex. */
/** Evidence in priority order (review S-1 MED-4): the terminal TITLE, then the cwd BASENAME (a path like
 * ~/.claude/worktrees/x must not read as "claude"), and only then the output tail — which can mention other agents
 * (a Claude terminal discussing Herdr), so it is a last resort. Within one source herdr > claude > codex. */
export function detectAgent(p: { title?: string | null; cwd?: string | null; tail?: string | null }): AgentKind | null {
  const base = (p.cwd ?? "").split("/").filter(Boolean).pop() ?? "";
  for (const text of [p.title ?? "", base, p.tail ?? ""]) {
    for (const k of ["herdr", ...PROVIDER_IDS] as const) if (new RegExp(`\\b${k}\\b`, "i").test(text)) return k;
  }
  return null;
}
