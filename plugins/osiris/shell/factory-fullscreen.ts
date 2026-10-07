// Factory full-screen mode (pure). A CSS overlay over the plugin viewport, NOT the Fullscreen API (the plugin runs in a host frame),
// and NOT persisted: full screen always starts off. The shell Layout is never written, so exit restores it exactly.
// Esc is deliberately not bound here: the shell closes the Key popover, then spotlight/follow, and only then calls exit().
import { CHORD_TIMEOUT_MS, isTyping } from "./keymap.ts";

/** Bare `Z` toggles. FACTORY_KEYS (factory-floor.tsx) owns Space, arrows, F, H, + - 0 and Escape; fg-lead adds I C K T; the shell KEYMAP has no bare letter. */
export const FS_CHORD = "z";

type Closest = { closest(sel: string): unknown } | null;
export type FsKeyEvent = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; repeat?: boolean; defaultPrevented?: boolean; target?: EventTarget | Closest };

// The overlay is itself a dialog (role=dialog); it must not count, or Z could never leave full screen. A dialog NESTED inside it still does.
const inDialog = (t: Closest) => !!t && typeof t.closest === "function" && !!t.closest("[role=dialog]:not(.oi-fsx),[aria-modal=true]:not(.oi-fsx)");

/** The shell's Mod+K chord state (app.tsx `chord.current` + Date.now()): Mod+K then Z is ZEN, so a Z inside that window is not ours. */
export type FsKeyCtx = { chordPendingAt?: number | null; now?: number };

/** Is a host Mod+K chord still pending? (app.tsx `chord.current` + Date.now()). While it is, a key belongs to the host, never to the Factory. */
export const chordPending = (at: number | null | undefined, now: number = Date.now()): boolean => typeof at === "number" && now - at <= CHORD_TIMEOUT_MS;

/** Does this keydown toggle full screen? Not from a modifier, a repeat, Shift+Z, a text field / terminal / chat composer, a dialog,
 * an event something already handled, or while a host Mod+K chord is pending (that Z belongs to zen). */
export function isFullscreenKey(e: FsKeyEvent, ctx?: FsKeyCtx): boolean {
  if (chordPending(ctx?.chordPendingAt, ctx?.now ?? Date.now())) return false;
  if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  const target = (e.target ?? null) as Closest; // a DOM EventTarget may lack closest(); both guards check for it
  if (isTyping(target) || inDialog(target)) return false;
  return e.key.toLowerCase() === FS_CHORD;
}

/** Tab inside the overlay: the index to focus next among `count` focusable elements, wrapping both ways; null when there is nothing to trap (let the browser act). `at` is the current index, -1 when focus is outside the list. */
export function trapTarget(count: number, at: number, back: boolean): number | null {
  if (!Number.isInteger(count) || count <= 0) return null;
  if (at < 0) return back ? count - 1 : 0;
  return back ? (at === 0 ? count - 1 : at - 1) : (at === count - 1 ? 0 : at + 1);
}

/** Selector for what Tab may land on inside the overlay. */
export const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Remembers what had focus when full screen opened and hands it back on exit. Takes ANY Element that can focus, not just
 * HTMLElement: Factory tokens are SVG <g tabIndex> nodes. `doc` is injected so the pure layer is testable without a DOM. */
export type FocusLike = { focus?: () => void; isConnected?: boolean };
export function createFocusKeeper(doc: { activeElement: unknown }) {
  let held: FocusLike | null = null;
  const canFocus = (x: unknown): x is FocusLike & { focus: () => void } => !!x && typeof (x as FocusLike).focus === "function";
  return {
    remember() { const a = doc.activeElement; held = canFocus(a) ? a : null; },
    restore(): boolean { const t = held; held = null; if (t && canFocus(t) && t.isConnected !== false) { t.focus(); return true; } return false; },
  };
}

/** Which layer ONE Escape closes, topmost first: the Key popover, the keyboard-pinned hover card, the spotlight, the follow, the detail
 * drawer (Calls full screen), and only then full screen; null when nothing is open (Esc then belongs to the host). `drawer` is optional:
 * the Factory has none, so its callers omit it and the order they pinned is unchanged. */
export type EscState = { keyOpen: boolean; hover: boolean; spot: boolean; follow: boolean; drawer?: boolean; full: boolean };
export const escLayer = (s: EscState): "key" | "hover" | "spot" | "follow" | "drawer" | "full" | null => (s.keyOpen ? "key" : s.hover ? "hover" : s.spot ? "spot" : s.follow ? "follow" : s.drawer ? "drawer" : s.full ? "full" : null);
