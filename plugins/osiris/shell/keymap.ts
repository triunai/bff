// Shell keymap (pure). Chords use the grammar of KeyChord in layout-types.ts: modifiers Mod / Alt / Shift joined with "+",
// the key last; a space separates the two steps of a chord ("Mod+K Z"). Mod = Cmd on macOS, Ctrl elsewhere; the matcher
// (like today's app.tsx handler) accepts either metaKey or ctrlKey so it never depends on platform sniffing.
import type { KeyBinding, KeyChord } from "./layout-types.ts";

/** Command ids. The shell maps these to LayoutActions (or to opening the search palette); view-items.ts uses the same ids. */
export const CMD = {
  search: "palette.search", primarySideBar: "view.primarySideBar", secondarySideBar: "view.secondarySideBar", bottomPanel: "view.bottomPanel",
  zen: "view.zen", zoomIn: "view.zoomIn", zoomOut: "view.zoomOut", zoomReset: "view.zoomReset", openView: "view.openView", secondarySideBarAlt: "view.secondarySideBar.alt", swapCentre: "view.swapWithCentre", shortcuts: "view.shortcuts", help: "view.help", navBack: "nav.back", navForward: "nav.forward",
} as const;

export const KEYMAP: KeyBinding[] = [
  { chord: "Mod+B", command: CMD.primarySideBar, label: "Toggle Primary Side Bar", when: "notTyping" },
  { chord: "Alt+Mod+B", command: CMD.secondarySideBar, label: "Toggle Secondary Side Bar", when: "notTyping" },
  // Non-colliding alternative to ⌥⌘B (BB / the browser may take it): ⌘K then B, same leader as Zen.
  { chord: "Mod+K B", command: CMD.secondarySideBarAlt, label: "Toggle Secondary Side Bar (alt)", when: "notTyping" },
  { chord: "Mod+J", command: CMD.bottomPanel, label: "Toggle Bottom Panel", when: "notTyping" },
  { chord: "Mod+K Z", command: CMD.zen, label: "Zen Mode", when: "notTyping" },
  { chord: "Mod+=", command: CMD.zoomIn, label: "Zoom In", when: "notTyping" },
  { chord: "Mod+-", command: CMD.zoomOut, label: "Zoom Out", when: "notTyping" },
  { chord: "Mod+0", command: CMD.zoomReset, label: "Reset Zoom", when: "notTyping" },
  { chord: "Alt+Mod+O", command: CMD.openView, label: "Open View…", when: "notTyping" },
  { chord: "Mod+\\", command: CMD.swapCentre, label: "Swap Focused Panel With Centre", when: "notTyping" },
  // Today's ⌘K: focus the search box. Kept as a binding so the palette and menu can show its chord; matched specially (see matchChord).
  { chord: "Mod+K", command: CMD.search, label: "Search", when: "notTyping" },
  // Breadcrumb history (the mockup's tooltips: Back ⌘[, Forward ⌘]).
  { chord: "Mod+[", command: CMD.navBack, label: "Back", when: "notTyping" },
  { chord: "Mod+]", command: CMD.navForward, label: "Forward", when: "notTyping" },
  // Typed as Shift+/ on most keyboards, so stepMatches tolerates Shift for it (like "=").
  { chord: "?", command: CMD.shortcuts, label: "Keyboard Shortcuts", when: "notTyping" },
];

/** The shortcut text for a command id, or undefined. */
export const chordFor = (command: string): KeyChord | undefined => KEYMAP.find(b => b.command === command)?.chord;

export const CHORD_TIMEOUT_MS = 1200;

type Closest = { closest(sel: string): unknown } | null;
const TYPING_SELECTOR = ".xterm,textarea,input,select,[contenteditable],[data-native-chat]";
// contenteditable="false" must not count: match only the truthy forms.
const typingAncestor = (target: Closest) => !!target && typeof target.closest === "function" && !!target.closest(TYPING_SELECTOR);

/** True when focus is somewhere keys belong to the user: the terminal (xterm's helper textarea lives inside `.xterm`), any
 * text field, a contenteditable, or the BB chat composer. Shell shortcuts never fire there. */
export function isTyping(target: Closest): boolean { return typingAncestor(target); }

/** TODAY's guard for ⌘K (app.tsx): textarea, contenteditable=true, BB chat. Deliberately NOT inputs or selects: ⌘K pressed
 * inside the search input re-focuses it today, and must keep doing so. xterm is covered because its helper is a textarea. */
export function isEditorLegacy(target: Closest): boolean {
  return !!target && typeof target.closest === "function" && !!target.closest("textarea,[contenteditable=true],[data-native-chat]");
}

export type KeyEventLike = { key: string; code?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; target?: Closest };
export type ChordState = { pendingAt: number | null; now: number };
export type ChordResult = { command: string | null; pendingChord: boolean; pendingAt: number | null; supersedes?: string };

