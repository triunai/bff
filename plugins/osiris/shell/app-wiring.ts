// App wiring helpers (pure). app.tsx stays a thin shell over these: which command id does what, which Esc wins, what the status
// bar says, how two repo paths compare, how a late answer is ignored, and how a typed path is pinned. No React, no DOM.
import type { Layout, LayoutAction, SlotId } from "./layout-types.ts";
import { CMD } from "./keymap.ts";
import type { ViewItem } from "./view-items.ts";
import { GRAPH_ENABLED } from "./panel-registry.ts";
import { focusTarget, reduce, slotOf } from "./layout-model.ts";

// ---- commands -------------------------------------------------------------------------------------------------------------
/** Command ids the host (app.tsx) answers itself. Every other id a menu item or keybinding can carry maps to a LayoutAction. */
export const HOST_COMMANDS = [
  CMD.search, CMD.openView, CMD.shortcuts, CMD.help, CMD.navBack, CMD.navForward, "view.redraw",
  "term.fontSmaller", "term.fontLarger", "term.fontReset",
  "legacy.toggleWork", "legacy.toggleInspector", "view.classicFactory", "view.demo", "view.themePicker",
  "workbench.filters", "workbench.refresh", "workbench.load", "workbench.export",
] as const;
export type HostCommand = (typeof HOST_COMMANDS)[number];
export const isHostCommand = (id: string): id is HostCommand => (HOST_COMMANDS as readonly string[]).includes(id);

export type CommandPlan = { kind: "layout"; action: LayoutAction } | { kind: "host"; command: HostCommand } | { kind: "none" };

/** What a command id means right now. "none" = nothing to do (e.g. swap with no focused panel), never an unknown id. */
export function planCommand(id: string, layout: Layout): CommandPlan {
  const v = layout.view, set = (patch: Partial<Layout["view"]>): CommandPlan => ({ kind: "layout", action: { type: "setView", patch } });
  switch (id) {
    case CMD.primarySideBar: return set({ primarySideBar: !v.primarySideBar });
    case CMD.secondarySideBar: case CMD.secondarySideBarAlt: return set({ secondarySideBar: !v.secondarySideBar });
    case CMD.bottomPanel: return set({ bottomPanel: !v.bottomPanel });
    case CMD.zen: return set({ zen: !v.zen });
    case CMD.zoomIn: return { kind: "layout", action: { type: "zoom", dir: "in" } };
    case CMD.zoomOut: return { kind: "layout", action: { type: "zoom", dir: "out" } };
    case CMD.zoomReset: return { kind: "layout", action: { type: "zoom", dir: "reset" } };
    case CMD.swapCentre: {
      const p = layout.focus.last, at = p ? slotOf(layout, p) : null;
      return p && at && at !== "centre" ? { kind: "layout", action: { type: "swapWithCentre", panel: p } } : { kind: "none" };
    }
    default: return isHostCommand(id) ? { kind: "host", command: id } : { kind: "none" };
  }
}

/** A keymap result is acted on only when focus rules allow it: ⌘K (search) and the Z that completes ⌘K Z always, everything else
 * never while the user is typing (terminal, input, chat composer). `typing` comes from isTyping(e.target). */
export function allowShortcut(r: { command: string | null; supersedes?: string }, typing: boolean): boolean {
  return !!r.command && (r.command === CMD.search || !!r.supersedes || !typing);
}

// ---- menu -----------------------------------------------------------------------------------------------------------------
/** Menu rows whose geometry 0.2.15 does not draw. They are shown, disabled, with the reason: never a silent no-op. */
export const UNSUPPORTED_ITEMS: Readonly<Record<string, string>> = {
  "panelPosition.left": "(bottom only for now)", "panelPosition.right": "(bottom only for now)",
  "panelAlign.justify": "(centre only for now)",
  "activityBar.top": "(side only for now)", "activityBar.hidden": "(side only for now)",
  movePrimary: "(left only for now)",
};
/** The side/bottom toggles draw nothing while their slot holds no panel (slotVisible needs panels), so they say so instead of flipping a
 * check mark silently (review W-2B M3). Item id -> the slot it shows. */
export const SLOT_TOGGLES: Readonly<Record<string, SlotId>> = { primarySideBar: "left", secondarySideBar: "right", bottomPanel: "bottom" };
export const EMPTY_SLOT_REASON = "(move a panel here first)";

