// Factory, isometric (pure, no React, no colours): the SAME floor frame as FactoryFloor (floorAt), laid out in a 2:1 isometric
// world instead of a flat strip. This file derives NO work state: stations, crates, locks, agents and the critical path all come
// from the frame, and it draws EVERY token and worker the frame holds (no cap of its own: a station past the frame's own cap
// says so with the frame's `overflow`); it only decides WHERE each thing stands and in WHAT ORDER to paint it.
// The world: a belt shaped like a V on a grid (arm A runs +x, down-right on screen; arm B runs -y, up-right). Each station's
// stretch of belt follows the frame's own bay x / w (silo widths: an empty silo is a sliver, a busy one grows), so a wide
// silo is a long machine bay with a long queue. Five machines stand on the inside of the V; crates queue upstream of their
// machine on the belt and the apron beside it, stacked in as many layers as needed; Intake and Land pile theirs on a pad;
// agents stand in rows on the outside of the V. Grid units are cells; z is in screen pixels (up). Painting order is a
// topological sort over axis-aligned boxes (sortIso).
// APPROXIMATIONS, stated:
//   - Agents stand in rows by their station, not beside their own crate.
//   - Crates glide between frames by a CSS transition on their position, not along the belt path; the return lane only
//     carries a crate the view was told was JUST sent back (`lane`), as FactoryFloor does.
//   - A machine that would straddle the belt's corner is moved clear of it, and stations keep their order and a gap, so under
//     extreme silo widths a station can sit a little off its bay's centre.
//   - The hover text is the one FactoryFloor shows, rebuilt here from the same model outputs: fold the two into this one
//     function when the Floor file is free to edit.
import { FLOOR, STATIONS, STATION_TEXT, cardLine, lockDetail, type FloorFrame, type FloorStation, type FloorToken, type FloorWorker, type TrailStop, type WhereIs } from "./factory-floor-model.ts";
import { sparkLanes, weatherOf } from "./factory-fx.ts";
import { stageLabel } from "./replay.ts";
import { formatAge, shortId } from "./surface-model.ts";
import { capitalise, termLabel } from "./glossary.ts";
import type { StationId } from "./station-rules.ts";
import type { ChainEdge } from "./block-chain.ts";
import { heatColorVar, heatTextVar } from "./heat-ramps.ts";
import type { HeatMode } from "./factory-floor-model.ts";

export type P = { x: number; y: number };
/** Grid vector. */
export type G = { x: number; y: number };
export const ISO = {
  /** Half a tile's width on screen: one grid step in x moves the screen by (U, U/2), in y by (-U, U/2). */
  U: 40,
  /** Arm A of the belt is LA cells long (along +x), arm B runs on to END (along -y). */
  LA: 9, END: 20, BELT_W: 1.1, BELT_H: 5,
  CRATE: 0.54, CRATE_H: 18, LAYER_GAP: 1, STEP: 0.62,
  /** Crate columns across the belt and the apron beside it (0 = the belt's centre line), and a pile's columns / rows on its pad. */
  COLS: [0, 0.62, 1.24] as readonly number[], PILE: 3, PILE_PITCH: 0.64,
  /** Agents: pitch along a row, the first row's distance from the belt, the gap between rows. */
  BOT_PITCH: 0.62, BOT_ROW0: 2.25, BOT_ROWS: 0.65,
  LANE_OFF: 1.78, // between the crate columns (reach 1.51) and the first row of agents (from 2.08)
  LANE_Z: 2, PAD_Z: 3, DOCK_Z: 8,
} as const;

const r1 = (n: number) => Math.round(n * 10) / 10;
export const proj = (x: number, y: number, z = 0): P => ({ x: (x - y) * ISO.U, y: ((x + y) * ISO.U) / 2 - z });
const pts = (...ps: P[]) => ps.map(p => `${r1(p.x)},${r1(p.y)}`).join(" ");

// ---- belt -------------------------------------------------------------------------------------------------------------
/** A point on the belt with the way it flows (`dir`) and the side facing the viewer (`near`, the OUTSIDE of the V). */
export type BeltFrame = { g: G; dir: G; near: G };
export function beltFrame(c: number): BeltFrame {
  const k = Math.max(0, Math.min(ISO.END, c));
  return k <= ISO.LA ? { g: { x: k, y: 0 }, dir: { x: 1, y: 0 }, near: { x: 0, y: 1 } } : { g: { x: ISO.LA, y: -(k - ISO.LA) }, dir: { x: 0, y: -1 }, near: { x: 1, y: 0 } };
}
/** The belt's centre line on screen at height z, corner included: the dashed flow path. */
export const beltPath = (z = ISO.BELT_H, from = 0, to = ISO.END): P[] => {
  const cs = [from, ...(from < ISO.LA && to > ISO.LA ? [ISO.LA] : []), to];
  return cs.map(c => { const f = beltFrame(c); return proj(f.g.x, f.g.y, z); });
};
/** The return lane under the belt on its outside, Gate back to Build, as a screen path (the corner takes both offsets). */
export function lanePath(lay: IsoLayout = isoLayoutOf(EVEN)): P[] {
  const a = beltFrame(lay.build.c), b = beltFrame(lay.gate.c), o = ISO.LANE_OFF, z = ISO.LANE_Z;
  return [proj(a.g.x + a.near.x * o, a.g.y + a.near.y * o, z), proj(ISO.LA + o, o, z), proj(b.g.x + b.near.x * o, b.g.y + b.near.y * o, z)];
}

