// Picking Factory (owner td-osi.1, re-homed 2026-10-11 when the bottom strip merged into the right bar): `work.factory` opens in the RIGHT panel as the ACTIVE tab (Inspector · Factory · Day · Work tree), and the centre
// KEEPS whatever Work view it had (Graph or Board). Pure, so a test can pin the placement and has teeth: `factoryPlacementProblems` names
// every way a placement can be wrong, and a planted bad placement must be caught.
import type { Layout, LayoutAction } from "./layout-types.ts";
import { slotOf, slotVisible } from "./layout-model.ts";

export const FACTORY_ID = "work.factory";

/** What the Factory pill does. `mode` is the centre's Work view, returned UNCHANGED (the caller must not write it). */
export function pickFactory<M extends string>(mode: M): { action: LayoutAction; mode: M } {
  return { action: { type: "open", panel: FACTORY_ID, slot: "right" }, mode };
}

/** Is the Factory on screen right now (in a visible slot, and the active tab there)? Drives the pill's pressed state and hides the KPI strip. */
export function factoryOnScreen(l: Layout): boolean {
  const at = slotOf(l, FACTORY_ID);
  return at !== null && l.slots[at].active === FACTORY_ID && slotVisible(l, at);
}

/** Empty = the placement is right. */
export function factoryPlacementProblems(before: Layout, after: Layout, modeBefore: string, modeAfter: string): string[] {
  const out: string[] = [];
  if (slotOf(after, FACTORY_ID) !== "right") out.push(`work.factory is in ${slotOf(after, FACTORY_ID) ?? "no slot"}, not the right panel`);
  if (after.slots.right.active !== FACTORY_ID) out.push(`the active right tab is ${after.slots.right.active}, not work.factory`);
  if (!slotVisible(after, "right")) out.push("the right panel is not visible");
  if (before.slots.right.panels.includes("work.tree") && !after.slots.right.panels.includes("work.tree")) out.push("the Work tree left the right panel");
  if (after.slots.centre.active !== before.slots.centre.active) out.push(`the centre panel changed (${before.slots.centre.active} -> ${after.slots.centre.active})`);
  if (modeAfter !== modeBefore) out.push(`the centre Work view changed (${modeBefore} -> ${modeAfter})`);
  return out;
}
