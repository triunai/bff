// The re-parenting mechanism. Every OPEN panel renders ONCE, through createPortal, into its own host <div> that is created
// once per panel id and kept in a ref Map. The portals sit at a FIXED position in the React tree (keyed by panel id, in
// registry order), so changing a panel's slot never remounts it: a layout effect only moves the host element. A slot is an
// empty <SlotBody>; the effect appends the slot's active panel's host into it. keepMounted panels (the terminal) that are
// not on screen are PARKED in a hidden off-screen holder, still mounted, so xterm and the BB terminal attach are never torn
// down. Other panels that are not on screen are unmounted (their state lives in the shell; holding every hidden view's DOM
// would cost memory for nothing - the old shell unmounted switched-away canvases too).
import {createContext, useCallback, useContext, useLayoutEffect, useRef, type ReactNode} from "react";
import {createPortal} from "react-dom";
import type {Layout, PanelDef, SlotId} from "../../shell/layout-types.ts";
import {ViewErrorBoundary, viewErrorStyles} from "./view-error-boundary.tsx";
import {planHosts, hostIdFor, reconcileHosts, type HostPlan} from "../../shell/host-plan.ts";

export {planHosts, hostIdFor} from "../../shell/host-plan.ts";

type SlotCtx = {register: (slot: SlotId, el: HTMLElement | null) => void};
const Ctx = createContext<SlotCtx | null>(null);

/** The empty container a slot's active host is appended into. React never renders children here. */
export function SlotBody({slot}: {slot: SlotId}) {
  const ctx = useContext(Ctx);
  const ref = useCallback((el: HTMLDivElement | null) => ctx?.register(slot, el), [ctx, slot]);
  return <div ref={ref} className="oi-slot-body" data-slot-body={slot}/>;
}

export type PanelHostHandle = {hostOf: (panel: string) => HTMLElement | null};

export function PanelHost({layout, registry, plan: given, content, children, handle}: {
  layout: Layout; registry: readonly PanelDef[]; plan?: HostPlan; content: (panel: string) => ReactNode; children: ReactNode;
  handle?: {current: PanelHostHandle | null};
}) {
  const hosts = useRef(new Map<string, HTMLDivElement>());
  const slotEls = useRef(new Map<SlotId, HTMLElement>());
  const holder = useRef<HTMLDivElement>(null);
  const ctx = useRef<SlotCtx>({register: (slot, el) => { if (el) slotEls.current.set(slot, el); else slotEls.current.delete(slot); }}).current;
  const hostFor = (id: string): HTMLDivElement => {
    let h = hosts.current.get(id);
    if (!h) { h = document.createElement("div"); h.id = hostIdFor(id); h.className = "oi-host"; h.dataset.panel = id; hosts.current.set(id, h); }
    return h;
  };
  if (handle) handle.current = {hostOf: id => hosts.current.get(id) ?? null};
  const plan = given ?? planHosts(layout, registry);
  const live = new Set([...Object.values(plan.placed), ...plan.parked]);

  // After every commit: put each placed host in its slot body, park the rest, drop the unmounted. Only hosts whose parent
  // actually changes are touched (a re-append would blur a focused element for nothing).
  useLayoutEffect(() => {
    // The terminal measures itself with a ResizeObserver (host size) and its `visible` effect; the window event also wakes
    // any other panel that listens for it.
    if (reconcileHosts(plan, hosts.current, slotEls.current, holder.current)) window.dispatchEvent(new Event("resize"));
  });

  return <Ctx.Provider value={ctx}>
    {children}
    {registry.filter(p => live.has(p.id)).map(p => createPortal(<ViewErrorBoundary title={p.title}>{content(p.id)}</ViewErrorBoundary>, hostFor(p.id), p.id))}
    <div ref={holder} className="oi-park" aria-hidden="true" inert/>
  </Ctx.Provider>;
}

export const panelHostStyles = viewErrorStyles + `
.oi-slot-body{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column;overflow:hidden}
.oi-host{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column}
.oi-park{position:fixed;left:-10000px;top:0;width:640px;height:480px;overflow:hidden;visibility:hidden;pointer-events:none}
.oi-park>.oi-host{height:100%}
`;
