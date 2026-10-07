// The Factory as TEXT, laid out exactly like the design's state 9 "Terminal Factory" (docs/design/2026-10-07-osiris-dashboard-harmony.html,
// tuiCanvas). Nothing semantic is derived here: stations, counts, workers, locks and the log come from factory-scene's `sceneOf`;
// the fleet rows from fleet-view-model's `listRows`; the colour per workstream from workstream-hue; needs-you decisions from
// surface-model. This file only lays those values out. PURE: no clocks, no I/O (the caller passes `now`).
import { allBlockEdges, chainBeads } from "../work/block-chain.ts";
import { STATIONS, STATION_TEXT, type FloorToken } from "../work/factory-floor-model.ts";
import { EMPTY_JOURNAL } from "../work/factory-journal.ts";
import { sceneOf, type FactoryScene } from "../work/factory-scene.ts";
import { buildGraphModel } from "../work/graph/graph.ts";
import { toBeadIssues } from "../work/graph/adapter.ts";
import { listRows } from "../work/fleet-view-model.ts";
import type { FleetLane, FleetSnapshot } from "../work/fleet-types.ts";
import { PROVIDERS, providerById, type ProviderMeta } from "../work/providers/registry.ts";
import { priorityTone } from "../work/priority-tone.ts";
import { decisionsWaiting, historyFromTimestamps } from "../work/surface-model.ts";
import type { WorkSurfaceSnapshot } from "../work/surface-types.ts";
import type { TelemetryMaps } from "../work/telemetry-model.ts";
import { initialWtUi, layoutWorktrees, worktreesKey, worktreesMouse, NO_ENV, type WtEnv, type WtUi, type WtView } from "./worktrees-model.ts";
import { C, SEL_BG, headerLine, keyRows, mu, selectRow, statusLine, type KeyItem } from "./chrome.ts";
import { barText, ageText, clockText, cat, clipLine, isCh, isDown, isUp, padLine, S, segHit, shiftHits, trimEnd, withStyle, type Frame, type Hit, type Size, type Key, type Line, type MouseAct, type Reduced, type Style } from "./term.ts";
import { workstreamTone } from "../work/workstream-hue.ts";
import { tabCreateArgv, cleanTitle } from "../work/herdr-dispatch/plan.ts";

/** The scene the Floor would draw for `snap` at `now` (live, no selection, no journal: the TUI keeps no history between runs). */
export function sceneForSnapshot(snap: WorkSurfaceSnapshot, now: number, maps: TelemetryMaps | null = null): FactoryScene {
  const events = historyFromTimestamps(snap), graph = buildGraphModel(toBeadIssues(snap));
  const closed = new Set(graph.nodes.filter(n => n.status === "closed").map(n => n.id));
  const chainIds = chainBeads(allBlockEdges(graph, id => closed.has(id)).filter(e => !closed.has(e.to)));
  return sceneOf({ snap, events, graph, t: now, now, opts: { chainIds, costs: maps?.costs ?? null, critical: maps?.critical ?? null, transcriptLive: maps?.transcriptLive ?? null }, journal: EMPTY_JOURNAL, ui: { selectedId: null, followId: null, spot: null, chainsOn: false } });
}

const LANE_ANSI = [75, 48, 177, 215, 51, 212, 155, 147] as const; // the cyberpunk --oi-lane-0..7 hexes
export const laneAnsi = (tone: number): number => LANE_ANSI[((tone % LANE_ANSI.length) + LANE_ANSI.length) % LANE_ANSI.length];
/** A workstream's colour for a parent id, from the shared hash (same epic = same colour in every view). */
export const workstreamAnsi = (parentId: string): number => laneAnsi(workstreamTone(parentId));

export type PanelId = "stations" | "fleet" | "needs" | "log";
export const PANELS: readonly PanelId[] = ["stations", "fleet", "needs", "log"];
export type Filter = "all" | "active" | "attention";
const FILTERS: readonly Filter[] = ["all", "active", "attention"];
export type FactoryUi = { focus: PanelId; sel: Record<PanelId, number>; filter: Filter; zoom: boolean; help: boolean; note: string[]; /** the "+N idle" fleet row is expanded */ idleOpen: boolean; tab: LowerTab; /** the embedded worktrees view's own state */ wt: WtUi };
export const initialUi = (): FactoryUi => ({ focus: "fleet", sel: { stations: 0, fleet: 0, needs: 0, log: 0 }, filter: "all", zoom: false, help: false, note: [], idleOpen: false, tab: "fleet", wt: initialWtUi() });

/** `maps` = telemetryMaps(WorkTelemetry): the same costs / critical path / live transcripts the web Floor is given (null = not connected). */
export type FactoryData = { snap: WorkSurfaceSnapshot; fleet: FleetSnapshot | null; now: number; maps?: TelemetryMaps | null; error?: string; /** the worktrees view for the Worktrees tab (the app loads it only while that tab is open) */ wt?: WtView | null };
type Cell = { tok: FloorToken; chip: { text: string; c: number } | null; barF: number | null; ageMs: number | null };
type FleetV = { key: string; state: FleetLane["state"]; label: string; chip: { text: string; c: number }; role: string; bead: string; activity: string; cost: string; beadId: string | null;
  /** nesting under a spawning lane that is itself in the list (0 = top level) */ depth: number; /** the "+N idle" summary row, not an agent */ summary?: number; parentKey: string | null };
type NeedV = { glyph: string; gc: number; who: string; text: string; agent: boolean; id: string | null };
type LogV = { at: number; text: string; c: number | null };
export type FactoryModel = {
  repo: string; now: number; live: number; idle: number; needsYou: number; burn: number | null; error?: string;
  stations: { id: (typeof STATIONS)[number]; count: number; cells: Cell[]; more: number; /** every cell, untrimmed: fitFactory re-cuts from this to the terminal's height */ all: Cell[] }[];
  flat: Cell[]; fleet: FleetV[]; needs: NeedV[]; log: LogV[];
  /** Body rows each section may draw (rules excluded); set by fitFactory, absent on a raw model. */
  budget?: Budget;
  /** the Worktrees tab's data and the size it is drawn at (columns, and rows INCLUDING its dropped header and key rows), set by fitFactory */
  wt?: WtView | null; lower?: { cols: number; rows: number };
};
export type Budget = { stations: number; fleet: number; needs: number; log: number };

