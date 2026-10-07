// PURE layout for the WORK tree, held to PARITY with beady-eye's README "arkham" frame, then better where a GUI can be
// (owner 22:39 + 23:00). beady-eye (Apache-2.0) is the reference: its look, and a few of its
// strings ("✓ n more beads · finished", the key row), are reproduced with attribution in third_party/NOTICE-beady-eye.md. No
// code is copied (it is Rust/ratatui); this is written against Osiris's own sidebarRows().
//
// Parity rules, measured from docs/bdi-frame.svg (88x26): guides four columns a level in the foreground; an id column padded
// to the widest id; in-progress glyph+id in the accent; done glyph+id dim and the title dimmer; a right bloc flush right (n/m,
// then "◍ wG:p2 · working" or "⚠ claimed · no pane"); `├─▸` on a folded bead; closed siblings drawn in place, folded to a count
// only in a long run; unattributed panes last under the root; a pane band "── wG:p2 ──" with the pane's last lines.
// Better than a TUI: a hover hint (full title, what it waits on, the warning in plain English), a live flag that animates a
// working agent, an optional cost chip, and a wide-short strip variant (the component).
import { boardCards, sidebarRows } from "./surface-model.ts";
import type { PaneTail, SidebarRow, TreeNode, UnattributedPane, WorkSurfaceSnapshot } from "./surface-types.ts";
import { anomalyText } from "./ui-text.ts";

export type BeadState = "active" | "open" | "done" | "blocked";
export type Tone = "muted" | "success" | "attention" | "failure" | "info" | "drift"; // drift = tracker/pane/worktree disagree (its own hue, never failure red; ui-v2 W14)
/** live: a working agent (the component pulses its ◍). short / tiny: what the segment shrinks to in a narrow tree (the split
 *  strip puts the tree in ~260-500px beside the Factory); the full text stays in the row's hover. */
export type Seg = { text: string; tone: Tone; live?: boolean; short?: string; tiny?: string };
/** Words the tree prints for Work-surface jargon. Default: the owner's own words. When work/glossary.ts lands (fix/plain-words),
 *  the wiring passes { label: termLabel, def: termDef } so the tree uses the ONE glossary, not its own copy. */
export type TreeTermKey = "pane" | "bead" | "claim";
export type TreeTerms = { label(k: TreeTermKey): string; def?(k: TreeTermKey): string };
export const OWNER_TERMS: TreeTerms = { label: k => k };
export type TreeLine =
  | { kind: "bead"; key: string; id: string; shortId: string; title: string; fullTitle: string; guide: string; glyph: string; state: BeadState; right: Seg[]; selected: boolean; paneId: string | null; folded: boolean; foldable: boolean; hint: string; drift: boolean }
  | { kind: "fold"; key: string; guide: string; text: string }
  | { kind: "group"; key: string; guide: string; text: string; hint: string; drift?: boolean }
  | { kind: "pane"; key: string; guide: string; label: string; state: string; cwd: string | null; live: boolean; paneId: string; hint: string };
export type TreeHeader = { tracker: string; age: string; frac: string | null; agents: number; warnings: number };
export type TreeLayout = { header: TreeHeader; lines: TreeLine[]; idWidth: number; tail: { label: string; beadId: string; lines: string[]; truncated: boolean } | null };
export type AgentRef = { paneId: string; label: string; state: string | null };
export type LayoutOpts = {
  selectedId?: string | null; showDone?: boolean; tail?: PaneTail | null; tailLines?: number;
  /** Beads whose children are hidden; drawn with the `├─▸` arm (beady-eye's fold marker). */
  folded?: ReadonlySet<string>;
  /** Optional per-bead cost text ("$0.42"), shown in the right bloc once costs are wired. */
  costs?: ReadonlyMap<string, string>;
  /** Hover hints (full title, waits-on, warning in plain English), keyed by bead id. treeFromSnapshot fills it. */
  hints?: ReadonlyMap<string, string>;
  /** Labels and definitions for jargon (see TreeTerms). */
  terms?: TreeTerms;
};

/** Guide cells, four columns a level, in the foreground (beady-eye: "the box-drawing stays in the terminal's own foreground"). */
export const GUIDE = { tee: "├── ", elbow: "└── ", pipe: "│   ", gap: "    ", teeFold: "├─▸ ", elbowFold: "└─▸ " } as const;
/** A run of at least this many closed siblings is drawn as one count line; shorter runs are drawn in place, dimmed (arkham). */
export const DONE_FOLD_MIN = 4;

type Node = { row: SidebarRow; kids: Node[] };

/** Flat depth-ordered rows → a forest. A row deeper than its predecessor + 1 (a gap in the input) hangs on the nearest open parent. */
export function forest(rows: readonly SidebarRow[]): Node[] {
  const roots: Node[] = [], stack: Node[] = [];
  for (const row of rows) {
    const n: Node = { row, kids: [] };
    while (stack.length > row.depth) stack.pop();
    (stack.length ? stack[stack.length - 1].kids : roots).push(n);
    stack.push(n);
  }
  return roots;
}

