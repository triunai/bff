// Classic Factory flag storage (pure over a Storage-like). The animated floor is the default; Classic is on ONLY after an explicit tick
// written under the v2 key. The v1 key (any earlier build, demo or stray click) is dropped on first read, never honoured.
export const CLASSIC_FACTORY_KEY = "osiris-classic-factory.v2";
export const LEGACY_CLASSIC_FACTORY_KEY = "osiris-classic-factory";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function readClassicFactory(s: Store): boolean {
  try { s.removeItem(LEGACY_CLASSIC_FACTORY_KEY); return s.getItem(CLASSIC_FACTORY_KEY) === "1"; } catch { return false; }
}
export function writeClassicFactory(s: Store, on: boolean): void {
  try { if (on) s.setItem(CLASSIC_FACTORY_KEY, "1"); else s.removeItem(CLASSIC_FACTORY_KEY); } catch { /* storage unavailable */ }
}
