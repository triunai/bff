// Pure logic behind components/ui/menu-select.tsx, kept free of the DOM so node:test can pin it.

export type MenuOption = { value: string; label: string; hint?: string; disabled?: boolean };

/** Next enabled index from `from` stepping by `dir` (+1/-1), wrapping; -1 when nothing is enabled. */
export function stepActive(options: readonly MenuOption[], from: number, dir: 1 | -1): number {
  const n = options.length;
  if (!n) return -1;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (!options[i].disabled) return i;
  }
  return -1;
}

/** First/last enabled index (Home/End). */
export const edgeActive = (options: readonly MenuOption[], end: boolean): number =>
  end ? stepActive(options, 0, -1) : options[0]?.disabled ? stepActive(options, 0, 1) : options.length ? 0 : -1;

/** Type-ahead: the next enabled option whose label starts with `buffer`, searching after `from` and wrapping.
 *  A buffer of one repeated letter ("bb") cycles through that letter's options like a native select. */
export function typeahead(options: readonly MenuOption[], buffer: string, from: number): number {
  const q = buffer.toLowerCase();
  if (!q) return -1;
  const same = q.length > 1 && [...q].every(c => c === q[0]), needle = same ? q[0] : q, start = same || q.length === 1 ? from : from - 1;
  const n = options.length;
  for (let k = 1; k <= n; k++) {
    const i = (((start + k) % n) + n) % n;
    if (!options[i].disabled && options[i].label.toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

export type Rect = { left: number; top: number; right: number; bottom: number; width: number };
export type Placement = { left: number; top: number; minWidth: number; maxHeight: number; flipped: boolean };

/** Where the menu goes: under the trigger, flipped above it when the space below is too small and above is larger,
 *  clamped inside the viewport on every side. `menuHeight` is the natural content height, `menuWidth` its natural width. */
export function placeMenu(trigger: Rect, view: { width: number; height: number }, menuWidth: number, menuHeight: number, gap = 4, edge = 8): Placement {
  const below = view.height - trigger.bottom - gap - edge, above = trigger.top - gap - edge;
  const flipped = menuHeight > below && above > below;
  const maxHeight = Math.max(80, Math.floor(flipped ? above : below));
  const h = Math.min(menuHeight, maxHeight);
  const top = flipped ? trigger.top - gap - h : trigger.bottom + gap;
  const w = Math.max(menuWidth, trigger.width);
  const left = Math.max(edge, Math.min(trigger.left, view.width - w - edge));
  return { left, top: Math.max(edge, top), minWidth: trigger.width, maxHeight, flipped };
}
