// What a herdr CHILD may see and where a herdr program may live, for every herdr spawn (server-side runner, herdr-dispatch, the session check script).
// Kept out of herdr-feed.ts on purpose: that file builds the launch plan and a wiring test pins that it never mentions the socket variable.
import { homedir } from "node:os";
import { join } from "node:path";
import { CELLAR_HERDR, unavailableOnOs, type ChildEnvOpts, type TrustPolicy } from "./trusted-bin.ts";

/** The minimal base (trusted-bin.ts) plus the variables herdr needs to find the user's server. HERDR_ENV / HERDR_PANE_ID / HERDR_TAB_ID / HERDR_WORKSPACE_ID are NOT passed
 * (they only matter to an attach, which Osiris never runs from the server). */
export const HERDR_CHILD: ChildEnvOpts = Object.freeze({ inherit: ["HERDR_SOCKET_PATH", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "USER", "LOGNAME"] });
/** Where a herdr path handed to a spawn may live (re-vetted by the primitive on every spawn): the fixed system dirs, ~/.cargo/bin, and the herdr Homebrew formula. */
export const HERDR_SPAWN_TRUST: TrustPolicy = Object.freeze({ extraDirs: [join(homedir(), ".cargo", "bin")], aliasTargets: CELLAR_HERDR });

/** herdr has no Windows build. Typed so the UI can say so in plain words; the primitive also refuses to resolve or spawn it on win32 ("unavailable-on-os"). */
export type HerdrAvailability = { available: true } | { available: false; reason: "unavailable-on-os"; text: string };
export const herdrAvailability = (platform: string = process.platform): HerdrAvailability =>
  unavailableOnOs("herdr", platform) === null ? { available: true }
    : { available: false, reason: "unavailable-on-os", text: "The Herdr terminal board is not available on Windows. The work tracker, worktree and Git views still work." };
