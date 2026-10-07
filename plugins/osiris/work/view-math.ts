// Pointer maths for an SVG drawn with the default preserveAspectRatio (xMidYMid meet). Pure. The component prefers
// getScreenCTM().inverse() (it also honours any CSS transform); this is the same conversion for a host without it, and the thing a test can run.
export type Rect = { left: number; top: number; width: number; height: number };
export type ViewBox = { x: number; y: number; w: number; h: number };

/** Pixels per viewBox unit: `meet` scales by the smaller ratio, so the other axis is letterboxed. */
export const viewScale = (r: Pick<Rect, "width" | "height">, vb: ViewBox): number => (r.width > 0 && r.height > 0 && vb.w > 0 && vb.h > 0 ? Math.min(r.width / vb.w, r.height / vb.h) : 0);

/** The viewBox point under a client point (the letterbox offset on the short axis, then the viewBox origin). */
export function viewPoint(r: Rect, vb: ViewBox, cx: number, cy: number): { x: number; y: number } {
  const s = viewScale(r, vb); if (!s) return { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 };
  return { x: vb.x + (cx - r.left - (r.width - vb.w * s) / 2) / s, y: vb.y + (cy - r.top - (r.height - vb.h * s) / 2) / s };
}
