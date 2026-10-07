// Pure rules for what picking a bead does to the layout (review W-2B M2). No React, no DOM.
// A Work panel (work.graph, work.board, work.factory, work.decisions) is a surface of its own: choosing a bead inside one must
// select it and leave the centre alone, so the terminal keeps its place. Only when no Work panel is visible anywhere does a pick
// (for example from the sidebar list) open the Work canvas in the centre, as before.

/** Is any Work panel (a `work.*` id) on screen? `placed` is the host plan's slot -> panel id map (hidden slots are already left out). */
export function workPanelVisible(placed: Readonly<Record<string, string>>): boolean {
  return Object.values(placed).some(id => id.startsWith("work."));
}

/** Where a bead pick came from: a placed Work panel / the mini graph ("panel"), or the sidebar list / anywhere else ("other"). */
export type BeadPickFrom = "panel" | "other";

/** `moveCentre` = open the Work canvas in the centre. False whenever the pick came from a placed panel, or a Work panel is already visible. */
export function beadSelectEffect(placed: Readonly<Record<string, string>>, from: BeadPickFrom = "other"): { moveCentre: boolean } {
  if (from === "panel") return { moveCentre: false };
  return { moveCentre: !workPanelVisible(placed) };
}

/** Review W-3B N1: a bead picked in a placed Work panel claims the inspector only while that pick is the LATEST selection.
 * `beadFocus` is set by a bead pick and cleared by any other pick (commit, day, spine, health, project) or a canvas switch. */
export function showPlacedBead(o: { workPanelVisible: boolean; beadFocus: boolean; hasBead: boolean; goalView: boolean; centreIsBeads: boolean }): boolean {
  return o.workPanelVisible && o.beadFocus && o.hasBead && !o.goalView && !o.centreIsBeads;
}
