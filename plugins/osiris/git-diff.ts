// PURE unified-diff parser for ONE file's `git show --patch` output (no node imports, no I/O). Pinned by git-diff.test.ts.
import type { DiffHunk, DiffLine, FileDiff } from "./git-types.ts";

/** Per-file display caps (research L): stop adding diff lines at 400 lines OR 64 KB of line text, whichever comes first. */
export const DIFF_LINE_CAP = 400, DIFF_BYTE_CAP = 64 * 1024;

const RENAME_SRC = /^(?:rename|copy) from (.*)$/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** UTF-8 byte length of a JS string without Buffer/TextEncoder (lone surrogates count as 3, like the replacement char). */
function utf8Len(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** Git C-quotes paths with special characters on rename-source lines; undo the common escapes, else return as-is. */
function unquote(p: string): string {
  if (p.length < 2 || p[0] !== '"' || p[p.length - 1] !== '"') return p;
  const bytes: number[] = [];
  const enc = new TextEncoder();
  const body = p.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") { bytes.push(...enc.encode(ch)); continue; }
    const nx = body[++i];
    if (nx === undefined) break;
    if (/[0-7]/.test(nx)) { let o = nx; while (o.length < 3 && /[0-7]/.test(body[i + 1] ?? "")) o += body[++i]; bytes.push(parseInt(o, 8) & 0xff); }
    else bytes.push(...enc.encode(nx === "n" ? "\n" : nx === "t" ? "\t" : nx));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Parse ONE file's patch. Lines are split on "\n" only, so a CRLF file keeps its "\r" inside `text`.
 * Combined merge diffs ("diff --cc" / "@@@") have no single-parent meaning: they return kind "empty" with no hunks
 * (the reader never produces them because it asks for --first-parent). Cap: once DIFF_LINE_CAP lines or DIFF_BYTE_CAP
 * bytes of line text are shown, no more lines are added; `truncated` is set and `omittedLines` counts every remaining
 * +/-/context line of the input (so it is exact for the input given; the CALLER must say if the input itself was cut).
 */
export function parseFileDiff(raw: string, path: string, caps: { lines?: number; bytes?: number } = {}): FileDiff {
  const lineCap = caps.lines ?? DIFF_LINE_CAP, byteCap = caps.bytes ?? DIFF_BYTE_CAP;
  const out: FileDiff = { path, oldPath: null, kind: "empty", oldMode: null, newMode: null, hunks: [], truncated: false, omittedLines: 0 };
  if (typeof raw !== "string" || raw === "") return out;
  const rows = raw.split("\n");
  if (rows[rows.length - 1] === "") rows.pop();
  let binary = false, combined = false, renamed = false;
  let renameFrom: string | null = null;
  let cur: DiffHunk | null = null;
  let oldNo = 0, newNo = 0, oldLeft = 0, newLeft = 0;
  let shown = 0, bytes = 0, full = false;
  let last: DiffLine | null = null;

  for (const row of rows) {
    if (cur === null || (oldLeft <= 0 && newLeft <= 0 && !row.startsWith("\\"))) {
      // Header zone (or between hunks).
      let m = HUNK.exec(row);
      if (m && !binary && !combined) {
        const oldStart = Number(m[1]), oldLines = m[2] === undefined ? 1 : Number(m[2]);
        const newStart = Number(m[3]), newLines = m[4] === undefined ? 1 : Number(m[4]);
        cur = { header: row, oldStart, oldLines, newStart, newLines, section: m[5] ?? "", lines: [] };
        oldNo = oldStart; newNo = newStart; oldLeft = oldLines; newLeft = newLines; last = null;
        continue;
      }
      if (row.startsWith("diff --cc") || row.startsWith("diff --combined")) combined = true;
      else if (row.startsWith("Binary files ") || row.startsWith("GIT binary patch")) binary = true;
      else if (row.startsWith("old mode ")) out.oldMode = row.slice(9).trim();
      else if (row.startsWith("new mode ")) out.newMode = row.slice(9).trim();
      else if (row.startsWith("new file mode ")) out.newMode = row.slice(14).trim();
      else if (row.startsWith("deleted file mode ")) out.oldMode = row.slice(18).trim();
      else if ((m = RENAME_SRC.exec(row))) { renamed = true; renameFrom = unquote(m[1]); }
      continue;
    }
    // Inside a hunk.
    if (row.startsWith("\\")) { if (last) last.noNewlineAtEof = true; continue; }
    const tag = row[0];
    const kind: DiffLine["kind"] | null = tag === "+" ? "add" : tag === "-" ? "del" : tag === " " || row === "" ? "ctx" : null;
    if (kind === null) { oldLeft = newLeft = 0; continue; } // malformed: leave the hunk, treat as header noise
    const text = row.slice(1);
    const line: DiffLine = { kind, text, oldNo: kind === "add" ? null : oldNo, newNo: kind === "del" ? null : newNo };
    if (kind !== "add") { oldNo++; oldLeft--; }
    if (kind !== "del") { newNo++; newLeft--; }
    if (!full && (shown >= lineCap || bytes + utf8Len(text) > byteCap)) full = true;
    if (full) { out.omittedLines++; last = null; continue; }
    if (!out.hunks.includes(cur)) out.hunks.push(cur);
    cur.lines.push(line); shown++; bytes += utf8Len(text); last = line;
  }
  // A hunk whose header was seen after the cap but which showed no lines is not kept (never pushed). Hunk lines that were
  // never reached because of the cap are counted above; hunks entirely past the cap contribute via the same branch.
  out.truncated = full;
  if (renamed && renameFrom !== null && renameFrom !== path) out.oldPath = renameFrom;
  out.kind = binary ? "binary" : out.hunks.length > 0 || full ? "text" : renamed ? "rename-only" : out.oldMode !== null && out.newMode !== null && out.oldMode !== out.newMode ? "mode-only" : "empty";
  if (combined) { out.kind = "empty"; out.hunks = []; out.truncated = false; out.omittedLines = 0; }
  if (binary) { out.hunks = []; out.truncated = false; out.omittedLines = 0; }
  return out;
}
