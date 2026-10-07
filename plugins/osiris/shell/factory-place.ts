// Picking Factory (owner td-osi.1): `work.factory` opens in the full-width BOTTOM slot as the ACTIVE tab next to the Work tree, and the centre
// KEEPS whatever Work view it had (Graph or Board). Pure, so a test can pin the placement and has teeth: `factoryPlacementProblems` names
// every way a placement can be wrong, and a planted bad placement must be caught.
import type { Layout, LayoutAction } from "./layout-types.ts";
import { slotOf, slotVisible } from "./layout-model.ts";

export const FACTORY_ID = "work.factory";

/** What the Factory pill does. `mode` is the centre's Work view, returned UNCHANGED (the caller must not write it). */
export function pickFactory<M extends string>(mode: M): { action: LayoutAction; mode: M } {
  return { action: { type: "open", panel: FACTORY_ID, slot: "bottom" }, mode };
}

/** Is the Factory on screen right now (in a visible slot, and the active tab there)? Drives the pill's pressed state and hides the KPI strip. */
export function factoryOnScreen(l: Layout): boolean {
  const at = slotOf(l, FACTORY_ID);
  return at !== null && l.slots[at].active === FACTORY_ID && slotVisible(l, at);
}

/** Empty = the placement is right. */
export function factoryPlacementProblems(before: Layout, after: Layout, modeBefore: string, modeAfter: string): string[] {
  const out: string[] = [];
  if (slotOf(after, FACTORY_ID) !== "bottom") out.push(`work.factory is in ${slotOf(after, FACTORY_ID) ?? "no slot"}, not the bottom slot`);
  if (after.slots.bottom.active !== FACTORY_ID) out.push(`the active bottom tab is ${after.slots.bottom.active}, not work.factory`);
  if (!slotVisible(after, "bottom")) out.push("the bottom strip is not visible");
  if (before.slots.bottom.panels.includes("work.tree") && !after.slots.bottom.panels.includes("work.tree")) out.push("the Work tree left the bottom strip");
  if (after.slots.centre.active !== before.slots.centre.active) out.push(`the centre panel changed (${before.slots.centre.active} -> ${after.slots.centre.active})`);
  if (modeAfter !== modeBefore) out.push(`the centre Work view changed (${modeBefore} -> ${modeAfter})`);
  return out;
}
