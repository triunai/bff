// Pure layout model (owner 19:13-19:24). No React, no DOM: the shell renders what `reduce` returns, and `normalize` is the
// only door persisted (untrusted) JSON may enter through. The terminal can be moved but never lost, and the centre is
// never empty: both are enforced by `settle`, which every reducer case ends with, so no action sequence can break them.
import {CUSTOM_THEME,parseCustomTheme} from "../theme/derive-theme.ts";
import {DEFAULT_THEME,resolveTheme} from "../theme/tokens.ts";
import {SLOTS, type Layout, type LayoutAction, type PanelDef, type SlotId, type SlotState, type ViewOptions} from "./layout-types.ts";

export const TERMINAL_ID = "terminal";
/** The beady-eye Work tree: always in the bottom strip (owner td-osi.1), never in the left sidebar. */
export const WORK_TREE_ID = "work.tree";
export const ZOOM_MIN = 0.7, ZOOM_MAX = 1.6, ZOOM_STEP = 0.1;
const MAX_PER_SLOT = 32, MAX_SPACES = 64, MAX_ID = 64;

export const DEFAULT_VIEW: ViewOptions = {
  primarySideBar: true, secondarySideBar: true, statusBar: true, bottomPanel: true, primaryRight: false,
  activityBar: "side", panelPosition: "bottom", panelAlign: "centre", tabBar: "pills", zen: false, zoom: 1,
  theme: DEFAULT_THEME, customTheme: null, bottomSeeded: true,
};

const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]); }
  return v;
};

/** The current look: sidebar left, terminal centre, inspector right, bottom closed. Frozen so an accidental mutation throws. */
export const DEFAULT_LAYOUT: Layout = deepFreeze({
  version: 1,
  slots: {
    left: {panels: ["sidebar"], active: "sidebar"},
    centre: {panels: [TERMINAL_ID], active: TERMINAL_ID},
    right: {panels: ["inspector"], active: "inspector"},
    bottom: {panels: [WORK_TREE_ID], active: WORK_TREE_ID},
  },
  view: {...DEFAULT_VIEW},
  focus: {bySlot: {}, bySpace: {}, last: null},
});

export const clampZoom = (z: number): number => (Number.isFinite(z) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 10) / 10)) : 1);

export const slotOf = (l: Layout, panel: string): SlotId | null => { for (const s of SLOTS) if (l.slots[s].panels.includes(panel)) return s; return null; };

/** Is the slot on screen? Centre always; zen hides every other slot; a side slot needs panels and its side-bar flag. */
export function slotVisible(l: Layout, slot: SlotId): boolean {
  if (slot === "centre") return true;
  if (l.view.zen || l.slots[slot].panels.length === 0) return false;
  if (slot === "bottom") return l.view.bottomPanel;
  const primary: SlotId = l.view.primaryRight ? "right" : "left";
  return slot === primary ? l.view.primarySideBar : l.view.secondarySideBar;
}

const without = (s: SlotState, panel: string): SlotState => {
  const i = s.panels.indexOf(panel);
  if (i < 0) return s;
  const panels = s.panels.filter(p => p !== panel);
  return {panels, active: s.active === panel ? (panels[i] ?? panels[panels.length - 1] ?? null) : s.active};
};

const withSlot = (l: Layout, slot: SlotId, s: SlotState): Layout => ({...l, slots: {...l.slots, [slot]: s}});

/** Show the slot a panel just landed in (a closed bottom or a hidden side bar would otherwise swallow the move). */
const reveal = (v: ViewOptions, slot: SlotId): ViewOptions => {
  if (slot === "bottom") return v.bottomPanel ? v : {...v, bottomPanel: true};
  if (slot === "centre") return v;
  const primary = (v.primaryRight ? "right" : "left") === slot;
  if (primary ? v.primarySideBar : v.secondarySideBar) return v;
  return primary ? {...v, primarySideBar: true} : {...v, secondarySideBar: true};
};

