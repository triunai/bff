import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fixtureReport } from "./analytics.ts";
import { providerById } from "./work/providers/registry.ts";
import type { ProviderId } from "./work/providers/registry.ts";
import { HERDR_START_COMMAND } from "./health-model.ts";
import { CELLAR_HERDR, resolveTrustedPath, type TrustFs, type TrustPolicy } from "./work/trusted-bin.ts";
import { HERDR_PLAN_VERSION, isOsirisSessionStampName, type HerdrStamp } from "./terminal-model.ts";

export type HerdrSnapshot = {
  available: boolean;
  note: string;
  capturedAt: number | null;
  stale: boolean;
  coverage: { filesScanned: number; discoveryTruncated: boolean } | null;
  report: ReturnType<typeof fixtureReport> | null;
};
const empty = (note: string): HerdrSnapshot => ({ available: false, note, capturedAt: null, stale: true, coverage: null, report: null });
const MAX_BYTES = 8 * 1024 * 1024;
export const HERDR_FEED_PATH = join(homedir(), ".local", "share", "bff", "herdr-feed.json");

/** Consume one bounded metadata feed. Never read provider transcripts or launch a terminal. */
export async function readHerdrFeed(path = HERDR_FEED_PATH, now = Date.now()): Promise<HerdrSnapshot> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) return empty("Herdr capture feed is not a bounded regular file.");
    const file = await open(path, "r");
    let bytes: Buffer;
    try {
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_BYTES) return empty("Herdr capture feed exceeds 8 MiB.");
      bytes = buffer.subarray(0, bytesRead);
    } finally { await file.close(); }
    const value = JSON.parse(bytes.toString("utf8"));
    if (value.kind !== "herdr-provider-capture" || !Number.isFinite(value.capturedAt) || value.capturedAt < 0 || value.capturedAt > now + 60000) return empty("Herdr capture feed has invalid provenance or timestamp.");
    const report = fixtureReport(value);
    if (report.calls.some(c => !["claude-transcript", "codex-transcript"].includes(c.source))) return empty("Herdr capture feed contains unsupported sources.");
    const count = value.coverage?.filesScanned;
    if (!Number.isInteger(count) || count < 0) return empty("Herdr capture feed has invalid coverage.");
    const stale = now - value.capturedAt > 30000;
    return {
      available: true, capturedAt: value.capturedAt, stale,
      note: "Local Claude/Codex provider capture; Herdr pane membership is unverified. " + (stale ? `Capture is older than 30 seconds. Run \`${HERDR_START_COMMAND}\` in a terminal to refresh it.` : "Capture is recent. It shows what was recorded, not whether an agent is running right now."),
      coverage: { filesScanned: count, discoveryTruncated: value.coverage.discoveryTruncated === true }, report,
    };
  } catch { return empty(`Herdr capture unavailable. Run \`${HERDR_START_COMMAND}\` in a terminal to start it (\`${HERDR_START_COMMAND} --help\` lists the options); Osiris does not read native provider stores.`); }
}