/** Model-tier provider group -> registry entry (gemini is "everything else", as in home-model.ts), so the chip code always comes from the registry. */
const metaOfGroup = (g: string | null): ProviderMeta | null => (g === "anthropic" ? providerById("claude") : g === "openai" ? providerById("codex") : g ? PROVIDERS.find(p => p.id !== "claude" && p.id !== "codex") ?? null : null);
const chipColor = (p: ProviderMeta | null) => (p?.id === "claude" ? C.ye : p?.id === "codex" ? C.gr : C.bl); // the mockup's chips: CL yellow, CX green, GM blue
/** THE model chip `CL·S` (provider code from the registry + the model's letter from model-tiers). Used by the stations AND the FLEET table. */
const chipFrom = (m: ProviderMeta | null, glyph: string) => ({ text: m ? `${m.chip}·${glyph}` : "??", c: chipColor(m) });
const chipOf = (group: string | null, glyph: string) => chipFrom(metaOfGroup(group), glyph);
/** A FLEET lane whose transcript names no model borrows the model badge of the station worker on its bead; with neither, its own provider and letter. */
function fleetChip(r: { runtime: string; modelKey: string; modelLetter: string; beadId: string | null }, workers: readonly { beadId: string | null; presence: string; badge: { provider: string | null; glyph: string } }[]) {
  const w = r.modelKey === "unknown" && r.beadId ? workers.find(x => x.beadId === r.beadId && x.badge.provider) : undefined;
  return w ? chipOf(w.badge.provider, w.badge.glyph) : chipFrom(providerById(r.runtime), r.modelLetter);
}
const BUILD_BAR_MS = 3600_000; // the bar is AGE against 1h (no bead carries a completion fraction)
const STATION_ROWS = 6;

/** The lower region is a tab: the fleet, or the SAME worktrees view the standalone app draws. */
export type LowerTab = "fleet" | "worktrees";
/** ONE render function for the worktrees view: the standalone app and the Factory's Worktrees tab both call exactly this (pinned by identity). */
export const WORKTREES_RENDER = layoutWorktrees;
/** Rows the Worktrees tab asks for (its own header and key rows are not drawn here, so a 12-row view shows in 10), and the least it will be given. */
const WT_ROWS = 40, WT_MIN = 10;
/** A lane quiet this long (and not waiting on a person) folds into the "+N idle" row. */
export const IDLE_FOLD_MS = 10 * 60_000;
/** The most FLEET rows the layout reserves when nothing is zoomed: the stations are the screen's point and a long fleet is a "+N more" row. */
export const FLEET_MAX_ROWS = 8;
/** PURE: hide quiet idle rows behind one summary row. A quiet row stays when something kept nests under it (the tree keeps its parent). */
export function foldIdle(rows: readonly FleetV[], quiet: ReadonlySet<string>, open: boolean): FleetV[] {
  const keep = new Set(rows.filter(r => !quiet.has(r.key)).map(r => r.key)), parent = new Map(rows.map(r => [r.key, r.parentKey]));
  for (const k of [...keep]) for (let p = parent.get(k) ?? null; p && !keep.has(p); p = parent.get(p) ?? null) keep.add(p);
  const hidden = rows.filter(r => !keep.has(r.key)).length;
  if (!hidden) return [...rows];
  const sum: FleetV = { key: "idle-summary", state: "idle", label: open ? `−${hidden} idle shown` : `+${hidden} idle`, chip: { text: "", c: C.mu }, role: "", bead: "", activity: open ? "i folds" : "i expands", cost: "", beadId: null, depth: 0, summary: hidden, parentKey: null };
  return [...(open ? rows : rows.filter(r => keep.has(r.key))), sum];
}
export function factoryModel(d: FactoryData, filter: Filter = "all", idleOpen = false): FactoryModel {
  const scene = sceneForSnapshot(d.snap, d.now, d.maps ?? null), landedAt = new Map(d.snap.issues.map(i => [i.id, Date.parse(i.updatedAt)])), workers = [...scene.workerOf.values()];
  const keep = (t: FloorToken) => filter === "all" || (filter === "active" ? t.station === "claim" || t.station === "build" || t.station === "gate" : t.blocked || t.critical || t.station === "gate");
  const stations = STATIONS.map(id => {
    const st = scene.stations.find(s => s.id === id)!;
    const all = st.queue.map(q => scene.tokenAt.get(q)).filter((t): t is FloorToken => !!t && keep(t));
    const toks = [...all.filter(t => !t.blocked), ...all.filter(t => t.blocked)]; // blocked beads sit under the others, like the mockup's ⊘ row
    const mk = (tok: FloorToken): Cell => {
      const w = workers.find(x => x.beadId === tok.id && x.presence === "live") ?? workers.find(x => x.beadId === tok.id);
      const chip = w && (id === "claim" || id === "build") ? chipOf(w.badge.provider, w.badge.glyph) : null;
      const age = id === "land" ? d.now - (landedAt.get(tok.id) ?? d.now) : (w?.elapsedMs ?? tok.sinceMs);
      return { tok, chip, barF: id === "build" && w ? (w.elapsedMs ?? 0) / BUILD_BAR_MS : null, ageMs: age };
    };
    const allCells = toks.map(mk), cells = allCells.slice(0, STATION_ROWS);
    return { id, count: st.count, cells, all: allCells, more: filter === "all" ? st.count - cells.length : toks.length - cells.length };
  });
  const fl = d.fleet;
  const rows = fl ? listRows(fl, filter === "active" ? { state: "live" } : filter === "attention" ? { needs: true } : {}, "state", d.now, "tree").filter(r => !r.group && r.role !== "main") : []; // main sessions are the owner's own: they show under NEEDS YOU, not as workers
  const laneBy = new Map((fl?.lanes ?? []).map(l => [l.key, l])), shown = new Map<string, number>();
  const all: FleetV[] = rows.map(r => {
    const ln = laneBy.get(r.key), parentKey = ln?.parentKey && shown.has(ln.parentKey) ? ln.parentKey : null, depth = parentKey ? (shown.get(parentKey) ?? 0) + 1 : 0;
    shown.set(r.key, depth);
    // The ONE identity (work/agent-identity.ts, already applied by buildFleet): the fleet label is used as is, no second label logic here.
    const label = r.label;
    return {
      key: r.key, state: r.state, label, chip: fleetChip(r, workers), role: r.role,
      bead: r.beadId ?? "", beadId: r.beadId, activity: r.activityRunning ? r.activity.replace(" · ", " ") : `idle ${ageText(d.now - (ln?.lastAt ?? d.now))}`,
      cost: r.costText === "—" || r.costText === "unpriced" ? "n/a" : r.costText, depth, parentKey,
    };
  });
  const quiet = new Set(rows.filter(r => r.state !== "live" && !r.needsYou && d.now - (laneBy.get(r.key)?.lastAt ?? d.now) > IDLE_FOLD_MS).map(r => r.key));
  const fleet = foldIdle(all, quiet, idleOpen);
  const needs: NeedV[] = [];
  for (const l of fl?.lanes ?? []) {
    if (!l.waiting || l.waiting === "message") continue;
    const since = l.waitingSince ? ` · ${ageText(d.now - l.waitingSince)}` : "";
    needs.push(l.waiting === "your-turn" ? { glyph: "⏎", gc: C.ye, who: l.label, text: `your turn${since}`, agent: true, id: l.beadId } : { glyph: "?", gc: C.ye, who: l.label, text: `${l.waiting}${since}`, agent: true, id: l.beadId });
  }
  for (const x of decisionsWaiting(d.snap, d.now)) needs.push({ glyph: "!", gc: C.rd, who: x.id, text: `${x.kind === "crit" ? "crit" : "owner gate"} · ${ageText(x.waitingMs)}`, agent: false, id: x.id });
  const log: LogV[] = [
    ...scene.timeline.map(e => ({ at: e.at, text: e.text.replace(/\p{Extended_Pictographic}\uFE0F?\s*/gu, "").trim(), c: e.tone === "failure" ? C.rd : null })),
    ...(fl?.messages ?? []).filter(m => m.kind === "spawn" || m.kind === "handback-lost").map(m => (m.kind === "spawn" ? { at: m.at, text: `${m.from} spawned ${m.to}`, c: null } : { at: m.at, text: `lost hand-back ${m.from} → ${m.to}`, c: C.rd })),
  ].sort((a, b) => b.at - a.at).slice(0, 12);
  return {
    repo: d.snap.repo.split("/").pop() ?? d.snap.repo, now: d.now, live: fl?.summary.live ?? [...scene.liveAt.values()].reduce((a, b) => a + b, 0), idle: fl?.summary.idle ?? 0,
    needsYou: (fl?.summary.needsYou ?? 0) + decisionsWaiting(d.snap, d.now).length, burn: fl?.summary.burnUsdPerHour ?? null, error: d.error,
    stations, flat: stations.flatMap(s => s.cells), fleet, needs, log, wt: d.wt ?? null,
  };
}

