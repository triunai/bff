// PURE parsers + lane layout for the read-only git reader. No node imports: runs in the server and (if needed) the UI.
import type { DayCommit, GitCommit, GitFileStat, GitTrailer, GitRef, GitStatus, GitStatusEntry, LaneEdge, LaneRow } from "./git-types.ts";

/** Only these trailers are read (lane identity, W-193c): who/what produced the commit and which work it refers to. Unfolded, joined by US (\x1f). */
export const TRAILER_KEYS = ["Refs", "Co-Authored-By", "Claude-Session", "Lane", "Agent"] as const;
const TRAILER_FORMAT = `%(trailers:${TRAILER_KEYS.map(k => `key=${k}`).join(",")},unfold,separator=%x1f)`;

/** "Refs: W-1, td-2\x1fAgent: x" -> [{key,value}]. Keys are matched case-insensitively and normalised to TRAILER_KEYS spelling; anything else is dropped. */
export function parseTrailers(raw: string): GitTrailer[] {
  const out: GitTrailer[] = [];
  for (const line of raw.split("\x1f")) {
    const m = /^([A-Za-z][A-Za-z-]*):\s*(.*)$/.exec(line.replace(/[\r\n]+$/g, ""));
    const key = m && TRAILER_KEYS.find(k => k.toLowerCase() === m[1].toLowerCase());
    if (m && key && m[2].trim()) out.push({ key, value: m[2].trim() });
  }
  return out;
}

/** Format passed to `git log`; parseLog is its inverse. Fields NUL-separated, records end with \x1e. */
export const LOG_FORMAT = `%H%x00%P%x00%an%x00%at%x00%ct%x00%s%x00%D%x00${TRAILER_FORMAT}%x1e`;
export const REF_FORMAT = "%(refname)%00%(objectname)%00%(committerdate:unix)";

/** `%D` -> short ref names: "HEAD -> main, tag: v1, origin/main" => ["main","v1","origin/main"]. A bare detached "HEAD" is kept. */
export function parseDecorations(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    let name = part.trim();
    if (!name) continue;
    if (name.startsWith("HEAD -> ")) name = name.slice(8);
    else if (name.startsWith("tag: ")) name = name.slice(5);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

const toMs = (s: string): number => { const n = Number(s); return Number.isFinite(n) ? n * 1000 : 0; };

const trailersOf = (raw: string | undefined): { trailers?: GitTrailer[] } => { const t = raw ? parseTrailers(raw) : []; return t.length ? { trailers: t } : {}; };
const fieldsToCommit = (f: string[], withTrailers = true): GitCommit | null => {
  if (f.length < 6 || !/^[0-9a-f]{7,64}$/.test(f[0])) return null;
  return {
    sha: f[0], parents: f[1] ? f[1].split(" ").filter(Boolean) : [], author: f[2], authoredAt: toMs(f[3]), committedAt: toMs(f[4]),
    subject: f[5], refs: parseDecorations(f[6] ?? ""), ...(withTrailers ? trailersOf(f[7]) : {}),
  };
};

export function parseLog(raw: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const rec of raw.split("\x1e")) {
    const text = rec.replace(/^\n+/, "");
    if (!text) continue;
    const c = fieldsToCommit(text.split("\0"));
    if (c) commits.push(c);
  }
  return commits;
}

/** Day-log format: LOG_FORMAT plus a trailing %S (the ref `git log --source` reached the commit by). */
export const DAY_LOG_FORMAT = "%H%x00%P%x00%an%x00%at%x00%ct%x00%s%x00%D%x00%S%x1e";

/** `%S` -> a short, display-safe source name. refs/heads/x -> "x"; refs/remotes/o/x -> "o/x"; refs/tags/v -> "tag:v";
 * any other ref (e.g. HEAD) is kept verbatim; empty -> null. Which ref wins when several reach one commit is git's
 * traversal order, so a commit shared by two branches is attributed to exactly one. */
export function shortSource(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith("refs/heads/")) return s.slice(11) || null;
  if (s.startsWith("refs/remotes/")) return s.slice(13) || null;
  if (s.startsWith("refs/tags/")) return s.length > 10 ? `tag:${s.slice(10)}` : null;
  return s;
}

/** Inverse of DAY_LOG_FORMAT: parseLog's fields plus `source`. */
export function parseDayLog(raw: string): DayCommit[] {
  const out: DayCommit[] = [];
  for (const rec of raw.split("\x1e")) {
    const text = rec.replace(/^\n+/, "");
    if (!text) continue;
    const f = text.split("\0");
    const c = fieldsToCommit(f, false);
    if (c) out.push({ ...c, source: shortSource(f[7] ?? "") });
  }
  return out;
}

