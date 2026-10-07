// The Work surface's dotted panel ids, ONE list. shell/panel-registry.ts registers a PanelDef for each, and
// components/work/work-panels.tsx must hold a renderer for each (its render map is typed over this list); a test pins both ways.
export const WORK_PANEL_IDS = ["work.tree", "work.graph", "work.board", "work.factory", "work.decisions", "sidebar.bottom"] as const;
export type WorkPanelId = (typeof WORK_PANEL_IDS)[number];
export const isWorkPanelId = (id: string): id is WorkPanelId => (WORK_PANEL_IDS as readonly string[]).includes(id);