// ---- layout (the mockup's own columns, scaled to the terminal) ----------------------------------------------------------------
/** The mockup's text columns at its 104-column body. Everything wide is these numbers scaled by cols/104 (see `geom`), so the structure never changes. */
const L = { rule: 104, lab: [2, 18, 37, 65, 86], item: [2, 21, 39, 66, 87], needsX: 60, fleet: { glyph: 2, label: 4, chip: 18, role: 23, bead: 33, act: 43, cost: 56 } } as const;
const WIDE = 100;
/** The rounded box costs 4 columns (border + 1 padding each side) and 3 rows (the info line above, the top and bottom border). */
const BOX_W = 4, BOX_H = 3;
const lineLen2 = (l: Line) => l.reduce((n, g) => n + g.t.length, 0);
type Geom = { lab: number[]; item: number[]; needsX: number; needsItem: number; fleet: { glyph: number; label: number; chip: number; role: number; bead: number; act: number; cost: number } };
/** Wide column positions for `cols`: stations scale linearly; the FLEET|NEEDS split moves with the width and the extra FLEET columns go to label, bead and activity. */
export function geom(cols: number): Geom {
  const f = Math.max(1, cols / L.rule), sc = (n: number) => Math.round(n * f);
  const needsX = Math.max(L.needsX, Math.round(cols * (L.needsX / L.rule))), extra = needsX - L.needsX, bx = Math.floor(extra * 0.25), ax = Math.floor(extra * 0.4), lw = 14 + Math.floor(extra * 0.35);
  const chip = 4 + lw, role = chip + 5, bead = role + 10, act = bead + 10 + bx;
  return { lab: L.lab.map(sc), item: L.item.map(sc), needsX, needsItem: needsX + 4, fleet: { glyph: 2, label: 4, chip, role, bead, act, cost: act + 13 + ax } };
}

/** `─ A ──── B ───` with each label at its column, a space either side, the rest ─ (mockup rule lines). */
function ruleAt(w: number, labels: [string, number][], gaps: number[] = []): Line {
  const ch = Array<string>(w).fill("─");
  for (const [t, c] of labels) { if (c > 0) ch[c - 1] = " "; for (let i = 0; i < t.length && c + i < w; i++) ch[c + i] = t[i]; if (c + t.length < w) ch[c + t.length] = " "; }
  for (const g of gaps) if (g < w) ch[g] = " ";
  return [S(ch.join(""), mu)];
}
const selected = (l: Line): Line => withStyle(l, { bg: SEL_BG });