export function parseRefs(raw: string): GitRef[] {
  const refs: GitRef[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [full, sha, date] = line.split("\0");
    if (!full || !sha) continue;
    let kind: GitRef["kind"], name: string;
    if (full.startsWith("refs/heads/")) { kind = "local"; name = full.slice(11); }
    else if (full.startsWith("refs/remotes/")) { kind = "remote"; name = full.slice(13); if (/^[^/]+\/HEAD$/.test(name)) continue; }
    else if (full.startsWith("refs/tags/")) { kind = "tag"; name = full.slice(10); }
    else continue;
    const t = date ? Number(date) : NaN;
    refs.push({ name, kind, sha, committedAt: Number.isFinite(t) ? t * 1000 : null });
  }
  return refs;
}

export const STATUS_ENTRY_CAP = 2000;

/** Parses `status --porcelain=v1 -z [--branch]`. Header ("## ...") is optional. */
export function parseStatus(raw: string, repo = "", cap = STATUS_ENTRY_CAP): GitStatus {
  const tokens = raw.split("\0");
  let branch: string | null = null, upstream: string | null = null, ahead: number | null = null, behind: number | null = null;
  const entries: GitStatusEntry[] = [];
  let truncated = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.startsWith("## ")) {
      const h = t.slice(3);
      if (h.startsWith("No commits yet on ")) { branch = h.slice(18); continue; }
      if (h.startsWith("Initial commit on ")) { branch = h.slice(18); continue; }
      if (h.startsWith("HEAD (no branch)")) { branch = null; continue; }
      const m = /^(.*?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(h);
      if (m) {
        branch = m[1] || null; upstream = m[2] ?? null;
        if (m[2]) { ahead = 0; behind = 0; }
        const a = /ahead (\d+)/.exec(m[3] ?? ""), b = /behind (\d+)/.exec(m[3] ?? "");
        if (a) ahead = Number(a[1]);
        if (b) behind = Number(b[1]);
      }
      continue;
    }
    if (t.length < 4) continue;
    const x = t[0], y = t[1], path = t.slice(3);
    let origPath: string | undefined;
    if (x === "R" || x === "C" || y === "R" || y === "C") origPath = tokens[++i];
    if (entries.length >= cap) { truncated = true; continue; }
    entries.push(origPath === undefined ? { path, x, y } : { path, x, y, origPath });
  }
  return { repo, branch, upstream, ahead, behind, entries, truncated };
}

/** Parses `show --numstat --format= -z`. Binary files report "-\t-". Renames: "a\td\t\0old\0new". */
export function parseNumstat(raw: string): GitFileStat[] {
  const tokens = raw.replace(/^\n+/, "").split("\0");
  const files: GitFileStat[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[i].replace(/^\n+/, ""));
    if (!m) continue;
    let path = m[3];
    if (path === "") { path = tokens[i + 2] ?? tokens[i + 1] ?? ""; i += 2; }
    const binary = m[1] === "-" || m[2] === "-";
    files.push({ path, additions: binary ? null : Number(m[1]), deletions: binary ? null : Number(m[2]), binary });
  }
  return files;
}

// ---- lane layout ----
/** Palette: 8 theme-token hues (`--oi-lane-0..7`) x 6 variants = 48 slots. slot % 8 is the base token; slot / 8 picks the variant
 * (see laneColorCss in git-ui.ts). Slots 0..7 are the pure tokens, so every pre-existing colour is unchanged. */
export const LANE_BASE = 8, LANE_VARIANTS = 6, LANE_PALETTE = LANE_BASE * LANE_VARIANTS;
function stableHash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }

/** Preferred palette slot (0..LANE_PALETTE-1) for a colour key, a PURE function of the key so a branch keeps its colour across
 * refreshes, scrolls and window shifts (W-193c a). The trunk (main/master) is always slot 0; every other key hashes into
 * 1..LANE_PALETTE-1. layoutGraph may probe past this slot when another OPEN lane already holds it (see openLane). */
export function laneColorOf(key: string): number {
  return key === "main" || key === "master" ? 0 : 1 + (stableHash(key) % (LANE_PALETTE - 1));
}
/** The colour key of a branch NAME. Unnamed lanes use `sha:<first commit>` (see layoutGraph). */
export const branchColor = (name: string): number => laneColorOf(name);

function branchOf(refs: string[], local?: ReadonlySet<string>): string | null {
  const cands = refs.filter(r => r !== "HEAD" && (local ? local.has(r) : !r.includes("/")));
  if (!cands.length) return null;
  return cands.find(r => r === "main" || r === "master") ?? [...cands].sort()[0];
}

