// `osiris worktrees` model and frame, ported to the look of beady-eye's Arkham screen (Apache-2.0, third_party/NOTICE-beady-eye.md): an
// inverse header row (`▾ repo  ✓ time` with the counts right-aligned), a `├──`/`└──` tree under it, a full-width `─` rule above the detail pane,
// a status row and the key row on the last line (first letter of each key bold, label dim). Wide terminals put the detail pane BESIDE the list.
// PURE: no I/O, no clock. The git reads live in worktrees-git.ts and are read-only by construction. ONE layout pass produces the lines and the
// click map (layoutWorktrees), so hit-tests can never disagree with the drawing.
import { commitRefs } from "../git-lane-identity.ts";
import type { GitTrailer } from "../git-types.ts";
import { planText, prunableText, type PrunePlan } from "./prune-model.ts";
import { C, SEL_BG, headerLine, keyRows, mu, panelRule, statusLine, type KeyItem } from "./chrome.ts";
import { ageText, cat, clipLine, clockText, isCh, isDown, isUp, padLine, S, segHit, trimEnd, withStyle, type Frame, type Hit, type Key, type Line, type MouseAct, type Reduced, type Size, type Style } from "./term.ts";

export type WtFile = { code: string; path: string };
export type WtCommit = { sha: string; at: number; subject: string };
export type WtRow = {
  repo: string; path: string; name: string; branch: string | null; upstream: string | null; ahead: number | null; behind: number | null;
  dirty: number | null; lastAt: number | null; subject: string | null; bead: string | null; agent: string | null; main: boolean;
  files: WtFile[]; commits: WtCommit[]; beadTitle: string | null;
  /** `git diff --stat` of a dirty worktree (per-file tails + summary); null = clean or unreadable */ stat: { files: { path: string; tail: string }[]; summary: string } | null;
};
/** The opened file's diff: unified-diff lines, or a note when there are none to show. */
export type WtFileDiff = { path: string; file?: string; sha?: string; lines: string[]; note?: string };
/** What the owner opened in the detail pane: a changed file's diff or a commit's stat + patch. */
export type WtDiffKey = { path: string; file?: string; sha?: string };
export const sameDiff = (a: WtDiffKey | null | undefined, b: WtDiffKey | null | undefined): boolean => !!a && !!b && a.path === b.path && a.file === b.file && a.sha === b.sha;
export type WtGroup = { repo: string; name: string; rows: WtRow[] };

/** Osiris dispatch names its branches `work/<bead-id>-<slug>` (work/dispatch.ts branchFor); that is the one branch convention read. */
export const beadFromBranch = (branch: string | null): string | null => /^work\/([a-z][a-z0-9]*-[a-z0-9]+(?:\.[a-z0-9]+)*)(?=-|$)/.exec(branch ?? "")?.[1] ?? null;
/** The linked bead: the tip commit's `Refs:` bead id (git-lane-identity's ONE extractor), else the dispatch branch convention. */
export const beadOf = (branch: string | null, trailers: readonly GitTrailer[] | undefined): string | null => commitRefs(trailers, "bead")[0] ?? beadFromBranch(branch);

const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
/** Group rows by repo; rows by newest commit first; groups by their newest row (activity), ties by name. */
export function groupRows(rows: readonly WtRow[]): WtGroup[] {
  const by = new Map<string, WtRow[]>();
  for (const r of rows) by.set(r.repo, [...(by.get(r.repo) ?? []), r]);
  const act = (rs: WtRow[]) => Math.max(0, ...rs.map(r => r.lastAt ?? 0));
  return [...by].map(([repo, rs]) => ({ repo, name: basename(repo), rows: [...rs].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || a.name.localeCompare(b.name)) }))
    .sort((a, b) => act(b.rows) - act(a.rows) || a.name.localeCompare(b.name));
}

// ---- states: Active now / Dirty / Recent / Stale over 7 days -----------------------------------------------------------------
export type WtState = "active" | "dirty" | "recent" | "stale" | "prune";
export const STATES: readonly WtState[] = ["active", "dirty", "recent", "stale", "prune"];
export const STATE_LABEL: Record<WtState, string> = { active: "Active now", dirty: "Dirty", recent: "Recent", stale: "Stale over 7 days", prune: "Prune candidates" };
export const ACTIVE_MS = 30 * 60_000, STALE_MS = 7 * 86_400_000;
/** An agent pane or a commit in the last half hour = active; else uncommitted changes = dirty; else committed within 7 days = recent; else stale. */
export function stateOf(r: WtRow, now: number): Exclude<WtState, "prune"> {
  if (r.agent || (r.lastAt !== null && now - r.lastAt < ACTIVE_MS)) return "active";
  if ((r.dirty ?? 0) > 0) return "dirty";
  return r.lastAt !== null && now - r.lastAt <= STALE_MS ? "recent" : "stale";
}

