// Open Folder (td-osi.13): the pure model behind "open any repo root in Osiris and see THAT repo's Board / Graph / Commits".
// Recents are a CONVENIENCE list (kv RECENTS_KEY, capped, deterministic order). The allowlist (work/repo-allow.ts) stays the ONLY
// gate and this module never adds to it: decideOpen() returns an explicit {kind:"needs-allow"} result that the UI turns into an
// owner button calling the existing pinRepo RPC. A repo without .beads still opens (Commits works); its Board shows "No tracker
// here" plus SETUP_TRACKER_GUIDE, which is documented and never executed. A tracker may live OUTSIDE its repo (the Osiris tracker
// does: a non-git, remote-less folder), reached through an owner-set binding and BEADS_DIR, never through a caller-supplied path.
// No node: imports, so the client bundle can use it too.

export const RECENTS_KEY = "repos.recent.v1", RECENT_MAX = 12, BINDINGS_KEY = "trackers.bound.v1", BINDING_MAX = 8, FOUND_MAX = 60, PATH_MAX = 4096;
/** Where the Osiris tracker lives, relative to the home directory (docs/design/own-base.md says why it is outside every repo). */
export const OSIRIS_TRACKER_SUBDIR = ".local/share/osiris-tracker";

export type Checked<T> = {ok: true; value: T} | {ok: false; reason: string};
/** A probed folder: `path` is its realpath, and it is a git ROOT (`.git` sits directly in it). */
export interface RepoProbe { path: string; name: string; hasBeads: boolean }
export interface RecentRepo { path: string; name: string; openedAt: number; tracker: boolean }
/** An owner-set link from a repo root to a tracker folder that holds `.beads` (the folder, not the .beads dir itself). */
export interface TrackerBinding { repo: string; trackerDir: string; label: string }
export type TrackerState =
  | {kind: "own"; beadsDir: string}
  | {kind: "bound"; beadsDir: string; label: string}
  | {kind: "none"; guide: readonly string[]};
export type OpenDecision =
  | {kind: "open"; path: string; name: string; tracker: TrackerState}
  | {kind: "needs-allow"; path: string; name: string; tracker: TrackerState; allow: {rpc: "pinRepo"; path: string}; ask: string}
  | {kind: "refused"; reason: string};
export interface PickerRow { path: string; name: string; group: "current" | "recent" | "found"; allowed: boolean; tracker: boolean }

/** Shown on the Board when a repo has no tracker. Osiris never runs these; the owner does, once, by hand. */
export const SETUP_TRACKER_GUIDE: readonly string[] = Object.freeze([
  "No tracker here. Commits still work; the Board needs a Beads tracker. To add one, by hand:",
  "1. Choose where it lives. Inside the repo only if `.beads/` is git-ignored there; otherwise a folder outside every git repo.",
  "2. In that folder: `BD_DISABLE_METRICS=1 BEADS_DIR=$PWD/.beads bd init --non-interactive --skip-agents --skip-hooks --prefix <short>`. Plain `bd init` also runs git init and writes AGENTS.md, CLAUDE.md and editor folders.",
  "3. Prove it has no remote: `bd dolt remote list` says \"No remotes configured\" and `bd config get sync.remote` is not set.",
  "4. `chmod 700` the folder. If it is outside the repo, bind it here with \"Use a tracker folder\".",
]);

const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const repoName = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;
const isAbs = (p: string): boolean => p.startsWith("/");
const trim = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);
const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);

/** What the owner typed (or a native picker returned) -> an absolute path. `~` expands against `home`. Syntax only: the server realpaths. */
export function parsePathInput(raw: unknown, home: string): Checked<string> {
  if (typeof raw !== "string" || !raw.trim()) return {ok: false, reason: "type the absolute path of a repository folder"};
  let p = raw.trim();
  if (p === "~" || p.startsWith("~/")) p = home.replace(/\/+$/, "") + p.slice(1);
  if (p.length > PATH_MAX || p.includes("\0")) return {ok: false, reason: "that path is not usable"};
  if (!isAbs(p)) return {ok: false, reason: "the path must be absolute (start with / or ~/)"};
  return {ok: true, value: trim(p)};
}

/** Newest first, then by path: the same input always renders the same list. */
const byRecency = (a: RecentRepo, b: RecentRepo): number => b.openedAt - a.openedAt || order(a.path, b.path);

