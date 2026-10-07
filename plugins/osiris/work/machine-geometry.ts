// Geometry for the Factory's GRAND machines (pure, no React, no colours). Every station gets a machine drawn in a LOCAL box:
// x runs 0..w across the bay, y runs 0..room DOWN to the belt (room = BELT_Y - top of the art). fin-big makes bay widths
// breathe with load, so nothing here is a fixed pixel: every number derives from `w` and `room`, and every shape stays
// inside [0, w] for any w from a 64 unit sliver to a wide bay (pinned in the tests). The component only draws these shapes.
import type { StationId } from "./factory-floor-model.ts";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const f = (n: number) => Math.round(n * 100) / 100;
export type Box = { w: number; room: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type Pt = { x: number; y: number };

/** Width class: sliver (<= 100), narrow (<= 180) or wide. Machines simplify in a sliver (fewer parts), never disappear. */
export const widthClass = (w: number): "sliver" | "narrow" | "wide" => (w <= 100 ? "sliver" : w <= 180 ? "narrow" : "wide");
/** Margin kept clear at both sides. */
export const margin = (w: number) => Math.max(3, w * 0.05);
/** Usable width. */
export const innerOf = (w: number) => Math.max(8, w - 2 * margin(w));

// ---- INTAKE: hopper + funnel --------------------------------------------------------------------------------------------
export type Intake = { hopper: string; rim: Rect; level: string; spout: Rect; funnel: string; stream: { x: number; y1: number; y2: number }; drops: Pt[]; hh: number };
/** `fill` 0..1 is how full the hopper is (queue against its threshold). */
export function intake(b: Box, fill: number): Intake {
  const { w, room } = b, iw = innerOf(w), cx = w / 2, hw = iw * 0.86, sw = Math.max(6, iw * 0.16), hh = Math.min(room * 0.36, iw * 0.7 + 20);
  const k = clamp(fill, 0, 1), yt = hh * (1 - k), wAt = (y: number) => sw + (hw - sw) * (y / hh);
  const nl = room * 0.1, fh = room * 0.1, fw = iw * 0.5, neckY = hh + nl, endY = neckY + fh;
  const dropN = widthClass(w) === "sliver" ? 2 : 3;
  return {
    hh, hopper: `M${f(cx - hw / 2)} 0H${f(cx + hw / 2)}L${f(cx + sw / 2)} ${f(hh)}H${f(cx - sw / 2)}Z`,
    rim: { x: f(cx - hw / 2 - 2), y: -3, w: f(hw + 4), h: 5 },
    level: k <= 0 ? "" : `M${f(cx - wAt(yt) / 2)} ${f(yt)}H${f(cx + wAt(yt) / 2)}L${f(cx + sw / 2)} ${f(hh)}H${f(cx - sw / 2)}Z`,
    spout: { x: f(cx - sw / 2), y: f(hh), w: f(sw), h: f(nl) },
    funnel: `M${f(cx - sw / 2)} ${f(neckY)}L${f(cx - fw / 2)} ${f(endY)}H${f(cx + fw / 2)}L${f(cx + sw / 2)} ${f(neckY)}Z`,
    stream: { x: f(cx), y1: f(hh), y2: f(endY) },
    drops: Array.from({ length: dropN }, (_, i) => ({ x: f(cx), y: f(hh + ((endY - hh) * (i + 0.5)) / dropN) })),
  };
}

// ---- CLAIM: sorting arm -------------------------------------------------------------------------------------------------
export type Claim = { post: Rect; base: Rect; pivot: Pt; arm: { x2: number; y2: number }; claw: Pt; clawR: number; swing: number; bins: Rect[] };
export function claim(b: Box): Claim {
  const { w, room } = b, iw = innerOf(w), m = margin(w), cx = w / 2, baseH = Math.max(4, room * 0.04), postW = Math.max(4, iw * 0.07), topY = room * 0.3;
  const len = Math.min(iw * 0.42, room * 0.3), rest = (-35 * Math.PI) / 180, clawR = Math.max(3, iw * 0.04);
  const binN = widthClass(w) === "sliver" ? 1 : 3, binW = Math.max(6, (iw * 0.9 - (binN - 1) * 4) / binN / 2.4), binH = room * 0.1;
  return {
    base: { x: f(m + iw * 0.2), y: f(room - baseH), w: f(iw * 0.6), h: f(baseH) }, post: { x: f(cx - postW / 2), y: f(topY), w: f(postW), h: f(room - baseH - topY) },
    pivot: { x: f(cx), y: f(topY) }, arm: { x2: f(Math.cos(rest) * len), y2: f(Math.sin(rest) * len) }, claw: { x: f(Math.cos(rest) * len), y: f(Math.sin(rest) * len) }, clawR: f(clawR), swing: 38,
    bins: Array.from({ length: binN }, (_, i) => ({ x: f(m + i * (binW + 4)), y: f(topY - binH * 0.2), w: f(binW), h: f(binH) })),
  };
}

// ---- BUILD: press / anvil + spark emitters -----------------------------------------------------------------------------
export type Build = { cols: Rect[]; beam: Rect; cylinder: Rect; head: Rect; stroke: number; anvil: string; anvilTop: number; sparks: { x: number; y: number; dx: number; dy: number }[] };
export function build(b: Box): Build {
  const { w, room } = b, iw = innerOf(w), m = margin(w), cx = w / 2, cw = Math.max(4, iw * 0.06), beamH = Math.max(5, room * 0.07), colX = m + iw * 0.08;
  const pw = Math.max(6, iw * 0.14), hw = Math.max(14, iw * 0.4), hy = room * 0.34, hh = Math.max(6, room * 0.07), stroke = room * 0.15;
  const aw = iw * 0.55, ay = hy + stroke + hh + 6, ah = Math.max(6, room * 0.07), n = widthClass(w) === "sliver" ? 4 : 6;
  return {
    cols: [{ x: f(colX), y: 0, w: f(cw), h: f(ay + ah) }, { x: f(w - colX - cw), y: 0, w: f(cw), h: f(ay + ah) }], beam: { x: f(colX), y: 0, w: f(w - 2 * colX), h: f(beamH) },
    cylinder: { x: f(cx - pw / 2), y: f(beamH), w: f(pw), h: f(hy - beamH) }, head: { x: f(cx - hw / 2), y: f(hy), w: f(hw), h: f(hh) }, stroke: f(stroke),
    anvil: `M${f(cx - aw / 2)} ${f(ay + ah)}L${f(cx - aw * 0.35)} ${f(ay)}H${f(cx + aw * 0.35)}L${f(cx + aw / 2)} ${f(ay + ah)}Z`, anvilTop: f(ay),
    sparks: Array.from({ length: n }, (_, i) => { const t = i / (n - 1) - 0.5; return { x: f(cx + t * aw * 0.6), y: f(ay), dx: f(t * iw * 0.45), dy: f(-room * (0.07 + 0.05 * ((i % 3) / 2))) }; }),
  };
}

// ---- GATE: scanner arch with a beam ------------------------------------------------------------------------------------
export type Gate = { pillars: Rect[]; arch: string; lintel: Rect; beam: Rect; travel: number; cone: string; lamp: Pt; lampR: number };
export function gate(b: Box): Gate {
  const { w, room } = b, iw = innerOf(w), m = margin(w), cx = w / 2, pw = Math.max(5, iw * 0.07), x1 = m + iw * 0.04, x2 = w - m - iw * 0.04, topY = room * 0.12;
  const innerL = x1 + pw, innerR = x2 - pw, r = clamp((innerR - innerL) / 2, 4, room * 0.25), lintelH = Math.max(4, room * 0.04);
  const beamTop = topY + r + lintelH, beamBot = room * 0.78, lampR = Math.max(3, iw * 0.035);
  return {
    pillars: [{ x: f(x1), y: f(topY + r), w: f(pw), h: f(room - topY - r) }, { x: f(x2 - pw), y: f(topY + r), w: f(pw), h: f(room - topY - r) }],
    arch: `M${f(innerL)} ${f(topY + r)}A${f(r)} ${f(r)} 0 0 1 ${f(innerR)} ${f(topY + r)}`, lintel: { x: f(innerL), y: f(topY - lintelH / 2), w: f(innerR - innerL), h: f(lintelH) },
    beam: { x: f(innerL), y: f(beamTop), w: f(innerR - innerL), h: 3 }, travel: f(Math.max(0, beamBot - beamTop)),
    cone: `M${f(innerL)} ${f(beamTop)}H${f(innerR)}L${f(innerR - (innerR - innerL) * 0.1)} ${f(beamBot)}H${f(innerL + (innerR - innerL) * 0.1)}Z`, lamp: { x: f(cx), y: f(topY - lampR - 3), }, lampR: f(lampR),
  };
}

// ---- LAND: loading dock + stacked crate pile ----------------------------------------------------------------------------
/** Crates per row of a pyramid for n crates, bottom row first and at most `baseMax` wide; the top row may be partial. A pile
 * that cannot be a full pyramid inside baseMax becomes a stepped wall (rows of baseMax), never wider than baseMax. */
export function pyramid(n: number, baseMax: number): number[] {
  const total = Math.max(0, Math.floor(n)), cap = Math.max(1, Math.floor(baseMax));
  if (total === 0) return [];
  let base = 1;
  while (base < cap && (base * (base + 1)) / 2 < total) base++;
  const rows: number[] = [];
  let left = total, row = base;
  while (left > 0) { const k = Math.min(left, row); rows.push(k); left -= k; row = Math.max(1, row - 1); }
  return rows;
}
export type Land = { dock: Rect; door: Rect; slats: number[]; canopy: Rect; crateSize: number; pile: Rect[]; pileCount: number };
/** `count` = crates landed; the pile shows at most PILE_MAX of them (the shelf and the count carry the real number). */
export const PILE_MAX = 28;
export function land(b: Box, count: number): Land {
  const { w, room } = b, iw = innerOf(w), m = margin(w), dockH = Math.max(6, room * 0.06), doorW = clamp(iw * 0.28, 12, 70), doorH = room * 0.22;
  const cs = clamp(Math.round(iw * 0.09), 7, 20), baseMax = Math.max(1, Math.floor((iw * 0.6) / (cs + 1))), shown = Math.min(Math.max(0, Math.floor(count)), PILE_MAX), rows = pyramid(shown, baseMax);
  const pile: Rect[] = [];
  rows.forEach((k, r) => { const rowW = k * (cs + 1), x0 = m + ((rows[0] * (cs + 1)) - rowW) / 2; for (let i = 0; i < k; i++) pile.push({ x: f(x0 + i * (cs + 1)), y: f(room - dockH - (r + 1) * (cs + 1)), w: cs, h: cs }); });
  return {
    dock: { x: f(m), y: f(room - dockH), w: f(iw), h: f(dockH) }, door: { x: f(w - m - doorW), y: f(room - dockH - doorH), w: f(doorW), h: f(doorH) },
    slats: Array.from({ length: 4 }, (_, i) => f(room - dockH - doorH + (doorH * (i + 1)) / 5)), canopy: { x: f(w - m - doorW - 3), y: f(room - dockH - doorH - 5), w: f(doorW + 6), h: 4 },
    crateSize: cs, pile, pileCount: shown,
  };
}

// ---- Floor plane: gradient floor, converging perspective lines, belt depth --------------------------------------------
export type FloorPlane = { plane: string; hlines: number[]; vlines: { x1: number; y1: number; x2: number; y2: number }[]; frontFace: Rect; topFace: Rect; shadow: Rect; rollers: number[] };
/** `y0` = the belt's lower edge, `H` = the floor's bottom, `W` its width, `beltY`/`beltH` the belt. The plane is the strip in
 * front of the belt; lines converge to a vanishing point above the belt, and horizontal lines bunch toward the horizon. */
export function floorPlane(W: number, H: number, beltY: number, beltH: number): FloorPlane {
  const y0 = beltY + beltH, depth = Math.max(8, H - y0), vx = W / 2, vy = beltY - 260, nH = 5, nV = 18;
  const hlines = Array.from({ length: nH }, (_, i) => f(y0 + depth * Math.pow((i + 1) / (nH + 1), 1.7)));
  const vlines = Array.from({ length: nV + 1 }, (_, i) => { const xb = (i / nV) * W * 1.6 - W * 0.3, t = (y0 - vy) / (H - vy); return { x1: f(vx + (xb - vx) * t), y1: f(y0), x2: f(xb), y2: f(H) }; });
  return {
    plane: `M16 ${f(y0)}H${f(W - 16)}L${f(W)} ${f(H)}H0Z`, hlines, vlines,
    frontFace: { x: 16, y: f(y0), w: f(W - 32), h: 5 }, topFace: { x: 16, y: f(beltY - 5), w: f(W - 32), h: 5 }, shadow: { x: 16, y: f(y0 + 5), w: f(W - 32), h: 9 },
    rollers: Array.from({ length: Math.floor((W - 32) / 24) }, (_, i) => f(16 + 12 + i * 24)),
  };
}

export const MACHINE_STATIONS: readonly StationId[] = ["intake", "claim", "build", "gate", "land"];

// ---- Numerals: "numbers are the game" (owner 01:31). A big station numeral on a plate at the top of each machine, plus a small
// waiting / in-progress split under it. Sized from the width; the split is hidden when it could not stay legible. -------------
/** Smallest split type, in units (19 = 11px at a 720px floor, FAC-13), and the width below which the split is hidden. */
export const SPLIT_FONT = 19, SPLIT_MIN_W = 100;
export type Plate = { cx: number; numeral: { x: number; y: number; fs: number }; split: { show: boolean; y: number; fs: number; waitX: number; workX: number }; h: number };
export function plate(b: Box): Plate {
  const { w } = b, cx = w / 2, fs = Math.round(clamp(w * 0.22, 20, 56)), show = w >= SPLIT_MIN_W, sy = fs + 4 + SPLIT_FONT;
  return {
    cx, numeral: { x: f(cx), y: fs, fs }, h: show ? sy + 6 : fs + 8,
    split: { show, y: sy, fs: SPLIT_FONT, waitX: f(cx - w * 0.18), workX: f(cx + w * 0.06) },
  };
}

// ---- VAULT: the Archived cabinet at the end of the Land dock ---------------------------------------------------------------
export type Vault = { body: Rect; drawers: Rect[]; handles: Rect[]; plate: Rect; numeral: { x: number; y: number; fs: number }; foot: Rect };
export function vault(b: Box): Vault {
  const { w, room } = b, iw = innerOf(w), m = margin(w), bodyH = Math.min(room * 0.7, iw * 1.5 + 30), top = room - bodyH, footH = Math.max(3, room * 0.025);
  const plateH = clamp(bodyH * 0.28, 16, 60), n = widthClass(w) === "sliver" ? 2 : 3, gap = 4, dh = (bodyH - plateH - footH - gap * (n + 1)) / n;
  const fs = Math.round(clamp(Math.min(iw * 0.3, plateH * 0.8), 14, 48)), hw = Math.max(8, iw * 0.3);
  return {
    body: { x: f(m), y: f(top), w: f(iw), h: f(bodyH - footH) }, foot: { x: f(m + iw * 0.06), y: f(room - footH), w: f(iw * 0.88), h: f(footH) },
    plate: { x: f(m + 5), y: f(top + 5), w: f(iw - 10), h: f(plateH - 5) }, numeral: { x: f(w / 2), y: f(top + 5 + (plateH - 5) * 0.5 + fs * 0.36), fs },
    drawers: Array.from({ length: n }, (_, i) => ({ x: f(m + 5), y: f(top + plateH + gap + i * (dh + gap)), w: f(iw - 10), h: f(dh) })),
    handles: Array.from({ length: n }, (_, i) => ({ x: f(w / 2 - hw / 2), y: f(top + plateH + gap + i * (dh + gap) + dh / 2 - 1.5), w: f(hw), h: 3 })),
  };
}
