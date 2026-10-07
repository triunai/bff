// Provider detection (server-only, read-only). Three questions, none of which executes a provider CLI:
//   1. Binaries: which CLIs are installed, using the SAME trust checks as herdr and caffeinate (owner is us or root, not writable by
//      group/other, every directory above it trusted; the REAL path after symlinks is the one validated).
//   2. Sessions: which providers have transcripts in the last 7 days (counted from the fleet, see status.ts).
//   3. Live agents: a transcript written in the last 5 minutes, joined to a Herdr pane by cwd, then by title / agent name.
import { homedir } from "node:os";
import { join } from "node:path";
import { FLEET_LIVE_MS } from "../fleet-types.ts";
import { resolveTrustedPath, resolveTrustedVia, type TrustFs } from "../trusted-bin.ts";
import { PROVIDERS, providerOf } from "./registry.ts";
import type { ProviderId } from "./registry.ts";

/** Where a provider CLI is normally installed. A fixed list: no PATH lookup, so a poisoned PATH cannot make a provider look installed. */
export const cliDirs = (home = homedir()): string[] => ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin"), join(home, ".cargo", "bin"), join(home, ".npm-global", "bin"), join(home, ".bun", "bin"), join(home, ".claude", "local")];

/** The validated REAL path of `name` in the first dir that holds a trusted one, else null. Never executes it. The rules are the shared primitive's (work/trusted-bin.ts):
 * owner is us or root, not writable by group/other, every directory above it trusted; a symlink is followed and its TARGET re-checked (a CLI installer may link into its own tree). */
export function detectBinary(name: string, home = homedir(), fsx?: TrustFs): string | null {
  return resolveTrustedPath(name, { dirs: cliDirs(home), aliasTargets: "trusted", home, fsx });
}
/** The same validated binary, as the ALIAS a user would type (~/.local/bin/claude), for the launch argv a Herdr pane runs. Osiris does not exec it. */
export const detectLaunchPath = (name: string, home = homedir(), fsx?: TrustFs): string | null => resolveTrustedVia(name, { dirs: cliDirs(home), aliasTargets: "trusted", home, fsx });
/** Installed flag per registered provider. */
export const detectInstalled = (home = homedir(), fsx?: TrustFs): Record<string, boolean> => Object.fromEntries(PROVIDERS.map(p => [p.id, detectBinary(p.binary, home, fsx) !== null]));

export interface LiveSession { providerId: ProviderId; key: string; cwd: string | null; lastAt: number }
export interface PaneLite { paneId: string; cwd: string | null; title: string; agent?: string | null }
export interface LiveJoin { providerId: ProviderId; key: string; paneId: string | null; /** More than one pane shares the cwd and nothing in their title / agent name told them apart. */ ambiguous: boolean }
const normCwd = (p: string | null | undefined): string | null => { const s = (p ?? "").replace(/\/+$/, ""); return s ? s : null; };

/** Live = wrote within FLEET_LIVE_MS (5 min). Each is joined to a pane with the SAME cwd; among several, the pane whose agent name or title names the
 *  provider wins; if that is still not one pane the join is `ambiguous` and carries no pane id (never a guess). A session with no cwd joins nothing. */
export function joinLive(sessions: readonly LiveSession[], panes: readonly PaneLite[], now: number): LiveJoin[] {
  return sessions.filter(s => now - Math.min(s.lastAt, now) < FLEET_LIVE_MS).map(s => {
    const cwd = normCwd(s.cwd), same = cwd ? panes.filter(p => normCwd(p.cwd) === cwd) : [];
    if (same.length <= 1) return { providerId: s.providerId, key: s.key, paneId: same[0]?.paneId ?? null, ambiguous: false };
    const named = same.filter(p => providerOf(p.agent ?? "")?.id === s.providerId || providerOf(p.title)?.id === s.providerId);
    return named.length === 1 ? { providerId: s.providerId, key: s.key, paneId: named[0].paneId, ambiguous: false } : { providerId: s.providerId, key: s.key, paneId: null, ambiguous: true };
  });
}