const stateOf = (s: string | null | undefined): string => (s ?? "").toLowerCase();
/** "◍ wG:p2 · working": success and live when working, attention when blocked at a prompt, muted when idle. */
const agentSeg = (label: string, state: string | null | undefined): Seg => {
  const st = stateOf(state);
  return { text: `◍ ${label}${st ? ` · ${st}` : ""}`, short: `◍ ${label}`, tiny: "◍", tone: st === "working" ? "success" : st === "blocked" ? "attention" : "muted", ...(st === "working" ? { live: true } : {}) };
};
const beadState = (r: SidebarRow): BeadState => (r.glyph === "✓" ? "done" : r.glyph === "⊘" ? "blocked" : r.glyph === "◐" ? "active" : "open");
const count = (n: Node): number => 1 + n.kids.reduce((a, k) => a + count(k), 0);
/** bdi's n/m: finished over all beads in the subtree INCLUDING the bead itself (arkham: ark-1 "2/9", ark-3 "0/3"). */
const finished = (n: Node): number => (n.row.dim ? 1 : 0) + n.kids.reduce((a, k) => a + finished(k), 0);

/** Lay out the tree under one header. */
export function treeLayout(rows: readonly SidebarRow[], header: TreeHeader, agents: ReadonlyMap<string, AgentRef>, unattributed: readonly UnattributedPane[], opts: LayoutOpts = {}): TreeLayout {
  const lines: TreeLine[] = [];
  type Item = { node: Node } | { fold: number };
  const emit = (nodes: readonly Node[], prefix: string, trailingSiblings: boolean) => {
    // Sibling items in order; a long run of closed siblings (and everything under them) becomes one count item.
    const items: Item[] = [];
    for (let i = 0; i < nodes.length;) {
      let j = i;
      while (j < nodes.length && nodes[j].row.dim) j++;
      if (!opts.showDone && j - i >= DONE_FOLD_MIN) { items.push({ fold: nodes.slice(i, j).reduce((a, n) => a + count(n), 0) }); i = j; continue; }
      if (j > i) { for (; i < j; i++) items.push({ node: nodes[i] }); continue; }
      items.push({ node: nodes[i++] });
    }
    items.forEach((it, i) => {
      const last = i === items.length - 1 && !trailingSiblings;
      if ("fold" in it) { const b = (opts.terms ?? OWNER_TERMS).label("bead"); lines.push({ kind: "fold", key: `${prefix}#fold:${i}`, guide: prefix + (last ? GUIDE.elbowFold : GUIDE.teeFold), text: `✓ ${it.fold} more ${b}${it.fold === 1 ? "" : "s"} · finished` }); return; }
      const r = it.node.row, a = agents.get(r.id) ?? null;
      const size = count(it.node), foldable = size > 1, folded = foldable && !!opts.folded?.has(r.id);
      const right: Seg[] = [];
      if (size > 1) right.push({ text: `${finished(it.node)}/${size}`, tone: "muted" });
      const cost = opts.costs?.get(r.id);
      if (cost) right.push({ text: cost, tone: "muted" });
      if (r.warn) right.push({ text: r.warn, short: "⚠", tiny: "⚠", tone: "drift" }); // the drift badge replaces the old "⚠ words" (W14); the glyph stays only as the narrow form
      else if (a) right.push(agentSeg(a.label, a.state));
      lines.push({
        kind: "bead", key: r.key, id: r.id, shortId: r.shortId, title: r.title, fullTitle: r.fullTitle,
        guide: prefix + (folded ? (last ? GUIDE.elbowFold : GUIDE.teeFold) : last ? GUIDE.elbow : GUIDE.tee),
        glyph: r.glyph, state: beadState(r), right, selected: opts.selectedId === r.id, paneId: a?.paneId ?? null, folded, foldable, drift: !!r.warn,
        hint: opts.hints?.get(r.id) ?? `${r.id} · ${r.fullTitle}`,
      });
      if (!folded) emit(it.node.kids, prefix + (last ? GUIDE.gap : GUIDE.pipe), false);
    });
  };
  emit(forest(rows), "", unattributed.length > 0);
  if (unattributed.length > 0) {
    const T = opts.terms ?? OWNER_TERMS, pane = T.label("pane"), bead = T.label("bead"), def = T.def?.("pane");
    const what = `${unattributed.length === 1 ? `a ${pane}` : `${pane}s`} working in this project that no ${bead} claims${def ? ` (${pane}: ${def})` : ""}`;
    lines.push({ kind: "group", key: "#unattributed", guide: GUIDE.elbow, text: `${unattributed.length} unattributed ${pane}${unattributed.length === 1 ? "" : "s"}`, drift: true, hint: `${unattributed.length} ${what}` });
    unattributed.forEach((u, i) => { const st = stateOf(u.state) || "unknown"; lines.push({ kind: "pane", key: `#u:${u.paneId}`, guide: GUIDE.gap + (i === unattributed.length - 1 ? GUIDE.elbow : GUIDE.tee), label: u.paneId, state: st, cwd: u.cwd, live: st === "working", paneId: u.paneId, hint: `${u.paneId}: ${st}${u.cwd ? ` in ${u.cwd}` : ""}; no ${bead} claims it` }); });
  }
  const beadLines = lines.filter((l): l is Extract<TreeLine, { kind: "bead" }> => l.kind === "bead");
  const idWidth = beadLines.reduce((w, l) => Math.max(w, [...l.shortId].length), 0);
  const sel = opts.selectedId ? beadLines.find(l => l.id === opts.selectedId) : undefined;
  const t = opts.tail && sel?.paneId && opts.tail.paneId === sel.paneId ? opts.tail : null;
  const n = opts.tailLines ?? 6;
  return { header, lines, idWidth, tail: t ? { label: agents.get(sel!.id)?.label ?? t.paneId, beadId: sel!.id, lines: t.lines.slice(-n), truncated: t.truncated || t.lines.length > n } : null };
}

