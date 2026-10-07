import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import { parseSpineIndex, type SpineIndex } from "./spine-index.ts";

export type SpineRead =
  | { state: "ok"; path: string; mtimeMs: number; index: SpineIndex; dropped: number }
  | { state: "missing"; path: string; hint: string }
  | { state: "invalid"; path: string; reason: string };
export const SPINE_MAX_BYTES = 4 * 1024 * 1024;

/** The contract's final location (T5, 2026-10-05): `<repo>/.bff/spine-index.json`, written by the webshop producer
 * (`npm run spine:index`) and by a future `bff spine --repo`. The pre-amendment `.spine/` never reached main and is retired. */
export const SPINE_DIR = ".bff";

/** Read ONLY `<repo>/.bff/spine-index.json`, bounded. The spine is authoritative: this never writes or generates it. */
export async function readSpineIndex(repo: string): Promise<SpineRead> {
  if (!isAbsolute(repo) || repo.includes("\0")) return { state: "invalid", path: "", reason: "Repo must be an absolute path without NUL bytes." };
  return readAt(normalize(repo), SPINE_DIR);
}

async function readAt(root: string, location: string): Promise<SpineRead> {
  const dir = join(root, location), path = normalize(join(dir, "spine-index.json"));
  if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) return { state: "invalid", path, reason: "Resolved path escapes the repo." };
  const hint = `Run \`bff spine --repo ${root}\` to build the index. It needs a "spine_index" command in ${root}/.bff.json.`;
  try {
    const d = await lstat(dir);
    if (d.isSymbolicLink() || !d.isDirectory()) return { state: "invalid", path, reason: `${location} is not a plain directory.` };
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return { state: "invalid", path, reason: "spine-index.json is not a regular file (symlinks are refused)." };
    if (stat.size > SPINE_MAX_BYTES) return { state: "invalid", path, reason: "spine-index.json exceeds 4 MiB." };
    // O_NOFOLLOW closes the lstat->open window: a symlink swapped in after the check fails to open (review-1 F12).
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const buffer = Buffer.alloc(SPINE_MAX_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > SPINE_MAX_BYTES) return { state: "invalid", path, reason: "spine-index.json exceeds 4 MiB." };
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await file.close(); }
    let value: unknown;
    try { value = JSON.parse(text); } catch { return { state: "invalid", path, reason: "spine-index.json is not valid JSON." }; }
    const parsed = parseSpineIndex(value);
    return parsed.ok ? { state: "ok", path, mtimeMs: stat.mtimeMs, index: parsed.index, dropped: parsed.dropped } : { state: "invalid", path, reason: parsed.reason };
  } catch (e) {
    const code = e !== null && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing", path, hint };
    return { state: "invalid", path, reason: `Could not read spine-index.json (${code || "error"}).` };
  }
}