// ---- live pane listing (read-only `herdr pane list`, through the one reviewed herdr runner) ----
export type HerdrPane = { paneId: string; terminalId: string | null; title: string; cwd: string | null; agent: ProviderId | null; status: string; workspaceId: string; focused: boolean };
export type HerdrPanesResult = { state: "live" | "empty" | "unreachable"; panes: HerdrPane[]; note: string | null };
/** The reviewed runner's shape (work/dispatch.ts `Exec`), declared here so this module spawns nothing itself. */
export type HerdrRun = (args: string[], o: { cwd?: string; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
const MAX_PANES = 200;
const str = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, max) : null);
/** Fallback label for a pane herdr gave no name: "(untitled) · <cwd basename> · #<last 4 of the pane id>". Distinguishable, never a full path or socket. */
const untitledLabel = (paneId: string, cwd: string | null): string => {
  const base = cwd ? basename(cwd.replace(/\/+$/, "")) : "";
  return ["(untitled)", base || null, `#${paneId.slice(paneId.lastIndexOf(":") + 1).slice(-4)}`].filter(Boolean).join(" · ");
};
/** Parse `herdr pane list` JSON (`.result.panes`). Returns null when the shape is not a pane list. Bounded; ignores unknown fields. */
export function parsePaneList(stdout: string): HerdrPane[] | null {
  let v: any; try { v = JSON.parse(stdout); } catch { return null; }
  const panes = v?.result?.panes; if (!Array.isArray(panes)) return null;
  const out: HerdrPane[] = [];
  for (const p of panes.slice(0, MAX_PANES)) {
    const paneId = str(p?.pane_id, 64); if (!paneId) continue;
    out.push({ paneId, terminalId: str(p.terminal_id, 64), title: str(p.label, 80) ?? str(p.terminal_title_stripped, 80) ?? str(p.terminal_title, 80) ?? untitledLabel(paneId, str(p.cwd, 4096)), cwd: str(p.cwd, 4096),
      agent: typeof p.agent === "string" && providerById(p.agent) ? p.agent as ProviderId : null, status: str(p.agent_status, 24) ?? "unknown", workspaceId: str(p.workspace_id, 64) ?? "", focused: p.focused === true });
  }
  return out;
}
const age = (ms: number) => { const m = Math.round(ms / 60000); return m < 60 ? `${Math.max(m, 1)} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`; };
/** Say WHY nothing is listed and the ONE next action (never a bare "No terminals"). `capture` is the bff capture, used only to
 * add its age to the explanation when the live query failed. */
export function unreachableNote(why: string, capture: Pick<HerdrSnapshot, "available" | "capturedAt" | "stale"> | null, now: number): string {
  const cap = capture?.available && capture.capturedAt !== null && capture.stale
    ? ` The Herdr capture is ${age(Math.max(0, now - capture.capturedAt))} old: run \`${HERDR_START_COMMAND}\` to refresh it.` : "";
  const install = /was not found in/.test(why) ? " Install it with `brew install herdr`." : "";
  return `Herdr is not reachable (${why}).${install} Start Herdr in a terminal (run \`herdr\`), then reopen this panel.${cap}`;
}
export async function readHerdrPanes(run: HerdrRun, capture: () => Promise<HerdrSnapshot>, now = Date.now(), cwd?: string): Promise<HerdrPanesResult> {
  let why: string;
  try {
    const r = await run(["pane", "list"], { cwd: cwd ?? homedir(), timeoutMs: 5000 });
    if (r.code === 0) {
      const panes = parsePaneList(r.stdout);
      if (panes) return panes.length ? { state: "live", panes, note: null } : { state: "empty", panes: [], note: "Herdr is running but has no panes open. Open a pane in Herdr and it will appear here." };
      why = "it answered in a format Osiris does not understand";
    } else why = str(r.stderr, 120) ?? `herdr exited with code ${r.code}`;
  } catch (e) { const m = str((e as Error)?.message, 120); why = m && /not found on PATH|ENOENT/.test(m) ? missingBinWhy() : m ?? "it could not be started"; }
  let cap: HerdrSnapshot | null = null; try { cap = await capture(); } catch { /* the capture is only extra context */ }
  return { state: "unreachable", panes: [], note: unreachableNote(why, cap, now) };
}

/** BB launches the plugin server with a curated PATH that need not contain Homebrew, so the binary is NOT found through PATH.
 * Only these fixed install locations are candidates. There is NO environment override and NO PATH lookup anywhere. */