export type WtFocus = "list" | "detail";
export type WtUi = { sel: number; filter: string; typing: boolean; note: string[]; focus: WtFocus; top: number; dscroll: number; open: Record<string, boolean>; /** selected changed file (then commit) in the detail pane: files first, commits after */ fsel: number; /** the file or commit whose diff is open (enter in the detail pane); esc closes */ diff: WtDiffKey | null; confirm: boolean; pruneGo: boolean };
/** sel starts at 1: item 0 is always a state header, so the first worktree is selected (clamped to the item count where drawn). */
export const initialWtUi = (): WtUi => ({ sel: 1, filter: "", typing: false, note: [], focus: "list", top: 0, dscroll: 0, open: {}, fsel: 0, diff: null, confirm: false, pruneGo: false });
const matches = (r: WtRow, f: string) => !f || [r.name, r.branch ?? "", r.bead ?? "", r.agent ?? "", r.repo, r.beadTitle ?? ""].some(x => x.toLowerCase().includes(f.toLowerCase()));
export const visibleRows = (groups: readonly WtGroup[], filter: string): WtRow[] => groups.flatMap(g => g.rows.filter(r => matches(r, filter)));

/** `prune` = the dry-run plans (one per repo) when the collector computed them; `pruned` = the one-line result of the last confirmed prune. */
export type WtView = { groups: WtGroup[]; now: number; error?: string; all: boolean; /** the diff of ui.diff, read on demand by the app */ fileDiff?: WtFileDiff; prune?: PrunePlan[]; pruned?: string };
const pruneSet = (v: Pick<WtView, "prune">): Set<string> => new Set((v.prune ?? []).flatMap(p => p.safe.map(e => e.path)));
/** Navigable things, in drawn order: a state header (fold toggle) or a worktree. Stale is collapsed unless the owner opened it; a filter opens every group with a match. */
export type WtItem = { k: "group"; key: string; repo: string; state: WtState; count: number; open: boolean } | { k: "row"; row: WtRow };
export const groupKey = (repo: string, s: WtState) => `${repo}|${s}`;
export function itemsOf(v: WtView, ui: Pick<WtUi, "filter" | "open">): WtItem[] {
  const out: WtItem[] = [], pr = pruneSet(v);
  for (const g of v.groups) for (const s of STATES) {
    const rs = g.rows.filter(r => matches(r, ui.filter) && (s === "prune" ? pr.has(r.path) : !pr.has(r.path) && stateOf(r, v.now) === s)); if (!rs.length) continue;
    const key = groupKey(g.repo, s), open = ui.filter ? true : (ui.open[key] ?? (s !== "stale" && s !== "prune"));
    out.push({ k: "group", key, repo: g.repo, state: s, count: rs.length, open }); if (open) for (const r of rs) out.push({ k: "row", row: r });
  }
  return out;
}
const clampSel = (ui: WtUi, n: number): WtUi => { const sel = Math.max(0, Math.min(ui.sel, n - 1)); return sel === ui.sel ? ui : { ...ui, sel }; };
export const selectedRow = (v: WtView | null, ui: WtUi): WtRow | null => { const it = v ? itemsOf(v, ui)[clampSel(ui, itemsOf(v, ui).length).sel] : undefined; return it?.k === "row" ? it.row : null; };

