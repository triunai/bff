// View menu model (pure). The menu is data: each item names what it does, either a LayoutAction (the reducer handles it)
// or a command id string (the shell handles it: zen/search palette/Open View…/redraw/font size/workbench actions).
import type { ActivityBarPosition, Layout, LayoutAction, PanelAlign, PanelPosition, TabBarMode } from "./layout-types.ts";
import { CMD, chordFor } from "./keymap.ts";
import { THEME_LABEL, THEME_NAMES } from "../theme/tokens.ts";
import { CUSTOM_THEME } from "../theme/derive-theme.ts";

export type ViewSelect = LayoutAction | string;
export type ViewItem = {
  id: string; label: string; shortcut?: string; // shortcut is a KeyChord ("Mod+B"); the menu formats it per platform
  checked?: boolean; disabled?: boolean; submenu?: ViewItem[]; onSelect?: ViewSelect;
  kind?: "item" | "separator" | "note"; hint?: string; // hint: right-side status text such as "120%" or "13px"
};

/** Host state the pure Layout does not hold. Every field optional: omit a group and its section is omitted. */
export type ViewOpts = {
  term?: { size: number; min: number; max: number; default: number }; // terminal text size (existing View-menu row)
  legacyPanes?: { work: boolean; inspector: boolean }; // existing "Work pane" / "Inspector pane" toggles
  workbench?: { busy: boolean; canRefresh: boolean; canExport: boolean }; // the former ••• menu actions
  demo?: boolean; // true while the synthetic demo data is shown (the item flips between Load and Exit)
  classicFactory?: boolean; // true while the classic Factory view is shown instead of the new Factory floor (default false)
  note?: string; // existing footnote about BB's sidebar shortcut
  sources?: { id: string; label: string; selected: boolean }[]; // the Herdr / BB / All scope switch (moved here from the header, ADR D-137)
};

const sep = (id: string): ViewItem => ({ id, label: "", kind: "separator" });
const set = (patch: Partial<Layout["view"]>): LayoutAction => ({ type: "setView", patch });
const choice = <T extends string>(id: string, label: string, current: T, value: T, key: keyof Layout["view"]): ViewItem => ({ id, label, checked: current === value, onSelect: set({ [key]: value } as Partial<Layout["view"]>) });
export const zoomPercent = (zoom: number) => Math.round(zoom * 100);

