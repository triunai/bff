// Provider coverage status (pure, browser-safe): what the bottom status bar says about which providers Osiris can see, so a missing
// provider is said out loud and never shows as a silent zero.
import { PROVIDERS } from "./registry.ts";
import type { ProviderId } from "./registry.ts";

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  chip: string;
  /** A trusted CLI binary was found on this machine. */
  installed: boolean;
  /** Sessions with a transcript inside the 7-day read window. */
  sessions: number;
  /** Sessions that wrote in the last 5 minutes. */
  live: number;
  /** A price table exists for this provider; false shows "$ n/a". */
  priced: boolean;
  /** The reader has not been checked against a real install. */
  unverified: boolean;
}
export const SESSION_WINDOW_DAYS = 7;

/** Pure: installed flags (detect.ts) + per-runtime lane counts (FleetSnapshot.summary.byRuntime) -> one status per registered provider. */
export function buildProviderStatus(installed: Readonly<Record<string, boolean>>, byRuntime: readonly { key: string; live: number; total: number }[]): ProviderStatus[] {
  return PROVIDERS.map(p => {
    const c = byRuntime.find(r => r.key === p.id);
    return { id: p.id, label: p.label, chip: p.chip, installed: installed[p.id] === true, sessions: c?.total ?? 0, live: c?.live ?? 0, priced: p.priced, unverified: p.unverified };
  });
}
/** `Claude ✓` · `Codex ✓ ($ n/a)` · `Gemini – (not installed)` · `Gemini – (no sessions in 7 days)`. */
export function providerCell(s: ProviderStatus): string {
  if (!s.installed && s.sessions === 0) return `${s.label} – (not installed)`;
  if (s.sessions === 0) return `${s.label} – (no sessions in ${SESSION_WINDOW_DAYS} days)`;
  return `${s.label} ✓${s.priced ? "" : " ($ n/a)"}`;
}
export const providersText = (all: readonly ProviderStatus[]): string => `providers: ${all.map(providerCell).join(" · ")}`;
/** Tooltip: what is and is not verified, in words. */
export const providersTitle = (all: readonly ProviderStatus[]): string =>
  all.map(s => `${s.label}: ${s.installed ? "CLI found" : "CLI not found"}, ${s.sessions} session${s.sessions === 1 ? "" : "s"} in ${SESSION_WINDOW_DAYS} days, ${s.live} live${s.priced ? "" : ", no price on file"}${s.unverified ? ", reader unverified on a real install" : ""}`).join("\n");