// ---- boxes ------------------------------------------------------------------------------------------------------------
export type Bounds = { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number };
export type Faces = { top: string; left: string; right: string };
/** An axis-aligned box at `along` / `across` the belt at a station's frame (across > 0 = the viewer's side), sized in cells. */
export function rectAt(f: BeltFrame, along: number, across: number, wAlong: number, wAcross: number, z0: number, z1: number): Bounds {
  const cx = f.g.x + f.dir.x * along + f.near.x * across, cy = f.g.y + f.dir.y * along + f.near.y * across;
  const hx = (Math.abs(f.dir.x) * wAlong + Math.abs(f.near.x) * wAcross) / 2, hy = (Math.abs(f.dir.y) * wAlong + Math.abs(f.near.y) * wAcross) / 2;
  return { x0: cx - hx, x1: cx + hx, y0: cy - hy, y1: cy + hy, z0, z1 };
}
/** The three faces a viewer sees: the top, the face toward +y (down-left) and the face toward +x (down-right). */
export function boxFaces(b: Bounds): Faces {
  const a = (x: number, y: number, z: number) => proj(x, y, z);
  return {
    top: pts(a(b.x0, b.y0, b.z1), a(b.x1, b.y0, b.z1), a(b.x1, b.y1, b.z1), a(b.x0, b.y1, b.z1)),
    left: pts(a(b.x0, b.y1, b.z1), a(b.x1, b.y1, b.z1), a(b.x1, b.y1, b.z0), a(b.x0, b.y1, b.z0)),
    right: pts(a(b.x1, b.y0, b.z1), a(b.x1, b.y1, b.z1), a(b.x1, b.y1, b.z0), a(b.x1, b.y0, b.z0)),
  };
}
/** Every crate has this shape, drawn about its own base centre (so the view moves it with a translate). */
export const CRATE_FACES: Faces = boxFaces({ x0: -ISO.CRATE / 2, x1: ISO.CRATE / 2, y0: -ISO.CRATE / 2, y1: ISO.CRATE / 2, z0: 0, z1: ISO.CRATE_H });
const hx = ISO.CRATE / 2, vtx = (x: number, y: number, z: number) => proj(x, y, z);
/** The crate's outline (a hexagon) for the selection highlight, and the flat diamond just outside its footprint for the critical-path ring. */
export const CRATE_SILHOUETTE = pts(vtx(-hx, -hx, ISO.CRATE_H), vtx(hx, -hx, ISO.CRATE_H), vtx(hx, -hx, 0), vtx(hx, hx, 0), vtx(-hx, hx, 0), vtx(-hx, hx, ISO.CRATE_H));
export const CRATE_RING = pts(vtx(-hx - 0.14, -hx - 0.14, 0), vtx(hx + 0.14, -hx - 0.14, 0), vtx(hx + 0.14, hx + 0.14, 0), vtx(-hx - 0.14, hx + 0.14, 0));
export const BOT = { w: 0.32, torso: 14, head: 9, headW: 0.24, h: 28 } as const;
export const BOT_FACES = { body: boxFaces({ x0: -BOT.w / 2, x1: BOT.w / 2, y0: -BOT.w / 2, y1: BOT.w / 2, z0: 0, z1: BOT.torso }), head: boxFaces({ x0: -BOT.headW / 2, x1: BOT.headW / 2, y0: -BOT.headW / 2, y1: BOT.headW / 2, z0: BOT.torso + 1, z1: BOT.torso + 1 + BOT.head }) };

// ---- painter's order --------------------------------------------------------------------------------------------------
export type Sortable = { key: string; b: Bounds };
const EPS = 1e-6, centre = (b: Bounds) => (b.x0 + b.x1 + b.y0 + b.y1) / 2 + (b.z0 + b.z1) / 2000;
/** 1 when `a` must be painted before `b` (a is behind or beneath it), -1 when after, 0 when either order is right. Larger x and
 * larger y are nearer the viewer, larger z is higher: a box separated in x or y is ordered by that; boxes that share a footprint
 * are ordered by height. */
export function behind(a: Bounds, b: Bounds): 1 | -1 | 0 {
  const aB = a.x1 <= b.x0 + EPS || a.y1 <= b.y0 + EPS, bB = b.x1 <= a.x0 + EPS || b.y1 <= a.y0 + EPS;
  if (aB && !bB) return 1; if (bB && !aB) return -1;
  if (a.z1 <= b.z0 + EPS) return 1; if (b.z1 <= a.z0 + EPS) return -1;
  return 0;
}
/** Paint order, back to front: a topological sort over `behind`, ties (and any cycle) broken by nearness then key, so the
 * order is deterministic. O(n^2) in the number of boxes, fine for a floor of a few hundred. */
export function sortIso<T extends Sortable>(items: readonly T[]): T[] {
  const n = items.length, out: T[] = [], edges: number[][] = items.map(() => []), indeg = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const d = behind(items[i].b, items[j].b); if (d === 1) { edges[i].push(j); indeg[j]++; } else if (d === -1) { edges[j].push(i); indeg[i]++; } }
  const order = (i: number, j: number) => centre(items[i].b) - centre(items[j].b) || (items[i].key < items[j].key ? -1 : items[i].key > items[j].key ? 1 : 0);
  const left = new Set(items.map((_, i) => i));
  while (left.size) {
    const ready = [...left].filter(i => indeg[i] === 0).sort(order), pick = ready[0] ?? [...left].sort(order)[0]; // a cycle cannot be ordered: take the nearest-to-back
    left.delete(pick); out.push(items[pick]); for (const j of edges[pick]) indeg[j]--;
  }
  return out;
}

// ---- layout from the frame's bays ---------------------------------------------------------------------------------------
/** One station's place on the belt: its machine's centre `c` (cells along the belt), the length of belt its bay owns, a machine
 * scale `s` (an empty silo is a sliver: small and idle), the machine's half depth, the half depth the next queue must clear, and
 * how many crates fit in a row along the belt upstream of it. */
