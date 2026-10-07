// The chrome the two Osiris text apps (and the Fleet | Worktrees panel embedded in the Factory) share, so they read as ONE app family: the colour
// roles, the selection highlight, the inverse header row, the status row and the bold-key/dim-label key row, and the `─ TITLE ●` panel rule.
// Each app keeps its own body (Factory stations/fleet, the Arkham worktree list + detail); nothing here knows about either. PURE.
import { cat, clipLine, lineLen, padLine, S, withStyle, type Key, type Line, type Style } from "./term.ts";

/** Colour roles (xterm-256) of the design mockup: muted, cyan (live), yellow (needs attention), green (ok), red (blocked), magenta, orange, blue. */
export const C = { cy: 51, ye: 227, gr: 48, rd: 203, mu: 103, mg: 207, or: 215, bl: 75, txt: 189, ink: 233 } as const;
export const SEL_BG = 53;
export const mu: Style = { c: C.mu };

/** The selected-row highlight: the row padded to `w` with the selection background. */
export const selectRow = (l: Line, w: number): Line => withStyle(padLine(l, w), { bg: SEL_BG });
/** The inverse header row: `left` at the start, the first of `rights` that fits right-aligned (every cell inverse, so it is a solid bar). */
export function headerLine(left: Line, rights: readonly string[], cols: number): Line {
  const ln = lineLen(left), right = rights.find(r => ln + 2 + r.length + 1 <= cols);
  const out = right === undefined ? clipLine(left, cols) : cat(padLine(left, cols - right.length - 1), [S(`${right} `, { inv: true })]);
  return padLine(out, cols).map(s => (s.s?.inv ? s : S(s.t, { inv: true })));
}
/** The status row: muted text clipped to the width. */
export const statusLine = (text: string, cols: number): Line => clipLine([S(text, mu)], cols);
/** `─ TITLE ● ───`: a full-width rule with its title; the dot marks the focused panel. */
export const panelRule = (title: string, w: number, on: boolean): Line => [S(`─ ${title}${on ? " ●" : ""} `.padEnd(w, "─"), on ? { c: C.cy } : mu)];

export type KeyItem = { k: string; label: string; key: Key | null };
/** The key row(s): the key bold, its label dim, items three spaces apart; an item with a `key` is clickable and acts as that key. `wrap` flows onto more
 * rows instead of clipping. `hits` carry the row index in `y` and the x-range of each clickable item. */
export function keyRows(items: readonly KeyItem[], cols: number, wrap = false): { rows: Line[]; hits: { y: number; x0: number; x1: number; key: Key }[] } {
  const rows: Line[] = [], hits: { y: number; x0: number; x1: number; key: Key }[] = []; let cur: Line = [], x = 0;
  for (const it of items) {
    const w = it.k.length + 1 + it.label.length;
    if (wrap && x && x + 3 + w > cols) { rows.push(clipLine(cur, cols)); cur = []; x = 0; }
    if (x) { cur.push(S("   ")); x += 3; }
    if (it.key) hits.push({ y: rows.length, x0: x, x1: x + w, key: it.key });
    cur.push(S(it.k, { b: true }), S(` ${it.label}`, { dim: true })); x += w;
  }
  rows.push(clipLine(cur, cols));
  return { rows, hits };
}