/** Defensive read of the kv value: drops malformed rows, keeps the newest row per path, sorts, caps. */
export function normalizeRecents(v: unknown): RecentRepo[] {
  const best = new Map<string, RecentRepo>();
  for (const x of Array.isArray(v) ? v : []) {
    const r = asRecord(x); if (!r) continue;
    const {path, openedAt} = r;
    if (typeof path !== "string" || !isAbs(path) || path.length > PATH_MAX || typeof openedAt !== "number" || !Number.isFinite(openedAt)) continue;
    const row: RecentRepo = {path, name: typeof r.name === "string" && r.name ? r.name : repoName(path), openedAt, tracker: r.tracker === true};
    const cur = best.get(path); if (!cur || cur.openedAt < openedAt) best.set(path, row);
  }
  return [...best.values()].sort(byRecency).slice(0, RECENT_MAX);
}
/** Record an open: the repo moves to the front; the oldest drops off past RECENT_MAX. */
export function touchRecent(list: readonly RecentRepo[], probe: RepoProbe, tracker: boolean, now: number): RecentRepo[] {
  return normalizeRecents([{path: probe.path, name: probe.name, openedAt: now, tracker}, ...list.filter(r => r.path !== probe.path)]);
}
/** Forget a recent. This never unpins: recents and the allowlist are separate lists. */
export const forgetRecent = (list: readonly RecentRepo[], path: string): RecentRepo[] => normalizeRecents(list.filter(r => r.path !== path));

export function normalizeBindings(v: unknown): TrackerBinding[] {
  const seen = new Map<string, TrackerBinding>();
  for (const x of Array.isArray(v) ? v : []) {
    const r = asRecord(x); if (!r) continue;
    const {repo, trackerDir} = r;
    if (typeof repo !== "string" || typeof trackerDir !== "string" || !isAbs(repo) || !isAbs(trackerDir) || repo.length > PATH_MAX || trackerDir.length > PATH_MAX) continue;
    if (!seen.has(repo)) seen.set(repo, {repo: trim(repo), trackerDir: trim(trackerDir), label: typeof r.label === "string" && r.label ? r.label.slice(0, 60) : repoName(trackerDir)});
  }
  return [...seen.values()].sort((a, b) => order(a.repo, b.repo)).slice(0, BINDING_MAX);
}
/** The explicit owner action "use this tracker folder for this repo". Replaces an existing binding for the same repo. */
export function bindTracker(list: readonly TrackerBinding[], b: TrackerBinding): Checked<TrackerBinding[]> {
  if (!isAbs(b.repo) || !isAbs(b.trackerDir)) return {ok: false, reason: "both the repo and the tracker folder must be absolute paths"};
  const rest = list.filter(x => x.repo !== b.repo);
  if (rest.length >= BINDING_MAX) return {ok: false, reason: `at most ${BINDING_MAX} tracker bindings`};
  return {ok: true, value: normalizeBindings([b, ...rest])};
}
export const unbindTracker = (list: readonly TrackerBinding[], repo: string): TrackerBinding[] => normalizeBindings(list.filter(x => x.repo !== repo));

/** An owner binding wins over the repo's own .beads (it is the more explicit choice); no tracker -> the setup guide. */
export function trackerFor(probe: RepoProbe, bindings: readonly TrackerBinding[]): TrackerState {
  const b = bindings.find(x => x.repo === probe.path);
  if (b) return {kind: "bound", beadsDir: `${b.trackerDir}/.beads`, label: b.label};
  return probe.hasBeads ? {kind: "own", beadsDir: `${probe.path}/.beads`} : {kind: "none", guide: SETUP_TRACKER_GUIDE};
}

/** Open a probed folder. Allowed -> open. Not allowed -> ask the owner (never pinned here). A failed probe -> refused, with its reason. */
export function decideOpen(probe: Checked<RepoProbe>, allowed: Iterable<string>, bindings: readonly TrackerBinding[]): OpenDecision {
  if (!probe.ok) return {kind: "refused", reason: probe.reason};
  const {path, name} = probe.value, tracker = trackerFor(probe.value, bindings);
  if (new Set(allowed).has(path)) return {kind: "open", path, name, tracker};
  return {kind: "needs-allow", path, name, tracker, allow: {rpc: "pinRepo", path}, ask: `Let Osiris read ${name}? It will be added to your allowed repositories (${path}).`};
}

/** The picker list: the current repo, then recents (newest first), then repos found on disk (by name). Each path appears once. */
export function pickerRows(input: {current: string | null; recents: readonly RecentRepo[]; found: readonly {path: string; hasBeads: boolean}[]; allowed: Iterable<string>}): PickerRow[] {
  const allowed = new Set(input.allowed), seen = new Set<string>(), out: PickerRow[] = [];
  const push = (path: string, name: string, group: PickerRow["group"], tracker: boolean) => { if (seen.has(path)) return; seen.add(path); out.push({path, name, group, allowed: allowed.has(path), tracker}); };
  const recent = new Map(input.recents.map(r => [r.path, r]));
  if (input.current) push(input.current, repoName(input.current), "current", recent.get(input.current)?.tracker ?? input.found.find(f => f.path === input.current)?.hasBeads ?? false);
  for (const r of [...input.recents].sort(byRecency)) push(r.path, r.name, "recent", r.tracker);
  const found = [...input.found].sort((a, b) => order(repoName(a.path), repoName(b.path)) || order(a.path, b.path)).slice(0, FOUND_MAX);
  for (const f of found) push(f.path, repoName(f.path), "found", f.hasBeads);
  return out;
}