export function decorateMenu(items: ViewItem[], layout?: Layout): ViewItem[] {
  return items.map(it => {
    const why = UNSUPPORTED_ITEMS[it.id] ?? (layout && SLOT_TOGGLES[it.id] && layout.slots[SLOT_TOGGLES[it.id]].panels.length === 0 ? EMPTY_SLOT_REASON : undefined);
    const next = why ? { ...it, disabled: true, label: `${it.label} ${why}` } : it;
    return next.submenu ? { ...next, submenu: decorateMenu(next.submenu, layout) } : next;
  });
}

/** Thread panel / calls-only builds have no shell layout: keep only the terminal text, workbench actions and the note. */
const SCOPED = new Set<string>(["term.fontSmaller", "term.fontLarger", "term.fontReset", "workbench.filters", "workbench.refresh", "workbench.load", "workbench.export"]);
export function scopedMenu(items: ViewItem[]): ViewItem[] {
  const keep = items.filter(i => i.kind === "note" || i.kind === "separator" || (typeof i.onSelect === "string" && SCOPED.has(i.onSelect)));
  const out: ViewItem[] = [];
  for (const i of keep) { if (i.kind === "separator" && (out.length === 0 || out[out.length - 1].kind === "separator")) continue; out.push(i); }
  while (out.length && out[out.length - 1].kind === "separator") out.pop();
  return out;
}

// ---- Esc ------------------------------------------------------------------------------------------------------------------
export type EscState = { editor: boolean; zen: boolean; selectedCall: boolean; selectedDay: boolean; spineDay?: boolean; typing: boolean };
export type EscAction = "ignore" | "exitZen" | "clearCall" | "clearDay" | "clearSpineDay" | "resetView";
/** First match wins: a chat/terminal composer keeps its own Esc; then zen; then the open call; then the picked git day, then the
 * picked Calendar day (both only when not typing); then the old catch-all (clear selection and problem, back to Changes).
 * Zen note (review W-2B L2): inside the terminal Esc belongs to the program running there, so it does NOT exit zen; the
 * "Exit zen" chip and the zen shortcut do. */
export function escAction(s: EscState): EscAction {
  if (s.editor) return "ignore";
  if (s.zen) return "exitZen";
  if (s.selectedCall) return "clearCall";
  if (s.selectedDay && !s.typing) return "clearDay";
  if (s.spineDay && !s.typing) return "clearSpineDay";
  return "resetView";
}

// ---- focus ----------------------------------------------------------------------------------------------------------------
/** Which panel takes focus after `a`: the slot's remembered panel (focusTarget) when it is the one on show, else the panel the
 * action named. Per-Herdr-space memory stays as it was: it is applied when a terminal is attached (app.tsx attachTerminal). */
export function focusAfterAction(layout: Layout, a: LayoutAction & { panel: string }): string {
  const next = reduce(layout, a), slot = slotOf(next, a.panel);
  const t = slot ? focusTarget(next, { slot }) : null;
  return t && slot && next.slots[slot].active === t ? t : a.panel;
}

// ---- status bar -----------------------------------------------------------------------------------------------------------
const head8 = (h: string) => h.slice(0, 8);
export const sameHead = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && (a.startsWith(b.slice(0, 7)) || b.startsWith(a.slice(0, 7)));
/** `main @ 631b37b8 · index 27 behind` (count from repo health), `· index from abc12345` (no count), or just `main @ 631b37b8`. */
export function headStatus(i: { branch: string; head: string; indexHead: string | null; behind: { count: number; capped: boolean } | null }): string {
  const base = `${i.branch} @ ${head8(i.head)}`;
  if (!i.indexHead || sameHead(i.head, i.indexHead)) return base;
  return i.behind && i.behind.count > 0 ? `${base} · index ${i.behind.count}${i.behind.capped ? "+" : ""} behind` : `${base} · index from ${head8(i.indexHead)}`;
}

// ---- repos ----------------------------------------------------------------------------------------------------------------
export const normRepo = (p: string) => p.trim().replace(/(.)\/+$/, "$1");
export const sameRepo = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && normRepo(a) === normRepo(b);

