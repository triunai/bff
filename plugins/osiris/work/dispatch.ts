// Dispatch: select a bead, claim it, put it in its own git worktree + a NEW Herdr pane, launch the runtime there.
// THE ONE BEADS WRITE Osiris ever makes is claimBead() (`bd update <id> --claim`, bd's own atomic compare-and-set).
// Everything else here is a read (`--readonly`), a herdr call, or a file write inside the new worktree.
// branchFor/slugify PORTED from Mardi Gras (MIT, (c) 2025 Matt Wright; third_party/mardi-gras-LICENSE.txt) internal/data BranchName/slugify.
import {createHash, randomBytes} from "node:crypto";
import {appendFile, lstat, mkdir, readdir, stat, unlink, writeFile} from "node:fs/promises";
import {realpathSync} from "node:fs";
import {basename, dirname, isAbsolute, join, resolve} from "node:path";
import {runGit, validateRepo} from "../git-feed.ts";
import {BD_CHILD, BD_TRUST, resolveBd, resolveGit} from "./bd-readonly.ts";
import {HERDR_CHILD, HERDR_SPAWN_TRUST} from "./herdr-spawn.ts";
import {trustedRun, type ChildEnvOpts, type TrustPolicy} from "./trusted-bin.ts";
import {buildWorkGraph} from "./work-model.ts";
import {cleanText, redactSecrets} from "./sanitize.ts";
import {fetchWorkSnapshot} from "./beads-adapter.ts";
import type {RunResult} from "./beads-adapter.ts";
import {buildLanePrompt} from "./prompt.ts";
import type {LaneBead} from "./prompt.ts";
import {buildArgv, defaultWhich} from "./runtimes.ts";
import {BEAD_ID_RE, isAllowedModel, MODEL_RE, RUNTIMES} from "./runtime-models.ts";
import type {Which} from "./runtimes.ts";
import type {ClaimOutcome, DispatchPreview, DispatchRequest, DispatchResult} from "./surface-types.ts";
import type {WorkDep, WorkIssue} from "./types.ts";

export type Exec = (args: string[], o: {cwd?: string; timeoutMs: number}) => Promise<RunResult>;
export const TOKEN_TTL_MS = 120_000, RATE_MS = 60_000, PREVIEW_MS = 2_000;
export const CHANGED = "The bead changed since you previewed it — preview again";
/** Failure text that reaches the UI: escapes/hidden characters stripped, secret shapes and the home user name masked (W-2A L5). */
export const scrub = (s: string): string => redactSecrets(cleanText(s, 2000));
/** Server-side dispatch guard state (S2 token, S3 rate limit + in-flight). In-memory, one per plugin load. */
export interface DispatchGuard {
  /** `digest` binds what the owner reviewed (prompt + argv + base + hooks, M3); `hooks` is the detected list. */
  tokens: Map<string, {key: string; exp: number; digest?: string; hooks?: string[]}>; last: Map<string, number>; inflight: Set<string>; rand: () => string;
  /** per-bead preview clock (L2): at most one preview per bead per PREVIEW_MS */
  previewed: Map<string, number>;
}
export const makeGuard = (rand: () => string = () => randomBytes(16).toString("hex")): DispatchGuard => ({tokens: new Map(), last: new Map(), inflight: new Set(), rand, previewed: new Map()});
/** Token bound to {repo, bead, runtime, model}: a different selection can never reuse it. */
export const tokenKey = (req: {repo: string; beadId: string; runtime: string; model: string | null}) => JSON.stringify([req.repo, req.beadId, req.runtime, req.model]);
export function issueToken(g: DispatchGuard, key: string, now: number, bind: {digest?: string; hooks?: string[]} = {}): string {
  for (const [t, v] of g.tokens) if (v.exp <= now) g.tokens.delete(t); // EXPIRED tokens go first; only then the oldest live one (L2)
  while (g.tokens.size >= 200) g.tokens.delete(g.tokens.keys().next().value!);
  const t = g.rand(); g.tokens.set(t, {key, exp: now + TOKEN_TTL_MS, ...bind}); return t;
}
/** null = ok, else the plain reason. take=true burns it (single use); a mismatched key never burns another selection's token. */
export function checkToken(g: DispatchGuard, token: string | undefined, key: string, now: number, take: boolean, digest?: string): string | null {
  if (typeof token !== "string" || !token) return "a dispatch token is required: open the preview first, then confirm";
  const v = g.tokens.get(token);
  if (!v) return "dispatch token is unknown or already used: preview again";
  if (v.exp <= now) { g.tokens.delete(token); return "dispatch token expired (2 min): preview again"; }
  if (v.key !== key) return "dispatch token does not match this repo, bead, runtime and model: preview again";
  if (digest !== undefined && v.digest !== undefined && v.digest !== digest) return CHANGED;
  if (take) g.tokens.delete(token);
  return null;
}