/** Invariants every action ends with: each slot's active is one of its panels; the terminal exists; the centre is not empty. */
function settle(l: Layout): Layout {
  let slots = l.slots, changed = false;
  const set = (slot: SlotId, s: SlotState) => { slots = {...slots, [slot]: s}; changed = true; };
  for (const slot of SLOTS) {
    const s = slots[slot];
    if (s.panels.length > 0 ? (s.active === null || !s.panels.includes(s.active)) : s.active !== null) set(slot, {panels: s.panels, active: s.panels[0] ?? null});
  }
  let at: SlotId | null = null;
  for (const slot of SLOTS) if (slots[slot].panels.includes(TERMINAL_ID)) { at = slot; break; }
  if (at === null) { const c = slots.centre; set("centre", {panels: [TERMINAL_ID, ...c.panels], active: c.active ?? TERMINAL_ID}); }
  else if (slots.centre.panels.length === 0) {
    set(at, without(slots[at], TERMINAL_ID));
    set("centre", {panels: [TERMINAL_ID], active: TERMINAL_ID});
  }
  const out = changed ? {...l, slots} : l;
  const focus = pruneFocus(out);
  return focus === out.focus ? out : {...out, focus};
}

/** Focus memory only ever names panels that are open, and bySlot only the slot a panel actually sits in. */
function pruneFocus(l: Layout): Layout["focus"] {
  const f = l.focus, open = (p: string) => slotOf(l, p) !== null;
  const bySlot: Partial<Record<SlotId, string>> = {};
  for (const slot of SLOTS) { const p = f.bySlot[slot]; if (p && l.slots[slot].panels.includes(p)) bySlot[slot] = p; }
  const bySpace: Record<string, string> = {};
  for (const [k, p] of Object.entries(f.bySpace)) if (open(p)) bySpace[k] = p;
  const last = f.last && open(f.last) ? f.last : null;
  const same = last === f.last && Object.keys(bySlot).length === Object.keys(f.bySlot).length && Object.keys(bySpace).length === Object.keys(f.bySpace).length
    && SLOTS.every(s => bySlot[s] === f.bySlot[s]);
  return same ? f : {bySlot, bySpace, last};
}

function activate(l: Layout, panel: string): Layout {
  const slot = slotOf(l, panel);
  if (slot === null || l.slots[slot].active === panel) return l;
  return withSlot(l, slot, {...l.slots[slot], active: panel});
}

function moveTo(l: Layout, panel: string, slot: SlotId): Layout {
  const from = slotOf(l, panel);
  if (from === slot) return reduce(l, {type: "activate", panel});
  let next = from ? withSlot(l, from, without(l.slots[from], panel)) : l;
  const dst = next.slots[slot];
  if (dst.panels.length >= MAX_PER_SLOT) return l;
  next = withSlot(next, slot, {panels: [...dst.panels, panel], active: panel});
  return settle({...next, view: reveal(next.view, slot)});
}

function swapWithCentre(l: Layout, panel: string): Layout {
  const from = slotOf(l, panel);
  if (from === null) return moveTo(l, panel, "centre");
  if (from === "centre") return activate(l, panel);
  const c = l.slots.centre, s = l.slots[from], other = c.active;
  if (other === null) return moveTo(l, panel, "centre");
  const sp = s.panels.map(p => (p === panel ? other : p)), cp = c.panels.map(p => (p === other ? panel : p));
  const next = withSlot(withSlot(l, from, {panels: sp, active: s.active === panel ? other : s.active}), "centre", {panels: cp, active: panel});
  return settle(next);
}

/** The focus slot (for `open` without a slot): where the last-focused panel lives, else centre. */
const focusedSlot = (l: Layout): SlotId => (l.focus.last ? slotOf(l, l.focus.last) : null) ?? "centre";

