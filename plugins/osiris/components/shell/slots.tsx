// Client side of the layout: state (reduce), per-user persistence (localStorage cache for the first paint, then bb.storage.kv
// through the layoutGet/layoutSet RPCs, debounced), and the ShellApi the View menu / keymap drive.
import {useCallback, useEffect, useRef, useState} from "react";
import type {Layout, LayoutAction, PanelDef} from "../../shell/layout-types.ts";
import {DEFAULT_LAYOUT, normalize, reduce} from "../../shell/layout-model.ts";
import {LAYOUT_LS_KEY, decodeLayout, encodeLayout, loadedLayout, saveKey, shouldSave} from "../../shell/layout-persist.ts";
import {terminalBridge} from "../../terminal-bridge.ts";

export type LayoutRpc = {call: (name: string, input: unknown) => Promise<unknown>};
/** What the shell exposes (the leader wires the View menu, palette and keymap to this). */
export type ShellApi = {layout: Layout; dispatch: (a: LayoutAction) => void; reset: () => void; redraw: () => void};

export const SAVE_DEBOUNCE_MS = 800;

const readLocal = (registry: readonly PanelDef[]): Layout => {
  try { return decodeLayout(localStorage.getItem(LAYOUT_LS_KEY), registry) ?? normalize(DEFAULT_LAYOUT, registry); } catch { return normalize(DEFAULT_LAYOUT, registry); }
};

export function useLayoutState(rpc: LayoutRpc, registry: readonly PanelDef[], enabled: boolean): ShellApi {
  const [layout, setLayout] = useState<Layout>(() => (enabled ? loadedLayout(readLocal(registry)) : normalize(DEFAULT_LAYOUT, registry)));
  const dirty = useRef(false), latest = useRef(layout), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  latest.current = layout;
  // Only a real layout change marks it dirty. Focus memory changes on every click and is excluded (shouldSave), so a focus event before
  // the server answers can no longer make the local copy win over the server copy (review W-2B M4).
  const dispatch = useCallback((a: LayoutAction) => setLayout(cur => { const next = reduce(cur, a); if (shouldSave(cur, next)) dirty.current = true; return next; }), []);

  // The server copy wins on first load unless the user already changed something here (then local is pushed instead).
  useEffect(() => {
    if (!enabled) return;
    let off = false;
    rpc.call("layoutGet", {}).then(r => {
      if (off) return;
      const res = r as {ok?: boolean; layout?: unknown} | null;
      if (res?.ok && res.layout && !dirty.current) { const l = loadedLayout(normalize(res.layout, registry)); setLayout(l); const t = encodeLayout(l); if (t) try { localStorage.setItem(LAYOUT_LS_KEY, t); } catch {} }
    }, () => {});
    return () => { off = true; };
  }, [enabled, rpc, registry]);

  // Debounced write, keyed on the layout WITHOUT focus memory so a click never reschedules or cancels a pending save.
  const key = saveKey(layout);
  useEffect(() => {
    if (!enabled || !dirty.current) return;
    const text = encodeLayout(latest.current);
    if (text === null) return;
    try { localStorage.setItem(LAYOUT_LS_KEY, text); } catch {}
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; rpc.call("layoutSet", {layout: latest.current}).catch(() => {}); }, SAVE_DEBOUNCE_MS);
  }, [key, enabled, rpc]);

  // A pending save is sent now when the panel unmounts or the page is closing (best effort: the local copy is already written).
  const flush = useRef(() => {});
  flush.current = () => { if (timer.current === null) return; clearTimeout(timer.current); timer.current = null; rpc.call("layoutSet", {layout: latest.current}).catch(() => {}); };
  useEffect(() => {
    const onUnload = () => flush.current();
    window.addEventListener("beforeunload", onUnload);
    return () => { window.removeEventListener("beforeunload", onUnload); flush.current(); };
  }, []);

  const reset = useCallback(() => dispatch({type: "reset"}), [dispatch]);
  const redraw = useCallback(() => { window.dispatchEvent(new Event("resize")); terminalBridge.redraw(); }, []);
  return {layout, dispatch, reset, redraw};
}