export function viewItems(layout: Layout, opts: ViewOpts = {}): ViewItem[] {
  const v = layout.view;
  const items: ViewItem[] = [
    { id: "primarySideBar", label: "Primary Side Bar", shortcut: chordFor(CMD.primarySideBar), checked: v.primarySideBar, onSelect: set({ primarySideBar: !v.primarySideBar }) },
    { id: "secondarySideBar", label: "Secondary Side Bar", shortcut: chordFor(CMD.secondarySideBar), checked: v.secondarySideBar, onSelect: set({ secondarySideBar: !v.secondarySideBar }) },
    { id: "statusBar", label: "Status Bar", checked: v.statusBar, onSelect: set({ statusBar: !v.statusBar }) },
    { id: "bottomPanel", label: "Bottom Panel", shortcut: chordFor(CMD.bottomPanel), checked: v.bottomPanel, onSelect: set({ bottomPanel: !v.bottomPanel }) },
    { id: "movePrimary", label: v.primaryRight ? "Move Primary Side Bar Left" : "Move Primary Side Bar Right", onSelect: set({ primaryRight: !v.primaryRight }) },
    sep("s1"),
    { id: "activityBar", label: "Activity Bar Position", submenu: (["side", "top", "hidden"] as ActivityBarPosition[]).map(x => choice(`activityBar.${x}`, x === "side" ? "Side" : x === "top" ? "Top" : "Hidden", v.activityBar, x, "activityBar")) },
    { id: "panelPosition", label: "Panel Position", submenu: (["bottom", "left", "right"] as PanelPosition[]).map(x => choice(`panelPosition.${x}`, x[0].toUpperCase() + x.slice(1), v.panelPosition, x, "panelPosition")) },
    { id: "panelAlign", label: "Align Panel", submenu: (["centre", "justify"] as PanelAlign[]).map(x => choice(`panelAlign.${x}`, x === "centre" ? "Centre" : "Justify", v.panelAlign, x, "panelAlign")) },
    { id: "tabBar", label: "Tab Bar", submenu: (["pills", "single", "hidden"] as TabBarMode[]).map(x => choice(`tabBar.${x}`, x === "pills" ? "Pill tabs" : x === "single" ? "Single" : "Hidden", v.tabBar, x, "tabBar")) },
    { id: "theme", label: "Theme", submenu: [
      ...THEME_NAMES.map(n => choice<Layout["view"]["theme"]>(`theme.${n}`, THEME_LABEL[n], v.theme, n, "theme")),
      // "Custom colour…" opens the picker (components/theme-picker.tsx); it is checked while a picked accent is what is shown.
      { id: `theme.${CUSTOM_THEME}`, label: v.customTheme ? `Custom colour… (${v.customTheme.accent})` : "Custom colour…", checked: v.theme === CUSTOM_THEME, onSelect: "view.themePicker" },
    ] },
    sep("s2"),
    { id: "zen", label: "Zen Mode", shortcut: chordFor(CMD.zen), checked: v.zen, onSelect: CMD.zen },
    { id: "zoomIn", label: "Zoom In", shortcut: chordFor(CMD.zoomIn), hint: `${zoomPercent(v.zoom)}%`, onSelect: { type: "zoom", dir: "in" } },
    { id: "zoomOut", label: "Zoom Out", shortcut: chordFor(CMD.zoomOut), onSelect: { type: "zoom", dir: "out" } },
    { id: "zoomReset", label: "Reset Zoom", shortcut: chordFor(CMD.zoomReset), onSelect: { type: "zoom", dir: "reset" } },
    sep("s3"),
    { id: "openView", label: "Open View…", shortcut: chordFor(CMD.openView), onSelect: CMD.openView },
    { id: "shortcuts", label: "Keyboard Shortcuts", shortcut: chordFor(CMD.shortcuts), onSelect: CMD.shortcuts },
    { id: "help", label: "Help and Glossary", onSelect: CMD.help },
    { id: "classicFactory", label: "Classic factory", checked: opts.classicFactory ?? false, onSelect: "view.classicFactory" },
    { id: "demo", label: opts.demo ? "Exit demo data" : "Load demo data", checked: opts.demo ?? false, onSelect: "view.demo" },
    { id: "resetLayout", label: "Reset Layout", onSelect: { type: "reset" } },
    { id: "redraw", label: "Redraw", onSelect: "view.redraw" },
  ];
  if (opts.sources) items.unshift({ id: "scope", label: "Scope", submenu: opts.sources.map(x => ({ id: `scope.${x.id}`, label: x.label, checked: x.selected, onSelect: `source.${x.id}` })) }, sep("s0"));
  if (opts.term) {
    const t = opts.term;
    items.push(sep("s4"),
      { id: "term.smaller", label: "Terminal Text Smaller", hint: `${t.size}px`, disabled: t.size <= t.min, onSelect: "term.fontSmaller" },
      { id: "term.larger", label: "Terminal Text Larger", disabled: t.size >= t.max, onSelect: "term.fontLarger" },
      { id: "term.reset", label: `Reset Terminal Text (${t.default}px)`, disabled: t.size === t.default, onSelect: "term.fontReset" });
  }
  if (opts.legacyPanes) items.push(sep("s5"),
    { id: "legacy.work", label: "Work pane", checked: opts.legacyPanes.work, onSelect: "legacy.toggleWork" },
    { id: "legacy.inspector", label: "Inspector pane", checked: opts.legacyPanes.inspector, onSelect: "legacy.toggleInspector" });
  if (opts.workbench) {
    const w = opts.workbench;
    items.push(sep("s6"),
      { id: "wb.filters", label: "Filters, Source and Coverage…", onSelect: "workbench.filters" },
      { id: "wb.refresh", label: w.busy ? "Scanning…" : "Refresh Capture", disabled: w.busy || !w.canRefresh, onSelect: "workbench.refresh" },
      { id: "wb.load", label: "Import Metadata JSON…", onSelect: "workbench.load" },
      { id: "wb.export", label: "Export These Calls (Metadata Only)", disabled: !w.canExport, onSelect: "workbench.export" });
  }
  if (opts.note) items.push(sep("s7"), { id: "note", label: opts.note, kind: "note" });
  return items;
}