/** The header is the shared inverse bar (chrome.ts), the same one the worktrees app draws; the counts sit right-aligned, longest first that fits. */
function headerBar(m: FactoryModel, cols: number): Line {
  const burn = m.burn === null ? "$n/a" : `$${m.burn.toFixed(2)}/h`;
  return headerLine([S(`▾ OSIRIS FACTORY  ${m.repo}  ✓ ${clockText(m.now)}`, { inv: true })], [`● ${m.live} live +${m.idle} idle  NEEDS YOU ${m.needsYou}  ${burn} est.`, `● ${m.live} live +${m.idle} idle  NEEDS YOU ${m.needsYou}  ${burn}`, `● ${m.live} live  NEEDS YOU ${m.needsYou}`, `● ${m.live}  ! ${m.needsYou}`], cols);
}

const titleSeg = (t: string, room: number): Line => (room >= 16 ? [S(` ${t.length > room - 1 ? `${t.slice(0, room - 2)}…` : t}`, mu)] : []);
/** The bead id, coloured by the ONE priority rule (work/priority-tone.ts): P0/crit red, P1 amber, the rest the default ink. */
const idStyle = (t: FloorToken): Style => { const tone = priorityTone({ priority: t.priority }); return tone === "failure" ? { c: C.rd, b: true } : tone === "attention" ? { c: C.ye } : {}; };
const stationCell = (c: Cell, id: string): Line => {
  const t = c.tok, ageStr = ageText(c.ageMs), ids = (extra = "") => S(` ${t.id}${extra}`, idStyle(t));
  if (t.blocked) return [S("⊘", { c: C.rd }), ids(" "), S(`blocked ${ageStr}`, { c: C.rd })];
  if (id === "intake") return [S("○", mu), ids()];
  if (id === "claim") return [S("◐", { c: C.ye }), ids(), ...(c.chip ? [S(` ${c.chip.text}`, { c: c.chip.c })] : [])];
  if (id === "build") return [S("◐", { c: C.ye }), ids(), ...(c.chip ? [S(` ${c.chip.text}`, { c: c.chip.c })] : []), ...(c.barF !== null ? [S(` ${barText(c.barF)}`, { c: C.cy }), S(` ${ageStr.padStart(3)}`)] : [])];
  if (id === "gate") return [S("◇", { c: C.bl }), ids(` ${t.gateRole === "held" ? "held" : "review"}`)];
  return [S("✓", { c: C.gr }), ids(` ${ageStr}`)];
};

/** Water-filling: every section gets min(natural, min) first, then each spare row goes to the section with the largest unmet share. */
export function allocate(nat: readonly number[], total: number, min: readonly number[]): number[] {
  const a = nat.map((n, i) => Math.min(n, min[i]));
  for (let left = total - a.reduce((x, y) => x + y, 0); left > 0; left--) {
    let bi = -1, bf = 0;
    nat.forEach((n, i) => { const f = (n - a[i]) / Math.max(1, n); if (n > a[i] && f > bf) { bf = f; bi = i; } });
    if (bi < 0) break;
    a[bi]++;
  }
  return a;
}

const keyItems = (ui: FactoryUi): KeyItem[] => [
  { k: "tab", label: "panels", key: "tab" }, { k: "j/k", label: "move", key: null }, { k: "enter", label: "open in Osiris", key: "enter" }, { k: "d", label: "dispatch…", key: { ch: "d" } },
  { k: "f", label: `filter${ui.filter === "all" ? "" : `:${ui.filter}`}`, key: { ch: "f" } }, { k: "z", label: `zoom panel${ui.zoom ? ":on" : ""}`, key: { ch: "z" } }, { k: "r", label: "refresh 5s", key: { ch: "r" } },
  { k: "i", label: ui.idleOpen ? "hide idle" : "show idle", key: { ch: "i" } }, { k: "w", label: ui.tab === "worktrees" ? "fleet" : "worktrees", key: { ch: "w" } }, { k: "?", label: "help", key: { ch: "?" } }, { k: "q", label: "quit", key: "quit" },
];
/** The key legend wrapped to `cols` by the shared key row (chrome.ts): the hit map and the drawing come from the same call. */
const legend = (ui: FactoryUi, cols: number) => keyRows(keyItems(ui), cols, true);

const flowRows = (log: LogV[], w: number, sel: number | null, max: number): { rows: Line[]; hits: Hit[] } => {
  const rows: Line[] = [], hits: Hit[] = []; let cur: Line = []; let used = 0;
  log.forEach((e, i) => {
    const item: Line = [S(clockText(e.at).slice(0, 5), mu), S(` ${e.text}`, e.c !== null ? { c: e.c } : undefined)];
    const it = sel === i ? withStyle(item, { bg: SEL_BG }) : item, len = lineLen2(item) + 3;
    if (used && used + len > w - 2) { rows.push(cur); cur = []; used = 0; }
    const x0 = lineLen2(cur) + (used ? 3 : 2);
    cur = cat(cur, used ? [S("   ")] : [S("  ")], it); used += used ? len : len - 1;
    hits.push({ y: rows.length, x0, x1: x0 + lineLen2(item), act: { k: "row", panel: "log", i } });
  });
  if (cur.length) rows.push(cur);
  return { rows: rows.slice(0, max), hits: hits.filter(h => h.y < max) };
};

