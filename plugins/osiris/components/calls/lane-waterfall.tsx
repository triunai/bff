import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import type { Call } from "../../analytics.ts";
import { fleetIndex } from "../../work/call-identity.ts";
import { MINIMAP_BUCKETS, MIN_WINDOW_MS, adjacentLanePick, buildCallTimeline, clampWindow, clockLabel, defaultBarIndex, panWindow, stepBar, zoomWindow } from "../../work/call-timeline-model.ts";
import type { TimeWindow, TimelineLane, TimelineSpan } from "../../work/call-timeline-model.ts";
import type { FleetLane, FleetName, FleetRole } from "../../work/fleet-types.ts";

export type LaneWaterfallProps = {
  calls: readonly Call[];
  /** The fleet's lanes, for names / roles / models. Optional: without them lanes read "Claude a94b1d1f". */
  lanes?: readonly FleetLane[];
  /** The compact name index for every lane (FleetSnapshot.names), so older, finished lanes still get a name. */
  names?: readonly FleetName[];
  /** null = the last 30 minutes of activity. */
  window: TimeWindow | null;
  onWindow: (w: TimeWindow | null) => void;
  selectedKey?: string | null;
  onSelect?: (callKey: string) => void;
  now: number;
};

const ROLE_GLYPH: Record<FleetRole, string> = { main: "◉", lead: "▲", worker: "●", reviewer: "◈" };
const TONES = ["failure", "attention", "running", "success", "muted", "info"] as const;
const pct = (x: number) => `${(x * 100).toFixed(3)}%`;
const range = (w: TimeWindow) => `${clockLabel(w.t0, false)}–${clockLabel(w.t1, false)}`;
type Drag = { mode: "move" | "l" | "r" | "new"; at: number; orig: TimeWindow };

function Bar({ s, selected, stop, at, onSelect, onExpand, onKeyDown, onFocus }: { s: TimelineSpan; selected: boolean; stop: boolean; at: string; onSelect?: (k: string) => void; onExpand: (s: TimelineSpan) => void; onKeyDown: (e: KeyboardEvent) => void; onFocus: () => void }) {
  const w = Math.max(0, s.x1 - s.x0), slow = s.slowFrom !== null && w > 0 ? Math.max(0, (s.slowFrom - s.x0) / w) : null;
  if (s.run) return <button type="button" tabIndex={stop ? 0 : -1} data-wf-at={at} aria-expanded={false} onKeyDown={onKeyDown} onFocus={onFocus} className={`oi-wf-bar oi-wf-run${selected ? " is-sel" : ""}`} title={`${s.title}. Click to open the run.`} aria-label={`${s.title}. Open run`}
    style={{ left: pct(s.x0), width: pct(w), background: `var(--oi-tone-${s.tone})` }} onClick={() => onExpand(s)}>
    <span className="oi-wf-badge">×{s.run.count}{s.run.failed > 0 ? ` ✕${s.run.failed}` : ""}</span>
  </button>;
  return <button type="button" tabIndex={stop ? 0 : -1} data-wf-at={at} onKeyDown={onKeyDown} onFocus={onFocus} className={`oi-wf-bar${s.count > 1 ? " oi-wf-dense" : ""}${selected ? " is-sel" : ""}`} title={s.title} aria-label={s.title}
    style={{ left: pct(s.x0), width: pct(w), background: `var(--oi-tone-${s.tone})` }} onClick={() => onSelect?.(s.callKey)}>
    {slow !== null && <i className="oi-wf-slow" style={{ left: pct(slow) }} />}
    {s.error && <b className="oi-wf-x" aria-hidden="true">✕</b>}
  </button>;
}

function LaneLabel({ l, stop, at, onPin, onFold, onKeyDown }: { l: TimelineLane; stop: boolean; at: string; onPin: () => void; onFold: () => void; onKeyDown: (e: KeyboardEvent) => void }) {
  return <div className="oi-wf-label" tabIndex={stop ? 0 : undefined} data-wf-at={stop ? at : undefined} onKeyDown={stop ? onKeyDown : undefined} aria-label={stop ? `${l.label}, no calls to show` : undefined} style={{ paddingLeft: 4 + l.depth * 12 }} title={l.known ? l.label : `${l.label} (no lane match)`}>
    <button type="button" className="oi-wf-btn" aria-pressed={l.pinned} aria-label={l.pinned ? "Unpin lane" : "Pin lane"} onClick={onPin}>{l.pinned ? "★" : "☆"}</button>
    {l.childCount > 0 ? <button type="button" className="oi-wf-btn oi-wf-fold" aria-expanded={!l.collapsed} aria-label={l.collapsed ? `Show ${l.childCount} sub-agents` : "Hide sub-agents"} onClick={onFold}>{l.collapsed ? `+${l.childCount}` : "−"}</button> : null}
    {l.role && <span className="oi-wf-role" title={l.role} aria-label={l.role}>{ROLE_GLYPH[l.role]}</span>}
    {l.modelLetter && <span className="oi-wf-model" title="Model">{l.modelLetter}</span>}
    <span className={`oi-wf-name${l.known ? "" : " is-dim"}`}>{l.label}</span>
    {l.retryLoop && <span className="oi-wf-loop" title="Same tool failing 3+ times in a row">↻ loop</span>}
    {l.untimed > 0 && <span className="oi-wf-untimed" title="Calls with no start time are not drawn">{l.untimed} untimed</span>}
  </div>;
}

