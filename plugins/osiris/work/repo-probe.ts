// Server-only fs probe for Open Folder (td-osi.13). Reads only: never runs bd or git, never pins, never writes. "Is a git root" is
// git-feed's validateRepo (one definition: realpath + `.git` directly in the folder); this adds whether `.beads` sits there, and
// checks an owner-chosen tracker folder (exists, holds .beads, private). The disk scan for "Found on disk" stays discoverRepos()
// (~/Repos, depth 2, read-only); annotateTrackers() only adds the has-a-tracker flag to its results.
import {stat} from "node:fs/promises";
import {homedir} from "node:os";
import {validateRepo} from "../git-feed.ts";
import {parsePathInput, repoName, type Checked, type RepoProbe} from "./repo-registry.ts";

export interface ProbeDeps {
  home: () => string;
  /** realpath of a git root, or a plain reason */
  gitRoot: (p: string) => Promise<Checked<string>>;
  /** directory mode bits, or null when the path is not a directory */
  dirMode: (p: string) => Promise<number | null>;
}
const dirMode = async (p: string): Promise<number | null> => { try { const s = await stat(p); return s.isDirectory() ? s.mode & 0o777 : null; } catch { return null; } };
export const PROBE_DEPS: ProbeDeps = {home: homedir, gitRoot: validateRepo, dirMode};

/** One refusal text whether the path is missing, a file, or a folder that is not a git root (repo-allow.ts's rule: no existence oracle). */
export const NOT_A_ROOT = "not a repository root: open the folder that contains .git", NO_TRACKER = "not a tracker folder: choose the folder that contains .beads";
/** Typed path -> a probed git root. A subfolder of a repo is refused: open the folder that holds `.git`. */
export async function probeRepo(raw: unknown, deps: ProbeDeps = PROBE_DEPS): Promise<Checked<RepoProbe>> {
  const p = parsePathInput(raw, deps.home()); if (!p.ok) return p;
  if ((await deps.dirMode(p.value)) === null) return {ok: false, reason: NOT_A_ROOT};
  const g = await deps.gitRoot(p.value);
  if (!g.ok) return {ok: false, reason: NOT_A_ROOT};
  return {ok: true, value: {path: g.value, name: repoName(g.value), hasBeads: (await deps.dirMode(`${g.value}/.beads`)) !== null}};
}

/** An owner-chosen tracker folder: absolute, a directory holding `.beads`. `private` is false when group/other can read it (warn). */
export async function probeTrackerDir(raw: unknown, deps: ProbeDeps = PROBE_DEPS): Promise<Checked<{trackerDir: string; beadsDir: string; private: boolean}>> {
  const p = parsePathInput(raw, deps.home()); if (!p.ok) return p;
  const mode = await deps.dirMode(p.value); if (mode === null) return {ok: false, reason: NO_TRACKER};
  if ((await deps.dirMode(`${p.value}/.beads`)) === null) return {ok: false, reason: NO_TRACKER};
  return {ok: true, value: {trackerDir: p.value, beadsDir: `${p.value}/.beads`, private: (mode & 0o077) === 0}};
}

/** Add the has-a-tracker flag to already-discovered repo paths (cap 60, matching discoverRepos). */
export async function annotateTrackers(paths: readonly string[], deps: ProbeDeps = PROBE_DEPS): Promise<{path: string; hasBeads: boolean}[]> {
  return Promise.all(paths.slice(0, 60).map(async path => ({path, hasBeads: (await deps.dirMode(`${path}/.beads`)) !== null})));
}
