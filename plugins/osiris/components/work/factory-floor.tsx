import { useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ptClass } from "../../work/priority-tone.ts";
import type { WorkSurfaceSnapshot } from "../../work/surface-types.ts";
import { formatAge, historyFromTimestamps, shortId } from "../../work/surface-model.ts";
import { stageLabel, stagesAt, timeRange, type Stage } from "../../work/replay.ts";
import { buildGraphModel } from "../../work/graph/graph.ts";
import { toBeadIssues } from "../../work/graph/adapter.ts";
import { type ChainEdge, allBlockEdges, chainBeads } from "../../work/block-chain.ts";
import { CHAIN_MS, EMPTY_JOURNAL, journal, litOf, momentsOf } from "../../work/factory-journal.ts";
import { LOG_MAX, type SceneEdge, hoverCardOf, hoverChainOf, sceneOf, withFx } from "../../work/factory-scene.ts";
import { LAND_VISIBLE_MAX, landCounts, prune, vaultOf } from "../../work/land-prune.ts";
import { viewPoint, viewScale } from "../../work/view-math.ts";
import { epicChip, FLOOR, HEAT_MODES, HEAT_TEXT, HOME, REWORK_ARC, RET, STATIONS, heatLegend, type HeatScale, STATION_TEXT, CARD_SIZES, badgeY, lockDetail, catchUpAdvance, catchUpStart, cardLine, fitId, latestLockMoment, ease, elapsedText, floorAt, floorLine, twoLines, agentLane, agentKeyOf, focusOn, interpolate, lerpCamera, lockStats, lockText, closeTimes, groupKey, catchUpStep, wheelZooms, STEP_MS, nextWorker, panBy, quantize, replayAdvance, stationIndex, zoomAt, type Camera, type FloorToken, type FloorWorker, type HeatMode, type PoseToken, type ScopeWait, type Speed, type StationId, type WorkerBadge } from "../../work/factory-floor-model.ts";
import { lerpRects } from "../../work/silo-layout.ts";
import { stationStats } from "../../work/iso-layout.ts";
import { moveMs, staggerMs } from "../../work/iso-travel.ts";
import { TimeLensBar, timeLensBarStyles } from "./time-lens-bar.tsx";
import { IsoStage, isoStageStyles } from "./iso-stage.tsx";
import { FactoryTreeRail, factoryTreeRailStyles } from "./factory-tree-rail.tsx";
import { railRoles } from "../../work/factory-tree-rail-model.ts";
import { ART_TOP, FactoryFloorPlane, StationMachine, VaultMachine, factoryMachinesStyles } from "./factory-machines.tsx";
import { DEFAULT_FACTORY_LOOK, FACTORY_LOOKS, factoryLookStyles, type FactoryLook } from "../../work/factory-look.ts";
import { HATCH_STEPS, hatchInkVar, hatchOpacity, hatchPatternId, heatColorVar, heatFamilyCss, heatLegend as heatSwatches, heatTabVar } from "../../work/heat-ramps.ts";
import { FloorTimeline, Glyph, floorTimelineStyles } from "./floor-timeline.tsx";
import { isTyping } from "../../shell/keymap.ts";
import { KIND_STYLE, kindOf, type TimelineLine } from "../../work/floor-timeline-model.ts";
import { chordPending, escLayer } from "../../shell/factory-fullscreen.ts";
import { FactoryTipLayer, factoryTipStyles, tipProps } from "./factory-tip.tsx";
import { FactoryFullscreen, FULLSCREEN_CSS, FullscreenToggle, useFactoryFullscreen } from "./factory-fullscreen.tsx";
import { MODEL_TIERS, ROLE_WORDS, type Provider } from "../../work/model-tiers.ts";
import { STAT, STAT_CELLS, STAT_WRAP_PX, type StatCellId } from "../../work/stat-cells.ts";
import { CHECK_MARK, RULE_OF, beadChecklist, limitText, type EvidenceInfo } from "../../work/station-rules.ts";
import { capitalise, firstUse, termDef, termLabel } from "../../work/glossary.ts";

// Every Factory word for a Work-surface term comes from the ONE glossary (work/glossary.ts); never a second term list here.
const PANE = termLabel("pane"), GHOST = termLabel("ghost"), ITEM = termLabel("bead"), STALE = termLabel("stale");
import { hourlyLanded, shouldCatchUp, unseenCount } from "../../work/time-lens.ts";
import { BURST, SHELF, shelfLine } from "../../work/factory-fx.ts";

