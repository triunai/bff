// Seam guard "Terminal <-> Herdr" (td-osi.12): the herdr session Osiris's terminal is attached to must BE the user's default (or explicitly picked) session.
// Identity is the SOCKET PATH from the read-only `herdr session list` (name status directory socket), never the name. Fails closed: anything unverifiable is crit.
import { HERDR_DEFAULT_SESSION, HERDR_INSTALL_COMMAND, parseSessionRows } from "../../terminal-model.ts";
import type { HerdrRun } from "../../herdr-feed.ts";
import type { GuardCtx, GuardResult, SeamGuard } from "./types.ts";

export type HerdrGuardCtx = {
  /** The ONE reviewed read-only herdr runner. Only `session list` is ever called. */
  run: HerdrRun;
  /** The session the user configured: null/"" = their default. */
  picked: string | null;
  /** The session identity the attached terminal was LAUNCHED with (from its launch stamp); null when unknown (no/old stamp). */
  launched: string | null;
};
/** "Couldn't check": the guard could not VERIFY (our own refusal, a failed or unreadable list). Amber, never red: only a VERIFIED mismatch or a missing binary is crit. */
const unverified = (what: string, why: string, fix: string): GuardResult => ({ ok: false, severity: "warn", what, why, fix });
const crit = (what: string, why: string, fix: string): GuardResult => ({ ok: false, severity: "crit", what, why, fix });

export async function checkHerdrSession(c: HerdrGuardCtx): Promise<GuardResult> {
  const want = c.picked || HERDR_DEFAULT_SESSION;
  let rows: ReturnType<typeof parseSessionRows>;
  try {
    const r = await c.run(["session", "list"], { timeoutMs: 5000 });
    if (r.code !== 0) return unverified("Couldn't check which Herdr session Osiris is showing", `herdr session list exited with code ${r.code}`, `Check that Herdr runs (${HERDR_INSTALL_COMMAND} if it is missing), then reopen the Terminal tab.`);
    rows = parseSessionRows(r.stdout);
  } catch (e) {
    const why = String((e as Error)?.message ?? e).slice(0, 160);
    // A runner/allowlist refusal is OUR bug, not a missing Herdr: never tell the user to install it.
    if ((e as { refused?: boolean })?.refused === true) return unverified("Couldn't check the Herdr session (Osiris internal error)", why, "This is an Osiris bug, not a Herdr problem: copy this message into a bug report and update Osiris.");
    if (/not found|ENOENT|not a trusted|untrusted/i.test(why)) return crit("Herdr is missing or could not be started", why, `Install Herdr: ${HERDR_INSTALL_COMMAND}`);
    return unverified("Couldn't check: Herdr could not be started", why, "Check that Herdr runs in your Terminal app, then reopen the Terminal tab.");
  }
  if (!rows) return unverified("Couldn't check: Osiris cannot read Herdr's session list", "the output was not the expected name/status/directory/socket table, so the session cannot be verified", "Update Osiris or Herdr, then reopen the Terminal tab.");
  const wantRow = rows.find(x => x.name === want);
  if (!wantRow) return crit(`Your Herdr session '${want}' was not found`, "Osiris cannot tell which session your Terminal app uses", "Start Herdr in your Terminal app, then press Switch to default.");
  if (!c.launched) return crit("Osiris cannot tell which Herdr session this terminal is on", "it was started by an older Osiris and carries no launch record", "Press Switch to default to reopen it on your session.");
  const gotRow = rows.find(x => x.name === c.launched);
  if (!gotRow) return crit(`Osiris is showing Herdr session '${c.launched}', which Herdr no longer lists`, `your Terminal app uses '${want}'`, "Press Switch to default.");
  if (gotRow.socket !== wantRow.socket) return crit(`Osiris is showing Herdr session '${gotRow.name}', but your Terminal app uses '${wantRow.name}'`, `different Herdr servers (${gotRow.socket} vs ${wantRow.socket})`, "Press Switch to default.");
  return { ok: true };
}

export const herdrSessionGuard: SeamGuard = { id: "herdr-session", seam: "Terminal ↔ Herdr", run: async (ctx: GuardCtx) => (ctx.herdrSession ? checkHerdrSession(await ctx.herdrSession()) : { ok: true }) };