export type StationLay = { id: StationId; c: number; len: number; s: number; half: number; rear: number; nAlong: number; idle: boolean };
export type IsoLayout = Readonly<Record<StationId, StationLay>>;
const HALF0: Readonly<Record<StationId, number>> = { intake: 0.75, claim: 0.5, build: 0.95, gate: 0.4, land: 1.15 };
/** How far a machine reaches ACROSS the belt (half its width, pad excluded): the belt's corner turns it into an along-the-belt extent for its neighbour, so the corner clearance uses the larger of this and `half`. */
const REACH0: Readonly<Record<StationId, number>> = { intake: 1.45, claim: 1.05, build: 1.7, gate: 1, land: 1 };
/** What the next station's queue must clear: Intake's pad reaches further than its hopper. */
const REAR0: Readonly<Record<StationId, number>> = { intake: 0.95, claim: 0.5, build: 0.95, gate: 0.4, land: 1.15 };
/** The clear belt between one building and the next (brief: each station gets breathing room). */
const GAP = 0.9;
/** Clear of the belt's corner: it turns a machine's width into depth for its neighbour on the other arm, so EVERY station keeps off it by the widest reach (Build's) plus its own half depth and a margin. */
const turnOf = (_id: StationId, half: number) => Math.max(...Object.values(REACH0)) + half + 0.6;
const EVEN: readonly Pick<FloorStation, "id" | "x" | "w" | "count">[] = STATIONS.map((id, i) => ({ id, x: FLOOR.X0 + i * FLOOR.BAY_W, w: FLOOR.BAY_W, count: 1 }));
/** Lay the five stations on the belt from the frame's bays (`x`, `w`, `count`: the silo layout is the frame's, never assumed). */
export function isoLayoutOf(stations: readonly Pick<FloorStation, "id" | "x" | "w" | "count">[]): IsoLayout {
  const span = FLOOR.W - 2 * FLOOR.X0, belt = ISO.END - 0.6, by = new Map(stations.map(s => [s.id, s]));
  const out = {} as Record<StationId, StationLay>;
  let prevC = -Infinity, prevClear = 0;
  for (const id of STATIONS) {
    const st = by.get(id)!, len = (st.w / span) * belt, idle = st.count === 0;
    const s = id === "land" ? 1 : idle ? 0.4 : Math.max(0.55, Math.min(1, len / 3.2)), half = HALF0[id] * (id === "land" ? 1 : s), rear = REAR0[id] * (id === "land" ? 1 : s);
    let c = 0.3 + ((st.x - FLOOR.X0 + st.w / 2) / span) * belt;
    c = Math.max(c, prevC + prevClear + half + GAP); // keep order and a clear gap between buildings
    if (Math.abs(c - ISO.LA) < turnOf(id, half)) c = c <= ISO.LA && ISO.LA - turnOf(id, half) >= prevC + prevClear + half + GAP ? ISO.LA - turnOf(id, half) : ISO.LA + turnOf(id, half); // not across the corner
    c = Math.min(c, ISO.END - half - 0.1);
    out[id] = { id, c, len, s, half, rear, nAlong: 1, idle };
    prevC = c; prevClear = rear;
  }
  // The belt may have run out under the last stations: walk back from Land and make room, so the gap between buildings is never spent.
  for (let i = STATIONS.length - 2; i >= 0; i--) {
    const l = out[STATIONS[i]], next = out[STATIONS[i + 1]], limit = next.c - next.half - GAP - l.rear;
    if (l.c > limit) l.c = Math.abs(limit - ISO.LA) < turnOf(l.id, l.half) ? ISO.LA - turnOf(l.id, l.half) : limit;
  }
  let prevRear = 0.1;
  for (const id of STATIONS) {
    const l = out[id], front = l.c - l.half - 0.28;
    l.nAlong = Math.max(1, Math.min(8, Math.floor((front - (prevRear + ISO.CRATE / 2)) / ISO.STEP) + 1));
    prevRear = l.c + l.rear + 0.15;
  }
  return out;
}

// ---- machines ---------------------------------------------------------------------------------------------------------
/** What a machine part is, for the view's classes and animation: the press head's piston moves, the gate's beam lights, the claim arm sways. */
export type PartRole = "pad" | "base" | "bin" | "chute" | "post" | "arm" | "claw" | "pillar" | "head" | "piston" | "leg" | "bar" | "beam" | "dock" | "wall" | "vault" | "vaultdoor";
export type IsoPart = { kind: "part"; key: string; station: StationId; role: PartRole; b: Bounds; faces: Faces; idle: boolean };
const T = ISO.BELT_H;
/** The five machines as boxes (along, across, wAlong, wAcross, z0, z1): Intake hopper, Claim sorting arm, Build press, Gate
 * scanner arch, Land loading dock. Machines stand on the far side (the inside of the V); the Gate arch and the press straddle the
 * belt, high enough for crates to pass under. Depths along the belt follow the station's scale (a sliver for an empty silo). */
export function machineParts(lay: IsoLayout, vault = false): IsoPart[] {
  const mk = (id: StationId, role: PartRole, n: number, along: number, across: number, wAlong: number, wAcross: number, z0: number, z1: number): IsoPart => {
    const l = lay[id], bb = rectAt(beltFrame(l.c), along * l.s, across, wAlong * l.s, wAcross, z0, z1);
    return { kind: "part", key: `m:${id}:${role}:${n}`, station: id, role, b: bb, faces: boxFaces(bb), idle: l.idle };
  };
  const fixed = (id: StationId, role: PartRole, n: number, across: number, wAlong: number, wAcross: number, z0: number, z1: number, along = 0): IsoPart => {
    const bb = rectAt(beltFrame(lay[id].c), along, across, wAlong, wAcross, z0, z1); return { kind: "part", key: `m:${id}:${role}:${n}`, station: id, role, b: bb, faces: boxFaces(bb), idle: lay[id].idle };
  };
  return [
    fixed("intake", "pad", 0, 1.7, 1.9, 1.9, 0, ISO.PAD_Z), // the pad and the dock do not shrink with their machine: crates stand on them
    mk("intake", "base", 0, 0, -0.95, 1, 1, 0, 10), mk("intake", "bin", 0, 0, -0.95, 1.5, 1.5, 10, 26), mk("intake", "chute", 0, 0, -0.35, 0.5, 0.7, T + 6, 12),
    mk("claim", "base", 0, 0, -1, 0.9, 0.9, 0, 10), mk("claim", "post", 0, 0, -1, 0.35, 0.35, 10, 54), mk("claim", "arm", 0, 0, -0.5, 0.3, 1.1, 48, 56), mk("claim", "claw", 0, 0, 0, 0.4, 0.4, 36, 48),
    mk("build", "pillar", 0, 0, -1.45, 1.6, 0.5, 0, 52), mk("build", "pillar", 1, 0, 1.45, 1.6, 0.5, 0, 52), mk("build", "head", 0, 0, 0, 1.8, 3.4, 52, 72), mk("build", "piston", 0, 0, 0, 0.7, 0.7, 38, 52),
    mk("gate", "leg", 0, 0, -0.8, 0.35, 0.35, 0, 46), mk("gate", "leg", 1, 0, 0.8, 0.35, 0.35, 0, 46), mk("gate", "bar", 0, 0, 0, 0.35, 1.95, 46, 54), mk("gate", "beam", 0, 0, 0, 0.05, 1.25, T, 46),
    fixed("land", "dock", 0, 0, 1.9, 1.9, 0, ISO.DOCK_Z), fixed("land", "wall", 0, 0, 0.2, 1.9, ISO.DOCK_Z, 52, 1.05),
    // the archive vault stands past the dock's end wall: a squat body with a proud door on the viewer's side
    ...(vault ? [fixed("land", "vault", 0, 0, 1.5, 1.9, 0, 24, 2.9), fixed("land", "vaultdoor", 0, 0.95, 0.9, 0.12, 4, 19, 2.9)] : []),
  ];
}
/** Height of each machine's top (the neon label hangs above it). */
export const TOP: Readonly<Record<StationId, number>> = { intake: 26, claim: 56, build: 72, gate: 54, land: 52 };