/** Cut `m` to the terminal: how many body rows each section may draw, and the stations re-cut to their share. Idempotent (re-cuts from `all`). */
export function fitFactory(m: FactoryModel, o: { cols: number; rows: number; zoom?: PanelId | null; extra?: number; help?: boolean; tab?: LowerTab }): FactoryModel {
  const outer = Math.max(40, o.cols), cols = outer - BOX_W, wide = outer >= WIDE, ui = { filter: "all", zoom: !!o.zoom } as FactoryUi, zoom = o.zoom ?? null;
  const fixed = 1 + (m.error ? 1 : 0) + (o.extra ?? 0) + (o.help ? 1 : legend(ui, cols).rows.length), avail = Math.max(0, o.rows - BOX_H - fixed);
  const norm = m.stations.map(s => s.all.filter(c => !c.tok.blocked).length), blk = m.stations.map(s => s.all.filter(c => c.tok.blocked).length);
  const natS = wide ? Math.max(0, ...norm) + Math.max(0, ...blk) : m.stations.reduce((n, s) => n + s.all.length, 0);
  const wtTab = o.tab === "worktrees", natF = wtTab ? (zoom === "fleet" ? 99 : WT_ROWS) : zoom === "fleet" ? m.fleet.length : Math.min(m.fleet.length, FLEET_MAX_ROWS), natN = Math.max(1, m.needs.length), natL = wide ? flowRows(m.log, cols, null, 999).rows.length : m.log.length;
  const stR = wide ? 1 : 5; // rules the stations section pays for
  let b: Budget;
  if (zoom) {
    const body = Math.max(0, avail - 1 - (zoom === "stations" ? stR - 1 : 0));
    b = { stations: zoom === "stations" ? body : 0, fleet: zoom === "fleet" ? body : 0, needs: zoom === "needs" ? body : 0, log: zoom === "log" ? body : 0 };
  } else if (wide) {
    const [s, fn, l] = allocate([stR + natS, 1 + Math.max(natF, natN), 1 + natL], avail, [stR + 2, 1 + (wtTab ? WT_MIN : 3), 1 + 1]);
    b = { stations: Math.max(0, s - stR), fleet: Math.max(0, fn - 1), needs: Math.max(0, fn - 1), log: Math.max(0, l - 1) };
  } else {
    const [s, f, n, l] = allocate([stR + natS, 1 + natF, 1 + natN, 1 + natL], avail, [stR + 5, 1 + (wtTab ? WT_MIN : 2), 1 + 1, 1 + 1]);
    b = { stations: Math.max(0, s - stR), fleet: Math.max(0, f - 1), needs: Math.max(0, n - 1), log: Math.max(0, l - 1) };
  }
  const stations = m.stations.map((s, i) => {
    const total = s.cells.length + s.more, take = (cap: number) => (s.all.length > cap ? Math.max(0, cap - 1) : s.all.length);
    const cap = wide ? b.stations : allocate(m.stations.map(x => x.all.length), b.stations, m.stations.map(() => 1))[i];
    const cells = s.all.slice(0, take(cap));
    return { ...s, cells, more: Math.max(0, total - cells.length) };
  });
  const lowerW = wide && !zoom ? geom(cols).needsX - 1 : cols;
  return { ...m, stations, flat: stations.flatMap(s => s.cells), budget: b, lower: { cols: lowerW, rows: Math.max(WT_MIN, b.fleet) + 2 } };
}

export type RenderOpts = { cols: number; rows?: number; color: boolean; /** Shrink the box to its content (no empty rows under the key line): for static renders such as the README art. A live pane always fills its rows. */ fit?: boolean };
/** The frame AND its hit map, from one layout pass: renderFactory is `.lines`; the mouse reducer hit-tests `.hits`. */
export const infoText = (o: { pane?: string | null; cols: number; rows: number; intervalS: number; hint?: string | null }): string => `pane ${o.pane ?? "-"} · bff osiris factory · ${o.cols}×${o.rows} · refreshes every ${o.intervalS}s, changed lines only${o.hint ? ` · ${o.hint}` : ""}`;
export function layoutFactory(m0: FactoryModel, ui: FactoryUi, o: RenderOpts & { info?: string }): Frame {
  const outer = Math.max(40, o.cols), rows = o.rows ?? 24, iw = outer - BOX_W, bm: Style = { c: C.mu };
  let ir = Math.max(1, rows - BOX_H);
  const m = m0.budget ? m0 : fitFactory(m0, { cols: outer, rows, zoom: ui.zoom ? ui.focus : null, extra: ui.note.length, help: ui.help, tab: ui.tab });
  const f = layoutInner(m, ui, { cols: iw, color: o.color }, outer >= WIDE);
  if (o.fit) ir = Math.max(1, Math.min(ir, f.lines.length));
  const body = Array.from({ length: ir }, (_, i) => cat([S("│ ", bm)], padLine(f.lines[i] ?? [], iw), [S(" │", bm)]));
  const info: Line = [S("●", { c: C.cy }), S(` ${o.info ?? infoText({ cols: outer, rows: ir + BOX_H, intervalS: 5 })}`, mu)];
  return { lines: [clipLine(info, outer), [S(`╭${"─".repeat(outer - 2)}╮`, bm)], ...body, [S(`╰${"─".repeat(outer - 2)}╯`, bm)]], hits: shiftHits(f.hits.filter(h => h.y < ir), 2).map(h => ({ ...h, x0: h.x0 + 2, x1: h.x1 + 2 })) };
}
/** The Worktrees tab: the standalone app's own frame (WORKTREES_RENDER), minus its header and key rows (the Factory has its own, from the same chrome),
 * with every panel it names prefixed `wt:` so the Factory's mouse reducer can route the click back to it. */
