// Geometry of the bottom strip (owner td-osi.1): the full-width bottom slot that always holds the Work tree and, when picked, the
// Factory. Pure: app.tsx measures the shell and renders what this says. Heights are px; null stored = "never dragged" = the default.
export const BOTTOM_KEY = "osiris-bottom-h.v2"; // v2: the old osiris-bottom-h was written on every mount (always 240), so it could never mean "never dragged"
export const BOTTOM_DEFAULT_FRAC = 0.4;  // default height: about 40% of the shell
export const BOTTOM_MAX_FRAC = 0.7;      // the drag handle cannot take more than this (use Maximise for all of it)
export const BOTTOM_COLLAPSE_PX = 160;   // below this the strip collapses to its tab row
export const BOTTOM_TAB_ROW_PX = 24;     // the PanelFrame row (components/shell/panel-frame.tsx)

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export const bottomDefault = (shellH: number): number => Math.max(BOTTOM_COLLAPSE_PX, Math.round((finite(shellH) ? shellH : 0) * BOTTOM_DEFAULT_FRAC));
export const bottomMaxPx = (shellH: number): number => Math.max(BOTTOM_COLLAPSE_PX, Math.round((finite(shellH) ? shellH : 0) * BOTTOM_MAX_FRAC));

/** A stored height from localStorage text: a finite, non-negative, sane number, else null (= use the default). Storage is untrusted. */
export function readBottomH(raw: string | null | undefined): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const v = Number(raw);
  return finite(v) && v >= 0 && v <= 20000 ? v : null;
}

export type BottomGeom =
  | { mode: "fill"; height: null }          // maximised: the strip takes the whole centre column
  | { mode: "collapsed"; height: null }     // under 160 px: only the tab row (height follows its content)
  | { mode: "fixed"; height: number };

export function bottomGeom(o: { stored: number | null; shellH: number; maximised: boolean }): BottomGeom {
  if (o.maximised) return { mode: "fill", height: null };
  const h = o.stored === null ? bottomDefault(o.shellH) : Math.min(o.stored, bottomMaxPx(o.shellH));
  return h < BOTTOM_COLLAPSE_PX ? { mode: "collapsed", height: null } : { mode: "fixed", height: h };
}

/** The height a drag (or an arrow key) lands on: `dy` px up is positive. Clamped to [0, max]; under 160 the geometry reads as collapsed. */
export const dragBottom = (startH: number, dy: number, shellH: number): number => Math.max(0, Math.min(startH + dy, bottomMaxPx(shellH)));

/** The height a drag STARTS from: what is on screen (a collapsed strip is just its tab row). */
export const visibleBottomH = (g: BottomGeom): number => (g.mode === "fixed" ? g.height : BOTTOM_TAB_ROW_PX);
