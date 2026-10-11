// The Work surface's dotted panel ids, ONE list. shell/panel-registry.ts registers a PanelDef for each, and
// components/work/work-panels.tsx must hold a renderer for each (its render map is typed over this list); a test pins both ways.
export const WORK_PANEL_IDS = ["work.tree", "work.graph", "work.board", "work.factory", "work.decisions", "sidebar.bottom"] as const;
export type WorkPanelId = (typeof WORK_PANEL_IDS)[number];
export const isWorkPanelId = (id: string): id is WorkPanelId => (WORK_PANEL_IDS as readonly string[]).includes(id);

/** What a Work panel shows before it has a snapshot. 0.3.1 live (owner, "factory doesnt work"): every null snapshot said "Choose a tracker
 *  to see this." with no way to do it, even while a chosen tracker was still being read (workSnapshot took seconds on the starved loop)
 *  or had failed. Three states, three messages; only "none" offers the picker. Pure, so node --test pins it without JSX. */
export type WorkPanelGate = { kind: "ready" } | { kind: "none"; text: string; action: string } | { kind: "reading"; text: string } | { kind: "error"; text: string };
export function workPanelGate(c: { snap: unknown; tracker?: string | null; error?: string | null }): WorkPanelGate {
  if (c.snap) return { kind: "ready" };
  if (!c.tracker) return { kind: "none", text: "No Work tracker is chosen, so there is nothing to show here yet.", action: "Choose a tracker" };
  if (c.error) return { kind: "error", text: `Could not read the tracker: ${c.error}` };
  return { kind: "reading", text: "Reading the tracker…" };
}