/** Toolcalls "Lanes" view: agent lanes on one wall clock, an overview strip to brush a window, pinned lanes, slow-excess hatching.
 *  Shape borrowed from Chrome DevTools Performance and Perfetto; SVG/CSS only. */
export function LaneWaterfall(p: LaneWaterfallProps) {
  const index = useMemo(() => fleetIndex(p.lanes, p.names), [p.lanes, p.names]);
  const [pins, setPins] = useState<ReadonlySet<string>>(new Set()), [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [stack, setStack] = useState<TimeWindow[]>([]);
  const [drag, setDrag] = useState<Drag | null>(null), [preview, setPreview] = useState<TimeWindow | null>(null);
  const mapRef = useRef<HTMLDivElement>(null), gridRef = useRef<HTMLDivElement>(null);
  const [stops, setStops] = useState<ReadonlyMap<string, string>>(new Map());
  const [fold, setFold] = useState(true), [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const refocus = useRef<string | null>(null);
  const m = useMemo(() => buildCallTimeline({ calls: p.calls, index, window: p.window, pins, collapsed, now: p.now, fold, expanded: opened }), [p.calls, index, p.window, pins, collapsed, p.now, fold, opened]);
  // After a run opens or folds back its span is replaced: put focus on the lane's new roving stop so keyboard users keep their place.
  useEffect(() => {
    const laneKey = refocus.current;
    if (!laneKey) return;
    refocus.current = null;
    const li = m.lanes.findIndex(l => l.key === laneKey);
    if (li < 0) return;
    const spans = m.lanes[li].spans, at = spans.findIndex(sp => sp.callKey === stops.get(laneKey));
    gridRef.current?.querySelector<HTMLElement>(`[data-wf-at="${li}:${at >= 0 ? at : defaultBarIndex(spans)}"]`)?.focus();
  }, [m, stops]);
  const toggle = (set: ReadonlySet<string>, k: string) => { const n = new Set(set); if (n.has(k)) n.delete(k); else n.add(k); return n; };
  if (!m.domain || !m.window) return <section className="oi-wf" aria-label="Lane timeline"><p className="oi-note">{m.untimed ? `${m.untimed} calls have no start time.` : "No calls yet."}</p></section>;
  const domain = m.domain, win = m.window, dSpan = domain.t1 - domain.t0;
  const shown = preview ?? win, frac = (t: number) => (t - domain.t0) / dSpan;
  const go = (w: TimeWindow, push = true) => { if (push && (w.t0 !== win.t0 || w.t1 !== win.t1)) setStack(s => [...s, win].slice(-6)); p.onWindow(w); };
  const preset = (ms: number) => go(clampWindow({ t0: domain.t1 - ms, t1: domain.t1 }, domain));
  const at = (e: PointerEvent) => { const r = mapRef.current!.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width))); };
  const onDown = (e: PointerEvent) => {
    const f = at(e), t = domain.t0 + f * dSpan, h = (e.target as HTMLElement).dataset.h as Drag["mode"] | undefined;
    mapRef.current!.setPointerCapture?.(e.pointerId);
    setDrag({ mode: h ?? "new", at: t, orig: win }); setPreview(win);
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const t = domain.t0 + at(e) * dSpan, d = t - drag.at;
    setPreview(drag.mode === "move" ? clampWindow({ t0: drag.orig.t0 + d, t1: drag.orig.t1 + d }, domain)
      : drag.mode === "l" ? clampWindow({ t0: Math.min(t, drag.orig.t1 - MIN_WINDOW_MS), t1: drag.orig.t1 }, domain)
      : drag.mode === "r" ? clampWindow({ t0: drag.orig.t0, t1: Math.max(t, drag.orig.t0 + MIN_WINDOW_MS) }, domain)
      : clampWindow({ t0: Math.min(drag.at, t), t1: Math.max(drag.at, t) }, domain));
  };
  const onUp = () => {
    if (drag && preview && (drag.mode !== "new" || preview.t1 - preview.t0 > MIN_WINDOW_MS)) go(preview);
    setDrag(null); setPreview(null);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "[" || e.key === "]") { e.preventDefault(); go(zoomWindow(win, domain, e.key === "[" ? 0.8 : 1.25), false); return; }
    const k = e.key.toLowerCase(), f = k === "w" ? 0.5 : k === "s" ? 2 : null, d = k === "a" ? -0.25 : k === "d" ? 0.25 : null;
    if (f === null && d === null) return;
    e.preventDefault(); go(f !== null ? zoomWindow(win, domain, f) : panWindow(win, domain, d!), false);
  };
  // Roving tabindex: one stop per lane, the newest bar unless the user moved (or the lane has no bar: its label).
  const stopIndex = (l: TimelineLane) => { const i = l.spans.findIndex(sp => sp.callKey === stops.get(l.key)); return i >= 0 ? i : defaultBarIndex(l.spans); };
  const focusAt = (li: number, si: number) => {
    const l = m.lanes[li], sp = l.spans[si];
    if (sp) setStops(prev => new Map(prev).set(l.key, sp.callKey));
    gridRef.current?.querySelector<HTMLElement>(`[data-wf-at="${li}:${si}"]`)?.focus();
  };
  const onNav = (e: KeyboardEvent, li: number, si: number) => {
    const n = m.lanes[li].spans.length;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { if (si < 0) return; e.preventDefault(); focusAt(li, stepBar(n, si, e.key === "ArrowLeft" ? -1 : 1)); }
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") { const to = adjacentLanePick(m.lanes, li, si, e.key === "ArrowUp" ? -1 : 1); e.preventDefault(); if (to) focusAt(to.lane, to.span); }
  };
  const setRun = (laneKey: string, runKey: string, open: boolean, landOn: string) => {
    setOpened(prev => { const n = new Set(prev); if (open) n.add(runKey); else n.delete(runKey); return n; });
    setStops(prev => new Map(prev).set(laneKey, landOn));
    refocus.current = laneKey;
  };
  const nowX = (p.now - win.t0) / (win.t1 - win.t0);
  const peak = Math.max(1, m.minimap.max);
  return <section className="oi-wf" aria-label="Lane timeline" tabIndex={0} onKeyDown={onKey} title="W / S zoom, A / D pan">
    <div className="oi-wf-bar-row">
      <button type="button" className="oi-wf-chip" onClick={() => preset(15 * 60_000)}>15 min</button>
      <button type="button" className="oi-wf-chip" onClick={() => preset(60 * 60_000)}>1 h</button>
      <button type="button" className="oi-wf-chip" onClick={() => go(domain)}>Fit all</button>
      <button type="button" className="oi-wf-chip" aria-pressed={fold} title="Fold runs of the same tool into one bar. Click a folded bar to open it." onClick={() => setFold(f => !f)}>Fold runs</button>
      <nav className="oi-wf-crumbs" aria-label="Zoom history">
        {stack.map((w, i) => <button key={`${i}:${w.t0}`} type="button" className="oi-wf-crumb" title="Back to this window" onClick={() => { setStack(stack.slice(0, i)); p.onWindow(w); }}>{range(w)}</button>)}
        <span className="oi-wf-crumb is-cur" aria-current="true">{range(win)}</span>
      </nav>
      {m.untimed > 0 && <span className="oi-wf-untimed" title="Calls with no start time are not drawn">{m.untimed} untimed</span>}
    </div>
    <div className="oi-wf-map" ref={mapRef} role="group" tabIndex={0} aria-label="Window brush. W and S zoom, A and D pan, [ and ] resize." onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} title="Drag to pick a window">
      <svg viewBox={`0 0 ${MINIMAP_BUCKETS} 24`} preserveAspectRatio="none" aria-hidden="true">
        {m.minimap.buckets.map((b, i) => { let y = 24; return TONES.map(t => { const n = b.byTone[t] ?? 0; if (!n) return null; const h = (n / peak) * 22; y -= h; return <rect key={`${i}${t}`} x={i + 0.1} y={y} width={0.8} height={h} style={{ fill: `var(--oi-tone-${t})` }} />; }); })}
      </svg>
      <div className="oi-wf-brush" data-h="move" style={{ left: pct(frac(shown.t0)), width: pct(frac(shown.t1) - frac(shown.t0)) }}>
        <i data-h="l" className="oi-wf-grip l" /><i data-h="r" className="oi-wf-grip r" />
      </div>
    </div>
    <div className="oi-wf-grid" ref={gridRef}>
      <div className="oi-wf-axis"><div className="oi-wf-corner">{m.lanes.length} lanes</div><div className="oi-wf-ticks">{m.ticks.map(t => <span key={t.at} style={{ left: pct(t.x) }}>{t.label}</span>)}</div></div>
      <div className="oi-wf-body"><div className="oi-wf-inner">
        {m.lanes.map((l, li) => { const si = stopIndex(l); return <div key={l.key} className={`oi-wf-lane${l.pinned ? " is-pin" : ""}`}>
          <LaneLabel l={l} stop={si < 0} at={`${li}:-1`} onKeyDown={e => onNav(e, li, -1)} onPin={() => setPins(toggle(pins, l.key))} onFold={() => setCollapsed(toggle(collapsed, l.key))} />
          <div className="oi-wf-track">
            {l.openRuns.map(r => <button key={r.key} type="button" className="oi-wf-unfold" style={{ left: pct(r.x0), width: pct(r.x1 - r.x0) }} aria-expanded={true} aria-label={`Fold run, ${r.tool} ×${r.count}`} title={`Fold run: ${r.tool} ×${r.count}`} onClick={() => setRun(l.key, r.key, false, r.key)}><span>−</span></button>)}
            {l.spans.map((s, i) => <Bar key={s.callKey} s={s} selected={s.callKey === p.selectedKey || (!!s.run && !!p.selectedKey && s.run.callKeys.includes(p.selectedKey))} stop={i === si} at={`${li}:${i}`} onSelect={p.onSelect} onExpand={sp => setRun(l.key, sp.callKey, true, sp.run!.first)} onKeyDown={e => onNav(e, li, i)} onFocus={() => setStops(prev => prev.get(l.key) === s.callKey ? prev : new Map(prev).set(l.key, s.callKey))} />)}
          </div>
        </div>; })}
        {m.lanes.length === 0 && <p className="oi-note">No calls in this window.</p>}
        <div className="oi-wf-overlay" aria-hidden="true">
          {m.ticks.map(t => <i key={t.at} className="oi-wf-gridline" style={{ left: pct(t.x) }} />)}
          {m.breaks.map(b => <i key={b.from} className="oi-wf-break" title={`Idle ${Math.round(b.ms / 60_000)} min`} style={{ left: pct(b.x0), width: pct(b.x1 - b.x0) }} />)}
          {nowX >= 0 && nowX <= 1 && <i className="oi-wf-now" title="Now" style={{ left: pct(nowX) }} />}
        </div>
      </div></div>
    </div>
  </section>;
}