const EPIC_CHIPS = 4;
const isWorkStation = (s: StationId) => s === "claim" || s === "build" || s === "gate";
const BAY_MS = 720, SLIVER_PX = 100; // a bay narrower than this (in floor units) is a sliver: rotated label, count, no sub-line
const MOVE_MS = 520;
/** A stable id per object identity, so a data revision is a pure key: the same snapshot, leases, transcripts and costs are the same revision even if React renders twice. */
const revIds = new WeakMap<object, number>(); let revNext = 0;
const revId = (o: object | null | undefined) => (o ? revIds.get(o) ?? (revIds.set(o, ++revNext), revNext) : 0);
/** Keys the floor handles (and swallows) while it has focus. */
export const FACTORY_KEYS: ReadonlySet<string> = new Set([" ", "ArrowLeft", "ArrowRight", "f", "F", "h", "H", "+", "=", "-", "_", "0", "Escape", "?", "k", "K", "c", "C", "i", "I", "t", "T", "p", "P"]);
/** GRAND (fg-lead): the stage view and the tree rail, remembered per viewer (try/catch: storage can be absent). Full screen is never persisted. */
export type FactoryView = "floor" | "iso";
export const VIEW_KEY = "oi.factory.view", RAIL_KEY = "oi.factory.rail", LOOK_KEY = "oi.factory.look", SCENE_KEY = "oi.factory.scene";
/** The Floor's SCENE: Plain = clean silos (header + crates, nothing behind them); Animated = the machine art and its motion, dimmed BEHIND the crates. */
export type FactoryScene = "plain" | "animated";
export const readScene = (): FactoryScene => { try { return localStorage.getItem(SCENE_KEY) === "animated" ? "animated" : "plain"; } catch { return "plain"; } };
const readView = (): FactoryView => { try { return localStorage.getItem(VIEW_KEY) === "iso" ? "iso" : "floor"; } catch { return "floor"; } };
const readLook = (): FactoryLook => { try { const v = localStorage.getItem(LOOK_KEY); return v === "app" || v === "cyberpunk" ? v : DEFAULT_FACTORY_LOOK; } catch { return DEFAULT_FACTORY_LOOK; } };
const readRail = (): boolean => { try { return localStorage.getItem(RAIL_KEY) !== "closed"; } catch { return true; } };
const store = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable: the choice lasts this session */ } };
const STAGE_TONE: Record<Stage, string> = { waiting: "muted", ready: "info", building: "running", review: "attention", done: "success" };
const { W, H, TOKEN: T, BELT_Y, BELT_H } = FLOOR;
const reducedMotion = () => { try { return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
const hex = (r: number) => Array.from({ length: 6 }, (_, k) => { const a = Math.PI / 6 + (k * Math.PI) / 3; return `${(r * Math.cos(a)).toFixed(1)},${(r * Math.sin(a)).toFixed(1)}`; }).join(" ");
/** An ON THE FLOOR line with its bead id (#33) as a chip in the bead's workstream hue; the verb after it keeps its event-kind colour. */
const logText = (text: string, tone: number | undefined) => { const m = tone === undefined ? null : /#[\w.-]+/.exec(text); return m ? <>{text.slice(0, m.index)}<b className="oi-ff-logid">{m[0]}</b>{text.slice(m.index + m[0].length)}</> : text; };
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
type Mode = "live" | "catchup" | "playing" | "paused";
type Flight = { from: PoseToken | null; to: PoseToken; start: number; ms: number }; // start may be in the future (staggered)
const PRUNED_KEY = "oi.factory.prunedAt", PRUNE_MS = 1500;
const readPrunedAt = (): number | null => { try { const v = Number(localStorage.getItem(PRUNED_KEY)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; } };
const LIVEONLY_KEY = "oi.factory.liveonly", UNDO_MS = 10_000;
const readLiveOnly = (): boolean => { try { return localStorage.getItem(LIVEONLY_KEY) === "1"; } catch { return false; } };
const restorePrunedAt = (prev: number | null) => { try { if (prev === null) localStorage.removeItem(PRUNED_KEY); else localStorage.setItem(PRUNED_KEY, String(prev)); } catch { /* storage blocked: the undo lasts for this session */ } };
const writePrunedAt = (at: number) => { try { localStorage.setItem(PRUNED_KEY, String(at)); } catch { /* storage blocked: the prune lasts for this session */ } };
const SEEN_KEY = "osiris-factory-last-viewed", RIDE_MS = 1400;
/** Per-viewer convenience: when this viewer last looked at the Factory (drives the catch-up rule). Never throws. */
const readSeen = (): number | null => { try { const v = Number(localStorage.getItem(SEEN_KEY)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; } };
const writeSeen = (at: number) => { try { localStorage.setItem(SEEN_KEY, String(at)); } catch { /* storage blocked: the catch-up just plays again */ } };
type LogLine = TimelineLine;

/** Padlock drawn on a crate's top-right corner. `open` lifts the shackle (the unlock pop). */
/** Provider icons: ORIGINAL glyphs, not the providers' logos (Anthropic's and OpenAI's trademark guidelines require prior
 * permission for their marks; see YB-REPORT). anthropic = a six-ray asterisk, openai = code chevrons, other = a four-point
 * star, unknown = "?". */
/** A KPI number that rolls to its value: each digit is a column of 0-9 sliding by a CSS transition (instant under reduced motion). The visible text is the number, the columns are decoration. */
export function RollNum(q: { n: number; reduced?: boolean }) {
  const ds = String(Math.max(0, Math.floor(q.n))).split("").map(Number);
  return <span className="oi-ff-roll" role="text" aria-label={String(q.n)}>{ds.map((d, i) => <span key={`${ds.length}:${i}`} className="oi-ff-rolld" aria-hidden="true"><span className="oi-ff-rollc" style={{ transform: `translateY(${-d * 1.15}em)`, transition: q.reduced ? "none" : undefined }}>{Array.from({ length: 10 }, (_, k) => <span key={k}>{k}</span>)}</span></span>)}</span>;
}
export const ProviderGlyph = (q: { provider: Provider | null }) => q.provider === "anthropic" ? <path className="oi-ff-icon stroke" d="M0 -4.6V4.6M-4 -2.3L4 2.3M-4 2.3L4 -2.3" />
  : q.provider === "openai" ? <path className="oi-ff-icon stroke" d="M-1.6 -3.8L-4.4 0L-1.6 3.8M1.6 -3.8L4.4 0L1.6 3.8" />
  : q.provider === "other" ? <path className="oi-ff-icon fill" d="M0 -4.8L1.3 -1.3L4.8 0L1.3 1.3L0 4.8L-1.3 1.3L-4.8 0L-1.3 -1.3Z" />
  : <text className="oi-ff-glyph" y="3.5" textAnchor="middle">?</text>;
/** The tier topper: strong = a small crown on top, king = a cape behind (flutters while live, still under reduced motion). */
export const Crown = () => <path className="oi-ff-crown" d="M-5.5 -11.5L-5.5 -16.5L-2.7 -13.8L0 -18L2.7 -13.8L5.5 -16.5L5.5 -11.5Z" />;
export const Cape = (q: { flutter: boolean }) => <path className={`oi-ff-cape${q.flutter ? " flutter" : ""}`} d="M-7.5 -5Q-12.5 5 -10 13.5L0 10.5L10 13.5Q12.5 5 7.5 -5Z" />;
/** One agent mark, as approved in rounds 4-5: cape (king) behind, the role shape, the provider icon in the middle, crown (strong)
 * on top. Lead ruling on FAC-4 (additive, owner may override): the MODEL LETTER rides as a small monospace tag on the badge's
 * bottom-right corner (S Sonnet, H Haiku, O Opus, F Fable…), so Sonnet ≠ Haiku at a glance without redesigning the icon. */
export const AgentMark = (q: { badge: Pick<WorkerBadge, "shape" | "provider" | "tier" | "glyph">; flutter: boolean; size?: number }) => <>
  {q.badge.tier === "king" && <Cape flutter={q.flutter} />}
  {q.badge.shape === "hex" ? <polygon className="oi-ff-body" points={hex(q.size ?? 11)} /> : <circle className="oi-ff-body" r={(q.size ?? 11) - 1.5} />}
  <ProviderGlyph provider={q.badge.provider} />
  {q.badge.provider && <g className="oi-ff-lettertag" transform="translate(7.5 7.5)"><rect className="oi-ff-lettertagbg" x={q.badge.glyph.length > 1 ? -6 : -4.5} y="-4.5" width={q.badge.glyph.length > 1 ? 12 : 9} height="9" rx="2" /><text className="oi-ff-letter" y="2.6" textAnchor="middle">{q.badge.glyph}</text></g>}
  {q.badge.tier === "strong" && <Crown />}
</>;
const Padlock = (q: { open?: boolean; title?: string }) => <g className={`oi-ff-padlock${q.open ? " open" : ""}`} transform={`translate(${T - 6} -7)`}>{q.title && <title>{q.title}</title>}
  <path className="oi-ff-shackle" d="M-3.5 0 V-3 a3.5 3.5 0 0 1 7 0 V0" /><rect className="oi-ff-lockbody" x="-5" y="0" width="10" height="8" rx="1.5" /><circle className="oi-ff-keyhole" cx="0" cy="3.6" r="1.1" />
</g>;

/** Factory v2: bays on one belt, crates at Intake and Land, OCCUPIED CARDS at Claim, Build and Gate (the agent's badge sits in
 * its bead's card with "#id" and "elapsed · $cost"), the return conveyor under the belt (a sent-back card drops down the Gate
 * chute, rides back and climbs into Build), alive on open and interactive. When this viewer has not looked in 10 minutes a
 * 5 s catch-up of recent history (reaching back to the latest lock) plays and lands exactly on now; then LIVE: the belt
 * drifts, live agents pulse, cards in Build shimmer, the counter ticks. LOCKS are first-class: a padlock snaps shut on a
 * dependency-blocked crate, a scope-leased one or one held at the Gate, a chain runs to what holds it, and the log gets
 * "🔒 #12 locked by #07" (Gate holds as one "🔒 Gate holding N" line); on clear the padlock pops open ("🔓"). Hover for the
 * trail and blockers, click an agent to follow it, click a station to spotlight its queue, drag to pan, Ctrl/Cmd+wheel to zoom; keys:
 * space, ←/→, F, H, + − 0, Esc (swallowed while focused). The time bar is the shared TimeLensBar.
 * The view derives NO work state: everything comes from floorAt. React never owns a bead's or the camera's transform; one rAF
 * loop writes them. Reduced motion: state only (static padlocks and conveyor, no chains or travel, the log still fills). */
export function FactoryFloor(p: { snap: WorkSurfaceSnapshot; now: number; selectedId: string | null; onSelect(id: string): void; critical?: ReadonlySet<string> | null; costs?: ReadonlyMap<string, number> | null; thresholds?: Partial<Record<StationId, number>> | null; scopeWaits?: readonly ScopeWait[] | null ; evidence?: ReadonlyMap<string, EvidenceInfo> | null; transcriptLive?: ReadonlyMap<string, { lane: string; lastAt: number }> | null;
  /** The shell's one hover card: called with the hovered bead and the pointer, or null. Iso, the tree rail and the timeline call the same card. */
  onHover?(h: { id: string; x: number; y: number } | null): void;
  /** The chain in focus (hover, else the selected bead): each bead's role and the edges drawn, for the shell to hand to Iso and the tree rail. */
  onChain?(c: { focus: string | null; roles: ReadonlyMap<string, "focus" | "up" | "down" | "dim">; edges: readonly ChainEdge[] }): void;
  /** Clicking the Archived vault: the ids of every archived bead (the shell opens the Calendar / Archive view). */
  onOpenArchive?(ids: readonly string[]): void;
  /** The shell's pending Mod+K chord start (app.tsx `chord`), so a Z that completes "Mod+K Z" (Zen) never also toggles full screen. */
  chordAt?(): number | null;
  /** Slots of the Factory body, left to right: `rail` (a thin tree rail), the stage (this floor), `side` (selection panel). Empty slots take no width. */
  rail?: ReactNode; side?: ReactNode; time?: ReactNode;
}) {
  const { snap, now } = p;
  const [at, setAt] = useState<number | null>(null); // null = live (follows `now`)
  const [mode, setModeState] = useState<Mode>("live");
  const [speed, setSpeed] = useState<Speed>(4);
  const [reduced, setReduced] = useState(reducedMotion);
  const [heat, setHeat] = useState<HeatMode | null>(null);
  const [heatScale, setHeatScale] = useState<HeatScale>("absolute");
  const [seenAtOpen] = useState(readSeen), [caughtUp, setCaughtUp] = useState(false);
  const [follow, setFollow] = useState<string | null>(null);
  const [spot, setSpot] = useState<StationId | null>(null);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [stationTip, setStationTip] = useState<{ id: StationId; x: number; y: number } | null>(null);
  const lastBead = useRef<string | null>(null); // the bead the station popover checks when none is selected
  const [wall, setWall] = useState(() => Date.now());
  const uid = useId(); // ids for the visually-hidden sentences that aria-describedby points at (a title alone is not reachable by keyboard or touch)
  const [jr, dispatch] = useReducer(journal, EMPTY_JOURNAL); // the ONE temporal state (work/factory-journal.ts): live-observed locks, review, rework
  const [replayFx, setReplayFx] = useState<{ bursts: ReadonlyMap<string, number>; chains: ReadonlyMap<string, number> }>({ bursts: new Map(), chains: new Map() }); // presentation moments while scrubbing, wall-expiring
  const [view, setViewState] = useState<FactoryView>(readView), [railOpen, setRailState] = useState(readRail), fs = useFactoryFullscreen();
  const setView = (f: (v: FactoryView) => FactoryView) => setViewState(v => { const n = f(v); store(VIEW_KEY, n); return n; });
  const fullScale = fs.full && view === "floor"; // FULL SCREEN true scale: wide cards, every bead, no +N (the iso keeps its own scene)
  const [look, setLookState] = useState<FactoryLook>(readLook);
  const setLook = (l: FactoryLook) => { setLookState(l); store(LOOK_KEY, l); };
  const [sceneMode, setSceneState] = useState<FactoryScene>(readScene), animated = sceneMode === "animated";
  const setScene = (n: FactoryScene) => { setSceneState(n); store(SCENE_KEY, n); };
  const setRailOpen = (f: (v: boolean) => boolean) => setRailState(v => { const n = f(v); store(RAIL_KEY, n ? "open" : "closed"); return n; });
  // LAND prune (display only; no doc or tracker writes): the viewer's last Prune press is a per-user stamp.
  const [prunedAt, setPrunedAt] = useState<number | null>(readPrunedAt), [pruneAnim, setPruneAnim] = useState<{ ids: string[]; total: number; stay: number; start: number } | null>(null), [pruneK, setPruneK] = useState(0), [pruneNote, setPruneNote] = useState<string | null>(null);
  const [liveOnly, setLiveOnlyState] = useState(readLiveOnly), [wsFilter, setWsFilter] = useState<number | null>(null), [wsOpen, setWsOpen] = useState(false);
  const [pruneAsk, setPruneAsk] = useState<{ n: number } | null>(null), [undo, setUndo] = useState<{ prev: number | null } | null>(null); // Prune: confirm with the count, then 10 s to put the stamp back
  const setLiveOnly = (f: (v: boolean) => boolean) => setLiveOnlyState(v => { const n = f(v); store(LIVEONLY_KEY, n ? "1" : "0"); return n; });
  const [keyOpen, setKeyOpen] = useState(false), [chainsAll, setChainsAll] = useState(false); // Chains: every dependency chain at once, faint
  const svgRef = useRef<SVGSVGElement>(null), worldRef = useRef<SVGGElement>(null), rootRef = useRef<HTMLDivElement>(null);
  // Full screen: the overlay focuses its wrapper first (child effect); this parent effect then moves focus onto the Factory root, so the
  // very first Esc reaches the Factory's key handler (Codex R3 M7) instead of the host.
  useEffect(() => { if (fs.full) rootRef.current?.focus(); }, [fs.full]);
  const modeRef = useRef<Mode>("live"), atRef = useRef<number | null>(null), speedRef = useRef(speed), catchFrom = useRef(0), clockRaf = useRef(0);
  const prevRef = useRef<ReturnType<typeof floorAt> | null>(null), shown = useRef(new Map<string, PoseToken>()), flights = useRef(new Map<string, Flight>()), moveRaf = useRef(0);
  const cam = useRef<Camera>(HOME), camGoal = useRef<Camera | null>(null), camRaf = useRef(0), drag = useRef<{ x: number; y: number } | null>(null);
  const movingRef = useRef(false);
  speedRef.current = speed; atRef.current = at;

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const q = matchMedia("(prefers-reduced-motion: reduce)"), on = () => setReduced(q.matches);
    q.addEventListener?.("change", on); return () => q.removeEventListener?.("change", on);
  }, []);
  const events = useMemo(() => historyFromTimestamps(snap), [snap]);
  const graph = useMemo(() => buildGraphModel(toBeadIssues(snap)), [snap]);
  const closedIds = useMemo(() => new Set(graph.nodes.filter(n => n.status === "closed").map(n => n.id)), [graph]);
  const allEdges = useMemo(() => allBlockEdges(graph, id => closedIds.has(id)), [graph, closedIds]);
  const chainIds = useMemo(() => chainBeads(allEdges.filter(e => !closedIds.has(e.to))), [allEdges, closedIds]); // beads on a live chain: Intake draws them as cards
  const range = useMemo(() => timeRange(events, now), [events, now]);
  const rangeRef = useRef(range); rangeRef.current = range;
  const t = at === null ? now : Math.min(at, now), tq = quantize(t, range.t0, range.t1);
  // Landed beads at the shown time, newest first: the input of work/land-prune.ts (prune decides who stays on Land).
  const landedAll = useMemo(() => { const st = stagesAt(snap, events, tq, now), ct = closeTimes(events, tq); return [...st].filter(([, v]) => v === "done").map(([id]) => ({ id, at: ct.get(id) ?? 0 })).sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1)); }, [snap, events, tq, now]);
  const split = useMemo(() => prune(landedAll, tq, prunedAt), [landedAll, tq, prunedAt]); // the stamp stays while Prune animates: beads archived before are never restored mid-animation
  const prunedIds = useMemo(() => new Set(split.archived.map(x => x.id)), [split]);
  const archivedIds = useMemo(() => liveOnly ? new Set([...prunedIds, ...landedAll.map(x => x.id)]) : prunedIds, [liveOnly, landedAll, prunedIds]); // Live only: a display filter over every landed crate, never a Prune
  const sceneRef = useRef<ReturnType<typeof sceneOf> | null>(null);
  // What is lit now. The 250 ms tick only changes this set's CONTENT when something expires, so it is keyed by its ids: a tick that expires
  // nothing leaves it (and everything built from it) untouched.
  const wallNow = Date.now(), litNow = (() => { const j = litOf(jr, wallNow), b = new Set(j.bursts), c = new Set(j.chainsLit); for (const [id, u] of replayFx.bursts) if (u > wallNow) b.add(id); for (const [id, u] of replayFx.chains) if (u > wallNow) c.add(id); return { bursts: b, chainsLit: c }; })();
  const litKey = `${[...litNow.bursts].sort().join(",")}|${[...litNow.chainsLit].sort().join(",")}`;
  const fxLit = useMemo(() => litNow, [litKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // sceneOf runs on its FRAME inputs only (the journal's records, not its fx expiries; fx overlay afterwards), so a tick never recomputes floorAt.
  const sceneBase = useMemo(() => sceneOf({ snap, events, graph, t: tq, now, journal: jr,
    opts: { prev: prevRef.current, reducedMotion: reduced, silos: true, chainIds, archivedIds, heat: heat ?? "age", heatScale, thresholds: p.thresholds ?? null, critical: p.critical ?? null, costs: p.costs ?? null, scopeWaits: p.scopeWaits ?? null, transcriptLive: p.transcriptLive ?? null, full: fullScale },
    ui: { selectedId: p.selectedId, followId: follow, spot, chainsOn: chainsAll } }), [snap, events, graph, tq, now, jr.records, reduced, chainIds, archivedIds, heat, heatScale, p.thresholds, p.critical, p.costs, p.scopeWaits, p.transcriptLive, p.selectedId, follow, spot, chainsAll, fullScale]); // eslint-disable-line react-hooks/exhaustive-deps
  const scene = useMemo(() => withFx(sceneBase, fxLit), [sceneBase, fxLit]);
  const vault = useMemo(() => vaultOf(split.archived, scene.pinned), [split, scene.pinned]); // the beads actually archived: pinned ones bypass the archive and are drawn on Land
  const frame = scene.frame;
  useEffect(() => { prevRef.current = frame; }, [frame]);
  // Silos breathe: the frame carries each bay's TARGET rect (work/silo-layout.ts, from the station counts); the drawn bays ease
  // toward it over BAY_MS (the beads fly there on their own flights). Reduced motion snaps. JS-tweened, not a CSS transition, so
  // the SVG geometry animates in every engine; the HTML mockup uses the equivalent CSS flex-basis transition.
  const goalBays = frame.stations.map(s => ({ x: s.x, w: s.w })), goalKey = goalBays.map(b => `${b.x}:${b.w}`).join("|");
  const [bays, setBays] = useState(goalBays), baysRef = useRef(goalBays), bayRaf = useRef(0);
  useEffect(() => {
    cancelAnimationFrame(bayRaf.current);
    const from = baysRef.current;
    if (reduced || typeof requestAnimationFrame !== "function") { baysRef.current = goalBays; setBays(goalBays); return; }
    const t0 = performance.now(), step = (ts: number) => {
      const k = Math.min(1, (ts - t0) / BAY_MS), cur = k >= 1 ? goalBays : lerpRects(from, goalBays, ease(k));
      baysRef.current = cur; setBays(cur); if (k < 1) bayRaf.current = requestAnimationFrame(step);
    };
    bayRaf.current = requestAnimationFrame(step); return () => cancelAnimationFrame(bayRaf.current);
  }, [goalKey, reduced]); // eslint-disable-line react-hooks/exhaustive-deps
  // A silo's TOP (viewBox units, <= 0): normally the floor's shared lift; in full screen each silo's own, so a silo's height follows its own item count.
  const stTop = new Map<StationId, number>(); for (const k of frame.tokens) stTop.set(k.station, Math.min(stTop.get(k.station) ?? Infinity, k.y));
  const bt = (s: { id: StationId }) => (fullScale ? Math.min(0, (stTop.get(s.id) ?? 60) - 60) : -frame.lift);
  const bayStations = frame.stations.map((st, i) => ({ ...st, x: bays[i].x, w: bays[i].w, cx: bays[i].x + bays[i].w / 2 }));
  // The journal observes the LIVE frame once per data revision (whatever the shown time is); scrubbing never dispatches. A repeated
  // revision is a no-op in the reducer, so StrictMode's double effect is safe.
  const rev = useMemo(() => `${revId(snap)}:${revId(p.scopeWaits)}:${revId(p.transcriptLive)}:${revId(p.costs)}:${now}`, [snap, p.scopeWaits, p.transcriptLive, p.costs, now]);
  const liveFrame = useMemo(() => floorAt(snap, events, now, now, { reducedMotion: true, graph, thresholds: p.thresholds ?? null, critical: p.critical ?? null, costs: p.costs ?? null, scopeWaits: p.scopeWaits ?? null, transcriptLive: p.transcriptLive ?? null }), [snap, events, graph, now, p.thresholds, p.critical, p.costs, p.scopeWaits, p.transcriptLive]);
  useEffect(() => { dispatch({ type: "observe", rev, live: liveFrame, wall: Date.now(), reduced, t0: range.t0 }); }, [rev]); // eslint-disable-line react-hooks/exhaustive-deps
  // Replay moments (a burst as a crate lands while scrubbing) are presentation: held with a wall expiry, never logged or counted.
  useEffect(() => {
    const prevScene = sceneRef.current; sceneRef.current = scene;
    const m = momentsOf(prevScene, scene, { reduced, speed });
    if (!m.landed.length && !m.locked.length) return;
    const n = Date.now();
    setReplayFx(f => ({ bursts: new Map([...f.bursts, ...m.landed.map(id => [id, n + BURST.MS] as const)]), chains: new Map([...f.chains, ...m.locked.map(k => [k, n + CHAIN_MS] as const)]) }));
  }, [scene.frame]); // eslint-disable-line react-hooks/exhaustive-deps -- moments belong to a new FRAME; a fx overlay that merely expired is the same frame
  // One ≤4 Hz tick, only while something is lit: it expires fx and never adds.
  const lit = jr.fxUntil.size > 0 || replayFx.bursts.size > 0 || replayFx.chains.size > 0;
  useEffect(() => {
    if (!lit) return;
    const id = setInterval(() => { const n = Date.now(); dispatch({ type: "tick", wall: n }); setWall(n); setReplayFx(f => [...f.bursts.values(), ...f.chains.values()].some(u => u <= n) ? { bursts: new Map([...f.bursts].filter(([, u]) => u > n)), chains: new Map([...f.chains].filter(([, u]) => u > n)) } : f); }, 250);
    return () => clearInterval(id);
  }, [lit]);

  // ---- clock: catch-up → live, replay, pause ---------------------------------------------------------------------------
  const setMode = (m: Mode) => { modeRef.current = m; setModeState(m); };
  const goLive = () => { cancelAnimationFrame(clockRaf.current); setMode("live"); atRef.current = null; setAt(null); };
  const runClock = () => {
    cancelAnimationFrame(clockRaf.current); let last = 0, lastStep = 0;
    const tick = (ts: number) => {
      const m = modeRef.current; if (m !== "catchup" && m !== "playing") return;
      if (last) {
        const r = rangeRef.current, cur = atRef.current ?? r.t1, dt = Math.min(100, ts - last);
        if (m === "catchup" && reducedRef.current && ts - lastStep < STEP_MS) { clockRaf.current = requestAnimationFrame(tick); return; }
        if (m === "catchup" && reducedRef.current) lastStep = ts;
        const nt = m === "catchup" ? (reducedRef.current ? catchUpStep(stepTimes.current, cur, r.t1) : catchUpAdvance(cur, dt, catchFrom.current, r.t1)) : replayAdvance(cur, dt, r.t0, r.t1, speedRef.current);
        if (nt >= r.t1) { goLive(); return; }
        atRef.current = nt; setAt(nt);
      }
      last = ts; clockRaf.current = requestAnimationFrame(tick);
    };
    clockRaf.current = requestAnimationFrame(tick);
  };
  const play = () => { const r = rangeRef.current, a = atRef.current; atRef.current = a === null || a >= r.t1 ? r.t0 : a; setAt(atRef.current); setMode("playing"); runClock(); };
  const pause = () => { cancelAnimationFrame(clockRaf.current); const a = atRef.current, r = rangeRef.current; if (a === null || r.t1 - a <= (r.t1 - r.t0) / 120) goLive(); else setMode("paused"); };
  const scrubTo = (v: number) => { cancelAnimationFrame(clockRaf.current); const r = rangeRef.current; if (v >= r.t1) goLive(); else { setMode("paused"); atRef.current = Math.max(r.t0, v); setAt(atRef.current); } };
  const lockAt = useRef<number | null | undefined>(undefined), stepTimes = useRef<number[]>([]), reducedRef = useRef(reduced); reducedRef.current = reduced;
  const catchUp = () => { // an accelerated replay of recent history that lands exactly on now, reaching back to the latest lock
    if (lockAt.current === undefined) lockAt.current = latestLockMoment(snap, events, now, range.t0, 5 * 60_000, { graph, thresholds: p.thresholds ?? null, scopeWaits: null }); // once per open
    const start = catchUpStart(events, now, range.t0, lockAt.current);
    if (start === null || start >= now) return;
    stepTimes.current = [...new Set(events.filter(e => e.at > start && e.at <= now).map(e => e.at))].sort((a, b) => a - b);
    setCaughtUp(true); catchFrom.current = start; atRef.current = start; setAt(start); setMode("catchup"); runClock();
  };
  useEffect(() => { // alive on open: catch up only if this viewer has not looked in the last 10 minutes, else straight to live
    if (!reducedMotion() && shouldCatchUp(seenAtOpen, now)) catchUp();
    const seen = setInterval(() => { if (modeRef.current === "live") writeSeen(Date.now()); }, 30_000);
    return () => { clearInterval(seen); if (modeRef.current === "live") writeSeen(Date.now()); modeRef.current = "live"; cancelAnimationFrame(clockRaf.current); cancelAnimationFrame(moveRaf.current); cancelAnimationFrame(camRaf.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once per mount
  useEffect(() => { if (mode !== "live" || reduced) return; const id = setInterval(() => { setWall(Date.now()); }, 1000); return () => clearInterval(id); }, [mode, reduced]);

  // ---- motion: crates (transform + opacity only) -------------------------------------------------------------------------
  useLayoutEffect(() => {
    const svg = svgRef.current; if (!svg) return;
    const els = new Map<string, SVGGElement>();
    svg.querySelectorAll<SVGGElement>("[data-tid]").forEach(el => els.set(el.dataset.tid!, el));
    const put = (k: PoseToken) => { const el = els.get(k.id); if (!el) return; el.setAttribute("transform", `translate(${k.x.toFixed(1)} ${k.y.toFixed(1)})${k.scale === 1 ? "" : ` scale(${k.scale.toFixed(3)})`}`); el.style.opacity = k.opacity >= 1 ? "" : k.opacity.toFixed(3); };
    const ride = (id: string, on: boolean) => els.get(id)?.classList.toggle("riding", on);
    const live = new Set(frame.tokens.map(k => k.id));
    for (const id of [...shown.current.keys()]) if (!live.has(id)) { shown.current.delete(id); flights.current.delete(id); }
    const start = typeof performance === "object" ? performance.now() : Date.now();
    const travelOpts = { reduced, live: frame.live, playing: movingRef.current, speed: speedRef.current }, instantMove = moveMs(MOVE_MS, travelOpts) === 0; let rank = 0; // live: 520 ms; playback: divided by the speed (floor 120 ms), staggered; scrub / pause: 0
    for (const k of frame.tokens) {
      const to: PoseToken = { id: k.id, x: k.x, y: k.y, opacity: 1, arc: k.motion === "reopened" || k.motion === "back" ? REWORK_ARC : 0, ret: k.motion === "rework", scale: 1 };
      if (reduced || instantMove) { shown.current.set(k.id, to); put(to); flights.current.delete(k.id); continue; } // reduced motion, a scrub, a jump or a pause: no tween
      const cur = shown.current.get(k.id) ?? null, fl = flights.current.get(k.id);
      if (fl ? fl.to.x === to.x && fl.to.y === to.y : cur !== null && cur.x === to.x && cur.y === to.y && cur.opacity === 1) { if (cur) put(cur); continue; }
      flights.current.set(k.id, { from: cur, to, start: start + staggerMs(rank++, travelOpts), ms: moveMs(to.ret ? RIDE_MS : MOVE_MS, travelOpts) }); if (to.ret && cur) ride(k.id, true);
      put(interpolate(cur ? { tokens: [cur] } : { tokens: [] }, { tokens: [to] }, 0).tokens[0]);
    }
    if (reduced) { flights.current.clear(); return; }
    cancelAnimationFrame(moveRaf.current);
    const step = (ts: number) => {
      for (const [id, fl] of flights.current) {
        const k = Math.max(0, Math.min(1, (ts - fl.start) / fl.ms)), pose = interpolate(fl.from ? { tokens: [fl.from] } : { tokens: [] }, { tokens: [fl.to] }, fl.to.ret ? k : ease(k)).tokens[0];
        shown.current.set(id, pose); put(pose);
        if (k >= 1) { flights.current.delete(id); if (fl.to.ret) ride(id, false); }
      }
      if (flights.current.size) moveRaf.current = requestAnimationFrame(step);
    };
    if (flights.current.size) moveRaf.current = requestAnimationFrame(step);
  }, [frame, reduced]);
  useEffect(() => { if (mode === "paused") cancelAnimationFrame(moveRaf.current); }, [mode]); // pause freezes the crates where they are, mid-travel

  // ---- camera: pan, zoom, follow ----------------------------------------------------------------------------------------
  const applyCam = () => { worldRef.current?.setAttribute("transform", `translate(${cam.current.x.toFixed(1)} ${cam.current.y.toFixed(1)}) scale(${cam.current.k.toFixed(3)})`); };
  const moveCam = (goal: Camera) => {
    if (reduced) { cam.current = goal; camGoal.current = null; applyCam(); return; }
    camGoal.current = goal; cancelAnimationFrame(camRaf.current);
    const step = () => {
      const g = camGoal.current; if (!g) return;
      cam.current = lerpCamera(cam.current, g, 0.16); applyCam();
      if (Math.abs(cam.current.x - g.x) + Math.abs(cam.current.y - g.y) + Math.abs(cam.current.k - g.k) * 100 > 0.6) camRaf.current = requestAnimationFrame(step);
      else { cam.current = g; applyCam(); camGoal.current = null; }
    };
    camRaf.current = requestAnimationFrame(step);
  };
  const { tokenAt, workerOf, lockByKey, liveAt, spotList } = scene;
  const stationOf = (id: string): StationId | null => tokenAt.get(id)?.station ?? null;
  const followed = follow ? tokenAt.get(follow) ?? null : null;
  useEffect(() => { if (followed) moveCam(focusOn(followed.x + followed.w / 2, followed.y + followed.h / 2, Math.max(cam.current.k, 1.9))); }, [followed?.x, followed?.y]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (follow && !followed) setFollow(null); }, [follow, followed]);
  // Client pixels -> the SVG's own user space (the viewBox, whose top is -frame.lift). getScreenCTM().inverse() honours the `meet`
  // letterbox and the stretched viewBox; viewPoint is the same maths for a host without it.
  const toFloor = (cx: number, cy: number) => {
    const svg = svgRef.current; if (!svg) return { x: W / 2, y: H / 2 };
    const ctm = svg.getScreenCTM?.();
    if (ctm && svg.createSVGPoint) { const pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy; const q = pt.matrixTransform(ctm.inverse()); return { x: q.x, y: q.y }; }
    const r = svg.getBoundingClientRect(); return r.width ? viewPoint(r, { x: 0, y: -frame.lift, w: W, h: H + frame.lift }, cx, cy) : { x: W / 2, y: H / 2 };
  };
  useEffect(() => {
    const svg = svgRef.current; if (!svg) return;
    const onWheel = (e: WheelEvent) => { if (!wheelZooms(e)) return; e.preventDefault(); const q = toFloor(e.clientX, e.clientY); camGoal.current = null; cam.current = zoomAt(cam.current, q.x, q.y, e.deltaY < 0 ? 1.12 : 1 / 1.12); applyCam(); };
    svg.addEventListener("wheel", onWheel, { passive: false }); return () => svg.removeEventListener("wheel", onWheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(applyCam);
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => { if ((e.target as Element).closest?.("[data-tid],[data-station],[data-worker]")) return; drag.current = { x: e.clientX, y: e.clientY }; };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (d) { const r = svgRef.current!.getBoundingClientRect(), s = 1 / (viewScale(r, { x: 0, y: -frame.lift, w: W, h: H + frame.lift }) || 1), dx = (e.clientX - d.x) * s, dy = (e.clientY - d.y) * s; if (Math.abs(dx) + Math.abs(dy) > 2) { d.x = e.clientX; d.y = e.clientY; setFollow(null); camGoal.current = null; cam.current = panBy(cam.current, dx, dy); applyCam(); } return; }
    const el = (e.target as Element).closest?.("[data-tid]") as SVGGElement | null, id = el?.dataset.tid ?? null;
    if (id) lastBead.current = id;
    setHover(h => (id === null ? null : h?.id === id && Math.abs(h.x - e.clientX) + Math.abs(h.y - e.clientY) < 6 ? h : { id, x: e.clientX, y: e.clientY }));
  };
  const zoomBy = (f: number) => { setFollow(null); moveCam(zoomAt(camGoal.current ?? cam.current, W / 2, H / 2, f)); };
  const home = () => { setFollow(null); moveCam(HOME); };
  /** Prune: the older landed beads arc into the vault, the counter ticks, then the stamp lands. Reduced motion is instant plus one line. */
  const pruneNow = () => { // asks first: the count is on the button
    if (pruneAnim) return;
    const fresh = prune(landedAll, tq, tq).archived.filter(x => !prunedIds.has(x.id));
    if (fresh.length === 0) { setPruneNote("nothing older to archive"); return; }
    setPruneAsk({ n: fresh.length });
  };
  const runPrune = () => {
    setPruneAsk(null);
    const plan = prune(landedAll, tq, tq), summary = (n: number) => `archived ${n} · today ${plan.stay.filter(x => x.at >= new Date(tq).setHours(0, 0, 0, 0)).length} stay`;
    const stamp = Math.max(tq, prunedAt ?? 0), done = () => { setUndo({ prev: prunedAt }); writePrunedAt(stamp); setPrunedAt(stamp); }; // never LOWER the stamp: pruning while scrubbed into the past must not un-archive
    const fresh = plan.archived.filter(x => !prunedIds.has(x.id));
    if (fresh.length === 0) { setPruneNote("nothing older to archive"); return; }
    if (reduced) { done(); setPruneNote(summary(plan.archived.length)); return; }
    setPruneAnim({ ids: fresh.map(x => x.id), total: fresh.length, stay: plan.stay.length, start: performance.now() }); setPruneK(0);
  };
  const undoPrune = () => { if (!undo) return; restorePrunedAt(undo.prev); setPrunedAt(undo.prev); setPruneNote("prune undone"); setUndo(null); };
  useEffect(() => { if (!undo) return; const id = setTimeout(() => setUndo(null), UNDO_MS); return () => clearTimeout(id); }, [undo]);
  useEffect(() => {
    if (!pruneAnim) return;
    let raf = 0; const step = (ts: number) => { const k = Math.min(1, (ts - pruneAnim.start) / PRUNE_MS); setPruneK(k); if (k < 1) raf = requestAnimationFrame(step); else { const stamp = Math.max(tq, prunedAt ?? 0); setUndo({ prev: prunedAt }); writePrunedAt(stamp); setPrunedAt(stamp); setPruneNote(`archived ${pruneAnim.total} · today ${landCounts(landedAll, 0, tq).today} stay`); setPruneAnim(null); } };
    raf = requestAnimationFrame(step); return () => cancelAnimationFrame(raf);
  }, [pruneAnim]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!pruneNote) return; const id = setTimeout(() => setPruneNote(null), 4000); return () => clearTimeout(id); }, [pruneNote]);
  const followNext = () => { const w = nextWorker(frame.workers, follow); if (w) setFollow(w.beadId); };
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (chordPending(p.chordAt?.() ?? null, Date.now())) return; // a Mod+K chord is pending: EVERY key (not only Z) belongs to the host until it resolves
    if (e.defaultPrevented || isTyping(e.target as HTMLElement) || e.metaKey || e.ctrlKey || e.altKey) return; // a child (the tree rail's BeadTree) already handled it
    // ONE Esc dispatcher: escLayer (shell/factory-fullscreen.ts) names the topmost open layer; null = nothing open, so Esc belongs to the host (R3 M5).
    const esc = e.key === "Escape" ? escLayer({ keyOpen, hover: !!hover, spot: !!spot, follow: !!follow, full: fs.full }) : null;
    if (e.key === "Escape" && esc === null) return;
    const r = rangeRef.current, step = ((r.t1 - r.t0) / 50) * (e.shiftKey ? 5 : 1), k = e.key;
    if (FACTORY_KEYS.has(k)) e.stopPropagation(); // the floor owns these keys while focused: a global shell keymap must not double-fire
    if (k === " ") { e.preventDefault(); modeRef.current === "playing" || modeRef.current === "catchup" ? pause() : play(); }
    else if (k === "ArrowLeft" || k === "ArrowRight") { e.preventDefault(); scrubTo((atRef.current ?? r.t1) + (k === "ArrowLeft" ? -step : step)); }
    else if (k === "f" || k === "F") { e.preventDefault(); followNext(); }
    else if (k === "h" || k === "H") { e.preventDefault(); setHeat(h => (h === null ? HEAT_MODES[0] : HEAT_MODES.indexOf(h) === HEAT_MODES.length - 1 ? null : HEAT_MODES[HEAT_MODES.indexOf(h) + 1])); }
    else if (k === "+" || k === "=") zoomBy(1.25); else if (k === "-" || k === "_") zoomBy(0.8); else if (k === "0") home();
    else if (k === "p" || k === "P") { e.preventDefault(); pruneNow(); }
    else if (k === "c" || k === "C") { e.preventDefault(); setChainsAll(o => !o); }
    else if (k === "?" || k === "k" || k === "K") { e.preventDefault(); setKeyOpen(o => !o); }
    else if (k === "i" || k === "I") { e.preventDefault(); setView(v => (v === "iso" ? "floor" : "iso")); }
    else if (k === "t" || k === "T") { e.preventDefault(); setRailOpen(o => !o); }
    else if (fs.handleKey(e.nativeEvent, { chordPendingAt: p.chordAt?.() ?? null, now: Date.now() })) e.preventDefault(); // Z: full screen (the hook has no window listener)
    else if (k === "Escape") { e.preventDefault(); if (esc === "key") setKeyOpen(false); else if (esc === "hover") setHover(null); else if (esc === "spot") setSpot(null); else if (esc === "follow") home(); else fs.exit(); } // ONE layer per Esc, topmost first (Key, pinned hover, spotlight, follow, full screen)
  };

  // ---- presentation only ------------------------------------------------------------------------------------------------
  const hoverCard = useMemo(() => (hover ? hoverCardOf(scene, snap, events, hover.id, tq, now) : null), [scene, hover?.id, snap, events, tq, now]); // eslint-disable-line react-hooks/exhaustive-deps -- the hover selector: memoised on (scene, id), never a scene input
  const hovered = hoverCard?.token ?? null;
  const unseen = useMemo(() => unseenCount(events, seenAtOpen, now), [events, seenAtOpen, now]);
  const trail = hoverCard?.trail ?? [];
  const focusLock = hovered?.lock ?? (p.selectedId ? tokenAt.get(p.selectedId)?.lock : null) ?? (followed?.lock ?? null);
  const chainKeys = reduced ? [] : [...new Set([...scene.fx.chainsLit, ...(focusLock ? [focusLock] : [])])].filter(k => lockByKey.has(k));
  const ringed = hoverCard?.ringed ?? new Set<string>();
  const exits = frame.tweens.filter(w => w.kind === "exit");
  const moving = !reduced && (mode === "playing" || mode === "catchup");
  movingRef.current = moving;
  const busy = frame.stations.some(s => (s.id === "claim" || s.id === "build" || s.id === "gate") && s.count > 0);
  const viaTranscript = frame.workers.filter(w => w.via === "transcript").length;
  const liveN = frame.workers.filter(w => w.presence === "live").length, ghosts = frame.workers.filter(w => w.presence === "ghost").length;
  const spentTotal = frame.costWired ? frame.workers.reduce((a, w) => a + (w.cost ?? 0), 0) : 0;
  const spark = useMemo(() => hourlyLanded(events, tq), [events, tq]), sparkMax = Math.max(3, ...spark);
  /** One stat cell's value and sub-line. Sub-lines use .oi-ff-note (never a bare span rule, which once shrank "4 · 2"). */
  const cellBody = (id: StatCellId) => id === "mode" ? <b className={`oi-ff-mode ${mode}`}>{mode === "catchup" ? "catching up…" : mode === "live" ? "● live" : mode === "playing" ? "▶ replay" : "❚❚ paused"}</b>
    : id === "landed" ? <><b className="oi-ff-t-success"><RollNum n={landedToday} reduced={reduced} /><i className="oi-ff-unit"> today</i></b>
      <svg className="oi-ff-spark" viewBox={`0 0 ${STAT.SPARK_MAX} 22`} preserveAspectRatio="none" aria-hidden="true">{spark.map((v, i) => <rect key={i} className="oi-ff-sparkbar" x={i * 15} y={22 - (v / sparkMax) * 20} width="11" height={Math.max(1, (v / sparkMax) * 20)} rx="1.5" />)}</svg><em className="oi-ff-note" title={`${frame.throughput.lastDay} landed in the last 24 hours`}>24 h: {frame.throughput.lastDay}</em></>
    : id === "ready" ? <b><RollNum n={frame.stations[0].queue} reduced={reduced} /></b>
    : id === "build" ? <b className="oi-ff-t-running"><RollNum n={frame.stations[1].count + frame.stations[2].count} reduced={reduced} /></b>
    : id === "review" ? <b className="oi-ff-t-attention"><RollNum n={frame.stations[3].count} reduced={reduced} /></b>
    : id === "wip" ? <b><RollNum n={frame.stations[1].count + frame.stations[2].count + frame.stations[3].count} reduced={reduced} /></b>
    : id === "perHour" ? <b><RollNum n={frame.throughput.perHour} reduced={reduced} /></b>
    : id === "spent" ? (frame.costWired ? <b>{`$${spentTotal < 100 ? spentTotal.toFixed(1) : Math.round(spentTotal)}`}</b> : null)
    : id === "agents" ? <><b><RollNum n={liveN} reduced={reduced} /></b>{(viaTranscript > 0 || ghosts > 0) && <em className="oi-ff-note">{viaTranscript > 0 && <span className="oi-ff-t-running" title={`${viaTranscript} working with no ${PANE}: their transcript was written in the last 5 min`}>{viaTranscript} by transcript</span>}{viaTranscript > 0 && ghosts > 0 && " · "}{ghosts > 0 && <span className="oi-ff-t-attention" title={`${termDef("ghost")} (No transcript in the last 5 min either.)`}>{ghosts} {GHOST}{ghosts === 1 ? "" : "s"}</span>}</em>}</>
    : id === "sentBack" ? <><b className="oi-ff-t-attention"><RollNum n={sentBack} reduced={reduced} /></b><em className="oi-ff-note oi-ff-t-attention" title={`${frame.inRework} came back from review and are being fixed now${jams.length ? ` · queue building at ${jams.map(x => x.label).join(", ")}` : ""}`}>{frame.inRework} being fixed now{jams.length > 0 && <span className="oi-ff-t-failure"> · jam</span>}</em></>
    : <><b className={ls.active ? "oi-ff-t-failure" : undefined}><RollNum n={ls.active} reduced={reduced} /></b>{ls.oldestMs !== null && <em className="oi-ff-note" title={`oldest lock ${elapsedText(ls.oldestMs)}`}>oldest {elapsedText(ls.oldestMs)}</em>}</>;
  const { landedToday, sentBack } = scene.stats, { sparks, shelf, weather, unlocking, fresh } = scene.fx, log = scene.timeline;
  const rework = frame.tokens.filter(k => k.motion === "rework").length, jams = frame.stations.filter(s => s.bottleneck), ls = lockStats(frame.locks);
  const heatChips = (m: HeatMode) => heatSwatches(m).map(s => <i key={s.step} className="oi-ff-heatchip" style={{ background: `var(${s.colorVar})`, color: `var(${s.textVar})` }} title={s.label}>{s.label}</i>); // ONE swatch table feeds the Key and the corner legend
  const empty = frame.stations.every(s => s.count === 0), heatOn = heat !== null;
  const skew = frame.live && !reduced ? Math.max(0, wall - now) : 0;
  const fw: FloorWorker | null = follow ? frame.workers.find(w => w.beadId === follow) ?? null : null;
  const agentNote = fw ? ((fw.via === "transcript" ? `No ${PANE} · transcript live${fw.transcriptAt === null ? "" : ` (last write ${elapsedText(Math.max(0, now - fw.transcriptAt))} ago)`}` : fw.presence === "live" ? undefined : fw.presence === "ghost" ? `${capitalise(GHOST)}: ${termDef("ghost")}` : `${capitalise(PANE)}: not recorded in history (only known live)`) ?? "") : ""; // the Following agent line's full sentence: a title and a hidden describedby target
  const trailPts = trail.map(s => ({ ...s, x: bayStations[stationIndex(s.station)].cx }));
  const tokenClass = (k: FloorToken) => ["oi-ff-tok", k.shape, `oi-ln-${k.group}`, `oi-st-${STAGE_TONE[k.stage]}`, k.blocked && "blocked", k.lock && "locked", k.hot && "hot", k.critical && "crit", ptClass(k), k.motion === "rework" && "rework", k.motion === "forward" && "fresh", p.selectedId === k.id && "sel", follow === k.id && "followed", ringed.has(k.id) && "blocker", hovered?.id === k.id && "hov", ((spot && k.station !== spot) || roles.get(k.id) === "dim" || (wsFilter !== null && k.group !== wsFilter)) && "dim", pruneAnim?.ids.includes(k.id) && "lifted", roles.get(k.id) === "up" && "dep-up", roles.get(k.id) === "down" && "dep-down", roles.get(k.id) === "focus" && "dep-focus", heatOn && (k.heatStep === null ? "heat-none" : `heat-${k.heatStep}`)].filter(Boolean).join(" ");
  const chainEnd = (id: string) => { const k = tokenAt.get(id); return k ? { x: k.x + k.w / 2, y: k.y + k.h / 2 } : null; };
  const fu = firstUse(); // the legend's first mention of each glossary term carries its definition
  const keyItems: readonly [ReactNode, string, string][] = [
    [<svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true"><ProviderGlyph provider="anthropic" /></svg>, "Anthropic", "The icon in an agent badge is its provider."],
    [<svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true"><ProviderGlyph provider="openai" /></svg>, "OpenAI", "The icon in an agent badge is its provider."],
    [<svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true"><ProviderGlyph provider={null} /></svg>, "unknown", `The ${ITEM} has no model: label, so the model is never guessed.`],
    [<svg width="20" height="22" viewBox="-10 -19 20 22" aria-hidden="true"><Crown /></svg>, "strong model", "Opus or Sol: a crown on the badge."],
    [<svg width="26" height="26" viewBox="-13 -8 26 23" aria-hidden="true"><Cape flutter={false} /></svg>, "top model", "Fable or Astra: a cape behind the badge."],
    ["S H O F", "model letter", `The small letter on a badge corner is its model: ${MODEL_TIERS.map(r => `${r.letter} ${r.label}`).join(", ")}. ? = unknown.`],
    [<svg width="14" height="14" aria-hidden="true"><polygon className="oi-ff-key" points={hex(6)} transform="translate(7 7)" /></svg>, ROLE_WORDS.lead, "A hexagon badge is a lead."],
    [<svg width="14" height="14" aria-hidden="true"><circle className="oi-ff-key" cx="7" cy="7" r="5.5" /></svg>, ROLE_WORDS.worker, "A round badge is a worker."],
    ["◉", "pulse = working", `The agent's ${PANE} is open and it is working. ${termDef("pane")}`],
    ["≋", "transcript live", `Working with no ${PANE}: its transcript was written in the last 5 minutes.`],
    ["◌", GHOST.toLowerCase(), termDef("ghost")],
    [<abbr title={termDef("stale")}>…</abbr>, STALE.toLowerCase(), `No sign of life for a while. ${termDef("stale")}`],
    ["⊘", "waits", `Striped with ⊘: waits on another ${ITEM}. ↓N is how many it holds up.`],
    ["🔒", "locked", `Waits on another ${ITEM}, on files another holds, or for a free reviewer (hover the padlock).`],
    ["↩", "sent back", `${termDef("rework")} It rides the return conveyor under the belt back to Claim or Build.`],
    ["↺", "reopened", "An arc over the belt: reopened after Land, counts as new work."],
    ["✦", "spark = active", "A spark by an agent: its transcript was written lately (faster = more recent; still after 3 minutes with no write)."],
    ["◎", "ring = landed", `A ring burst: a ${ITEM} just landed. SHIPPED TODAY in the Land bay lists today's landings.`],
    ["◯", "ring = critical", frame.criticalWired ? "A ring on a card: it is on the critical path." : "Critical path: not connected yet."],
    [<svg width="28" height="8" aria-hidden="true"><line className="oi-ff-chain gate" x1="2" y1="4" x2="26" y2="4" /></svg>, "gate hold", "Dotted line at the Gate: waiting for a free reviewer (a review-capacity hold, not a dependency)."],
    ["▬", "Claim", `Live: claimed, but no agent is working yet (no ${PANE}, no recent transcript). Replay: picked up in the last 15 minutes.`],
    ["→ ⇢", "arrows", "Solid arrows = what it waits on; dashed = what waits on it; the rest dims."],
    ...(frame.costWired ? [] : [["$", "cost: off", "Cost per agent is not connected."] as [ReactNode, string, string]]),
  ];
  const stats = useMemo(() => stationStats(frame), [frame]); // the iso header numbers: "N wait · M active", "p50 .. · oldest .."
  const landHead = (() => { const c = landCounts(landedAll, vault.length, tq); return `today ${c.today} · week ${c.week} · archived ${c.archived}`; })();
  const groups = groupKey(frame), groupOf = new Map(groups.map(g => [g.tone, g.label]));
  // One colour per AGENT everywhere (crate chip, ON THE FLOOR rows): a hash of the agent identity onto the lane tokens.
  const agentVar = useMemo(() => { const who = new Map(snap.issues.map(i => [i.id, i.assignee])), pane = new Map(frame.workers.map(w => [w.beadId, w.pane])); return (id: string) => ({ ["--agent" as string]: `var(--oi-lane-${agentLane(agentKeyOf(who.get(id), pane.get(id), id))})` }) as CSSProperties; }, [snap.issues, frame.workers]);
  const groupByBead = useMemo(() => { const m = new Map<string, number>(); for (const r of frame.factory.rows) for (const cs of frame.factory.cells.get(r.key)?.values() ?? []) for (const c of cs) m.set(c.id, r.toneIndex); for (const [id, g] of frame.factory.hiddenTone) m.set(id, g); for (const k of frame.tokens) m.set(k.id, k.group); return m; }, [frame]); // one workstream hue per bead, the same index the crates carry
  // who waits for what: the hovered (else selected) bead's whole `blocks` chain, across stations, with direction
  const whereOf = (id: string): StationId | null => tokenAt.get(id)?.station ?? null;
  const isDoneNow = scene.isDone;
  const focusId = hovered?.id ?? (p.selectedId && tokenAt.has(p.selectedId) ? p.selectedId : null);
  const hoverChain = useMemo(() => (hovered ? hoverChainOf(scene, graph, hovered.id, p.critical) : null), [scene, graph, hovered?.id, p.critical]); // eslint-disable-line react-hooks/exhaustive-deps
  const chain = hoverChain ? hoverChain.chain : scene.chains.focus; // hover wins over the selection, as before
  const roles = hoverChain ? hoverChain.roles : scene.chains.roles;
  // The rail tints EVERY tree bead in the chain, not only those drawn on the floor (beads past a cap have no token; rail LOW-2).
  // Iso under Chains: with no focus every edge is the main layer (solid blocker -> blocked); with a focus the focus chain is the main layer and
  // every other chain stays visible, faint, underneath (Codex R5 m3: Iso used to drop the unrelated chains).
  const isoAllEdges = useMemo(() => allEdges.filter(e => tokenAt.has(e.from) && tokenAt.has(e.to)).map(e => ({ ...e, side: "up" as const })), [allEdges, tokenAt]);
  const railTint = useMemo(() => railRoles(chain, snap.issues.map(i => i.id), focusId), [chain, snap, focusId]);
  const onHoverRef = useRef(p.onHover), onChainRef = useRef(p.onChain); onHoverRef.current = p.onHover; onChainRef.current = p.onChain;
  useEffect(() => { onHoverRef.current?.(hover ? { id: hover.id, x: hover.x, y: hover.y } : null); }, [hover?.id, hover?.x, hover?.y]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onChainRef.current?.({ focus: focusId, roles, edges: chain?.edges ?? [] }); }, [focusId, chain]); // eslint-disable-line react-hooks/exhaustive-deps
  const depEdges = (hoverChain ? hoverChain.edges : scene.chains.focusEdges) as readonly (SceneEdge & { side: "up" | "down" })[]; // a focus chain always has a side
  const depPath = (from: FloorToken, to: FloorToken) => { // blocker → blocked, ending on the blocked box's edge; bows clear of a stack
    const a = { x: from.x + from.w / 2, y: from.y + from.h / 2 }, c = { x: to.x + to.w / 2, y: to.y + to.h / 2 }, dx = c.x - a.x, dy = c.y - a.y;
    const k = Math.min(Math.abs(dx) > 0 ? to.w / 2 / Math.abs(dx) : Infinity, Math.abs(dy) > 0 ? to.h / 2 / Math.abs(dy) : Infinity, 1), b = { x: c.x - dx * k, y: c.y - dy * k };
    const sameBay = Math.abs(dx) < Math.max(...frame.stations.map(b => b.w)) / 2, m = sameBay ? { x: Math.min(a.x, c.x) - 34 - Math.abs(dy) * 0.15, y: (a.y + c.y) / 2 } : { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 26 - Math.abs(dx) * 0.12 };
    return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${m.x.toFixed(1)} ${m.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  };
  const selIssue = scene.selected?.issue ?? null, selDeps = scene.selected?.deps ?? null, selChain = scene.selected?.chain ?? null;
  const titleOf = (id: string) => snap.issues.find(i => i.id === id)?.title ?? "";
  const placeText = (id: string) => { const x = whereOf(id); return isDoneNow(id) ? "landed ✓" : x === null ? "not on the floor" : `at ${STATION_TEXT[x].label}`; };

  return <FactoryFullscreen full={fs.full} onExit={fs.exit}><div ref={rootRef} className={`oi-ff${fs.full ? " full" : ""} oi-ff-scene-${sceneMode}`} data-oi-factory-look={look} data-scene={sceneMode} data-heat={heat ?? "off"} data-view={view} tabIndex={0} onKeyDown={onKey} aria-label="Factory floor. Space play or pause, arrows scrub, F follow next agent, H heat, plus and minus zoom, I floor or isometric, T tree rail, Z full screen, Escape clear.">
    <TimeLensBar events={events} t={t} now={now} t0={range.t0} playing={mode === "playing" || mode === "catchup"} speed={speed} onSpeed={setSpeed}
      onScrub={scrubTo} onPlay={on => (on ? play() : pause())} jump
      heat={heat} heatModes={HEAT_MODES.map(m => ({ id: m, label: m === "impact" ? "Blocking" : m[0].toUpperCase() + m.slice(1), title: HEAT_TEXT[m], accent: heatTabVar(m) }))} onHeat={id => setHeat(id as HeatMode | null)} heatScale={heatScale} onHeatScale={setHeatScale}
      extra={mode === "catchup" ? <button type="button" className="oi-ff-catch" onClick={goLive}>skip</button> : mode === "live" && !caughtUp && unseen > 0 ? <button type="button" className="oi-ff-catch" title={`${unseen} events since you last looked`} onClick={catchUp}>catch me up</button> : null}
      tools={<><button type="button" className={`oi-ff-chainbtn${chainsAll ? " lit" : ""}`} aria-pressed={chainsAll} {...tipProps("Chains", "Draw every dependency chain at once; the critical path is brighter", "C")} onClick={() => setChainsAll(o => !o)}><i className="oi-tb-g" aria-hidden="true">⛓</i><span className="oi-tb-l">Chains</span></button><button type="button" className={`oi-ff-chainbtn${liveOnly ? " lit" : ""}`} aria-pressed={liveOnly} {...tipProps("Live only", "Hide landed and done crates from the floor (a filter; nothing is archived or written)")} onClick={() => setLiveOnly(o => !o)}><i className="oi-tb-g" aria-hidden="true">◉</i><span className="oi-tb-l">Live only</span></button><span className="oi-ff-scenesw" role="group" aria-label="Scene">{(["plain", "animated"] as const).map(m => <button key={m} type="button" className={`oi-ff-chainbtn${sceneMode === m ? " lit" : ""}`} aria-pressed={sceneMode === m} {...tipProps(m === "plain" ? "Plain" : "Animated", m === "plain" ? "Clean silos, nothing behind the crates" : "The machines and their motion, dimmed behind the crates")} onClick={() => setScene(m)}>{m === "plain" ? "Plain" : "Animated"}</button>)}</span><span className="oi-ff-ws"><button type="button" className={`oi-ff-chainbtn${wsFilter !== null ? " lit" : ""}`} aria-haspopup="listbox" aria-expanded={wsOpen} {...tipProps("Workstream filter", "Dim everything outside one workstream")} onClick={() => setWsOpen(o => !o)}>{wsFilter === null ? <><i className="oi-tb-g" aria-hidden="true">⑂</i><span className="oi-tb-l">Workstream</span></> : <><i className={`oi-ff-swatch oi-ln-${wsFilter}`} /> {epicChip(groupOf.get(wsFilter) ?? "Unfiled").id || "Unfiled"}</>} ▾</button>{wsOpen && <div className="oi-ff-wslist" role="listbox" aria-label="Workstreams"><button type="button" role="option" aria-selected={wsFilter === null} onClick={() => { setWsFilter(null); setWsOpen(false); }}>All workstreams</button>{groups.map(g => <button key={g.tone} type="button" role="option" aria-selected={wsFilter === g.tone} title={g.label} onClick={() => { setWsFilter(g.tone); setWsOpen(false); }}><i className={`oi-ff-swatch oi-ln-${g.tone}`} /> {g.label} ({g.count})</button>)}</div>}</span><button type="button" className="oi-ff-chainbtn" {...tipProps("Prune", `Older landed beads move to the Archived vault (display only: it hides them for you, on this device; nothing is written, and Undo last prune puts them back for 10 s). Land also keeps at most ${LAND_VISIBLE_MAX} beads.`, "P")} onClick={pruneNow} disabled={!!pruneAnim}><i className="oi-tb-g" aria-hidden="true">✂</i><span className="oi-tb-l">Prune</span></button>{pruneAsk && <span className="oi-ff-pruneask" role="alertdialog" aria-label="Confirm prune"><button type="button" className="oi-ff-chainbtn lit" autoFocus onClick={runPrune}>{`Archive ${pruneAsk.n}`}</button><button type="button" className="oi-ff-chainbtn" onClick={() => setPruneAsk(null)}>Cancel</button></span>}{undo && !pruneAnim && <button type="button" className="oi-ff-chainbtn" {...tipProps("Undo last prune", "Put the archived crates back (available for 10 seconds)")} onClick={undoPrune}>Undo last prune</button>}{(pruneAnim || pruneNote) && <span className="oi-ff-prunenote" role="status">{pruneAnim ? `archived ${Math.round(pruneK * pruneAnim.total)} · today ${landCounts(landedAll, 0, tq).today} stay` : pruneNote}</span>}<button type="button" className="oi-ff-keybtn" aria-pressed={keyOpen} {...tipProps("Key", "What the marks mean", "?")} onClick={() => setKeyOpen(o => !o)}><i className="oi-tb-g" aria-hidden="true">?</i><span className="oi-tb-l">Key</span></button><span className="oi-ff-viewseg" role="group" aria-label="Stage view">{(["floor", "iso"] as const).map(v => <button key={v} type="button" aria-pressed={view === v} {...tipProps(v === "floor" ? "Floor" : "Iso", v === "floor" ? "The flat working view" : "The isometric factory", "I")} onClick={() => setView(() => v)}><i className="oi-tb-g" aria-hidden="true">{v === "floor" ? "▤" : "◇"}</i><span className="oi-tb-l">{v === "floor" ? "Floor" : "Iso"}</span></button>)}</span><span className="oi-ff-viewseg" role="group" aria-label="Stage look">{FACTORY_LOOKS.map(l => <button key={l} type="button" aria-pressed={look === l} {...tipProps(l === "cyberpunk" ? "Neon" : "Theme", l === "cyberpunk" ? "The Cyberpunk factory look (default)" : "Match the app theme")} onClick={() => setLook(l)}><i className="oi-tb-g" aria-hidden="true">{l === "cyberpunk" ? "◆" : "◐"}</i><span className="oi-tb-l">{l === "cyberpunk" ? "Neon" : "Theme"}</span></button>)}</span><button type="button" className="oi-ff-railbtn" aria-pressed={railOpen} {...tipProps("Tree", "The Work tree beside the floor", "T")} onClick={() => setRailOpen(o => !o)}><i className="oi-tb-g" aria-hidden="true">≡</i><span className="oi-tb-l">Tree</span></button><FullscreenToggle full={fs.full} onToggle={fs.toggle} /></>} />

    <FactoryTipLayer root={rootRef} />
    <div className="oi-ff-body">
    <div className="oi-ff-stage">
    <div className="oi-ff-cellwrap"><div className="oi-ff-cells" aria-live="polite" aria-label={empty ? "No work at this time" : floorLine(frame)}>
      {STAT_CELLS.map(c => { const body = cellBody(c.id); return body && <div key={c.id} className={`oi-ff-cell c-${c.id}`}><small title={c.full}>{c.short}</small>{body}</div>; })}
    </div></div>
      {heatOn && !(frame.heatMode === "cost" && !frame.costWired) && <div className="oi-ff-heatcorner" role="group" aria-label={`Heat legend: ${heat === "impact" ? "blocking" : heat}`}><small>{heat === "impact" ? "blocking" : heat}</small>{heatChips(heat!)}</div>}
      {view === "iso" && <IsoStage frame={frame} selectedId={p.selectedId} onSelect={p.onSelect} onHover={h => setHover(h)} chainEdges={chainsAll && !focusId ? isoAllEdges : depEdges} allEdges={chainsAll && focusId ? isoAllEdges : null} heat={heat} roles={focusId ? roles : null} reduced={reduced} playing={moving} speed={speed}
        fx={{ weather: weather, sparks: new Set(sparks.keys()) }} hoverId={hover?.id ?? null} archived={vault.length} />}
      <svg ref={svgRef} aria-hidden={view === "iso" || undefined} className={`oi-ff-svg${view === "iso" ? " off" : ""}${moving && busy ? " run" : ""}${!moving && frame.live && !reduced ? " drift" : ""}${heatOn ? " heat" : ""}`} viewBox={`0 ${-frame.lift} ${W} ${H + frame.lift}`} role="group" aria-label="Factory floor: work items moving from intake to landed"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { drag.current = null; }} onPointerLeave={() => { drag.current = null; setHover(null); }}>
        <defs>
          <pattern id="oi-ff-grid" width="24" height="24" patternUnits="userSpaceOnUse"><path className="oi-ff-gridline" d="M24 0H0V24" /></pattern>
          <pattern id="oi-ff-stripe" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect className="oi-ff-stripe" width="3" height="6" /></pattern>
          <pattern id="oi-ff-hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect className="oi-ff-hatchline" width="2" height="10" /></pattern>
          {HATCH_STEPS.map(n => <pattern key={n} id={hatchPatternId(n)} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(135)"><rect width="8" height="8" style={{ fill: `var(${heatColorVar("impact", n)})` }} /><rect width="2" height="8" style={{ fill: `var(${hatchInkVar(n)})`, opacity: hatchOpacity(n) }} /></pattern>)}
          <radialGradient id="oi-ff-pool"><stop offset="0" className="oi-ff-pool0" /><stop offset="1" className="oi-ff-pool1" /></radialGradient>
          <marker id="oi-ff-arrow-up" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path className="oi-ff-arrowhead up" d="M0 0L10 5L0 10Z" /></marker>
          <marker id="oi-ff-arrow-down" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path className="oi-ff-arrowhead down" d="M0 0L10 5L0 10Z" /></marker>
          <clipPath id="oi-ff-beltclip"><rect x="16" y={BELT_Y} width={W - 32} height={BELT_H} rx="3" /></clipPath>
        </defs>
        <rect className="oi-ff-floor" y={-frame.lift} width={W} height={H + frame.lift} rx="12" />
        {animated && <g className="oi-ff-art"><FactoryFloorPlane W={W} H={H} beltY={BELT_Y} beltH={BELT_H} /></g>}
        <g ref={worldRef}>
          <rect width={W} height={H} fill="url(#oi-ff-grid)" />
          {bayStations.map(s => <g key={s.id} className={`oi-ff-bay oi-ff-s-${s.id}${s.bottleneck ? " jam" : ""}${spot === s.id ? " spot" : ""}${spot && spot !== s.id ? " dim" : ""}`} style={{ ["--sev" as string]: s.severity }}>
            {s.bottleneck && <rect className="oi-ff-halo" x={s.x + 4} y={46 + bt(s)} width={s.w - 8} height={BELT_Y - 38 - bt(s)} rx="14" />}
            <rect className="oi-ff-pad" x={s.x + 6} y={52 + bt(s)} width={s.w - 12} height={BELT_Y - 48 - bt(s)} rx="10" />
            {animated && <g className="oi-ff-art"><StationMachine station={s.id} x={s.x} w={s.w} floorY={BELT_Y} load={s.count / Math.max(1, ...frame.stations.map(c => c.count))} bottleneck={s.bottleneck} reduced={reduced} /></g>} {/* no count: the station number lives in the header, never under a crate */}
            <g className="oi-ff-head" data-station={s.id} role="button" tabIndex={0} aria-pressed={spot === s.id} aria-label={`${s.label}: ${s.count}. Hover or focus for its rules, click or Enter to spotlight its queue`} onPointerEnter={e => { const r = (e.currentTarget as unknown as Element).getBoundingClientRect(); setStationTip({ id: s.id, x: r.left, y: r.bottom }); }} onPointerLeave={() => setStationTip(null)}
              onFocus={e => { const r = (e.currentTarget as unknown as Element).getBoundingClientRect(); setStationTip({ id: s.id, x: r.left, y: r.bottom }); }} onBlur={() => setStationTip(null)}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setSpot(x => (x === s.id ? null : s.id)); } }} onClick={() => setSpot(x => (x === s.id ? null : s.id))}>
              <rect x={s.x + 6} y={12 + bt(s)} width={s.w - 12} height={38} rx="8" className="oi-ff-headhit" />
              {s.w < SLIVER_PX ? <>
                <text className="oi-ff-count" x={s.cx} y={34 + bt(s)} textAnchor="middle">{s.count}</text>
                <text className="oi-ff-label sliver" transform={`translate(${s.cx + 4} ${BELT_Y - 12}) rotate(-90)`}>{s.label.toUpperCase()}</text>
              </> : <>
              <text className="oi-ff-label" x={s.x + 16} y={30 + bt(s)}>{s.label.toUpperCase()} <tspan className="oi-ff-count">{s.count}</tspan></text>
              </>}
              {s.w < SLIVER_PX ? null : <>
                {weather.get(s.id) ? <text className="oi-ff-sub oi-ff-weather" x={s.x + 16} y={43 + bt(s)} textLength={Math.min(weather.get(s.id)!.text.length * 5.3, s.w - 32)} lengthAdjust="spacingAndGlyphs"><title>{weather.get(s.id)!.title}</title>{weather.get(s.id)!.text}</text> : <text className="oi-ff-sub" x={s.x + 16} y={43 + bt(s)}>{s.id === "land" ? landHead : stats[s.id].sub}</text>}
                {stats[s.id].p50 && <text className="oi-ff-sub oi-ff-p50" x={s.x + 16} y={55 + bt(s)}>{stats[s.id].p50}</text>}
              </>}
            </g>
            {!fullScale && s.overflow > 0 && <g className="oi-ff-more" transform={`translate(${s.overflowAt.x} ${s.overflowAt.y})`}><rect width="44" height="16" rx="8" /><text x="22" y="12" textAnchor="middle">+{s.overflow}</text></g>}
            {s.id === "land" && shelf.total > 0 && s.w >= SLIVER_PX && !fullScale && <g className="oi-ff-shelf" role="group" aria-label={`Shipped today: ${shelf.total}`}>
              <text className="oi-ff-shelfhead" x={s.x + 16} y={70 + bt(s)}>SHIPPED TODAY · {shelf.total}</text>
              {shelf.items.map((it, k) => <g key={it.id} className="oi-ff-shelfrow" role="button" tabIndex={0} aria-label={`${it.title}, landed ${clock(it.at)}${it.cost === null ? "" : `, cost $${it.cost.toFixed(2)}`}. Select`} onClick={() => p.onSelect(it.id)} onKeyDown={e => { if (e.key === "Enter") { e.stopPropagation(); p.onSelect(it.id); } }}>
                <title>{`#${shortId(it.id)} · ${it.title} · landed ${clock(it.at)}${it.cost === null ? "" : ` · cost $${it.cost.toFixed(2)}`}`}</title>
                <rect className="oi-ff-shelfhit" x={s.x + 10} y={74 + bt(s) + k * 13} width={s.w - 20} height="13" rx="3" />
                <text className="oi-ff-shelftext" x={s.x + 16} y={84 + bt(s) + k * 13}>{shelfLine(it, clock(it.at))}</text>
              </g>)}
              {shelf.total > SHELF.ROWS && <text className="oi-ff-shelfmore" x={s.x + 16} y={84 + bt(s) + SHELF.ROWS * 13}>+{shelf.total - SHELF.ROWS} more today</text>}
            </g>}
            {animated && s.id !== "intake" && <g className="oi-ff-gantry oi-ff-art" transform={`translate(${s.x} 0)`}><rect x="-3" y={BELT_Y - 112} width="6" height="118" rx="2" /><rect x="-14" y={BELT_Y - 118} width="28" height="8" rx="3" /><circle className="oi-ff-lamp" cx="0" cy={BELT_Y - 124} r="4" /></g>}
            {animated && s.id === "gate" && s.count > 0 && <rect className="oi-ff-scan oi-ff-art" x={s.x + 8} y={60} width={s.w - 16} height="2" rx="1" />}
            {s.id === "gate" && !frame.reviewKnown && <g className="oi-ff-norecord" aria-label="Review history not recorded: in the past the Gate is empty and a work item that was in review shows at Build">
              <rect x={s.x + 6} y={52 + bt(s)} width={s.w - 12} height={BELT_Y - 48 - bt(s)} rx="10" fill="url(#oi-ff-hatch)" />
              {s.w >= SLIVER_PX && <><text className="oi-ff-norecordtext" x={s.cx} y={BELT_Y - 150} textAnchor="middle">review history</text>
              <text className="oi-ff-norecordtext" x={s.cx} y={BELT_Y - 134} textAnchor="middle">not recorded</text></>}
              <title>Review history is not recorded, so in replay the Gate stays empty and a work item that was in review shows at Build. Go live to see the Gate.</title>
            </g>}
          </g>)}
          <g className="oi-ff-belt">
            <rect className="oi-ff-beltbed" x="16" y={BELT_Y} width={W - 32} height={BELT_H} rx="3" />
            <g clipPath="url(#oi-ff-beltclip)"><g className="oi-ff-chevrons">{Array.from({ length: Math.ceil(W / 32) + 2 }, (_, k) => <path key={k} d={`M${k * 32} ${BELT_Y + 3}l6 5l-6 5`} />)}</g></g>
            <line className="oi-ff-edge" x1="16" y1={BELT_Y} x2={W - 16} y2={BELT_Y} /><line className="oi-ff-edge" x1="16" y1={BELT_Y + BELT_H} x2={W - 16} y2={BELT_Y + BELT_H} />
            {Array.from({ length: Math.floor((W - 40) / 48) + 1 }, (_, k) => <circle key={k} className="oi-ff-roller" cx={24 + k * 48} cy={BELT_Y + BELT_H + 5} r="3" />)}
          </g>
          {(() => { // the return conveyor: rework only, Gate → Build, right to left under the main belt
            const x0 = bayStations[2].x + 34, x1 = bayStations[3].x + bayStations[3].w - 20, ly = RET.LANE_Y, active = frame.inRework > 0;
            return <g className={`oi-ff-return${active ? " active" : ""}${heat === "rework" ? ` heat heat-${frame.laneHeat}` : ""}`} aria-label={`Return conveyor: ${frame.inRework} in rework`}>
              <path className="oi-ff-chute" d={`M${x1 - 46} ${BELT_Y + BELT_H + 2} L${x1 - 8} ${BELT_Y + BELT_H + 2} L${x1} ${ly} L${x1 - 30} ${ly} Z`} />
              <path className="oi-ff-ramp" d={`M${x0} ${ly} L${x0 + 30} ${ly} L${x0 + 58} ${BELT_Y + BELT_H + 2} L${x0 + 24} ${BELT_Y + BELT_H + 2} Z`} />
              <rect className="oi-ff-lanebed" x={x0} y={ly} width={x1 - x0} height={RET.LANE_H} rx="2" />
              <clipPath id="oi-ff-laneclip"><rect x={x0} y={ly} width={x1 - x0} height={RET.LANE_H} /></clipPath>
              <g clipPath="url(#oi-ff-laneclip)"><g className="oi-ff-lanechev">{Array.from({ length: Math.ceil((x1 - x0) / 18) + 2 }, (_, k) => <path key={k} d={`M${x0 + k * 18} ${ly + 1} l-4 2 l4 2`} />)}</g></g>
              <line className="oi-ff-laneedge" x1={x0} y1={ly + RET.LANE_H} x2={x1} y2={ly + RET.LANE_H} />
              <g className="oi-ff-lanebadge" transform={`translate(${bayStations[3].x} ${ly - 7})`}><rect x="-44" y="-9" width="88" height="15" rx="7.5" /><text textAnchor="middle" y="2">↩ {frame.inRework} being fixed</text><title>{`${frame.inRework} came back from review and are being fixed`}</title></g>
            </g>;
          })()}
          {trailPts.length > 1 && <g className="oi-ff-trail" aria-hidden="true">
            <path d={trailPts.map((s, k) => `${k === 0 ? "M" : "L"}${s.x} ${BELT_Y + BELT_H / 2}`).join(" ")} />
            {trailPts.map((s, k) => <g key={k} transform={`translate(${s.x} ${BELT_Y + BELT_H / 2})`}><circle r="4" /><text y={-10 - (k % 2) * 11} textAnchor="middle">{clock(s.at)}</text></g>)}
          </g>}
          {frame.workers.filter(w => w.presence === "live").map(w => { const k = tokenAt.get(w.beadId); return k && <ellipse key={`pool:${w.key}`} className="oi-ff-poolglow" cx={k.x + k.w / 2} cy={k.y + k.h + 4} rx={k.w / 2 + 8} ry="8" />; })}
          {chainKeys.map(key => { const l = lockByKey.get(key)!, a = tokenAt.get(l.beadId); if (!a || (l.kind === "blocked" && depEdges.length > 0)) return null; return l.holders.slice(0, 3).map(h => { const b = chainEnd(h); return b && <line key={`${key}>${h}`} className={`oi-ff-chain ${l.kind}`} x1={a.x + a.w - 6} y1={a.y - 3} x2={b.x} y2={b.y}>{l.kind === "gate" && <title>{`#${shortId(l.beadId)} is waiting for a free reviewer (not a dependency): #${shortId(h)} is in review`}</title>}</line>; }); })}
          {exits.map(w => <g key={`x:${w.id}`} className="oi-ff-exit" transform={`translate(${w.from.x} ${w.from.y})`}><rect className="oi-ff-crate" width={T} height={T} rx="4" /></g>)}
          {frame.tokens.map(k => { const w = k.shape === "card" ? workerOf.get(k.id) ?? null : null; return <g key={k.id} data-tid={k.id} role="button" tabIndex={0} onKeyDown={e => { if (e.key === "Enter") { e.stopPropagation(); p.onSelect(k.id); } }} onFocus={e => { const r = (e.currentTarget as unknown as Element).getBoundingClientRect(); setHover({ id: k.id, x: r.left, y: r.bottom }); }} onBlur={() => setHover(h => (h?.id === k.id ? null : h))} aria-label={`${k.shortId} ${k.title}, ${stageLabel(k.stage)}${k.lock ? `. ${lockDetail(lockByKey.get(k.lock)!, whereOf).slice(3)}` : k.caption ? `. ${k.caption.full}` : ""}`} aria-pressed={p.selectedId === k.id}
            className={tokenClass(k)} style={{ ["--heat" as string]: k.heat ?? 0 }} onClick={() => p.onSelect(k.id)}>
            {scene.fx.bursts.has(k.id) && <g className="oi-ff-burst" aria-hidden="true" transform={`translate(${k.w / 2} ${k.h / 2})`}><circle className="oi-ff-burstring" r={k.shape === "card" ? 14 : 10} />{Array.from({ length: 8 }, (_, n) => <path key={n} className="oi-ff-burstray" d="M0 -9V-15" transform={`rotate(${n * 45})`} />)}</g>}
            {k.critical && <rect className="oi-ff-critring" x="-4" y="-4" width={k.w + 8} height={k.h + 8} rx="7" />}
            <rect className="oi-ff-shadow" x="1.5" y="3" width={k.w} height={k.h} rx="5" />
            <rect className="oi-ff-crate" width={k.w} height={k.h} rx={k.shape === "card" ? 6 : 4} />
            {k.blocked && <rect width={k.w} height={k.h} rx="4" fill="url(#oi-ff-stripe)" />}
            {k.shape === "crate" ? <>
              <rect className="oi-ff-lid" x="3" y="3" width={T - 6} height="4" rx="1.5" />
              {ptClass(k) && <circle className={`oi-ff-prio ${ptClass(k)}`} cx={T - 5} cy={T - 5} r="2.5" />}
              {k.blocked && <g className="oi-ff-barrier" transform={`translate(${T + 2} 0)`}><rect x="0" y="-4" width="3" height={T + 6} rx="1" /><rect className="oi-ff-boom" x="-22" y="7" width="26" height="5" rx="2" /></g>}
              <text className="oi-ff-mark" x={T / 2} y={T / 2 + 6} textAnchor="middle">{k.blocked ? "⊘" : k.motion === "rework" ? "↩" : ""}</text>
              {k.blocked && k.downstream > 0 && <text className="oi-ff-down" x={T / 2} y={T + 11} textAnchor="middle">↓{k.downstream}</text>}
            </> : <>
              {k.density === "full" ? <>
                <text className="oi-ff-cid" x={w || isWorkStation(k.station) ? 32 : 8} y="13"><title>{`#${k.shortId}`}</title>#{k.shortId}</text>
                {twoLines(k.title, w || isWorkStation(k.station) ? 21 : 26).map((ln, i) => <text key={i} className="oi-ff-ttl" x={w || isWorkStation(k.station) ? 32 : 8} y={25 + i * 11}>{ln}</text>)}
                <text className="oi-ff-el" x={w || isWorkStation(k.station) ? 32 : 8} y="48">{cardLine(k.sinceMs === null ? null : k.sinceMs + skew, frame.costWired ? w?.cost ?? null : null)}</text>
              </> : k.density === "normal" ? <>
                <text className="oi-ff-cid" x="32" y="14"><title>{`#${k.shortId}`}</title>{fitId(k.shortId)}</text>
                <text className="oi-ff-el" x="32" y="27">{cardLine(k.sinceMs === null ? null : k.sinceMs + skew, frame.costWired ? w?.cost ?? null : null)}</text>
              </> : k.density === "dense" ? <>
                <text className="oi-ff-cid dense" x="21" y="10"><title>{`#${k.shortId}`}</title>{fitId(k.shortId, 7)}</text>
                <text className="oi-ff-el dense" x="21" y="20">{cardLine(k.sinceMs === null ? null : k.sinceMs + skew, null)}</text>
              </> : <text className="oi-ff-cid micro" x="16" y="12"><title>{`#${k.shortId}`}</title>{fitId(k.shortId, 4)}</text>}
              {ptClass(k) && <circle className={`oi-ff-prio ${ptClass(k)}`} cx={k.w - 5} cy="5" r={k.density === "normal" ? 2.5 : 1.8} />}
              {k.caption && k.caption.short && <g className={`oi-ff-cap ${k.caption.kind}`} data-goto={k.caption.ids.length === 1 ? k.caption.ids[0] : undefined} role="button" aria-label={k.caption.full} onClick={e => { if (k.caption!.ids.length !== 1) return; e.stopPropagation(); p.onSelect(k.caption!.ids[0]); }}>
                <title>{`${k.caption.full}${k.caption.ids.length === 1 ? ` · click to select #${shortId(k.caption.ids[0])}` : " · select this card to see them all"}`}</title>
                <rect className="oi-ff-capbg" x="1" y={k.h - CARD_SIZES[k.density].foot} width={k.w - 2} height={CARD_SIZES[k.density].foot - 1} rx="2" />
                <text className={`oi-ff-captext ${k.density}`} x="4" y={k.h - (k.density === "normal" ? 3 : 2.5)}>{k.caption.short}</text>
              </g>}
              {w?.via === "transcript" && <text className="oi-ff-tx" x={k.w - (k.density === "normal" ? 7 : 4)} y={k.h - CARD_SIZES[k.density].foot - (k.density === "normal" ? 4 : 2)} textAnchor="end"><title>{`no ${PANE} · transcript live: working with no ${PANE}, its transcript was written in the last 5 min${w.transcriptAt === null ? "" : ` (last write ${elapsedText(Math.max(0, now - w.transcriptAt))} ago)`}`}</title>≋</text>}
              {k.station === "build" && !reduced && (w?.presence === "live" || (w?.presence === "past" && moving)) && <rect className="oi-ff-shimmer" x={CARD_SIZES[k.density].badgeX * 2} y={k.h - CARD_SIZES[k.density].foot - (k.density === "normal" ? 4 : 2)} width={k.density === "normal" ? 14 : 8} height="2" rx="1" />}
              {w ? <g className={`oi-ff-worker ${w.presence} oi-ff-m-${w.badge.model ?? "none"}${w.stale ? " stale" : ""}${w.critical ? " crit" : ""}${follow === w.beadId ? " followed" : ""}`} data-worker={w.beadId} style={agentVar(w.beadId)} transform={`translate(${CARD_SIZES[k.density].badgeX} ${badgeY(k.density)})${k.density === "normal" ? "" : ` scale(${(CARD_SIZES[k.density].badgeR / 11).toFixed(3)})`}`} role="button" aria-label={`Follow the ${w.badge.model ?? "unknown"} agent on ${k.shortId}`} onClick={e => { e.stopPropagation(); setFollow(f => (f === w.beadId ? null : w.beadId)); }}>
                {w.presence === "live" && !reduced && <circle className="oi-ff-beat" r="10" />}
                <AgentMark badge={w.badge} flutter={w.presence === "live" && !reduced} />
                <title>{`${w.badge.title} on ${k.shortId}${w.via === "transcript" ? ` · no ${PANE} · transcript live` : w.presence === "live" ? ` · ${PANE} ${w.pane}${w.paneState ? ` (${w.paneState})` : ""}` : w.presence === "ghost" ? ` · ${GHOST}: ${termDef("ghost")}` : ""}${w.stale ? ` · ${STALE}: ${termDef("stale")}` : ""} Click to follow.`}</title>
              </g> : k.density === "full" && !isWorkStation(k.station) ? null : <circle className="oi-ff-seat" cx={CARD_SIZES[k.density].badgeX} cy={badgeY(k.density)} r={CARD_SIZES[k.density].badgeR - 1} />}
              {w && sparks.get(k.id) && (() => { const sp = sparks.get(k.id)!, lit = sp.animated && !reduced, c = CARD_SIZES[k.density], z = k.density === "normal" ? 1 : k.density === "dense" ? 0.75 : 0.55; return <g transform={`translate(${c.badgeX + c.badgeR * 0.75} ${badgeY(k.density) - c.badgeR})scale(${z})`} aria-hidden="true"><path className={`oi-ff-fxspark${lit ? "" : " still"}`} d="M0 -3L.8 -.8L3 0L.8 .8L0 3L-.8 .8L-3 0L-.8 -.8Z" style={lit ? { animationDuration: `${sp.intervalMs}ms`, animationDelay: `-${sp.delayMs}ms` } : undefined}><title>{`transcript written ${elapsedText(sp.ageMs)} ago`}</title></path></g>; })()}
            </>}
            <g className="oi-ff-ride" aria-hidden="true"><rect className="oi-ff-rideglow" x={k.w - 2} y="6" width="64" height={k.h - 12} rx="8" /><text className="oi-ff-ridetag" x={k.w + 8} y="-8">↩ #{k.shortId}{k.rework > 1 ? ` · ${k.rework}× sent back` : " · sent back"}</text></g>
            {k.lock ? <g key={`lock:${k.lock}`} className={fresh.has(k.id) ? "oi-ff-snap" : undefined} transform={`translate(${k.w - T} 0)`}><Padlock title={lockDetail(lockByKey.get(k.lock)!, whereOf)} /></g> : unlocking.has(k.id) && <g key={`open:${frame.t}`} className="oi-ff-pop" transform={`translate(${k.w - T} 0)`}><Padlock open /></g>}
          </g>; })}
          {(() => { // the Archived vault in the Land bay, and the crates arcing into it while a prune runs
            const land = bayStations[4], vx = land.x + 18, vw = Math.max(28, land.w - 36), vy = BELT_Y + BELT_H + 16, n = vault.length + (pruneAnim ? Math.round(pruneK * pruneAnim.total) : 0);
            const ghosts = pruneAnim ? frame.tokens.filter(k => k.station === "land" && pruneAnim.ids.includes(k.id)) : [];
            return <g className="oi-ff-vaultlayer">
              <g className={`oi-ff-vault${pruneAnim ? " busy" : ""}`} role="button" tabIndex={0} aria-label={`Archived: ${n}. Open the archive`} onClick={() => p.onOpenArchive?.(vault.map(x => x.id))} onKeyDown={e => { if (e.key === "Enter") { e.stopPropagation(); p.onOpenArchive?.(vault.map(x => x.id)); } }}>
                <title>{`Archived · ${n}: landed beads from before today, moved off the floor (display only; nothing is deleted)`}</title>
                <rect className="oi-ff-vaulthit" x={vx} y={vy} width={vw} height="40" rx="6" />
                {/* fg-machines' VaultMachine art (ONE vault drawing for the Floor), fitted into the 40-unit box below the belt */}
                {animated ? <g transform={`translate(0 ${vy - ART_TOP})`}><VaultMachine x={vx - 6} w={vw + 12} floorY={ART_TOP + 40} count={n} flash={pruneAnim !== null} reduced={reduced} /></g> : <g className="oi-ff-vaultplain"><rect x={vx} y={vy} width={vw} height="40" rx="6" /><text x={vx + vw / 2} y={vy + 25} textAnchor="middle">ARCHIVED {n}</text></g>}
              </g>
              {ghosts.map((k, i) => { const delay = (i / Math.max(1, ghosts.length)) * 0.55, a = Math.min(1, Math.max(0, (pruneK - delay) / 0.45)), e = ease(a), x = k.x + (vx + 14 - k.x) * e, y = k.y + (vy + 12 - k.y) * e - Math.sin(a * Math.PI) * 50; return a >= 1 ? null : <rect key={`ghost:${k.id}`} className="oi-ff-crate oi-ff-ghost" x={x} y={y} width={k.w} height={k.h} rx="4" opacity={1 - a * 0.6} />; })}
            </g>;
          })()}
          {chainsAll && <g className="oi-ff-deps all" aria-hidden="true">{allEdges.filter(e => tokenAt.has(e.from) && tokenAt.has(e.to) && !depEdges.some(d => d.from === e.from && d.to === e.to)).map(e => <path key={`all:${e.from}>${e.to}`} className={`oi-ff-dep all${e.met ? " met" : ""}${p.critical?.has(e.from) && p.critical?.has(e.to) ? " crit" : ""}`} d={depPath(tokenAt.get(e.from)!, tokenAt.get(e.to)!)} markerEnd="url(#oi-ff-arrow-up)" />)}</g>}
          {depEdges.length > 0 && <g className="oi-ff-deps" aria-hidden="true">{depEdges.map(e => <path key={`${e.from}>${e.to}`} className={`oi-ff-dep ${e.side}${e.met ? " met" : ""}`} d={depPath(tokenAt.get(e.from)!, tokenAt.get(e.to)!)} markerEnd={`url(#oi-ff-arrow-${e.side})`} />)}</g>}
        </g>
      </svg>
      <aside className="oi-ff-side">
        {selIssue && selDeps && <section aria-label="Selected: who waits for what">
          <h4>Selected</h4>
          <b>#{shortId(selIssue.id)} · {selIssue.title}</b>
          <span className="oi-ff-ph">Waiting on</span>
          {selDeps.blockers.length === 0 ? <><small title="Nothing: no work item blocks it" aria-describedby={`${uid}-noblock`}>—</small><span id={`${uid}-noblock`} className="oi-ff-sr">Nothing: no work item blocks it</span></> : <ol className="oi-ff-deplist up">{selDeps.blockers.map(id => <li key={id} className={isDoneNow(id) ? "met" : undefined}><button type="button" onClick={() => p.onSelect(id)} onMouseEnter={() => setHover({ id, x: -1, y: -1 })} onMouseLeave={() => setHover(null)}><span>#{shortId(id)}</span> {titleOf(id)}<small>{placeText(id)}</small></button></li>)}</ol>}
          <span className="oi-ff-ph">Holds up</span>
          {selDeps.dependents.length === 0 ? <><small title="Nothing waits on it" aria-describedby={`${uid}-nowait`}>—</small><span id={`${uid}-nowait`} className="oi-ff-sr">Nothing waits on it</span></> : <ol className="oi-ff-deplist down">{selDeps.dependents.map(id => <li key={id} className={isDoneNow(id) ? "met" : undefined}><button type="button" onClick={() => p.onSelect(id)} onMouseEnter={() => setHover({ id, x: -1, y: -1 })} onMouseLeave={() => setHover(null)}><span>#{shortId(id)}</span> {titleOf(id)}<small>{placeText(id)}</small></button></li>)}</ol>}
          {selChain && (selChain.upstream.length > selDeps.blockers.length || selChain.downstream.length > selDeps.dependents.length) && <small>Whole chain: {selChain.upstream.length} upstream · {selChain.downstream.length} downstream (arrows on the floor)</small>}
        </section>}
        {fw && followed && <section aria-label="Following">
          <h4>Following <button type="button" onClick={home} aria-label="Stop following">✕</button></h4>
          <b>#{followed.shortId} · {followed.title}</b>
          <span>{fw.badge.role ? ROLE_WORDS[fw.badge.role] : "Agent (role unknown)"} · {fw.badge.model ? fw.badge.label : "model unknown"}</span>
          <span>At {STATION_TEXT[fw.station].label} for {elapsedText(fw.elapsedMs === null ? null : fw.elapsedMs + skew)}</span>
          <span title={agentNote || undefined} aria-describedby={agentNote ? `${uid}-agent` : undefined}>{fw.via === "transcript" ? "Transcript live" : fw.presence === "live" ? `${capitalise(PANE)} ${fw.pane}${fw.paneState ? ` (${fw.paneState})` : ""}` : fw.presence === "ghost" ? capitalise(GHOST) : "Not recorded"}{fw.stale ? ` · ${STALE}` : ""}</span>{agentNote && <span id={`${uid}-agent`} className="oi-ff-sr">{agentNote}</span>}
          {frame.costWired && <span>Cost so far: {fw.cost === null ? "unknown" : `$${fw.cost.toFixed(2)}`}</span>}
          <small title="F: next agent · Esc: stop following" aria-describedby={`${uid}-keys`}>F · Esc</small><span id={`${uid}-keys`} className="oi-ff-sr">F: next agent · Esc: stop following</span>
        </section>}
        {spot && <section aria-label={`${STATION_TEXT[spot].label} queue`}>
          <h4>{STATION_TEXT[spot].label} · {frame.stations[stationIndex(spot)].count} <button type="button" onClick={() => setSpot(null)} aria-label="Clear spotlight">✕</button></h4>
          {spotList.length === 0 ? <><span title="Nothing here at this time." aria-describedby={`${uid}-nospot`}>No items</span><span id={`${uid}-nospot`} className="oi-ff-sr">Nothing here at this time.</span></> : <ol>{spotList.map(k => <li key={k.id}><button type="button" onClick={() => p.onSelect(k.id)} onMouseEnter={() => setHover({ id: k.id, x: -1, y: -1 })} onMouseLeave={() => setHover(null)}><span>#{k.shortId}</span> {k.title}<small>{k.lock ? lockText(lockByKey.get(k.lock)!).slice(3) : k.sinceMs === null ? "" : formatAge(k.sinceMs)}</small></button></li>)}</ol>}
          {frame.stations[stationIndex(spot)].overflow > 0 && <small>+{frame.stations[stationIndex(spot)].overflow} more not drawn</small>}
        </section>}
        <section aria-label="On the floor"><h4>On the floor</h4>{log.length === 0 ? <><span title={events.length ? "No floor moves in recent history." : "Nothing has happened yet."} aria-describedby={`${uid}-nolog`}>{events.length ? "No moves" : "No history"}</span><span id={`${uid}-nolog`} className="oi-ff-sr">{events.length ? "No floor moves in recent history." : "Nothing has happened yet."}</span></> : <ol className="oi-ff-log">{log.map((l, k) => <li key={l.key} title={l.earlier ? "earlier (from history)" : undefined} className={[l.earlier ? "earlier" : k === 0 && !reduced ? "new" : "", l.beadId && groupByBead.has(l.beadId) ? "oi-ws" : ""].filter(Boolean).join(" ") || undefined} style={l.beadId ? agentVar(l.beadId) : undefined}><span className="oi-ff-logtime">{clock(l.at)}</span><span className="oi-ff-logmsg" style={{ color: `var(${KIND_STYLE[kindOf(l)].css})` }}><svg className="oi-ftl-cg oi-ff-logglyph" viewBox="-8 -8 16 16" width={13} height={13} style={{ ["--c" as string]: `var(${KIND_STYLE[kindOf(l)].css})` }} role="img" aria-label={KIND_STYLE[kindOf(l)].word}><title>{KIND_STYLE[kindOf(l)].word}</title><Glyph g={KIND_STYLE[kindOf(l)].glyph} /></svg>{logText(l.text, l.beadId ? groupByBead.get(l.beadId) : undefined)}{l.title && <small className="oi-ff-logtitle"> · {l.title}</small>}</span></li>)}</ol>}</section>
      </aside>
    </div>
    <div className="oi-ff-sidecol">{p.side}</div></div>
    <div className={`oi-ff-rail oi-ff-treebar${railOpen ? " open" : ""}`} data-tree={railOpen ? "open" : "closed"}>{p.rail ?? <FactoryTreeRail snap={snap} now={now} selectedId={p.selectedId} onSelect={p.onSelect} onHover={h => setHover(h)} roles={railTint} open={railOpen} onToggle={() => setRailOpen(o => !o)} frame={frame.live ? frame : null} scrubbed={!frame.live} transcriptLive={p.transcriptLive ?? null} hoverId={hover?.id ?? null} />}</div>
    <div className="oi-ff-time">{p.time ?? <FloorTimeline lines={log as readonly TimelineLine[]} t0={range.t0} t1={Math.max(range.t0, now)} now={now} reduced={reduced} stationOf={stationOf} onSelect={p.onSelect} onHover={h => setHover(h)} />}</div>
    {groups.length > 0 && <div className="oi-ff-epics" title="A card's edge colour is the epic (parent work item) it belongs to">{groups.slice(0, EPIC_CHIPS).map(g => { const c = epicChip(g.label); return <span key={g.tone} className={`oi-ff-epic oi-ln-${g.tone}`} title={`${g.label} (${g.count})`}><i className="oi-ff-swatch" /><b>{c.id}</b> {c.name}</span>; })}{groups.length > EPIC_CHIPS && <span className="oi-ff-epic more" title={groups.slice(EPIC_CHIPS).map(g => g.label).join("\n")}>+{groups.length - EPIC_CHIPS}</span>}</div>}
    {keyOpen && <div className="oi-ff-keypop" role="dialog" aria-label="Factory key">
      <div className="oi-ff-keygrid">{keyItems.map(([glyph, words, tip]) => <span key={words} className="oi-ff-keyitem" title={tip}><i>{glyph}</i>{words}</span>)}
        {heatOn && <span className="oi-ff-keyitem wide" title={HEAT_TEXT[heat!]}>{frame.heatMode === "cost" && !frame.costWired ? "heat: cost not connected" : <>{heatLegend(heat!, heatScale)} {heatChips(heat!)}</>}</span>}
        {!frame.reviewKnown && <span className="oi-ff-keyitem wide" title={`In replay review history is not recorded, so the Gate is hatched and a ${ITEM} that was in review shows at Build.`}><i>▨</i>review not recorded</span>}
      </div>
      <small>Hover any item for what it means. Press ? or Esc to close.</small>
    </div>}
    {hovered && hover && hover.x >= 0 && <div className="oi-ff-tip" style={{ left: Math.min(hover.x + 14, (typeof innerWidth === "number" ? innerWidth : 1200) - 340), top: hover.y + 14 }}>
      <b>#{hovered.shortId} · {hovered.title}</b>
      <span className="oi-ff-tipgroup">Epic: {groupOf.get(hovered.group) ?? frame.factory.rows.find(r => r.toneIndex === hovered.group)?.label ?? "none"}</span>
      <span>{STATION_TEXT[hovered.station].label}{hovered.sinceMs === null ? "" : ` for ${formatAge(hovered.sinceMs)}`}{hovered.critical ? " · critical path" : ""}</span>
      {trail.length > 0 && <span className="oi-ff-tiptrail">{trail.map(s => `${STATION_TEXT[s.station].label} ${clock(s.at)}`).join(" → ")}</span>}
      {hovered.gateRole === "review" && <span>At the Gate: assumed under review (no review-start signal yet)</span>}
      {hovered.lock && <span className="oi-ff-t-failure">{lockDetail(lockByKey.get(hovered.lock)!, whereOf)}</span>}
      {hovered.waitingOn.length > 0 && <span className="oi-ff-t-failure">Waits on {hovered.waitingOn.map(x => `#${shortId(x)} (${placeText(x)})`).join(", ")}</span>}
      {hovered.blocks.length > 0 && <span className="oi-ff-t-running">Holds up {hovered.blocks.map(x => `#${shortId(x)}`).join(", ")}{hovered.downstream > hovered.blocks.length ? ` · ${hovered.downstream} ${ITEM}s wait on it` : ""}</span>}
      {chain && (chain.upstream.length > 0 || chain.downstream.length > 0) && <small>Arrows: solid = waits on, dashed = waits on it</small>}
      {hovered.rework > 0 && <span className="oi-ff-t-attention">Sent back {hovered.rework}×</span>}
      {(() => { const w = workerOf.get(hovered.id); const who = hovered.pane ?? w?.pane ?? null; return w || who ? <span>Agent: {who ?? (w?.via === "transcript" ? "working by transcript" : "no agent attached")}{w?.badge.model ? ` · ${w.badge.label}` : ""}</span> : null; })()}
    </div>}
    {stationTip && (() => { // what the station does, its rules (the same table the floor uses), its limit, and the bead checklist
      const r = RULE_OF[stationTip.id], st = frame.stations[stationIndex(stationTip.id)], beadId = p.selectedId ?? lastBead.current, issue = beadId ? snap.issues.find(i => i.id === beadId) ?? null : null;
      const k = beadId ? tokenAt.get(beadId) ?? null : null, w = beadId ? workerOf.get(beadId) ?? null : null;
      const checks = issue ? beadChecklist(issue, frame.live ? w?.via === "pane" || !!k?.pane : null, p.evidence, issue.id, w?.via === "transcript") : [];
      return <div className="oi-ff-pop-station" role="tooltip" style={{ left: Math.min(stationTip.x + 14, (typeof innerWidth === "number" ? innerWidth : 1200) - 380), top: stationTip.y + 6 }}>
        <b>{r.label}: {r.meaning}</b>
        <span className="oi-ff-ph">To be here</span><ul>{r.enter.map(x => <li key={x}>{x}</li>)}</ul>
        <span className="oi-ff-ph">Moves on when</span><ul>{r.exit.map(x => <li key={x}>{x}</li>)}</ul>
        <span className="oi-ff-ph">Limit</span><span>{st.count} here · {st.queue} queued · {limitText(stationTip.id, st.threshold, frame.thresholdsWired)}{st.bottleneck ? " · over the limit" : ""}</span>
        <span className="oi-ff-ph">Checklist {issue ? `for #${shortId(issue.id)}${p.selectedId ? " (selected)" : " (last hovered)"}` : ""}</span>
        {issue ? <ul className="oi-ff-checks">{checks.map(c => <li key={c.id} className={`c-${c.state}`}><i>{CHECK_MARK[c.state]}</i> {c.label}<small>{c.detail}</small></li>)}</ul> : <><span title="Hover or select a work item to check it against these conditions." aria-describedby={`${uid}-pick`}>Pick an item</span><span id={`${uid}-pick`} className="oi-ff-sr">Hover or select a work item to check it against these conditions.</span></>}
        {p.evidence && issue && p.evidence.get(issue.id)?.lines.slice(0, 3).map(l => <small key={l} className="oi-ff-evline">{l}</small>)}
      </div>;
    })()}
    {empty && <div className="oi-ff-empty" aria-describedby={`${uid}-empty`} title={frame.live ? `No ${ITEM}s to show yet: this tracker has none, or only epics (an epic groups ${ITEM}s and is not drawn).` : "Nothing existed yet at this point in history."}>{frame.live ? "No items" : "No history"}<span id={`${uid}-empty`} className="oi-ff-sr">{frame.live ? `No ${ITEM}s to show yet: this tracker has none, or only epics (an epic groups ${ITEM}s and is not drawn).` : "Nothing existed yet at this point in history."}</span></div>}
  </div></FactoryFullscreen>;
}

// Heat reads the theme's --oi-heat-0..4 (theme/tokens.ts on wip/osiris-ui-v2); until that lands the fallbacks below are mixed
// from existing tokens only, ember → red → amber → near-white, never the accent. Selection, follow and trails use --oi-accent.
export const factoryFloorStyles = `${timeLensBarStyles}${factoryLookStyles}${factoryTipStyles}${isoStageStyles}${factoryTreeRailStyles}${factoryMachinesStyles}${floorTimelineStyles}${FULLSCREEN_CSS}${heatFamilyCss()}
.oi-ff{position:relative;--ff-h0:var(--oi-heat-0,color-mix(in srgb,var(--oi-tone-failure) 22%,var(--oi-bg)));--ff-h1:var(--oi-heat-1,color-mix(in srgb,var(--oi-tone-failure) 48%,var(--oi-bg)));--ff-h2:var(--oi-heat-2,var(--oi-tone-failure));--ff-h3:var(--oi-heat-3,var(--oi-tone-attention));--ff-h4:var(--oi-heat-4,color-mix(in srgb,var(--oi-tone-attention) 30%,var(--oi-text)));--ff-accent:var(--oi-accent,var(--oi-tone-info));display:flex;flex-direction:column;min-width:0;font:13px system-ui,sans-serif;color:var(--oi-text);outline:none}
.oi-ff:focus-visible{box-shadow:inset 0 0 0 1px var(--oi-focus,var(--ff-accent))}
.oi-ff>.oi-tl{margin:0 12px}
.oi-ff-catch{font:600 11px ui-monospace,monospace;min-height:30px;padding:0 10px;border:1px dashed var(--ff-accent);border-radius:8px;background:transparent;color:var(--ff-accent);cursor:pointer}
.oi-ff-cellwrap{container-type:inline-size;container-name:ffcells;position:relative;order:-1;flex:0 0 100%;min-width:0;margin:6px 6px 4px;z-index:3} /* a row of the stage, never an overlay: it takes its own height above the silos */
.oi-ff-cells{display:grid;grid-template-columns:repeat(11,minmax(0,1fr));gap:2px;padding:4px 4px;border-radius:8px;background:color-mix(in srgb,var(--oi-bg) 78%,transparent)}
.oi-ff-ttl{font:10px system-ui,sans-serif;fill:var(--oi-text-2,var(--oi-text))}
.oi-ff-cell{padding:2px ${STAT.PAD_X / 2}px;border:0;border-radius:6px;background:transparent;min-width:0;overflow:hidden;display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:6px;align-items:baseline}
.oi-ff-cell>b{grid-column:1;grid-row:1}.oi-ff-cell>small{grid-column:1/-1;grid-row:3}.oi-ff-cell>:not(b):not(small){grid-column:2;grid-row:1}.oi-ff-cell>.oi-ff-note{grid-column:1/-1;grid-row:2}
.oi-ff-cell small{display:block;color:var(--oi-tone-muted);font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oi-ff-cell b{display:block;font:700 20px ui-monospace,monospace;line-height:1.15;color:var(--oi-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oi-ff-cell b span,.oi-ff-cell b i{font:inherit;font-style:normal}
.oi-ff-cell b i.oi-ff-unit{font-size:.48em;font-weight:600;color:var(--oi-tone-muted);letter-spacing:.02em}
.oi-ff-cell b .oi-ff-dot{color:var(--oi-tone-muted)}
.oi-ff-cell b.oi-ff-mode{font-size:13px;line-height:1.6}
.oi-ff-note{display:block;font-style:normal;font-size:10px;color:var(--oi-tone-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oi-ff-roll{display:inline-flex;vertical-align:top}.oi-ff-rolld{display:inline-block;height:1.15em;overflow:hidden}.oi-ff-rollc{display:flex;flex-direction:column;transition:transform 700ms cubic-bezier(.2,.8,.2,1)}.oi-ff-rollc>span{height:1.15em;line-height:1.15}
.oi-ff-spark{display:block;width:100%;max-width:${STAT.SPARK_MAX}px;min-width:0;height:12px}
@container ffcells (max-width:${STAT_WRAP_PX}px){.oi-ff-cells{grid-template-columns:repeat(6,minmax(0,1fr))}}
.oi-ff-sparkbar{fill:var(--oi-tone-success);opacity:.9}
.oi-ff-pop-station{position:fixed;z-index:51;display:flex;flex-direction:column;gap:3px;width:360px;max-width:calc(100vw - 32px);padding:10px 12px;border:1px solid var(--oi-border);border-radius:10px;background:var(--oi-panel);color:var(--oi-text);font-size:12px;box-shadow:var(--oi-shadow-raised,0 6px 18px var(--oi-shadow));pointer-events:none}
.oi-ff-pop-station ul{margin:0;padding-left:16px;color:var(--oi-text-2,var(--oi-text))}
.oi-ff-ph{margin-top:5px;font:700 10.5px ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--oi-tone-muted)}
.oi-ff-checks{list-style:none;padding:0!important}
.oi-ff-checks li{display:grid;grid-template-columns:16px 1fr;column-gap:4px}
.oi-ff-checks li small{grid-column:2;color:var(--oi-tone-muted)}
.oi-ff-checks i{font-style:normal;font-weight:700}
.oi-ff-checks .c-yes i{color:var(--oi-tone-success)}.oi-ff-checks .c-no i{color:var(--oi-tone-failure)}.oi-ff-checks .c-unknown i{color:var(--oi-tone-attention)}.oi-ff-checks .c-not-connected i{color:var(--oi-tone-muted)}
.oi-ff-evline{font:10.5px ui-monospace,monospace;color:var(--oi-tone-muted)}
.oi-ff-hud{display:flex;gap:14px;flex-wrap:wrap;align-items:baseline;padding:8px 12px;font-size:12px;color:var(--oi-tone-muted)}
.oi-ff-hud b{font-size:13px;color:var(--oi-text)}
.oi-ff-mode{font:600 11px ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase}
.oi-ff-mode.live{color:var(--oi-tone-success)}.oi-ff-mode.catchup{color:var(--oi-tone-running)}
.oi-ff-mode button{font:inherit;text-transform:none;border:1px solid var(--oi-border);border-radius:5px;background:transparent;color:var(--oi-text);cursor:pointer;margin-left:4px}
.oi-ff-stat i{font:600 13px ui-monospace,monospace;font-style:normal;display:inline-block}
.oi-ff-tick{animation:oi-ff-pop .5s ease-out 1}
.oi-ff-t-muted{color:var(--oi-tone-muted)}.oi-ff-t-info{color:var(--oi-tone-info)}.oi-ff-t-running{color:var(--oi-tone-running)}.oi-ff-t-attention{color:var(--oi-tone-attention)}.oi-ff-t-success{color:var(--oi-tone-success)}.oi-ff-t-failure{color:var(--oi-tone-failure)}
.oi-ff.full .oi-ff-body{overflow:auto;align-items:start} /* the WHOLE section scrolls as one page: rail, silos and inspector */
.oi-ff.full .oi-ff-stage{overflow:visible;align-items:flex-start}
.oi-ff.full .oi-ff-svg{flex:1 1 0;height:auto;align-self:flex-start}
.oi-ff-svg.off{display:none!important} /* Iso is showing: the Floor SVG stays MOUNTED (its placement + wheel listener bind once to this node) */
.oi-ff-body{display:grid;grid-template-columns:minmax(0,1fr) var(--ff-side,0px);min-width:0}
/* The work tree is a strip BELOW the scene (owner 11:55): open = a short multi-column tree, closed = a slim bar; the scene keeps the full width. */
.oi-ff-treebar{flex:none;height:28px;border-top:1px solid var(--oi-border)}.oi-ff-treebar.open{height:var(--ff-tree-h,188px)}
.oi-ff-treebar .oi-ftr{height:100%;box-shadow:none}
.oi-ff-treebar .oi-ftr:not(.oi-ftr-shut){column-width:340px;column-gap:18px;column-fill:auto;overflow-x:auto;overflow-y:hidden;padding-right:34px}
.oi-ff-treebar .oi-bt-row,.oi-ff-treebar .oi-bt-root{break-inside:avoid}
.oi-ff-treebar .oi-ftr-sliver{flex-direction:row;justify-content:flex-start;padding:0 12px;gap:8px;align-items:center}
.oi-ff-treebar .oi-ftr-count{writing-mode:horizontal-tb}
.oi-ff-rail,.oi-ff-sidecol{min-width:0;overflow:hidden}.oi-ff-rail:empty,.oi-ff-sidecol:empty{display:none}
.oi-ff-stage{position:relative;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:flex-start;padding:0 12px 4px;min-width:0}
.oi-ff-stage>.oi-iso-svg{flex:1;min-width:0}
.oi-beads>.oi-ff{flex:1;min-height:0}.oi-beads .oi-ff-svg{min-height:560px}.oi-beads .oi-ff-stage{align-items:stretch}
.oi-ff-label.sliver{font-size:11px;letter-spacing:.18em;filter:none}
.oi-ff-svg{display:block;flex:1;width:100%;min-width:0;height:auto;touch-action:none;cursor:grab;border-radius:12px}
.oi-ff-floor{fill:var(--oi-bg)} /* the iso hero ground: --oi-bg, the blue-black of the cyberpunk look */
.oi-ff-gridline{fill:none;stroke:var(--oi-tone-running);stroke-width:.5;opacity:.16} /* the iso grid line: thin cyan, faint */
.oi-ff-stripe{fill:var(--oi-tone-failure);opacity:.35}
.oi-ff-s-intake{--tone:var(--oi-station-intake,var(--oi-tone-info))}.oi-ff-s-claim{--tone:var(--oi-station-claim,var(--oi-tone-running))}.oi-ff-s-build{--tone:var(--oi-station-build,var(--oi-tone-attention))}.oi-ff-s-gate{--tone:var(--oi-station-gate,var(--oi-accent,var(--oi-lane-2)))}.oi-ff-s-land{--tone:var(--oi-station-land,var(--oi-tone-success))} /* the same station hues as the iso (.oi-iso-s-*) */
.oi-ff-bay{transition:opacity .3s}.oi-ff-bay.dim{opacity:.45}
.oi-ff-art{opacity:.4} /* Animated: the art sits BEHIND the crates (document order) and dimmed so crates and labels stay readable */
.oi-ff-scenesw{display:inline-flex;gap:2px}
.oi-ff-scene-plain .oi-ff-halo{animation:none}
.oi-ff-vaultplain rect{fill:color-mix(in srgb,var(--oi-station-land,var(--oi-tone-success)) 8%,var(--oi-bg));stroke:color-mix(in srgb,var(--oi-station-land,var(--oi-tone-success)) 55%,transparent);stroke-width:1}
.oi-ff-vaultplain text{font:700 12px ui-monospace,monospace;letter-spacing:.12em;fill:var(--oi-station-land,var(--oi-tone-success));pointer-events:none}
.oi-ff-pad{fill:color-mix(in srgb,var(--tone) 4%,var(--oi-panel));stroke:color-mix(in srgb,var(--tone) 30%,transparent);stroke-width:1}
.oi-ff-bay.spot .oi-ff-pad{stroke:var(--tone);stroke-width:2;fill:color-mix(in srgb,var(--tone) 10%,transparent)}
.oi-ff-head{cursor:pointer}.oi-ff-headhit{fill:transparent}.oi-ff-head:hover .oi-ff-headhit{fill:var(--oi-hover)}
.oi-ff-label{font:700 17px ui-monospace,monospace;letter-spacing:.14em;fill:var(--tone);filter:drop-shadow(0 0 3px color-mix(in srgb,var(--tone) 45%,transparent))}
.oi-ff-count{font:700 17px ui-monospace,monospace;fill:var(--oi-text);letter-spacing:0}
.oi-ff-sub{font:600 10.5px ui-monospace,monospace;fill:var(--oi-tone-muted)}
.oi-ff-halo{fill:color-mix(in srgb,var(--oi-tone-failure) calc(6% + var(--sev,0)*14%),transparent);stroke:var(--oi-tone-failure);stroke-opacity:calc(.35 + var(--sev,0)*.5);stroke-width:1.5;animation:oi-ff-jam 3.4s ease-in-out infinite}
.oi-ff-bay.jam .oi-ff-sub{fill:var(--oi-tone-failure)}
.oi-ff-weather{font-size:10px;font-weight:600}
.oi-ff-fxspark{fill:var(--oi-tone-running);opacity:0;transform-box:fill-box;transform-origin:center;animation:oi-ff-spark 1.2s ease-out infinite}
.oi-ff-fxspark.still{animation:none;opacity:.8}
.oi-ff-burst{pointer-events:none}
.oi-ff-burstring{fill:none;stroke:var(--oi-tone-success);stroke-width:2;transform-box:fill-box;transform-origin:center;animation:oi-ff-burst 1.1s ease-out .45s 1 both}
.oi-ff-burstray{fill:none;stroke:var(--oi-tone-success);stroke-width:1.6;stroke-linecap:round;animation:oi-ff-burstray 1.1s ease-out .45s 1 both}
.oi-ff-shelfhead{font:700 10px ui-monospace,monospace;letter-spacing:.12em;fill:var(--oi-tone-success)}
.oi-ff-shelftext{font:10px ui-monospace,monospace;fill:var(--oi-text);pointer-events:none}
.oi-ff-shelfmore{font:10px ui-monospace,monospace;fill:var(--oi-tone-muted)}
.oi-ff-shelfrow{outline:none;cursor:pointer}.oi-ff-shelfhit{fill:transparent}
.oi-ff-shelfrow:hover .oi-ff-shelfhit,.oi-ff-shelfrow:focus-visible .oi-ff-shelfhit{fill:var(--oi-hover)}
.oi-ff-more rect{fill:var(--oi-panel);stroke:var(--oi-border)}.oi-ff-more text{font:600 11px ui-monospace,monospace;fill:var(--oi-text)}
.oi-ff-gantry rect{fill:color-mix(in srgb,var(--oi-tone-muted) 40%,var(--oi-panel));stroke:var(--oi-border)}
.oi-ff-lamp{fill:var(--tone);opacity:.85}
.oi-ff-svg.run .oi-ff-lamp,.oi-ff-svg.drift .oi-ff-lamp{animation:oi-ff-blink 1.2s steps(2,jump-none) infinite}
.oi-ff-scan{fill:var(--oi-tone-attention);opacity:.55;transform-box:fill-box;animation:oi-ff-scan 2.4s ease-in-out infinite alternate}
.oi-ff-beltbed{fill:color-mix(in srgb,var(--oi-tone-muted) 22%,var(--oi-panel));stroke:var(--oi-border)}
.oi-ff-edge{stroke:color-mix(in srgb,var(--oi-tone-running) 45%,transparent);stroke-width:1.2}
.oi-ff-chevrons path{fill:none;stroke:var(--oi-tone-muted);stroke-width:1.4;opacity:.55}
.oi-ff-svg.run .oi-ff-chevrons{animation:oi-ff-belt 1.1s linear infinite}
.oi-ff-svg.drift .oi-ff-chevrons{animation:oi-ff-belt 6s linear infinite}
.oi-ff-roller{fill:var(--oi-panel);stroke:var(--oi-tone-muted);stroke-opacity:.6}
.oi-ff-trail path{fill:none;stroke:var(--ff-accent);stroke-width:2.5;opacity:.85}
.oi-ff-trail circle{fill:var(--ff-accent)}.oi-ff-trail text{font:10px ui-monospace,monospace;fill:var(--oi-text)}
.oi-ff-pool0{stop-color:var(--oi-tone-running);stop-opacity:.45}.oi-ff-pool1{stop-color:var(--oi-tone-running);stop-opacity:0}
.oi-ff-poolglow{fill:url(#oi-ff-pool);pointer-events:none}
.oi-ff-tok{cursor:pointer;outline:none;transition:opacity .3s}.oi-ff-tok.dim{opacity:.22}
.oi-ff-crate{fill:color-mix(in srgb,var(--lane) 26%,var(--oi-panel));stroke:var(--lane);stroke-width:1.4}
.oi-ff-lid{fill:var(--lane);opacity:.55}
.oi-ff-tok.card .oi-ff-crate{fill:color-mix(in srgb,var(--lane) 14%,var(--oi-panel))}
.oi-ff-shadow{fill:var(--oi-shadow);opacity:.7}
.oi-ff-cid{font:600 10.5px ui-monospace,monospace;fill:var(--oi-text)}
.oi-ff-el{font:10px ui-monospace,monospace;fill:var(--oi-tone-muted)}
.oi-ff-seat{fill:none;stroke:var(--oi-tone-muted);stroke-dasharray:2 3}
.oi-ff-cid.dense{font-size:9px}.oi-ff-el.dense{font-size:8px}.oi-ff-cid.micro{font-size:8px}
.oi-ff-tx{font:700 9px ui-monospace,monospace;fill:var(--oi-tone-running)}
.oi-ff-swatchrow{display:inline-flex;align-items:center;gap:4px;margin-right:8px}.oi-ff-swatch{display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--lane)}
.oi-ff-logtitle{color:var(--oi-text-2,var(--oi-text));font-size:inherit}
.oi-ff-hatchline{fill:color-mix(in srgb,var(--oi-tone-muted) 30%,transparent)}.oi-ff-norecordtext{font:600 12px system-ui,sans-serif;fill:var(--oi-tone-muted);pointer-events:none}
.oi-ff-capbg{fill:color-mix(in srgb,var(--oi-text) 10%,transparent)}.oi-ff-cap[data-goto]{cursor:pointer}
.oi-ff-cap.waits .oi-ff-capbg{fill:color-mix(in srgb,var(--oi-tone-attention) 26%,transparent)}.oi-ff-cap.blocks .oi-ff-capbg{fill:color-mix(in srgb,var(--oi-tone-running) 22%,transparent)}
.oi-ff-cap.files .oi-ff-capbg{fill:color-mix(in srgb,var(--oi-drift,var(--oi-tone-attention)) 24%,transparent)}
.oi-ff-captext{font:600 8.5px ui-monospace,monospace;fill:var(--oi-text)}.oi-ff-captext.dense{font-size:7px}.oi-ff-cap[data-goto]:hover .oi-ff-captext{text-decoration:underline}
.oi-ff-dep{fill:none;stroke-width:2.2;stroke-linecap:round;pointer-events:none}.oi-ff-dep.up{stroke:var(--oi-tone-attention)}.oi-ff-dep.down{stroke:var(--oi-tone-running);stroke-dasharray:5 3}.oi-ff-dep.met{opacity:.45}
.oi-ff-dep.all{stroke:var(--oi-tone-attention);stroke-width:1.6;opacity:.32}.oi-ff-dep.all.met{opacity:.18}.oi-ff-dep.all.crit{stroke-width:2.8;opacity:.95}
.oi-ff-arrowhead.up{fill:var(--oi-tone-attention)}.oi-ff-arrowhead.down{fill:var(--oi-tone-running)}
.oi-ff-tok.dep-up .oi-ff-crate{stroke:var(--oi-tone-attention);stroke-width:2.4}.oi-ff-tok.dep-down .oi-ff-crate{stroke:var(--oi-tone-running);stroke-width:2.4;stroke-dasharray:4 2}.oi-ff-tok.dep-focus .oi-ff-crate{stroke:var(--ff-accent);stroke-width:2.8}
.oi-ff-deplist{margin:2px 0 4px;padding:0;list-style:none}.oi-ff-deplist li.met{opacity:.6}.oi-ff-deplist.up button span{color:var(--oi-tone-attention)}.oi-ff-deplist.down button span{color:var(--oi-tone-running)}
.oi-ff-svg.heat .heat-3 :is(.oi-ff-cid,.oi-ff-el),.oi-ff-svg.heat .heat-4 :is(.oi-ff-cid,.oi-ff-el){fill:var(--oi-bg)}
.oi-ff-prio{fill:var(--oi-tone-attention)}
.oi-ff-mark{font:700 13px system-ui,sans-serif;fill:var(--oi-text)}
.oi-ff-down{font:600 9.5px ui-monospace,monospace;fill:var(--oi-tone-failure)}
.oi-ff-shimmer{fill:var(--oi-tone-running);opacity:.85;animation:oi-ff-shimmer 1.4s ease-in-out infinite alternate}
.oi-ff-barrier rect{fill:var(--oi-tone-failure)}.oi-ff-boom{fill:url(#oi-ff-stripe);stroke:var(--oi-tone-failure);stroke-width:1}
.oi-ff-tok.hot .oi-ff-crate{stroke:var(--oi-tone-failure);fill:color-mix(in srgb,var(--oi-tone-failure) calc(var(--heat,0)*40%),color-mix(in srgb,var(--lane) 26%,var(--oi-panel)))}
.oi-ff-tok.blocked .oi-ff-crate{stroke:var(--oi-tone-failure);stroke-dasharray:3 2}
.oi-ff-tok.locked .oi-ff-crate{stroke:var(--oi-tone-failure);stroke-width:1.8} /* waiting / locked: a red outline plus the padlock, as in the iso */
.oi-ff-crate{filter:drop-shadow(0 0 2px color-mix(in srgb,var(--lane) 32%,transparent))}
.oi-ff-tok.rework .oi-ff-crate{stroke:var(--oi-tone-attention);stroke-width:2.2}
.oi-ff-tok.fresh .oi-ff-lid{animation:oi-ff-flash .6s ease-out 2}
.oi-ff-tok.blocker .oi-ff-crate{stroke:var(--oi-tone-failure);stroke-width:2.6}
.oi-ff-tok.sel .oi-ff-crate,.oi-ff-tok.hov .oi-ff-crate,.oi-ff-tok:focus-visible .oi-ff-crate{stroke:var(--ff-accent);stroke-width:2.4}
.oi-ff-tok.followed .oi-ff-crate{stroke:var(--ff-accent);stroke-width:3}
.oi-ff-critring{fill:none;stroke:var(--oi-accent,var(--oi-tone-info));stroke-width:1.6;stroke-dasharray:5 3} /* the critical-path dashed halo, as .oi-iso-ring */
.oi-ff-padlock .oi-ff-lockbody{fill:var(--oi-tone-failure);stroke:var(--oi-bg);stroke-width:.8}
.oi-ff-shackle{fill:none;stroke:var(--oi-tone-failure);stroke-width:1.8;stroke-linecap:round;transition:transform .2s}
.oi-ff-keyhole{fill:var(--oi-bg)}
.oi-ff-padlock.open .oi-ff-shackle{transform:translate(2px,-3px)}
.oi-ff-padlock.open .oi-ff-lockbody{fill:var(--oi-tone-success)}.oi-ff-padlock.open .oi-ff-shackle{stroke:var(--oi-tone-success)}
.oi-ff-snap{transform-box:fill-box;transform-origin:center;animation:oi-ff-snap .45s cubic-bezier(.3,1.6,.5,1) 1}
.oi-ff-snap .oi-ff-shackle{animation:oi-ff-shut .45s ease-in 1}
.oi-ff-pop{opacity:0;animation:oi-ff-pop-open 1.1s ease-out 1}
.oi-ff-chain{stroke:var(--oi-tone-failure);stroke-width:2;stroke-dasharray:4 2.5;stroke-linecap:round;opacity:.85;pointer-events:none;animation:oi-ff-in .35s ease-out 1}
.oi-ff-chain.gate{stroke:var(--oi-tone-muted);stroke-dasharray:.5 4;stroke-width:2.6;pointer-events:stroke}.oi-ff-chain.scope{stroke:var(--oi-drift,var(--oi-tone-attention))}
.oi-ff-svg.heat .oi-ff-tok .oi-ff-crate{stroke:var(--oi-border)}
.oi-ff-svg.heat .heat-0 .oi-ff-crate{fill:var(--ff-h0)}.oi-ff-svg.heat .heat-1 .oi-ff-crate{fill:var(--ff-h1)}.oi-ff-svg.heat .heat-2 .oi-ff-crate{fill:var(--ff-h2)}.oi-ff-svg.heat .heat-3 .oi-ff-crate{fill:var(--ff-h3)}.oi-ff-svg.heat .heat-4 .oi-ff-crate{fill:var(--ff-h4)}
.oi-ff-svg.heat .heat-3 .oi-ff-mark,.oi-ff-svg.heat .heat-4 .oi-ff-mark{fill:var(--oi-bg)}
.oi-ff-svg.heat .heat-none .oi-ff-crate{fill:url(#oi-ff-stripe);opacity:.5}
.oi-ff-svg.heat .oi-ff-tok.sel .oi-ff-crate,.oi-ff-svg.heat .oi-ff-tok.followed .oi-ff-crate{stroke:var(--ff-accent)}
.oi-ff-return{--rw:var(--oi-rework,var(--oi-tone-attention))}
.oi-ff-lanebed{fill:color-mix(in srgb,var(--rw) 14%,var(--oi-panel));stroke:color-mix(in srgb,var(--rw) 40%,transparent);stroke-width:1}
.oi-ff-laneedge{stroke:color-mix(in srgb,var(--rw) 55%,transparent);stroke-width:1.2}
.oi-ff-chute,.oi-ff-ramp{fill:color-mix(in srgb,var(--rw) 10%,transparent);stroke:color-mix(in srgb,var(--rw) 45%,transparent);stroke-width:1;stroke-dasharray:3 2}
.oi-ff-lanechev path{fill:none;stroke:var(--rw);stroke-width:1.2;opacity:.45}
.oi-ff-return .oi-ff-lanechev{animation:oi-ff-lane 8s linear infinite}.oi-ff-return.active .oi-ff-lanechev{animation-duration:1.2s}
.oi-ff-return:not(.active){opacity:.6}
.oi-ff-return.active .oi-ff-lanechev path{opacity:.9}
.oi-ff-return.active .oi-ff-laneedge{filter:drop-shadow(0 0 3px var(--rw))}
.oi-ff-return.heat.heat-1{--rw:var(--ff-h1)}.oi-ff-return.heat.heat-2{--rw:var(--ff-h2)}.oi-ff-return.heat.heat-3{--rw:var(--ff-h3)}.oi-ff-return.heat.heat-4{--rw:var(--ff-h4)}
.oi-ff-return.heat .oi-ff-lanebed{fill:color-mix(in srgb,var(--rw) 45%,var(--oi-panel))}
.oi-ff-lanebadge rect{fill:var(--oi-panel);stroke:color-mix(in srgb,var(--rw) 60%,transparent)}.oi-ff-lanebadge text{font:600 10px ui-monospace,monospace;fill:var(--rw)}
.oi-ff-ride{display:none;pointer-events:none}.oi-ff-tok.riding .oi-ff-ride{display:inline}
.oi-ff-rideglow{fill:color-mix(in srgb,var(--oi-tone-attention) 30%,transparent);opacity:.7}
.oi-ff-ridetag{font:600 16px ui-monospace,monospace;fill:var(--oi-tone-attention)}
.oi-ff-heatkey{display:inline-flex;gap:3px;align-items:center}.oi-ff-heatkey i{width:14px;height:10px;border-radius:2px;display:inline-block}
.oi-ff-heatkey .heat-0{background:var(--ff-h0)}.oi-ff-heatkey .heat-1{background:var(--ff-h1)}.oi-ff-heatkey .heat-2{background:var(--ff-h2)}.oi-ff-heatkey .heat-3{background:var(--ff-h3)}.oi-ff-heatkey .heat-4{background:var(--ff-h4)}
.oi-ff-exit{opacity:0;animation:oi-ff-out .5s ease-out 1}
.oi-ff-exit .oi-ff-crate{--lane:var(--oi-tone-muted)}
${Array.from({ length: 8 }, (_, n) => `.oi-ln-${n}{--lane:var(--oi-lane-${n})}`).join("")}
.oi-ff-worker{--who:var(--oi-tone-running);cursor:pointer}
.oi-ff-worker .oi-ff-body{fill:color-mix(in srgb,var(--agent,var(--m,var(--who))) 42%,var(--oi-panel));stroke:var(--who);stroke-width:1.6}
.oi-ff-worker:hover .oi-ff-body{stroke-width:2.6}.oi-ff-worker.followed .oi-ff-body{stroke:var(--ff-accent);stroke-width:3}
.oi-ff-m-opus{--m:var(--oi-lane-2)}.oi-ff-m-sonnet{--m:var(--oi-lane-4)}.oi-ff-m-codex{--m:var(--oi-lane-3)}.oi-ff-m-haiku{--m:var(--oi-lane-6)}.oi-ff-m-other{--m:var(--oi-lane-7)}
.oi-ff-worker.ghost{--who:var(--oi-tone-attention);opacity:.55}.oi-ff-worker.ghost .oi-ff-body{stroke-dasharray:3 3}
.oi-ff-worker.past{--who:var(--oi-tone-muted);opacity:.8}
.oi-ff-worker.stale .oi-ff-body{stroke:var(--oi-tone-attention)}
.oi-ff-worker.crit .oi-ff-body{stroke-width:2.6}
.oi-ff-glyph{font:700 11px ui-monospace,monospace;fill:var(--oi-text);pointer-events:none}
.oi-ff-letter{font:800 7px ui-monospace,monospace;fill:var(--oi-text);pointer-events:none}.oi-ff-lettertagbg{fill:var(--oi-bg);stroke:var(--oi-border,var(--oi-tone-muted));stroke-width:.8}
.oi-ff-icon{pointer-events:none}.oi-ff-icon.stroke{fill:none;stroke:var(--oi-text);stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.oi-ff-icon.fill{fill:var(--oi-text)}
.oi-ff-crown{fill:var(--oi-crown,var(--oi-tone-attention));stroke:var(--oi-bg);stroke-width:.8;stroke-linejoin:round}
.oi-ff-cape{fill:var(--oi-cape,var(--oi-lane-5));opacity:.92;transform-box:fill-box;transform-origin:50% 0}
.oi-ff-cape.flutter{animation:oi-ff-cape 2.2s ease-in-out infinite alternate}
.oi-tl-tools .oi-ff-keybtn,.oi-tl-tools .oi-ff-chainbtn,.oi-tl-tools .oi-ff-viewseg button,.oi-tl-tools .oi-ff-railbtn,.oi-tl-tools .oi-fsx-toggle{font:500 14px ui-monospace,monospace;min-width:30px;min-height:30px;padding:0 6px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--oi-tone-muted);cursor:pointer}
.oi-tl-tools .oi-ff-viewseg{display:inline-flex;gap:0;margin:0 2px}
.oi-tl-tools .oi-ff-viewseg button[aria-pressed=true],.oi-tl-tools .oi-ff-railbtn[aria-pressed=true],.oi-tl-tools .oi-ff-keybtn[aria-pressed=true]{background:var(--oi-selected);color:var(--oi-text)}
.oi-tl-tools .oi-ff-viewseg button:hover,.oi-tl-tools .oi-ff-railbtn:hover,.oi-tl-tools .oi-fsx-toggle:hover{color:var(--oi-text)}
.oi-tl-tools .oi-ff-chainbtn.lit::after{content:none}
.oi-tl-tools .oi-ff-chainbtn[aria-haspopup]{font-size:12px}
.oi-tl-tools .oi-ff-keybtn,.oi-tl-tools .oi-ff-chainbtn,.oi-tl-tools .oi-ff-viewseg button,.oi-tl-tools .oi-ff-railbtn,.oi-tl-tools .oi-fsx-toggle{display:inline-flex;align-items:center;white-space:nowrap}
.oi-tb-g{font-style:normal}
.oi-ff>.oi-tl{border-bottom:0}
.oi-ff-body{flex:1 1 auto;min-height:0}
.oi-ff[data-view=floor] .oi-ff-svg{margin-top:56px}
.oi-ff-tok.lifted{opacity:0}.oi-ff-prunenote{align-self:center;font:600 11px ui-monospace,monospace;color:var(--oi-tone-success)}
.oi-ff-vaulthit{fill:transparent}.oi-ff-vaultbody{fill:color-mix(in srgb,var(--oi-tone-muted) 14%,transparent);stroke:var(--oi-tone-muted);stroke-width:1.5}.oi-ff-vaultdial{fill:none;stroke:var(--oi-tone-muted);stroke-width:2}.oi-ff-vaulttext{font:700 11px ui-monospace,monospace;fill:var(--oi-text-2)}
.oi-ff-vault{cursor:pointer;outline:none}.oi-ff-vault.busy .oi-ff-vaultbody{stroke:var(--oi-tone-success)}.oi-ff-ghost{pointer-events:none}
.oi-ff-keybtn,.oi-ff-chainbtn{font:500 11px ui-monospace,monospace;letter-spacing:.04em;min-height:26px;padding:0 9px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--oi-tone-muted);cursor:pointer}
.oi-ff-chainbtn.lit{background:color-mix(in srgb,var(--oi-accent,var(--oi-tone-info)) 18%,transparent);color:var(--oi-text);border-color:var(--oi-accent,var(--oi-tone-info));box-shadow:0 0 8px color-mix(in srgb,var(--oi-accent,var(--oi-tone-info)) 45%,transparent)}
.oi-ff-chainbtn.lit::after{content:" · on";opacity:.7}.oi-ff-chainbtn.lit[aria-haspopup]::after,.oi-ff-pruneask .oi-ff-chainbtn.lit::after{content:none}
.oi-ff-ws{position:relative;display:inline-block}.oi-ff-wslist{position:absolute;right:0;top:100%;z-index:6;display:flex;flex-direction:column;min-width:200px;max-width:320px;padding:4px;border:1px solid var(--oi-border);border-radius:8px;background:var(--oi-panel)}
.oi-ff-wslist button{display:flex;align-items:center;gap:6px;min-height:28px;padding:0 8px;border:0;background:transparent;color:var(--oi-text);font:11px ui-monospace,monospace;text-align:left;cursor:pointer;border-radius:5px}.oi-ff-wslist button:hover,.oi-ff-wslist button[aria-selected=true]{background:var(--oi-selected)}
.oi-ff-pruneask{display:inline-flex;gap:4px;align-items:center}
.oi-ff-heatcorner{position:absolute;left:18px;top:62px;z-index:3;display:inline-flex;gap:3px;align-items:center;padding:3px 6px;border:1px solid var(--oi-border);border-radius:6px;background:color-mix(in srgb,var(--oi-bg) 82%,transparent);pointer-events:none}.oi-ff-heatcorner small{font:600 9.5px ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--oi-tone-muted);margin-right:3px}
.oi-ff-keybtn:hover,.oi-ff-chainbtn:hover{color:var(--oi-text);border-color:var(--oi-border)}
.oi-ff-keybtn[aria-pressed=true],.oi-ff-chainbtn[aria-pressed=true]{background:var(--oi-selected);color:var(--oi-text)}
.oi-ff-keypop{position:absolute;right:12px;top:64px;z-index:5;max-width:min(560px,calc(100% - 24px));padding:10px 12px;border:1px solid var(--oi-border-strong);border-radius:10px;background:var(--oi-raised,var(--oi-panel));box-shadow:var(--oi-shadow-raised,0 8px 24px var(--oi-shadow));display:flex;flex-direction:column;gap:8px;font-size:12px}
.oi-ff-keygrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 16px}
.oi-ff-keyitem{display:flex;gap:8px;align-items:center;min-width:0;white-space:nowrap;color:var(--oi-text-2);cursor:help}.oi-ff-keyitem.wide{grid-column:1/-1}
.oi-ff-keyitem i{font-style:normal;min-width:26px;display:inline-flex;justify-content:center;color:var(--oi-text)}.oi-ff-keyitem svg{overflow:visible}
.oi-ff-heatchip{min-width:14px;padding:1px 5px;border-radius:3px;display:inline-block;font:600 10px ui-monospace,monospace;font-style:normal;text-align:center}.oi-ff-heatchip.heat-0{background:var(--ff-h0)}.oi-ff-heatchip.heat-1{background:var(--ff-h1)}.oi-ff-heatchip.heat-2{background:var(--ff-h2)}.oi-ff-heatchip.heat-3{background:var(--ff-h3)}.oi-ff-heatchip.heat-4{background:var(--ff-h4)}
.oi-ff-epics{display:flex;gap:12px;flex-wrap:nowrap;overflow:hidden;margin:0 12px;padding:4px 0;font-size:11px;color:var(--oi-tone-muted);white-space:nowrap}
.oi-ff-epic{display:inline-flex;gap:5px;align-items:center;min-width:0}.oi-ff-epic b{font:700 11px ui-monospace,monospace;color:var(--oi-text-2)}
@keyframes oi-ff-cape{0%{transform:skewX(-5deg) scaleY(.96)}100%{transform:skewX(5deg) scaleY(1.03)}}
.oi-ff-cost{font:10px ui-monospace,monospace;fill:var(--oi-tone-muted)}
.oi-ff-tether{stroke:var(--who);stroke-opacity:.35;stroke-width:1;stroke-dasharray:2 3;animation:oi-ff-in .6s ease-out 1}
.oi-ff-beat{fill:none;stroke:var(--who);stroke-width:2;transform-box:fill-box;transform-origin:center;animation:oi-ff-beat 1.4s ease-out infinite}
.oi-ff-key{fill:none;stroke:var(--oi-tone-running);stroke-width:1.4}
.oi-ff-side{width:208px;flex:none;display:flex;flex-direction:column;gap:14px;font-size:12px}
.oi-ff-side section{display:flex;flex-direction:column;gap:3px;padding:0 0 0 10px;border-left:2px solid color-mix(in srgb,var(--oi-border-strong) 80%,transparent)}
.oi-ff-side section>b{font:700 14px/1.3 ui-monospace,monospace;color:var(--oi-text);margin-bottom:2px}
.oi-ff-side h4{margin:0 0 4px;display:flex;justify-content:space-between;font:700 10px ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--oi-tone-muted)}
.oi-ff-side h4 button{border:0;background:transparent;color:var(--oi-text);cursor:pointer;min-width:24px;min-height:24px}
.oi-ff-side span,.oi-ff-side small{color:var(--oi-tone-muted)}
.oi-ff-side ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;max-height:300px;overflow:auto}
.oi-ff-side li button{all:unset;box-sizing:border-box;display:block;width:100%;padding:4px 6px;border-radius:6px;cursor:pointer;color:var(--oi-text)}
.oi-ff-side li button:hover,.oi-ff-side li button:focus-visible{background:var(--oi-hover)}
.oi-ff-side li button span{font:11px ui-monospace,monospace}.oi-ff-side li small{display:block}
.oi-ff-log li{display:grid;grid-template-columns:42px 1fr;gap:6px;font:11.5px ui-monospace,monospace;padding-left:6px;box-shadow:inset 3px 0 0 transparent}
.oi-ff-log li.oi-ws{box-shadow:inset 3px 0 0 var(--agent,var(--lane))} /* the per-AGENT hue (lane token), not the workstream's */
.oi-ff-logtime{color:var(--oi-tone-muted)}
.oi-ff-logid{font-weight:700;padding:0 4px;border-radius:3px;color:var(--agent,var(--lane));background:color-mix(in srgb,var(--agent,var(--lane)) var(--oi-tint,16%),transparent)}
.oi-ff-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
.oi-ff-logglyph{vertical-align:-2px;margin-right:4px;flex:none}.oi-ff-log li.new{animation:oi-ff-slide .45s ease-out 1}
.oi-ff-log li.earlier .oi-ff-logmsg{font-style:italic}
.oi-ff-tip{position:fixed;z-index:50;pointer-events:none;display:flex;flex-direction:column;gap:2px;max-width:340px;padding:8px 10px;border:1px solid var(--oi-border);border-radius:8px;background:var(--oi-panel);color:var(--oi-text);font-size:12px;box-shadow:var(--oi-shadow-raised,0 4px 14px var(--oi-shadow))}
.oi-ff-tip span{color:var(--oi-tone-muted)}.oi-ff-tiptrail{font:11px ui-monospace,monospace;color:var(--oi-text)!important}
.oi-ff-empty{padding:10px 12px;font-size:13px;color:var(--oi-tone-muted)}
@keyframes oi-ff-belt{to{transform:translateX(32px)}}
@keyframes oi-ff-lane{to{transform:translateX(-18px)}}
@keyframes oi-ff-beat{0%{transform:scale(1);opacity:.8}100%{transform:scale(1.9);opacity:0}}
@keyframes oi-ff-jam{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes oi-ff-blink{50%{opacity:.25}}
@keyframes oi-ff-spark{0%{opacity:0;transform:translate(0,0) scale(.4)}12%{opacity:1;transform:translate(1px,-1px) scale(1)}45%{opacity:0;transform:translate(3px,-9px) scale(.6)}100%{opacity:0;transform:translate(3px,-9px) scale(.6)}}
@keyframes oi-ff-burst{0%{opacity:1;transform:scale(.4)}100%{opacity:0;transform:scale(2)}}
@keyframes oi-ff-burstray{0%{opacity:0}25%{opacity:1}100%{opacity:0}}
@keyframes oi-ff-scan{from{transform:translateY(0)}to{transform:translateY(${BELT_Y - 70}px)}}
@keyframes oi-ff-shimmer{from{transform:translateX(0)}to{transform:translateX(${T - 14}px)}}
@keyframes oi-ff-flash{0%{opacity:1}100%{opacity:.55}}
@keyframes oi-ff-pop{0%{transform:translateY(-4px);opacity:.3}100%{transform:none;opacity:1}}
@keyframes oi-ff-snap{0%{transform:scale(1.9);opacity:0}60%{transform:scale(.9);opacity:1}100%{transform:scale(1)}}
@keyframes oi-ff-shut{0%{transform:translateY(-4px)}70%{transform:translateY(-4px)}100%{transform:none}}
@keyframes oi-ff-pop-open{0%{opacity:1;transform:none}60%{opacity:1;transform:translateY(-6px)}100%{opacity:0;transform:translateY(-10px)}}
@keyframes oi-ff-slide{from{transform:translateX(-10px);opacity:0}to{transform:none;opacity:1}}
@keyframes oi-ff-out{from{opacity:1}to{opacity:0}}
@keyframes oi-ff-in{from{opacity:0}to{opacity:1}}
@media (max-width:900px){.oi-ff-stage{flex-direction:column;flex-wrap:nowrap}.oi-ff-side{width:auto;align-self:stretch}}
@media (prefers-reduced-motion:reduce){.oi-ff-halo,.oi-ff-chevrons,.oi-ff-lamp,.oi-ff-scan,.oi-ff-beat,.oi-ff-lid,.oi-ff-shimmer,.oi-ff-tick,.oi-ff-snap,.oi-ff-snap .oi-ff-shackle,.oi-ff-log li.new,.oi-ff-chain,.oi-ff-tether,.oi-ff-lanechev,.oi-ff-cape{animation:none!important}.oi-ff-fxspark{animation:none!important;opacity:.8}.oi-ff-burstring{animation:none!important;opacity:.9}.oi-ff-burstray{display:none}.oi-ff-ride{display:none!important}.oi-ff-exit,.oi-ff-pop{display:none}.oi-ff-bay,.oi-ff-tok{transition:none}}
`;
