// READ-ONLY, bounded markdown section reader (server-only). Never writes; no shell; no symlinks.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { DocSection, GitResult } from "./git-types.ts";
import { isSafeRelPath, validateRepo } from "./git-feed.ts";

export const DOC_MAX_BYTES = 2 * 1024 * 1024;
export const SECTION_MAX_LINES = 300;
const SHA_CAP = 50;

/** Unique sha-like tokens (7-40 hex chars containing at least one digit and one letter). Best-effort: a hex-looking word
 * can still be a false positive, so the UI must verify a token resolves before linking it. */
export function extractShas(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
    const t = m[0];
    if (/\d/.test(t) && /[a-f]/.test(t) && !out.includes(t)) { out.push(t); if (out.length >= SHA_CAP) break; }
  }
  return out;
}

/** The section starting at 1-based `line` (must be a markdown ATX heading): through the line before the next heading of
 * the same or higher level. Headings inside fenced code blocks are not headings. Pure. */
export function sliceSection(lines: string[], line: number): { heading: string; text: string; truncated: boolean } | null {
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return null;
  const level: number[] = new Array(lines.length).fill(0);
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (f) { if (fence === null) fence = f[1][0]; else if (f[1][0] === fence) fence = null; continue; }
    if (fence !== null) continue;
    const h = /^(#{1,6}) /.exec(lines[i]);
    if (h) level[i] = h[1].length;
  }
  const start = line - 1, lv = level[start];
  if (!lv) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (level[i] && level[i] <= lv) { end = i; break; }
  while (end > start + 1 && lines[end - 1].trim() === "") end--;
  const truncated = end - start > SECTION_MAX_LINES;
  const body = lines.slice(start, truncated ? start + SECTION_MAX_LINES : end);
  return { heading: lines[start].replace(/^#{1,6}\s+/, "").trim(), text: body.join("\n"), truncated };
}

/** Read the markdown section addressed by `ref` = "path#L<n>" inside `repo`. */
export async function readDocSection(repo: string, ref: string): Promise<GitResult<DocSection>> {
  const m = typeof ref === "string" ? /^(.{1,4096})#L(\d{1,7})$/.exec(ref) : null;
  if (!m || !isSafeRelPath(m[1]) || !m[1].endsWith(".md")) return { ok: false, reason: "invalid doc reference" };
  const path = m[1], line = Number(m[2]);
  const v = await validateRepo(repo);
  if (!v.ok) return v;
  try {
    const full = join(v.value, path);
    const st = await lstat(full);
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false, reason: "not a regular file" };
    if (st.size > DOC_MAX_BYTES) return { ok: false, reason: "file exceeds 2 MiB" };
    // A symlinked parent directory could still point outside the repo: the real path must stay inside it.
    const real = await realpath(full), root = v.value.endsWith(sep) ? v.value : v.value + sep;
    if (!real.startsWith(root)) return { ok: false, reason: "path escapes the repository" };
    const fh = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const buf = Buffer.alloc(DOC_MAX_BYTES + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead > DOC_MAX_BYTES) return { ok: false, reason: "file exceeds 2 MiB" };
      text = buf.subarray(0, bytesRead).toString("utf8");
    } finally { await fh.close(); }
    const sec = sliceSection(text.split(/\r?\n/), line);
    if (!sec) return { ok: false, reason: "line is not a markdown heading" };
    return { ok: true, value: { path, line, heading: sec.heading, text: sec.text, truncated: sec.truncated, shas: extractShas(sec.text) } };
  } catch (e) {
    const code = e !== null && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
    return { ok: false, reason: code === "ENOENT" || code === "ENOTDIR" ? "file not found" : "could not read file" };
  }
}
