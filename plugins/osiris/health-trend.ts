// Health rework — trend over per-repo snapshots kept in the viewer's own localStorage. Pure except load/save.
import type { HealthRow, HealthSnapshot, Trend } from "./health-types.ts";

const KEY = "osiris.health.history.v1:";
const same = (a: Record<string, number>, b: Record<string, number>) => { const k = Object.keys(a); return k.length === Object.keys(b).length && k.every(x => a[x] === b[x]); };

/** Append only when the figures differ from the last entry; oldest dropped past `cap`. Never mutates. */
export function recordSnapshot(history: HealthSnapshot[], snap: HealthSnapshot, cap = 60): HealthSnapshot[] {
  const last = history[history.length - 1];
  if (last && same(last.figures, snap.figures)) return history.slice();
  return [...history, snap].slice(-cap);
}
export function snapshotOf(rows: HealthRow[], at: number): HealthSnapshot {
  const figures: Record<string, number> = {};
  for (const r of rows) if (typeof r.metric === "number" && Number.isFinite(r.metric)) figures[r.id] = r.metric;
  return { at, figures };
}
const hhmm = (at: number) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
/** Latest snapshot at/before the last wrap (it predates the wrap, so it is labelled with its own time), else the earliest one, else null. */
export function baselineFor(history: HealthSnapshot[], wrapAt: number | null): { snap: HealthSnapshot; since: string } | null {
  if (!history.length) return null;
  if (wrapAt !== null) { const w = history.filter(h => h.at <= wrapAt); if (w.length) return { snap: w.reduce((a, b) => (b.at >= a.at ? b : a)), since: `since ${hhmm(w.reduce((a, b) => (b.at >= a.at ? b : a)).at)} (last seen before the wrap)` }; }
  const first = history.reduce((a, b) => (b.at < a.at ? b : a));
  return { snap: first, since: `since first seen ${hhmm(first.at)}` };
}
/** delta = metric - base; lower is better for every row. */
export function applyTrends(rows: HealthRow[], baseline: { snap: HealthSnapshot; since: string } | null): HealthRow[] {
  return rows.map(r => {
    const base = baseline?.snap.figures[r.id];
    if (!baseline || r.metric === undefined || base === undefined) return { ...r, trend: null };
    const delta = r.metric - base;
    const trend: Trend = { delta, direction: delta < 0 ? "better" : delta > 0 ? "worse" : "same", since: baseline.since };
    return { ...r, trend };
  });
}
const valid = (x: unknown): x is HealthSnapshot => !!x && typeof x === "object" && typeof (x as HealthSnapshot).at === "number" && !!(x as HealthSnapshot).figures && typeof (x as HealthSnapshot).figures === "object" && Object.values((x as HealthSnapshot).figures).every(v => typeof v === "number");
export function loadHistory(repo: string): HealthSnapshot[] {
  try { const v = JSON.parse(localStorage.getItem(KEY + repo) ?? "[]"); return Array.isArray(v) ? v.filter(valid) : []; } catch { return []; }
}
export function saveHistory(repo: string, h: HealthSnapshot[]): void {
  try { localStorage.setItem(KEY + repo, JSON.stringify(h)); } catch { /* storage unavailable: trend just restarts */ }
}
