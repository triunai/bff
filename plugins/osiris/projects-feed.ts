import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { parseSpineV2, type SpineV2 } from "./projects.ts";

export const PROJECTS_MAX_FILES = 60;
export const PROJECTS_MAX_BYTES = 2 * 1024 * 1024;
export type ProjectsRead =
  | { state: "ok"; dir: string; projects: SpineV2[]; invalid: { file: string; reason: string }[] }
  | { state: "missing" | "empty" | "invalid"; dir: string; reason: string };

/** Server-side fallback only, and deliberately nobody's project folder: the Projects tab asks the user to pick theirs. Only a LOCATION: no project data is bundled. */
export function defaultProjectsDir(): string { return join(homedir(), ".local", "share", "osiris", "projects"); }

const codeOf = (e: unknown) => (e !== null && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "");

/** Bounded, read-only: absolute dir, realpath, non-recursive `*.spine.json`, symlinks skipped, <= 60 files of <= 2 MiB, O_NOFOLLOW. */
export async function readProjects(dir: string): Promise<ProjectsRead> {
  if (typeof dir !== "string" || !isAbsolute(dir) || dir.includes("\0")) return { state: "invalid", dir: String(dir ?? ""), reason: "Folder must be an absolute path without NUL bytes." };
  let root: string;
  try {
    root = await realpath(normalize(dir));
    if (!(await lstat(root)).isDirectory()) return { state: "invalid", dir, reason: "Not a directory." };
  } catch (e) {
    const c = codeOf(e);
    return c === "ENOENT" || c === "ENOTDIR" ? { state: "missing", dir, reason: "Folder does not exist." } : { state: "invalid", dir, reason: `Could not open the folder (${c || "error"}).` };
  }
  let names: string[];
  try { names = (await readdir(root)).filter(n => n.endsWith(".spine.json")).sort(); } catch (e) { return { state: "invalid", dir, reason: `Could not list the folder (${codeOf(e) || "error"}).` }; }
  const invalid: { file: string; reason: string }[] = [];
  const projects: SpineV2[] = [];
  let seen = 0;
  for (const name of names) {
    const path = join(root, name);
    let st;
    try { st = await lstat(path); } catch { continue; }
    if (st.isSymbolicLink() || !st.isFile()) continue; // symlinks and non-files are skipped silently
    if (++seen > PROJECTS_MAX_FILES) { invalid.push({ file: name, reason: `Over the ${PROJECTS_MAX_FILES}-file limit; skipped.` }); continue; }
    if (st.size > PROJECTS_MAX_BYTES) { invalid.push({ file: name, reason: "Exceeds 2 MiB." }); continue; }
    try {
      const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let text: string;
      try {
        const buf = Buffer.alloc(PROJECTS_MAX_BYTES + 1);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        if (bytesRead > PROJECTS_MAX_BYTES) { invalid.push({ file: name, reason: "Exceeds 2 MiB." }); continue; }
        text = buf.subarray(0, bytesRead).toString("utf8");
      } finally { await fh.close(); }
      let value: unknown;
      try { value = JSON.parse(text); } catch { invalid.push({ file: name, reason: "Not valid JSON." }); continue; }
      const r = parseSpineV2(value);
      if (r.ok) projects.push(r.spine); else invalid.push({ file: name, reason: r.reason });
    } catch (e) { invalid.push({ file: name, reason: `Could not read the file (${codeOf(e) || "error"}).` }); }
  }
  if (projects.length === 0) return invalid.length > 0 ? { state: "invalid", dir, reason: `${invalid.length} spine file(s) could not be read: ${invalid[0].file} — ${invalid[0].reason}` } : { state: "empty", dir, reason: "No *.spine.json files in the folder." };
  return { state: "ok", dir, projects, invalid };
}
