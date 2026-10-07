import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { WorkSurfaceSnapshot } from "../../work/surface-types.ts";
import { formatAge, historyFromTimestamps } from "../../work/surface-model.ts";
import { STAGES, scrubMarks, stageLabel, timeRange, type Stage } from "../../work/replay.ts";
import { HOT_MS, cardsOf, countsLine, factoryAt, factoryEdges, motionDelta, type FactoryCard } from "../../work/factory-model.ts";
import { TimeScrubber } from "./time-scrubber.tsx";

const MOVE_MS = 420;
const STAGE_TONE: Record<Stage, string> = { waiting: "muted", ready: "info", building: "running", review: "attention", done: "success" };
type Pos = { x: number; y: number };
type Path = { key: string; d: string; unmet: boolean; barrier: { x: number; y: number } | null };
const none = { fresh: new Set<string>(), rework: new Set<string>() };
const reducedMotion = () => { try { return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };

/** Factory floor: rows = parent beads, columns = stages. Motion is the v1 mockup's, ported: a re-render per scrub tick
 * (at most one per animation frame) replaced by FLIP so cards slide between cells; glow = forward move, bounce = rework,
 * heat = long in build/review, stripes = blocked, an SVG overlay for `blocks` edges drawn after layout. */
export function FactoryView(p: { snap: WorkSurfaceSnapshot; now: number; selectedId: string | null; onSelect(id: string): void }) {
  const { snap, now } = p;
  const [at, setAt] = useState<number | null>(null); // null = live (follows `now`)
  const [playing, setPlaying] = useState(false);
  const [tip, setTip] = useState<{ card: FactoryCard; x: number; y: number } | null>(null);
  const [paths, setPaths] = useState<Path[]>([]);
  const rootRef = useRef<HTMLDivElement>(null), posRef = useRef(new Map<string, Pos>()), rafRef = useRef(0), wantRef = useRef<number | null>(null), tRaf = useRef(0);
  const prevRef = useRef<{ f: ReturnType<typeof factoryAt>; t: number } | null>(null);

  const events = useMemo(() => historyFromTimestamps(snap), [snap]);
  const range = useMemo(() => timeRange(events, now), [events, now]);
  const marks = useMemo(() => scrubMarks(events), [events]);
  const t = at === null ? now : Math.min(at, now);
  const f = useMemo(() => factoryAt(snap, events, t, now), [snap, events, t, now]);
  const edges = useMemo(() => factoryEdges(snap, f), [snap, f]);
  const motion = useMemo(() => { const q = prevRef.current; return !q || q.f === f || t < q.t ? none : (d => ({ fresh: new Set(d.fresh), rework: new Set(d.rework) }))(motionDelta(q.f, f)); }, [f, t]);
  useEffect(() => { prevRef.current = { f, t }; }, [f, t]);

  // Debounce: scrub/replay input lands in a ref; at most ONE state change (so one layout pass) per animation frame.
  const onChange = (v: number) => { wantRef.current = v >= range.t1 ? null : v; if (tRaf.current) return; tRaf.current = requestAnimationFrame(() => { tRaf.current = 0; setAt(wantRef.current); }); };

  const measure = () => {
    const root = rootRef.current; const out = new Map<string, Pos>(); if (!root) return out;
    root.querySelectorAll<HTMLElement>("[data-cid]").forEach(el => out.set(el.dataset.cid!, { x: el.offsetLeft, y: el.offsetTop })); // offset*: ignores in-flight transforms
    return out;
  };
  // FLIP: old positions come from the previous layout, new from now; apply the inverse transform, then transition to zero.
  useLayoutEffect(() => {
    const root = rootRef.current; if (!root) return;
    const prev = posRef.current, next = measure(); posRef.current = next;
    if (reducedMotion()) return;
    const moving: HTMLElement[] = [];
    root.querySelectorAll<HTMLElement>("[data-cid]").forEach(el => {
      const o = prev.get(el.dataset.cid!), n = next.get(el.dataset.cid!); if (!o || !n) return;
      const dx = o.x - n.x, dy = o.y - n.y; if (!dx && !dy) return;
      el.style.transition = "none"; el.style.transform = `translate(${dx}px,${dy}px)`; moving.push(el);
    });
    if (!moving.length) return;
    void root.offsetWidth; // flush the inverse transforms before transitioning
    const id = requestAnimationFrame(() => moving.forEach(el => { el.style.transition = `transform ${MOVE_MS}ms cubic-bezier(.2,.8,.2,1)`; el.style.transform = ""; }));
    return () => cancelAnimationFrame(id);
  }, [f]);

  // Edges: drawn after layout, one rAF, redrawn on resize and on every new frame.
  const draw = () => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const root = rootRef.current; if (!root) return;
      posRef.current = measure();
      const el = (id: string) => root.querySelector<HTMLElement>(`[data-cid="${CSS.escape(id)}"]`);
      const out: Path[] = [];
      for (const e of edges) {
        const a = el(e.from), b = el(e.to); if (!a || !b) continue;
        const sx = a.offsetLeft + a.offsetWidth, sy = a.offsetTop + a.offsetHeight / 2, tx = b.offsetLeft, ty = b.offsetTop + b.offsetHeight / 2, dx = Math.max(26, Math.abs(tx - sx) / 2);
        out.push({ key: `${e.from}>${e.to}`, unmet: e.unmet, d: `M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`, barrier: e.unmet ? { x: tx - 9, y: ty } : null });
      }
      setPaths(out);
    });
  };
  const drawRef = useRef(draw); drawRef.current = draw; // the observer must call the LATEST draw (fresh edges), not the first render's (review W-1B M5)
  useEffect(() => { draw(); }, [f, edges]);
  useEffect(() => {
    const root = rootRef.current; if (!root || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => drawRef.current()); ro.observe(root);
    return () => { ro.disconnect(); cancelAnimationFrame(rafRef.current); cancelAnimationFrame(tRaf.current); };
  }, []);

  const total = cardsOf(f).length;
  return <div className="oi-fv">
    <TimeScrubber t0={range.t0} t1={range.t1} value={t} playing={playing} marks={marks} onChange={onChange} onPlaying={setPlaying} />
    <div className="oi-fv-head" aria-live="polite"><b>{total === 0 ? "No work at this time" : countsLine(f.counts)}</b>{f.hiddenRows > 0 && <span>{f.hiddenRows} quieter group{f.hiddenRows === 1 ? "" : "s"} not shown</span>}</div>
    <div className="oi-fv-scroll"><div className="oi-fac" ref={rootRef} onMouseMove={e => { const el = (e.target as HTMLElement).closest<HTMLElement>("[data-cid]"); const c = el && cardsOf(f).find(x => x.id === el.dataset.cid); setTip(c ? { card: c, x: e.clientX, y: e.clientY } : null); }} onMouseLeave={() => setTip(null)}>
      <div className="oi-fac-colh oi-fac-corner">Work group</div>
      {STAGES.map(st => <div key={st} className={`oi-fac-colh oi-t-${STAGE_TONE[st]}`}>{stageLabel(st)} <span>{f.counts[st]}</span></div>)}
      {f.rows.map(r => [
        <div key={`${r.key}:l`} className="oi-fac-lane" style={{ color: `var(--oi-lane-${r.toneIndex})` }} title={r.label}>{r.label}</div>,
        ...STAGES.map(st => <div key={`${r.key}:${st}`} className={`oi-fac-cell${st === "done" ? " oi-done" : ""}`}>{f.cells.get(r.key)!.get(st)!.map(c => {
          const heat = c.hot || ((c.stage === "building" || c.stage === "review") && c.sinceMs !== null) ? Math.min(1, (c.sinceMs ?? 0) / (2 * HOT_MS)) : 0;
          return <button type="button" key={c.id} data-cid={c.id} aria-pressed={p.selectedId === c.id} onClick={() => p.onSelect(c.id)}
            className={["oi-fc", c.blocked && "blocked", c.hot && "hot", motion.fresh.has(c.id) && "fresh", motion.rework.has(c.id) && "rework", p.selectedId === c.id && "sel"].filter(Boolean).join(" ")}
            style={{ borderLeftColor: c.blocked ? undefined : `var(--oi-lane-${r.toneIndex})`, ["--heat" as string]: heat }}>
            <span className="oi-fc-top"><span className="oi-fc-id">{c.shortId}</span>{c.blocked ? <span className="oi-fc-flag f">⊘ blocked</span> : c.hot ? <span className="oi-fc-flag f">slow</span> : null}</span>
            <span className="oi-fc-tt">{c.title}</span>
            {c.pane && <span className="oi-fc-pane">◉ {c.pane}</span>}
            {motion.rework.has(c.id) && <span className="oi-fc-flag a">↩ sent back</span>}
          </button>;
        })}</div>),
      ])}
      <svg className="oi-fac-edges" aria-hidden="true">
        <defs><marker id="oi-ar" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path className="oi-ar" d="M0,0 L7,3.5 L0,7z" /></marker><marker id="oi-ar-bad" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path className="oi-ar-bad" d="M0,0 L7,3.5 L0,7z" /></marker></defs>
        {paths.map(e => <g key={e.key}><path className={e.unmet ? "oi-fe bad" : "oi-fe"} d={e.d} markerEnd={`url(#${e.unmet ? "oi-ar-bad" : "oi-ar"})`} />{e.barrier && <rect className="oi-fe-bar" x={e.barrier.x} y={e.barrier.y - 10} width="4" height="20" rx="1" />}</g>)}
      </svg>
    </div></div>
    <div className="oi-fv-legend"><span>line: dependency, finished</span><span className="f">dashed line with bar: the blocker is not done yet</span><span>glow: just moved forward</span><span className="a">bounce: sent back for rework</span><span>red tint: in build or review for a long time</span></div>
    {tip && <div className="oi-fv-tip" style={{ left: Math.min(tip.x + 14, (typeof innerWidth === "number" ? innerWidth : 1200) - 320), top: tip.y + 14 }}>
      <b>{tip.card.fullTitle}</b>
      <span>Stage: {stageLabel(tip.card.stage)}{tip.card.blocked ? " (blocked)" : ""}</span>
      <span>Pane: {tip.card.pane ?? "no pane"}</span>
      <span>{tip.card.sinceMs === null ? "Time in stage unknown" : `In this stage for ${formatAge(tip.card.sinceMs)}`}</span>
    </div>}
    {total === 0 && <div className="oi-fv-empty">Nothing existed yet at this point in history.</div>}
  </div>;
}