export function reduce(l: Layout, a: LayoutAction): Layout {
  switch (a.type) {
    case "swapWithCentre": return swapWithCentre(l, a.panel);
    case "moveTo": return SLOTS.includes(a.slot) ? moveTo(l, a.panel, a.slot) : l;
    case "open": {
      const at = slotOf(l, a.panel);
      if (at === null) return moveTo(l, a.panel, a.slot ?? focusedSlot(l));
      if (a.slot && a.slot !== at) return moveTo(l, a.panel, a.slot);
      // W-11 MED-1: opening a panel that sits in a hidden slot shows that slot, like moveTo does; otherwise the open is silent.
      const n = activate(l, a.panel), v = reveal(n.view, at);
      return v === n.view ? n : {...n, view: v};
    }
    case "close": {
      const at = slotOf(l, a.panel);
      if (at === null || a.panel === TERMINAL_ID) return l; // the terminal is moved, never closed
      return settle(withSlot(l, at, without(l.slots[at], a.panel)));
    }
    case "activate": return activate(l, a.panel);
    case "setView": {
      const view = sanitizeView({...l.view, ...a.patch}, l.view);
      return JSON.stringify(view) === JSON.stringify(l.view) ? l : {...l, view};
    }
    case "zoom": {
      const z = a.dir === "reset" ? 1 : clampZoom(l.view.zoom + (a.dir === "in" ? ZOOM_STEP : -ZOOM_STEP));
      return z === l.view.zoom ? l : {...l, view: {...l.view, zoom: z}};
    }
    case "focus": {
      const slot = slotOf(l, a.panel);
      if (slot === null) return l;
      const space = a.space ?? null, f = l.focus;
      const spaceSame = space === null || f.bySpace[space] === a.panel;
      if (f.bySlot[slot] === a.panel && f.last === a.panel && spaceSame) return l;
      const bySpace = space === null || spaceSame ? f.bySpace : capSpaces({...f.bySpace, [space]: a.panel});
      return {...l, focus: {bySlot: {...f.bySlot, [slot]: a.panel}, bySpace, last: a.panel}};
    }
    case "reset": return DEFAULT_LAYOUT;
    default: return l;
  }
}

function capSpaces(m: Record<string, string>): Record<string, string> {
  const keys = Object.keys(m);
  if (keys.length <= MAX_SPACES) return m;
  return Object.fromEntries(keys.slice(keys.length - MAX_SPACES).map(k => [k, m[k]]));
}

/** Which panel should take keyboard focus: the slot's remembered panel (if still there) else its active one; for a Herdr
 * space the panel last focused while that space was current (null = no memory, the caller keeps its own default). */
export function focusTarget(l: Layout, target: {slot: SlotId} | {space: string}): string | null {
  if ("slot" in target) {
    const s = l.slots[target.slot], m = l.focus.bySlot[target.slot];
    return m && s.panels.includes(m) ? m : s.active;
  }
  const m = l.focus.bySpace[target.space];
  return m && slotOf(l, m) !== null ? m : null;
}

// ---- untrusted input -------------------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const oneOf = <T extends string>(v: unknown, set: readonly T[], d: T): T => (typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : d);

/** A stored theme is only ever a real preset or "custom" WITH a valid saved setting: anything else falls back (unknown name -> Dark,
 * "custom" with no usable setting -> Dark), so a stale or hand-edited layout can never name a theme that has no CSS. */
function sanitizeTheme(r: Record<string, unknown>, base: ViewOptions): Pick<ViewOptions, "theme" | "customTheme"> {
  const customTheme = "customTheme" in r ? parseCustomTheme(r.customTheme) : base.customTheme;
  const raw = "theme" in r ? r.theme : base.theme;
  return { customTheme, theme: raw === CUSTOM_THEME ? (customTheme ? CUSTOM_THEME : DEFAULT_THEME) : resolveTheme(raw) };
}

