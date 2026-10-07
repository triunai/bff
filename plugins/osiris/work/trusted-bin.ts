// THE trusted-binary primitive (ADR D-139, td-osi.36). Server-only. Every child process Osiris starts goes through this ONE module, and a fitness test
// (work/__tests__/trusted-bin.fitness.test.ts) fails if `child_process` is imported anywhere else.
//
// Two halves, deliberately in one file so a rule can never exist in one half only:
//   1. RESOLVE: `resolveTrusted(name)` finds an absolute program in a FIXED per-OS directory list. There is NO PATH lookup and NO environment override.
//      The program must be a regular executable file, not writable by group/other, owned by root or the current user, every directory above its REAL
//      path must be owned by root/us and not world-writable, and a symlink is followed with realpath and the TARGET re-checked.
//   2. SPAWN: `trustedSpawn(bin, argv, ...)` re-vets that path at USE time (nothing is trusted because it was trusted earlier), runs it with argv only
//      (no shell), and builds the child's environment from a minimal explicit base. Loader/injection variables can never reach a child.
// Cached: the WINNING CANDIDATE per (name, policy). Never cached: trust. Every call re-validates the winner, so a binary swapped after the first call is
// refused on the next one (the window is one call, same as the herdr contract it replaces).
import { execFile, type ChildProcess } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Trust primitives (moved here from herdr-feed.ts; re-exported there for the herdr tests)
// ---------------------------------------------------------------------------------------------------------------------------------------------
export type TrustSt = { uid: number; mode: number; isFile: boolean; isDir: boolean };
export type TrustFs = { realpath(p: string): string; stat(p: string): TrustSt; execOk(p: string): boolean; uid: number | undefined };
export const realFs: TrustFs = {
  realpath: p => realpathSync(p),
  stat: p => { const s = statSync(p); return { uid: s.uid, mode: s.mode, isFile: s.isFile(), isDir: s.isDirectory() }; },
  execOk: p => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } },
  uid: process.getuid?.(),
};
/** Owned by this user or root, and not writable by group/other (a binary anyone can replace is not trusted). */
export const trustedFile = (st: { uid: number; mode: number }, uid: number | undefined): boolean => (st.uid === 0 || st.uid === uid) && (st.mode & 0o022) === 0;
/** A directory on the real path's chain: owned by this user or root and not world-writable. Group-writable is ACCEPTED when the owner is us/root, because
 * Homebrew's own layout is 0775 owner:admin (/opt/homebrew/bin, Cellar) on the owner's Mac; a foreign-owned or world-writable directory anywhere above the
 * binary is rejected, since its owner could swap the binary. (A sticky world-writable dir such as /tmp is refused too: Osiris targets macOS, where tmpdir() is private.) */
export const trustedDir = (st: { uid: number; mode: number }, uid: number | undefined): boolean => (st.uid === 0 || st.uid === uid) && (st.mode & 0o002) === 0;

/** Why a candidate was refused. Typed so callers and tests branch on the reason, never on message text. */
export type TrustRefusal =
  | "not-found"            // nothing at any candidate path
  | "not-absolute"         // a relative or NUL-bearing path: PATH could substitute it
  | "bad-name"             // a bare name that is not a plain file name
  | "location"             // the directory is not in the fixed allowlist
  | "not-regular-file"
  | "not-executable"
  | "writable"             // group- or other-writable file
  | "foreign-owner"        // owned by neither root nor the current user
  | "not-root-owned"       // rootOnly policy and the owner is not root
  | "untrusted-directory"  // a directory above the real path is foreign-owned or world-writable
  | "symlink-refused"      // an alias that policy does not allow (or one leading outside its allowed target)
  | "bad-argv";
/** `path` is the REAL path; `via` is the validated candidate (the alias, when there was one). */
export type Vet = { ok: true; path: string; via: string } | { ok: false; reason: TrustRefusal; detail: string };

export type TrustPolicy = {
  /** Directories to search INSTEAD of the OS default (absolute). Order is priority. */
  dirs?: readonly string[];
  /** Directories searched AFTER the default list (per-binary extras, e.g. ~/.cargo/bin). */
  extraDirs?: readonly string[];
  /** Where a symlink may lead. Default: a Homebrew Cellar `.../Cellar/<formula>/<version>/bin/<name>`. "trusted": any target that passes every check.
   * "none": no symlink at all. A RegExp: the real path must match it. */
  aliasTargets?: RegExp | "trusted" | "none";
  /** The file must be owned by ROOT (system programs such as /usr/bin/env and caffeinate). Implies no symlink. */
  rootOnly?: boolean;
  home?: string;
  /** Test seam only: a fake file system. A call with a fake fs never touches the cache. */
  fsx?: TrustFs;
};

