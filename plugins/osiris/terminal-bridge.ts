// Bridge between the centre terminal (the ONLY owner of terminal discovery and attach) and other surfaces such as the
// left sidebar. Others get a read-only snapshot and may ask to attach an EXISTING terminal by id — nothing else ever
// reaches the terminals API through this module (no create, close, restart or rename).
import {useSyncExternalStore} from "react";
import type {ProviderId} from "./work/providers/registry.ts";

export type BridgedAgent = "herdr" | ProviderId | null;
export type BridgedTerminal = { id: string; title: string; status: string; initialCwd: string; agent: BridgedAgent };
/** terminals null = not discovered yet (the centre terminal has not mounted); [] = discovered, none found. */
export type BridgeState = { terminals: BridgedTerminal[] | null; attachedId: string | null;
  /** Red, loud: set while the herdr-session seam guard fails (the Terminal shows a different Herdr session than the user's). Null = ok or not applicable. */
  guardCrit: string | null };

const initial: BridgeState = { terminals: null, attachedId: null, guardCrit: null };
let state: BridgeState = initial;
const subscribers = new Set<() => void>();
let attachHandler: ((id: string) => void) | null = null;
let pendingAttach: string | null = null;
let focusHandler: (() => boolean) | null = null;
let redrawHandler: (() => void) | null = null;

export const terminalBridge = {
  get: (): BridgeState => state,
  publish(next: Partial<BridgeState>): void { state = { ...state, ...next }; subscribers.forEach(f => f()); },
  subscribe(f: () => void): () => void { subscribers.add(f); return () => { subscribers.delete(f); }; },
  /** Ask the centre terminal to attach an existing terminal. Queued (latest wins) until the centre terminal registers. */
  requestAttach(id: string): void { if (attachHandler) attachHandler(id); else pendingAttach = id; },
  registerAttach(handler: (id: string) => void): () => void {
    attachHandler = handler;
    if (pendingAttach !== null) { const id = pendingAttach; pendingAttach = null; handler(id); }
    return () => { if (attachHandler === handler) attachHandler = null; };
  },
  /** Put keyboard focus in xterm (shell focus memory). False when no terminal is registered or it is not on screen. */
  focus(): boolean { return focusHandler ? focusHandler() : false; },
  registerFocus(handler: () => boolean): () => void { focusHandler = handler; return () => { if (focusHandler === handler) focusHandler = null; }; },
  /** Nudge the PTY so the TUI repaints (the terminal's own Redraw). No-op when none is registered. */
  redraw(): void { redrawHandler?.(); },
  registerRedraw(handler: () => void): () => void { redrawHandler = handler; return () => { if (redrawHandler === handler) redrawHandler = null; }; },
  /** Test-only reset. */
  reset(): void { state = initial; attachHandler = null; pendingAttach = null; focusHandler = null; redrawHandler = null; subscribers.clear(); },
};

export const useTerminalBridge = (): BridgeState => useSyncExternalStore(terminalBridge.subscribe, terminalBridge.get, terminalBridge.get);
