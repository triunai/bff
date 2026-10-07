// What a herdr CHILD may see and where a herdr program may live, for every herdr spawn (server-side runner, herdr-dispatch, the session check script).
// Kept out of herdr-feed.ts on purpose: that file builds the launch plan and a wiring test pins that it never mentions the socket variable.
import { homedir } from "node:os";
import { join } from "node:path";
import { CELLAR_HERDR, type ChildEnvOpts, type TrustPolicy } from "./trusted-bin.ts";

/** The minimal base (trusted-bin.ts) plus the variables herdr needs to find the user's server. HERDR_ENV / HERDR_PANE_ID / HERDR_TAB_ID / HERDR_WORKSPACE_ID are NOT passed
 * (they only matter to an attach, which Osiris never runs from the server). */
export const HERDR_CHILD: ChildEnvOpts = Object.freeze({ inherit: ["HERDR_SOCKET_PATH", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "USER", "LOGNAME"] });
/** Where a herdr path handed to a spawn may live (re-vetted by the primitive on every spawn): the fixed system dirs, ~/.cargo/bin, and the herdr Homebrew formula. */
export const HERDR_SPAWN_TRUST: TrustPolicy = Object.freeze({ extraDirs: [join(homedir(), ".cargo", "bin")], aliasTargets: CELLAR_HERDR });
