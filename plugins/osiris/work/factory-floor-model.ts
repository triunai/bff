// Factory floor v2 (pure, no React, no colours). "Overview tells you what to do; Factory tells you what the system is doing."
// The Factory derives NO work state of its own: stages come from factoryAt (the shared replay), moves from motionDelta,
// unmet blockers from factoryEdges, downstream impact from the work graph (buildGraphModel adjacency), a bead's trail
// from stagesAt sampled at its own events, scope waits from the lease queue (work/scope-lease.ts, optional input). This
// file only turns those outputs into a floor: five STATIONS on one conveyor, beads as crates stacked at their station,
// agents standing below the belt with model badges and cost, LOCKS (dependency, scope lease, gate hold) with lock/unlock
// moments, heat modes, a camera, and the motion between two frames. Geometry is a fixed virtual canvas (FLOOR.W x FLOOR.H)
// the view scales, so the layout is deterministic and testable.
// APPROXIMATIONS, stated:
//   - "Claim" is not a bead status. LIVE: a building bead with no pane attached yet stands at Claim, so stuck claims pile up
//     there. REPLAY (t < now; panes are unknown for the past): a building bead started less than CLAIM_MS ago.
//   - factoryAt shows at most MAX_ROWS work groups (the floor reads its hiddenCards too, so every eligible bead is drawn or listed in a +N). Beads in the hidden groups are still COUNTED (from its stage counts)
//     and land in the "+N" overflow; their building beads are counted at Build.
//   - Panes are only known for "now" (as in factoryAt): past frames show agents as "past", never live or ghost.
//   - Intake's queue for its threshold is its READY beads only: blocked beads are not waiting for a worker.
//   - Gate hold: review carries no "being reviewed" signal, so with R reviewers (the Gate threshold) the first R beads at the
//     Gate, front of queue first, count as in review and the rest as held.
//   - Review has no timestamp (replay.ts), so a trail only shows Gate for "now", and trails use the replay Claim rule.
import type { HistoryEvent, WorkSurfaceSnapshot } from "./surface-types.ts";
import { STAGES, stagesAt, type Stage } from "./replay.ts";
import { shortId } from "./surface-model.ts";
import { HOT_MS, allCardsOf, factoryAt, factoryEdges, motionDelta, type FactoryAt, type FactoryCard } from "./factory-model.ts";
import { buildGraphModel, type GraphModel } from "./graph/graph.ts";
import { directBlocks } from "./block-chain.ts";
import { toBeadIssues } from "./graph/adapter.ts";
import { stationByRules, type StationId } from "./station-rules.ts";
import { modelTier, tierTitle, type Provider, type Tier } from "./model-tiers.ts";
import { siloRects, siloWidths } from "./silo-layout.ts";
export type { StationId } from "./station-rules.ts";

export const STATIONS: readonly StationId[] = ["intake", "claim", "build", "gate", "land"];
export const STATION_TEXT: Record<StationId, { label: string; sub: string }> = {
  intake: { label: "Intake", sub: "waiting and ready" }, claim: { label: "Claim", sub: "assigned, not started" },
  build: { label: "Build", sub: "in a worktree" }, gate: { label: "Gate", sub: "review" }, land: { label: "Land", sub: "done" },
};
/** Virtual canvas. Crates (Intake, Land) stack upwards from the belt in COLS x ROWS; occupied cards (Claim, Build, Gate: the
 * agent sits in its bead's card with its elapsed time and cost) in CARD_COLS x CARD_ROWS. Front of the queue at the right. */
export const FLOOR = { W: 1200, H: 440, X0: 30, BAY_W: 228, BELT_Y: 300, BELT_H: 16, TOKEN: 26, GAP: 6, COLS: 6, ROWS: 4, PAD: 14, HEAD_CLEAR: 60, CARD_W: 100, CARD_H: 42, CARD_COLS: 2, CARD_ROWS: 5 } as const;
/** The return conveyor under the main belt (rework only, Gate → Build, right to left): a crate drops down the chute at Gate,
 * rides the lane shrunk to RET.SCALE with its top at RET.Y, and climbs the ramp into Build. LANE_Y/LANE_H is the belt itself. */
export const RET = { Y: 327, LANE_Y: 352, LANE_H: 6, SCALE: 0.6 } as const; // Y + CARD_H * SCALE sits on the lane
export const CLAIM_MS = 15 * 60_000, THROUGHPUT_MS = 24 * 3600_000, REWORK_ARC = 74, ENTER_DX = 46;
/** Queue size above which a station glows, per station (data, not code): Gate above the reviewer count, Build above the worker
 * cap, the rest above 6; Land never. Callers pass the real reviewer count and worker cap through FloorOpts.thresholds. */
export const DEFAULT_THRESHOLDS: Readonly<Record<StationId, number>> = { intake: 6, claim: 6, build: 6, gate: 2, land: Infinity };
export const SPEEDS = [1, 4, 16] as const;
export type Speed = (typeof SPEEDS)[number];
/** Wall time for one full replay of the scrubber's span at 1x. */
export const REPLAY_BASE_MS = 24_000;
/** Catch-up on open: replay the last CATCHUP_MS (stretched back to at least CATCHUP_MIN_EVENTS events, and to the latest lock
 * moment when the caller knows one, never past CATCHUP_MAX_MS) in CATCHUP_PLAY_MS. */
export const CATCHUP_MS = 45 * 60_000, CATCHUP_MAX_MS = 90 * 60_000, CATCHUP_MIN_EVENTS = 6, CATCHUP_PLAY_MS = 5_000;
export const HEAT_MODES = ["age", "rework", "impact", "cost"] as const;
export type HeatMode = (typeof HEAT_MODES)[number];
/** What each heat mode colours, as the mode button's tooltip (uh-factory-strings-9: the bare names did not say). */
export const HEAT_TEXT: Record<HeatMode, string> = { age: "Age: how long each work item has been at its station", rework: "Rework: how many times review sent it back", impact: "Blocking: how many work items wait on it", cost: "Cost: what its agent has cost so far" };
/** Value that saturates the heat ramp, per mode (age in ms, rework count, downstream beads, dollars). */
export const HEAT_FULL: Record<HeatMode, number> = { age: 2 * HOT_MS, rework: 2, impact: 5, cost: 5 };
/** absolute (default, lead: "truth beats prettiness"): HEAT_FULL is the brightest; relative: the hottest bead on the floor is. */
export type HeatScale = "absolute" | "relative";
/** The legend's "= max" text, GENERATED from HEAT_FULL (it once said "4 h" while the ramp saturated at 48 h: a 12x lie). */
export const heatFullText = (mode: HeatMode): string => mode === "age" ? `${Math.round(HEAT_FULL.age / 3_600_000)} h at a station` : mode === "rework" ? `sent back ${HEAT_FULL.rework}×` : mode === "impact" ? `${HEAT_FULL.impact} waiting on it` : `$${HEAT_FULL.cost}`;
/** Legend line for the heat key, e.g. "heat: age, absolute, 48 h at a station = max". */
export const heatLegend = (mode: HeatMode, scale: HeatScale) => `heat: ${mode === "impact" ? "blocking" : mode}, ${scale}, ${scale === "absolute" ? heatFullText(mode) : "hottest on the floor"} = max`;
/** Rework count that makes the return conveyor itself glow at full heat. */
export const LANE_FULL = 3;

/** rework = sent back from Gate to Claim/Build (rides the return conveyor); reopened = Land back to Intake (new work, not rework);
 * back = any other backward move in forward time (e.g. a claim losing its pane); rewind = time running backwards. */
export type Motion = "forward" | "rework" | "reopened" | "back" | "enter" | "shift" | "rewind";
export type Point = { x: number; y: number };
export type FloorStation = { id: StationId; label: string; sub: string; x: number; w: number; cx: number; count: number; queue: number; threshold: number; shown: number; overflow: number; overflowIds: string[]; overflowAt: Point; bottleneck: boolean; severity: number };
/** Three separate signals: shape = role (lead hexagon / worker circle), icon = provider, topper = tier (strong crown, king cape).
 * `model` is the MODEL_TIERS key (null when unknown: a neutral "?" badge, never guessed); `title` is the tooltip text. */
export type WorkerBadge = { model: string | null; provider: Provider | null; tier: Tier | null; label: string; title: string; role: "lead" | "worker" | null; shape: "hex" | "circle"; glyph: string };
export type FloorWorker = { key: string; beadId: string; station: StationId; x: number; y: number; presence: "live" | "ghost" | "past";
  /** Why it counts as working: a Herdr pane, or (no pane) its lane's transcript written within the window. */
  via: "pane" | "transcript" | null; transcriptAt: number | null; stale: boolean; pane: string | null; paneState: string | null; badge: WorkerBadge; elapsedMs: number | null; cost: number | null; critical: boolean };