// ---- crates and agents ------------------------------------------------------------------------------------------------
export type Slot = { b: Bounds; at: P };
const crateB = (x: number, y: number, z0: number): Bounds => ({ x0: x - ISO.CRATE / 2, x1: x + ISO.CRATE / 2, y0: y - ISO.CRATE / 2, y1: y + ISO.CRATE / 2, z0, z1: z0 + ISO.CRATE_H });
const layerZ = (base: number, layer: number) => base + layer * (ISO.CRATE_H + ISO.LAYER_GAP);
const pointAt = (l: StationLay, along: number, across: number) => { const f = beltFrame(l.c); return { x: f.g.x + f.dir.x * along + f.near.x * across, y: f.g.y + f.dir.y * along + f.near.y * across }; };
/** Where the k-th crate of a station stands (k = 0 is the front of the queue). Claim, Build and Gate queue upstream of the
 * machine: `nAlong` to a row along the belt, three rows across it and the apron, then up a layer at a time. Intake and Land pile
 * 3 x 3 per layer on their pad. There is no limit: a long queue only gets taller. */
export function crateSlot(lay: IsoLayout, id: StationId, k: number): Slot {
  const l = lay[id], pile = id === "intake" || id === "land", per = pile ? ISO.PILE * ISO.PILE : l.nAlong * ISO.COLS.length, layer = Math.floor(k / per), i = k % per;
  let along: number, across: number, z0: number;
  if (pile) { along = ((i % ISO.PILE) - 1) * ISO.PILE_PITCH; across = (id === "intake" ? 1.7 : 0) + (Math.floor(i / ISO.PILE) - 1) * ISO.PILE_PITCH; z0 = layerZ(id === "intake" ? ISO.PAD_Z : ISO.DOCK_Z, layer); }
  else { along = -(l.half + 0.28 + (i % l.nAlong) * ISO.STEP); across = ISO.COLS[Math.floor(i / l.nAlong)]; z0 = layerZ(ISO.BELT_H, layer); }
  const p = pointAt(l, along, across);
  return { b: crateB(p.x, p.y, z0), at: proj(p.x, p.y, z0) };
}
/** A crate that was just sent back rides the return lane, Gate toward Build; i = its place in line. */
export function laneSlot(lay: IsoLayout, i: number): Slot {
  const f = beltFrame(lay.gate.c - 1.1 - i * 0.7), o = ISO.LANE_OFF, x = f.g.x + f.near.x * o, y = f.g.y + f.near.y * o;
  return { b: crateB(x, y, ISO.LANE_Z), at: proj(x, y, ISO.LANE_Z) };
}
export type Placed<T> = { token: T; slot: Slot; lane: boolean; /** 1-based place in its station's queue (1 = front); 0 on the return lane. */ pos: number };
/** The ONE place a token gets a slot: every token the frame holds, in queue order per station, a sent-back one (`lane`, at most 3)
 * on the return lane. Used by the scene and by isoOrder, so they cannot disagree. */
