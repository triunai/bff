// Where an instant tooltip goes: under its anchor, flipped above when it would run off the bottom, clamped into the viewport
// horizontally. Pure (rects in, a point out) so the flip rule is testable without a browser.
export type TipBox = { left: number; top: number; right: number; bottom: number };
export const TIP_GAP = 6, TIP_MARGIN = 8;
export function placeTip(anchor: TipBox, size: { w: number; h: number }, vp: { w: number; h: number }): { x: number; y: number; flipped: boolean } {
  const below = anchor.bottom + TIP_GAP, flipped = below + size.h > vp.h - TIP_MARGIN && anchor.top - TIP_GAP - size.h >= TIP_MARGIN;
  const y = flipped ? anchor.top - TIP_GAP - size.h : Math.max(TIP_MARGIN, Math.min(below, vp.h - TIP_MARGIN - size.h));
  const x = Math.max(TIP_MARGIN, Math.min(anchor.left + (anchor.right - anchor.left) / 2 - size.w / 2, vp.w - TIP_MARGIN - size.w));
  return { x, y, flipped };
}
