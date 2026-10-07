import { useEffect, useRef } from "react";

/** Shared replay bar for the Work surface (Graph and Factory), ported from the v1 mockup's scrub row: replay/pause, a
 * range over [t0, t1], the clock, and labelled marks. Pure presentation: the parent owns `value` and `playing`; while
 * playing, this steps `value` forward over ~12 s of wall time and stops (and reports done) at t1. */
export function TimeScrubber(p: { t0: number; t1: number; value: number; playing: boolean; marks: { at: number; label: string }[]; onChange(t: number): void; onPlaying(on: boolean): void }) {
  const live = useRef(p); live.current = p;
  useEffect(() => {
    if (!p.playing) return;
    const span = Math.max(1, p.t1 - p.t0), step = span / 120;
    const id = setInterval(() => {
      const q = live.current, next = Math.min(q.t1, (q.value >= q.t1 ? q.t0 : q.value) + step);
      q.onChange(next);
      if (next >= q.t1) q.onPlaying(false);
    }, 100);
    return () => clearInterval(id);
  }, [p.playing, p.t0, p.t1]);
  const span = Math.max(1, p.t1 - p.t0), atNow = p.value >= p.t1;
  const clock = atNow ? "now" : new Date(p.value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return <div className="oi-ts">
    <button type="button" className="oi-ts-play" onClick={() => p.onPlaying(!p.playing)} aria-label={p.playing ? "Pause replay" : "Replay history"}>{p.playing ? "❚❚ pause" : "▶ replay"}</button>
    <div className="oi-ts-track">
      <input type="range" min={p.t0} max={p.t1} step={span / 600} value={p.value} aria-label="Scrub through history" aria-valuetext={clock} onChange={e => { p.onPlaying(false); p.onChange(Number(e.target.value)); }} />
      <div className="oi-ts-marks" aria-hidden="true">{p.marks.map((m, i) => <span key={i} style={{ left: `${((m.at - p.t0) / span) * 100}%` }} title={m.label} />)}</div>
    </div>
    <span className="oi-ts-clock">{clock}</span>
    {!atNow && <button type="button" className="oi-ts-now" onClick={() => { p.onPlaying(false); p.onChange(p.t1); }}>Back to now</button>}
  </div>;
}

export const timeScrubberStyles = `
.oi-ts{display:flex;align-items:center;gap:10px;padding:6px 12px;border-bottom:1px solid var(--oi-border);background:var(--oi-panel);min-width:0}
.oi-ts button{font:11px ui-monospace,monospace;border:1px solid var(--oi-border);border-radius:6px;padding:2px 9px;background:transparent;color:var(--oi-text);cursor:pointer;white-space:nowrap}
.oi-ts button:hover{background:var(--oi-hover)}
.oi-ts-track{position:relative;flex:1;min-width:120px}
.oi-ts-track input{width:100%;accent-color:var(--oi-tone-info)}
.oi-ts-marks{position:absolute;left:0;right:0;top:-3px;height:4px;pointer-events:none}
.oi-ts-marks span{position:absolute;width:2px;height:4px;background:var(--oi-tone-info);opacity:.7}
.oi-ts-clock{font:12px ui-monospace,monospace;min-width:110px;text-align:right;color:var(--oi-text)}
`;
