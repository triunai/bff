// Shell layout contract (owner 19:13-19:24, td-osi.1 addenda 1-5). Every surface is a PANEL; the terminal is just one of
// them. Four slots: left, centre, right and an optional bottom. Any panel may sit in any slot. The layout is pure data
// (this file + shell/layout-model.ts); the shell renders it. Persisted per user (bb.storage.kv via RPC, localStorage cache).

import type { CustomTheme } from "../theme/derive-theme.ts";
import type { ThemeName } from "../theme/tokens.ts";

export type SlotId = "left" | "centre" | "right" | "bottom";
export const SLOTS: readonly SlotId[] = ["left", "centre", "right", "bottom"];

/** A registered surface. `minWidth` in px. `keepMounted`: never unmounted while open (the terminal: its xterm + BB attach
 * live in a stable host element that is RE-PARENTED between slots, never torn down). */
export type PanelDef = { id: string; title: string; minWidth: number; keepMounted?: boolean; /** ADDED (WF1, optional): the panel renders the frame controls itself, inside its own toolbar (zero extra rows). */ inlineChrome?: boolean; group: "core" | "sidebar" | "inspector" | "work" | "spine" };

/** A slot holds an ordered stack of panel ids (shown as pill tabs when >1, per View ▸ Tab Bar) and the active one. */
export type SlotState = { panels: string[]; active: string | null };

export type ActivityBarPosition = "side" | "top" | "hidden";
export type PanelPosition = "bottom" | "left" | "right"; // where the BOTTOM slot docks
export type PanelAlign = "centre" | "justify";
export type TabBarMode = "pills" | "single" | "hidden";

export type ViewOptions = {
  primarySideBar: boolean; // the slot that holds the primary sidebar (left unless primaryRight)
  secondarySideBar: boolean; // the other side slot
  statusBar: boolean;
  bottomPanel: boolean;
  primaryRight: boolean; // "Move Primary Side Bar Right": mirrors left/right
  activityBar: ActivityBarPosition;
  panelPosition: PanelPosition;
  panelAlign: PanelAlign;
  tabBar: TabBarMode;
  zen: boolean; // centre panel only; Esc exits
  zoom: number; // UI scale for Osiris only, 0.7..1.6, step 0.1, default 1
  theme: ThemeName | "custom"; // View > Theme (ui-v2 W2). "custom" only ever with a valid customTheme (sanitizeView enforces it)
  customTheme: CustomTheme | null; // the colour picker's saved accent + base; kept while a preset is shown so Custom can come back
  bottomSeeded: boolean; // the Work tree has been placed in the bottom strip once (owner td-osi.1): migrates layouts saved before it existed, then lets a user who closes it keep it closed
};

export type Layout = {
  version: 1;
  slots: Record<SlotId, SlotState>;
  view: ViewOptions;
  /** Focus memory (owner 19:17): last-focused panel per slot, and per Herdr space (workspace id) the last-focused panel. */
  focus: { bySlot: Partial<Record<SlotId, string>>; bySpace: Record<string, string>; last: string | null };
};

/** Every action the reducer accepts. Pure; the shell dispatches these from headers, the View menu and the keymap. */
export type LayoutAction =
  | { type: "swapWithCentre"; panel: string }
  | { type: "moveTo"; panel: string; slot: SlotId }
  | { type: "open"; panel: string; slot?: SlotId } // Open View…: into the given slot, else the focused slot, else centre
  | { type: "close"; panel: string }
  | { type: "activate"; panel: string }
  | { type: "setView"; patch: Partial<ViewOptions> }
  | { type: "zoom"; dir: "in" | "out" | "reset" }
  | { type: "focus"; panel: string; space?: string | null }
  | { type: "reset" };

/** Keymap: each binding names its chord and the action id it fires. `when: "notTyping"` = never while focus is inside the
 * terminal (xterm) or a text input / the BB chat composer (the "not in terminal" guard, pinned). */
export type KeyChord = string; // e.g. "Mod+B", "Alt+Mod+B", "Mod+J", "Mod+K Z", "Mod+=", "Mod+-", "Mod+0", "Shift+Mod+P", "Mod+\\"
export type KeyBinding = { chord: KeyChord; command: string; label: string; when: "notTyping" };