export function placeCrates<T extends { id: string; station: StationId }>(tokens: readonly T[], lay: IsoLayout, lane: ReadonlySet<string> | null = null): Placed<T>[] {
  const back = tokens.filter(k => lane?.has(k.id)).slice(0, 3), onLane = new Set(back.map(k => k.id)), out: Placed<T>[] = [];
  back.forEach((token, i) => out.push({ token, slot: laneSlot(lay, i), lane: true, pos: 0 }));
  const n = new Map<StationId, number>();
  for (const token of tokens) { if (onLane.has(token.id)) continue; const k = n.get(token.station) ?? 0; n.set(token.station, k + 1); out.push({ token, slot: crateSlot(lay, token.station, k), lane: false, pos: k + 1 }); }
  return out;
}
/** The z-order of the crates, back to front (the order to paint them in): a pure function of the tokens and the layout. */
export function isoOrder<T extends { id: string; station: StationId }>(tokens: readonly T[], lay: IsoLayout, lane: ReadonlySet<string> | null = null): T[] {
  return sortIso(placeCrates(tokens, lay, lane).map(p => ({ key: p.token.id, b: p.slot.b, token: p.token }))).map(p => p.token);
}
/** Agents per row along the belt for a station, and where the i-th stands: rows on the viewer's side, outside the crate columns. */
export const botsPerRow = (l: StationLay) => Math.max(2, Math.floor((l.len - 0.4) / ISO.BOT_PITCH));
export function botSlot(lay: IsoLayout, id: StationId, i: number): Slot {
  const l = lay[id], n = botsPerRow(l), row = Math.floor(i / n);
  const p = pointAt(l, ((i % n) - (n - 1) / 2) * ISO.BOT_PITCH, ISO.BOT_ROW0 + row * ISO.BOT_ROWS);
  return { b: { x0: p.x - BOT.w / 2, x1: p.x + BOT.w / 2, y0: p.y - BOT.w / 2, y1: p.y + BOT.w / 2, z0: 0, z1: BOT.h }, at: proj(p.x, p.y, 0) };
}
/** The neon label's anchor above a machine, and the plate (the "+N" crates, the weather line) on the floor in front of the agents. */
/** The neon label hangs ABOVE the buildings, never on them: its anchor is the highest point of any machine part whose screen span meets the label's span, less the label's own height (name, wait/active and p50 lines) and a margin. */
export const LABEL_W = 150, LABEL_H = 29, LABEL_GAP = 8;
const partTop = (b: Bounds) => Math.min(...[b.x0, b.x1].flatMap(x => [b.y0, b.y1].map(y => proj(x, y, b.z1).y)));
const partSpan = (b: Bounds) => { const xs = [b.x0, b.x1].flatMap(x => [b.y0, b.y1].map(y => proj(x, y).x)); return { x0: Math.min(...xs), x1: Math.max(...xs) }; };
export const labelAt = (lay: IsoLayout, id: StationId): P => {
  const parts = machineParts(lay, true).filter(m => m.role !== "pad"), own = parts.filter(m => m.station === id).map(m => partSpan(m.b));
  const cx = (Math.min(...own.map(o => o.x0)) + Math.max(...own.map(o => o.x1))) / 2, x0 = cx - LABEL_W / 2, x1 = cx + LABEL_W / 2;
  const top = Math.min(...parts.filter(m => { const sp = partSpan(m.b); return sp.x0 < x1 && x0 < sp.x1; }).map(m => partTop(m.b)));
  return { x: cx, y: top - LABEL_H - LABEL_GAP };
};
export const plateAt = (lay: IsoLayout, id: StationId, botRows: number): P => { const f = beltFrame(lay[id].c), o = ISO.BOT_ROW0 + 0.9 + Math.max(0, botRows - 1) * ISO.BOT_ROWS; return proj(f.g.x + f.near.x * o, f.g.y + f.near.y * o, 0); };

// ---- the scene --------------------------------------------------------------------------------------------------------
/** What a crate just did, for its one-shot effect: arrive (dropped into a station), claim (picked by an agent), land (reached Land), back (sent back). */
export type PulseKind = "arrive" | "claim" | "land" | "back";
export const PULSE_CAP = 12, SCAN_CAP = 6;
export type IsoCrate = { kind: "crate"; key: string; b: Bounds; at: P; token: FloorToken; lane: boolean; selected: boolean; pos: number; pulse: PulseKind | null; scanning: boolean; /** The claiming agent's model letter, flashed on the crate for a claim pulse. */ stamp: string | null };
export type IsoBot = { kind: "bot"; key: string; b: Bounds; at: P; worker: FloorWorker; sparking: boolean; /** The agent's number: the digits of its pane id, else its place in the station. */ num: string };
export type IsoItem = IsoPart | IsoCrate | IsoBot;
/** A machine's neon label with its count, the "+N" plate for crates the FRAME did not draw (its own `overflow`), and the weather
 * line when it is over its limit (the caller's `fx.weather`). */
export type IsoLabel = { id: StationId; text: string; count: number; /** The beads the frame did NOT draw here (its own overflowIds), and a short list of them for the plate's title. */ hidden: readonly string[]; hiddenText: string; sub: string; p50: string | null; /** The solver's result: how far the label was raised (cells of screen px) to clear its neighbours, and which sub-lines it kept. */ lift: number; showSub: boolean; showP50: boolean; oldest: string | null; at: P; more: number; weather: { text: string; title: string } | null; plateAt: P; over: boolean; idle: boolean };
export type IsoFx = { press: number; beam: boolean; laneActive: boolean; inRework: number; claimSwing: boolean; gateFrozen: boolean; buildHot: boolean };
/** The numbers across the top: what the floor holds right now (all from the frame; `cost` only when costs are wired). */
export type IsoHud = { ready: number; building: number; gate: number; landed: number; agents: number; wip: number; perHour: number; cost: number | null };
/** One station's numbers, from the tokens drawn there: how many wait / are being worked, the oldest and the typical (median) time there. */
export type StationStats = { count: number; waiting: number; working: number; done: number; oldestMs: number | null; p50Ms: number | null; /** "3 wait · 2 active", short enough to sit under a machine's name. */ sub: string; /** "p50 14m": the typical time a bead has been here, or null. */ p50: string | null };
/** The archive vault: its count, how many went in today, the label anchor, and the arc a crate flies from the dock's pile to its door (`delta` of them, for the latest prune). */
export type IsoVault = { n: number; today: number | null; at: P; from: P; to: P; delta: number };
export type IsoScene = { items: IsoItem[]; labels: IsoLabel[]; fx: IsoFx; layout: IsoLayout; hud: IsoHud; stats: Record<StationId, StationStats>; vault: IsoVault | null };
/** Effects the caller derives once (from the scene or `isoFxOf`): the weather line per over-limit station, the beads whose lane was written lately. */
export type IsoFxInput = { weather: ReadonlyMap<StationId, { text: string; title: string }>; sparks: ReadonlySet<string> };
export const NO_FX: IsoFxInput = { weather: new Map(), sparks: new Set() };
/** The effects for a frame, from the model's own functions (weatherOf, sparkLanes). A standalone view calls this; a shell that has
 * a FactoryScene passes `scene.fx` instead. */
export function isoFxOf(frame: FloorFrame, now: number): IsoFxInput {
  const weather = new Map(frame.stations.flatMap(s => { const w = weatherOf(s, frame.thresholdsWired); return w ? [[s.id, w] as const] : []; }));
  return { weather, sparks: new Set(sparkLanes(frame.workers, now).map(l => l.beadId)) };
}