export type FloorToken = {
  id: string; shortId: string; title: string; stage: Stage; station: StationId; shape: "crate" | "card"; density: Density; x: number; y: number; w: number; h: number; group: number;
  blocked: boolean; hot: boolean; critical: boolean; priority: number; sinceMs: number | null; pane: string | null; motion: Motion | null;
  /** Unmet blockers at t (factoryEdges) and how many not-done beads sit downstream of this one (work graph). */
  waitingOn: string[]; downstream: number; rework: number;
  /** Not-done beads this one holds up directly (its `blocks` dependents in the work graph). */
  blocks: string[];
  /** The one-line wait / block caption (card strip, tooltip, inspector), or null when nothing waits either way. */
  caption: WaitCaption | null;
  /** Heat for the chosen mode, 0..1, and its ramp step 0..4; null when the mode has no data (cost while not wired). */
  heat: number | null; heatStep: number | null;
  /** Set when a lock holds this bead (its key in frame.locks). */
  lock: string | null;
  /** At the Gate: "review" for the first R beads (ASSUMED under review: beads carry no review-start signal yet), "held" for the rest. */
  gateRole: "review" | "held" | null;
};
/** A lock: a bead that cannot move because of something else. blocked = an unmet `blocks` dependency; scope = a write-scope lease
 * another bead holds (Dispatch queued it); gate = waiting at the Gate while every reviewer is busy. */
