// Time lens (pure): the helpers behind the shared time bar (components/work/time-lens-bar.tsx) — event ticks on the scrub
// track, the clock label, the scrub value mapping, and when an open should play the catch-up. One time control for Factory,
// Board and Graph; no colours here (tones are names the view maps to tokens).
import type { HistoryEvent } from "./surface-types.ts";

export type LensTone = "success" | "running" | "attention" | "muted";
export type LensTick = { at: number; pct: number; tone: LensTone; label: string };
/** Ticks per kind of event: a close lands, a start runs, a status change back to open needs a look. Created beads are no tick. */
const toneOf = (e: HistoryEvent): LensTone | null => e.kind === "closed" || e.to === "closed" ? "success" : e.kind === "started" || e.to === "in_progress" ? "running" : e.kind === "status" ? "attention" : null;
const short = (id: string) => { const k = id.indexOf("-"); return k >= 0 && k < id.length - 1 ? id.slice(k + 1) : id; };

/** Up to `max` ticks inside [t0, t1], newest kept, oldest first; pct is the position on the track (0..100). */
export function lensTicks(events: readonly HistoryEvent[], t0: number, t1: number, max = 60): LensTick[] {
  const span = Math.max(1, t1 - t0), out: LensTick[] = [];
  for (const e of events) {
    const tone = toneOf(e); if (tone === null || e.at < t0 || e.at > t1) continue;
    out.push({ at: e.at, pct: ((e.at - t0) / span) * 100, tone, label: `${short(e.id)} ${tone === "success" ? "landed" : tone === "running" ? "started" : "changed"}` });
  }
  out.sort((a, b) => a.at - b.at);
  return out.slice(Math.max(0, out.length - max));
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Default clock: local HH:MM. */
export const hhmm = (at: number) => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** The clock beside the track: "now · 14:05" when live, else the scrubbed time ("13:20"). */
export const lensClock = (t: number, now: number, fmt: (at: number) => string = hhmm) => (t >= now ? `now · ${fmt(now)}` : fmt(t));

/** Track position 0..steps for t, and back. The right end is exactly now (live). */
export const toTrack = (t: number, t0: number, t1: number, steps = 1000) => Math.round((Math.min(t1, Math.max(t0, t)) - t0) / Math.max(1, t1 - t0) * steps);
export const fromTrack = (v: number, t0: number, t1: number, steps = 1000) => (v >= steps ? t1 : t0 + (Math.max(0, v) / steps) * (t1 - t0));

/** Catch-up on open (lead rule): play it when this viewer has not looked in the last `freshMs` (default 10 min), else go
 * straight to live. `lastViewed` null means never. */
export const CATCHUP_FRESH_MS = 10 * 60_000;
export const shouldCatchUp = (lastViewed: number | null, now: number, freshMs = CATCHUP_FRESH_MS) => lastViewed === null || now - lastViewed > freshMs;
/** History this viewer has not seen yet: events after lastViewed (all of them when never viewed). Drives "catch me up". */
export const unseenCount = (events: readonly HistoryEvent[], lastViewed: number | null, now: number) => events.filter(e => e.at <= now && (lastViewed === null || e.at > lastViewed)).length;

/** Landed per hour for the last `hours` hours ending at t, oldest first (the stat row's sparkline). Each bead counts once. */
export function hourlyLanded(events: readonly HistoryEvent[], t: number, hours = 10): number[] {
  const out = Array<number>(hours).fill(0), from = t - hours * 3600_000, seen = new Set<string>();
  for (const e of [...events].sort((a, b) => b.at - a.at)) {
    if (e.at > t || e.at <= from || !(e.kind === "closed" || e.to === "closed") || seen.has(e.id)) continue;
    seen.add(e.id); out[Math.min(hours - 1, Math.floor((e.at - from) / 3600_000))]++;
  }
  return out;
}

/** Hour marks for the scrub track: one per whole local hour strictly inside (t0, t1), pct 0..100. Pure presentation; scrubbing never animates. */
export function hourMarks(t0: number, t1: number): { at: number; pct: number; label: string }[] {
  const out: { at: number; pct: number; label: string }[] = [];
  if (!(t1 > t0)) return out;
  const d = new Date(t0); d.setMinutes(0, 0, 0);
  for (let h = d.getTime() + 3_600_000; h < t1; h = new Date(h).setHours(new Date(h).getHours() + 1, 0, 0, 0)) {
    out.push({ at: h, pct: ((h - t0) / (t1 - t0)) * 100, label: `${String(new Date(h).getHours()).padStart(2, "0")}:00` });
    if (out.length > 48) break;
  }
  return out;
}
/** Hour-label thinning: the smallest step (1, 2, 3, 6 or 12 h) at which two printed labels sit at least LABEL_PX apart on a track `trackPx` wide. Marks in between stay as ticks only. */
export const LABEL_PX = 24;
export const HOUR_STEPS = [1, 2, 3, 6, 12] as const;
export function hourLabelStep(trackPx: number, t0: number, t1: number): number {
  const hours = Math.max(1e-6, (t1 - t0) / 3_600_000), perHour = Math.max(0, trackPx) / hours;
  return HOUR_STEPS.find(st => perHour * st >= LABEL_PX) ?? 24;
}
/** "HH:MM" (24 h, today in local time) as a time clamped into [t0, now]; anything else is null. */
export function parseJump(text: string, t0: number, now: number): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const at = new Date(now).setHours(Number(m[1]), Number(m[2]), 0, 0);
  return Math.min(now, Math.max(t0, at));
}
