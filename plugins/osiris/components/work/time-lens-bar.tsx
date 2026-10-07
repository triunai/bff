import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { HistoryEvent } from "../../work/surface-types.ts";
import { timeRange } from "../../work/replay.ts";
import { fromTrack, hourLabelStep, hourMarks, lensClock, lensTicks, parseJump, toTrack } from "../../work/time-lens.ts";
import { replayAdvance } from "../../work/factory-floor-model.ts";

export type LensSpeed = 1 | 4 | 16;
/** `accent` is a CSS custom-property NAME (e.g. "--oi-heat-age-3"): the mode button gets an underline in it, so each mode reads as its own hue. */
export type LensHeatMode = { id: string; label: string; title?: string; accent?: string };
export type TimeLensProps = {
  events: readonly HistoryEvent[]; t: number; now: number; t0?: number;
  playing: boolean; speed: LensSpeed; speeds?: readonly LensSpeed[];
  onScrub(t: number): void; onPlay(on: boolean): void; onSpeed(s: LensSpeed): void;
  /** Optional heat control (Factory). Omit `heatModes` and the control is not drawn. */
  heat?: string | null; heatModes?: readonly LensHeatMode[]; onHeat?(id: string | null): void;
  /** Optional scale switch inside the heat control, shown while a heat mode is on: absolute (fixed max) or relative. */
  heatScale?: "absolute" | "relative"; onHeatScale?(s: "absolute" | "relative"): void;
  /** Optional slot right after replay (Factory: "catch me up" while there is unseen history, "skip" during a catch-up). */
  extra?: ReactNode;
  /** Factory only: hour tick marks on the track and a "Jump to time" HH:MM input (today). Scrubbing to it never animates. */
  jump?: boolean;
  /** Factory only: the view toggles as icon buttons, pushed to the right end of the SAME row (one control row, no second toolbar). */
  tools?: ReactNode;
};

/** The one time control for the Work surface (owner-approved look, frozen): replay / pause, 1× 4× 16×, a scrub track with
 * event ticks, "now · HH:MM", and an optional heat control. Pure presentation: the parent owns the clock, or uses
 * useTimeLens below. */
export function TimeLensBar(p: TimeLensProps) {
  const t0 = p.t0 ?? timeRange(p.events, p.now).t0;
  const ticks = useMemo(() => lensTicks(p.events, t0, p.now), [p.events, t0, p.now]);
  const clock = lensClock(p.t, p.now);
  const trackRef = useRef<HTMLDivElement>(null), [trackPx, setTrackPx] = useState(600); // the scrubber's width decides how many hour labels fit
  useEffect(() => { const el = trackRef.current; if (!el || typeof ResizeObserver === "undefined") return; const ro = new ResizeObserver(() => setTrackPx(el.clientWidth || 600)); ro.observe(el); setTrackPx(el.clientWidth || 600); return () => ro.disconnect(); }, []);
  return <div className="oi-tl">
    <button type="button" className="oi-tl-play" aria-label={p.playing ? "Pause replay" : "Replay history"} onClick={() => p.onPlay(!p.playing)}>{p.playing ? "❚❚ pause" : "▶ replay"}</button>
    {p.extra}
    <div className="oi-tl-seg" role="group" aria-label="Replay speed">{(p.speeds ?? [1, 4, 16]).map(s => <button key={s} type="button" aria-pressed={p.speed === s} onClick={() => p.onSpeed(s)}>{s}×</button>)}</div>
    <div className="oi-tl-track" ref={trackRef}>
      <input type="range" min={0} max={1000} step={1} value={toTrack(p.t, t0, p.now)} aria-label="Scrub through history" aria-valuetext={clock} onChange={e => { p.onPlay(false); p.onScrub(fromTrack(Number(e.target.value), t0, p.now)); }} />
      {p.jump && <div className="oi-tl-hours" aria-hidden="true">{(() => { const step = hourLabelStep(trackPx, t0, p.now); return hourMarks(t0, p.now).map(h => <i key={h.at} style={{ left: `${h.pct}%` }}>{Number(h.label.slice(0, 2)) % step === 0 && <b>{h.label.slice(0, 2)}</b>}</i>); })()}</div>}
      <div className="oi-tl-ticks" aria-hidden="true">{ticks.map((k, i) => <i key={i} className={`oi-tl-${k.tone}`} style={{ left: `${k.pct}%` }} title={k.label} />)}</div>
    </div>
    <span className="oi-tl-clock">{clock}</span>
    {p.jump && <input className="oi-tl-jump" type="text" inputMode="numeric" placeholder="HH:MM" maxLength={5} aria-label="Jump to time (HH:MM, today)" title="Jump to time: type HH:MM (today) and press Enter" onKeyDown={e => { if (e.key !== "Enter") return; const v = parseJump(e.currentTarget.value, t0, p.now); if (v === null) { e.currentTarget.setAttribute("aria-invalid", "true"); return; } e.currentTarget.removeAttribute("aria-invalid"); p.onPlay(false); p.onScrub(v); e.currentTarget.value = ""; }} />}
    {p.heatModes && p.onHeat && <div className="oi-tl-seg" role="group" aria-label="Heat">
      <button type="button" aria-pressed={!p.heat} onClick={() => p.onHeat!(null)}>No heat</button>
      {p.heatModes.map(m => <button key={m.id} type="button" aria-pressed={p.heat === m.id} title={m.title} style={m.accent ? { borderBottom: `2px solid var(${m.accent})` } : undefined} onClick={() => p.onHeat!(m.id)}>{m.label}</button>)}
      {p.heat && p.heatScale && p.onHeatScale && <button type="button" className="oi-tl-scale" title="Heat scale: absolute = a fixed maximum; relative = the hottest on screen is brightest" aria-label={`Heat scale ${p.heatScale}, switch`} onClick={() => p.onHeatScale!(p.heatScale === "absolute" ? "relative" : "absolute")}>{p.heatScale === "absolute" ? "abs" : "rel"}</button>}
    </div>}
    {p.tools && <div className="oi-tl-tools" role="toolbar" aria-label="View options">{p.tools}</div>}
  </div>;
}

