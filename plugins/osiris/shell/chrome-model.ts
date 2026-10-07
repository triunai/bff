// Top bar and bottom status bar model (pure; ADR D-137: the approved mockup docs/design/2026-10-07-osiris-dashboard-harmony.html is the spec).
// The components only render what these functions say, so the slot order, the verbatim copy and the status-bar items are pinned from fixtures.
import type { Loc } from "./nav-history.ts";
import { providerCell, type ProviderStatus } from "../work/providers/status.ts";
import { uncommittedCount } from "../worktree-model.ts";
import type { GitStatusEntry } from "../git-types.ts";

/** Left to right. `seams` and `guard` are the LOUD red chips (ADR D-138): they sit next to NEEDS YOU and never go into a menu. */
export const TOP_SLOTS = ["logo", "repo", "search", "needs", "seams", "guard", "keepAwake", "fleet", "spend", "theme", "view"] as const;
export const SEARCH_PLACEHOLDER = "Search or jump to an id (demo-3f1, W-12, D-40, sha)";
export const NEEDS_WORDS: readonly [string, string] = ["needs", "you"];
export const SPEND_WORDS: readonly [string, string] = ["per hour", "est."];
export const SCOPE_LABEL = "Scope";
export const NO_REPO = "no repo";
export const repoLabel = (name: string | null | undefined): string => `${name || NO_REPO} ▾`;
export const themeLabel = (name: string): string => `Theme: ${name}`;
/** "$4.10" from the fleet's list-price burn per hour, or a dash while nothing priced ran this hour. */
export const spendAmount = (usdPerHour: number | null | undefined): string => (typeof usdPerHour === "number" && Number.isFinite(usdPerHour) ? `$${usdPerHour.toFixed(2)}` : "—");

// ---- the search box jumps ---------------------------------------------------------------------------------------------------
export type Jump = { kind: "loc"; loc: Loc } | { kind: "thread"; id: string };
export type JumpIndex = { beadIds: readonly string[]; threadIds: readonly string[]; adrs: readonly { id: string; threadId: string }[] };
/** An id typed in the search box: a bead (demo-3f1), a thread (W-12), an ADR (D-40) or a commit sha (7-40 hex). Anything else is null (it is a call search). */
export function resolveJump(raw: string, ix: JumpIndex): Jump | null {
  const q = raw.trim();
  if (!q || /\s/.test(q)) return null;
  const same = (a: string) => a.toLowerCase() === q.toLowerCase();
  const bead = ix.beadIds.find(same);
  if (bead) return { kind: "loc", loc: { view: "work", sub: "beads", item: bead } };
  const thread = ix.threadIds.find(same);
  if (thread) return { kind: "thread", id: thread };
  const adr = ix.adrs.find(a => same(a.id));
  if (adr) return { kind: "thread", id: adr.threadId };
  if (/^[0-9a-f]{7,40}$/i.test(q)) return { kind: "loc", loc: { view: "history", sub: "commits", item: q.toLowerCase() } };
  return null;
}

// ---- the bottom status bar --------------------------------------------------------------------------------------------------
export type StatusInput = {
  connected: boolean; beads: number | null; trackerWrites: boolean; gitEntries: readonly GitStatusEntry[] | null;
  /** Herdr capture age in ms (null = unavailable) and whether it is stale; `loading` while the first capture is read. */
  captureAgeMs: number | null; captureStale: boolean; captureLoading?: boolean;
  providers: readonly ProviderStatus[] | undefined; head: string | null; scanned: string | null;
};
export type StatusItem = { id: string; text: string; tone?: "ok" | "bad" | "warn" | "muted"; link?: Loc; title?: string; provider?: string };
export const UNCOMMITTED_LINK: Loc = { view: "history", sub: "working-tree" };
export const LIST_PRICE_NOTE = "list-price estimates, not a bill";
const plural = (n: number, w: string) => `${n} ${w}`;

export function statusBar(i: StatusInput, ageText: (ms: number) => string): { left: StatusItem[]; right: StatusItem[] } {
  const left: StatusItem[] = [
    i.connected ? { id: "connection", text: "● connected", tone: "ok" } : { id: "connection", text: "● disconnected", tone: "bad" },
    { id: "beads", text: i.beads === null ? "no tracker" : plural(i.beads, "beads"), tone: i.beads === null ? "muted" : undefined },
    { id: "writes", text: `tracker writes ${i.trackerWrites ? "ON" : "OFF"}` },
  ];
  if (i.gitEntries) left.push({ id: "uncommitted", text: `${uncommittedCount(i.gitEntries)} uncommitted`, link: UNCOMMITTED_LINK, title: "Open History ▸ Working tree" });
  left.push(i.captureLoading ? { id: "capture", text: "capture loading", tone: "muted" }
    : i.captureAgeMs === null ? { id: "capture", text: "capture unavailable", tone: "warn" }
    : { id: "capture", text: `capture ${ageText(i.captureAgeMs)} ago${i.captureStale ? " (stale)" : ""}`, tone: i.captureStale ? "warn" : undefined, title: "Age of the last capture write; this is not a process heartbeat" });
  // The footer's former items (index from <sha> …, generated …, scanned …) fold in here, once.
  if (i.head) left.push({ id: "head", text: i.head, title: "Live HEAD of the selected repo (the doc spine index may be older)" });
  if (i.scanned) left.push({ id: "scanned", text: i.scanned, title: "Time of the last bounded history scan" });
  const right: StatusItem[] = [];
  right.push({ id: "providers", text: "providers:", tone: "muted" });
  for (const p of i.providers ?? []) right.push({ id: `provider-${p.id}`, text: providerCell(p), provider: p.id, tone: p.installed || p.sessions > 0 ? undefined : "muted" });
  right.push({ id: "price", text: LIST_PRICE_NOTE });
  return { left, right };
}