export type LockKind = "blocked" | "scope" | "gate";
export type FloorLock = { key: string; kind: LockKind; beadId: string; holders: string[]; holderAgent: string | null; scope: string[] | null; sinceMs: number | null };
/** A queued Dispatch from the lease queue (scope-lease.ts QueueEntry, structurally): the waiting bead and what blocks it. */
export type ScopeWait = { beadId: string; blockers: readonly { beadId: string; holder: string; scope: readonly string[]; expiresIn: number }[] };
export type Tween = { id: string; kind: Motion | "exit"; from: Point; to: Point };
export type FloorFrame = {
  t: number; live: boolean; heatMode: HeatMode; heatScale: HeatScale;
  /** Beads at Claim/Build that came back from the Gate (the conveyor badge, "↩ 2 in rework"), and the conveyor's heat step. */
  inRework: number; laneHeat: number;
  /** Gate holds right now (aggregated in the log: "🔒 Gate holding 4"). */
  gateHolding: number;
  /** How far the floor stretches upward (floor units) so every live card is drawn; 0 when everything fits. */
  lift: number;
  /** Review is only known for "now" (replay.ts: labels carry no timestamp). false in the past: the Gate is drawn hatched with
   * "review history not recorded", and a bead that was in review shows at Build. */
  reviewKnown: boolean;
  /** The caller passed real glow thresholds; false = DEFAULT_THRESHOLDS, and the limit text says "default limit". */
  thresholdsWired: boolean;
  stations: FloorStation[]; tokens: FloorToken[]; workers: FloorWorker[]; workerOverflow: Record<StationId, number>;
  tweens: Tween[];
  locks: FloorLock[];
  /** Locks that closed or opened since opts.prev, in forward time only (a rewind shows no lock moments). */
  lockMoments: { locked: FloorLock[]; unlocked: FloorLock[] };
  counts: Record<Stage, number>;
  throughput: { lastDay: number; perHour: number };
  /** Optional inputs from sibling modules; false means the slot is drawn empty, not that nothing is critical / free / leased. */
  criticalWired: boolean; costWired: boolean; leasesWired: boolean;
  factory: FactoryAt;
};
export type FloorOpts = {
  prev?: FloorFrame | null;
  reducedMotion?: boolean;
  claimMs?: number; maxPerStation?: number;
  /** Landed beads the viewer pruned into the Archived vault (work/land-prune.ts): not drawn at Land and not counted there. */
  archivedIds?: ReadonlySet<string> | null;
  /** Ids no renderer may hide behind a "+N" (selected, followed, critical): when one sits past a capped station's cap it takes the place of the last unpinned bead that was drawn. */
  pinned?: ReadonlySet<string> | null;
  /** Beads on any `blocks` chain (work/block-chain.ts chainBeads). Those standing at Intake are drawn as cards, never folded. */
  chainIds?: ReadonlySet<string> | null;
  /** Size the bays by load (work/silo-layout.ts): an empty station is a sliver, a busy one widens. Off = the uniform bays. */
  silos?: boolean;
  /** FULL SCREEN true scale (floor view only): every bead is drawn as a wide "full" card (id, two title lines, age/cost, wait caption), nothing folds into "+N", and the floor stretches upward (frame.lift) as far as it needs. */
  full?: boolean;
  /** Per-station glow thresholds over DEFAULT_THRESHOLDS: gate = reviewer count, build = worker cap. */
  thresholds?: Partial<Record<StationId, number>> | null;
  heat?: HeatMode; heatScale?: HeatScale;
  /** The work graph for this snapshot (pass it memoised; built here when absent). */
  graph?: GraphModel | null;
  /** Backward moves the view saw happen live, by bead id (added to the trail's own count). */
  reworkSeen?: ReadonlyMap<string, number> | null;
  /** Bead ids on the critical path (work/critical-steps.ts), or null while not wired. */
  critical?: ReadonlySet<string> | null;
  /** Cost so far by pane id or bead id (cache telemetry, td-osi.21), or null while not wired. */
  costs?: ReadonlyMap<string, number> | null;
  /** Dispatch's queued scope waits (scope-lease.ts queueOrder entries in state "wait"), or null while not wired. Live only. */
  scopeWaits?: readonly ScopeWait[] | null;
  /** Live only: beads whose lane's transcript was written recently (transcript-liveness.ts over yb-cachetel's feed and
   * join). Such a bead counts as worked on even with no Herdr pane: it stands at Build and its agent counts as working. */
  transcriptLive?: ReadonlyMap<string, { lane: string; lastAt: number }> | null;
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const clamp01 = (n: number) => (n <= 0 ? 0 : n >= 1 ? 1 : n);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
export const stationIndex = (s: StationId) => STATIONS.indexOf(s);
export const bayX = (s: StationId) => FLOOR.X0 + stationIndex(s) * FLOOR.BAY_W;
/** One bay's left edge and width. The default is the uniform bay; `silos` layouts (work/silo-layout.ts) pass narrower and wider ones. */
export type Bay = { x: number; w: number };
export const uniformBay = (s: StationId): Bay => ({ x: bayX(s), w: FLOOR.BAY_W });
export const thresholdsOf = (o?: Partial<Record<StationId, number>> | null): Record<StationId, number> => ({ ...DEFAULT_THRESHOLDS, ...(o ?? {}) });

/** Which station a bead stands at. Stage is factoryAt's; only Claim vs Build is decided here: LIVE (pass `live`) by whether a
 * pane is attached, REPLAY by claim age. */
export function stationOf(c: Pick<FactoryCard, "stage" | "sinceMs">, claimMs = CLAIM_MS, live: { attached: boolean } | null = null): StationId {
  return stationByRules({ stage: c.stage, sinceMs: c.sinceMs, claimMs, live }); // the one table in station-rules.ts
}

/** A title on at most two lines of `n` characters, breaking at a space where it can; the second line ends in an ellipsis when the title does not fit. */
export const twoLines = (t: string, n: number): string[] => {
  const clean = t.replace(/\s+/g, " ").trim(); if (clean.length <= n) return [clean];
  const cut = (str: string) => { const i = str.lastIndexOf(" ", n); return i > n * 0.5 ? i : n; };
  const a = cut(clean), rest = clean.slice(a).trim();
  return [clean.slice(0, a).trim(), rest.length <= n ? rest : `${rest.slice(0, n - 1).trimEnd()}…`];
};
export const isCardStation = (s: StationId) => s === "claim" || s === "build" || s === "gate";
/** Live work is never hidden (owner, 22:53: "SEE all running lanes"). Claim, Build and Gate draw every card: past 10 they
 * go DENSE (3 a row, smaller), past 21 MICRO (4 a row), and past 44 the floor itself STRETCHES upward (frame.lift). Only
 * Intake (backlog) and Land (done) keep a cap with a "+N" chip. */
export type Density = "normal" | "dense" | "micro" | "full";
/** `foot` is the caption strip along a card's bottom ("waits on #h1w.17", "blocks 2"); micro cards have none (their wait shows
 * on hover and in the chain highlight). The agent badge is centred in the space above the strip. */
export const CARD_SIZES: Readonly<Record<Density, { w: number; h: number; cols: number; gap: number; badgeX: number; badgeR: number; foot: number }>> = {
  normal: { w: FLOOR.CARD_W, h: FLOOR.CARD_H, cols: FLOOR.CARD_COLS, gap: FLOOR.GAP, badgeX: 16, badgeR: 11, foot: 10 },
  dense: { w: 64, h: 30, cols: 3, gap: 4, badgeX: 11, badgeR: 8, foot: 8 },
  micro: { w: 47, h: 18, cols: 4, gap: 3, badgeX: 8, badgeR: 6, foot: 0 },
  /** Full screen only: room for "#id", two lines of title, "age · cost" and the wait caption. */
  full: { w: 170, h: 66, cols: 2, gap: 6, badgeX: 16, badgeR: 11, foot: 12 },
};
/** The agent badge's centre inside a card of this density. */
export const badgeY = (d: Density) => (CARD_SIZES[d].h - CARD_SIZES[d].foot) / 2;
/** Height a bay's stack may use above the belt before the floor has to stretch (below the bay header). */
export const STACK_ROOM = FLOOR.BELT_Y - 3 - 60;
/** The largest density whose stack fits under the bay header (normal up to 10 cards, dense up to 21, else micro, which holds
 * 44 before the floor stretches). Derived from the sizes, so a taller caption strip can never silently overflow a header. */
export const densityFor = (n: number, bayW: number = FLOOR.BAY_W): Density => (["normal", "dense"] as const).find(d => stackHeight(n, d, colsIn(d, bayW)) <= STACK_ROOM) ?? "micro";
/** Left inset a slot row keeps from its bay's edge (the pad rect starts 6 in), as the uniform bay already did. */
const EDGE = 6;
/** Columns of cards a bay of this width holds at a density (never more than the density's own, never fewer than one). */
export const colsIn = (d: Density, bayW: number) => { const c = CARD_SIZES[d]; return Math.max(1, Math.min(c.cols, Math.floor((bayW - FLOOR.PAD - EDGE + c.gap) / (c.w + c.gap)))); };
/** Columns of crates (Intake, Land) a bay of this width holds. */
export const crateColsIn = (bayW: number) => Math.max(1, Math.min(FLOOR.COLS, Math.floor((bayW - FLOOR.PAD - EDGE + FLOOR.GAP) / (FLOOR.TOKEN + FLOOR.GAP))));
const CRATE_ROWS_MAX = Math.floor((STACK_ROOM + FLOOR.GAP) / (FLOOR.TOKEN + FLOOR.GAP));
export const capOf = (s: StationId, bayW: number = FLOOR.BAY_W) => (isCardStation(s) ? Infinity : Math.min(FLOOR.COLS * FLOOR.ROWS, crateColsIn(bayW) * CRATE_ROWS_MAX));
export const sizeOf = (s: StationId, d: Density = "normal") => (isCardStation(s) || d === "full" ? { w: CARD_SIZES[d].w, h: CARD_SIZES[d].h } : { w: FLOOR.TOKEN, h: FLOOR.TOKEN });
/** Height of n cards stacked at a density. */
export const stackHeight = (n: number, d: Density, cols: number = CARD_SIZES[d].cols) => { const c = CARD_SIZES[d], rows = Math.ceil(n / cols); return rows ? rows * (c.h + c.gap) - c.gap : 0; };
/** Slot k of a bay: the front of the queue (k = 0) sits on the belt at the bay's right edge, nearest the next station. */
export function slotAt(s: StationId, k: number, d: Density = "normal", bay: Bay = uniformBay(s)): Point {
  const card = isCardStation(s) || d === "full", cols = card ? colsIn(d, bay.w) : crateColsIn(bay.w), gap = card ? CARD_SIZES[d].gap : FLOOR.GAP, { w, h } = sizeOf(s, d), col = k % cols, row = Math.floor(k / cols);
  return { x: bay.x + bay.w - FLOOR.PAD - w - col * (w + gap), y: FLOOR.BELT_Y - h - 3 - row * (h + gap) };
}

type Placed<C> = { c: C; k: number; p: Point; card: boolean; d: Density; size: { w: number; h: number } };
/** Intake with chain beads: every chain bead is a CARD (all drawn, never folded into "+N"); the other beads stay crates and stack
 * ABOVE the cards in the room that is left (fewer crates, or none, when the cards fill the bay: those fold into the chip). */
export function intakePlan(nCards: number, nCrates: number, _capShown: number, bayW: number) {
  const d = densityFor(nCards, bayW), cols = colsIn(d, bayW), cardsH = stackHeight(nCards, d, cols), lift = cardsH + FLOOR.GAP;
  const rows = Math.max(0, Math.floor((STACK_ROOM - lift + FLOOR.GAP) / (FLOOR.TOKEN + FLOOR.GAP)));
  const crateCap = Math.min(FLOOR.COLS * FLOOR.ROWS, crateColsIn(bayW) * rows), shownCrates = Math.min(crateCap, nCrates);
  const crateAt = (k: number, bay: Bay): Point => { const q = slotAt("intake", k, "normal", bay); return { x: q.x, y: q.y - lift }; };
  return {
    shown: nCards + shownCrates, shownCrates, density: d,
    top: (bay: Bay): Point => (crateCap > 0 ? crateAt(crateCap - 1, bay) : slotAt("claim", Math.max(0, nCards - 1), d, bay)),
    place<C extends { id: string }>(list: readonly C[], ids: ReadonlySet<string>, bay: Bay, pin?: ReadonlySet<string> | null): Placed<C>[] {
      const cards = list.filter(c => ids.has(c.id)), crates = withPinned(list.filter(c => !ids.has(c.id)), shownCrates, pin);
      return [...cards.map((c, k) => ({ c, k, p: slotAt("claim", k, d, bay), card: true, d, size: sizeOf("claim", d) })), ...crates.map((c, k) => ({ c, k: nCards + k, p: crateAt(k, bay), card: false, d: "normal" as Density, size: sizeOf("intake") }))];
    },
  };
}

/** The first `cap` of `list`, except that every pinned id beyond the cap swaps in for the last unpinned id inside it (order is otherwise kept). */
export function withPinned<C extends { id: string }>(list: readonly C[], cap: number, pin: ReadonlySet<string> | null | undefined): C[] {
  const head = list.slice(0, cap);
  if (!pin || !pin.size) return head;
  for (const c of list.slice(cap)) {
    if (!pin.has(c.id)) continue;
    let at = -1; for (let i = head.length - 1; i >= 0; i--) if (!pin.has(head[i].id)) { at = i; break; }
    if (at < 0) head.push(c); else head[at] = c;
  }
  return head;
}

/** Badge from the `model:*` and `role:*` labels, through MODEL_TIERS. A lead is a hexagon, a worker a circle; with no role, a
 * strong or king model reads as a lead. */
export function workerBadge(labels: readonly string[]): WorkerBadge {
  const val = (k: string) => labels.find(l => l.toLowerCase().startsWith(`${k}:`))?.slice(k.length + 1).trim().toLowerCase() ?? null;
  const t = modelTier(val("model")), r = val("role"), role = r === "lead" || r === "worker" ? r : null, known = t.provider !== null;
  return { model: known ? t.key : null, provider: t.provider, tier: t.tier, label: t.label, title: tierTitle(t, role), role, shape: role === "lead" || (role === null && (t.tier === "strong" || t.tier === "king")) ? "hex" : "circle", glyph: t.letter };
}

/** The lane/workstream hue (0..7, theme token --oi-lane-N) an agent wears everywhere on the Floor: FNV-1a of its identity onto the 8 existing lane tokens, so the same agent is the same colour on its crate chip and its ON THE FLOOR rows. No palette of its own. */
export const AGENT_LANES = 8;
export const agentLane = (key: string): number => { let h = 0x811c9dc5; for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h % AGENT_LANES; };
/** Who a bead's work belongs to for colouring: its assignee lane, else the pane working it, else the bead itself (no agent: per item). */
export const agentKeyOf = (assignee: string | null | undefined, pane: string | null | undefined, beadId: string): string => assignee || pane || beadId;
/** Ramp step 0..4 for a heat value 0..1 (0 stays cold; each quarter above it is one step). */
export const heatStep = (v: number | null): number | null => (v === null ? null : v <= 0 ? 0 : Math.min(4, Math.ceil(clamp01(v) * 4)));

/** Pane + anomalies per bead from bdi's tree (first node that carries an agent wins). */
function paneJoin(s: WorkSurfaceSnapshot) {
  const out = new Map<string, { paneId: string | null; state: string | null; stale: boolean }>();
  for (const r of s.tree) for (const n of r.nodes) {
    const had = out.get(n.id); if (had?.paneId) continue;
    out.set(n.id, { paneId: n.agent?.paneId ?? null, state: n.agent?.state ?? null, stale: n.anomalies.some(a => a === "stale-pane" || a === "stale-claim") || (had?.stale ?? false) });
  }
  return out;
}

/** Not-done beads downstream of `id` through `blocks` edges of the work graph (each counted once). */
export function downstreamOf(g: GraphModel, id: string, done: (id: string) => boolean): number {
  const seen = new Set<string>([id]); let queue = [id], n = 0;
  while (queue.length) {
    const next: string[] = [];
    for (const x of queue) for (const e of g.adjacency[x]?.outgoing ?? []) {
      if (e.type !== "blocks" || seen.has(e.target)) continue;
      seen.add(e.target); next.push(e.target); if (!done(e.target)) n++;
    }
    queue = next;
  }
  return n;
}

/** Beads that landed in (from, t], each once: the stat row's "Landed today" with from = local midnight (FAC-12: a per-hour rate
 * over 24 h rounded one landing down to "0" beside a log line saying it landed). */
export function landedSince(events: readonly HistoryEvent[], from: number, t: number): number {
  const ids = new Set<string>();
  for (const e of events) if (e.at <= t && e.at > from && (e.kind === "closed" || (e.kind === "status" && e.to === "closed"))) ids.add(e.id);
  return ids.size;
}
/** Done at t: closes in (t - THROUGHPUT_MS, t], each bead once. */
export function throughputAt(events: readonly HistoryEvent[], t: number): { lastDay: number; perHour: number } {
  const ids = new Set<string>();
  for (const e of events) if (e.at <= t && e.at > t - THROUGHPUT_MS && (e.kind === "closed" || (e.kind === "status" && e.to === "closed"))) ids.add(e.id);
  return { lastDay: ids.size, perHour: Math.round((ids.size / 24) * 10) / 10 };
}

export function closeTimes(events: readonly HistoryEvent[], t: number) {
  const m = new Map<string, number>();
  for (const e of events) if (e.at <= t && (e.kind === "closed" || (e.kind === "status" && e.to === "closed"))) m.set(e.id, Math.max(m.get(e.id) ?? -Infinity, e.at));
  return m;
}

export type TrailStop = { station: StationId; at: number };
/** The stations a bead passed through up to t, with the time it reached each. Sampled from stagesAt at the bead's own events
 * (and at its blockers' closes, which move it from waiting to ready); consecutive repeats collapse. Pure consumption of replay. */
export function trailOf(s: WorkSurfaceSnapshot, events: readonly HistoryEvent[], id: string, t: number, now: number, claimMs = CLAIM_MS): TrailStop[] {
  const blockers = new Set(s.deps.filter(d => d.type === "blocks" && d.issueId === id).map(d => d.dependsOnId));
  const times = new Set<number>();
  for (const e of events) if (e.at <= t && (e.id === id || (blockers.has(e.id) && (e.kind === "closed" || e.to === "closed")))) { times.add(e.at); if (e.id === id && (e.kind === "started" || e.to === "in_progress")) times.add(e.at + claimMs); }
  times.add(t);
  const i = s.issues.find(x => x.id === id), started = i?.startedAt ? Date.parse(i.startedAt) : NaN;
  const out: TrailStop[] = [];
  for (const at of [...times].filter(x => x <= t).sort((a, b) => a - b)) {
    const st = stagesAt(s, events, at, now).get(id); if (!st) continue;
    const since = st === "building" && Number.isFinite(started) ? Math.max(0, at - started) : null;
    const station = stationOf({ stage: st, sinceMs: since }, claimMs);
    if (out.at(-1)?.station !== station) out.push({ station, at });
  }
  return out;
}
/** Backward moves along a trail (Gate back to Build, Build back to Intake, ...). */
/** Sent back along a trail: Gate → Claim/Build only (a reopen after Land is new work, not rework; lead answer 1). */
export const reworkIn = (trail: readonly TrailStop[]) => trail.reduce((n, x, k) => n + (k > 0 && trail[k - 1].station === "gate" && (x.station === "claim" || x.station === "build") ? 1 : 0), 0);
/** The Motion for a bead whose station went from `from` to `to` while its stage moved backwards in forward time. */
export const backwardMotion = (from: StationId, to: StationId): Motion => (from === "gate" && (to === "claim" || to === "build") ? "rework" : from === "land" && to === "intake" ? "reopened" : "back");

// ---- locks ------------------------------------------------------------------------------------------------------------
/** Log line for a lock moment, e.g. "🔒 #12 locked by #07", "🔒 #12 waiting on scope src/auth/** (held by w-3)". */
export function lockText(l: FloorLock, opened = false): string {
  const me = `#${shortId(l.beadId)}`;
  if (opened) return `🔓 ${me} unlocked`;
  if (l.kind === "blocked") return `🔒 ${me} locked by ${l.holders.map(h => `#${shortId(h)}`).join(", ")}`;
  if (l.kind === "scope") return `🔒 ${me} waiting on scope ${(l.scope ?? []).join(", ")}${l.holderAgent ? ` (held by ${l.holderAgent})` : ""}`;
  return `🔒 ${me} held at the gate (${l.holders.length} in review)`;
}
/** Where a bead is at t, for wait texts: its station, or null when it is not on the floor (not in this snapshot). */
export type WhereIs = (id: string) => StationId | null;
const placeOf = (where: WhereIs, id: string) => { const x = where(id); return x === null ? `#${shortId(id)} (not on the floor)` : x === "land" ? `#${shortId(id)} (landed)` : `#${shortId(id)} (at ${STATION_TEXT[x].label})`; };
const andList = (xs: readonly string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
/** What a lock locks and who holds it, in plain words (the padlock's tooltip): "#C cannot start until #B (at Build)
 * lands", "#C waits for files src/auth/**, which #B holds (agent w-3)", "#C waits at the Gate for a free reviewer. 2
 * reviews run at a time and #x and #y are in review". */
export function lockDetail(l: FloorLock, where: WhereIs): string {
  const me = `#${shortId(l.beadId)}`, hs = l.holders.map(h => `#${shortId(h)}`);
  if (l.kind === "blocked") return `🔒 Locked: ${me} cannot start until ${andList(l.holders.map(h => placeOf(where, h)))} ${hs.length === 1 ? "lands" : "land"}.`;
  if (l.kind === "scope") return `🔒 Locked: ${me} waits for files ${(l.scope ?? []).join(", ") || "in use"}, which ${andList(hs)} ${hs.length === 1 ? "holds" : "hold"}${l.holderAgent ? ` (agent ${l.holderAgent})` : ""}.`;
  return `🔒 Held: ${me} waits at the Gate for a free reviewer. ${hs.length} ${hs.length === 1 ? "review runs" : "reviews run"} at a time and ${andList(hs)} ${hs.length === 1 ? "is" : "are"} in review.`;
}

/** A card's wait / block caption. kind: waits = an unmet `blocks` dependency; files = a write-scope lease; blocks = it holds
 * other beads up; held = queued at the Gate. `ids` are the beads it names (clickable); `short` fits the card strip at its
 * density ("" for micro: no strip); `full` is the sentence for the tooltip and the inspector. */
export type WaitCaption = { kind: "waits" | "files" | "blocks" | "held"; ids: string[]; short: string; full: string };
/** Characters a caption strip holds per density (at its font size). */
export const CAPTION_CHARS: Readonly<Record<Density, number>> = { normal: 18, dense: 13, micro: 0, full: 26 };
/** prefix + "#id" + suffix in at most `max` characters: the id is shortened first (to 5, "h1w…7"), then the "+N" goes (the full
 * sentence always names every bead). */
const fitIn = (prefix: string, id: string, suffix: string, max: number) => {
  const room = (sfx: string) => max - prefix.length - sfx.length - 1, sfx = room(suffix) >= 5 || shortId(id).length <= room(suffix) ? suffix : "";
  return `${prefix}${fitId(shortId(id), Math.max(5, room(sfx)))}${sfx}`;
};
/** Priority: what it waits on (dependency, then files) beats what it holds up, which beats a Gate queue. */
export function waitCaption(k: { waitingOn: readonly string[]; blocks: readonly string[] }, lock: FloorLock | null, d: Density, where: WhereIs): WaitCaption | null {
  const max = CAPTION_CHARS[d], fit = (s: string) => (max === 0 ? "" : s);
  if (k.waitingOn.length) {
    const [a] = k.waitingOn, more = k.waitingOn.length - 1, suffix = more ? ` +${more}` : "";
    return { kind: "waits", ids: [...k.waitingOn], short: fit(fitIn(d === "normal" || d === "full" ? "waits on " : "waits ", a, suffix, max)), full: `Waits on ${k.waitingOn.map(x => placeOf(where, x)).join(", ")}` };
  }
  if (lock?.kind === "scope") return { kind: "files", ids: [...lock.holders], short: fit(d === "normal" || d === "full" ? "waits for files" : "files busy"), full: lockDetail(lock, where).slice(3) };
  if (k.blocks.length) {
    const n = k.blocks.length;
    return { kind: "blocks", ids: [...k.blocks], short: fit(n === 1 ? fitIn("blocks ", k.blocks[0], "", max) : `blocks ${n}`), full: `Blocks ${k.blocks.map(x => placeOf(where, x)).join(", ")}: ${n === 1 ? "it waits" : "they wait"} until this lands` };
  }
  if (lock?.kind === "gate") return { kind: "held", ids: [...lock.holders], short: fit(d === "normal" || d === "full" ? "queued for review" : "review queue"), full: lockDetail(lock, where).slice(3) };
  return null;
}

/** Locks that appeared and disappeared between two frames, by key. Time running backwards shows none. */
export function lockMoments(prev: readonly FloorLock[], next: readonly FloorLock[], forward: boolean): { locked: FloorLock[]; unlocked: FloorLock[] } {
  if (!forward) return { locked: [], unlocked: [] };
  const a = new Set(prev.map(l => l.key)), b = new Set(next.map(l => l.key));
  return { locked: next.filter(l => !a.has(l.key)), unlocked: prev.filter(l => !b.has(l.key)) };
}
/** What a log line IS, so ON THE FLOOR can colour and draw each kind its own way (owner 01:38). `intake` is reserved for new work
 * arriving; nothing emits it yet (a reopen is its own kind). */
export type LogKind = "intake" | "claimed" | "gate" | "landed" | "sentBack" | "reopened" | "locked" | "unlocked";
/** `kind` + `beadId`: set at every emit site, so no consumer ever parses them out of `text` or `key`. `beadId` is absent for the
 * aggregated Gate line. Optional only so older callers and fixtures that build bare lines still type-check. */
/** `title`: the bead's title, so a line reads "#osi.11 claimed · Diff viewer" without a hover (FAC-9); absent for aggregate
 * lines ("Gate holding 4"). */
export type LogLine = { key: string; text: string; tone: "failure" | "attention" | "success" | "info"; title?: string; kind?: LogKind; beadId?: string };
/** A title fitted to one log line. */
export const logTitle = (title: string, max = 40) => (title.length <= max ? title : `${title.slice(0, max - 1).trimEnd()}…`);
/** The floor log's lock lines between two frames (lead answer 2): blocked and scope locks per bead ("🔒 #12 locked by #07",
 * "🔓 #12 unlocked"); Gate holds as ONE aggregated line when their count changes ("🔒 Gate holding 4", "🔓 Gate clear"). */
export function lockLogLines(prev: Pick<FloorFrame, "locks" | "t"> | null, next: Pick<FloorFrame, "locks" | "t"> & Partial<Pick<FloorFrame, "tokens">>): LogLine[] {
  if (!prev || next.t < prev.t) return [];
  const m = lockMoments(prev.locks.filter(l => l.kind !== "gate"), next.locks.filter(l => l.kind !== "gate"), true), out: LogLine[] = [];
  const titleOf = (id: string) => { const k = next.tokens?.find(x => x.id === id); return k ? { title: logTitle(k.title) } : {}; };
  for (const l of m.unlocked) out.push({ key: `u:${l.key}:${next.t}`, text: lockText(l, true), tone: "success", kind: "unlocked", beadId: l.beadId, ...titleOf(l.beadId) });
  for (const l of m.locked) out.push({ key: `l:${l.key}:${next.t}`, text: lockText(l), tone: "failure", kind: "locked", beadId: l.beadId, ...titleOf(l.beadId) });
  const a = prev.locks.filter(l => l.kind === "gate").length, b = next.locks.filter(l => l.kind === "gate").length;
  if (a !== b) out.push({ key: `g:${b}:${next.t}`, text: b ? `🔒 Gate holding ${b}` : "🔓 Gate clear", tone: b ? "attention" : "success", kind: b ? "locked" : "unlocked" });
  return out;
}
/** The floor's own moves between two frames, as log lines: claimed (into Claim / Build from Intake), to the gate, landed,
 * sent back (rework), reopened. Forward time only. Same wording the live log uses. */
export function moveLogLines(prev: Pick<FloorFrame, "tokens" | "t"> | null, next: Pick<FloorFrame, "tokens" | "t">): LogLine[] {
  if (!prev || next.t < prev.t) return [];
  const was = new Map(prev.tokens.map(k => [k.id, k.station])), out: LogLine[] = [];
  for (const k of next.tokens) {
    const w = was.get(k.id); if (w === undefined || w === k.station) continue;
    const id = `#${k.shortId}`, key = (x: string) => `${x}:${k.id}:${next.t}`, title = logTitle(k.title);
    // the sent-back line names where it really went (Claim or Build); it used to say Build either way (FAC-9)
    if (w === "gate" && (k.station === "claim" || k.station === "build")) out.push({ key: key("r"), text: `↩ ${id} sent back to ${STATION_TEXT[k.station].label}`, tone: "attention", title, kind: "sentBack", beadId: k.id });
    else if (w === "land" && k.station === "intake") out.push({ key: key("o"), text: `↺ ${id} reopened (new work)`, tone: "info", title, kind: "reopened", beadId: k.id });
    else if (w === "intake" && (k.station === "claim" || k.station === "build")) out.push({ key: key("c"), text: `${id} claimed`, tone: "info", title, kind: "claimed", beadId: k.id });
    else if (k.station === "gate" && stationIndex(w) < stationIndex("gate")) out.push({ key: key("g"), text: `${id} to the Gate for review`, tone: "attention", title, kind: "gate", beadId: k.id });
    else if (k.station === "land") out.push({ key: key("d"), text: `${id} landed`, tone: "success", title, kind: "landed", beadId: k.id });
  }
  return out;
}
/** ON THE FLOOR backfill (owner, 22:38): when the open skips the catch-up, the log still shows the most recent `max` moments
 * from history (claimed / to the gate / landed / locked / unlocked / sent back), newest first, each with its time. Built by
 * stepping the floor itself through the latest history event times, so it says exactly what a replay would. Empty only when
 * the history really is empty. */
/** `now` is the REAL present (what floorAt treats as live); `upTo` is the time being shown (default: now). Only events up to `upTo` count, and
 * only a sample AT `now` is a live frame, so a replayed position never reads the snapshot's current statuses. Creations are not sampled:
 * they draw no log line, and counting them let quiet events evict every meaningful one. */
export function historyLog(s: WorkSurfaceSnapshot, events: readonly HistoryEvent[], now: number, opts: FloorOpts = {}, max = 12, upTo: number = now): (LogLine & { at: number })[] {
  const times = [...new Set(events.filter(e => e.at <= upTo && e.kind !== "created").map(e => e.at))].sort((a, b) => a - b).slice(-(max * 2));
  if (!times.length) return [];
  const o = { ...opts, prev: null, reducedMotion: true, heat: "age" as const }, out: (LogLine & { at: number })[] = [];
  const frame = (t: number) => floorAt(s, events, t, now, o), emit = (p: FloorFrame, f: FloorFrame, at: number) => { for (const l of [...lockLogLines(p, f), ...moveLogLines(p, f)]) out.push({ ...l, at }); };
  // each meaningful time is diffed against the state JUST BEFORE it, so a bead created blocked and released later still shows its release
  for (const t of times) emit(frame(t - 1), frame(t), t);
  if (upTo > times[times.length - 1]) emit(frame(times[times.length - 1]), frame(upTo), upTo); // the last stretch (live only changes at now)
  const seen = new Set<string>();
  return out.reverse().filter(l => (seen.has(l.key) ? false : (seen.add(l.key), true))).slice(0, max);
}
/** Reduced motion keeps "catch me up" (FAC-14): instead of an accelerated glide the catch-up JUMPS from one history moment to
 * the next, STEP_MS apart, and lands on now. The next stop after `cur` (or t1 when none is left). */
export const STEP_MS = 450;
export const catchUpStep = (times: readonly number[], cur: number, t1: number) => Math.min(t1, times.find(x => x > cur) ?? t1);
/** The wheel zooms only with Ctrl or Cmd held; a plain wheel scrolls the page (FAC-13: the floor used to swallow page scroll).
 * A pinch on a trackpad arrives as ctrlKey + wheel, so it still zooms. */
export const wheelZooms = (e: { ctrlKey: boolean; metaKey: boolean }) => e.ctrlKey || e.metaKey;
/** The colour key (FAC-11: a card's edge colour is its parent epic, and nothing said so): one entry per colour on the floor,
 * with the epic it stands for and how many drawn beads carry it, most first, at most `max`. */
export function groupKey(f: Pick<FloorFrame, "tokens" | "factory">, max = 8): { tone: number; label: string; count: number }[] {
  const n = new Map<number, number>(); for (const k of f.tokens) n.set(k.group, (n.get(k.group) ?? 0) + 1);
  const label = new Map<number, string>(); for (const r of f.factory.rows) if (!label.has(r.toneIndex)) label.set(r.toneIndex, r.label);
  return [...n].map(([tone, count]) => ({ tone, count, label: label.get(tone) ?? "Unfiled" })).sort((a, b) => b.count - a.count || a.tone - b.tone).slice(0, max);
}
/** An epic's key chip: its short id and a name of at most three words (the full label is the tooltip). Rows read "<shortId> · <title>". */
export function epicChip(label: string): { id: string; name: string } {
  const [id, ...rest] = label.split(" · "), words = rest.join(" · ").split(/\s+/).filter(Boolean);
  return rest.length ? { id, name: words.slice(0, 3).join(" ") + (words.length > 3 ? "…" : "") } : { id: "", name: label };
}
/** The stat-row "Locks" cell: how many are active and how long the oldest has held (null when no age is known). */
export function lockStats(locks: readonly FloorLock[]): { active: number; oldestMs: number | null } {
  const ages = locks.map(l => l.sinceMs).filter((x): x is number => x !== null);
  return { active: locks.length, oldestMs: ages.length ? Math.max(...ages) : null };
}

export function floorAt(s: WorkSurfaceSnapshot, events: readonly HistoryEvent[], t: number, now: number, opts: FloorOpts = {}): FloorFrame {
  const claimMs = opts.claimMs ?? CLAIM_MS, th = thresholdsOf(opts.thresholds), heatMode = opts.heat ?? "age";
  const live = t >= now, f = factoryAt(s, events, t, now), cards = allCardsOf(f), closed = closeTimes(events, t);
  const graph = opts.graph ?? buildGraphModel(toBeadIssues(s));
  const stageOf = new Map(cards.map(c => [c.id, c.stage])), graphStatus = new Map(graph.nodes.map(n => [n.id, n.status]));
  const isDone = (id: string) => (stageOf.get(id) ?? (graphStatus.get(id) === "closed" ? "done" : null)) === "done";
  const waiting = new Map<string, string[]>();
  for (const e of factoryEdges(s, f, true)) if (e.unmet) waiting.set(e.to, [...(waiting.get(e.to) ?? []), e.from]);
  const join = live ? paneJoin(s) : new Map<string, { paneId: string | null; state: string | null; stale: boolean }>();
  const tlive = live ? opts.transcriptLive ?? null : null;
  const group = new Map<string, number>();
  for (const r of f.rows) for (const st of STAGES) for (const c of f.cells.get(r.key)!.get(st)!) group.set(c.id, r.toneIndex);
  for (const [id, tone] of f.hiddenTone) group.set(id, tone);
  const at = new Map<StationId, FactoryCard[]>(STATIONS.map(x => [x, []]));
  // live: an agent is attached when it has a pane, or (no pane) its lane's transcript was written within the window
  // a pinned bead (selected, followed, critical, a lock holder) is never hidden by the archive
  for (const c of cards) if (!(c.stage === "done" && opts.archivedIds?.has(c.id) && !opts.pinned?.has(c.id))) at.get(stationOf(c, claimMs, live ? { attached: !!(c.pane || join.get(c.id)?.paneId || tlive?.has(c.id)) } : null))!.push(c);
  // Hidden groups: counted from factoryAt's stage totals, never drawn.
  const seen = { waiting: 0, ready: 0, building: 0, review: 0, done: 0 } as Record<Stage, number>;
  for (const c of cards) seen[c.stage]++;
  const hid = (st: Stage) => Math.max(0, f.counts[st] - seen[st]);
  const hidden: Record<StationId, number> = { intake: hid("waiting") + hid("ready"), claim: 0, build: hid("building"), gate: hid("review"), land: hid("done") };
  const order = (x: StationId) => (a: FactoryCard, b: FactoryCard) => x === "land" ? (closed.get(b.id) ?? 0) - (closed.get(a.id) ?? 0) || cmp(a.id, b.id)
    : x === "intake" ? Number(a.stage === "waiting") - Number(b.stage === "waiting") || a.priority - b.priority || cmp(a.id, b.id)
    : a.priority - b.priority || (b.sinceMs ?? 0) - (a.sinceMs ?? 0) || cmp(a.id, b.id);

  const prev = opts.prev ?? null, rewind = prev !== null && t < prev.t;
  const delta = prev ? motionDelta(prev.factory, f) : { fresh: [], rework: [] };
  const fresh = new Set(delta.fresh), rework = new Set(rewind ? [] : delta.rework);
  const was = new Map((prev?.tokens ?? []).map(k => [k.id, k]));
  const labels = new Map(s.issues.map(i => [i.id, i.labels]));
  const critical = opts.critical ?? null, costs = opts.costs ?? null;
  const costOf = (id: string, paneId: string | null) => (costs ? costs.get(paneId ?? "") ?? costs.get(id) ?? null : null);
  const heatScale = opts.heatScale ?? "absolute";
  const reworkOf = (id: string, x: StationId) => (heatMode === "rework" || x === "claim" || x === "build" ? reworkIn(trailOf(s, events, id, t, now, claimMs)) : 0) + (opts.reworkSeen?.get(id) ?? 0);

  // Locks, from consumed outputs only: factoryEdges (blocked), the lease queue (scope, live), the Gate threshold (gate).
  const locks: FloorLock[] = [], since = new Map(cards.map(c => [c.id, c.sinceMs]));
  for (const c of cards) { const w = waiting.get(c.id); if (c.stage === "waiting" && w?.length) locks.push({ key: `blocked:${c.id}`, kind: "blocked", beadId: c.id, holders: [...w].sort(cmp), holderAgent: null, scope: null, sinceMs: c.sinceMs }); }
  if (live) for (const q of opts.scopeWaits ?? []) if (stageOf.has(q.beadId) && q.blockers.length) locks.push({ key: `scope:${q.beadId}`, kind: "scope", beadId: q.beadId, holders: q.blockers.map(b => b.beadId), holderAgent: q.blockers[0].holder, scope: [...new Set(q.blockers.flatMap(b => b.scope))], sinceMs: since.get(q.beadId) ?? null });
  const gateList = at.get("gate")!.sort(order("gate")), reviewing = gateList.slice(0, th.gate).map(c => c.id);
  for (const c of gateList.slice(th.gate)) locks.push({ key: `gate:${c.id}`, kind: "gate", beadId: c.id, holders: reviewing, holderAgent: null, scope: null, sinceMs: c.sinceMs });
  const lockOf = new Map<string, string>();
  for (const l of locks) if (!lockOf.has(l.beadId)) lockOf.set(l.beadId, l.key);

  const bayOf = new Map<StationId, Bay>(STATIONS.map(x => [x, uniformBay(x)]));
  if (opts.silos) { // widths follow load: counts are the station totals incl. hidden ones, so they do not depend on what is drawn
    const w = siloWidths(Object.fromEntries(STATIONS.map(x => [x, at.get(x)!.length + hidden[x]])) as Record<StationId, number>, FLOOR.W - 2 * FLOOR.X0, opts.full ? { minBusy: CARD_SIZES.full.w + FLOOR.PAD + EDGE } : {}); // full: a busy silo fits one full card
    siloRects(w, FLOOR.X0).forEach((r, i) => bayOf.set(STATIONS[i], r));
  }
  const capFor = (x: StationId) => opts.full ? Infinity : Math.max(1, Math.min(opts.maxPerStation ?? capOf(x, bayOf.get(x)!.w), capOf(x, bayOf.get(x)!.w)));
  const stations: FloorStation[] = [], tokens: FloorToken[] = [], workers: FloorWorker[] = [], workerOverflow = { intake: 0, claim: 0, build: 0, gate: 0, land: 0 } as Record<StationId, number>;
  for (const x of STATIONS) {
    const cap = capFor(x), list = at.get(x)!.sort(order(x)), count = list.length + hidden[x], bay = bayOf.get(x)!, bx = bay.x;
    // INTAKE chain beads (opts.chainIds: any bead on a `blocks` chain) are drawn as full CARDS, all of them, never folded into
    // "+N"; the plain crates stack above the cards in whatever room is left.
    const chainCards = x === "intake" && opts.chainIds && !opts.full ? list.filter(c => opts.chainIds!.has(c.id)) : [], plan = chainCards.length ? intakePlan(chainCards.length, list.length - chainCards.length, Math.min(cap, list.length), bay.w) : null;
    // `shown` is what is actually DRAWN (pinned beads past the cap take a slot too), so the +N chip, its count and overflowIds always agree
    const planned = plan ? plan.place(list, opts.chainIds!, bay, opts.pinned) : null, drawList = planned ? null : withPinned(list, Math.min(cap, list.length), opts.pinned);
    const shown = planned ? planned.length : drawList!.length;
    const density: Density = opts.full ? "full" : isCardStation(x) ? densityFor(shown, bay.w) : "normal", size = sizeOf(x, density);
    const queue = x === "land" ? 0 : x === "intake" ? list.filter(c => c.stage === "ready").length + hid("ready") : count, limit = th[x];
    const top = plan ? plan.top(bay) : slotAt(x, Number.isFinite(cap) ? cap - 1 : Math.max(0, shown - 1), density, bay);
    stations.push({ id: x, ...STATION_TEXT[x], x: bx, w: bay.w, cx: bx + bay.w / 2, count, queue, threshold: limit, shown, overflow: count - shown, overflowIds: [], overflowAt: { x: bx + FLOOR.PAD, y: top.y - FLOOR.GAP - 14 }, bottleneck: queue > limit, severity: queue <= limit ? 0 : clamp01((queue - limit) / Math.max(1, limit)) });
    const slots = planned ?? drawList!.map((c, k) => ({ c, k, p: slotAt(x, k, density, bay), card: isCardStation(x) || opts.full === true, d: density, size }));
    { const drawn = new Set(slots.map(q => q.c.id)); stations[stations.length - 1].overflowIds = list.filter(c => !drawn.has(c.id)).map(c => c.id); } // the "+N" chip lists exactly who it holds
    slots.forEach(({ c, k, p, card, d: density, size }) => {
      const o = was.get(c.id);
      const motion: Motion | null = !prev ? null : !o ? "enter" : o.x === p.x && o.y === p.y ? null
        : rewind ? "rewind" : rework.has(c.id) || stationIndex(x) < stationIndex(o.station) ? backwardMotion(o.station, x) : fresh.has(c.id) || stationIndex(x) > stationIndex(o.station) ? "forward" : "shift";
      const downstream = downstreamOf(graph, c.id, isDone), rw = reworkOf(c.id, x), cost = costOf(c.id, join.get(c.id)?.paneId ?? null);
      const raw = heatMode === "age" ? (c.stage === "done" ? 0 : c.sinceMs) : heatMode === "rework" ? rw : heatMode === "impact" ? downstream : cost;
      const heat = raw === null ? null : clamp01(raw / HEAT_FULL[heatMode]);
      tokens.push({ id: c.id, shortId: c.shortId, title: c.title, stage: c.stage, station: x, shape: card ? "card" : "crate", density, ...p, ...size, gateRole: x !== "gate" ? null : k < th.gate ? "review" : "held", group: group.get(c.id) ?? 0, blocked: c.blocked, hot: c.hot, critical: critical?.has(c.id) ?? false, priority: c.priority, sinceMs: c.sinceMs, pane: c.pane, motion, waitingOn: (waiting.get(c.id) ?? []).sort(cmp), downstream, rework: rw, heat, heatStep: heatStep(heat), lock: lockOf.get(c.id) ?? null, blocks: c.stage === "done" ? [] : directBlocks(graph, c.id).dependents.filter(d => !isDone(d)), caption: null }); // a landed bead holds nothing up
    });
    if (isCardStation(x)) { // the agent occupies its bead's card: its badge sits inside the card, left
      list.slice(0, shown).forEach((c, k) => {
        const p = slotAt(x, k, density, bay), j = join.get(c.id), paneId = j?.paneId ?? null, tl = tlive?.get(c.id) ?? null;
        const via: FloorWorker["via"] = !live ? null : c.pane || paneId ? "pane" : tl ? "transcript" : null, presence: FloorWorker["presence"] = !live ? "past" : via ? "live" : "ghost";
        workers.push({ key: paneId ? `${paneId}:${c.id}` : `${presence}:${c.id}`, beadId: c.id, station: x, x: p.x + CARD_SIZES[density].badgeX, y: p.y + badgeY(density), presence, via, transcriptAt: tl?.lastAt ?? null, stale: j?.stale ?? false, pane: c.pane ?? paneId, paneState: j?.state ?? null, badge: workerBadge(labels.get(c.id) ?? []), elapsedMs: c.sinceMs, cost: costOf(c.id, paneId), critical: critical?.has(c.id) ?? false });
      });
      workerOverflow[x] = count - shown;
    }
  }
  const stationAt = new Map<string, StationId>(); for (const [x, list] of at) for (const c of list) stationAt.set(c.id, x);
  const where: WhereIs = id => stationAt.get(id) ?? null, lockBy = new Map(locks.map(l => [l.key, l]));
  for (const k of tokens) k.caption = waitCaption(k, k.lock ? lockBy.get(k.lock) ?? null : null, k.shape === "card" ? k.density : "micro", where);
  if (heatScale === "relative") { // the hottest bead on the floor is the brightest; an all-cold floor stays cold
    const top = Math.max(0, ...tokens.map(k => k.heat ?? 0));
    for (const k of tokens) if (k.heat !== null) { k.heat = top > 0 ? k.heat / top : 0; k.heatStep = heatStep(k.heat); }
  }
  const inRework = tokens.filter(k => (k.station === "claim" || k.station === "build") && (k.rework > 0 || k.motion === "rework")).length;
  const tweens: Tween[] = [];
  if (prev && !opts.reducedMotion) {
    const now2 = new Set(tokens.map(k => k.id));
    for (const k of tokens) {
      if (!k.motion) continue;
      const o = was.get(k.id);
      tweens.push({ id: k.id, kind: k.motion, from: o ? { x: o.x, y: o.y } : { x: k.x - ENTER_DX, y: k.y }, to: { x: k.x, y: k.y } });
    }
    for (const o of prev.tokens) if (!now2.has(o.id)) tweens.push({ id: o.id, kind: "exit", from: { x: o.x, y: o.y }, to: { x: o.x, y: o.y } });
  }
  const lift = Math.max(0, FLOOR.HEAD_CLEAR - Math.min(FLOOR.HEAD_CLEAR, ...tokens.map(k => k.y))); // the floor stretches up until the highest drawn token clears the bay headers (cards and crates alike)
  return { lift, reviewKnown: live, thresholdsWired: (opts.thresholds ?? null) !== null, t, live, heatMode, heatScale, inRework, gateHolding: locks.filter(l => l.kind === "gate").length, laneHeat: heatStep(clamp01(inRework / LANE_FULL)) ?? 0, stations, tokens, workers, workerOverflow, tweens, locks, lockMoments: prev ? lockMoments(prev.locks, locks, !rewind) : { locked: [], unlocked: [] }, counts: f.counts, throughput: throughputAt(events, t), criticalWired: critical !== null, costWired: costs !== null, leasesWired: (opts.scopeWaits ?? null) !== null, factory: f };
}

// ---- motion -----------------------------------------------------------------------------------------------------------
/** What is on screen: one entry per drawn crate. `ret` routes a move over the return conveyor (rework: drop, ride back
 * shrunk to `scale`, climb); `arc` lifts a crate over the belt (reopened or another backward move); neither rides the belt. */
export type PoseToken = { id: string; x: number; y: number; opacity: number; arc: number; ret: boolean; scale: number };
export type Pose = { tokens: PoseToken[] };
export const poseOf = (f: Pick<FloorFrame, "tokens">): Pose => ({ tokens: f.tokens.map(k => ({ id: k.id, x: k.x, y: k.y, opacity: 1, arc: k.motion === "reopened" || k.motion === "back" ? REWORK_ARC : 0, ret: k.motion === "rework", scale: 1 })) });

/** Point at fraction a along p → down to the lane → along it → up to n, by path length; shrinks to RET.SCALE on the lane. */
export function viaReturn(p: Point, n: Point, a: number): Point & { scale: number } {
  const r = RET.Y, d1 = Math.abs(r - p.y), d2 = Math.abs(n.x - p.x), d3 = Math.abs(n.y - r), L = d1 + d2 + d3 || 1;
  let d = clamp01(a) * L;
  if (d <= d1) { const k = d1 ? d / d1 : 1; return { x: p.x, y: lerp(p.y, r, k), scale: lerp(1, RET.SCALE, k) }; }
  d -= d1; if (d <= d2) return { x: lerp(p.x, n.x, d2 ? d / d2 : 1), y: r, scale: RET.SCALE };
  d -= d2; const k = d3 ? d / d3 : 1; return { x: n.x, y: lerp(r, n.y, k), scale: lerp(RET.SCALE, 1, k) };
}

/** Pose between prev (alpha 0) and next (alpha 1). Matched crates glide (rework rides the return conveyor, a reopen arcs back
 * over the belt); new crates slide in
 * from the left and fade in; crates that left fade out in place and are gone at alpha 1. Pure, so an interrupted tween can
 * start again from whatever pose is on screen. */
export function interpolate(prev: Pose, next: Pose, alpha: number): Pose {
  const a = clamp01(alpha);
  if (a === 1) return { tokens: next.tokens.map(k => ({ ...k })) };
  const was = new Map(prev.tokens.map(k => [k.id, k])), out: PoseToken[] = [];
  for (const n of next.tokens) {
    const p = was.get(n.id);
    if (!p) { out.push({ ...n, x: n.x - ENTER_DX * (1 - a), opacity: n.opacity * a }); continue; }
    const at = n.ret ? viaReturn(p, n, a) : { x: lerp(p.x, n.x, a), y: lerp(p.y, n.y, a) - n.arc * Math.sin(Math.PI * a), scale: lerp(p.scale, n.scale, a) };
    out.push({ ...n, ...at, opacity: lerp(p.opacity, n.opacity, a) });
  }
  const keep = new Set(next.tokens.map(k => k.id));
  for (const p of prev.tokens) if (!keep.has(p.id)) out.push({ ...p, opacity: p.opacity * (1 - a) });
  return { tokens: out };
}
/** Ease-out cubic for the view's tween clock. */
export const ease = (k: number) => 1 - Math.pow(1 - clamp01(k), 3);

// ---- replay -----------------------------------------------------------------------------------------------------------
/** Next replay time after dtMs of wall time at `speed`: the whole span takes REPLAY_BASE_MS / speed. Clamped to t1. */
export const replayAdvance = (t: number, dtMs: number, t0: number, t1: number, speed: Speed) => Math.min(t1, t + ((t1 - t0) * dtMs * speed) / REPLAY_BASE_MS);
/** Snap t to one of `steps` buckets across [t0, t1] (t1 itself stays exact, so "now" is live), to bound recomputes. */
export const quantize = (t: number, t0: number, t1: number, steps = 600) => (t >= t1 ? t1 : t0 + Math.floor(((t - t0) / Math.max(1, t1 - t0)) * steps) * (Math.max(1, t1 - t0) / steps));
/** Where the open-time catch-up starts: CATCHUP_MS before now, pulled back far enough to include the last CATCHUP_MIN_EVENTS
 * events and the moment `lockAt` (the latest lock moment, so the owner sees a padlock snap), never more than CATCHUP_MAX_MS
 * back and never before t0. Null when there is no history to catch up on. The catch-up always ends exactly on now. */
export function catchUpStart(events: readonly HistoryEvent[], now: number, t0: number, lockAt: number | null = null): number | null {
  const past = events.filter(e => e.at <= now).map(e => e.at).sort((a, b) => a - b);
  if (!past.length) return null;
  const nth = past[Math.max(0, past.length - CATCHUP_MIN_EVENTS)], lock = lockAt !== null && lockAt <= now ? lockAt - 60_000 : Infinity;
  return Math.max(t0, now - CATCHUP_MAX_MS, Math.min(now - CATCHUP_MS, nth - 60_000, lock));
}
/** The latest moment a new lock appeared in the last CATCHUP_MAX_MS, found by sampling the floor every `stepMs`; null when none.
 * Called once on open to feed catchUpStart (lead answer 1), so the catch-up shows a padlock snap. Pass the memoised graph. */
export function latestLockMoment(s: WorkSurfaceSnapshot, events: readonly HistoryEvent[], now: number, t0: number, stepMs = 5 * 60_000, opts: FloorOpts = {}): number | null {
  const from = Math.max(t0, now - CATCHUP_MAX_MS), times: number[] = [];
  for (let t = from; t < now; t += stepMs) times.push(t);
  times.push(now);
  let seen: Set<string> | null = null, last: number | null = null;
  for (const t of times) {
    const keys = new Set(floorAt(s, events, t, now, { ...opts, prev: null, heat: "age" }).locks.map(l => l.key));
    if (seen && [...keys].some(k => !seen!.has(k))) last = t;
    seen = keys;
  }
  return last;
}
/** Catch-up clock: the window [start, now] plays in CATCHUP_PLAY_MS of wall time, whatever its length. */
export const catchUpAdvance = (t: number, dtMs: number, start: number, now: number) => Math.min(now, t + ((now - start) * dtMs) / CATCHUP_PLAY_MS);

// ---- camera + interaction ---------------------------------------------------------------------------------------------
/** screen = world * k + (x, y), in floor units. k in [1, MAX_ZOOM]; the floor always covers the view. */
export type Camera = { x: number; y: number; k: number };
export const MAX_ZOOM = 3, HOME: Camera = { x: 0, y: 0, k: 1 };
export function clampCamera(c: Camera): Camera {
  const k = Math.min(MAX_ZOOM, Math.max(1, c.k));
  return { k, x: Math.min(0, Math.max(FLOOR.W - FLOOR.W * k, c.x)), y: Math.min(0, Math.max(FLOOR.H - FLOOR.H * k, c.y)) };
}
/** Zoom by `factor` keeping the floor point under (px, py) (view units) still. */
export function zoomAt(c: Camera, px: number, py: number, factor: number): Camera {
  const k = Math.min(MAX_ZOOM, Math.max(1, c.k * factor)), wx = (px - c.x) / c.k, wy = (py - c.y) / c.k;
  return clampCamera({ k, x: px - wx * k, y: py - wy * k });
}
export const panBy = (c: Camera, dx: number, dy: number): Camera => clampCamera({ ...c, x: c.x + dx, y: c.y + dy });
/** Camera centring floor point (x, y) at zoom k (clamped, so edges stay on screen). */
export const focusOn = (x: number, y: number, k = 1.8): Camera => clampCamera({ k, x: FLOOR.W / 2 - x * k, y: FLOOR.H / 2 - y * k });
export const lerpCamera = (a: Camera, b: Camera, k: number): Camera => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), k: lerp(a.k, b.k, k) });
/** F key: the next agent to follow after `current` (a worker key or bead id) — live first, then ghosts, then past; wraps. */
export function nextWorker(workers: readonly FloorWorker[], current: string | null): FloorWorker | null {
  const rank = { live: 0, ghost: 1, past: 2 } as const;
  const list = [...workers].sort((a, b) => rank[a.presence] - rank[b.presence] || a.x - b.x || a.y - b.y || cmp(a.key, b.key));
  if (!list.length) return null;
  const k = current === null ? -1 : list.findIndex(w => w.key === current || w.beadId === current);
  return list[(k + 1) % list.length];
}