function lowerFrame(m: FactoryModel, ui: FactoryUi, w: number, h: number): Frame {
  if (!m.wt) return { lines: [[S("  reading worktrees…", mu)]], hits: [] };
  const rows = Math.max(WT_MIN, h) + 2, f = WORKTREES_RENDER(m.wt, ui.wt, { cols: w, rows, color: true });
  const lines = f.lines.slice(1, rows - 1).slice(0, h), hits: Hit[] = f.hits.filter(x => x.y >= 1 && x.y <= rows - 2 && x.y - 1 < h && x.act.k !== "key").map(x => ({ ...x, y: x.y - 1, act: x.act.k === "row" ? { k: "row", panel: `wt:${x.act.panel}`, i: x.act.i } : x.act.k === "panel" ? { k: "panel", panel: `wt:${x.act.panel}` } : x.act }));
  return { lines, hits };
}
/** The FLEET rule with its two tabs: the active one bright, both clickable (panel `tab:fleet` / `tab:worktrees`). */
function tabbed(base: Line, tab: LowerTab, y: number): { line: Line; hits: Hit[] } {
  const t = base[0].t, f = t.indexOf("FLEET"), w = t.indexOf("WORKTREES"), on: Style = { c: C.cy, b: true };
  const line: Line = [S(t.slice(0, f), mu), S("FLEET", tab === "fleet" ? on : mu), S(t.slice(f + 5, w), mu), S("WORKTREES", tab === "worktrees" ? on : mu), S(t.slice(w + 9), mu)];
  return { line, hits: [{ y, x0: f, x1: f + 5, act: { k: "panel", panel: "tab:fleet" } }, { y, x0: w, x1: w + 9, act: { k: "panel", panel: "tab:worktrees" } }] };
}
function layoutInner(m: FactoryModel, ui: FactoryUi, o: { cols: number; color: boolean }, wide: boolean): Frame {
  const cols = o.cols, out: Line[] = [], hits: Hit[] = [], foc = (p: PanelId) => ui.focus === p, bud = m.budget!;
  const z = (p: PanelId) => !ui.zoom || ui.focus === p, g = geom(cols);
  const sel = (p: PanelId, i: number) => foc(p) && ui.sel[p] === i;
  const rw = cols, row = (panel: string, i: number, x0: number, x1: number, y = out.length) => hits.push({ y, x0, x1, act: { k: "row", panel, i } });
  const title = (panel: PanelId, x0 = 0, x1 = cols) => hits.push({ y: out.length, x0, x1, act: { k: "panel", panel } });
  out.push(headerBar(m, cols));
  if (m.error) out.push(clipLine([S(`feed error: ${m.error}`, { c: C.rd })], cols));
  if (z("stations")) {
    const R = ui.zoom ? bud.stations : bud.stations, sIdx = foc("stations") ? ui.sel.stations : null, flatIdx = (c: Cell) => m.flat.indexOf(c);
    if (wide) {
      const norm = m.stations.map(s => s.cells.filter(c => !c.tok.blocked)), blk = m.stations.map(s => s.cells.filter(c => c.tok.blocked));
      const rows = Math.max(1, ...m.stations.map((s, i) => norm[i].length + (s.more > 0 ? 1 : 0))), brows = Math.max(0, ...blk.map(b => b.length));
      title("stations"); out.push(ruleAt(rw, STATIONS.map((id, i) => [STATION_TEXT[id].label.toUpperCase(), g.lab[i]] as [string, number])));
      const put = (cells: (Cell | "more" | undefined)[]): void => {
        let line: Line = [];
        cells.forEach((cell, i) => {
          const avail = (i + 1 < g.item.length ? g.item[i + 1] : cols) - g.item[i] - 2;
          let seg: Line = cell === "more" ? [S(`+${m.stations[i].more} more`, mu)] : cell ? stationCell(cell, m.stations[i].id) : [];
          if (cell && cell !== "more") { const ts = titleSeg(cell.tok.title, avail - lineLen2(seg)); if (ts.length) seg = cat(seg, ts); if (sIdx === flatIdx(cell)) seg = selected(seg); row("stations", flatIdx(cell), g.item[i], g.item[i] + lineLen2(seg)); }
          if (seg.length) line = cat(padLine(line, g.item[i]), seg);
        });
        out.push(line);
      };
      const start = out.length;
      for (let r = 0; r < rows; r++) put(m.stations.map((s, i) => norm[i][r] ?? (r === norm[i].length && s.more > 0 ? "more" : undefined)));
      for (let r = 0; r < brows; r++) put(m.stations.map((_, i) => blk[i][r]));
      const keep = Math.max(1, R), cut = out.length - start - keep;
      if (cut > 0) { out.length = start + keep; for (let i = hits.length - 1; i >= 0 && hits[i].y >= out.length; i--) if (hits[i].act.k === "row") hits.splice(i, 1); }
    } else {
      let n = 0;
      for (const s of m.stations) {
        title("stations"); out.push(ruleAt(cols, [[`${STATION_TEXT[s.id].label.toUpperCase()} ${s.count}`, 2]]));
        for (const c of s.cells) { let l = cat([S("  ")], stationCell(c, s.id)); l = cat(l, titleSeg(c.tok.title, cols - lineLen2(l) - 1)); l = clipLine(l, cols); row("stations", n, 0, cols); out.push(sIdx === n ? selected(l) : l); n++; }
        if (s.more > 0) out.push([S(`  +${s.more} more`, mu)]);
      }
    }
  }
  // A list longer than its budget ends in "+N more" (it takes the budget's last row); zoom gives the focused panel every spare row.
  const capped = <T,>(items: T[], cap: number, draw: (t: T, i: number) => Line, more: (n: number) => string): Line[] =>
    (items.length > cap ? [...items.slice(0, Math.max(0, cap - 1)).map(draw), [S(more(items.length - Math.max(0, cap - 1)), mu)]] : items.map(draw));
  let lowerAt = -1, lowerN = 0;
  const lower = ui.tab === "worktrees" && z("fleet") ? lowerFrame(m, ui, wide && !ui.zoom ? g.needsX - 1 : cols, Math.max(1, bud.fleet)) : null;
  const fleetRows = lower ? lower.lines : capped(m.fleet, bud.fleet, (f, i) => fleetLine(f, sel("fleet", i), g, wide ? g.needsItem - 1 : cols), n => `   +${n} more`);
  const first = m.needs.findIndex(x => x.agent);
  const needRows = capped(m.needs, bud.needs, (n, i) => needLine(n, i === first, sel("needs", i), wide && !ui.zoom ? cols - g.needsItem : cols - 2), n => `+${n} more`);
  const fleetShown = lower ? 0 : Math.min(m.fleet.length, bud.fleet > 0 && m.fleet.length > bud.fleet ? bud.fleet - 1 : m.fleet.length), needShown = Math.min(m.needs.length, bud.needs > 0 && m.needs.length > bud.needs ? bud.needs - 1 : m.needs.length);
  if (wide && !ui.zoom) {
    title("fleet", 0, g.needsX - 1); title("needs", g.needsX, cols);
    const tr = tabbed(ruleAt(rw, [["FLEET", 2], ["WORKTREES", 9], ["NEEDS YOU", g.needsX + 2]], [g.needsX - 1]), ui.tab, out.length); hits.push(...tr.hits); out.push(tr.line);
    if (lower) { hits.push(...shiftHits(lower.hits, out.length)); lowerAt = out.length; lowerN = lower.lines.length; }
    const n = Math.max(1, fleetRows.length, needRows.length);
    for (let i = 0; i < n; i++) {
      if (i < fleetShown) row("fleet", i, 0, g.needsX - 1);
      if (i < needShown) row("needs", i, g.needsX, cols);
      out.push(cat(padLine(fleetRows[i] ?? [], g.needsItem), needRows[i] ?? []));
    }
  } else {
    if (z("fleet")) {
      title("fleet"); const tr = tabbed(ruleAt(rw, [["FLEET", 2], ["WORKTREES", 9]]), ui.tab, out.length); hits.push(...tr.hits); out.push(tr.line);
      if (lower) { hits.push(...shiftHits(lower.hits, out.length)); lowerAt = out.length; lowerN = lower.lines.length; }
      fleetRows.forEach((r, i) => { if (i < fleetShown) row("fleet", i, 0, cols); out.push(clipLine(r, cols)); });
    }
    if (z("needs")) {
      title("needs"); out.push(ruleAt(rw, [[`NEEDS YOU ${m.needs.length}`, 2]]));
      if (needRows.length) needRows.forEach((r, i) => { if (i < needShown) row("needs", i, 0, cols); out.push(cat([S("  ")], r)); }); else out.push([S("  nothing needs you", mu)]);
    }
  }
  if (z("log")) {
    title("log"); out.push(ruleAt(rw, [["LOG", 2]]));
    const cap = Math.max(0, bud.log);
    if (wide) { const f = flowRows(m.log, cols, foc("log") ? ui.sel.log : null, cap); hits.push(...shiftHits(f.hits.map(h => ({ ...h, act: h.act })), out.length)); out.push(...f.rows); }
    else m.log.slice(0, cap).forEach((e, i) => { const l: Line = [S("  "), S(clockText(e.at).slice(0, 5), mu), S(` ${e.text}`, e.c !== null ? { c: e.c } : undefined)]; row("log", i, 0, cols); out.push(clipLine(sel("log", i) ? withStyle(l, { bg: SEL_BG }) : l, cols)); });
  }
  for (const n of ui.note) out.push(clipLine([S(` ${n}`, { c: C.ye })], cols));
  if (ui.help) out.push(statusLine(" tab/shift-tab panel · j/k or arrows move · enter prints the bead id · d prints a dispatch command (never runs it) · f cycles all/active/attention · z zoom · i shows idle agents · click selects, double-click = enter, wheel scrolls · q quit", cols));
  else { const kr = legend(ui, cols); for (const h of kr.hits) hits.push({ y: out.length + h.y, x0: h.x0, x1: h.x1, act: { k: "key", key: h.key } }); out.push(...kr.rows); }
  const done = out.map(trimEnd);
  return { lines: o.color ? done : done.map((l, y) => (l.some(g => g.s?.bg === SEL_BG) && !(y >= lowerAt && y < lowerAt + lowerN) ? markSelected(l) : l)), hits }; // the embedded worktrees view marks its own selection (─▸)
}
export const renderFactory = (m: FactoryModel, ui: FactoryUi, o: RenderOpts): Line[] => layoutFactory(m, ui, o).lines;