/** "#a, #b, #c and 4 more": who a +N plate hides (at most 8 named). */
export const hiddenText = (ids: readonly string[], max = 8): string => (ids.length === 0 ? "" : `${ids.slice(0, max).map(i => `#${shortId(i)}`).join(", ")}${ids.length > max ? ` and ${ids.length - max} more` : ""}`);
const age = (ms: number | null) => (ms === null ? null : cardLine(ms, null));
/** Per-station numbers from the frame's tokens (what is drawn there; `count` is the station's own total, hidden beads included). */
export function stationStats(frame: FloorFrame): Record<StationId, StationStats> {
  const out = {} as Record<StationId, StationStats>;
  for (const st of frame.stations) {
    const ks = frame.tokens.filter(k => k.station === st.id), ages = ks.map(k => k.sinceMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
    const waiting = ks.filter(k => k.stage === "waiting" || k.stage === "ready").length, working = ks.filter(k => k.stage === "building" || k.stage === "review").length, done = ks.filter(k => k.stage === "done").length;
    const oldestMs = ages.length ? ages[ages.length - 1] : null, p50Ms = ages.length ? ages[Math.floor((ages.length - 1) / 2)] : null;
    const sub = st.id === "land" ? `${st.count} landed` : `${waiting} wait · ${working} active`;
    out[st.id] = { count: st.count, waiting, working, done, oldestMs, p50Ms, sub, p50: age(p50Ms) ? `p50 ${age(p50Ms)}${oldestMs !== null && ages.length > 1 ? ` · oldest ${age(oldestMs)}` : ""}` : null };
  }
  return out;
}
/** What each crate just did, from the frame's own motion (set when it moved since the previous frame): dropped in, claimed, landed or sent back.
 * The view keeps a pulse for a moment and plays one effect per crate; at most PULSE_CAP at once so a 50-lane fleet stays readable. */
export function pulsesOf(frame: Pick<FloorFrame, "tokens">): Map<string, PulseKind> {
  const out = new Map<string, PulseKind>();
  for (const k of frame.tokens) {
    if (out.size >= PULSE_CAP) break;
    const kind: PulseKind | null = k.motion === "enter" ? "arrive" : k.motion === "rework" || k.motion === "back" ? "back" : k.motion === "forward" ? (k.station === "land" ? "land" : k.station === "claim" || k.station === "build" ? "claim" : null) : null;
    if (kind) out.set(k.id, kind);
  }
  return out;
}

/** Everything the view draws above the floor, in paint order: EVERY token and worker of the frame (nothing is capped here). */
export function isoScene(frame: FloorFrame, o: { selectedId?: string | null; lane?: ReadonlySet<string> | null; fx?: IsoFxInput | null; pulses?: ReadonlyMap<string, PulseKind> | null; /** How many beads the Land archive vault holds; absent = no vault object. */ archived?: number | null; archivedToday?: number | null; archivedDelta?: number | null } = {}): IsoScene {
  const sel = o.selectedId ?? null, fx = o.fx ?? NO_FX, lay = isoLayoutOf(frame.stations), items: IsoItem[] = machineParts(lay, o.archived != null), labels: IsoLabel[] = [];
  const placed = placeCrates(frame.tokens, lay, o.lane ?? null);
  const stats = stationStats(frame), pulses = o.pulses ?? null; let scans = 0, pulsed = 0;
  for (const p of placed) {
    const scanning = frame.reviewKnown && p.token.gateRole === "review" && scans < SCAN_CAP && ++scans > 0, pk = pulses?.get(p.token.id) ?? null, pulse = pk && pulsed < PULSE_CAP && ++pulsed > 0 ? pk : null;
    items.push({ kind: "crate", key: p.token.id, b: p.slot.b, at: p.slot.at, token: p.token, lane: p.lane, selected: sel === p.token.id, pos: p.pos, pulse, scanning, stamp: pulse === "claim" ? frame.workers.find(w => w.beadId === p.token.id)?.badge.glyph ?? null : null });
  }
  for (const st of frame.stations) {
    const ws = frame.workers.filter(w => w.station === st.id);
    ws.forEach((w, i) => { const s = botSlot(lay, st.id, i); items.push({ kind: "bot", key: `bot:${w.key}`, b: s.b, at: s.at, worker: w, sparking: fx.sparks.has(w.beadId), num: /(\d+)$/.exec(w.pane ?? "")?.[1] ?? String(i + 1) }); });
    const rows = Math.ceil(ws.length / botsPerRow(lay[st.id]));
    labels.push({ id: st.id, text: STATION_TEXT[st.id].label.toUpperCase(), count: st.count, hidden: st.overflowIds, hiddenText: hiddenText(st.overflowIds), lift: 0, showSub: true, showP50: true, sub: stats[st.id].sub, p50: stats[st.id].p50, oldest: age(stats[st.id].oldestMs), at: labelAt(lay, st.id), more: st.overflow, weather: fx.weather.get(st.id) ?? null, plateAt: plateAt(lay, st.id, rows), over: st.bottleneck, idle: lay[st.id].idle });
  }
  const live = frame.workers.filter(w => w.station === "build" && (w.presence === "live" || fx.sparks.has(w.beadId))).length, st = (id: StationId) => frame.stations.find(x => x.id === id)!;
  const costs = frame.costWired ? frame.workers.reduce((a, w) => a + (w.cost ?? 0), 0) : null;
  const hud: IsoHud = { ready: st("intake").queue, building: st("claim").count + st("build").count, gate: st("gate").count, landed: frame.throughput.lastDay, agents: frame.workers.filter(w => w.presence === "live").length, wip: st("claim").count + st("build").count + st("gate").count, perHour: frame.throughput.perHour, cost: costs };
  const fxOut: IsoFx = { press: live > 0 ? Math.min(6, 2 + live) : 0, beam: frame.reviewKnown && frame.tokens.some(k => k.gateRole === "review"), laneActive: frame.inRework > 0, inRework: frame.inRework, claimSwing: items.some(i => i.kind === "crate" && i.pulse === "claim"), gateFrozen: st("gate").bottleneck, buildHot: st("build").bottleneck };
  const vf = beltFrame(lay.land.c), at3 = (a: number, ac: number, z: number) => proj(vf.g.x + vf.dir.x * a + vf.near.x * ac, vf.g.y + vf.dir.y * a + vf.near.y * ac, z);
  const vault: IsoVault | null = o.archived == null ? null : { n: o.archived, today: o.archivedToday ?? null, at: at3(2.9, -0.9, 46), from: at3(0, 0, ISO.DOCK_Z + ISO.CRATE_H * 2), to: at3(2.9, 0.95, 12), delta: Math.max(0, Math.min(3, o.archivedDelta ?? 0)) };
  solveLabels(labels);
  return { items: sortIso(items), labels, layout: lay, hud, stats, fx: fxOut, vault };
}

// ---- labels never overlap -----------------------------------------------------------------------------------------------
/** The digits of a count, most significant first (at least one): the odometer rolls each digit's column. */
export const digitsOf = (n: number): number[] => String(Math.max(0, Math.floor(n))).split("").map(Number);
export const NAME_PX = 11, SUB_PX = 6.2;
type Box = { x0: number; x1: number; y0: number; y1: number };
/** The screen boxes a label occupies (its name and count line, then the wait/active line, then the p50 line), at a raise of `lift` px. */
export function labelBoxes(l: Pick<IsoLabel, "text" | "count" | "sub" | "p50" | "at">, lift: number, showSub: boolean, showP50: boolean): Box[] {
  const nameW = (l.text.length + 1 + String(l.count).length) * NAME_PX, cx = l.at.x, y = l.at.y - lift, out: Box[] = [{ x0: cx - nameW / 2, x1: cx + nameW / 2, y0: y - 14, y1: y + 3 }];
  if (showSub) out.push({ x0: cx - (l.sub.length * SUB_PX) / 2, x1: cx + (l.sub.length * SUB_PX) / 2, y0: y + 3, y1: y + 17 });
  if (showSub && showP50 && l.p50) out.push({ x0: cx - (l.p50.length * SUB_PX) / 2, x1: cx + (l.p50.length * SUB_PX) / 2, y0: y + 17, y1: y + 29 });
  return out;
}
export const boxesTouch = (a: readonly Box[], b: readonly Box[]) => a.some(p => b.some(q => p.x0 < q.x1 + 2 && q.x0 < p.x1 + 2 && p.y0 < q.y1 + 2 && q.y0 < p.y1 + 2));
const TRIES: readonly { lift: number; sub: boolean; p50: boolean }[] = [{ lift: 0, sub: true, p50: true }, { lift: 30, sub: true, p50: true }, { lift: 0, sub: true, p50: false }, { lift: 30, sub: true, p50: false }, { lift: 60, sub: true, p50: false }, { lift: 0, sub: false, p50: false }, { lift: 30, sub: false, p50: false }, { lift: 60, sub: false, p50: false }, { lift: 90, sub: false, p50: false }, { lift: 120, sub: false, p50: false }, { lift: 150, sub: false, p50: false }, { lift: 180, sub: false, p50: false }];
/** Settle the machine labels so none overlaps another, working left to right: keep the label where it is if it clears the ones placed,
 * else raise it, else drop its least important line (the p50, then the wait/active line) before it would overlap; the name and count
 * line is never dropped. Mutates `at` (raised), `lift`, `showSub`, `showP50`. */
export function solveLabels(labels: IsoLabel[]): IsoLabel[] {
  const placed: Box[][] = [];
  for (const l of [...labels].sort((a, b) => a.at.x - b.at.x || a.id.localeCompare(b.id))) {
    const base = l.at; let pick = TRIES[TRIES.length - 1];
    for (const t of TRIES) if (!placed.some(b => boxesTouch(labelBoxes({ ...l, at: base }, t.lift, t.sub, t.p50), b))) { pick = t; break; }
    l.lift = pick.lift; l.showSub = pick.sub; l.showP50 = pick.p50 && !!l.p50; l.at = { x: base.x, y: base.y - pick.lift };
    placed.push(labelBoxes({ ...l, at: base }, pick.lift, pick.sub, pick.p50));
  }
  return labels;
}

/** What Iso shows per station, for the parity check against the scene's queues: the bead ids it DRAWS as crates (a sent-back crate on the return
 * lane counts at its own station), the ids its +N plate hides (the frame's own overflowIds) and the number the plate prints. */
export function isoPartition(frame: FloorFrame, o: { lane?: ReadonlySet<string> | null } = {}): Record<StationId, { drawn: string[]; hidden: string[]; plate: number }> {
  const sc = isoScene(frame, { lane: o.lane ?? null }), out = {} as Record<StationId, { drawn: string[]; hidden: string[]; plate: number }>;
  for (const l of sc.labels) out[l.id] = { drawn: [], hidden: [...l.hidden], plate: l.more };
  for (const i of sc.items) if (i.kind === "crate") out[i.token.station].drawn.push(i.token.id);
  return out;
}

/** The scene's frame (viewBox): the empty V with its machines, labels and conveyors, grown to hold whatever the scene draws, so a
 * quiet floor is framed the same way every time and a busy one only gets more room. */
/** Height reserved above the scene for the HUD row of numerals. */
export const HUD_H = 56;
export function isoViewBox(scene: IsoScene | null = null, margin = 36): { x: number; y: number; w: number; h: number } {
  const xs: number[] = [], ys: number[] = [], lay = scene?.layout ?? isoLayoutOf(EVEN);
  const add = (b: Bounds) => { for (const x of [b.x0, b.x1]) for (const y of [b.y0, b.y1]) for (const z of [b.z0, b.z1]) { const p = proj(x, y, z); xs.push(p.x); ys.push(p.y); } };
  for (const m of machineParts(lay, true)) add(m.b); // the vault's room is always reserved, so adding it never rescales the stage
  for (const i of scene?.items ?? []) if (i.kind !== "part") add(i.b);
  for (const id of STATIONS) { const l = labelAt(lay, id); xs.push(l.x - 50, l.x + 50); ys.push(l.y - 16); }
  for (const l of scene?.labels ?? []) { xs.push(l.plateAt.x - 115, l.plateAt.x + 115); ys.push(l.plateAt.y + 40); }
  if (!scene) for (const id of STATIONS) { const p = plateAt(lay, id, 1); xs.push(p.x - 115, p.x + 115); ys.push(p.y + 40); }
  for (const p of [...beltPath(), ...lanePath(lay)]) { xs.push(p.x); ys.push(p.y); }
  const x = Math.min(...xs) - margin, y = Math.min(...ys) - margin - HUD_H;
  return { x: Math.floor(x), y: Math.floor(y), w: Math.ceil(Math.max(...xs) + margin - x), h: Math.ceil(Math.max(...ys) + margin - y) };
}

// ---- heat, keyboard anchors, edge layers -----------------------------------------------------------------------------------
/** A crate's heat paint from the frame's own heatStep, through the same per-mode families the Floor uses: the fill and ink as CSS var()
 * strings (--oi-heat-<family>-N via heat-ramps.ts) and whether Blocking's hatch goes over it. Null when heat is off or the mode has no data. */
export function crateHeat(k: Pick<FloorToken, "heatStep">, mode: HeatMode | null): { step: number; fill: string; ink: string; hatch: boolean } | null {
  if (mode === null || k.heatStep === null) return null;
  const step = Math.max(0, Math.min(4, Math.round(k.heatStep)));
  return { step, fill: `var(${heatColorVar(mode, step)})`, ink: `var(${heatTextVar(mode, step)})`, hatch: mode === "impact" && step >= 1 };
}
/** Where a focused element reports its hover from (its bounding rect's left and bottom), so the shared card can show for the keyboard. */
export const rectAnchor = (r: { left: number; bottom: number }): { x: number; y: number } => ({ x: Math.max(0, r.left), y: Math.max(0, r.bottom) });
/** The edges to draw in two layers: every OTHER chain faint underneath (`all`, minus what the focus chain draws, only where both ends are
 * drawn) and the focus chain on top. With no `all` there is no faint layer. */
export function edgeLayers(all: readonly ChainEdge[], focus: readonly ChainEdge[], drawn: ReadonlySet<string>): { faint: ChainEdge[]; focus: ChainEdge[] } {
  const ok = (e: ChainEdge) => drawn.has(e.from) && drawn.has(e.to), key = (e: ChainEdge) => `${e.from}>${e.to}`, top = new Set(focus.filter(ok).map(key));
  return { faint: all.filter(e => ok(e) && !top.has(key(e))), focus: focus.filter(ok) };
}

// ---- hover source -----------------------------------------------------------------------------------------------------
/** Who set the current hover: the pointer, or keyboard focus. A blur must clear only a hover its own focus set (a pointer hover set by
 * another element survives it), and the pointer leaving clears only a pointer hover: the same model as the rail's reduceHover. */
export type StageHover = { id: string; source: "focus" | "pointer" } | null;
export type StageHoverEvent = { type: "focus" | "blur"; id: string } | { type: "pointer"; id: string | null } | { type: "leave" };
export function reduceStageHover(prev: StageHover, ev: StageHoverEvent): { state: StageHover; emit: "set" | "clear" | null } {
  if (ev.type === "focus") return { state: { id: ev.id, source: "focus" }, emit: "set" };
  if (ev.type === "blur") return prev && prev.source === "focus" && prev.id === ev.id ? { state: null, emit: "clear" } : { state: prev, emit: null };
  if (ev.type === "pointer" && ev.id !== null) return { state: prev && prev.source === "pointer" && prev.id === ev.id ? prev : { id: ev.id, source: "pointer" }, emit: "set" };
  return prev && prev.source === "pointer" ? { state: null, emit: "clear" } : { state: prev, emit: null }; // leave, or the pointer on empty floor
}

// ---- hover text -------------------------------------------------------------------------------------------------------
export type TipTone = "head" | "muted" | "plain" | "failure" | "running" | "attention";
export type TipLine = { text: string; tone: TipTone };
const ITEM = termLabel("bead"), PANE = termLabel("pane");
/** The hovered crate's tooltip: the lines FactoryFloor's card tooltip shows (epic, station and age, trail, lock, what it waits on
 * and holds up, rework, pane), as data. `done` says whether a bead has landed, `where` which station it stands at. */
export function tipLines(k: FloorToken, c: { frame: FloorFrame; epic: string | null; trail: readonly TrailStop[]; where: WhereIs; done: (id: string) => boolean; via: FloorWorker["via"] | null; clock: (at: number) => string }): TipLine[] {
  const place = (id: string) => (c.done(id) ? "landed ✓" : c.where(id) === null ? "not on the floor" : `at ${STATION_TEXT[c.where(id)!].label}`);
  const lock = k.lock ? c.frame.locks.find(l => l.key === k.lock) ?? null : null, out: TipLine[] = [];
  out.push({ text: `#${k.shortId} · ${k.title}`, tone: "head" }, { text: `Epic: ${c.epic ?? "none"}`, tone: "muted" });
  out.push({ text: `${STATION_TEXT[k.station].label}: ${stageLabel(k.stage)}${k.sinceMs === null ? "" : ` for ${formatAge(k.sinceMs)}`}`, tone: "muted" });
  if (c.trail.length) out.push({ text: c.trail.map(s => `${STATION_TEXT[s.station].label} ${c.clock(s.at)}`).join(" → "), tone: "plain" });
  if (k.gateRole === "review") out.push({ text: "At the Gate: assumed under review (no review-start signal yet)", tone: "muted" });
  if (lock) out.push({ text: lockDetail(lock, c.where), tone: "failure" });
  if (k.waitingOn.length) out.push({ text: `Waits on ${k.waitingOn.map(x => `#${shortId(x)} (${place(x)})`).join(", ")}`, tone: "failure" });
  if (k.blocks.length) out.push({ text: `Holds up ${k.blocks.map(x => `#${shortId(x)} (${place(x)})`).join(", ")}`, tone: "running" });
  if (k.downstream > k.blocks.length) out.push({ text: `${k.downstream} ${ITEM}s wait on it in all, further down the chain`, tone: "muted" });
  if (k.rework > 0) out.push({ text: `Sent back ${k.rework}×`, tone: "attention" });
  out.push({ text: `${capitalise(PANE)}: ${k.pane ?? (c.via === "transcript" ? "none · working by transcript" : "none")}`, tone: "muted" });
  return out;
}