/** A self-contained clock for views without their own (Board, Graph): returns TimeLensBar props. Live (t = now) until the
 * viewer scrubs or plays; playing walks t0 → now in 24 s / speed and returns to live at the end. */
export function useTimeLens(events: readonly HistoryEvent[], now: number): Omit<TimeLensProps, "heat" | "heatModes" | "onHeat" | "extra"> & { live: boolean } {
  const [at, setAt] = useState<number | null>(null), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState<LensSpeed>(4);
  const range = useMemo(() => timeRange(events, now), [events, now]);
  const ref = useRef({ at, range, speed }); ref.current = { at, range, speed };
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = 0, cur = ref.current.at === null || ref.current.at >= ref.current.range.t1 ? ref.current.range.t0 : ref.current.at;
    const tick = (ts: number) => {
      if (last) { const r = ref.current.range; cur = replayAdvance(cur, Math.min(100, ts - last), r.t0, r.t1, ref.current.speed); if (cur >= r.t1) { setAt(null); setPlaying(false); return; } setAt(cur); }
      last = ts; raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [playing]);
  const t = at === null ? now : Math.min(at, now);
  return { events, t, now, t0: range.t0, playing, speed, live: at === null, onScrub: v => setAt(v >= range.t1 ? null : v), onPlay: setPlaying, onSpeed: setSpeed };
}

export const timeLensBarStyles = `
.oi-tl{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--oi-border);min-width:0}
.oi-tl button{font:12px ui-monospace,monospace;color:var(--oi-text);cursor:pointer}
.oi-tl-play{min-width:92px;min-height:30px;border:1px solid var(--oi-accent,var(--oi-tone-info));background:transparent;border-radius:8px;font-weight:600!important;color:var(--oi-accent,var(--oi-tone-info))!important}
.oi-tl-seg{display:inline-flex;border:1px solid var(--oi-border);border-radius:8px;overflow:hidden}
.oi-tl-seg button{border:0;background:transparent;padding:4px 10px;min-height:30px;color:var(--oi-tone-muted)}
.oi-tl-seg button[aria-pressed=true]{background:var(--oi-selected);color:var(--oi-text);box-shadow:inset 0 -2px 0 var(--oi-accent,var(--oi-tone-info))}
.oi-tl-seg .oi-tl-scale{font-size:10.5px;padding:0 7px;border-left:1px solid var(--oi-border);color:var(--oi-text)}
.oi-tl-track{position:relative;flex:1;min-width:160px}
.oi-tl-track input{width:100%;accent-color:var(--oi-accent,var(--oi-tone-info))}
.oi-tl-ticks{position:absolute;left:0;right:0;top:-2px;height:4px;pointer-events:none}
.oi-tl-ticks i{position:absolute;width:2px;height:4px;opacity:.75}
.oi-tl-success{background:var(--oi-tone-success)}.oi-tl-running{background:var(--oi-tone-running)}.oi-tl-attention{background:var(--oi-tone-attention)}.oi-tl-muted{background:var(--oi-tone-muted)}
.oi-tl-hours{position:absolute;left:0;right:0;bottom:-11px;height:10px;pointer-events:none}
.oi-tl-hours i{position:absolute;width:1px;height:4px;background:var(--oi-border-strong,var(--oi-border))}
.oi-tl-hours b{position:absolute;top:4px;left:-6px;font:9px ui-monospace,monospace;font-weight:400;color:var(--oi-tone-muted)}
.oi-tl-track:has(.oi-tl-hours){margin-bottom:10px}
.oi-tl-jump{width:56px;min-height:26px;padding:0 6px;border:1px solid var(--oi-border);border-radius:6px;background:transparent;color:var(--oi-text);font:11px ui-monospace,monospace}
.oi-tl-jump[aria-invalid=true]{border-color:var(--oi-tone-failure)}
.oi-tl-tools{display:flex;gap:2px;align-items:center;flex-wrap:wrap;margin-left:auto}
.oi-tl-clock{font:12px ui-monospace,monospace;min-width:120px;text-align:right;color:var(--oi-text)}
`;