const fleetLine = (f: FleetV, sel: boolean, g: Geom, panelW: number): Line => {
  const c = g.fleet, gl = f.state === "live" ? S("●", { c: C.cy }) : f.state === "idle" ? S("◌", { c: C.ye }) : S("○", mu);
  let l: Line = [S(" ".repeat(c.glyph)), gl];
  l = cat(padLine(l, c.label), [S(`${f.depth > 0 ? `${"  ".repeat(f.depth - 1)}└ ` : ""}${f.label}`, f.summary ? mu : undefined)]); l = cat(padLine(l, c.chip), [S(f.chip.text, { c: f.chip.c })]); l = cat(padLine(l, c.role), [S(f.role)]);
  l = cat(padLine(l, c.bead), [S(f.bead)]); l = cat(padLine(l, c.act), [S(f.activity)]); l = cat(padLine(l, c.cost), [S(f.cost, f.cost === "n/a" ? mu : undefined)]);
  return sel ? withStyle(padLine(l, panelW), { bg: SEL_BG }) : l;
};
const needLine = (n: NeedV, first: boolean, sel: boolean, w: number): Line => {
  const l: Line = [S(n.glyph, { c: n.gc }), S(` ${n.who.padEnd(12)}${n.text}`), ...(n.agent && first ? [S("   "), S("[g] go", mu)] : [])];
  return sel ? withStyle(padLine(l, w), { bg: SEL_BG }) : l;
};
function markSelected(l: Line): Line {
  // Replace the first visible char of column 1 (always a pad space in the mockup layout) with ▸, keeping the width.
  const flat = l.map(g => g.t).join(""); const i = flat.search(/\S/);
  if (i < 1) return l;
  let pos = 0; return l.map(g => { const s = pos; pos += g.t.length; return i - 1 >= s && i - 1 < pos ? S(g.t.slice(0, i - 1 - s) + "▸" + g.t.slice(i - s), g.s) : g; });
}

