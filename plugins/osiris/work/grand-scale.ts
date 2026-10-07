// Grand density tier for the Factory FLOOR (pure, no React, no colours). Today's cards are 100x42 and the stacks go DENSE past
// 10 cards; the owner's verdict was "the silos are so small". This module answers ONE question: given the floor's size and how
// many cards each station holds, how big can its cards be? It returns the card box, gaps, badge, FONT sizes and how much text
// fits, per station, so the view draws what the numbers say and never invents a size of its own.
// Rules, stated:
//   - Sizes are VIRTUAL units (the floor's viewBox, FLOOR.W wide). The rendered scale is pxW / viewW, so a font in units is
//     legible when units * scale >= LEGIBLE_PX. FAC-13: 11px at a 720px-wide floor, so the minimum type is
//     ceil(11 / (720 / 1200)) = 19 units there, and shrinks as the floor widens. Type is never below that minimum; when a
//     card cannot carry it, the text is dropped (text: "none"), not shrunk below the floor of legibility.
//   - A station takes the LARGEST tier whose stack fits `room` (the height above the belt under the bay header). Past the last
//     tier the stack overflows and `lift` says by how much, exactly as frame.lift does today.
//   - The bay width breathes (fin-big): card columns are derived from the bay width given, never from a constant.
//   - Crate stations (Intake, Land) get larger tokens the same way, and report their CAPACITY so the "+N" overflow chip is
//     drawn from the same number.
import { FLOOR, STACK_ROOM, type StationId } from "./factory-floor-model.ts";

export const LEGIBLE_PX = 11, REF_PX_W = 720;
/** Characters of a short id the card must show ("osi.15"): drives whether the id fits beside the badge. */
const ID_CHARS = 8;
/** Average glyph width of the floor's monospace type, as a fraction of its font size. */
const GLYPH = 0.62;

export type GrandTierName = "grand" | "large" | "mid" | "dense" | "micro";
type CardTier = { name: GrandTierName; h: number; gap: number; minW: number; maxCols: number };
/** Largest first. `minW` is the narrowest card the tier wants (it sets the column count), `h` the card height. mid / dense /
 * micro reproduce today's normal / dense / micro boxes at the stock bay width, so a stock floor degrades to what ships now. */
export const CARD_TIERS: readonly CardTier[] = [
  { name: "grand", h: 88, gap: 10, minW: 150, maxCols: 3 },
  { name: "large", h: 60, gap: 8, minW: 120, maxCols: 3 },
  { name: "mid", h: 46, gap: 6, minW: 90, maxCols: 4 },
  { name: "dense", h: 30, gap: 4, minW: 56, maxCols: 5 },
  { name: "micro", h: 18, gap: 3, minW: 40, maxCols: 6 },
];
/** Crate tokens for Intake / Land, largest first. */
export const CRATE_SIZES: readonly { name: GrandTierName; size: number; gap: number }[] = [
  { name: "grand", size: 52, gap: 8 }, { name: "large", size: 40, gap: 7 }, { name: "mid", size: 32, gap: 6 }, { name: "micro", size: FLOOR.TOKEN, gap: FLOOR.GAP },
];

