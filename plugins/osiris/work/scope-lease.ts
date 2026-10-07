// Scope leases: a bead claim stops two agents taking the same TASK; a scope lease stops two agents editing the same CODE.
// Pure and deterministic: no clock, no I/O, no storage. Every function takes `now` (epoch ms) and returns new values.
//
// CONSERVATIVE BY DESIGN: when overlap cannot be decided cheaply, `overlaps` answers true. A false positive only queues a
// dispatch; a false negative lets two agents collide. Known deliberate over-reports: two segments that both contain a
// wildcard always "overlap"; `*`/`?` match dotfiles (POSIX would not); `[..]` and `{..}` are treated as "could be anything".
// Paths are POSIX-style and CASE-SENSITIVE. Empty scope = no files = overlaps nothing (Dispatch must refuse an undeclared scope).

export type Lease = { scope: string[]; beadId: string; holder: string; acquiredAt: number; heartbeatAt: number; ttlMs: number };
export type LeaseRequest = { scope: string[]; beadId: string; holder: string; ttlMs: number };
export type Conflict = { beadId: string; holder: string; scope: string[]; expiresIn: number };
export type Reclaimable = { beadId: string; holder: string; scope: string[]; expiredAgo: number };
export type AcquireResult = { ok: true; reclaimable: Reclaimable[] } | { ok: false; conflicts: Conflict[]; reclaimable: Reclaimable[] };
export type QueueEntry = { beadId: string; state: "start" | "wait"; blockers: Conflict[]; earliestStartAt: number };