export const laneWaterfallStyles = `
.oi-wf{display:flex;flex-direction:column;gap:6px;min-width:0;outline:none}
.oi-wf:focus-visible{outline:2px solid var(--oi-accent);outline-offset:2px}
.oi-wf-bar-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.oi-wf-chip,.oi-wf-crumb{border:1px solid var(--oi-border);background:transparent;color:var(--oi-text);border-radius:999px;padding:1px 9px;font:inherit;font-size:11px;cursor:pointer}
.oi-wf-chip:hover,.oi-wf-crumb:hover{background:var(--oi-hover)}
.oi-wf-crumbs{display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-left:auto}
.oi-wf-crumb.is-cur{border-color:var(--oi-accent);cursor:default}
.oi-wf-untimed{font-size:10px;color:var(--oi-muted);white-space:nowrap}
.oi-wf-map:focus-visible,.oi-wf-label:focus-visible,.oi-wf-bar:focus-visible{outline:2px solid var(--oi-accent);outline-offset:1px;z-index:3}
.oi-wf-map{position:relative;height:34px;border-block:1px solid var(--oi-border);cursor:crosshair;touch-action:none;user-select:none}
.oi-wf-map svg{position:absolute;inset:3px 0 0 0;width:100%;height:calc(100% - 3px)}
.oi-wf-brush{position:absolute;top:0;bottom:0;background:var(--oi-selected);border:1px solid var(--oi-accent);cursor:grab;min-width:3px}
.oi-wf-grip{position:absolute;top:0;bottom:0;width:7px;cursor:ew-resize}
.oi-wf-grip.l{left:-4px}.oi-wf-grip.r{right:-4px}
.oi-wf-grid{display:flex;flex-direction:column;min-width:0;border:1px solid var(--oi-border);border-radius:4px;overflow:hidden}
.oi-wf-axis,.oi-wf-lane{display:grid;grid-template-columns:200px 1fr;min-width:0}
.oi-wf-axis{border-bottom:1px solid var(--oi-border);background:var(--oi-panel);font-size:10px;color:var(--oi-muted)}
.oi-wf-corner{padding:2px 6px;position:sticky;left:0}
.oi-wf-ticks{position:relative;height:16px}
.oi-wf-ticks span{position:absolute;top:2px;transform:translateX(-50%);white-space:nowrap}
.oi-wf-body{max-height:440px;overflow:auto}
.oi-wf-inner{position:relative}
.oi-wf-lane{height:20px;border-bottom:1px solid color-mix(in srgb,var(--oi-border) 50%,transparent)}
.oi-wf-lane.is-pin{background:var(--oi-selected)}
.oi-wf-label{position:sticky;left:0;z-index:2;display:flex;align-items:center;gap:3px;min-width:0;background:var(--oi-bg);border-right:1px solid var(--oi-border);font-size:11px;overflow:hidden;white-space:nowrap}
.oi-wf-lane.is-pin .oi-wf-label{background:var(--oi-panel)}
.oi-wf-btn{border:0;background:transparent;color:var(--oi-muted);font:inherit;font-size:11px;padding:0 2px;cursor:pointer;min-width:14px}
.oi-wf-btn[aria-pressed=true]{color:var(--oi-tone-attention)}
.oi-wf-fold{font-variant-numeric:tabular-nums}
.oi-wf-role{color:var(--oi-muted);font-size:9px}
.oi-wf-model{border:1px solid var(--oi-border);border-radius:3px;padding:0 3px;font-size:9px;color:var(--oi-muted)}
.oi-wf-name{overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.oi-wf-name.is-dim{color:var(--oi-muted);font-style:italic}
.oi-wf-loop{color:var(--oi-tone-failure);font-size:10px;font-weight:600}
.oi-wf-track{position:relative;height:20px;min-width:0}
.oi-wf-bar{position:absolute;top:4px;height:12px;min-width:2px;padding:0;border:0;border-radius:2px;overflow:hidden;cursor:pointer;opacity:.9}
.oi-wf-bar:hover,.oi-wf-bar.is-sel{opacity:1;outline:1px solid var(--oi-text);z-index:1}
.oi-wf-dense{border-radius:0;opacity:.7}
.oi-wf-slow{position:absolute;top:0;bottom:0;right:0;background:repeating-linear-gradient(45deg,var(--oi-bg) 0 2px,transparent 2px 5px)}
.oi-wf-x{position:absolute;right:1px;top:-2px;font-size:10px;line-height:14px;color:var(--oi-bg);font-weight:700}
.oi-wf-overlay{position:absolute;top:0;bottom:0;left:200px;right:0;pointer-events:none;z-index:1}
.oi-wf-gridline{position:absolute;top:0;bottom:0;width:1px;background:var(--oi-border);opacity:.5}
.oi-wf-break{position:absolute;top:0;bottom:0;background:repeating-linear-gradient(90deg,var(--oi-border) 0 1px,transparent 1px 6px);opacity:.7}
.oi-wf-run{overflow:visible;min-width:26px;top:3px;height:14px;border-radius:3px;background-image:repeating-linear-gradient(90deg,transparent 0 5px,var(--oi-bg) 5px 6px);transition:transform .12s}
.oi-wf-run:hover{transform:scaleY(1.15)}
.oi-wf-badge{position:absolute;inset:0;display:flex;align-items:center;padding:0 3px;font-size:9px;font-weight:700;line-height:14px;color:var(--oi-bg);white-space:nowrap;font-variant-numeric:tabular-nums}
.oi-wf-unfold{position:absolute;bottom:0;height:4px;min-width:10px;padding:0;border:0;border-top:1px solid var(--oi-muted);background:transparent;color:var(--oi-muted);cursor:pointer;z-index:2}
.oi-wf-unfold:hover{border-top-color:var(--oi-text);color:var(--oi-text)}
.oi-wf-unfold:focus-visible{outline:2px solid var(--oi-accent);outline-offset:1px}
.oi-wf-unfold span{position:absolute;left:0;bottom:2px;font-size:10px;line-height:8px}
.oi-wf-chip[aria-pressed=true]{border-color:var(--oi-accent)}
@media (prefers-reduced-motion:reduce){.oi-wf-run{transition:none}.oi-wf-run:hover{transform:none}}
.oi-wf-now{position:absolute;top:0;bottom:0;width:2px;background:var(--oi-tone-running)}
`;
