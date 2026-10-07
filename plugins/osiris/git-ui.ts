// PURE presentation helpers for the Work graph / Changes / Inspector views. No DOM, no IO, no clock (callers pass `now`).
import { LANE_BASE, LANE_VARIANTS } from "./git-graph.ts";
import type { DiffHunk, DiffLine, DiffLineKind, FileDiff, GitGraph, GitCommit, GitRef, GitRefKind } from "./git-types.ts";

export type SubjectSegment = { text: string; thread?: string };
/** Splits a commit subject/body into plain text and word-bounded `W-NNN` thread mentions ("W-1" never matches inside "W-12" or "AW-1"). */
export function subjectSegments(subject: string): SubjectSegment[] {
  const out: SubjectSegment[] = [];
  let last = 0;
  for (const m of subject.matchAll(/\bW-\d+\b/g)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: subject.slice(last, at) });
    out.push({ text: m[0], thread: m[0] });
    last = at + m[0].length;
  }
  if (last < subject.length) out.push({ text: subject.slice(last) });
  return out;
}

/** Unique thread ids mentioned in the given texts, in first-seen order. */
export function threadMentions(...texts: string[]): string[] {
  const seen = new Set<string>();
  for (const t of texts) for (const s of subjectSegments(t)) if (s.thread) seen.add(s.thread);
  return [...seen];
}

/** The commit search: every word of `query` (case-insensitive) must appear in the subject, the sha, the author, a ref name or a trailer
 *  (a bead id such as td-osi.12 travels in "Refs:" trailers and subjects), or be a thread mention found by threadMentions. An empty query matches all. */
export function commitMatches(c: Pick<GitCommit, "sha" | "author" | "subject" | "refs" | "trailers">, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [c.sha, c.author, c.subject, ...c.refs, ...(c.trailers ?? []).map(t => `${t.key} ${t.value}`), ...threadMentions(c.subject)].join("\n").toLowerCase();
  return words.every(w => hay.includes(w));
}

export type Conventional = { type: string; scope: string | null; breaking: boolean; rest: string };
/** `type(scope)!: rest` -> parts; anything else is null (rendered as plain text, never guessed). */
export function conventional(subject: string): Conventional | null {
  const m = /^([A-Za-z]+)(?:\(([^()\s][^()]*)\))?(!)?: (\S.*)$/.exec(subject);
  return m ? { type: m[1], scope: m[2] ?? null, breaking: m[3] === "!", rest: m[4] } : null;
}

/** Kind of a ref name as recorded in the graph's ref list; falls back to the name's shape only when git did not list it. */
export function chipKind(ref: string, refs: GitRef[]): GitRefKind {
  const hit = refs.find(r => r.name === ref);
  if (hit) return hit.kind;
  if (ref === "HEAD" || ref.startsWith("HEAD ->")) return "head";
  return ref.includes("/") ? "remote" : "local";
}

/** Deterministic compact age: now, 5m, 3h, 2d, 4w, then an ISO (UTC) date. Future or non-finite times read as "now". */
export function relativeAge(ms: number, now: number): string {
  if (!Number.isFinite(ms) || !Number.isFinite(now)) return "—";
  const s = Math.floor((now - ms) / 1000);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  if (d < 35) return `${Math.floor(d / 7)}w`;
  return new Date(ms).toISOString().slice(0, 10);
}

export const shortSha = (sha: string | null | undefined): string => (sha ? sha.slice(0, 8) : "—");

/** "" clean, "1 change", "12 changes", "—" when git could not say. */
export function dirtyLabel(n: number | null): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n <= 0 ? "" : n === 1 ? "1 change" : `${n} changes`;
}

/** The commit at the tip of `latestLocal` ("what is in dev"), or null when unknown / outside the loaded window. */
export function latestLocalTip(graph: GitGraph | null): GitCommit | null {
  if (!graph || !graph.latestLocal) return null;
  const ref = graph.refs.find(r => r.name === graph.latestLocal && r.kind === "local");
  const byRef = ref ? graph.commits.find(c => c.sha === ref.sha) : undefined;
  return byRef ?? graph.commits.find(c => c.refs.includes(graph.latestLocal as string)) ?? null;
}

/** "+12 −3" from the hunk lines actually present (a truncated diff counts only what is shown). */
export function diffStatsLabel(diff: FileDiff): string {
  let a = 0, d = 0;
  for (const h of diff.hunks) for (const l of h.lines) { if (l.kind === "add") a++; else if (l.kind === "del") d++; }
  return `+${a} \u2212${d}`;
}

/** Unified-diff range of a hunk, "\u221210,7 +10,9" (counts always printed, even when 1). */
export const hunkRange = (h: Pick<DiffHunk, "oldStart" | "oldLines" | "newStart" | "newLines">): string => `\u2212${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines}`;

/** Gutter marker for a diff line: "+", "\u2212" (true minus) or a space. */
export const lineMarker = (kind: DiffLineKind): string => (kind === "add" ? "+" : kind === "del" ? "\u2212" : " ");

/** One muted sentence for the non-text kinds; null for "text" (the hunks speak for themselves). */
export function diffKindNote(diff: FileDiff): string | null {
  switch (diff.kind) {
    case "binary": return "Binary file \u2014 not shown";
    case "rename-only": return "Renamed, content unchanged";
    case "mode-only": return `Mode ${diff.oldMode ?? "?"} \u2192 ${diff.newMode ?? "?"}`;
    case "empty": return "No textual change in this commit";
    default: return null;
  }
}

