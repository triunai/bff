// The initial guards. Each one is pure over GuardCtx readers, reports what / why / fix, and never acts. A guard is here only where the
// invariant is real in code: tracker identity (Work board), build identity (installed dir), transcript sources, git repo, keep-awake,
// dispatch target and telemetry sealing. (The Herdr-session guard belongs to lane HS and joins the registry there.)
import type { GuardCtx, GuardResult, SeamGuard } from "./types.ts";

const ok: GuardResult = { ok: true };
const bad = (severity: "crit" | "warn", what: string, why: string, fix: string): GuardResult => ({ ok: false, severity, what, why, fix });
const DAY = 86_400_000;
/** A transcript root whose newest file is older than this is probably not being written any more. */
export const TRANSCRIPT_STALE_MS = 24 * 3_600_000;

/** The Work board shows ONE tracker; the bd snapshot on screen must have been read from that same path, and the repo must still be allowed. */
export const trackerIdentityGuard: SeamGuard = { id: "tracker-identity", seam: "Work board tracker == the repo its bd snapshot was read at", async run(ctx) {
  const { trackerRepo, snapshotRepo } = ctx.view;
  if (!trackerRepo) return ok;
  if (!(await ctx.isRepoAllowed(trackerRepo))) return bad("crit", `The Work board's tracker ${trackerRepo} is not an allowed repository`, "Osiris would be reading a tracker you have not opened or pinned.", "Open it as a BB project or pin it from the repo picker, or pick a different tracker.");
  if (snapshotRepo && snapshotRepo !== trackerRepo) return bad("crit", `The board's tracker is ${trackerRepo} but its bd snapshot came from ${snapshotRepo}`, "Every card on the board describes a different tracker than the one you selected.", "Refresh the Work board; if it persists, re-pick the tracker from the repo picker.");
  return ok;
} };

/** The plugin that is running must be the build BB reports as installed. With no way to ask BB there is nothing to compare. */
export const buildIdentityGuard: SeamGuard = { id: "build-identity", seam: "Running Osiris build == the install dir BB reports", async run(ctx) {
  if (!ctx.installedBuild) return ok;
  const running = await ctx.runningBuild();
  if (!running) return bad("crit", "Cannot identify the Osiris build that is running", "Without it nobody can tell which build the screen belongs to.", "Reinstall Osiris with osiris-update, then reload BB.");
  const installed = await ctx.installedBuild();
  if (!installed) return bad("warn", "BB did not report an installed Osiris dir", "The running build cannot be checked against what BB thinks is installed.", "Run `bb plugin list` and check that tool-observer shows a source path.");
  if (running.dir !== installed.dir) return bad("crit", `Running build ${running.version} (${running.dir}) is not the installed dir ${installed.dir} (${installed.version})`, "You may be looking at an old or a different build than the one you installed.", "Run osiris-update, then reload BB; or restart the plugin with `bb plugin restart tool-observer`.");
  return ok;
} };

/** Agent activity comes from transcript roots on disk: they must exist and be readable, and the newest file should be recent. */
export const transcriptSourcesGuard: SeamGuard = { id: "transcript-sources", seam: "Configured transcript roots exist, are readable and are being written", async run(ctx) {
  const roots = await ctx.transcriptRoots();
  const t = ctx.now();
  for (const r of roots) {
    if (r.exists && !r.readable) return bad("crit", `Transcript root ${r.path} exists but cannot be read`, "The fleet and calls views will show no agents from it.", `Fix the permissions on ${r.path} (the user running BB must be able to read it).`);
    if (!r.exists) return bad(r.required ? "crit" : "warn", `Transcript root ${r.path} does not exist`, r.required ? "Osiris cannot see any agent activity without it." : "Agents of that runtime will not appear.", r.required ? `Start a Claude Code session once so ${r.path} is created, or check the path.` : "Ignore this if you do not use that runtime.");
  }
  const stale = roots.find(r => r.newestMtime === null || t - r.newestMtime > TRANSCRIPT_STALE_MS);
  if (stale) return bad("warn", stale.newestMtime === null ? `Transcript root ${stale.path} holds no transcripts` : `Newest transcript under ${stale.path} is ${Math.floor((t - stale.newestMtime) / DAY * 10) / 10} days old`, "Nothing has been written there for a long time, so live views may be quietly empty.", "Check that your agents still write transcripts to this root; ignore this on an idle machine.");
  return ok;
} };

/** Commits / History and the Work board are chosen separately; when they differ the owner must know. */
export const gitRepoGuard: SeamGuard = { id: "git-repo", seam: "Commits / History repo == the Work board's tracker repo", async run(ctx) {
  const { gitRepo, trackerRepo } = ctx.view;
  if (!gitRepo || !trackerRepo || gitRepo === trackerRepo) return ok;
  return bad("warn", `Commits show ${gitRepo} but the Work board tracks ${trackerRepo}`, "Commit links, Health and History describe a different repo than the board.", "Pick the same repo in both, or keep them different on purpose and ignore this.");
} };

/** While agents are live on macOS with the setting on, the caffeinate child must be alive; the live count and the child are read in the same tick. */
export const keepAwakeGuard: SeamGuard = { id: "keep-awake", seam: "Keep-awake child is alive while agents are live", async run(ctx) {
  if (ctx.platform !== "darwin") return ok;
  const k = await ctx.keepAwake();
  if (!k.supported || !k.enabled || !(k.live > 0)) return ok;
  if (!k.active) return bad("crit", `${k.live} agent${k.live === 1 ? " is" : "s are"} working but Osiris is not keeping the Mac awake`, "The Mac can sleep mid-run and stall every agent.", "Check that /usr/bin/caffeinate is intact and root-owned, then reload the plugin; or run `caffeinate -i` yourself.");
  return ok;
} };

/** Dispatch always opens its tab in the user's default Herdr session; the Terminal tab must be showing that same session. */
export const dispatchTargetGuard: SeamGuard = { id: "dispatch-target", seam: "Dispatch target session == the session the Terminal shows", async run(ctx) {
  const target = await ctx.dispatchSession();
  const shown = ctx.view.terminalSession || "default";
  if (shown === target) return ok;
  return bad("warn", `Dispatch opens agents in Herdr session "${target}" but the Terminal shows "${shown}"`, "A dispatched agent will appear in a session you are not looking at.", `Switch the Terminal back to the default session, or look at "${target}" in your own Herdr.`);
} };

/** A sample payload is sealed by the real sealing path; none of the raw ids it was built from may survive in the output. */
export const telemetrySealingGuard: SeamGuard = { id: "telemetry-sealing", seam: "Outgoing telemetry payloads are sealed (D-135)", async run(ctx) {
  const { raw, sealed } = await ctx.sealedSample();
  if (raw.length === 0) return bad("crit", "The sealing sample has no raw ids to look for", "The check proves nothing, so it fails closed.", "Fix sealedSample() so it feeds known raw ids through the sealing path.");
  const leaked = raw.filter(r => sealed.includes(r));
  if (leaked.length) return bad("crit", `A sample payload leaked ${leaked.length} raw id${leaked.length === 1 ? "" : "s"} past the sealing boundary`, "Real agent and session ids would leave the server in telemetry answers.", "Do not ship: a recent change bypassed sealFleet / sealWorkTelemetry. Run the opaque-key tests.");
  return ok;
} };