export const factoryViewStyles = `
.oi-fv{display:flex;flex-direction:column;min-width:0;font:13px system-ui,sans-serif;color:var(--oi-text)}
.oi-fv-head{display:flex;gap:16px;flex-wrap:wrap;align-items:center;padding:8px 12px;font-size:13px}
.oi-fv-head span{color:var(--oi-tone-muted);font-size:12px}
.oi-fv-scroll{overflow:auto;padding:0 12px 4px}
.oi-fac{position:relative;display:grid;grid-template-columns:132px repeat(5,minmax(150px,1fr));border-bottom:1px solid var(--oi-border);overflow:hidden;min-width:880px}
.oi-fac-colh{font:600 12px system-ui,sans-serif;padding:8px;border-bottom:1px solid var(--oi-border);border-left:1px solid var(--oi-border);color:var(--oi-tone-muted)}
.oi-fac-colh span{font:12px ui-monospace,monospace;color:var(--oi-text)}
.oi-fac-corner{border-left:0}
.oi-t-muted{color:var(--oi-tone-muted)}.oi-t-info{color:var(--oi-tone-info)}.oi-t-running{color:var(--oi-tone-running)}.oi-t-attention{color:var(--oi-tone-attention)}.oi-t-success{color:var(--oi-tone-success)}
.oi-fac-lane{font:600 12px system-ui,sans-serif;padding:10px 8px;border-top:1px solid var(--oi-border);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
.oi-fac-cell{border-top:1px solid var(--oi-border);border-left:1px solid var(--oi-border);padding:6px;display:flex;flex-direction:column;gap:6px;min-height:64px;min-width:0}
.oi-fac-cell.oi-done{background:color-mix(in srgb,var(--oi-tone-success) 4%,transparent)}
.oi-fc{position:relative;z-index:2;display:flex;flex-direction:column;gap:2px;text-align:left;font:inherit;color:var(--oi-text);cursor:pointer;min-width:0;padding:5px 7px;border:1px solid var(--oi-border);border-left:3px solid var(--oi-tone-muted);border-radius:6px;background-color:var(--oi-panel);background-image:linear-gradient(color-mix(in srgb,var(--oi-tone-failure) calc(var(--heat,0)*34%),transparent),color-mix(in srgb,var(--oi-tone-failure) calc(var(--heat,0)*34%),transparent))}
.oi-fc:hover{border-color:var(--oi-tone-info)}
.oi-fc.sel{outline:1px solid var(--oi-tone-info);background-color:var(--oi-selected)}
.oi-fc-top{display:flex;justify-content:space-between;gap:4px}
.oi-fc-id{font:11px ui-monospace,monospace;color:var(--oi-tone-muted)}
.oi-fc-tt{font-size:12px;line-height:1.3;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.oi-fc-pane{font:11px ui-monospace,monospace;color:var(--oi-tone-running)}
.oi-fc-flag{font-size:12px}.oi-fc-flag.f,.f{color:var(--oi-tone-failure)}.oi-fc-flag.a,.a{color:var(--oi-tone-attention)}
.oi-fc.blocked{border-left-color:var(--oi-tone-failure);background-image:repeating-linear-gradient(135deg,color-mix(in srgb,var(--oi-tone-failure) 11%,var(--oi-panel)) 0 6px,var(--oi-panel) 6px 12px)}
.oi-fc.hot{box-shadow:0 0 12px color-mix(in srgb,var(--oi-tone-failure) 55%,transparent)}
.oi-fc.fresh{animation:oi-glow 1.4s ease-out 2}
.oi-fc.rework{animation:oi-bounce .7s ease-out 2;border-color:var(--oi-tone-attention)}
@keyframes oi-glow{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--oi-tone-info) 70%,transparent)}100%{box-shadow:0 0 0 9px transparent}}
@keyframes oi-bounce{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--oi-tone-attention) 70%,transparent)}30%{margin-left:-5px}60%{margin-left:4px}100%{margin-left:0;box-shadow:0 0 0 9px transparent}}
@media (prefers-reduced-motion:reduce){.oi-fc.fresh,.oi-fc.rework{animation:none}.oi-fc.fresh{border-color:var(--oi-tone-info)}.oi-fc{transition:none!important;transform:none!important}}
.oi-fac-edges{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:1;overflow:visible}
.oi-fe{fill:none;stroke:var(--oi-tone-muted);stroke-opacity:.45;stroke-width:1.2}
.oi-fe.bad{stroke:var(--oi-tone-failure);stroke-opacity:.85;stroke-dasharray:5 3}
.oi-fe-bar{fill:var(--oi-tone-failure)}
.oi-ar{fill:var(--oi-tone-muted)}.oi-ar-bad{fill:var(--oi-tone-failure)}
.oi-fv-legend{display:flex;gap:14px;flex-wrap:wrap;padding:8px 12px;font-size:12px;color:var(--oi-tone-muted)}
.oi-fv-tip{position:fixed;z-index:50;pointer-events:none;display:flex;flex-direction:column;gap:2px;max-width:300px;padding:7px 10px;border:1px solid var(--oi-border);border-radius:6px;background:var(--oi-panel);color:var(--oi-text);font-size:12px;box-shadow:0 4px 14px var(--oi-shadow)}
.oi-fv-tip span{color:var(--oi-tone-muted)}
.oi-fv-empty{padding:10px 12px;font-size:13px;color:var(--oi-tone-muted)}
`;