export interface DispatchDeps {
  bd: Exec; herdr: Exec; now: () => number; which: Which;
  fs: {mkdir: (p: string) => Promise<unknown>; writeFile: (p: string, data: string) => Promise<unknown>; appendFile: (p: string, data: string) => Promise<unknown>};
  /** Absolute path of a worktree's info/exclude (`git rev-parse --git-path info/exclude`), null when unknown. */
  excludePath: (worktree: string) => Promise<string | null>;
  guard: DispatchGuard;
  /** git for read-only probes that must NOT disable hooksPath (hooks dir, ls-files). Default: the real git, absolute-resolved, GIT_* stripped. */
  git: Exec;
  /** M2: refuse (reason) when the worktree's .osiris is a symlink or tracked, or a launch target is a symlink; unlinks stale regular files. null = safe to write. */
  prepareLaunch: (worktree: string) => Promise<string | null>;
  /** Claim identity. Default is unique PER DISPATCH, so re-dispatching one bead can never be an idempotent "ok". */
  actor?: string;
}

/** `resolve()` returns an absolute program (the primitive re-vets it on EVERY call, D-139); the env is the minimal explicit base plus only what `env` names. A program that is
 * missing or untrusted fails closed: the promise rejects and nothing runs. */
const exec = (name: string, resolve: () => string | null, env: ChildEnvOpts, trust?: TrustPolicy): Exec => (args, o) => {
  const bin = resolve();
  if (!bin) return Promise.reject(new Error(`${name} is not installed in a trusted location`));
  return trustedRun(bin, args, {...env, cwd: o.cwd, timeoutMs: o.timeoutMs, maxBuffer: 16 * 1024 * 1024, trust, label: name});
};
const gitExcludePath = async (worktree: string): Promise<string | null> => {
  const r = await runGit(worktree, ["rev-parse", "--git-path", "info/exclude"]); if (!r.ok) return null;
  const p = r.value.trim(); return p ? resolve(worktree, p) : null;
};
/** M2: the launch files are written into a worktree CHECKED OUT FROM THE REPO, so the repo controls what is already there. Refuse a symlinked or
 *  tracked `.osiris`, refuse a symlinked target, unlink a stale regular file (the writes then use flag "wx", which never follows a link). */
export async function safeLaunchDir(worktree: string, git: Exec, names: readonly string[] = ["prompt.md", "launch.sh"]): Promise<string | null> {
  const dir = join(worktree, ".osiris");
  try { const st = await lstat(dir); if (st.isSymbolicLink() || !st.isDirectory()) return ".osiris in the worktree is a symlink or not a directory (the repo planted it); refusing to write launch files"; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : `cannot inspect .osiris: ${(e as Error).message}`; }
  let tracked: RunResult; try { tracked = await git(["ls-files", "-z", "--", ".osiris"], {cwd: worktree, timeoutMs: 10_000}); } catch (e) { return `cannot check whether .osiris is tracked: ${(e as Error).message}`; }
  if (tracked.code !== 0) return "cannot check whether .osiris is tracked; refusing to write launch files";
  if (tracked.stdout.trim()) return ".osiris is tracked in the repo (it ships files into the worktree); refusing to write launch files over it";
  for (const n of names) {
    const f = join(dir, n);
    try { const st = await lstat(f); if (st.isSymbolicLink() || !st.isFile()) return `.osiris/${n} is a symlink or not a regular file; refusing to write launch files`; await unlink(f); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return `cannot inspect .osiris/${n}: ${(e as Error).message}`; }
  }
  return null;
}
/** Read-only git probes run inside a worktree checked out from a possibly untrusted repo. They must see the repo's REAL
 * hooks path (that is what they check), so unlike runGit they cannot null core.hooksPath, but a repo-configured fsmonitor
 * or untracked cache can still execute a program on index reads; both are forced off for every probe. */