export const herdrBinAllowlist = (home = homedir()): string[] => herdrDirs(home).map(d => join(d, "herdr"));
// The trust rules live in ONE place (work/trusted-bin.ts, ADR D-139); herdr only declares WHERE its binary may be and WHICH alias is allowed.
export { trustedFile, trustedDir, CELLAR_HERDR, type TrustFs } from "./work/trusted-bin.ts";
const herdrPolicy = (home: string, fsx?: TrustFs): TrustPolicy => ({ dirs: herdrDirs(home), aliasTargets: CELLAR_HERDR, home, fsx });
const herdrDirs = (home: string): string[] => ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin"), join(home, ".cargo", "bin")];
export const resolveHerdrBin = (home = homedir(), fsx?: TrustFs): string | null => resolveTrustedPath("herdr", herdrPolicy(home, fsx));
/** The launch-plan RPC body: a plugin caller is refused BEFORE project enumeration or any path resolution. */
export async function launchPlanFor(isPlugin: boolean, refusal: string, cwdCandidates: () => Promise<readonly string[]>, home = homedir(), fsx?: TrustFs, session?: string | null): Promise<HerdrLaunchPlan> {
  if (isPlugin) return { ok: false, reason: refusal };
  const cwds = await cwdCandidates(); // resolve AFTER every await: a swap during project enumeration must not return a stale, already-validated path
  return herdrLaunchPlan(resolveHerdrBin(home, fsx), cwds, home, session, resolveEnvBin(fsx));
}
/** A fixed system program (no symlink, no PATH lookup): a regular executable file owned by ROOT and not writable by group/other, with every
 * directory above it trusted. Re-checked on every call, like herdr. */
export const resolveRootBin = (bin: string, fsx?: TrustFs): string | null => resolveTrustedPath(bin, { rootOnly: true, fsx });
/** The ONE env program the launch argv may go through: exactly /usr/bin/env. */
export const ENV_BIN = "/usr/bin/env";
export const resolveEnvBin = (fsx?: TrustFs): string | null => resolveRootBin(ENV_BIN, fsx);
/** Plain-words reason when the runner could not find the binary on PATH (the message the reviewed runner throws). */
export const missingBinWhy = (home = homedir()) => `the herdr program was not found in ${herdrBinAllowlist(home).join(", ")}`;

const STAMP_PREFIX = "herdr-stamp:";
type StampKv = { get<T>(k: string): Promise<T | undefined>; set(k: string, v: unknown): Promise<void>; list(prefix?: string): Promise<string[]> };
/** The stamp is written by the server (it owns the plan version), keyed by the BB terminal id. Read-only elsewhere. */
export async function writeHerdrStamp(kv: StampKv, terminalId: string, session: string): Promise<{ ok: boolean }> {
  if (!terminalId || !isOsirisSessionStampName(session)) return { ok: false };
  await kv.set(STAMP_PREFIX + terminalId, { plan: HERDR_PLAN_VERSION, session } satisfies HerdrStamp);
  return { ok: true };
}
/** The session a terminal was launched with, or null when it has no stamp or an older plan version (unverifiable). */
export async function launchedSessionOf(kv: StampKv, terminalId: string): Promise<string | null> {
  const v = await kv.get<HerdrStamp>(STAMP_PREFIX + terminalId);
  return v && v.plan === HERDR_PLAN_VERSION && typeof v.session === "string" ? v.session : null;
}
export async function readHerdrStamps(kv: StampKv): Promise<{ stamps: Record<string, HerdrStamp> }> {
  const stamps: Record<string, HerdrStamp> = {};
  for (const k of (await kv.list(STAMP_PREFIX)).slice(0, 500)) {
    const v = await kv.get<HerdrStamp>(k);
    if (v && typeof v.plan === "number" && typeof v.session === "string") stamps[k.slice(STAMP_PREFIX.length)] = v;
  }
  return { stamps };
}

export type HerdrLaunchPlan = { ok: true; argv: string[]; cwd: string; title: string } | { ok: false; reason: string };
/** A herdr session name the launch plan may carry. Strict allowlist (the owner's spec is `^[A-Za-z0-9._-]{1,64}$`), plus no leading dash so a name can
 * never be read as an option (`session attach --help`). It is the ONLY client-supplied text that can reach argv. */