export function sanitizeView(raw: unknown, base: ViewOptions = DEFAULT_VIEW): ViewOptions {
  const r = isObj(raw) ? raw : {};
  return {
    primarySideBar: bool(r.primarySideBar, base.primarySideBar), secondarySideBar: bool(r.secondarySideBar, base.secondarySideBar),
    statusBar: bool(r.statusBar, base.statusBar), bottomPanel: bool(r.bottomPanel, base.bottomPanel), primaryRight: bool(r.primaryRight, base.primaryRight),
    activityBar: oneOf(r.activityBar, ["side", "top", "hidden"], base.activityBar), panelPosition: oneOf(r.panelPosition, ["bottom", "left", "right"], base.panelPosition),
    panelAlign: oneOf(r.panelAlign, ["centre", "justify"], base.panelAlign), tabBar: oneOf(r.tabBar, ["pills", "single", "hidden"], base.tabBar),
    zen: bool(r.zen, base.zen), zoom: typeof r.zoom === "number" ? clampZoom(r.zoom) : base.zoom,
    ...sanitizeTheme(r, base), bottomSeeded: bool(r.bottomSeeded, false),
  };
}

/** A layout saved before the Work tree moved to the bottom strip has no `bottomSeeded` flag: put the tree there ONCE (and show the strip),
 * then mark it seeded so a user who later closes it is not given it back on every reload. A tree already placed somewhere stays put. */
function seedWorkTree(l: Layout, registered: boolean): Layout {
  if (l.view.bottomSeeded || !registered) return {...l, view: {...l.view, bottomSeeded: true}};
  const view = {...l.view, bottomSeeded: true, bottomPanel: true};
  if (slotOf(l, WORK_TREE_ID) !== null) return {...l, view: {...l.view, bottomSeeded: true}};
  const b = l.slots.bottom;
  return {...l, view, slots: {...l.slots, bottom: {panels: [WORK_TREE_ID, ...b.panels], active: b.active ?? WORK_TREE_ID}}};
}

/** Make ANY value a valid Layout for this registry: unknown/duplicate panels dropped, actives repaired, terminal in the
 * centre if absent, centre never empty, view/focus sanitised. Non-objects and wrong versions give the default. */
export function normalize(raw: unknown, registry: readonly PanelDef[]): Layout {
  const known = new Set(registry.map(p => p.id));
  const src: Record<string, unknown> = isObj(raw) && raw.version === 1 && isObj(raw.slots) ? raw : (DEFAULT_LAYOUT as unknown as Record<string, unknown>);
  const rs = src.slots as Record<string, unknown>, seen = new Set<string>();
  const slots = {} as Record<SlotId, SlotState>;
  for (const slot of SLOTS) {
    const e = isObj(rs[slot]) ? (rs[slot] as Record<string, unknown>) : {};
    const panels: string[] = [];
    if (Array.isArray(e.panels)) for (const p of e.panels) {
      if (panels.length >= MAX_PER_SLOT) break;
      if (typeof p === "string" && p.length <= MAX_ID && (known.has(p) || p === TERMINAL_ID) && !seen.has(p)) { seen.add(p); panels.push(p); }
    }
    slots[slot] = {panels, active: typeof e.active === "string" && panels.includes(e.active) ? e.active : (panels[0] ?? null)};
  }
  const f = isObj(src.focus) ? (src.focus as Record<string, unknown>) : {};
  const open = (p: unknown): p is string => typeof p === "string" && seen.has(p);
  const bySlot: Partial<Record<SlotId, string>> = {};
  if (isObj(f.bySlot)) for (const slot of SLOTS) { const p = (f.bySlot as Record<string, unknown>)[slot]; if (open(p)) bySlot[slot] = p; }
  const bySpace: Record<string, string> = {};
  if (isObj(f.bySpace)) for (const [k, p] of Object.entries(f.bySpace).slice(0, MAX_SPACES)) if (k.length <= 128 && open(p)) bySpace[k] = p;
  const layout: Layout = {version: 1, slots, view: sanitizeView(src.view), focus: {bySlot, bySpace, last: open(f.last) ? f.last : null}};
  return settle(seedWorkTree(layout, known.has(WORK_TREE_ID)));
}