export const hardenGitArgs = (args: readonly string[]): string[] => ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "--no-optional-locks", ...args];
/** herdr 0.9.3: `worktree create [--workspace ID | --cwd PATH] ...`, the two are MUTUALLY EXCLUSIVE. The live smoke caught
 * the earlier argv passing both: herdr refused it AFTER the claim (bead claimed, no worktree), which every fake-herdr test
 * missed. The repo's own workspace is required (pre-claim refusal when absent), so only --workspace is passed. */
/** true / false / null (unreadable): do two checkouts share one git common dir (realpath)? Read-only, hardened git. */
export async function sameRepo(git: Exec, repo: string, worktree: string): Promise<boolean | null> {
  const dir = async (cwd: string) => { try { const r = await git(["rev-parse", "--git-common-dir"], {cwd, timeoutMs: 10_000}); return r.code === 0 && r.stdout.trim() ? realpathSync(resolve(cwd, r.stdout.trim())) : null; } catch { return null; } };
  const [a, b] = await Promise.all([dir(repo), dir(worktree)]);
  return a === null || b === null ? null : a === b;
}
export const worktreeCreateArgv = (ws: string, pv: {branch: string; worktree: string; paneTitle: string}, base: string): string[] =>
  ["worktree", "create", "--workspace", ws, "--branch", pv.branch, "--base", base, "--path", pv.worktree, "--label", pv.paneTitle];
/** herdr runner that takes ONLY a freshly validated absolute path from `trusted()` on EVERY call (no PATH lookup, no env, no cached
 * path): null fails closed with nothing executed. The caller's resolver owns the trust rules (herdr-feed.ts resolveHerdrBin). */
/** Only these subcommands (all talk to an already-running server): a bare `herdr`, `--session`, `attach`, any `session` other than `session list`, `update` or any flag
 * would launch a session and spawn a server that inherits herdrEnv's minimal PATH, so they are refused before anything resolves. */
export const HERDR_SUBCOMMANDS: readonly string[] = ["worktree", "pane"];
/** The ONE read-only `session` argv: `session list` only talks to the running server. attach / stop / delete / anything else stays refused. */
export const herdrArgvAllowed = (args: readonly string[]): boolean => HERDR_SUBCOMMANDS.includes(args[0]) || (args.length === 2 && args[0] === "session" && args[1] === "list");
export class HerdrRefusedError extends Error { readonly refused = true; }
export const herdrRunner = (trusted: () => string | null, trust: TrustPolicy = HERDR_SPAWN_TRUST): Exec => (args, o) => { if (!herdrArgvAllowed(args)) return Promise.reject(new HerdrRefusedError(`"${args.slice(0, 2).map(String).join(" ")}" is not an allowed herdr subcommand`)); const bin = trusted(); return bin && isAbsolute(bin) ? exec("herdr", () => bin, HERDR_CHILD, trust)(args, o) : Promise.reject(new Error("herdr not found in the trusted install paths")); };
export const defaultDeps = (opts: {herdrBin?: () => string | null} = {}): DispatchDeps => { const gitRaw = exec("git", resolveGit, BD_CHILD), git: Exec = (args, o) => gitRaw(hardenGitArgs(args), o); return {bd: exec("bd", resolveBd, BD_CHILD, BD_TRUST), herdr: herdrRunner(opts.herdrBin ?? (() => null)), now: Date.now, which: defaultWhich, guard: makeGuard(), excludePath: gitExcludePath, git, prepareLaunch: (w) => safeLaunchDir(w, git),
  // flag "wx": create-only, never follows a symlink or truncates an existing file
  fs: {mkdir: (p) => mkdir(p, {recursive: true}), writeFile: (p, d) => writeFile(p, d, {mode: 0o600, flag: "wx"}), appendFile: (p, d) => appendFile(p, d)}}; };

// ---- repo hooks (W-2A M1) ------------------------------------------------------------------------------------------
/** Hooks that would RUN CODE during dispatch: bd's `.beads/hooks/on_*` (fired by the claim) and `hook.exec` / `hook.path` config, plus the git hooks a
 *  `worktree add` fires (post-checkout; reference-transaction on the new branch ref) in the EFFECTIVE hooks dir (core.hooksPath respected). Read-only. */
