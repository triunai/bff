import { useMemo, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { filterProjects, groupProjects, type SpineV2 } from "../../projects.ts";
import { countsLine, portfolioRow, progressLabel, TONE_WORD } from "../../projects-board.ts";

export { TONE_WORD }; // board.tsx imports it from here; the one definition lives in projects-board.ts
export type Row = { spine: SpineV2; group: string; text: string };
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Portfolio as card rows: health stripe + reason, name, one-line goal, counts, progress, Next and Waiting on. Click a card to open its board. */
export function Portfolio(p: { rows: Row[]; today: string; pill: string; setPill(v: string): void; query: string; setQuery(v: string): void; input: RefObject<HTMLInputElement | null>; invalid: { file: string; reason: string }[]; onOpen(id: string): void }) {
  const f = useMemo(() => filterProjects(p.rows, p.pill, p.query), [p.rows, p.pill, p.query]);
  const pillOrder = useMemo(() => ["all", ...groupProjects(p.rows.map(r => r.spine)).map(g => g.group as string)], [p.rows]);
  const groups = groupProjects(f.visible.map(r => r.spine));
  const onPillKey = (e: ReactKeyboardEvent, i: number) => {
    const n = pillOrder.length;
    const next = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i + n - 1) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault(); p.setPill(pillOrder[next]);
    requestAnimationFrame(() => document.getElementById(`oi-pj-pill-${next}`)?.focus());
  };
  const reset = () => { p.setPill("all"); p.setQuery(""); p.input.current?.focus(); };
  return (
    <div className="oi-pj-port">
      <div className="oi-pj-ctl">
        <div className="oi-pj-pills" role="tablist" aria-label="Project groups">
          {pillOrder.map((name, i) => (
            <button key={name} id={`oi-pj-pill-${i}`} type="button" role="tab" aria-selected={p.pill === name} tabIndex={p.pill === name ? 0 : -1} className="oi-pj-pill" onClick={() => p.setPill(name)} onKeyDown={e => onPillKey(e, i)}>
              {name === "all" ? "All" : name}<span className="oi-pj-pc">{f.countsByPill[name] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="oi-pj-search">
          <input ref={p.input} type="search" value={p.query} onChange={e => p.setQuery(e.target.value)} placeholder="Search projects, outcomes, actions…" aria-label="Search projects, outcomes, actions and blockers" autoComplete="off" spellCheck={false}
            onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); p.setQuery(""); } }} />
          {p.query ? <button type="button" className="oi-pj-x" aria-label="Clear search" onClick={() => { p.setQuery(""); p.input.current?.focus(); }}>×</button> : null}
          <kbd>{isMac() ? "⌘K" : "Ctrl K"}</kbd>
        </div>
      </div>
      <p className="oi-pj-count" role="status" aria-live="polite">{f.label}</p>
      {p.invalid.length > 0 ? <p className="oi-pj-dim">{p.invalid.length} file(s) skipped: {p.invalid.map(i => `${i.file} (${i.reason})`).join("; ")}</p> : null}
      {f.visible.length === 0 ? (
        <div className="oi-pj-empty"><b>No matching projects</b><p>Try another search or project group.</p><button type="button" className="oi-pj-btn" onClick={reset}>Reset filters</button></div>
      ) : (
        <div className="oi-pj-scroll">
          {groups.map(g => (
            <section key={g.group} className="oi-pj-grpbox">
              <h4 className="oi-pj-grp">{g.group}</h4>
              {g.projects.map(s => {
                const r = portfolioRow(s, p.today);
                return (
                  <div key={r.id} role="button" tabIndex={0} className={`oi-pj-pc2 t-${r.health.tone}`} aria-label={`Open ${r.name} project board`} onClick={() => p.onOpen(r.id)}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.onOpen(r.id); } }}>
                    <div className="oi-pj-hs" title={r.health.reason}><b>{TONE_WORD[r.health.tone]}</b><span>{r.health.reason.replace(/^\w+: /, "")}</span></div>
                    <div className="oi-pj-mid">
                      <div className="oi-pj-name">{r.name}</div>
                      {r.goal ? <div className="oi-pj-goal">{r.goal}</div> : null}
                      <div className="oi-pj-cnt">{countsLine(r)}</div>
                      <div className="oi-pj-prog" title={progressLabel(r.progress)}><span className="oi-pj-bar"><span style={{ width: `${r.progress.pct}%` }} /></span><small>{progressLabel(r.progress)}</small></div>
                    </div>
                    <div className="oi-pj-nx">
                      <div><small>Next →</small> {r.next ?? <span className="oi-pj-dim">nothing set</span>}</div>
                      <div className={r.waiting ? "oi-pj-wait" : ""}><small>Waiting on →</small> {r.waiting ?? <span className="oi-pj-dim">nothing</span>}</div>
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
      <p className="oi-pj-dim">Click a project for its board. Open the ? in the header for what the colours and badges mean.</p>
    </div>
  );
}
