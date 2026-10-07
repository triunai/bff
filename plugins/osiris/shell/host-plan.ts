// Pure planning for the panel host (components/shell/panel-host.tsx): which host element goes in which slot, which
// keepMounted panels are parked off-screen but alive, and which panels are unmounted. Kept free of React so it is pinned
// by node tests. The host id of a panel NEVER depends on where it is: that stability is what lets a move re-parent a DOM
// node instead of remounting a component (the terminal's xterm + BB attach survive every move).
import {SLOTS, type Layout, type PanelDef, type SlotId} from "./layout-types.ts";
import {slotOf, slotVisible} from "./layout-model.ts";

export type HostPlan = {
  hostIds: Record<string, string>;            // panel id -> stable host element id (all registry panels)
  placed: Partial<Record<SlotId, string>>;     // slot -> the panel whose host sits in that slot's body
  parked: string[];                            // keepMounted, open, not placed: host lives in the hidden holder, content mounted
  unmount: string[];                           // everything else: content not rendered, no live DOM held
};

export const hostIdFor = (panel: string): string => `oi-host-${panel}`;

/** `hidden`: slots the shell is not drawing right now even though the layout says visible (e.g. a collapsed pane ratio). */
export function planHosts(layout: Layout, registry: readonly PanelDef[], hidden: readonly SlotId[] = []): HostPlan {
  const ids = new Set(registry.map(p => p.id));
  const hostIds: Record<string, string> = {};
  for (const p of registry) hostIds[p.id] = hostIdFor(p.id);
  const placed: Partial<Record<SlotId, string>> = {};
  for (const slot of SLOTS) {
    const a = layout.slots[slot].active;
    if (a && ids.has(a) && slotVisible(layout, slot) && !hidden.includes(slot)) placed[slot] = a;
  }
  const placedSet = new Set(Object.values(placed));
  const parked: string[] = [], unmount: string[] = [];
  for (const p of registry) {
    if (placedSet.has(p.id)) continue;
    if (p.keepMounted && slotOf(layout, p.id) !== null) parked.push(p.id); else unmount.push(p.id);
  }
  return {hostIds, placed, parked, unmount};
}

export type FrameMode = "none" | "row" | "inline";
/** How a panel's controls are drawn. "inline": the panel's own toolbar hosts them (zero extra rows - the terminal). "row":
 * one 24px header line above the panel. "none": View > Tab Bar is hidden and the panel has no toolbar of its own. */
export function frameMode(layout: Layout, def: PanelDef): FrameMode {
  if (def.inlineChrome) return "inline";
  return layout.view.tabBar === "hidden" ? "none" : "row";
}

/** The few DOM members the reconciler touches (a real HTMLElement satisfies it; tests use a tiny fake tree). */
export interface DomLike { parentElement: DomLike | null; children: ArrayLike<DomLike>; appendChild(child: never): unknown; remove(): void }

/** Apply a plan to the DOM: each placed host into its slot body, parked hosts into the holder, the rest detached. Hosts are
 * the SAME objects every time (never recreated), and only a host whose parent actually differs is touched, so a re-append
 * never blurs a focused element for nothing. A slot body keeps only its own placed host. Returns true if anything moved. */
export function reconcileHosts(plan: HostPlan, hosts: ReadonlyMap<string, DomLike>, slotEls: ReadonlyMap<SlotId, DomLike>, holder: DomLike | null): boolean {
  let moved = false;
  const want = new Map<string, DomLike>();
  for (const [slot, panel] of Object.entries(plan.placed)) { const el = slotEls.get(slot as SlotId); if (el && panel) want.set(panel, el); }
  for (const [id, h] of hosts) {
    const target = want.get(id) ?? (plan.parked.includes(id) ? holder : null);
    if (target) { if (h.parentElement !== target) { target.appendChild(h as never); moved = true; } }
    else if (h.parentElement) { h.remove(); moved = true; }
  }
  for (const [slot, el] of slotEls) {
    const placed = plan.placed[slot], keep = placed ? hosts.get(placed) : undefined;
    for (const c of Array.from(el.children)) if (c !== keep) { c.remove(); moved = true; }
  }
  return moved;
}