// ---- glob intersection -------------------------------------------------------------------------------------------
const norm = (g: string): string[] => {
  let s = g.trim().replace(/\/{2,}/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  if (s === "" || s === ".") return [];
  if (s.endsWith("/")) s += "**"; // a directory means its whole subtree
  return s.split("/").filter((x) => x !== "" && x !== ".");
};
const WILD = /[*?[\]{}]/;
const segInter = (x: string, y: string): boolean => {
  const wx = WILD.test(x), wy = WILD.test(y);
  if (!wx && !wy) return x === y;
  if (wx && wy) return true; // two patterns: not worth deciding, over-report
  const [pat, lit] = wx ? [x, y] : [y, x];
  if (/[[\]{}]/.test(pat)) return true; // classes/braces: over-report
  const re = pat.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*+/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${re}$`).test(lit);
};
const interSegs = (a: string[], b: string[]): boolean => {
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const k = i * (b.length + 1) + j, hit = memo.get(k);
    if (hit !== undefined) return hit;
    let r: boolean;
    if (i === a.length && j === b.length) r = true;
    else if (i === a.length) r = b.slice(j).every((s) => s === "**");
    else if (j === b.length) r = a.slice(i).every((s) => s === "**");
    else if (a[i] === "**" || b[j] === "**") r = go(i + 1, j) || go(i, j + 1); // ** eats zero or one more segment of the other side
    else r = segInter(a[i], b[j]) && go(i + 1, j + 1);
    memo.set(k, r);
    return r;
  };
  return go(0, 0);
};
/** True when some path could match a glob in `a` AND a glob in `b`. Conservative: see the header. */
export const overlaps = (a: string[], b: string[]): boolean => {
  const nb = b.map(norm);
  return a.map(norm).some((x) => x.length > 0 && nb.some((y) => y.length > 0 && interSegs(x, y)));
};

// ---- lease lifecycle ---------------------------------------------------------------------------------------------
export const expiresAt = (l: Pick<Lease, "heartbeatAt" | "ttlMs">): number => l.heartbeatAt + l.ttlMs;
/** Expired = heartbeatAt + ttl < now (strict: a lease is still live at exactly its expiry instant). */
export const isExpired = (l: Pick<Lease, "heartbeatAt" | "ttlMs">, now: number): boolean => expiresAt(l) < now;
const conflictOf = (l: Lease, now: number): Conflict => ({ beadId: l.beadId, holder: l.holder, scope: l.scope, expiresIn: expiresAt(l) - now });
const reclaimOf = (l: Lease, now: number): Reclaimable => ({ beadId: l.beadId, holder: l.holder, scope: l.scope, expiredAgo: now - expiresAt(l) });
const byExpiry = (a: Lease, b: Lease): number => expiresAt(a) - expiresAt(b) || (a.beadId < b.beadId ? -1 : a.beadId > b.beadId ? 1 : 0);

/** Leases whose heartbeat lapsed: their holders are presumed dead and the scope may be taken. Oldest first. */
export const reclaimable = (leases: Lease[], now: number): Lease[] => leases.filter((l) => isExpired(l, now)).sort(byExpiry);

/** Pure refresh. Does not decide liveness: callers check `isExpired` first (an already-reclaimed worker must stop, as with `bd heartbeat`). */
export const heartbeat = (lease: Lease, now: number): Lease => ({ ...lease, heartbeatAt: Math.max(lease.heartbeatAt, now) });

export const release = (leases: Lease[], beadId: string): Lease[] => leases.filter((l) => l.beadId !== beadId);

/** A bead's own lease never blocks itself (re-acquire = renew). Expired leases never block but are listed as reclaimable. */
export const canAcquire = (request: LeaseRequest, leases: Lease[], now: number): AcquireResult => {
  const hits = leases.filter((l) => l.beadId !== request.beadId && overlaps(request.scope, l.scope)).sort(byExpiry);
  const live = hits.filter((l) => !isExpired(l, now)), dead = hits.filter((l) => isExpired(l, now));
  const rec = dead.map((l) => reclaimOf(l, now));
  return live.length === 0 ? { ok: true, reclaimable: rec } : { ok: false, conflicts: live.map((l) => conflictOf(l, now)), reclaimable: rec };
};

/**
 * FIFO plan for waiting requests, in input order. A request that can start now takes a virtual lease from `now`; a waiter takes a
 * virtual lease from its `earliestStartAt`, so a later overlapping request queues behind it (fairness over throughput: a later,
 * disjoint-from-the-holder request never jumps an earlier waiter it overlaps). `earliestStartAt` assumes blockers never release
 * early and never heartbeat: it is when every blocker has lapsed (expiry + 1ms), an upper bound on the wait, not a promise.
 */
export const queueOrder = (requests: LeaseRequest[], leases: Lease[], now: number): QueueEntry[] => {
  const book: Lease[] = leases.filter((l) => !isExpired(l, now));
  return requests.map((r) => {
    const hits = book.filter((l) => l.beadId !== r.beadId && overlaps(r.scope, l.scope)).sort(byExpiry);
    const startAt = hits.length === 0 ? now : Math.max(now, ...hits.map((l) => expiresAt(l) + 1));
    book.push({ scope: r.scope, beadId: r.beadId, holder: r.holder, acquiredAt: startAt, heartbeatAt: startAt, ttlMs: r.ttlMs });
    return { beadId: r.beadId, state: hits.length === 0 ? "start" : "wait", blockers: hits.map((l) => conflictOf(l, now)), earliestStartAt: startAt };
  });
};

// ---- bridge from ~/.claude/fleet-active.txt ----------------------------------------------------------------------
/** fleet-map.sh matches with bash `[[ $P == $g ]]`, where `*` crosses `/`. Widen a trailing bare `*` to `**` so the bridge never under-reports. */
const fromFnmatch = (g: string): string => (g.endsWith("/*") ? `${g}*` : g === "*" ? "**" : g);
/**
 * Parse one `allow <branch-glob> <path-glob>...` line. Returns null for comments, blanks, other directives, or an allow with no paths.
 * KNOWN GAP: a `*` inside a filename pattern (`spine-*.mjs`, `*.test.ts`) crosses `/` under bash but not here; those stay single-segment.
 */
export const scopeFromAllowLine = (line: string): { branch: string; scope: string[] } | null => {
  const t = line.trim().split(/\s+/);
  if (t[0] !== "allow" || t.length < 3 || line.trimStart().startsWith("#")) return null;
  return { branch: t[1], scope: t.slice(2).map(fromFnmatch) };
};
