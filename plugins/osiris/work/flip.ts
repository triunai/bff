// FLIP (First, Last, Invert, Play) planning for the Board: pure, no DOM. A card keyed by bead id that changes column or order slides from where
// it was to where it is; a card with no previous position fades in. Under prefers-reduced-motion NOTHING is planned, so nothing animates.
export const FLIP_MS = 200;
export type Pt = { x: number; y: number };
export type FlipStep = { id: string; kind: "move"; dx: number; dy: number } | { id: string; kind: "enter" };
/** `prev` = positions before the update, `next` = after. Moves under 1px are ignored. */
export function planFlip(prev: ReadonlyMap<string, Pt>, next: ReadonlyMap<string, Pt>, reduced: boolean): FlipStep[] {
  if (reduced) return [];
  const out: FlipStep[] = [];
  for (const [id, n] of next) {
    const p = prev.get(id);
    if (!p) { if (prev.size > 0) out.push({ id, kind: "enter" }); continue; } // the very first paint does not fade everything in
    const dx = p.x - n.x, dy = p.y - n.y;
    if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) out.push({ id, kind: "move", dx, dy });
  }
  return out;
}
export const prefersReducedMotion = (): boolean => { try { return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