/** Quote a path for a shell only when it needs it. */
export const shq = (s: string) => (/^[\w./@:+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// ---- geometry: ONE function both the drawing and the reducers read -------------------------------------------------------------
export const TWO_PANE = 130;
export type WtGeom = { two: boolean; listW: number; detX: number; detW: number; top: number; listH: number; detH: number; ruleY: number; statusY: number; keysY: number };
/** `big` = a file diff is open: the one-pane layout gives the detail pane nearly the whole body (the list keeps three rows). */
export function wtGeom(size: Size, big = false): WtGeom {
  const cols = Math.max(40, size.cols), rows = Math.max(12, size.rows), keysY = rows - 1, statusY = rows - 2;
  if (cols >= TWO_PANE) { const listW = Math.floor(cols * 0.52), top = 2; return { two: true, listW, detX: listW + 1, detW: cols - listW - 1, top, listH: statusY - top, detH: statusY - top, ruleY: 1, statusY, keysY }; }
  const detH = big ? Math.max(6, statusY - 5) : Math.max(6, Math.min(14, Math.floor(rows * 0.42))), ruleY = statusY - detH - 1;
  return { two: false, listW: cols, detX: 0, detW: cols, top: 1, listH: ruleY - 1, detH, ruleY, statusY, keysY };
}

const glyphOf = (r: WtRow): Seg1 => (r.dirty === null ? S("?", { c: C.ye }) : r.dirty > 0 ? S("◐", { c: C.ye }) : S("●", { c: C.gr }));
type Seg1 = ReturnType<typeof S>;
const syncText = (r: WtRow): Line => (r.upstream === null ? [S("no upstream", mu)] : r.ahead === 0 && r.behind === 0 ? [S("in sync", mu)] : [S(`↑${r.ahead ?? 0}`, r.ahead ? { c: C.cy } : mu), S(` ↓${r.behind ?? 0}`, r.behind ? { c: C.or } : mu)]);

/** The list as drawn lines, each tied to its item index (null = not selectable). One line per item, so the list scrolls by whole items. */
export function listLines(v: WtView, ui: WtUi, w: number, multi = v.groups.length > 1): { lines: Line[]; itemAt: (number | null)[] } {
  const items = itemsOf(v, ui), lines: Line[] = [], itemAt: (number | null)[] = [];
  let lastRepo: string | null = null;
  const stateLast = (i: number) => { for (let j = i + 1; j < items.length; j++) { const it = items[j]; if (it.k === "group") return it.repo !== (items[i] as { repo: string }).repo; } return true; };
  items.forEach((it, i) => {
    const sel = i === ui.sel && ui.focus === "list" || i === ui.sel;
    const arm = (last: boolean) => (sel ? (last ? "└─▸ " : "├─▸ ") : last ? "└── " : "├── ");
    if (it.k === "group") {
      if (multi && it.repo !== lastRepo) { lines.push(clipLine([S(`▾ ${basename(it.repo)}`, { b: true, c: C.bl })], w)); itemAt.push(null); }
      lastRepo = it.repo;
      const last = stateLast(i), l: Line = [S("  "), S(arm(last), mu), S(it.open ? "▾ " : "▸ ", mu), S(STATE_LABEL[it.state], { b: true, c: it.state === "stale" || it.state === "prune" ? C.mu : it.state === "dirty" ? C.ye : it.state === "active" ? C.gr : C.bl }), S(`  ${it.count}`, mu)];
      lines.push(clipLine(sel ? withStyle(l, { bg: SEL_BG }) : l, w)); itemAt.push(i); return;
    }
    const r = it.row, nextIsRow = items[i + 1]?.k === "row", rail = items.slice(0, i).reverse().find(x => x.k === "group") as Extract<WtItem, { k: "group" }>;
    const groupLast = stateLast(items.findIndex(x => x === rail)), pad = groupLast ? "    " : "│   ";
    const bloc: Line = cat(...[r.bead ? [S(r.bead, { c: C.or }), S("  ")] : [], r.agent ? [S(`◍ ${r.agent}`, { c: C.gr }), S("  ")] : [], syncText(r), [S("  ")], r.dirty === null ? [S("status ?", { c: C.ye })] : r.dirty > 0 ? [S(`✎ ${r.dirty}`, { c: C.ye })] : [S("clean", mu)], [S(`  ${r.lastAt === null ? "-" : ageText(v.now - r.lastAt)}`.padStart(5), mu)]]);
    const blocLen = bloc.reduce((n, g) => n + g.t.length, 0), left: Line = [S(`  ${pad}`), S(arm(!nextIsRow), mu), glyphOf(r), S(` ${r.name}`, { b: r.main })];
    const room = w - blocLen - 2 - left.reduce((n, g) => n + g.t.length, 0);
    const br = r.branch ?? "(detached)", brSeg: Line = room >= 8 ? [S("  "), S(br.length > room - 2 ? `${br.slice(0, Math.max(1, room - 3))}…` : br, { c: r.branch ? C.bl : C.ye })] : [];
    let l = cat(left, brSeg);
    l = w - blocLen - 1 > l.reduce((n, g) => n + g.t.length, 0) ? cat(padLine(l, w - blocLen - 1), bloc) : clipLine(l, w);
    lines.push(clipLine(sel ? withStyle(padLine(l, w), { bg: SEL_BG }) : l, w)); itemAt.push(i);
  });
  return { lines, itemAt };
}

/** The detail pane's lines for the selected worktree (notes first, in yellow), and which changed file (index into r.files) each line is, for the click map. */
export function detailModel(r: WtRow | null, note: readonly string[], now: number, w: number, fsel: number | null = null): { lines: Line[]; fileAt: (number | null)[] } {
  const out: Line[] = note.map(n => [S(` ${n}`, { c: C.ye })]), fileAt: (number | null)[] = out.map(() => null), push = (l: Line, f: number | null = null) => { out.push(l); fileAt.push(f); };
  if (!r) { push([S(" select a worktree to see its branch, changes and commits", mu)]); return { lines: out, fileAt }; }
  const k = (t: string): Seg1 => S(` ${t.padEnd(8)}`, mu);
  push([S(` ${r.name}`, { b: true }), ...(r.main ? [S("  main worktree", mu)] : [])]);
  push([k("branch"), S(r.branch ?? "(detached)", { c: r.branch ? C.bl : C.ye })]);
  push([k("sync"), ...(r.upstream ? [S(`${r.upstream}  `, mu)] : []), ...syncText(r)]);
  push([k("bead"), ...(r.bead ? [S(r.bead, { c: C.or }), S(r.beadTitle ? `  ${r.beadTitle}` : "")] : [S("none linked", mu)])]);
  push([k("agent"), ...(r.agent ? [S(`◍ ${r.agent}`, { c: C.gr })] : [S("no agent pane known", mu)])]);
  push([k("path"), S(r.path, mu)]);
  push([k("changes"), ...(r.dirty === null ? [S("status unreadable", { c: C.ye })] : r.dirty ? [S(`✎ ${r.dirty} file${r.dirty === 1 ? "" : "s"}`, { c: C.ye }), ...(r.stat?.summary ? [S(`  ${r.stat.summary}`, mu)] : [])] : [S("clean", mu)])]);
  const tails = new Map((r.stat?.files ?? []).map(f => [f.path, f.tail] as const)), tailOf = (p: string) => tails.get(p) ?? [...tails].find(([q]) => p.endsWith(q))?.[1];
  r.files.slice(0, FILES_SHOWN).forEach((f, i) => { const t = tailOf(f.path), l: Line = [S(`  ${fsel === i ? "▸" : " "}${f.code.padEnd(2)} `, { c: C.ye }), S(f.path), ...(t ? [S(`  | ${t}`, mu)] : [])]; push(fsel === i ? withStyle(l, { bg: SEL_BG }) : l, i); });
  if (r.files.length > FILES_SHOWN) push([S(`   +${r.files.length - FILES_SHOWN} more`, mu)]);
  const nf = Math.min(r.files.length, FILES_SHOWN);
  if (r.files.length || r.commits.length) push([S(fsel === null ? "   (click here or press tab: pick a file or commit, enter = diff, o = editor)" : "   j/k pick · enter opens the diff · o opens in your editor", mu)]);
  push([k("commits"), ...(r.commits.length ? [] : [S("none read", mu)])]);
  r.commits.slice(0, COMMITS_SHOWN).forEach((c, j) => { const l: Line = [S(`  ${fsel === nf + j ? "▸" : " "} ${c.sha.slice(0, 7)} `, { c: C.cy }), S(`${ageText(now - c.at).padEnd(4)} `, mu), S(c.subject)]; push(fsel === nf + j ? withStyle(l, { bg: SEL_BG }) : l, nf + j); });
  return { lines: out.map(l => clipLine(l, w)), fileAt };
}
export const FILES_SHOWN = 200, COMMITS_SHOWN = 5;
/** The detail pane's pickable things in order: the changed files, then the commits. */
export const pickables = (r: WtRow | null): { files: WtFile[]; commits: WtCommit[]; n: number } => { const files = r?.files.slice(0, FILES_SHOWN) ?? [], commits = r?.commits.slice(0, COMMITS_SHOWN) ?? []; return { files, commits, n: files.length + commits.length }; };
export const detailLines = (r: WtRow | null, note: readonly string[], now: number, w: number): Line[] => detailModel(r, note, now, w).lines;

/** One unified-diff line, coloured by its first character; the +/-/@ glyph stays, so colour is never the only signal. */
export function diffLine(t: string): Line {
  const l = `  ${t}`;
  if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(t)) return [S(l, { b: true, dim: true })];
  if (t.startsWith("@@")) return [S(l, { c: C.cy })];
  if (t.startsWith("+")) return [S(l, { c: C.gr })];
  if (t.startsWith("-")) return [S(l, { c: C.rd })];
  if (t.startsWith("…")) return [S(l, mu)];
  return [S(l)];
}
/** What the detail pane shows: the selected worktree's detail, or - while a file diff is open - that file's coloured diff. */
export function detailBody(v: WtView | null, ui: WtUi, w: number): { lines: Line[]; fileAt: (number | null)[]; diff: boolean } {
  const r = v ? selectedRow(v, ui) : null;
  if (ui.diff && r && ui.diff.path === r.path) {
    const d = v?.fileDiff && sameDiff(v.fileDiff, ui.diff) ? v.fileDiff : null;
    const head: Line[] = [[S(` ${ui.diff.file ?? `commit ${ui.diff.sha?.slice(0, 7)}`}`, { b: true }), S("  esc back · j/k scroll · o open in editor", mu)]];
    const lines = d ? [...head, ...(d.note ? [[S(`  ${d.note}`, { c: C.ye })] as Line] : []), ...d.lines.map(diffLine)] : [...head, [S("  reading diff…", mu)]];
    return { lines: lines.map(l => clipLine(l, w)), fileAt: lines.map(() => null), diff: true };
  }
  const m = detailModel(r, ui.note, v?.now ?? 0, w, ui.focus === "detail" ? Math.max(0, Math.min(ui.fsel, pickables(r).n - 1)) : null);
  return { ...m, diff: false };
}

const KEYS: KeyItem[] = [
  { k: "j/k", label: "move", key: null }, { k: "enter", label: "open/fold", key: "enter" }, { k: "tab", label: "panel", key: "tab" }, { k: "/", label: "find", key: { ch: "/" } },
  { k: "o", label: "open", key: { ch: "o" } }, { k: "d", label: "remove", key: { ch: "d" } }, { k: "r", label: "refresh", key: { ch: "r" } }, { k: "q", label: "quit", key: "quit" },
];
const PRUNE_KEY: (typeof KEYS)[number] = { k: "p", label: "prune", key: { ch: "p" } };
const clampTop = (top: number, sel: number, h: number, n: number) => Math.max(0, Math.min(Math.max(0, n - h), sel < top ? sel : sel >= top + h ? sel - h + 1 : top));

export type RenderOpts = { cols: number; rows?: number; color: boolean; /** a one-line notice appended to the status row (e.g. the mouse hint) */ hint?: string | null };
/** The frame and its click map from one pass. */
export function layoutWorktrees(v: WtView, ui0: WtUi, o: RenderOpts): Frame {
  const cols = Math.max(40, o.cols), rows = Math.max(12, o.rows ?? 30), g = wtGeom({ cols, rows }, !!ui0.diff), out: Line[] = Array.from({ length: rows }, () => []), hits: Hit[] = [];
  const items = itemsOf(v, ui0); const ui = clampSel(ui0, items.length); const flat = visibleRows(v.groups, ui.filter), total = v.groups.reduce((n, x) => n + x.rows.length, 0);
  const dirty = flat.filter(r => (r.dirty ?? 0) > 0).length, agents = flat.filter(r => r.agent).length;
  // header: inverse row, repo + time left, counts right
  const name = v.groups.length === 1 ? v.groups[0].name : v.groups.length ? `${v.groups.length} repos` : "worktrees";
  const right = `${flat.length}${ui.filter ? `/${total}` : ""}  ⚠ ${dirty} dirty  ◍ ${agents}${v.prune ? `  ⌫ ${prunableText({ safe: v.prune.flatMap(p => p.safe) } as PrunePlan)}` : ""}`;
  out[0] = headerLine([S(`▾ ${name}  ✓ ${clockText(v.now)}`, { inv: true }), ...(v.error ? [S(`  ⚠ ${v.error}`, { inv: true, c: C.rd })] : [])], [right], cols);
  hits.push({ y: 0, x0: 0, x1: cols, act: { k: "panel", panel: "list" } });
  // list
  const { lines, itemAt } = listLines(v, ui, g.listW, v.groups.length > 1), selLine = Math.max(0, itemAt.indexOf(ui.sel)), top = clampTop(ui.top, selLine, g.listH, lines.length);
  lines.slice(top, top + g.listH).forEach((l, i) => { out[g.top + i] = l; const it = itemAt[top + i]; if (it !== null) hits.push({ y: g.top + i, x0: 0, x1: g.listW, act: { k: "row", panel: "list", i: it } }); });
  if (!items.length) out[g.top] = [S(v.groups.length ? "  no worktree matches the filter" : "  no worktrees found", mu)];
  // detail
  const body = detailBody(v, ui, g.detW), dl = body.lines, ds = Math.max(0, Math.min(ui.dscroll, Math.max(0, dl.length - g.detH)));
  const dline = (i: number): Line => dl.slice(ds, ds + g.detH)[i] ?? [];
  /** a changed-file line of the detail pane is its own click target (row "files"), drawn over the pane's panel hit */
  const fileHits = (y0: number, x0: number, x1: number): Hit[] => Array.from({ length: g.detH }, (_, i) => ({ y: y0 + i, i: body.fileAt[ds + i] })).flatMap(h => (h.i === null || h.i === undefined ? [] : [{ y: h.y, x0, x1, act: { k: "row", panel: "files", i: h.i } as const }]));
  const label = panelRule;
  if (g.two) {
    out[1] = cat(label("WORKTREES", g.listW, ui.focus === "list"), [S("┬", mu)], label(ui.diff ? "DIFF" : "DETAIL", g.detW, ui.focus === "detail"));
    hits.push({ y: 1, x0: 0, x1: g.listW, act: { k: "panel", panel: "list" } }, { y: 1, x0: g.detX, x1: cols, act: { k: "panel", panel: "detail" } });
    for (let i = 0; i < g.detH; i++) { const y = g.top + i; out[y] = cat(padLine(out[y], g.listW), [S("│", mu)], dline(i)); }
    hits.push(...Array.from({ length: g.detH }, (_, i) => ({ y: g.top + i, x0: g.detX, x1: cols, act: { k: "panel", panel: "detail" } as const })), ...fileHits(g.top, g.detX, cols));
  } else {
    out[g.ruleY] = label(ui.diff ? "DIFF" : "DETAIL", cols, ui.focus === "detail"); hits.push({ y: g.ruleY, x0: 0, x1: cols, act: { k: "panel", panel: "detail" } });
    for (let i = 0; i < g.detH; i++) out[g.ruleY + 1 + i] = dline(i);
    hits.push(...Array.from({ length: g.detH }, (_, i) => ({ y: g.ruleY + 1 + i, x0: 0, x1: cols, act: { k: "panel", panel: "detail" } as const })), ...fileHits(g.ruleY + 1, 0, cols));
  }
  // status + keys
  out[g.statusY] = statusLine(ui.typing ? ` filter: ${ui.filter}▏  enter keep · esc clear` : ` ${items.length ? `${ui.sel + 1}/${items.length}` : "0/0"}  ${flat.length} worktree${flat.length === 1 ? "" : "s"} · ${dirty} dirty · ${agents} agent${agents === 1 ? "" : "s"}${ui.filter ? `  /${ui.filter}` : ""}${ui.note.length ? "  · note in detail" : ""}${o.hint ? `  · ${o.hint}` : ""}${v.pruned ? `  · ${v.pruned}` : ""}`, cols);
  const kr = keyRows(v.prune?.some(p => p.safe.length) ? [...KEYS.slice(0, 5), PRUNE_KEY, ...KEYS.slice(5)] : KEYS, cols); hits.push(...kr.hits.map(h => ({ y: g.keysY, x0: h.x0, x1: h.x1, act: { k: "key", key: h.key } as const }))); out[g.keysY] = kr.rows[0];
  const done = out.map(trimEnd);
  return { lines: o.color ? done : done.map((l, y) => (itemAt[y - g.top + top] === ui.sel && y >= g.top && y < g.top + g.listH ? l : l)), hits: hits };
}
export const renderWorktrees = (v: WtView, ui: WtUi, o: RenderOpts): Line[] => layoutWorktrees(v, ui, o).lines;

export function removeText(r: WtRow): string[] {
  const dir = r.main ? null : shq(r.path);
  if (!dir) return [`${r.name} is the main worktree of ${r.repo}: git will not remove it.`];
  return [`remove ${r.name}: this app never runs it. In a shell:`, `  git -C ${shq(r.repo)} worktree remove ${dir}`, ...((r.dirty ?? 0) > 0 ? [`  (it has ${r.dirty} uncommitted change${r.dirty === 1 ? "" : "s"}: git refuses until they are committed or discarded)`] : [])];
}

/** The prune plan in the detail pane: the SAFE list, the totals, and the y/n question. Never removes anything by itself. */
export function pruneNote(v: WtView | null): string[] {
  const plans = v?.prune ?? [];
  if (!plans.length) return ["prune: no plan loaded"];
  const safe = plans.flatMap(p => p.safe), tail = (p: PrunePlan) => planText(p).slice(-2);
  if (!safe.length) return ["prune: nothing is SAFE to remove right now", ...plans.flatMap(tail)];
  return [`prune would remove ${safe.length} worktree${safe.length === 1 ? "" : "s"} (never forced, branches kept):`, ...safe.slice(0, 8).map(e => `  ${e.name}  ${e.reason}`), ...(safe.length > 8 ? [`  +${safe.length - 8} more`] : []), ...plans.flatMap(tail), `remove these ${safe.length}? y = yes, any other key = no`];
}
const reveal = (ui0: WtUi, v: WtView | null, size: Size): WtUi => {
  if (!v) return ui0;
  const ui = clampSel(ui0, itemsOf(v, ui0).length);
  const g = wtGeom(size), { itemAt, lines } = listLines(v, ui, g.listW, v.groups.length > 1);
  return { ...ui, top: clampTop(ui.top, Math.max(0, itemAt.indexOf(ui.sel)), g.listH, lines.length), dscroll: 0, fsel: 0, diff: null };
};
const DEFAULT_SIZE: Size = { cols: 100, rows: 30 };
/** The side effects the reducers may ask for, injected so the reducers stay pure and the tests can spy: open a worktree (and a file in it) in the editor. */
export type WtEnv = { open: (worktree: string, file: string | null) => string };
export const NO_ENV: WtEnv = { open: () => "open in editor is not available here" };
export function worktreesKey(ui0: WtUi, k: Key, v: WtView | null, size: Size = DEFAULT_SIZE, env: WtEnv = NO_ENV): Reduced<WtUi> {
  const items = v ? itemsOf(v, ui0) : [], ui = clampSel(ui0, items.length);
  if (ui.typing) {
    if (k === "esc") return { ui: { ...ui, typing: false, filter: "", sel: 0, top: 0 } };
    if (k === "enter") return { ui: { ...ui, typing: false } };
    if (k === "quit") return { ui, quit: true };
    if (typeof k === "object") return { ui: { ...ui, filter: k.ch === "\x7f" ? ui.filter.slice(0, -1) : (ui.filter + k.ch).slice(0, 40), sel: 0, top: 0 } };
    return { ui };
  }
  if (ui.confirm) return isCh(k, "y") ? { ui: { ...ui, confirm: false, pruneGo: true, note: ["pruning the SAFE worktrees (each re-checked first)…"] }, refresh: true } : { ui: { ...ui, confirm: false, note: ["prune cancelled: nothing removed"] } };
  if (k === "quit") return { ui, quit: true };
  if (k === "esc" && ui.diff) return { ui: { ...ui, diff: null, dscroll: 0 } };
  if (k === "tab" || k === "shift-tab") return { ui: { ...ui, focus: ui.focus === "list" ? "detail" : "list", note: [] } };
  if (isDown(k) || isUp(k)) {
    if (ui.focus === "detail") return { ui: ui.diff || !pickables(selectedRow(v, ui)).n ? scrollDetail(ui, v, size, isDown(k) ? 1 : -1) : pickItem(ui, v, size, isDown(k) ? 1 : -1) };
    return { ui: reveal({ ...ui, sel: Math.min(Math.max(0, items.length - 1), Math.max(0, ui.sel + (isDown(k) ? 1 : -1))), note: [] }, v, size) };
  }
  if (isCh(k, "/")) return { ui: { ...ui, typing: true, note: [] } };
  if (isCh(k, "r")) return { ui, refresh: true };
  const it = items[ui.sel], r = it?.k === "row" ? it.row : null;
  if (k === "enter" && ui.focus === "detail" && !ui.diff && pickables(selectedRow(v, ui)).n) return openDiff(ui, v);
  if (isCh(k, "o")) { const row = selectedRow(v, ui); if (!row) return { ui: { ...ui, note: ["select a worktree first"] } }; const f = ui.diff ? ui.diff.file ?? null : ui.focus === "detail" ? pickables(row).files[ui.fsel]?.path ?? null : null; return { ui: { ...ui, note: [env.open(row.path, f)] } }; }
  if (k === "enter" || isCh(k, " ")) {
    if (it?.k === "group") return { ui: reveal({ ...ui, open: { ...ui.open, [it.key]: !it.open }, note: [] }, v, size) };
    if (k === "enter") return { ui: { ...ui, note: r ? [`cd ${shq(r.path)}`] : [] } };
    return { ui };
  }
  if (isCh(k, "p")) return { ui: { ...ui, note: pruneNote(v), confirm: !!v?.prune?.some(p => p.safe.length) } };
  if (isCh(k, "d")) return { ui: { ...ui, note: r ? removeText(r) : [] } };
  return { ui };
}
/** Move the pick among the changed files then the commits, keeping the picked line inside the pane. */
function pickItem(ui: WtUi, v: WtView | null, size: Size, d: number): WtUi {
  const r = v ? selectedRow(v, ui) : null, n = pickables(r).n, fsel = Math.max(0, Math.min(n - 1, Math.min(ui.fsel, n - 1) + d)), g = wtGeom(size), body = detailBody(v, { ...ui, fsel, focus: "detail" }, g.detW), at = Math.max(0, body.fileAt.indexOf(fsel));
  return { ...ui, fsel, dscroll: at < ui.dscroll ? at : at >= ui.dscroll + g.detH ? at - g.detH + 1 : ui.dscroll };
}
/** enter in the detail pane: open the picked file's (or commit's) diff; the app reads it on the refresh this asks for. */
function openDiff(ui: WtUi, v: WtView | null): Reduced<WtUi> {
  const r = v ? selectedRow(v, ui) : null, p = pickables(r), i = Math.min(ui.fsel, p.n - 1);
  if (!r || i < 0) return { ui };
  const diff: WtDiffKey = i < p.files.length ? { path: r.path, file: p.files[i].path } : { path: r.path, sha: p.commits[i - p.files.length].sha };
  return { ui: { ...ui, diff, dscroll: 0, note: [] }, refresh: true };
}
function scrollDetail(ui: WtUi, v: WtView | null, size: Size, d: number): WtUi {
  const g = wtGeom(size, !!ui.diff), n = detailBody(v, ui, g.detW).lines.length;
  return { ...ui, dscroll: Math.max(0, Math.min(Math.max(0, n - g.detH), ui.dscroll + d)) };
}
/** PURE mouse reducer: click selects a row / focuses a panel / presses a key; double-click is enter; the wheel scrolls the focused panel. */
export function worktreesMouse(ui: WtUi, a: MouseAct, v: WtView | null, size: Size = DEFAULT_SIZE, env: WtEnv = NO_ENV): Reduced<WtUi> {
  if (ui.typing) return { ui };
  if (a.kind === "wheel") return worktreesKey(ui, a.dir > 0 ? "down" : "up", v, size, env);
  const h = a.hit;
  if (!h) return { ui };
  if (h.k === "key") return worktreesKey(ui, h.key, v, size, env);
  if (h.k === "row" && h.panel === "files") { const ui3: WtUi = { ...ui, focus: "detail", fsel: h.i, note: [] }; return a.kind === "dblclick" ? openDiff(ui3, v) : { ui: ui3 }; }
  if (h.k === "panel") return { ui: { ...ui, focus: h.panel === "detail" ? "detail" : "list", note: [] } };
  const ui2 = reveal({ ...ui, focus: "list", sel: h.i, note: [] }, v, size);
  return a.kind === "dblclick" ? worktreesKey(ui2, "enter", v, size, env) : { ui: ui2 };
}
