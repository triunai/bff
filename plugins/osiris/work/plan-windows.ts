// Plan windows (5-hour and weekly) for the Calls > Cost & cache tile: pure maths and plain words, no I/O.
//
// The forecast, window-lookback, liveLimit and duration helpers are ported from headroom
// (https://github.com/vihrea1337/headroom @ 67c808ac819709966f65f6989d4ea629ac0701ba, hooks/core.ts), MIT, (c) 2026 vihrea1337.
// Licence text: third_party/headroom-LICENSE.txt. Adapted: English only, readings come from the osiris-bridge feed's measure rows.
import type { FeedRow } from "../mod-feed.ts";
import type { LaneSignal } from "./loop-signals.ts";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** How long each known window lasts. */
export const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * DAY };
/** A reading older than this is shown as stale rather than as current. */
export const STALE_MS = 30 * MIN;

export type Limit = { kind: string; pct: number; resetsAt: number | null };
export type Sample = { kind: string; at: number; pct: number; resetsAt: number | null };
export type Verdict = "calm" | "tight" | "short" | "empty" | "unknown";
export type Forecast = { rate: number | null; emptyAt: number | null; verdict: Verdict };

export function parseResetsAt(iso: string | undefined | null): number | null {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
}

/** A window whose reset time has passed reads as empty until the feed says otherwise. */
export function liveLimit(l: Limit, now: number): Limit {
    return l.resetsAt !== null && l.resetsAt <= now ? { ...l, pct: 0, resetsAt: null } : l;
}

/** Readings to measure over: the last 90 minutes of a 5-hour window, the last day of a weekly one. */
export function lookback(kind: string): number {
    return (WINDOW_MS[kind] ?? 5 * HOUR) > DAY ? DAY : 90 * MIN;
}

/**
 * The burn rate is a least-squares slope over this window's own readings (same reset time), so one jump of a whole point
 * does not swing it. It needs 3 readings spanning 10 minutes and a rise of 2 points; otherwise there is no forecast.
 */
export function forecast(limit: Limit, samples: readonly Sample[], now: number): Forecast {
    if (limit.pct >= 100) return { rate: null, emptyAt: now, verdict: "empty" };
    const since = now - lookback(limit.kind);
    const pts = samples.filter(s => s.kind === limit.kind && s.resetsAt === limit.resetsAt && s.at >= since).map(s => ({ x: s.at, y: s.pct }));
    pts.push({ x: now, y: limit.pct });
    const first = pts[0];
    if (!first || pts.length < 3 || now - first.x < 10 * MIN || limit.pct - first.y < 2) return { rate: null, emptyAt: null, verdict: limit.pct >= 80 ? "tight" : "unknown" };
    const n = pts.length, mx = pts.reduce((a, p) => a + p.x, 0) / n, my = pts.reduce((a, p) => a + p.y, 0) / n;
    const sxx = pts.reduce((a, p) => a + (p.x - mx) ** 2, 0), sxy = pts.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0);
    const perMs = sxx > 0 ? sxy / sxx : 0;
    if (perMs <= 0) return { rate: 0, emptyAt: null, verdict: limit.pct >= 80 ? "tight" : "calm" };
    const rate = perMs * HOUR, emptyAt = now + (100 - limit.pct) / perMs;
    if (limit.resetsAt === null) return { rate, emptyAt, verdict: "unknown" };
    if (emptyAt < limit.resetsAt) return { rate, emptyAt, verdict: "short" };
    const slack = (limit.resetsAt - now) * 0.25;
    return { rate, emptyAt, verdict: limit.pct >= 80 || emptyAt < limit.resetsAt + slack ? "tight" : "calm" };
}

/** "1h 48m", "4d 2h", "<1m": the two largest units. */
export function fmtLeft(ms: number): string {
    if (ms < MIN) return "<1m";
    const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / HOUR), m = Math.floor((ms % HOUR) / MIN);
    if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
}
const p2 = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
/** "17:15" when within 20 hours, else "Mo 09:00" (local time). */
export function fmtAt(at: number, now: number): string {
    const d = new Date(at), hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
    return Math.abs(at - now) < 20 * HOUR ? hm : `${DAYS[d.getDay()]} ${hm}`;
}