/** "truncated \u2014 N more lines not shown", or plain "truncated" when the count is unknown / zero. */
export const truncationNote = (omitted: number): string => (omitted > 0 ? `truncated \u2014 ${omitted} more line${omitted === 1 ? "" : "s"} not shown` : "truncated");

/** Semantic tone for a conventional-commit type chip (tokens only; the UI maps tone -> --oi-tone-*). Unknown types read as "muted". */
export type TypeTone = "info" | "success" | "attention" | "failure" | "muted";
export function conventionalTone(type: string, breaking = false): TypeTone {
  if (breaking) return "failure";
  switch (type.toLowerCase()) {
    case "feat": return "info";
    case "fix": case "revert": return "attention";
    case "test": case "perf": return "success";
    default: return "muted";
  }
}

/** The merge marker for a row: two or more parents. Title names the parents so the glyph is never the only signal. */
export function mergeMarker(c: { parents: readonly string[] }): { glyph: string; label: string } | null {
  return c.parents.length > 1 ? { glyph: "↩", label: `Merge of ${c.parents.map(p => shortSha(p)).join(" + ")}` } : null;
}

/** Order of the ref chips on one commit: HEAD, then the latest local branch, then the trunk, other locals, remotes, tags; ties by name. */
export function sortChips(names: readonly string[], refs: readonly GitRef[], latestLocal: string | null): string[] {
  const rank = (n: string): number => {
    if (n === "HEAD" || n.startsWith("HEAD ->")) return 0;
    if (latestLocal && n === latestLocal) return 1;
    const k = chipKind(n, refs as GitRef[]);
    if (k === "local") return n === "main" || n === "master" ? 2 : 3;
    return k === "remote" ? 4 : k === "tag" ? 5 : 6;
  };
  return [...names].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** CSS colour for a lane palette slot: `--oi-lane-(slot % 8)` plus a variant (slot / 8). Theme tokens only. v0 pure; v1 lightened
 * toward text; v2 deepened toward the background; v3..v5 blend with the lane token 2/4/6 hues along (oklch), i.e. a distinct hue. */
export function laneColorCss(slot: number): string {
  const n = Math.max(0, Math.floor(slot)), base = n % LANE_BASE, v = Math.floor(n / LANE_BASE) % LANE_VARIANTS, tok = (i: number) => `var(--oi-lane-${i % LANE_BASE})`;
  if (v === 0) return tok(base);
  if (v === 1) return `color-mix(in srgb, ${tok(base)} 62%, var(--oi-text))`;
  if (v === 2) return `color-mix(in srgb, ${tok(base)} 62%, var(--oi-bg))`;
  return `color-mix(in oklch, ${tok(base)} 55%, ${tok(base + 2 * (v - 2))})`;
}

/** Fork-sized graph geometry: 32px rows, 15px lane pitch by default. Pinned by git-ui.test.ts. */
export const GRAPH_ROW_H = 32, GRAPH_PITCH = 15, GRAPH_MIN_PITCH = 6, GRAPH_GUTTER_BUDGET = 640;
/** Right-hand columns of a commit row, in order (the subject/chips fill the rest). */
export const GRAPH_COLUMNS = ["author", "sha", "date"] as const;

/** Lane pitch in px: 15 by default, shrinking ONLY when `width` lanes would not fit in `avail` px, never below 6. Below the floor the
 * gutter keeps its true width and the list scrolls sideways. */
export const lanePitch = (width: number, avail: number = GRAPH_GUTTER_BUDGET): number => Math.max(GRAPH_MIN_PITCH, Math.min(GRAPH_PITCH, Math.floor(avail / Math.max(1, width))));
/** X centre of each lane column for `width` lanes. */
export const laneColumns = (width: number, avail: number = GRAPH_GUTTER_BUDGET): number[] => { const p = lanePitch(width, avail); return Array.from({ length: Math.max(0, width) }, (_, l) => l * p + p / 2); };

/** Full local date for the right-hand column: "YYYY-MM-DD HH:mm". Empty for a non-finite instant. */
export function fullDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms), z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}

/** Virtualised row window for a fixed-height list: the half-open [start,end) range to mount, with `overscan` rows either side.
 * Pure; clamps garbage input. The mounted count is bounded by ceil(viewport/rowH)+2*overscan regardless of `total`. */
export function visibleWindow(scrollTop: number, viewportH: number, total: number, rowH: number, overscan = 8): { start: number; end: number } {
  const n = Math.max(0, Math.floor(total)), h = Math.max(1, rowH);
  const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0, vh = Number.isFinite(viewportH) ? Math.max(0, viewportH) : 0;
  const first = Math.min(n, Math.floor(top / h)), last = Math.min(n, Math.ceil((top + vh) / h));
  return { start: Math.max(0, first - overscan), end: Math.min(n, last + overscan) };
}
/** True when the window is close enough to the loaded tail that the next page should be requested. */
export const nearTail = (end: number, total: number, margin = 30): boolean => total > 0 && end >= total - margin;

/** Commit-count label: "N commits" when complete, "N commits · more on scroll" while a further page exists. */
export const loadedLabel = (loaded: number, more: boolean): string => (more ? `${loaded} commits \u00b7 more on scroll` : `${loaded} commits`);

/** Side-by-side rows of one hunk: a run of deletions is paired with the run of additions that follows it; context sits on both sides. */
export type SplitRow = { left: DiffLine | null; right: DiffLine | null };
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const out: SplitRow[] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind === "ctx") { out.push({ left: lines[i], right: lines[i] }); i++; continue; }
    const dels: DiffLine[] = [], adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return out;
}