// ---- keys ---------------------------------------------------------------------------------------------------------------------
const counts = (m: FactoryModel): Record<PanelId, number> => ({ stations: m.flat.length, fleet: m.fleet.length, needs: m.needs.length, log: m.log.length });
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** The dispatch command as TEXT: herdr's own tab-create argv from the dispatch planner, never run from here. */
export const dispatchText = (repo: string, id: string, title: string, herdr = "herdr"): string[] => [
  `dispatch ${id}: this app never spawns. In a shell, open the pane yourself:`,
  `  ${tabCreateArgv([herdr], repo, cleanTitle(`${id} ${title}`)).map(a => (/^[\w./:@=-]+$/.test(a) ? a : q(a))).join(" ")}`,
  "  or use Work > the bead > Dispatch to Herdr in Osiris (it claims the bead and asks you to confirm).",
];
export function selectedItem(m: FactoryModel, ui: FactoryUi): { id: string | null; title: string } | null {
  if (ui.focus === "stations") { const c = m.flat[ui.sel.stations]; return c ? { id: c.tok.id, title: c.tok.title } : null; }
  if (ui.focus === "fleet") { const f = m.fleet[ui.sel.fleet]; return f ? { id: f.beadId, title: f.label } : null; }
  if (ui.focus === "needs") { const n = m.needs[ui.sel.needs]; return n ? { id: n.id, title: n.who } : null; }
  return null;
}
/** The Worktrees tab owns these keys while it is the focused panel: moving, opening, esc, `o`, `d`, filtering. The Factory keeps tab/z/f/?/r/w/q. */
const wtOwns = (k: Key): boolean => k === "enter" || k === "esc" || isDown(k) || isUp(k) || isCh(k, "o", "d", "/", " ");
export function factoryKey(ui: FactoryUi, k: Key, m: FactoryModel | null, repo = "", env: WtEnv = NO_ENV): Reduced<FactoryUi> {
  if (ui.tab === "worktrees" && ui.focus === "fleet" && m?.lower) {
    const size = { cols: m.lower.cols, rows: m.lower.rows };
    if (ui.wt.typing || wtOwns(k)) { const r = worktreesKey(ui.wt, k, m.wt ?? null, size, env); return { ui: { ...ui, wt: r.ui }, quit: r.quit, refresh: r.refresh }; }
    if (k === "tab" && ui.wt.focus === "list") return { ui: { ...ui, wt: { ...ui.wt, focus: "detail", note: [] } } }; // tab walks list -> detail -> the next Factory panel
    if (k === "shift-tab" && ui.wt.focus === "detail") return { ui: { ...ui, wt: { ...ui.wt, focus: "list", note: [] } } };
  }
  if (k === "quit") return { ui, quit: true };
  if (isCh(k, "w")) { const tab: LowerTab = ui.tab === "fleet" ? "worktrees" : "fleet"; return { ui: { ...ui, tab, focus: "fleet", note: [] }, refresh: tab === "worktrees" }; }
  const n = m ? counts(m) : { stations: 0, fleet: 0, needs: 0, log: 0 };
  const idx = PANELS.indexOf(ui.focus);
  if (k === "tab" || k === "shift-tab") return { ui: { ...ui, focus: PANELS[(idx + (k === "tab" ? 1 : PANELS.length - 1)) % PANELS.length], wt: { ...ui.wt, focus: "list" }, note: [] } };
  if (isDown(k) || isUp(k)) { const max = Math.max(0, n[ui.focus] - 1), v = Math.min(max, Math.max(0, ui.sel[ui.focus] + (isDown(k) ? 1 : -1))); return { ui: { ...ui, sel: { ...ui.sel, [ui.focus]: v }, note: [] } }; }
  if (isCh(k, "z")) return { ui: { ...ui, zoom: !ui.zoom } };
  if (isCh(k, "f")) return { ui: { ...ui, filter: FILTERS[(FILTERS.indexOf(ui.filter) + 1) % FILTERS.length], sel: { stations: 0, fleet: 0, needs: 0, log: 0 } } };
  if (isCh(k, "?")) return { ui: { ...ui, help: !ui.help } };
  if (isCh(k, "r")) return { ui, refresh: true };
  if (isCh(k, "i")) return { ui: { ...ui, idleOpen: !ui.idleOpen } };
  if (k === "enter" && ui.focus === "fleet" && m?.fleet[ui.sel.fleet]?.summary) return { ui: { ...ui, idleOpen: !ui.idleOpen } };
  const it = m ? selectedItem(m, ui) : null;
  if (k === "enter") return { ui: { ...ui, note: it?.id ? [`open in Osiris: ${it.id}   (Osiris search box / Work, then paste the id)`] : ["nothing selected that maps to a bead"] } };
  if (isCh(k, "d")) return { ui: { ...ui, note: it?.id ? dispatchText(repo, it.id, it.title) : ["select a bead first (stations or fleet), then press d"] } };
  if (isCh(k, "g")) return { ui: { ...ui, note: it ? [`go to pane: open Osiris > Terminal and pick the pane of ${it.title}`] : [] } };
  return { ui };
}

/** PURE mouse reducer: a click selects the row / focuses the panel / presses the key it landed on; a double-click on a row is enter; the wheel moves the focused panel. */
export function factoryMouse(ui: FactoryUi, a: MouseAct, m: FactoryModel | null, repo = "", env: WtEnv = NO_ENV): Reduced<FactoryUi> {
  if (a.kind === "wheel") return factoryKey(ui, a.dir > 0 ? "down" : "up", m, repo, env);
  const h = a.hit;
  if (!h) return { ui };
  if (h.k === "key") return factoryKey(ui, h.key, m, repo, env);
  if (h.panel.startsWith("tab:")) { const tab = h.panel.slice(4) as LowerTab; return { ui: { ...ui, tab, focus: "fleet", note: [] }, refresh: tab === "worktrees" && ui.tab !== "worktrees" }; }
  if (h.panel.startsWith("wt:") && m?.lower) { // a click inside the embedded worktrees view: the standalone app's own reducer answers it
    const hit = { ...h, panel: h.panel.slice(3) }, r = worktreesMouse(ui.wt, { ...a, hit } as MouseAct, m.wt ?? null, { cols: m.lower.cols, rows: m.lower.rows }, env);
    return { ui: { ...ui, focus: "fleet", wt: r.ui }, refresh: r.refresh };
  }
  const panel = h.panel as PanelId;
  if (h.k === "panel") return { ui: { ...ui, focus: panel, note: [] } };
  const ui2: FactoryUi = { ...ui, focus: panel, sel: { ...ui.sel, [panel]: h.i }, note: [] };
  if (panel === "fleet" && m?.fleet[h.i]?.summary) return { ui: a.kind === "dblclick" ? ui2 : { ...ui2, idleOpen: !ui.idleOpen } }; // one click expands/folds the "+N idle" row
  return a.kind === "dblclick" ? factoryKey(ui2, "enter", m, repo) : { ui: ui2 };
}