/** What Osiris remembers about the Work tracker. `last` = the most recent explicit pick; `def` = the pinned "Make default" repo. */
export type TrackerStore = { last: string | null; def: string | null };
export const TRACKER_KEY = "osiris-work-tracker.v2";
export const LEGACY_TRACKER_KEY = "osiris-work-repo";
/** Read the stored choice. The old `osiris-work-repo` value counts as an explicit past pick: only the owner could have set it. Never invents a repo. */
export function parseTrackerStore(raw: string | null, legacy: string | null): TrackerStore | null {
  try {
    const v = raw ? JSON.parse(raw) : null;
    if (v && typeof v === "object") {
      const last = typeof v.last === "string" && v.last ? v.last : null, def = typeof v.def === "string" && v.def ? v.def : null;
      if (last || def) return { last, def };
    }
  } catch { /* corrupt value: treat as never picked */ }
  return legacy ? { last: legacy, def: null } : null;
}
/** The repo to show on open: pinned default, else the last explicit pick, else null so the PICKER shows. Never falls back to any other repo. */
export const trackerState = (stored: TrackerStore | null): string | null => stored?.def ?? stored?.last ?? null;
/** An explicit pick: becomes `last`; `makeDefault` also pins it. A one-off pick leaves an existing default alone. */
export const pickTracker = (stored: TrackerStore | null, path: string, makeDefault: boolean): TrackerStore =>
  ({ last: path, def: makeDefault ? path : stored?.def ?? null });
/** The header's Make default toggle for the repo on screen. */
export const toggleDefault = (stored: TrackerStore | null, shown: string): TrackerStore =>
  ({ last: stored?.last ?? shown, def: sameRepo(stored?.def, shown) ? null : shown });
export const trackerName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

// ---- late answers ---------------------------------------------------------------------------------------------------------
/** Number every request; accept an answer only if it is newer than the last one applied, so a slow old reply never overwrites a newer one. */
export function makeSeqGuard() {
  let issued = 0, applied = 0;
  return { next: () => ++issued, accept: (n: number) => { if (n <= applied) return false; applied = n; return true; } };
}

// ---- pinning a typed path -------------------------------------------------------------------------------------------------
export type PinResult = { ok: true; path: string } | { ok: false; reason: string };
export type CallLike = { call: (name: string, input: unknown) => Promise<unknown> };
export function pinReason(e: unknown): string {
  const m = (e instanceof Error ? e.message : String(e)).replace(/^(Error: )?pin: /, "").trim();
  return m || "That folder could not be used.";
}
/** Typed paths are refused by the server until pinned. Pin first; return the resolved path, or a plain reason to show. */
export async function pinRepoVia(rpc: CallLike, typed: string): Promise<PinResult> {
  const path = typed.trim();
  if (!path.startsWith("/") || path.includes("\0")) return { ok: false, reason: "Enter an absolute path that starts with /." };
  try {
    const r = (await rpc.call("pinRepo", { path })) as { ok?: boolean; path?: string } | null;
    return r?.ok && typeof r.path === "string" ? { ok: true, path: r.path } : { ok: false, reason: "That folder could not be used." };
  } catch (e) { return { ok: false, reason: pinReason(e) }; }
}

// ---- activity nav: what each item surfaces (pinned by __tests__/nav-reachability.test.ts) ----
export const NAV_ITEMS = [
  // abbr: the collapsed rail shows these, so no two may match (Calls/Calendar, History/Health). Terminal shows its live label's first letter.
  { id: "home", label: "Home", abbr: "Ho" }, { id: "terminal", label: "Terminal", abbr: "T" }, { id: "calls", label: "Calls", abbr: "Ca" }, { id: "work", label: "Work", abbr: "W" },
  { id: "history", label: "History", abbr: "Hi" }, { id: "calendar", label: "Calendar", abbr: "Cd" }, { id: "health", label: "Health", abbr: "He" },
  { id: "archive", label: "Archive", abbr: "A" },
] as const;
export type NavId = (typeof NAV_ITEMS)[number]["id"];
/** Rows hidden from the left nav. Empty: the owner uses Calls and History daily, so both are drawn (td-osi.12) even though the mockup omits them. */
export const NAV_HIDDEN: ReadonlySet<NavId> = new Set<NavId>([]);
/** nav item -> the registry panel ids it puts one click away. Work modes are pills inside Work; Decisions is the Work inspector's top card;
 *  Calls surfaces the inspector (the tool-call observer); History is Work's Commits mode (workMode "graph"). */
export const navTargets: Readonly<Record<NavId, readonly string[]>> = {
  home: ["home"], terminal: ["terminal"],
  calls: ["inspector"],
  work: ["work", ...(GRAPH_ENABLED ? ["work.graph"] : []), "work.board", "work.factory", "work.decisions"],
  history: ["work"],
  calendar: ["calendar", "calendar.day"], health: ["health"], archive: ["archive"],
};
/** Panels that live INSIDE another panel and are on screen whenever that host is placed by DEFAULT_LAYOUT (no nav click needed). */
export const hostedBy: Readonly<Record<string, string>> = { "sidebar.bottom": "sidebar" };
