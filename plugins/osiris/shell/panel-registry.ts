// Every surface the shell can place in a slot. Only what app.tsx can actually render is registered: normalize() drops ids
// that are not here, so a registered-but-unrenderable panel would be a blank slot. The Left sidebar is ONE panel (its five
// sections live in components/left-sidebar.tsx and are not separable without editing it); the inspector is ONE panel (its
// Overview/All/Trace/Problems/Signals/Changes tabs share the call state); Work holds Commits/Threads/Projects as modes;
// Graph/Board/Factory/Decisions and the sidebar's bottom pill-tab panel are their own panels (work.*, sidebar.bottom).
import type {PanelDef} from "./layout-types.ts";

/** The ONE Graph switch. Owner 2026-10-07 first hid it ("kinda useless"), then asked for ALL features on to match the approved mockup (td-osi.12), so it is ON. false HIDES every Graph surface (Work "Graph" pill,
 *  sidebar mini-graph tab, the work.graph panel, nav/View/palette routes) without deleting the modules. Flip to true to bring it back. Commits (the git view) is NOT Graph. */
export const GRAPH_ENABLED = true;

const ALL_PANELS: readonly PanelDef[] = [
  // inlineChrome: the terminal's own 28px toolbar hosts the panel controls, so the frame adds NO row above the terminal.
  {id: "terminal", title: "Terminal", minWidth: 320, keepMounted: true, inlineChrome: true, group: "core"},
  {id: "home", title: "Home", minWidth: 320, group: "core"},
  {id: "sidebar", title: "Sidebar", minWidth: 160, group: "sidebar"},
  {id: "inspector", title: "Inspector", minWidth: 270, group: "inspector"},
  {id: "work", title: "Work", minWidth: 300, group: "work"},
  // Work views as their own panels (WV): each renders through components/work/work-panels.tsx renderWorkPanel. The ids live in
  // work/panel-ids.ts; shell/__tests__/panel-registry.test.ts pins registry and renderers both ways (no orphans).
  {id: "work.tree", title: "Work tree", minWidth: 240, group: "work"},
  {id: "work.graph", title: "Graph", minWidth: 320, group: "work"},
  {id: "work.board", title: "Board", minWidth: 320, group: "work"},
  {id: "work.factory", title: "Factory", minWidth: 320, group: "work"},
  {id: "work.decisions", title: "Decisions waiting on you", minWidth: 240, group: "work"},
  {id: "sidebar.bottom", title: GRAPH_ENABLED ? "Next up · Commits · Graph" : "Next up · Commits", minWidth: 160, group: "sidebar"},
  {id: "calendar", title: "Calendar", minWidth: 300, group: "spine"},
  // The Calendar's selected day as the Commits git view (components/day-tab.tsx); auto-added beside Inspector on the first day pick.
  {id: "calendar.day", title: "Day", minWidth: 300, group: "spine"},
  {id: "health", title: "Health", minWidth: 300, group: "spine"},
  {id: "archive", title: "Archive", minWidth: 300, group: "spine"},
];

/** Disabled panels are filtered out here, so normalize() also drops a persisted layout's `work.graph` and the Open View list never offers it. */
export const PANELS: readonly PanelDef[] = ALL_PANELS.filter(p => GRAPH_ENABLED || p.id !== "work.graph");

export const panelDef = (id: string): PanelDef | undefined => PANELS.find(p => p.id === id);
/** The canvases the activity nav opens in the centre (Terminal is itself a panel). */
export const CANVAS_PANELS = ["home", "terminal", "work", "calendar", "health", "archive"] as const;
export type CanvasId = (typeof CANVAS_PANELS)[number];
export const isCanvas = (id: string | null | undefined): id is CanvasId => !!id && (CANVAS_PANELS as readonly string[]).includes(id);