export async function detectHooks(repo: string, deps: Pick<DispatchDeps, "bd" | "git">): Promise<string[]> {
  const out: string[] = [];
  const scan = async (dir: string, want: (n: string) => boolean, label: string) => {
    let names: string[]; try { names = (await readdir(dir)).sort(); } catch { return; }
    for (const n of names) if (want(n)) { try { const st = await stat(join(dir, n)); if (st.isFile() && (st.mode & 0o111) !== 0) out.push(`${label} ${n}`); } catch { /* unreadable: not run */ } }
  };
  await scan(join(repo, ".beads", "hooks"), (n) => /^on_/.test(n), "bd");
  for (const k of ["hook.exec", "hook.path"]) {
    try { const r = await deps.bd(["--readonly", "config", "get", k], {cwd: repo, timeoutMs: 15_000}), v = r.stdout.trim(); if (r.code !== 0) out.push(`bd config ${k} (unreadable)`); else if (v && !/\(not set\)\s*$/.test(v) && !/^(false|none|off|0)$/i.test(v)) out.push(`bd config ${k}`); }
    catch { out.push(`bd config ${k} (unreadable)`); }
  }
  try { const r = await deps.git(["rev-parse", "--git-path", "hooks"], {cwd: repo, timeoutMs: 10_000}); if (r.code === 0 && r.stdout.trim()) await scan(resolve(repo, r.stdout.trim()), (n) => n === "post-checkout" || n === "reference-transaction", "git"); } catch { /* no git: nothing to detect */ }
  return out;
}

