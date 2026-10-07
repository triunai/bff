// Factory silo widths (owner td-osi.15.2: "dramatically resize its silos as we go"). Pure: card counts per station and the width
// available in, one integer width per station out. An EMPTY station collapses to a narrow labelled sliver, a busy one grows with
// sqrt(count) so one huge queue cannot erase the rest, every busy station keeps a minimum that fits one card column, and LAND is
// capped so a long done list cannot dominate. The widths always sum to the available width (largest-remainder rounding).
import type { StationId } from "./station-rules.ts";

export const SILO = { SLIVER: 64, MIN_BUSY: 128, LAND_SHARE: 0.26 } as const;
export const SILO_ORDER: readonly StationId[] = ["intake", "claim", "build", "gate", "land"];
export type SiloCounts = Readonly<Record<StationId, number>>;
export type SiloOpts = { sliver?: number; minBusy?: number; landShare?: number };

/** Integer widths (px) per station, in SILO_ORDER, summing to `available`. */
export function siloWidths(counts: SiloCounts, available: number, o: SiloOpts = {}): Record<StationId, number> {
  const n = SILO_ORDER.length, total = Math.max(0, Math.floor(available));
  const sliver = Math.min(o.sliver ?? SILO.SLIVER, total / n), minBusy = Math.min(o.minBusy ?? SILO.MIN_BUSY, total / n);
  const busy = SILO_ORDER.filter(s => counts[s] > 0);
  const out = {} as Record<StationId, number>;
  if (busy.length === 0) { for (const s of SILO_ORDER) out[s] = total / n; return roundTo(out, total); } // nothing anywhere: an even floor
  const w: Record<StationId, number> = {} as Record<StationId, number>;
  for (const s of SILO_ORDER) w[s] = counts[s] > 0 ? minBusy : sliver;
  const weight = (s: StationId) => Math.sqrt(counts[s]);
  const cappable = (s: StationId) => s === "land" && busy.length > 1;
  const cap = (o.landShare ?? SILO.LAND_SHARE) * total;
  // water-fill: spend what is left above the floors in proportion to sqrt(count); a capped station freezes at its cap
  let free = total - SILO_ORDER.reduce((a, s) => a + w[s], 0), open = busy.slice();
  for (let guard = 0; guard < n && free > 1e-9 && open.length; guard++) {
    const sum = open.reduce((a, s) => a + weight(s), 0), frozen: StationId[] = [];
    for (const s of open) { const want = w[s] + (free * weight(s)) / sum; if (cappable(s) && want > cap) frozen.push(s); }
    if (!frozen.length) { for (const s of open) w[s] += (free * weight(s)) / sum; free = 0; break; }
    for (const s of frozen) { free -= Math.max(0, cap - w[s]); w[s] = Math.max(w[s], cap); }
    open = open.filter(s => !frozen.includes(s));
  }
  if (free > 1e-9) { // every busy station is capped (e.g. only Land plus slack): share the slack evenly rather than lose width
    const each = free / n; for (const s of SILO_ORDER) w[s] += each;
  }
  return roundTo(w, total);
}

/** Largest-remainder rounding so the integers sum to exactly `total`. */
function roundTo(w: Record<StationId, number>, total: number): Record<StationId, number> {
  const floor = SILO_ORDER.map(s => Math.floor(w[s]));
  let rest = total - floor.reduce((a, b) => a + b, 0);
  const order = SILO_ORDER.map((s, i) => ({ i, r: w[s] - floor[i] })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) { if (rest <= 0) break; floor[i]++; rest--; }
  return Object.fromEntries(SILO_ORDER.map((s, i) => [s, floor[i]])) as Record<StationId, number>;
}

/** Left edges for a run of widths starting at `x0` (the bays sit edge to edge). */
export const siloRects = (widths: Record<StationId, number>, x0: number): { x: number; w: number }[] => {
  let x = x0; return SILO_ORDER.map(s => { const r = { x, w: widths[s] }; x += widths[s]; return r; });
};

/** Ease between two layouts: `k` in 0..1 (already eased by the caller). Pure so the tween is testable. */
export const lerpRects = (a: readonly { x: number; w: number }[], b: readonly { x: number; w: number }[], k: number) => b.map((r, i) => ({ x: a[i].x + (r.x - a[i].x) * k, w: a[i].w + (r.w - a[i].w) * k }));