/** Readings of every window, oldest first, from the feed's measure rows (account-wide, so every session contributes). */
export function samplesFromRows(rows: readonly FeedRow[]): Sample[] {
    const out: Sample[] = [];
    for (const r of rows) {
        if (r.kind !== "measure") continue;
        for (const w of r.rate) if (w.kind in WINDOW_MS) out.push({ kind: w.kind, at: r.ts, pct: w.percentUsed, resetsAt: parseResetsAt(w.resetsAt) });
    }
    return out.sort((a, b) => a.at - b.at);
}

export interface PlanReply { rows: readonly FeedRow[]; windows: { fiveHour: { percentUsed: number; resetsAt?: string } | null; sevenDay: { percentUsed: number; resetsAt?: string } | null }; lastTs: number | null; gap: boolean; lanes?: readonly LaneSignal[]; stats?: { truncated?: boolean; droppedRows?: number; error?: string | null } }
export interface WindowTile { kind: "five_hour" | "seven_day"; title: string; value: string; sub: string; verdict: Verdict; bad: boolean }
export interface PlanView { state: "no-feed" | "no-windows" | "ok"; note: string; tiles: WindowTile[] }

const VERDICT_WORDS: Record<Verdict, string> = { calm: "lasts until reset", tight: "tight", short: "runs out before reset", empty: "limit reached", unknown: "no forecast yet" };

/** The tile's content. Without a feed (null reply, or a feed with no window reading) it says so and shows no numbers. */
/** Loud, plain words when the feed read lost rows or failed (D-138); empty when it is whole. */
export function feedLossNote(st: PlanReply["stats"]): string {
    if (!st) return "";
    const parts: string[] = [];
    if (st.error) parts.push(`The feed could not be read (${st.error}).`);
    if (st.droppedRows && st.droppedRows > 0) parts.push(`${st.droppedRows} older feed rows were dropped from memory, so loop and forecast history is partial.`);
    return parts.join(" ");
}

export function planView(reply: PlanReply | null, now: number): PlanView {
    if (!reply || typeof reply.lastTs !== "number") return { state: "no-feed", tiles: [], note: (reply?.stats?.error ? `The feed could not be read (${reply.stats.error}). ` : "") + "No plan-window feed. The osiris-bridge mod writes it; it is not installed or has not run yet." };
    const raw = [["five_hour", "5-hour window", reply.windows.fiveHour], ["seven_day", "Weekly window", reply.windows.sevenDay]] as const;
    if (!raw.some(r => r[2])) return { state: "no-windows", tiles: [], note: "The feed is running but has not reported a 5-hour or weekly reading yet." };
    const samples = samplesFromRows(reply.rows), age = now - reply.lastTs, stale = age > STALE_MS;
    const tiles: WindowTile[] = raw.map(([kind, title, w]) => {
        if (!w) return { kind, title, value: "—", sub: "no reading from the plan", verdict: "unknown" as Verdict, bad: false };
        const lim = liveLimit({ kind, pct: w.percentUsed, resetsAt: parseResetsAt(w.resetsAt) }, now), f = forecast(lim, samples, now);
        const parts: string[] = [];
        parts.push(lim.resetsAt !== null ? `resets in ${fmtLeft(lim.resetsAt - now)}` : "reset time unknown");
        if (f.verdict === "empty") parts.push(VERDICT_WORDS.empty);
        else if (f.rate !== null && f.rate > 0 && f.emptyAt !== null) parts.push(`+${f.rate.toFixed(f.rate >= 10 ? 0 : 1)}%/h, ${f.verdict === "short" ? `runs out ~${fmtAt(f.emptyAt, now)}` : VERDICT_WORDS[f.verdict]}`);
        else parts.push(f.rate === 0 ? `flat, ${VERDICT_WORDS[f.verdict]}` : VERDICT_WORDS[f.verdict]);
        if (stale) parts.push(`last reading ${fmtLeft(age)} ago`);
        return { kind, title, value: `${Math.round(lim.pct)}%`, sub: parts.join(" · "), verdict: f.verdict, bad: f.verdict === "short" || f.verdict === "empty" };
    });
    const notes = [reply.gap ? "Transcripts are newer than the feed: a session may not have the bridge loaded, so these readings can lag." : "", feedLossNote(reply.stats)].filter(Boolean);
    return { state: "ok", tiles, note: notes.join(" ") };
}