// ---- naming --------------------------------------------------------------------------------------------------------
export function slugify(s: string): string {
  let r = "", dash = false;
  for (const c of s.toLowerCase()) {
    if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) { r += c; dash = false; }
    else if ((c === " " || c === "-" || c === "_" || c === "/") && !dash && r) { r += "-"; dash = true; }
  }
  return r.replace(/-+$/, "").slice(0, 50).replace(/-+$/, "");
}
export const branchFor = (b: {id: string; title: string}) => `work/${b.id}-${slugify(b.title)}`.replace(/-$/, "");
export const worktreeFor = (repo: string, b: {id: string}) => join(dirname(repo), ".osiris-worktrees", basename(repo), b.id);
const shortId = (id: string) => id.replace(/^[^-]+-/, "");
export const paneTitleFor = (b: {id: string; title: string}) => { const t = cleanText(b.title).replace(/\s+/g, " ").trim(); return `${shortId(b.id)} · ${t.length > 40 ? t.slice(0, 39).trimEnd() + "…" : t}`; };
/** POSIX single-quote: the only safe way to embed arbitrary text (quotes, $(), backticks, newlines) in launch.sh. */
export function shSingleQuote(s: string): string {
  if (s.includes("\0")) throw new Error("NUL in shell word");
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---- preflight -----------------------------------------------------------------------------------------------------
/** bd 1.3.1 keys that make a write push, sync or stage on its own. Researched via `bd config --help` / `bd config show` / `bd help`. */
export const AUTO_KEYS = ["backup.git-push", "export.git-add", "export.auto", "dolt.auto-push", "dolt.auto-sync", "sync.auto", "federation.auto"] as const;
const TRUTHY = /^(true|on|yes|1)\b/i;
export type Preflight = {ok: true; warnings: string[]} | {ok: false; reason: string};
/** READ-ONLY. Refuses when any automatic push/sync/stage is enabled (fail closed on an unreadable key). A Dolt remote alone only warns. */
export async function preflight(repo: string, deps: Pick<DispatchDeps, "bd">): Promise<Preflight> {
  const warnings: string[] = [];
  const get = async (k: string) => deps.bd(["--readonly", "config", "get", k], {cwd: repo, timeoutMs: 15_000});
  for (const k of AUTO_KEYS) {
    let r: RunResult;
    try { r = await get(k); } catch (e) { return {ok: false, reason: `cannot read bd config ${k}: ${(e as Error).message}`}; }
    if (r.code !== 0) return {ok: false, reason: `cannot read bd config ${k} (exit ${r.code}); refusing to claim`};
    if (TRUTHY.test(r.stdout.trim())) return {ok: false, reason: `bd config ${k} is enabled (automatic push/sync/staging); disable it before dispatching`};
  }
  try {
    const b = await get("backup.enabled");
    if (b.code === 0 && TRUTHY.test(b.stdout.trim())) warnings.push("bd auto-backup is enabled (backup.enabled)");
    const rem = await deps.bd(["--readonly", "dolt", "remote", "list"], {cwd: repo, timeoutMs: 15_000});
    if (rem.code !== 0) warnings.push("could not list Dolt remotes");
    else if (!/No remotes configured/i.test(rem.stdout + rem.stderr)) warnings.push("a Dolt remote is configured (Osiris never pushes)");
  } catch (e) { warnings.push(`warning checks failed: ${(e as Error).message}`); }
  return {ok: true, warnings};
}

// ---- the ONE write -------------------------------------------------------------------------------------------------
const ACTOR_RE = /^[A-Za-z0-9._:-]{1,64}$/;
/** Classify bd's own CAS result: rc 0 -> ok (idempotent for the same actor); "already claimed by X" / `held by "X"` -> takenBy X. */
export function classifyClaim(code: number, text: string, actor: string): ClaimOutcome {
  if (code === 0) return {ok: true, actor};
  const m = /already claimed by ([^\s"]+)/.exec(text) ?? /held by "([^"]+)"/.exec(text);
  if (m) return {ok: false, takenBy: m[1], reason: `already claimed by ${m[1]}`};
  return {ok: false, takenBy: null, reason: (text.trim().split("\n").find((l) => /error/i.test(l)) ?? text.trim()).slice(0, 300) || `bd exited ${code}`};
}
/** The ONLY beads write in Osiris. bd's atomic compare-and-set; never combined with --if-* (bd refuses). No labels ride on
 * it: the safety scan forbids label writes, so the claim argv is exactly `update <id> --claim`. */
export async function claimBead(repo: string, id: string, actor: string, deps: Pick<DispatchDeps, "bd">): Promise<ClaimOutcome> {
  if (!ACTOR_RE.test(actor)) return {ok: false, takenBy: null, reason: "invalid actor"};
  try {
    const r = await deps.bd(["--actor", actor, "update", id, "--claim"], {cwd: repo, timeoutMs: 20_000});
    return classifyClaim(r.code, r.stderr + "\n" + r.stdout, actor);
  } catch (e) { return {ok: false, takenBy: null, reason: `could not run bd: ${(e as Error).message}`}; }
}

// ---- preview -------------------------------------------------------------------------------------------------------
const BASE_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;
const validate = (req: DispatchRequest): string | null =>
  typeof req.repo !== "string" || !isAbsolute(req.repo) ? "repo must be an absolute path" : typeof req.beadId !== "string" || req.beadId.length > 64 || !BEAD_ID_RE.test(req.beadId) ? "invalid bead id"
  : !RUNTIMES.includes(req.runtime) ? "unknown runtime" : req.model !== null && (typeof req.model !== "string" || !MODEL_RE.test(req.model)) ? "model id must match [A-Za-z0-9._:-]{1,64}"
  : !isAllowedModel(req.runtime, req.model) ? `model "${String(req.model)}" is not in the allowed list for ${req.runtime}`
  : req.base !== undefined && (!BASE_RE.test(req.base) || req.base.includes("..")) ? "invalid base ref" : null;

type Read = {ok: true; bead: LaneBead; map: Map<string, WorkIssue>; deps: WorkDep[]; ready: string | null} | {ok: false; reason: string};
async function readBead(repo: string, id: string, deps: DispatchDeps): Promise<Read> {
  const snap = await fetchWorkSnapshot({runner: (a, t) => deps.bd(["--readonly", ...a], {cwd: repo, timeoutMs: t})});
  if (!snap.ok) return {ok: false, reason: snap.error.message};
  const issue = snap.value.issues.find((i) => i.id === id);
  if (!issue) return {ok: false, reason: `bead ${id} not found`};
  let extra: Record<string, unknown> = {};
  const r = await deps.bd(["--readonly", "show", id, "--json"], {cwd: repo, timeoutMs: 15_000});
  if (r.code === 0) { try { const a = JSON.parse(r.stdout); if (Array.isArray(a) && a[0] && typeof a[0] === "object") extra = a[0]; } catch { /* list data alone is enough */ } }
  const s = (k: string) => (typeof extra[k] === "string" && extra[k] ? (extra[k] as string) : undefined);
  const bead: LaneBead = {...issue, description: s("description"), notes: s("notes"), acceptance: s("acceptance_criteria"), owner: s("owner")};
  // M1: only READY beads dispatch (the work-model ready frontier: open, no unresolved blocks edge) and nobody holds them. bd's own --claim
  // only refuses closed beads, and the RPC input comes from the client, so this is the server's gate, not the UI's.
  const g = buildWorkGraph(snap.value.issues, snap.value.deps, deps.now()), blockers = g.blocked.find((b) => b.id === id)?.blockers ?? [];
  const ready = issue.status !== "open" ? `bead ${id} is ${issue.status}, not open: only a ready bead can be dispatched`
    : issue.type === "epic" ? `bead ${id} is an epic: dispatch one of its children`
    : issue.assignee ? `bead ${id} is already assigned to ${cleanText(issue.assignee, 64)}`
    : blockers.length ? `bead ${id} is blocked by ${blockers.slice(0, 5).join(", ")}${blockers.length > 5 ? ` and ${blockers.length - 5} more` : ""}: finish those first`
    : !g.readyFrontier.includes(id) ? `bead ${id} is not on the ready frontier` : null;
  return {ok: true, bead, map: new Map(snap.value.issues.map((i) => [i.id, i])), deps: snap.value.deps, ready};
}

type Built = {ok: true; pv: Extract<DispatchPreview, {ok: true}>; repo: string; digest: string} | {ok: false; reason: string};
/** M3: what the owner reviewed, as one hash: the prompt text, the launch argv, the base ref and the hooks that would run. */
export const reviewDigest = (pv: {prompt: string; argv: string[]; hooks?: string[]}, base?: string): string => createHash("sha256").update(pv.prompt).update("\0").update(JSON.stringify(pv.argv)).update("\0").update(base ?? "").update("\0").update(JSON.stringify(pv.hooks ?? [])).digest("hex");
/** Read-only core of preview AND dispatch: realpath the repo (L3), read the bead, refuse non-ready beads (M1), build prompt, argv and launch.sh now (M2). */
async function buildPreview(req: DispatchRequest, deps: DispatchDeps): Promise<Built> {
  const bad = validate(req); if (bad) return {ok: false, reason: bad};
  const v = await validateRepo(req.repo); if (!v.ok) return {ok: false, reason: v.reason};
  const repo = v.value;
  const rd = await readBead(repo, req.beadId, deps); if (!rd.ok) return rd;
  if (rd.ready) return {ok: false, reason: rd.ready};
  if (/[\0\r\n]/.test(rd.bead.id) || rd.bead.title.includes("\0")) return {ok: false, reason: "bead id or title contains a NUL or line break and cannot be launched"};
  const branch = branchFor(rd.bead), worktree = worktreeFor(repo, rd.bead), paneTitle = paneTitleFor(rd.bead);
  if (paneTitle.startsWith("-") || /[\0-\x1f]/.test(paneTitle)) return {ok: false, reason: "pane title is not safe to pass to herdr"};
  const prompt = buildLanePrompt(rd.bead, rd.deps, rd.map, {worktree, branch, paneTitle});
  const a = buildArgv(req.runtime, {model: req.model, prompt, worktree, beadId: rd.bead.id}, deps.which); if (!a.ok) return {ok: false, reason: a.reason};
  try { launchScript(a.argv); } catch (e) { return {ok: false, reason: `launch script cannot be built: ${(e as Error).message}`}; }
  const hooks = await detectHooks(repo, deps), pv: Extract<DispatchPreview, {ok: true}> = {ok: true, prompt, argv: a.argv, branch, worktree, paneTitle, hooks};
  return {ok: true, repo, pv, digest: reviewDigest(pv, req.base)};
}

/** Read-only apart from minting the in-memory single-use token (S2). Never claims, never touches herdr. */
export async function previewDispatch(req: DispatchRequest, deps: DispatchDeps): Promise<DispatchPreview> {
  // L2: one preview per bead per 2 s, so a spammer can neither fork bd processes nor flush the owner's token out of the 200-token store.
  const g = deps.guard, pk = `${req.repo}\0${req.beadId}`, now = deps.now(), prev = g.previewed.get(pk);
  if (prev !== undefined && now - prev < PREVIEW_MS) return {ok: false, reason: `preview again in ${Math.ceil((PREVIEW_MS - (now - prev)) / 1000)} s (one preview per bead per ${PREVIEW_MS / 1000} s)`};
  g.previewed.set(pk, now); if (g.previewed.size > 500) g.previewed.delete(g.previewed.keys().next().value!);
  // Review W-3B/W-3A L-E: the preview path's text reaches the trust prompt, so it is scrubbed like the dispatch path's.
  const b = await buildPreview(req, deps); if (!b.ok) return {...b, reason: scrub(b.reason)};
  b.pv.hooks = b.pv.hooks?.map(h => cleanText(h, 200));
  return {...b.pv, token: issueToken(g, tokenKey({...req, repo: b.repo}), deps.now(), {digest: b.digest, hooks: b.pv.hooks})};
}

// ---- dispatch ------------------------------------------------------------------------------------------------------
const paneIdOf = (stdout: string): string | null => {
  try { const p = JSON.parse(stdout)?.result?.root_pane?.pane_id; return typeof p === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/.test(p) ? p : null; } catch { return null; }
};
export const WORKSPACE_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
/** M4: the Herdr workspace that already shows this repo (`herdr worktree list --cwd` -> .result.source.source_workspace_id), or null. */
export async function workspaceFor(repo: string, deps: Pick<DispatchDeps, "herdr">): Promise<string | null> {
  try {
    const r = await deps.herdr(["worktree", "list", "--cwd", repo], {cwd: repo, timeoutMs: 15_000}); if (r.code !== 0) return null;
    const id = JSON.parse(r.stdout)?.result?.source?.source_workspace_id; return typeof id === "string" && WORKSPACE_RE.test(id) ? id : null;
  } catch { return null; }
}
const OTEL_BEAD_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * Telemetry stamp for the launched agent: `bead=<id>,lane=<name>` (the value of OTEL_RESOURCE_ATTRIBUTES), so cost telemetry can
 * join a transcript to its bead exactly. Built ONLY from the bead id and the claim actor, each checked against a strict allowlist
 * that excludes every shell metacharacter and the stamp's own separators (`,` and `=`). Anything else returns null (no stamp);
 * a bad value can never reach the launch script. Never part of the claim path.
 */
export const otelAttrs = (beadId: string, lane: string): string | null => (OTEL_BEAD_RE.test(beadId) && ACTOR_RE.test(lane) ? `bead=${beadId},lane=${lane}` : null);
/** `attrs` (from otelAttrs) is exported as OTEL_RESOURCE_ATTRIBUTES, single-quoted like every other word in this script. */
export const launchScript = (argv: string[], attrs?: string | null) => `#!/bin/sh\n# Written by Osiris dispatch. argv is single-quoted word by word.\ncd "$(dirname "$0")/.." || exit 1\n${attrs ? `OTEL_RESOURCE_ATTRIBUTES=${shSingleQuote(attrs)}\nexport OTEL_RESOURCE_ATTRIBUTES\n` : ""}exec ${argv.map(shSingleQuote).join(" ")}\n`;

export async function dispatch(req: DispatchRequest, deps: DispatchDeps): Promise<DispatchResult> {
  const stop = (reason: string): DispatchResult => ({ok: false, stage: "validate", reason});
  const bad = validate(req); if (bad) return stop(bad);
  const v = await validateRepo(req.repo); if (!v.ok) return stop(v.reason);
  const repo = v.value, key = tokenKey({...req, repo}), bead = `${repo}\0${req.beadId}`, g = deps.guard;
  // S2: token present, unexpired, unused and bound to THIS selection. Checked first so a bad call costs no bd/herdr process.
  const tk = checkToken(g, req.token, key, deps.now(), false); if (tk) return stop(tk);
  // S3: one in flight per bead, and at most one dispatch per bead per 60 s.
  if (g.inflight.has(bead)) return stop(`bead ${req.beadId} is already being dispatched`);
  const since = deps.now() - (g.last.get(bead) ?? -Infinity);
  if (since < RATE_MS) return stop(`rate limited: one dispatch per bead per ${RATE_MS / 1000} s (try again in ${Math.ceil((RATE_MS - since) / 1000)} s)`);
  g.inflight.add(bead);
  try { return await run({...req, repo}, key, bead, deps); } finally { g.inflight.delete(bead); }
}

async function run(req: DispatchRequest, key: string, bead: string, deps: DispatchDeps): Promise<DispatchResult> {
  const stop = (reason: string): DispatchResult => ({ok: false, stage: "validate", reason: scrub(reason)});
  const b = await buildPreview(req, deps); if (!b.ok) return stop(b.reason);
  const pv = b.pv;
  // M3: the token is bound to what the owner reviewed; a bead edited since the preview (or a new hook) changes the digest.
  const chg = checkToken(deps.guard, req.token, key, deps.now(), false, b.digest); if (chg) return stop(chg);
  // M1: a repo that runs its own code on dispatch needs the owner's explicit trust.
  if (pv.hooks?.length && req.trustHooks !== true) return stop(`this repo runs code when you dispatch (${pv.hooks.join(", ")}); confirm that you trust the repo's hooks`);
  const pf = await preflight(req.repo, deps); if (!pf.ok) return stop(pf.reason);
  const ws = await workspaceFor(req.repo, deps); if (!ws) return stop(`Open ${req.repo} in Herdr first (no workspace shows this repo, and Osiris will not create one)`);
  // Point of no return: burn the token (atomic with the check) and stamp the rate limiter.
  const tk = checkToken(deps.guard, req.token, key, deps.now(), true, b.digest); if (tk) return stop(tk);
  deps.guard.last.set(bead, deps.now()); if (deps.guard.last.size > 500) deps.guard.last.delete(deps.guard.last.keys().next().value!);
  const actor = deps.actor ?? `osiris-${req.runtime}-${deps.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const c = await claimBead(req.repo, req.beadId, actor, deps);
  if (!c.ok) return {ok: false, stage: "claim", reason: scrub(c.reason), takenBy: c.takenBy === null ? null : scrub(c.takenBy)};
  // CLAIMED. From here a failure reports its stage and does NOT unclaim: unclaiming would be a SECOND beads write path, which
  // Osiris forbids. M3: it names what was left behind and the manual release command, and returns the worktree/pane for the UI.
  let pane: string | null = null, worktree: string | null = null;
  const fail = (stage: "worktree" | "pane" | "launch", reason: string): DispatchResult => ({ok: false, stage, reason: `${scrub(reason)} (bead ${req.beadId} stays claimed by ${actor}${worktree ? `; left behind: worktree ${worktree}` : ""}${pane ? `, pane ${pane}` : ""}; to release it by hand run (bd's own compare-and-set release, the inverse of claim): bd --actor ${actor} unclaim ${req.beadId} --if-assignee ${actor})`, ...(worktree ? {worktree} : {}), ...(pane ? {paneId: pane} : {})});
  const h = (args: string[]) => deps.herdr(args, {cwd: req.repo, timeoutMs: 60_000});
  try {
    await deps.fs.mkdir(dirname(pv.worktree));
    const wt = await h(worktreeCreateArgv(ws, pv, req.base ?? "HEAD"));
    if (wt.code !== 0) return fail("worktree", `herdr worktree create failed: ${wt.stderr.trim().slice(0, 300)}`);
    worktree = pv.worktree; pane = paneIdOf(wt.stdout);
    if (!pane) return fail("worktree", "herdr worktree create returned no usable .result.root_pane.pane_id");
    // Review W-4 MED-2: --workspace alone names the repo only indirectly (via the workspace's source). Before anything runs in
    // the new worktree, its git common dir must BE this repo's; otherwise (or when unreadable) stop before the launch.
    const own = await sameRepo(deps.git, req.repo, pv.worktree);
    if (own !== true) return fail("worktree", own === false ? "the new worktree does not belong to this repo (herdr used another workspace); the agent was not started" : "could not confirm the new worktree belongs to this repo; the agent was not started");
    const rn = await h(["pane", "rename", pane, pv.paneTitle]);
    if (rn.code !== 0) return fail("pane", `herdr pane rename failed: ${rn.stderr.trim().slice(0, 300)}`);
    const md = await h(["pane", "report-metadata", pane, "--source", "osiris", "--display-agent", req.beadId]);
    if (md.code !== 0) return fail("pane", `herdr pane report-metadata failed: ${md.stderr.trim().slice(0, 300)}`);
    try {
      const unsafe = await deps.prepareLaunch(pv.worktree); if (unsafe) return fail("launch", unsafe);
      await deps.fs.mkdir(join(pv.worktree, ".osiris"));
      await deps.fs.writeFile(join(pv.worktree, ".osiris", "prompt.md"), pv.prompt);
      await deps.fs.writeFile(join(pv.worktree, ".osiris", "launch.sh"), launchScript(pv.argv, otelAttrs(req.beadId, actor)));
      // L7: keep the launch files out of `git status` (the worktree's own info/exclude), instead of asking the agent not to commit them.
      const ex = await deps.excludePath(pv.worktree); if (!ex) throw new Error("could not resolve the worktree's info/exclude");
      await deps.fs.mkdir(dirname(ex)); await deps.fs.appendFile(ex, "\n.osiris/\n");
    } catch (e) { return fail("launch", `could not write launch files: ${(e as Error).message}`); }
    const rr = await h(["pane", "run", pane, "sh .osiris/launch.sh"]);
    if (rr.code !== 0) return fail("launch", `herdr pane run failed: ${rr.stderr.trim().slice(0, 300)}`);
    return {ok: true, branch: pv.branch, worktree: pv.worktree, paneId: pane, actor};
  } catch (e) { return fail("worktree", `herdr could not run: ${(e as Error).message}`); }
}
