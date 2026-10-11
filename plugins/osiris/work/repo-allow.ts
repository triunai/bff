// S4: the repo allowlist. EVERY rpc that takes a `repo` or `dir` (server.ts) calls assertAllowedRepo() first, so a hostile caller cannot
// point git/bd/herdr/readers at /etc, a home directory or a repo the owner never opened. One definition; server.test pins that every
// handler uses it. allowed = realpath of: discoverRepos() results + BB project source paths + paths pinned through pinRepo (kv, <=50)
// + the default projects dir. Paths are compared as REALPATHS, so `..` tricks and symlinks into a disallowed place resolve first.
// HONEST LIMIT: this is not authentication. A local process can still call BB's API (127.0.0.1) and pinRepo any git repo; it raises the
// bar against a confused page, another plugin or a typo, it does not stop a determined local user (who can read the disk anyway).
import {realpath} from "node:fs/promises";
import {isAbsolute} from "node:path";
import {DeadlineError, withDeadline} from "./deadline.ts";

/** A dependency that never answers (BB's project list while the host is starved) must not hold every git RPC forever: it counts as empty. */
export const DEP_DEADLINE_MS = 5_000;
export const PIN_KEY = "repos.pinned.v1", PIN_MAX = 50, ALLOW_TTL_MS = 30_000, REFRESH_MIN_MS = 5_000;
export const NOT_ALLOWED = "not an allowed repository: open it as a BB project or pin it from the repo picker first";
export interface RepoGuardDeps {
  discover: () => Promise<string[]>; projects: () => Promise<string[]>; defaultDir: () => string;
  kvGet: () => Promise<unknown>; kvSet: (v: string[]) => Promise<void>; now: () => number;
  /** validates a path to pin as a git repo and returns its realpath, or a plain reason */
  validateRepo: (p: string) => Promise<{ok: true; value: string} | {ok: false; reason: string}>;
}
const real = async (p: string): Promise<string | null> => { try { return await realpath(p); } catch { return null; } };
const reals = async (ps: readonly string[]): Promise<string[]> => (await Promise.all(ps.map(real))).filter((x): x is string => x !== null);
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export const HOST_BUSY = "couldn't confirm this repo is allowed: the host is busy (BB or a dependency did not answer in time); wait a moment and press Refresh";
/** Thrown on a miss against a DEGRADED allowlist (a dependency timed out). Still fail-CLOSED: the repo is not admitted, but the text says why. */
export class AllowlistBusyError extends Error { constructor() { super(HOST_BUSY); this.name = "AllowlistBusyError"; } }

/** The seam guards' view of the allowlist: true / false for a real answer, "busy" when it could not be checked (never folded into false: a busy host is not a violation). */
export async function repoAllowedFact(assertAllowed: (p: string) => Promise<string>, path: string): Promise<boolean | "busy"> {
  try { await assertAllowed(path); return true; } catch (e) { return e instanceof AllowlistBusyError ? "busy" : false; }
}

export function makeRepoGuard(d: RepoGuardDeps) {
  type Snap = {set: Set<string>; degraded: boolean};
  let cache: (Snap & {at: number}) | null = null, built = -Infinity, flight: Promise<Snap> | null = null, gen = 0;
  const dl = <T>(p: Promise<T>, what: string): Promise<T> => withDeadline(p, DEP_DEADLINE_MS, `${what} did not answer`);
  const buildNow = async (myGen: number): Promise<Snap> => {
    let degraded = false;
    const soft = <T>(p: Promise<T>, what: string): Promise<T | never[]> => dl(p, what).catch(e => { if (e instanceof DeadlineError) degraded = true; return []; });
    const [disc, proj, pinned, dflt] = await Promise.all([soft(d.discover(), "discover"), soft(d.projects(), "projects"), soft(d.kvGet(), "kv").then(asList), real(d.defaultDir())]);
    const set = new Set<string>([...await reals(disc as string[]), ...await reals(proj as string[]), ...await reals(pinned)]); if (dflt) set.add(dflt);
    // a pin/unpin during this build bumped `gen`: the result is stale, so it is returned to ITS callers but never cached
    if (myGen === gen) { cache = {at: d.now(), set, degraded}; built = d.now(); }
    return {set, degraded};
  };
  /** ONE rebuild at a time per generation; callers after a pin/unpin start a fresh flight. */
  const build = (): Promise<Snap> => {
    if (flight) return flight;
    const f: Promise<Snap> = buildNow(gen).finally(() => { if (flight === f) flight = null; });
    return (flight = f);
  };
  const invalidate = () => { gen++; cache = null; built = -Infinity; flight = null; };
  /** Resolve `path` to its realpath and require it in the allowed set; returns the realpath. Throws a plain Error otherwise (same text whether or not the path exists). */
  async function assertAllowedRepo(path: unknown): Promise<string> {
    if (typeof path !== "string" || !path || path.length > 4096 || path.includes("\0") || !isAbsolute(path)) throw new Error(NOT_ALLOWED);
    const r = await real(path); if (!r) throw new Error(NOT_ALLOWED);
    if (cache && d.now() - cache.at < ALLOW_TTL_MS && cache.set.has(r)) return r;
    // a miss (or a stale cache) rebuilds, but never more than once per REFRESH_MIN_MS so a hostile loop cannot make us rescan the disk
    const snap: Snap = cache && d.now() - built < REFRESH_MIN_MS ? cache : await build();
    if (!snap.set.has(r)) throw snap.degraded ? new AllowlistBusyError() : new Error(NOT_ALLOWED);
    return r;
  }
  /** Keep only the allowed paths (gitRepos `extra`): hostile entries are dropped silently, never probed. A BUSY allowlist is NOT silent: it throws so the picker shows the error. */
  async function filterAllowedRepos(paths: readonly string[]): Promise<string[]> {
    const out: string[] = []; for (const p of paths) { try { out.push(await assertAllowedRepo(p)); } catch (e) { if (e instanceof AllowlistBusyError) throw e; /* dropped */ } } return out;
  }
  /** Pin a git repo (kv, <=50). Returns its realpath. */
  async function pinRepo(path: unknown): Promise<string> {
    if (typeof path !== "string" || !path || path.includes("\0") || !isAbsolute(path)) throw new Error("pin: an absolute path to a git repository is required");
    const v = await d.validateRepo(path); if (!v.ok) throw new Error(`pin: ${v.reason}`);
    const cur = asList(await d.kvGet().catch(() => [])); if (cur.includes(v.value)) return v.value;
    if (cur.length >= PIN_MAX) throw new Error(`pin: at most ${PIN_MAX} pinned repositories`);
    await d.kvSet([...cur, v.value]); invalidate(); return v.value;
  }
  /** W-2A L3: the pinned list (what the owner can repair) and removal of ONE pinned path (raw or realpath spelling). Not a way to allow anything. */
  const listPinned = async (): Promise<string[]> => asList(await d.kvGet().catch(() => []));
  async function unpinRepo(path: unknown): Promise<string[]> {
    if (typeof path !== "string" || !path || path.length > 4096 || path.includes("\0")) throw new Error("unpin: a path is required");
    const cur = asList(await d.kvGet().catch(() => [])), r = (await real(path)) ?? path, next = cur.filter(p => p !== path && p !== r);
    if (next.length !== cur.length) { await d.kvSet(next); invalidate(); }
    return next;
  }
  return {assertAllowedRepo, filterAllowedRepos, pinRepo, listPinned, unpinRepo, allowed: async () => [...(await build()).set]};
}