export const HERDR_SESSION_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
export const isHerdrSessionName = (n: unknown): n is string => typeof n === "string" && HERDR_SESSION_NAME.test(n);
// parseSessionRows lives in terminal-model.ts (browser-safe: the seam-guard registry the client bundles needs it); re-exported here.
export { parseSessionRows, type HerdrSessionRow } from "./terminal-model.ts";
export type HerdrSession = { name: string; running: boolean };
/** `herdr session list` is a read-only table (name status directory socket). Unknown shape is null; rows whose name fails the allowlist are dropped. */
export function parseSessionList(stdout: string): HerdrSession[] | null {
  const lines = stdout.split("\n").map(l => l.trim()).filter(Boolean);
  if (!lines.length || !/^name\s+status\b/i.test(lines[0])) return null;
  const out: HerdrSession[] = [];
  for (const l of lines.slice(1)) { const [name, status] = l.split(/\s+/); if (isHerdrSessionName(name) && (status === "running" || status === "stopped")) out.push({ name, running: status === "running" }); }
  return out;
}
/** Read-only: lists the sessions herdr reports. Never starts, stops or deletes one. */
export async function readHerdrSessions(run: HerdrRun, cwd = homedir()): Promise<{ ok: true; sessions: HerdrSession[] } | { ok: false; reason: string }> {
  try {
    const r = await run(["session", "list"], { cwd, timeoutMs: 5000 });
    const sessions = r.code === 0 ? parseSessionList(r.stdout) : null;
    return sessions ? { ok: true, sessions } : { ok: false, reason: r.code === 0 ? "herdr answered in a format Osiris does not understand" : str(r.stderr, 120) ?? `herdr exited with code ${r.code}` };
  } catch (e) { return { ok: false, reason: str((e as Error)?.message, 120) ?? "herdr could not be started" }; }
}
/** BB itself may have been started inside a herdr pane, so every BB terminal inherits these four variables and herdr then refuses with "nested herdr is
 * disabled by default". They are removed by /usr/bin/env -u (no shell). HERDR_SOCKET_PATH is deliberately NOT unset: it is how herdr finds the user's server. */
export const HERDR_UNSET: readonly string[] = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"].flatMap(v => ["-u", v]);
/** The ONE terminal Osiris may ask BB to create on a human click: the pinned herdr binary (a trusted file from the fixed install-path list; no env override) with a FIXED argv shape.
 * Argv is [/usr/bin/env, -u HERDR_ENV, -u HERDR_PANE_ID, -u HERDR_TAB_ID, -u HERDR_WORKSPACE_ID, bin, ...rest]; rest is [] by default: plain `herdr` attaches the user's own persistent (default) session, so their normal tabs show. (It used to be
 * `--session osiris`, a separate session, which hid every tab the owner already had.) A named session is `session attach <name>`, and the name
 * must pass HERDR_SESSION_NAME. No other user text reaches argv, and no shell string is ever built. */
export function herdrLaunchPlan(bin: string | null, cwdCandidates: readonly string[], home = homedir(), session?: string | null, envBin: string | null = null): HerdrLaunchPlan {
  if (!bin) return { ok: false, reason: missingBinWhy(home) + ". Install Herdr (brew install herdr), then try again." };
  if (session !== undefined && session !== null && !isHerdrSessionName(session)) return { ok: false, reason: "That is not a valid session name (letters, digits, dot, dash and underscore only, up to 64, not starting with a dash)." };
  if (!envBin) return { ok: false, reason: `${ENV_BIN} is missing or not a trusted system file, so Osiris will not start herdr.` };
  const valid = cwdCandidates.filter(c => c.startsWith("/") && !/[\0-\x1f]/.test(c));
  const cwd = valid[0] ?? home;
  return { ok: true, argv: [envBin, ...HERDR_UNSET, bin, ...(session ? ["session", "attach", session] : [])], cwd, title: "Herdr (Osiris)" };
}
