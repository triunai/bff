// Navigation history for the centre pane (pure). A location is where the user is: a view, an optional sub-view, an optional item.
// The host derives the current location from its own state and pushes it; back/forward move the cursor and the host re-applies it.
export type ViewId = "home" | "terminal" | "work" | "calls" | "history" | "calendar" | "health" | "archive";
export type Loc = { view: ViewId; sub?: string; item?: string };
export type NavHistory = { stack: readonly Loc[]; index: number };

export const NAV_CAP = 50;
export const navEmpty = (): NavHistory => ({ stack: [], index: -1 });
export const sameLoc = (a: Loc | undefined, b: Loc | undefined): boolean => !!a && !!b && a.view === b.view && a.sub === b.sub && a.item === b.item;
export const navCurrent = (h: NavHistory): Loc | undefined => h.stack[h.index];

/** Push a location: a duplicate of the current entry is a no-op (same object back); a push after going back drops the forward entries; the oldest fall off at NAV_CAP. */
export function navPush(h: NavHistory, loc: Loc, cap = NAV_CAP): NavHistory {
  if (sameLoc(navCurrent(h), loc)) return h;
  const stack = [...h.stack.slice(0, h.index + 1), loc].slice(-cap);
  return { stack, index: stack.length - 1 };
}
export const canBack = (h: NavHistory): boolean => h.index > 0;
export const canForward = (h: NavHistory): boolean => h.index >= 0 && h.index < h.stack.length - 1;
export const navBack = (h: NavHistory): NavHistory => (canBack(h) ? { ...h, index: h.index - 1 } : h);
export const navForward = (h: NavHistory): NavHistory => (canForward(h) ? { ...h, index: h.index + 1 } : h);