/** "full" = badge + id + elapsed/cost line; "id" = badge + id; "none" = badge only (the card's tooltip carries the rest). */
export type CardText = "full" | "id" | "none";
export type GrandCard = {
  kind: "card"; tier: GrandTierName; w: number; h: number; cols: number; rows: number; gap: number; badgeR: number; badgeX: number; foot: number;
  font: { id: number; meta: number; cap: number }; text: CardText; captionChars: number;
  /** Cards drawn, the stack's height, and how far past `room` it reaches (0 when it fits; the floor lifts by this much). */
  shown: number; stackH: number; lift: number;
  /** Height relative to today's normal card (FLOOR.CARD_H): "grand" is >= 2 when space allows. */
  factor: number;
};
export type GrandCrate = { kind: "crate"; tier: GrandTierName; size: number; gap: number; cols: number; rows: number; capacity: number; shown: number; overflow: number; stackH: number; font: number; factor: number };
export type GrandStationIn = { id: StationId; count: number; bayW: number };
export type GrandIn = {
  /** Rendered pixel width of the floor, and the virtual width it draws (FLOOR.W unless the lift/zoom changes the viewBox). */
  pxW: number; viewW?: number;
  /** Height available above the belt for a stack (defaults to STACK_ROOM). */
  room?: number;
  stations: readonly GrandStationIn[];
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const isCard = (s: StationId) => s === "claim" || s === "build" || s === "gate";

/** Smallest type, in virtual units, that renders at >= LEGIBLE_PX on a floor `pxW` wide (viewBox `viewW` wide). */
export function legibleUnits(pxW: number, viewW: number = FLOOR.W): number {
  const scale = pxW > 0 && viewW > 0 ? pxW / viewW : REF_PX_W / FLOOR.W;
  return Math.ceil(LEGIBLE_PX / scale);
}
/** Bay padding: the stock PAD, tightened on a sliver so the cards keep their width. */
export const bayPad = (bayW: number) => Math.min(FLOOR.PAD, Math.max(3, bayW * 0.08));
const innerW = (bayW: number) => Math.max(8, bayW - 2 * bayPad(bayW));
const stackOf = (rows: number, h: number, gap: number) => (rows > 0 ? rows * (h + gap) - gap : 0);

function cardAt(t: CardTier, count: number, bayW: number, room: number, minFont: number): GrandCard {
  const inner = innerW(bayW), cols = clamp(Math.floor((inner + t.gap) / (t.minW + t.gap)), 1, t.maxCols);
  const w = Math.floor((inner - t.gap * (cols - 1)) / cols), rows = Math.ceil(count / cols), stackH = stackOf(rows, t.h, t.gap);
  const badgeR = clamp(Math.round(t.h * 0.26), 5, 22), badgeX = badgeR + 5;
  // Type grows with the card but never drops under the legibility floor; the caption strip needs a line of it.
  const grown = Math.round(t.h * 0.22), idFont = Math.max(minFont, grown), metaFont = Math.max(minFont, Math.round(grown * 0.85)), capFont = minFont;
  const twoLines = t.h >= idFont + metaFont + 10, footH = t.h >= idFont + metaFont + capFont + 14 ? capFont + 4 : 0;
  const idFits = badgeX + badgeR + 6 + ID_CHARS * GLYPH * idFont <= w;
  const text: CardText = t.h >= idFont + 6 && idFits ? (twoLines ? "full" : "id") : "none";
  return {
    kind: "card", tier: t.name, w, h: t.h, cols, rows, gap: t.gap, badgeR, badgeX, foot: text === "full" ? footH : 0,
    font: { id: idFont, meta: metaFont, cap: capFont }, text, captionChars: footH ? Math.max(0, Math.floor((w - 8) / (capFont * GLYPH))) : 0,
    shown: count, stackH, lift: Math.max(0, stackH - room), factor: t.h / FLOOR.CARD_H,
  };
}

function crateAt(c: (typeof CRATE_SIZES)[number], count: number, bayW: number, room: number, minFont: number): GrandCrate {
  const inner = innerW(bayW), cols = Math.max(1, Math.floor((inner + c.gap) / (c.size + c.gap))), rowsFit = Math.max(1, Math.floor((room + c.gap) / (c.size + c.gap)));
  const capacity = cols * Math.min(rowsFit, FLOOR.ROWS * 2), shown = Math.min(count, capacity), rows = Math.ceil(shown / cols);
  return { kind: "crate", tier: c.name, size: c.size, gap: c.gap, cols, rows, capacity, shown, overflow: count - shown, stackH: stackOf(rows, c.size, c.gap), font: minFont, factor: c.size / FLOOR.TOKEN };
}

/** One station's grand layout. Card stations take the largest tier that fits `room`; if none does, the smallest tier is used and
 * `lift` reports the overflow. Crate stations take the largest token whose capacity still holds every crate, else the one
 * holding the most (the rest go to the "+N" chip). */
export function grandStation(s: GrandStationIn, room: number, minFont: number): GrandCard | GrandCrate {
  const count = Math.max(0, Math.floor(s.count));
  if (isCard(s.id)) {
    const fit = CARD_TIERS.map(t => cardAt(t, count, s.bayW, room, minFont));
    return fit.find(c => c.lift === 0) ?? fit[fit.length - 1];
  }
  const fit = CRATE_SIZES.map(c => crateAt(c, count, s.bayW, room, minFont));
  return fit.find(c => c.overflow === 0) ?? fit.reduce((best, c) => (c.capacity > best.capacity ? c : best));
}

/** Grand layout for every station given. Pure: same input, same output. */
export function grandScale(input: GrandIn): Partial<Record<StationId, GrandCard | GrandCrate>> {
  const room = input.room ?? STACK_ROOM, minFont = legibleUnits(input.pxW, input.viewW ?? FLOOR.W), out: Partial<Record<StationId, GrandCard | GrandCrate>> = {};
  for (const s of input.stations) out[s.id] = grandStation(s, room, minFont);
  return out;
}