/** Plain-English header, e.g. "3 ready for a worker · 2 being built · 1 at the gate · 7 landed in the last day". */
export function floorLine(f: FloorFrame): string {
  const by = (x: StationId) => f.stations.find(s => s.id === x)!;
  return `${by("intake").queue} ready for a worker · ${by("claim").count + by("build").count} being built · ${by("gate").count} at the gate · ${f.throughput.lastDay} landed in the last day`;
}
/** A card's id line, fitted to the card: "#osi.11.14" fits; longer ids keep the head and the tail ("#osi…4.2.1"). */
export function fitId(shortId: string, max = 10): string {
  // max <= 4 keeps a head only: slice(-0) is the WHOLE string, which once let micro cards print the full id
  return `#${shortId.length <= max ? shortId : max <= 4 ? `${shortId.slice(0, Math.max(1, max - 1))}…` : `${shortId.slice(0, 3)}…${shortId.slice(-(max - 4))}`}`;
}
/** A card's second line, fitted to the card (at most 12 characters): "2h26 $13.9", "18m $2.50", "3d4h". */
export function cardLine(ms: number | null, cost: number | null): string {
  const m = ms === null ? null : Math.floor(ms / 60_000);
  const el = m === null ? "–" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`;
  if (cost === null) return el;
  const c = cost < 10 ? cost.toFixed(2) : cost < 100 ? cost.toFixed(1) : String(Math.round(cost));
  return `${el} $${c}`;
}
/** Elapsed as "12m" / "3h 05m" / "2d 4h"; "–" when unknown. */
export function elapsedText(ms: number | null): string {
  if (ms === null) return "–";
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}
