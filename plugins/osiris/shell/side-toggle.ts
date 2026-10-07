// Opening and closing a side bar (pure). Two independent things decide whether a side bar is on screen: the layout flag
// (view.primarySideBar / secondarySideBar, plus a panel in the slot) AND the pane width ratio (app.tsx `panes`, persisted in
// localStorage, 0 = dragged shut). The old toggle only flipped the flag, so a bar collapsed by its divider stayed invisible
// while View and the shortcut flipped a check mark (bug F, td-osi.12). toggleSide decides from what is REALLY visible.
import type { Layout, LayoutAction, SlotId } from "./layout-types.ts";
import { CMD } from "./keymap.ts";
import { slotVisible } from "./layout-model.ts";

export type SideSlot = "left" | "right";
export type Panes = { left: number; right: number };
export const PANE_OPEN: Panes = { left: 0.15, right: 0.3 };
const DEFAULT_PANEL: Record<SideSlot, string> = { left: "sidebar", right: "inspector" };

/** Which slot a side-bar command drives: the primary bar is the left slot unless moved right, the secondary is the other. */
export function sideSlotFor(command: string, layout: Layout): SideSlot | null {
  const pr = layout.view.primaryRight;
  if (command === CMD.primarySideBar) return pr ? "right" : "left";
  if (command === CMD.secondarySideBar || command === CMD.secondarySideBarAlt) return pr ? "left" : "right";
  return null;
}
const flagKey = (slot: SideSlot, layout: Layout) => ((layout.view.primaryRight ? "right" : "left") === slot ? "primarySideBar" : "secondarySideBar") as "primarySideBar" | "secondarySideBar";

/** A View-menu setView that only flips one side-bar flag is the same command as its shortcut; route it through toggleSide. */
export function sideCommandOf(a: LayoutAction): string | null {
  if (a.type !== "setView") return null;
  const k = Object.keys(a.patch);
  if (k.length !== 1) return null;
  return k[0] === "primarySideBar" ? CMD.primarySideBar : k[0] === "secondarySideBar" ? CMD.secondarySideBar : null;
}

/** Visible = slot drawn by the layout AND not collapsed to a zero pane. */
export const sideShown = (layout: Layout, panes: Panes, slot: SideSlot, desktop = true): boolean => slotVisible(layout, slot) && (!desktop || panes[slot] > 0);

export type SideToggle = { actions: LayoutAction[]; panes: Panes };
/** Toggle a side bar by what is on screen. Opening: set the flag, seed the slot with its default panel when empty/invalid,
 * and restore a collapsed pane width. Closing: clear the flag. */
export function toggleSide(layout: Layout, panes: Panes, slot: SideSlot, desktop = true): SideToggle {
  const key = flagKey(slot, layout);
  if (sideShown(layout, panes, slot, desktop)) return { actions: [{ type: "setView", patch: { [key]: false } }], panes };
  const actions: LayoutAction[] = [];
  if (layout.view.zen) actions.push({ type: "setView", patch: { zen: false } });
  if (layout.slots[slot].panels.length === 0) actions.push({ type: "open", panel: DEFAULT_PANEL[slot], slot });
  actions.push({ type: "setView", patch: { [key]: true } });
  return { actions, panes: panes[slot] > 0 ? panes : { ...panes, [slot]: PANE_OPEN[slot] } };
}

/** Closed side bars that still draw an edge notch to reopen them (never in zen, which has its own exit chip). */
export function notchSides(layout: Layout, shown: Record<SideSlot, boolean>): SideSlot[] {
  if (layout.view.zen) return [];
  return (["left", "right"] as SideSlot[]).filter(s => !shown[s]);
}
export const notchLabel = (slot: SideSlot) => `Open ${slot} sidebar`;
export type { SlotId };