/** The fixed per-OS directory list. NEVER derived from PATH or the environment (BB hands plugins a curated PATH; a hostile PATH must change nothing). */
export function systemDirs(home = homedir(), platform: string = process.platform): string[] {
  const common = [join(home, ".local", "bin")];
  if (platform === "darwin") return ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin", ...common];
  return ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin", ...common];
}
const effectiveDirs = (p: TrustPolicy): string[] => [...(p.dirs ?? systemDirs(p.home)), ...(p.extraDirs ?? [])];
const cellarFor = (name: string): RegExp => new RegExp(`^(?:/opt/homebrew|/usr/local)/Cellar/[^/]+/[^/]+/bin/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
/** The beads formula installs the real program as `beads` and links `bd` to it inside the same Cellar bin, so a `bd` alias may end at either name, in the beads formula only. */
export const CELLAR_BD = /^(?:\/opt\/homebrew|\/usr\/local)\/Cellar\/beads\/[^/]+\/bin\/(?:bd|beads)$/;
/** The herdr-only pin kept for the herdr tests: a herdr alias may only lead into the herdr formula. */
export const CELLAR_HERDR = /^(?:\/opt\/homebrew|\/usr\/local)\/Cellar\/herdr\/[^/]+\/bin\/herdr$/;

const bad = (reason: TrustRefusal, detail: string): Vet => ({ ok: false, reason, detail });

/** Validate ONE absolute candidate under `policy` and return its REAL path (never the alias). Pure given `policy.fsx`. */
export function vetPath(candidate: string, policy: TrustPolicy = {}): Vet {
  if (typeof candidate !== "string" || !candidate || candidate.includes("\0") || !isAbsolute(candidate)) return bad("not-absolute", "the program path must be absolute (a bare name would be found through PATH)");
  const fsx = policy.fsx ?? realFs, name = basename(candidate), dir = dirname(candidate), rootOnly = policy.rootOnly === true;
  const target: RegExp | "trusted" | "none" = rootOnly ? "none" : policy.aliasTargets ?? cellarFor(name);
  // LOCATION first, before the file system is touched: the candidate sits in the allowlist, or it is the already-resolved real path of a permitted alias (what
  // resolveTrusted returned, re-vetted at spawn time).
  const inList = effectiveDirs(policy).includes(dir), resolvedAlias = target instanceof RegExp && target.test(candidate);
  if (!inList && !resolvedAlias) return bad("location", `${dir} is not one of the fixed program directories`);
  let real: string, st: TrustSt;
  try { real = fsx.realpath(candidate); st = fsx.stat(real); } catch { return bad("not-found", `${candidate} does not exist`); }
  const aliased = real !== candidate;
  if (aliased && !inList) return bad("location", `${candidate} is a symlink outside the fixed program directories`);
  if (aliased) {
    if (target === "none") return bad("symlink-refused", `${candidate} is a symlink and this program must be a plain file`);
    if (target !== "trusted" && !target.test(real)) return bad("symlink-refused", `${candidate} leads to ${real}, which is not an allowed target`);
  }
  if (!st.isFile) return bad("not-regular-file", `${real} is not a regular file`);
  if (!fsx.execOk(real)) return bad("not-executable", `${real} is not executable`);
  if (rootOnly && st.uid !== 0) return bad("not-root-owned", `${real} is not owned by root`);
  if (st.uid !== 0 && st.uid !== fsx.uid) return bad("foreign-owner", `${real} belongs to another user`);
  if ((st.mode & 0o022) !== 0) return bad("writable", `${real} is writable by group or other`);
  try {
    for (let d = dirname(real); ; d = dirname(d)) {
      if (!trustedDir(fsx.stat(d), fsx.uid)) return bad("untrusted-directory", `${d} (above ${real}) is foreign-owned or world-writable`);
      if (dirname(d) === d) break;
    }
  } catch { return bad("not-found", `a directory above ${real} cannot be inspected`); }
  return { ok: true, path: real, via: candidate };
}

const winners = new Map<string, string>();
const policyKey = (name: string, p: TrustPolicy): string => JSON.stringify([name, effectiveDirs(p), p.rootOnly === true, p.aliasTargets instanceof RegExp ? p.aliasTargets.source : p.aliasTargets ?? null]);
/** Test hook: forget every cached winner. */
export const clearTrustCache = (): void => winners.clear();

/** Find `name` in the fixed directories (first trusted wins). `name` may be a plain file name or an absolute path whose directory is in the list.
 * Re-validates on EVERY call; only the winning candidate is remembered. Refuses with the most informative typed reason when nothing is trusted. */
export function resolveTrusted(name: string, policy: TrustPolicy = {}): Vet {
  const dirs = effectiveDirs(policy);
  let cands: string[];
  if (isAbsolute(name)) cands = [name];
  else if (!name || name.includes("/") || name.includes("\0") || name === "." || name === ".." || name.startsWith("-")) return bad("bad-name", "a program name must be a plain file name");
  else cands = dirs.map(d => join(d, name));
  const key = policyKey(name, policy), cached = policy.fsx ? undefined : winners.get(key);
  if (cached) { const v = vetPath(cached, policy); if (v.ok) return v; winners.delete(key); }
  let worst: Vet | null = null;
  for (const c of cands) {
    const v = vetPath(c, policy);
    if (v.ok) { if (!policy.fsx) winners.set(key, c); return v; }
    if (!worst || (worst.ok === false && worst.reason === "not-found" && v.reason !== "not-found")) worst = v;
  }
  return worst ?? bad("not-found", `${name} was not found in ${dirs.join(", ")}`);
}
/** The validated CANDIDATE path (the alias, e.g. ~/.local/bin/claude) rather than its real path. ONLY for a program that someone else launches (an agent CLI typed into a Herdr pane): many CLIs find
 * their install through argv0 / a `current` symlink, so the alias must survive. Osiris itself never execs this path; its own spawns use the real path, re-vetted. */
export const resolveTrustedVia = (name: string, policy: TrustPolicy = {}): string | null => { const v = resolveTrusted(name, policy); return v.ok ? v.via : null; };
/** Convenience for callers that only need the path (null when refused). Same rules, same re-validation. */
export const resolveTrustedPath = (name: string, policy: TrustPolicy = {}): string | null => { const v = resolveTrusted(name, policy); return v.ok ? v.path : null; };

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Child environment: a minimal explicit base. Nothing is inherited except what the caller NAMES.
// ---------------------------------------------------------------------------------------------------------------------------------------------
/** Variables that change what a program LOADS or RUNS before main(). Never inherited, and refused outright when passed explicitly.
 * GIT_CONFIG_NOSYSTEM is the one GIT_CONFIG* name allowed explicitly: it only turns the system config OFF (git-feed's hardening). */
export const LOADER_ENV = /^(?:DYLD_|LD_|PYTHON|PERL5|RUBY|GIT_EXEC_PATH$|GIT_CONFIG(?!_NOSYSTEM$)|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|SHELLOPTS$|BASHOPTS$|IFS$|CDPATH$|PROMPT_COMMAND$|GCONV_PATH$|LOCPATH$|NLSPATH$)/;
export type ChildEnvOpts = {
  /** Explicit variables. `undefined` removes a base variable. A LOADER_ENV name throws. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Names copied from this process when present (e.g. HERDR_SOCKET_PATH). A LOADER_ENV name throws. */
  inherit?: readonly string[];
  home?: string;
  /** Source of the inherited names; defaults to process.env. */
  from?: NodeJS.ProcessEnv;
};
const langOf = (v: string | undefined): string => (v && /^[A-Za-z0-9_.@-]{1,32}$/.test(v) ? v : "en_US.UTF-8");
export function childEnv(o: ChildEnvOpts = {}): Record<string, string> {
  const from = o.from ?? process.env, home = o.home ?? (from.HOME && isAbsolute(from.HOME) ? from.HOME : homedir());
  const out: Record<string, string> = { PATH: systemDirs(home).join(":"), HOME: home, LANG: langOf(from.LANG) };
  for (const n of o.inherit ?? []) { if (LOADER_ENV.test(n)) throw new Error(`refusing to inherit ${n} into a child process`); const v = from[n]; if (v !== undefined) out[n] = v; }
  for (const [k, v] of Object.entries(o.env ?? {})) {
    if (LOADER_ENV.test(k)) throw new Error(`refusing to pass ${k} to a child process`);
    if (v === undefined) delete out[k]; else if (v.includes("\0")) throw new Error(`NUL in the value of ${k}`); else out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------------------------------------------------------------------------
export type SpawnOpts = ChildEnvOpts & { cwd?: string; timeoutMs?: number; maxBuffer?: number; trust?: TrustPolicy; /** trustedSpawnChild only: start in its own process group with no stdio (a GUI launcher the caller unref()s). */ detached?: boolean };
export type SpawnOutcome =
  | { kind: "exit"; code: number; stdout: string; stderr: string }                         // it ran and exited (code may be 0)
  | { kind: "refused"; reason: TrustRefusal; detail: string }                               // nothing was executed
  | { kind: "timeout"; stdout: string; stderr: string }
  | { kind: "overflow"; stdout: string; stderr: string }
  | { kind: "error"; code: string | number | undefined; message: string; stdout: string; stderr: string }; // ENOENT after vetting, killed by signal, ...
export type RunResult = { code: number; stdout: string; stderr: string };

const argvOk = (argv: readonly string[]): boolean => Array.isArray(argv) && argv.every(a => typeof a === "string" && !a.includes("\0"));
const DEFAULT_MAX = 4 * 1024 * 1024;
const optsFor = (o: SpawnOpts) => ({ shell: false as const, cwd: o.cwd, timeout: o.timeoutMs, maxBuffer: o.maxBuffer ?? DEFAULT_MAX, encoding: "utf8" as const, windowsHide: true, env: childEnv(o), ...(o.detached ? { detached: true, stdio: "ignore" as const } : {}) });

/** Run `bin` with `argv` (an array: no shell ever). `bin` is re-vetted here, whoever resolved it. Never throws; every outcome is a typed value. */
export function trustedSpawn(bin: string, argv: readonly string[], o: SpawnOpts = {}): Promise<SpawnOutcome> {
  const v = vetPath(bin, o.trust);
  if (!v.ok) return Promise.resolve({ kind: "refused", reason: v.reason, detail: v.detail });
  if (!argvOk(argv)) return Promise.resolve({ kind: "refused", reason: "bad-argv", detail: "argv must be an array of strings without NUL" });
  return new Promise(resolve => {
    execFile(v.path, [...argv], optsFor(o), (err, stdout, stderr) => {
      const out = String(stdout ?? ""), errText = String(stderr ?? "");
      if (!err) return resolve({ kind: "exit", code: 0, stdout: out, stderr: errText });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: string | number | null };
      if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ kind: "overflow", stdout: out, stderr: errText });
      if (e.killed) return resolve({ kind: "timeout", stdout: out, stderr: errText });
      if (typeof e.code === "number") return resolve({ kind: "exit", code: e.code, stdout: out, stderr: errText });
      resolve({ kind: "error", code: e.code ?? undefined, message: e.message, stdout: out, stderr: errText });
    });
  });
}

/** Thrown by trustedRun for anything that is not "the program exited". `timeout` mirrors the shape the bd adapter already branches on. */
export class TrustedRunError extends Error {
  readonly kind: "refused" | "timeout" | "overflow" | "error";
  readonly reason?: TrustRefusal;
  constructor(message: string, kind: "refused" | "timeout" | "overflow" | "error", reason?: TrustRefusal) { super(message); this.kind = kind; this.reason = reason; }
  get timeout(): boolean { return this.kind === "timeout"; }
}
/** The `{code, stdout, stderr}` shape four callers used to hand-roll: resolves on ANY exit code, rejects (TrustedRunError) on refusal, timeout, overflow or spawn failure. */
export async function trustedRun(bin: string, argv: readonly string[], o: SpawnOpts & { label?: string } = {}): Promise<RunResult> {
  const r = await trustedSpawn(bin, argv, o), label = o.label ?? basename(bin);
  switch (r.kind) {
    case "exit": return { code: r.code, stdout: r.stdout, stderr: r.stderr };
    case "refused": throw new TrustedRunError(`${label} is not a trusted program: ${r.detail}`, "refused", r.reason);
    case "timeout": throw new TrustedRunError(`${label} timed out`, "timeout");
    case "overflow": throw new TrustedRunError(`${label} output exceeded the size bound`, "overflow");
    default: throw new TrustedRunError(r.message, "error");
  }
}

/** A long-lived child (caffeinate): same vetting and env, no output capture. Returns the child, or the refusal. The caller owns kill/exit handling. */
export function trustedSpawnChild(bin: string, argv: readonly string[], o: SpawnOpts = {}): { ok: true; child: ChildProcess } | { ok: false; reason: TrustRefusal; detail: string } {
  const v = vetPath(bin, o.trust);
  if (!v.ok) return v;
  if (!argvOk(argv)) return { ok: false, reason: "bad-argv", detail: "argv must be an array of strings without NUL" };
  return { ok: true, child: execFile(v.path, [...argv], optsFor(o), () => {}) };
}

/** Plain words for a refusal, for UI and logs. */
export const refusalText = (name: string, r: { reason: TrustRefusal; detail: string }): string => `${name} is not a trusted program (${r.reason}): ${r.detail}`;