const CODE_KEYS: Record<string, string> = { Equal: "=", Minus: "-", Backslash: "\\", Digit0: "0", BracketLeft: "[", BracketRight: "]" };
function keyToken(e: KeyEventLike): string {
  const c = e.code ?? "";
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase(); // Alt+B yields "∫" in e.key on macOS; code is stable
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  if (CODE_KEYS[c]) return CODE_KEYS[c];
  const k = e.key.toLowerCase();
  return k === "+" ? "=" : k; // Shift+= reports "+"; treat as the = key
}

type Parsed = { mod: boolean; alt: boolean; shift: boolean; key: string };
function parseStep(step: string): Parsed {
  const parts = step.split("+"); // "Mod+=" -> ["Mod","="]; "Mod+-" -> ["Mod","-"]; the final part is the key
  const key = parts[parts.length - 1].toLowerCase();
  const mods = parts.slice(0, -1);
  return { mod: mods.includes("Mod"), alt: mods.includes("Alt"), shift: mods.includes("Shift"), key };
}
const stepMatches = (p: Parsed, e: KeyEventLike) => p.mod === !!(e.metaKey || e.ctrlKey) && p.alt === !!e.altKey && (p.shift === !!e.shiftKey || ((p.key === "=" || p.key === "?") && !p.shift)) && p.key === keyToken(e); // "=" tolerates Shift: Cmd++ is Cmd+Shift+=

const NONE: ChordResult = { command: null, pendingChord: false, pendingAt: null };

/**
 * Resolve one keydown against KEYMAP.
 *
 * How ⌘K alone keeps today's behaviour: ⌘K is NOT delayed waiting for a possible Z. It fires the "palette.search"
 * command immediately, under today's own guard (isEditorLegacy, not isTyping), AND arms a chord window (pendingChord=true,
 * pendingAt=now). If Z follows within CHORD_TIMEOUT_MS the result is command "view.zen" with supersedes "palette.search" so
 * the caller can close the palette it just opened. Any other key after ⌘K (or Z after the window expired) is not consumed:
 * the result is {command:null}, the key flows on as ordinary input (e.g. typing into the search box), and nothing about the
 * plain-⌘K path changed. The Z step is accepted even though focus is by then in the search input (a typing target) because
 * it completes a chord this very keyboard sequence started; callers must preventDefault when command is non-null.
 */
export function matchChord(e: KeyEventLike, state: ChordState): ChordResult {
  const modOnly = !!(e.metaKey || e.ctrlKey);
  const armed = state.pendingAt !== null && state.now - state.pendingAt <= CHORD_TIMEOUT_MS;
  if (armed) {
    // The second step is a bare key (no modifiers): Z, not ⌘Z.
    const second = KEYMAP.find(b => { if (!b.chord.startsWith("Mod+K ")) return false; const p = parseStep(b.chord.slice(6)); return !modOnly && !e.altKey && !e.shiftKey && p.key === keyToken(e); });
    if (second) return { command: second.command, pendingChord: false, pendingAt: null, supersedes: CMD.search };
    // fall through: a non-chord key after ⌘K; evaluate it as a fresh press below (so ⌘K ⌘K or ⌘B still work).
  }
  if (e.key === "Shift" || e.key === "Control" || e.key === "Meta" || e.key === "Alt") return armed ? { command: null, pendingChord: true, pendingAt: state.pendingAt } : NONE;
  if (modOnly && !e.altKey && keyToken(e) === "k") { // Shift allowed: the base focused search on any modifiers (review W-2B L6)
    if (isEditorLegacy(e.target ?? null)) return NONE; // exactly today's guard
    return { command: CMD.search, pendingChord: true, pendingAt: state.now };
  }
  if (typingAncestor(e.target ?? null)) return NONE;
  for (const b of KEYMAP) {
    if (b.chord.includes(" ") || b.command === CMD.search) continue;
    if (stepMatches(parseStep(b.chord), e)) return { command: b.command, pendingChord: false, pendingAt: null };
  }
  return NONE;
}

const MAC_KEY: Record<string, string> = { Mod: "⌘", Alt: "⌥", Shift: "⇧" };
const KEY_LABEL: Record<string, string> = { "\\": "\\" };
function formatStep(step: string, isMac: boolean): string {
  const p = step.split("+");
  const key = p[p.length - 1];
  const mods = p.slice(0, -1);
  const k = KEY_LABEL[key] ?? key.toUpperCase();
  if (isMac) { const order = ["Ctrl", "Alt", "Shift", "Mod"]; return order.filter(m => mods.includes(m)).map(m => MAC_KEY[m] ?? "⌃").join("") + k; }
  const order = ["Mod", "Alt", "Shift"]; const names: Record<string, string> = { Mod: "Ctrl", Alt: "Alt", Shift: "Shift" };
  return [...order.filter(m => mods.includes(m)).map(m => names[m]), k].join("+");
}
/** "Mod+B" -> "⌘B"; "Alt+Mod+B" -> "⌥⌘B"; "Mod+K Z" -> "⌘K Z"; non-mac: "Ctrl+B", "Ctrl+Alt+B", "Ctrl+K Z". */
export function formatChord(chord: KeyChord, isMac: boolean): string { return chord.split(" ").map(s => formatStep(s, isMac)).join(" "); }
