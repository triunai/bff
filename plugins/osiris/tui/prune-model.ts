// `osiris prune` model: classify every worktree of a repo into SAFE / REVIEW / KEEP, each with the REASON. PURE: no I/O, no clock.
// The facts come from prune-git.ts (guarded reads); removal is not in this plugin (bff runs it). Nothing here can touch a repo.
// Rules (the owner's, 2026-10-07): never remove a worktree that is dirty, holds commits no remote/main/integration branch has, is the installed
// plugin dir or one of the last three install-* dirs, has a live agent pane (or was modified in the last 2 h), is locked, or is the main one.
// Branches are never touched: this app only ever names worktree DIRECTORIES.

export type PruneFacts = {
  path: string; name: string; main: boolean; locked: boolean; branch: string | null;
  /** Entries in `git status` (tracked changes AND untracked files); null = status unreadable (never guessed as clean). */
  dirty: number | null;
  /** Commits of HEAD that no remote ref and no protected branch contains; null = could not be measured. */
  unreachable: number | null;
  /** Newest of the tip commit time and the directory mtime, ms; null = unknown. */
  activeAt: number | null;
  /** Pane label of a live agent whose cwd is inside this worktree. */
  live: string | null;
};
export type PruneOpts = { now: number; minIdleDays: number; installed: string | null };
export type Bucket = "SAFE" | "REVIEW" | "KEEP";
export type PruneEntry = { path: string; name: string; branch: string | null; bucket: Bucket; reason: string };
export type StaleEntry = { path: string; reason: string };
export type PrunePlan = { repo: string; opts: PruneOpts; safe: PruneEntry[]; review: PruneEntry[]; keep: PruneEntry[]; stale: StaleEntry[]; protectedPaths: string[] };

export const HOUR_MS = 3_600_000, DAY_MS = 86_400_000, RECENT_MS = 2 * HOUR_MS, ROLLBACK_KEEP = 3;
/** Dirs whose names say they are finished with: SAFE as soon as they are clean and fully reachable, however recently touched. */
export const RETIRED_NAME = /^(failed-stage|retired|superseded)-/;

const natural = (s: string): (string | number)[] => s.match(/\d+|\D+/g)?.map(t => (/^\d/.test(t) ? Number(t) : t)) ?? [];
/** `sort -V`-like: numeric chunks compare as numbers (install-0.2.10 sorts above install-0.2.9). */
export function compareVersion(a: string, b: string): number {
  const x = natural(a), y = natural(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i], q = y[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p - q;
    return String(p) < String(q) ? -1 : 1;
  }
  return 0;
}
const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** Paths that must never be removed because they are the installed plugin or its rollback: the installed dir and the newest ROLLBACK_KEEP install-* dirs. */
export function installProtected(paths: readonly string[], installed: string | null): string[] {
  const installs = paths.filter(p => /^install-/.test(basename(p))).sort((a, b) => compareVersion(basename(b), basename(a)));
  const out = new Set(installs.slice(0, ROLLBACK_KEEP));
  if (installed) for (const p of paths) if (trimSlash(p) === trimSlash(installed)) out.add(p);
  return [...out];
}

/** ONE worktree, one verdict. KEEP reasons win over everything; REVIEW is "clean but a human should look"; SAFE is the only removable bucket. */
export function classifyOne(f: PruneFacts, o: PruneOpts, protectedPaths: ReadonlySet<string>): { bucket: Bucket; reason: string } {
  const keep = (reason: string) => ({ bucket: "KEEP" as const, reason }), review = (reason: string) => ({ bucket: "REVIEW" as const, reason });
  if (f.main) return keep("main worktree");
  if (f.locked) return keep("locked");
  if (protectedPaths.has(f.path)) return keep(o.installed && trimSlash(o.installed) === trimSlash(f.path) ? "installed plugin dir" : "rollback install (one of the newest 3)");
  if (f.live) return keep(`live agent ${f.live}`);
  if (f.dirty === null) return keep("status unreadable");
  if (f.dirty > 0) return keep(`${f.dirty} uncommitted/untracked change${f.dirty === 1 ? "" : "s"}`);
  if (f.activeAt !== null && o.now - f.activeAt < RECENT_MS) return keep("modified in the last 2 h");
  if (f.unreachable === null) return review("reachability unknown");
  if (f.unreachable > 0) return review(`${f.unreachable} commit${f.unreachable === 1 ? "" : "s"} on no remote or main/integration branch`);
  if (RETIRED_NAME.test(f.name)) return { bucket: "SAFE", reason: "retired name, clean, fully reachable" };
  if (f.activeAt === null) return review("activity unknown");
  const idle = (o.now - f.activeAt) / DAY_MS;
  if (idle < o.minIdleDays) return review(`active ${idle < 1 ? "today" : `${Math.floor(idle)} d ago`} (idle under ${o.minIdleDays} d)`);
  return { bucket: "SAFE", reason: `clean, fully reachable, idle ${Math.floor(idle)} d` };
}

export function buildPlan(repo: string, facts: readonly PruneFacts[], stale: readonly StaleEntry[], o: PruneOpts): PrunePlan {
  const prot = installProtected(facts.map(f => f.path), o.installed), set = new Set(prot);
  const plan: PrunePlan = { repo, opts: o, safe: [], review: [], keep: [], stale: [...stale], protectedPaths: prot };
  for (const f of facts) {
    const v = classifyOne(f, o, set), e: PruneEntry = { path: f.path, name: f.name, branch: f.branch, bucket: v.bucket, reason: v.reason };
    (v.bucket === "SAFE" ? plan.safe : v.bucket === "REVIEW" ? plan.review : plan.keep).push(e);
  }
  return plan;
}

const group = (title: string, es: readonly PruneEntry[], max: number): string[] => [
  `${title} (${es.length})`, ...es.slice(0, max).map(e => `  ${e.name.padEnd(34)} ${e.reason}`), ...(es.length > max ? [`  … ${es.length - max} more (use --json for all)`] : []),
];
/** The dry-run report: grouped SAFE / REVIEW / KEEP with reasons, then totals. */
export function planText(p: PrunePlan, max = 200): string[] {
  const total = p.safe.length + p.review.length + p.keep.length;
  return [
    `prune plan for ${p.repo} (dry run unless --apply; min idle ${p.opts.minIdleDays} d)`,
    ...group("SAFE: would remove", p.safe, max), ...group("REVIEW: clean but look first", p.review, max), ...group("KEEP", p.keep, max),
    `stale admin entries: ${p.stale.length}${p.stale.length ? " (worktree prune clears them)" : ""}`,
    `total ${total} worktrees: SAFE ${p.safe.length} · REVIEW ${p.review.length} · KEEP ${p.keep.length}`,
  ];
}
/** The short header text for the worktrees app. */
export const prunableText = (p: PrunePlan | null | undefined): string => (p ? `${p.safe.length} prunable` : "");
