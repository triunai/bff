// Wall-clock lane timeline (pure): one row per agent lane, tool calls as bars on a shared clock. Shape taken from Chrome DevTools
// Performance (overview strip + brush, named lanes, shade only the part past the slow threshold) and Perfetto (pinned tracks, nested
// groups). Reimplemented, no code copied. PRIVACY: tool names, statuses and timestamps only. Calls with no start time are COUNTED per
// lane ("n untimed"), never drawn at 0.
import { callKey, type Call } from "../analytics.ts";
import { isSlow, humanDuration } from "../live-observer.ts";
import { toneForStatus, type Tone } from "../ui-tokens.ts";
import { identityOf, type FleetIndex } from "./call-identity.ts";
import { foldRuns, type CallRun } from "./call-runs.ts";
import type { FleetRole, FleetState } from "./fleet-types.ts";

export const DEFAULT_WINDOW_MS = 30 * 60_000;
export const BREAK_MS = 10 * 60_000;
/** A span narrower than this share of the window folds into a density segment. */
export const MIN_SPAN_FRAC = 1 / 2000;
export const MINIMAP_BUCKETS = 60;
export const RETRY_LOOP_RUN = 3;
export const MIN_WINDOW_MS = 1000;

export type TimeWindow = { t0: number; t1: number };
export interface TimelineInput {
  calls: readonly Call[];
  index: FleetIndex;
  laneState?: ReadonlyMap<string, FleetState>;
  /** null = the last DEFAULT_WINDOW_MS of activity. */
  window: TimeWindow | null;
  pins: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  now: number;
  /** Fold runs of consecutive same-tool calls into one span each. Default true. */
  fold?: boolean;
  /** Run keys (CallRun.key) the user opened: those calls draw individually again. */
  expanded?: ReadonlySet<string>;
}
/** Set on a span that stands for a whole run of calls (the span's callKey is the run's key). */
export interface SpanRun { count: number; failed: number; tool: string; /** First call of the run: where focus lands when it opens. */ first: string; /** Every member call key (so a selected call inside the run can be found). */ callKeys: string[]; /** Members that intersect the window: what `drawn` counts. */ inWindow: number }
/** An opened run: its calls are individual spans, this keeps the bracket that folds them back. */
export interface OpenRun { key: string; tool: string; count: number; failed: number; x0: number; x1: number }
export interface TimelineSpan {
  callKey: string;
  /** Fractions of the window, 0..1. */
  x0: number; x1: number;
  tool: string;
  status: Call["status"];
  tone: Tone;
  /** Where the slow threshold is crossed (window fraction, within x0..x1) or null. */
  slowFrom: number | null;
  /** denied or error: the bar carries a cross glyph, not colour alone. */
  error: boolean;
  /** 1 for a real bar; > 1 for a density segment that stands for that many calls. */
  count: number;
  title: string;
  run?: SpanRun;
}
export interface TimelineLane {
  key: string;
  label: string;
  modelLetter: string | null;
  role: FleetRole | null;
  depth: number;
  parentKey: string | null;
  /** Descendant lanes (shown or folded away). */
  childCount: number;
  collapsed: boolean;
  pinned: boolean;
  known: boolean;
  state: FleetState | null;
  spans: TimelineSpan[];
  untimed: number;
  retryLoop: boolean;
  openRuns: OpenRun[];
}
export interface MinimapBucket { t0: number; t1: number; total: number; byTone: Partial<Record<Tone, number>> }
export interface TimelineBreak { x0: number; x1: number; from: number; to: number; ms: number }
export interface TimelineTick { x: number; at: number; label: string }
export interface TimelineModel {
  domain: TimeWindow | null;
  window: TimeWindow | null;
  ticks: TimelineTick[];
  lanes: TimelineLane[];
  minimap: { buckets: MinimapBucket[]; max: number };
  breaks: TimelineBreak[];
  /** Timed calls drawn inside the window (a density segment counts all calls it stands for; a folded run counts only its members inside the window). */
  drawn: number;
  untimed: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const clockLabel = (at: number, seconds: boolean) => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ""}`; };
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400].map(s => s * 1000);

/** Nice wall-clock ticks, about 6-8 across; seconds shown only when the step is under a minute. */
export function timeTicks(w: TimeWindow): TimelineTick[] {
  const span = w.t1 - w.t0;
  const step = STEPS.find(s => span / s <= 8) ?? STEPS[STEPS.length - 1];
  // Align to LOCAL wall clock: shift by the zone offset so hour/day steps land on :00.
  const off = (at: number) => -new Date(at).getTimezoneOffset() * 60_000;
  const out: TimelineTick[] = [];
  for (let at = Math.ceil((w.t0 + off(w.t0)) / step) * step - off(w.t0); at <= w.t1; at += step) out.push({ x: (at - w.t0) / span, at, label: clockLabel(at, step < 60_000) });
  return out;
}

/** Zoom about `anchor` (0..1 of the window); factor < 1 zooms in. Clamped to the domain. */
export function zoomWindow(w: TimeWindow, domain: TimeWindow, factor: number, anchor = 0.5): TimeWindow {
  const width = Math.min(domain.t1 - domain.t0, Math.max(MIN_WINDOW_MS, (w.t1 - w.t0) * factor));
  return clampWindow({ t0: w.t0 + (w.t1 - w.t0) * anchor - width * anchor, t1: w.t0 + (w.t1 - w.t0) * anchor + width * (1 - anchor) }, domain);
}
/** Pan by a fraction of the window width. */
export function panWindow(w: TimeWindow, domain: TimeWindow, frac: number): TimeWindow {
  const d = (w.t1 - w.t0) * frac;
  return clampWindow({ t0: w.t0 + d, t1: w.t1 + d }, domain);
}
export function clampWindow(w: TimeWindow, domain: TimeWindow): TimeWindow {
  const full = domain.t1 - domain.t0, width = Math.min(full, Math.max(MIN_WINDOW_MS, w.t1 - w.t0));
  const t0 = Math.min(domain.t1 - width, Math.max(domain.t0, w.t0));
  return { t0, t1: Math.min(domain.t1, t0 + width) };
}

/** The slow threshold `isSlow` applies to this call, read from isSlow itself so there is one definition. */
const slowThresholdMs = (c: Call): number | null => [5000, 10000, 60000].find(t => isSlow({ ...c, status: "success", durationMs: t })) ?? null;
const TONE_RANK: Record<string, number> = { failure: 4, attention: 3, running: 2, success: 1, muted: 0, info: 0 };
const STATE_RANK: Record<string, number> = { live: 0, idle: 1, done: 2 };

type Timed = { c: Call; start: number; end: number };
const timedOf = (c: Call, now: number): Timed | null => {
  if (c.startedAt === null) return null;
  const end = c.endedAt !== null ? Math.max(c.endedAt, c.startedAt) : c.status === "running" ? Math.max(now, c.startedAt) : c.startedAt;
  return { c, start: c.startedAt, end };
};
const spanTitle = (c: Call, start: number) => `${c.tool} · ${c.status} · ${humanDuration(c.durationMs)}${c.durationMs !== null ? ` ${c.durationKind === "observed" ? "observed" : "provider"}` : ""} · ${clockLabel(start, true)}`;

function hasRetryLoop(timed: Timed[]): boolean {
  let run = 0, tool = "";
  for (const t of [...timed].sort((a, b) => a.start - b.start)) {
    if (t.c.status === "error") { run = t.c.tool === tool ? run + 1 : 1; tool = t.c.tool; if (run >= RETRY_LOOP_RUN) return true; } else { run = 0; tool = ""; }
  }
  return false;
}

export function buildCallTimeline(input: TimelineInput): TimelineModel {
  const { index, laneState, pins, collapsed, now } = input;
  const expanded = input.expanded ?? new Set<string>();
  const runsByLane = new Map<string, CallRun[]>();
  if (input.fold !== false) for (const r of foldRuns(input.calls, { now })) { const g = runsByLane.get(r.lane); if (g) g.push(r); else runsByLane.set(r.lane, [r]); }
  const groups = new Map<string, Call[]>();
  for (const c of input.calls) { const g = groups.get(c.sessionId); if (g) g.push(c); else groups.set(c.sessionId, [c]); }
  const timedBy = new Map<string, Timed[]>();
  let untimedTotal = 0, d0 = Infinity, d1 = -Infinity;
  for (const [key, cs] of groups) {
    const timed: Timed[] = [];
    for (const c of cs) { const t = timedOf(c, now); if (t) { timed.push(t); d0 = Math.min(d0, t.start); d1 = Math.max(d1, t.end); } else untimedTotal++; }
    timedBy.set(key, timed);
  }
  if (!Number.isFinite(d0)) return { domain: null, window: null, ticks: [], lanes: [], minimap: { buckets: [], max: 0 }, breaks: [], drawn: 0, untimed: untimedTotal };
  const domain: TimeWindow = { t0: d0, t1: Math.max(d1, d0 + MIN_WINDOW_MS) };
  const window = input.window ? clampWindow(input.window, domain) : clampWindow({ t0: domain.t1 - DEFAULT_WINDOW_MS, t1: domain.t1 }, domain);
  const wSpan = window.t1 - window.t0;

  // Parent lane = the lane's FleetLane.parentKey, only when that lane has calls here and is not pinned (pinned lanes float to the top).
  const parentOf = (key: string): string | null => { const p = index.get(key)?.parentKey ?? null; return p && p !== key && groups.has(p) && !pins.has(p) ? p : null; };
  const children = new Map<string, string[]>();
  for (const key of groups.keys()) { const p = parentOf(key); if (p) children.set(p, [...(children.get(p) ?? []), key]); }
  const depthOf = (key: string): number => { let d = 0, k = key; const seen = new Set([k]); for (let p = parentOf(k); p && !seen.has(p); p = parentOf(p)) { d++; seen.add(p); } return d; };
  const descendants = (key: string, seen = new Set<string>()): number => { let n = 0; for (const ch of children.get(key) ?? []) if (!seen.has(ch)) { seen.add(ch); n += 1 + descendants(ch, seen); } return n; };

  const laneOf = (key: string): TimelineLane => {
    const cs = groups.get(key)!, timed = timedBy.get(key)!, id = identityOf(cs[0], index);
    const spans: TimelineSpan[] = [], tiny = new Map<number, Timed[]>(), openRuns: OpenRun[] = [];
    const folded = new Set<string>(), byCall = new Map<string, Timed>();
    for (const t of timed) byCall.set(callKey(t.c), t);
    for (const r of runsByLane.get(key) ?? []) {
      const open = expanded.has(r.key);
      if (r.end < window.t0 || r.start > window.t1) { if (!open) for (const k of r.callKeys) folded.add(k); continue; }
      const x0 = Math.max(0, (r.start - window.t0) / wSpan), x1 = Math.min(1, Math.max(x0 + MIN_SPAN_FRAC, (r.end - window.t0) / wSpan));
      if (open) { openRuns.push({ key: r.key, tool: r.tool, count: r.count, failed: r.failed, x0, x1 }); continue; }
      for (const k of r.callKeys) folded.add(k);
      const members = r.callKeys.map(k => byCall.get(k)!), worst = members.reduce((a, b) => (TONE_RANK[toneForStatus(b.c.status)] > TONE_RANK[toneForStatus(a.c.status)] ? b : a));
      spans.push({ callKey: r.key, x0, x1, tool: r.tool, status: worst.c.status, tone: toneForStatus(worst.c.status), slowFrom: null, error: r.failed > 0, count: r.count, title: `${r.title} · ${clockLabel(r.start, true)}`, run: { count: r.count, failed: r.failed, tool: r.tool, first: r.callKeys[0], callKeys: r.callKeys, inWindow: members.filter(t => t.end >= window.t0 && t.start <= window.t1).length } });
    }
    for (const t of timed) {
      if (folded.has(callKey(t.c))) continue;
      if (t.end < window.t0 || t.start > window.t1) continue;
      const x0 = Math.max(0, (t.start - window.t0) / wSpan), x1 = Math.min(1, (t.end - window.t0) / wSpan);
      if (x1 - x0 < MIN_SPAN_FRAC) { const b = Math.floor(x0 / MIN_SPAN_FRAC); tiny.set(b, [...(tiny.get(b) ?? []), t]); continue; }
      const th = slowThresholdMs(t.c), slowAt = isSlow(t.c) && th !== null ? (t.start + th - window.t0) / wSpan : null;
      spans.push({ callKey: callKey(t.c), x0, x1, tool: t.c.tool, status: t.c.status, tone: toneForStatus(t.c.status), slowFrom: slowAt === null ? null : Math.min(x1, Math.max(x0, slowAt)), error: t.c.status === "error" || t.c.status === "denied", count: 1, title: spanTitle(t.c, t.start) });
    }
    for (const group of tiny.values()) {
      if (group.length === 1) { const t = group[0], x0 = Math.max(0, (t.start - window.t0) / wSpan); spans.push({ callKey: callKey(t.c), x0, x1: Math.min(1, x0 + MIN_SPAN_FRAC), tool: t.c.tool, status: t.c.status, tone: toneForStatus(t.c.status), slowFrom: null, error: t.c.status === "error" || t.c.status === "denied", count: 1, title: spanTitle(t.c, t.start) }); continue; }
      const worst = group.reduce((a, b) => (TONE_RANK[toneForStatus(b.c.status)] > TONE_RANK[toneForStatus(a.c.status)] ? b : a));
      const x0 = Math.max(0, Math.min(...group.map(t => (t.start - window.t0) / wSpan))), x1 = Math.min(1, Math.max(x0 + MIN_SPAN_FRAC, ...group.map(t => (t.end - window.t0) / wSpan)));
      spans.push({ callKey: callKey(worst.c), x0, x1, tool: `${group.length} calls`, status: worst.c.status, tone: toneForStatus(worst.c.status), slowFrom: null, error: group.some(t => t.c.status === "error" || t.c.status === "denied"), count: group.length, title: `${group.length} calls · worst ${worst.c.status} · ${clockLabel(Math.min(...group.map(t => t.start)), true)}` });
    }
    spans.sort((a, b) => a.x0 - b.x0);
    return { key, label: id.label, modelLetter: id.modelLetter, role: id.role, depth: depthOf(key), parentKey: parentOf(key), childCount: descendants(key), collapsed: collapsed.has(key), pinned: pins.has(key), known: id.known, state: laneState?.get(key) ?? index.get(key)?.state ?? null, spans, untimed: cs.length - timed.length, retryLoop: hasRetryLoop(timed), openRuns };
  };
  const lastAt = (key: string) => Math.max(0, ...(timedBy.get(key) ?? []).map(t => t.end));
  const order = (a: string, b: string) => {
    const sa = STATE_RANK[laneState?.get(a) ?? index.get(a)?.state ?? ""] ?? 3, sb = STATE_RANK[laneState?.get(b) ?? index.get(b)?.state ?? ""] ?? 3;
    return sa - sb || lastAt(b) - lastAt(a) || a.localeCompare(b);
  };
  const built = new Map<string, TimelineLane>();
  for (const key of groups.keys()) built.set(key, laneOf(key));
  // A lane is listed when it has spans in the window, is pinned, or a descendant does.
  const active = (key: string, seen = new Set<string>()): boolean => { if (seen.has(key)) return false; seen.add(key); const l = built.get(key)!; return l.spans.length > 0 || l.pinned || (children.get(key) ?? []).some(ch => active(ch, seen)); };
  const lanes: TimelineLane[] = [];
  const emit = (key: string) => {
    if (!active(key)) return;
    lanes.push(built.get(key)!);
    if (!collapsed.has(key)) for (const ch of [...(children.get(key) ?? [])].sort(order)) emit(ch);
  };
  for (const key of [...groups.keys()].filter(k => pins.has(k)).sort(order)) emit(key);
  for (const key of [...groups.keys()].filter(k => !pins.has(k) && parentOf(k) === null).sort(order)) emit(key);

  // Minimap: every timed call by start time over the whole domain, split by tone.
  const bw = (domain.t1 - domain.t0) / MINIMAP_BUCKETS;
  const buckets: MinimapBucket[] = Array.from({ length: MINIMAP_BUCKETS }, (_, i) => ({ t0: domain.t0 + i * bw, t1: domain.t0 + (i + 1) * bw, total: 0, byTone: {} }));
  const all: Timed[] = [...timedBy.values()].flat();
  for (const t of all) { const b = buckets[Math.min(MINIMAP_BUCKETS - 1, Math.floor((t.start - domain.t0) / bw))], tone = toneForStatus(t.c.status); b.total++; b.byTone[tone] = (b.byTone[tone] ?? 0) + 1; }

  // Breaks: idle stretches > BREAK_MS between activity across ALL lanes, inside the window. Marked, not collapsed (the axis stays linear).
  const inWin = all.filter(t => t.end >= window.t0 && t.start <= window.t1).sort((a, b) => a.start - b.start);
  const breaks: TimelineBreak[] = [];
  let reach = -Infinity;
  for (const t of inWin) {
    if (reach > -Infinity && t.start - reach > BREAK_MS) breaks.push({ x0: Math.max(0, (reach - window.t0) / wSpan), x1: Math.min(1, (t.start - window.t0) / wSpan), from: reach, to: t.start, ms: t.start - reach });
    reach = Math.max(reach, t.end);
  }
  const drawn = lanes.reduce((n, l) => n + l.spans.reduce((m, s) => m + (s.run ? s.run.inWindow : s.count), 0), 0);
  return { domain, window, ticks: timeTicks(window), lanes, minimap: { buckets, max: Math.max(0, ...buckets.map(b => b.total)) }, breaks, drawn, untimed: untimedTotal };
}

/** Roving-tabindex default: the newest bar of a lane (spans are sorted by start), or -1 when the lane has none (the label is the stop). */
export const defaultBarIndex = (spans: readonly { x0: number }[]): number => spans.length - 1;
/** Left/Right inside one lane: the neighbouring bar, clamped at both ends. */
export const stepBar = (count: number, i: number, dir: -1 | 1): number => Math.min(count - 1, Math.max(0, i + dir));
/** Up/Down: the bar in the adjacent lane whose centre is nearest in time to the current bar. span = -1 means the lane has no bar (focus its label). null = no such lane. */
export function adjacentLanePick(lanes: readonly { spans: readonly { x0: number; x1: number }[] }[], lane: number, span: number, dir: -1 | 1): { lane: number; span: number } | null {
  const to = lane + dir;
  if (to < 0 || to >= lanes.length) return null;
  const from = lanes[lane]?.spans[span], target = lanes[to].spans;
  if (target.length === 0) return { lane: to, span: -1 };
  const mid = from ? (from.x0 + from.x1) / 2 : 1;
  let best = 0, gap = Infinity;
  target.forEach((s, i) => { const d = Math.abs((s.x0 + s.x1) / 2 - mid); if (d < gap) { gap = d; best = i; } });
  return { lane: to, span: best };
}