/** Classic lane assignment over topo-ordered commits (children before parents). Deterministic.
 * Colour: a lane takes the colour of the branch NAME that reaches it (a ref in the window, even when the lane was reserved by a
 * merge before the tip is drawn), else of the SHA that opened it; never of its column index, so nothing depends on how many other
 * lanes happen to be open. `row.branch` is the name the lane carries, when known.
 * Edge semantics: from/to are lane indices at this row -> the next row. "straight" = a lane continues (incl. first parent);
 * "merge" = this commit's extra parent; "fork" = a lane whose reserved sha is this commit joins this commit's lane. */
export function layoutGraph(commits: GitCommit[], localBranches?: ReadonlySet<string>): LaneRow[] {
  const lanes: (string | null)[] = [], colors: number[] = [], names: (string | null)[] = [];
  const tipName = new Map<string, string>();
  for (const c of commits) { const n = branchOf(c.refs, localBranches); if (n) tipName.set(c.sha, n); }
  // A lane takes its key's preferred slot; if an OPEN lane already holds it, probe forward (deterministic) so concurrent lanes stay
  // distinct until the palette itself is exhausted. Colour is still never a function of the column index.
  const openLane = (sha: string, k: number) => {
    const n = tipName.get(sha) ?? null; names[k] = n;
    let c = laneColorOf(n ?? `sha:${sha}`);
    if (c !== 0) {
      const taken = new Set<number>(); for (let i = 0; i < lanes.length; i++) if (i !== k && lanes[i] !== null) taken.add(colors[i]);
      for (let t = 0; t < LANE_PALETTE - 1 && taken.has(c); t++) c = 1 + (c % (LANE_PALETTE - 1));
    }
    colors[k] = c;
  };
  const rows: LaneRow[] = [];
  const free = (): number => { const i = lanes.indexOf(null); return i === -1 ? lanes.length : i; };
  for (const c of commits) {
    const before = lanes.length;
    let lane = lanes.indexOf(c.sha);
    if (lane === -1) { lane = free(); lanes[lane] = c.sha; openLane(c.sha, lane); }
    const color = colors[lane], branch = names[lane] ?? tipName.get(c.sha) ?? null;
    const edges: LaneEdge[] = [];
    // other lanes converging on this commit end here
    for (let i = 0; i < lanes.length; i++) if (i !== lane && lanes[i] === c.sha) { edges.push({ from: i, to: lane, color: colors[i], kind: "fork" }); lanes[i] = null; }
    // pass-through lanes
    for (let i = 0; i < lanes.length; i++) if (i !== lane && lanes[i] !== null) edges.push({ from: i, to: i, color: colors[i], kind: "straight" });
    let width = Math.max(before, lanes.length);
    if (c.parents.length === 0) lanes[lane] = null;
    else {
      lanes[lane] = c.parents[0];
      edges.push({ from: lane, to: lane, color, kind: "straight" });
      for (const p of c.parents.slice(1)) {
        let k = lanes.indexOf(p);
        if (k === -1) { k = free(); lanes[k] = p; openLane(p, k); }
        edges.push({ from: lane, to: k, color: colors[k], kind: "merge" });
      }
    }
    width = Math.max(width, lanes.length);
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ sha: c.sha, lane, color, edges, width, ...(branch ? { branch } : {}) });
  }
  return rows;
}

/** Compact-mode lane cap (the "Compact (12)" toggle). The default view draws EVERY lane. A busy repo can carry hundreds of local branches (agent worktrees), so a 300-commit window reaches 44 lanes
 * (median 5, p90 31; measured 2026-10-06). Lanes at or beyond `cap` fold into the last visible column and the row is
 * flagged `clamped`. Nothing is hidden: every commit row stays. `cap` defaults to unlimited (identity); pass LANE_CAP for compact. */
export const LANE_CAP = 12;
export function capLanes(rows: LaneRow[], cap = Infinity): { rows: LaneRow[]; maxWidth: number; clampedRows: number } {
  const last = Math.max(0, cap - 1), fold = (n: number) => Math.min(n, last);
  let maxWidth = 0, clampedRows = 0;
  const out = rows.map(r => {
    maxWidth = Math.max(maxWidth, r.width);
    const clamped = r.lane > last || r.edges.some(e => e.from > last || e.to > last);
    if (clamped) clampedRows++;
    if (!clamped && r.width <= cap) return r;
    const seen = new Set<string>(), edges = r.edges.map(e => ({ ...e, from: fold(e.from), to: fold(e.to) })).filter(e => { const k = `${e.from}:${e.to}:${e.kind}`; if (seen.has(k)) return false; seen.add(k); return true; });
    return { ...r, lane: fold(r.lane), edges, width: Math.min(r.width, cap), ...(clamped ? { clamped: true } : {}) };
  });
  return { rows: out, maxWidth, clampedRows };
}