/** Hover hints from the snapshot: full title, what the bead waits on (id · title), and each warning in plain English. */
export function hintsFromSnapshot(s: WorkSurfaceSnapshot, now: number): Map<string, string> {
  const by = new Map(s.issues.map(i => [i.id, i]));
  const waits = new Map(boardCards(s, now).map(c => [c.id, c.blockedBy]));
  const rules = new Map<string, string[]>();
  for (const r of s.tree) for (const nd of r.nodes) for (const a of nd.anomalies) { const list = rules.get(nd.id) ?? []; if (!list.includes(a)) list.push(a); rules.set(nd.id, list); }
  const out = new Map<string, string>();
  for (const i of s.issues) {
    const w = waits.get(i.id) ?? [];
    out.set(i.id, [`${i.id} · ${i.title}`, ...(w.length ? [`Waits on: ${w.map(b => `${b.id} · ${by.get(b.id)?.title ?? b.title}`).join("; ")}`] : []), ...(rules.get(i.id) ?? []).map(anomalyText)].join("\n"));
  }
  return out;
}

/** The whole tree from a snapshot, through the real sidebarRows(). */
export function treeFromSnapshot(s: WorkSurfaceSnapshot, now: number, opts: LayoutOpts = {}): TreeLayout {
  const rows = sidebarRows(s, now);
  const agents = new Map<string, AgentRef>();
  for (const r of s.tree) for (const nd of r.nodes as TreeNode[]) if (nd.agent && !agents.has(nd.id)) agents.set(nd.id, { paneId: nd.agent.paneId, label: nd.agent.title ? shortTitle(nd.agent.title) : nd.agent.paneId, state: nd.agent.state });
  const total = s.tree.reduce((a, r) => a + r.total, 0), finished = s.tree.reduce((a, r) => a + r.finished, 0);
  const header: TreeHeader = {
    tracker: s.repo.split("/").filter(Boolean).pop() ?? s.repo,
    age: shortAge(now - s.generatedAt),
    frac: s.tree.length ? `${finished}/${total}` : null,
    agents: s.tree.reduce((a, r) => a + r.liveAgents, 0),
    warnings: s.tree.reduce((a, r) => a + r.anomalyCount, 0),
  };
  return treeLayout(rows, header, agents, s.unattributed, { hints: hintsFromSnapshot(s, now), ...opts });
}

/** Compact age for the root line ("4s", "4m", "3h", "2d"), as beady-eye prints it. */
export function shortAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 48 * 3600 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}
const shortTitle = (t: string) => (t.length > 18 ? `${t.slice(0, 17)}…` : t);

/** The root line, as arkham lays it out: left "✓ <age> ago"; right, flush, "n/m  k agents  ⚠ x". */
export function headerSegs(h: TreeHeader): { left: Seg[]; right: Seg[] } {
  const right: Seg[] = [];
  if (h.frac) right.push({ text: h.frac, tone: "muted" });
  right.push({ text: `${h.agents} agent${h.agents === 1 ? "" : "s"}`, short: `◍ ${h.agents}`, tiny: `◍${h.agents}`, tone: h.agents ? "success" : "muted" });
  if (h.warnings) right.push({ text: `drift ${h.warnings}`, tiny: `⚠${h.warnings}`, tone: "drift" });
  return { left: [{ text: `✓ ${h.age} ago`, tone: "muted" }], right };
}

/** The key row, in beady-eye's order ("a all   ? keys   / find   q quit"). In a GUI there is nothing to quit: q hides the strip. */
export const TREE_KEYS: readonly { key: string; label: string }[] = [{ key: "a", label: "all" }, { key: "?", label: "keys" }, { key: "/", label: "find" }, { key: "q", label: "hide" }];
