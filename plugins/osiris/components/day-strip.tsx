import { useRef, type KeyboardEvent } from "react";
import type { DayCounts } from "../git-types.ts";
import { MONTHS, humanDate, parseDate, plural, stripDays } from "../day-ui.ts";

/** Layout choice: ONE row, one square per day (not a 7-row week grid), so the strip stays a single compact line above the
 * graph; month labels sit above the first square of each month. Overflow scrolls inside the strip only. */
export function DayStrip(p: { counts: DayCounts | null; busy: boolean; error: string | null; selected: string | null; onDay(date: string | null): void }) {
  const row = useRef<HTMLDivElement>(null);
  if (p.error) return <div className="oi-ds"><p className="oi-ds-note err" role="alert">{p.error}</p></div>;
  if (!p.counts) return <div className="oi-ds"><p className="oi-ds-note">{p.busy ? "Loading commit days…" : "No day data."}</p></div>;
  const c = p.counts, days = stripDays(c);
  if (days.length === 0) return <div className="oi-ds"><p className="oi-ds-note">No day data.</p></div>;
  // The one tab stop: the selected day, else the newest day.
  const stop = p.selected && days.some(d => d.date === p.selected) ? p.selected : days[days.length - 1].date;
  const moveFocus = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "Home" ? -Infinity : e.key === "End" ? Infinity : 0;
    if (!step) return;
    const btns = Array.from(row.current?.querySelectorAll<HTMLButtonElement>("button[data-date]") ?? []);
    const at = btns.findIndex(b => b === document.activeElement);
    if (at < 0) return;
    e.preventDefault();
    btns[Math.max(0, Math.min(btns.length - 1, step === Infinity ? btns.length - 1 : step === -Infinity ? 0 : at + step))]?.focus();
  };
  let lastMonth = "";
  return <div className="oi-ds">
    <div className="oi-ds-title">{plural(c.total, "commit")} in the last {plural(c.days, "day")}{c.truncated && <span className="oi-ds-trunc" title="The bounded read hit its cap; older days may be undercounted."> (bounded)</span>}{p.selected && <button type="button" className="oi-ds-clear" title={`Showing ${humanDate(p.selected)}. Show every day again`} onClick={() => p.onDay(null)}>× All days</button>}</div>
    <div className="oi-ds-scroll">
      <div className="oi-ds-grid" ref={row} role="group" aria-label="Commits per day" onKeyDown={moveFocus} style={{ gridTemplateColumns: `repeat(${days.length}, var(--oi-ds-size))` }}>
        {days.map((d, i) => {
          const pd = parseDate(d.date), month = pd ? MONTHS[pd.m - 1] : "";
          const label = month !== lastMonth ? (lastMonth = month) : null;
          return label && <span key={`m${d.date}`} className="oi-ds-month" style={{ gridColumn: i + 1, gridRow: 1 }} aria-hidden="true">{label}</span>;
        })}
        {days.map((d, i) => <button key={d.date} type="button" data-date={d.date} data-level={d.level} className={`oi-ds-day${p.selected === d.date ? " sel" : ""}`} style={{ gridColumn: i + 1, gridRow: 2 }}
          aria-label={`${humanDate(d.date)}: ${plural(d.n, "commit")}`} aria-pressed={p.selected === d.date} tabIndex={d.date === stop ? 0 : -1}
          title={`${humanDate(d.date)}: ${plural(d.n, "commit")}`} onClick={() => p.onDay(p.selected === d.date ? null : d.date)} />)}
      </div>
    </div>
  </div>;
}

/** Heat steps are the info tone at rising strength (never green: green means evidence-backed success). Empty days use the border. */
export const dayStripStyles = `
.oi-ds{--oi-ds-size:10px;padding:4px 8px 6px;color:var(--oi-text);font-size:11px}
.oi-ds-note{margin:0;color:var(--oi-tone-muted)}.oi-ds-note.err{color:var(--oi-tone-failure)}
.oi-ds-title{margin-bottom:2px;color:var(--oi-tone-muted)}.oi-ds-trunc{color:var(--oi-tone-attention)}
.oi-ds-clear{margin-left:8px;padding:0 6px;font:inherit;font-size:11px;color:var(--oi-tone-info);background:transparent;border:1px solid var(--oi-border);border-radius:9px;cursor:pointer}
.oi-ds-clear:hover{background:var(--oi-hover)}.oi-ds-clear:focus-visible{outline:2px solid var(--oi-text)}
.oi-ds-scroll{overflow-x:auto;max-width:100%;padding-bottom:2px}
.oi-ds-grid{display:inline-grid;grid-template-rows:12px var(--oi-ds-size);gap:2px;min-width:max-content}
.oi-ds-month{font-size:10px;line-height:12px;color:var(--oi-tone-muted);white-space:nowrap;overflow:visible;pointer-events:none}
.oi-ds-day{width:var(--oi-ds-size);height:var(--oi-ds-size);padding:0;border:0;border-radius:2px;cursor:pointer;background:var(--oi-border)}
.oi-ds-day[data-level="1"]{background:color-mix(in srgb,var(--oi-tone-info) 20%,transparent)}
.oi-ds-day[data-level="2"]{background:color-mix(in srgb,var(--oi-tone-info) 40%,transparent)}
.oi-ds-day[data-level="3"]{background:color-mix(in srgb,var(--oi-tone-info) 65%,transparent)}
.oi-ds-day[data-level="4"]{background:color-mix(in srgb,var(--oi-tone-info) 90%,transparent)}
.oi-ds-day:hover{outline:1px solid var(--oi-tone-muted)}
.oi-ds-day.sel{outline:2px solid var(--oi-tone-info);outline-offset:1px}
.oi-ds-day:focus-visible{outline:2px solid var(--oi-text);outline-offset:1px}
`;
