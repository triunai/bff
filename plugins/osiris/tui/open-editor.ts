// "Open in editor" for the worktrees app (and the Factory's embedded worktrees panel): the ONE editor spawner. The editor is a fixed GUI program found
// at a fixed install path and re-validated on every call (a regular executable, owned by you or root, not group/other-writable, every directory above
// it trusted; symlinks are followed only to a destination that passes the same checks), the same pattern as herdr and caffeinate. It is started with an
// argv ARRAY, shell:false, a minimal environment, detached with no stdio, and the path it is handed must be INSIDE the selected worktree. There is NO PATH
// lookup: $VISUAL / $EDITOR only choose WHICH of the known GUI editors to use, never what to run.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { resolveTrustedPath, trustedSpawnChild, type TrustFs, type TrustPolicy } from "../work/trusted-bin.ts";
import { isInsideWorktree } from "./worktrees-git.ts";

/** The GUI editors this may start, by program name; `goto` = takes `-g file:line`. A terminal editor (vim, nano) is never started: it needs this tty. */
export const GUI_EDITORS: Readonly<Record<string, { label: string; goto: boolean }>> = Object.freeze({
  code: { label: "VS Code", goto: true }, "code-insiders": { label: "VS Code Insiders", goto: true }, cursor: { label: "Cursor", goto: true }, windsurf: { label: "Windsurf", goto: true },
  zed: { label: "Zed", goto: false }, subl: { label: "Sublime Text", goto: false }, mate: { label: "TextMate", goto: false },
});
const APP_BIN: Record<string, string> = { code: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", cursor: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" };
/** Fixed install locations for a named editor. Nothing from PATH, nothing from the environment beyond the NAME. */
export const editorCandidates = (name: string, home = homedir()): string[] => [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, join(home, ".local", "bin", name), ...(APP_BIN[name] ? [APP_BIN[name], APP_BIN[name].replace("/Applications/", `${home}/Applications/`)] : [])];
/** Which editor: the program named by $VISUAL then $EDITOR when it is a known GUI editor (an absolute path or a bare name; arguments are ignored), else `code`. */
export function editorName(env: NodeJS.ProcessEnv): string {
  for (const v of [env.VISUAL, env.EDITOR]) { const n = basename((v ?? "").trim().split(/\s+/)[0] ?? ""); if (Object.hasOwn(GUI_EDITORS, n)) return n; }
  return "code";
}
/** Where `name` may live and which alias is allowed: its fixed install locations, and a symlink may lead anywhere that passes every other check (brew's `code` is a link into the app bundle). */
const editorPolicy = (name: string, home: string, fsx?: TrustFs): TrustPolicy => ({ dirs: [...new Set(editorCandidates(name, home).map(c => dirname(c)))], aliasTargets: "trusted", home, fsx });
/** A candidate's validated REAL path, or null (ADR D-139: the one trust check, work/trusted-bin.ts). Re-checked on every call. */
export const trustedEditor = (candidate: string, fsx?: TrustFs): string | null => resolveTrustedPath(candidate, { dirs: [dirname(candidate)], aliasTargets: "trusted", fsx });
export function resolveEditor(env: NodeJS.ProcessEnv = process.env, home = homedir(), fsx?: TrustFs): { name: string; bin: string } | null {
  const named = editorName(env);
  for (const name of named === "code" ? ["code"] : [named, "code"]) for (const c of editorCandidates(name, home)) { const bin = resolveTrustedPath(c, editorPolicy(name, home, fsx)); if (bin) return { name, bin }; }
  return null;
}
/** The exact argv: `-g <abs file>[:line]` for an editor that takes it, else the bare path; the worktree folder when there is no file. */
export function editorArgv(name: string, wt: string, file: string | null, line?: number): string[] {
  if (file === null) return [wt];
  const target = `${resolve(wt, file)}${line && GUI_EDITORS[name]?.goto ? `:${line}` : ""}`;
  return GUI_EDITORS[name]?.goto ? ["-g", target] : [target];
}
/** The spawn: through the primitive (re-vets the real path, argv array, no shell, minimal env), detached with no stdio. */
function spawnEditor(bin: string, argv: readonly string[]): void {
  const r = trustedSpawnChild(bin, argv, { trust: { dirs: [dirname(bin)], aliasTargets: "none" }, inherit: ["USER", "TMPDIR"], detached: true });
  if (!r.ok) return;
  r.child.on("error", () => {}); r.child.unref();
}
export type EditorDeps = { resolve: () => { name: string; bin: string } | null; run: (bin: string, argv: readonly string[]) => void; realpath: (p: string) => string };
const realDeps: EditorDeps = { resolve: () => resolveEditor(), run: spawnEditor, realpath: p => realpathSync(p) };
export const NO_EDITOR = "no editor found: set $VISUAL or install the `code` CLI";
/** Open `file` (relative to the worktree `wt`) or, with no file, the folder. Returns the one line to show the owner. Refuses a path outside the worktree
 * (a `..` segment, an absolute path, or a symlink whose destination leaves it) before anything is spawned. */
export function openInEditor(wt: string, file: string | null, deps: EditorDeps = realDeps): string {
  const rel = file === null ? null : file.replace(/\/$/, "");
  if (rel !== null && !isInsideWorktree(rel, wt)) return "not opened: that path is outside the worktree";
  const ed = deps.resolve(); if (!ed) return NO_EDITOR;
  try {
    const root = deps.realpath(wt);
    if (rel !== null) { const real = deps.realpath(resolve(wt, rel)); if (!real.startsWith(`${root}${sep}`)) return "not opened: that path is outside the worktree"; }
  } catch { return rel === null ? "not opened: the worktree folder is gone" : `not opened: ${rel} does not exist (deleted?)`; }
  deps.run(ed.bin, editorArgv(ed.name, wt, rel));
  return `opening ${rel ?? wt} in ${GUI_EDITORS[ed.name]?.label ?? ed.name}`;
}
