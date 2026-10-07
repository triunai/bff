// The Calendar's Lite | Full toggle. Lite (the approved mockup's day summary) is the default; the choice is remembered per browser.
export const CAL_MODES = ["lite", "full"] as const;
export type CalMode = (typeof CAL_MODES)[number];
export const CAL_MODE_KEY = "osiris.calendar.mode";
type Store = Pick<Storage, "getItem" | "setItem"> | undefined;
const defaultStore = (): Store => { try { return globalThis.localStorage; } catch { return undefined; } };

/** Whitelisted read: anything but a known mode (missing, corrupt, a throwing store) is "lite". */
export function loadCalMode(store: Store = defaultStore()): CalMode {
  try { const v = store?.getItem(CAL_MODE_KEY); return (CAL_MODES as readonly string[]).includes(v ?? "") ? (v as CalMode) : "lite"; } catch { return "lite"; }
}
export function saveCalMode(mode: CalMode, store: Store = defaultStore()): void {
  try { if ((CAL_MODES as readonly string[]).includes(mode)) store?.setItem(CAL_MODE_KEY, mode); } catch {}
}
