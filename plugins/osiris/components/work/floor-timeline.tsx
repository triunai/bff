import { useEffect, useMemo, useRef, useState } from "react";
import { shortId } from "../../work/surface-model.ts";
import type { StationId } from "../../work/factory-floor-model.ts";
import { KIND_STYLE, cardLines, kindOf, layoutPips, pipTip, shortWords, type Pip, type PipGlyph, type TimelineLine } from "../../work/floor-timeline-model.ts";

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const H = 44, MID = 22;
type Hover = { id: string; x: number; y: number } | null;

/** One glyph per event kind, drawn around (0,0), 7px reach; colour comes from the parent's `color`/`--c`. */
export function Glyph({ g }: { g: PipGlyph }) {
  const st = { fill: "none", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round", className: "oi-ftl-stroke" } as const;
  if (g === "check") return <path d="M-3.4 .2L-1 2.8L3.6 -2.8" {...st} />;
  if (g === "chevron") return <path d="M-1.6 -3.4L2 0L-1.6 3.4" {...st} />;
  if (g === "bars") return <path d="M-2 -3.4V3.4M2 -3.4V3.4" {...st} />;
  if (g === "plus") return <path d="M0 -3.4V3.4M-3.4 0H3.4" {...st} />;
  if (g === "back") return <path d="M3.4 2H-1a2.4 2.4 0 010-4.8H2.6M-1.2 -4.6L-3.4 -2.6L-1.2 -.4" {...st} strokeWidth={1.6} />;
  if (g === "cycle") return <path d="M-3.2 .4a3.4 3.4 0 106-2M2.8 -4.2V-1.8H.4" {...st} strokeWidth={1.5} />;
  if (g === "lock") return <><rect x="-3.2" y="-.6" width="6.4" height="4.6" rx="1" className="oi-ftl-fill" /><path d="M-1.8 -.6V-1.8a1.8 1.8 0 013.6 0V-.6" {...st} strokeWidth={1.3} /></>;
  return <><rect x="-3.2" y="-.6" width="6.4" height="4.6" rx="1" fill="none" strokeWidth="1.3" className="oi-ftl-stroke" /><path d="M-1.8 -.6V-1.8a1.8 1.8 0 013.4-.9" {...st} strokeWidth={1.3} /></>;
}

/** The bottom "time" strip of the Factory screen: one pip per ON THE FLOOR line on a time axis, each KIND in its own colour and
 * glyph, clusters merged into a count pip, a "now" marker at the right end. Text only in <title>, the shell's hover card (via
 * `onHover`) and the cluster card. Consumes the shell's existing log; draws nothing of its own. A single pip with a `beadId`
 * hovers/selects that crate; a cluster pip is a button that opens a card listing its events (and their ids).
 * `stationOf` colours a bead id by its CURRENT station accent (muted when unknown). */
export function FloorTimeline(p: { lines: readonly TimelineLine[]; t0: number; t1: number; now: number; onSelect(id: string): void; onHover?(h: Hover): void; stationOf?(id: string): StationId | null; reduced?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600); // SSR/jsdom-safe default; the observer replaces it with the real width
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const read = () => { const n = el.getBoundingClientRect().width; if (n > 0) setW(n); };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read); ro.observe(el); return () => ro.disconnect();
  }, []);
  const layout = useMemo(() => layoutPips(p.lines, p.t0, p.t1, w, p.now), [p.lines, p.t0, p.t1, p.now, w]);
  const newest = layout.pips.length ? layout.pips[layout.pips.length - 1].key : null;
  const openPip = open === null ? null : layout.pips.find(x => x.count > 1 && x.lines[0].key === open) ?? null; // keyed by its first line: stable while newer lines arrive
  useEffect(() => { if (open !== null && !openPip) setOpen(null); }, [open, openPip]);
  return <div ref={ref} className="oi-ftl" role="group" aria-label={`On the floor: ${p.lines.length} events`} onKeyDown={e => { if (e.key === "Escape" && open !== null) { e.stopPropagation(); setOpen(null); } }}>
    <svg className="oi-ftl-svg" width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="presentation">
      <line className="oi-ftl-axis" x1={0} x2={w} y1={MID} y2={MID} />
      {layout.pips.map(pip => <PipMark key={pip.key} pip={pip} fresh={pip.key === newest && !p.reduced && !pip.earlier} expanded={openPip === pip}
        onToggle={() => setOpen(o => (o === pip.lines[0].key ? null : pip.lines[0].key))} onSelect={p.onSelect} onHover={p.onHover} />)}
      <g className="oi-ftl-now" transform={`translate(${layout.nowX} 0)`}><title>Now</title><line y1={6} y2={H - 6} /><path d={`M-4 ${MID - 4}L2 ${MID}L-4 ${MID + 4}Z`} /></g>
    </svg>
    {p.lines.length === 0 && <span className="oi-ftl-empty">Nothing yet</span>}
    {openPip && <EventCard pip={openPip} w={w} stationOf={p.stationOf} onSelect={id => { setOpen(null); p.onSelect(id); }} onHover={p.onHover} onClose={() => setOpen(null)} />}
  </div>;
}

function PipMark(p: { pip: Pip; fresh: boolean; expanded: boolean; onToggle(): void; onSelect(id: string): void; onHover?(h: Hover): void }) {
  const { pip } = p, id = pip.beadId, many = pip.count > 1, act = id !== null || many;
  const at = (e: { clientX: number; clientY: number }) => id && p.onHover?.({ id, x: e.clientX, y: e.clientY });
  const tip = pipTip(pip, clock), k = KIND_STYLE[pip.kind];
  const press = () => (many ? p.onToggle() : id && p.onSelect(id));
  return <g className={`oi-ftl-pip oi-ftl-k-${pip.kind}${pip.earlier ? " earlier" : ""}${many ? " many" : ""}${p.fresh ? " new" : ""}${act ? " act" : ""}`} style={{ ["--c" as string]: `var(${k.css})` }} transform={`translate(${pip.x} ${MID})`}
    role={act ? "button" : "img"} tabIndex={act ? 0 : undefined} aria-label={tip.replace(/\n/g, "; ")} aria-expanded={many ? p.expanded : undefined} aria-haspopup={many ? "dialog" : undefined}
    onClick={act ? press : undefined} onKeyDown={act ? e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); press(); } } : undefined}
    onMouseEnter={at} onMouseMove={at} onMouseLeave={() => id && p.onHover?.(null)} onFocus={id ? e => { const r = (e.currentTarget as SVGGElement).getBoundingClientRect(); p.onHover?.({ id, x: r.left + r.width / 2, y: r.top }); } : undefined} onBlur={id ? () => p.onHover?.(null) : undefined}>
    <title>{tip}</title>
    <circle className="oi-ftl-bg" r={many ? 9 : 7.5} />
    {many ? <text className="oi-ftl-count" textAnchor="middle" y={3.6}>{pip.count > 99 ? "99+" : pip.count}</text> : <Glyph g={pip.glyph} />}
  </g>;
}

/** The cluster card: its events newest first, each row = time (muted) · kind glyph · #id (current station accent) · short title.
 * A row with a bead id selects it and lights its crate while hovered. */
function EventCard(p: { pip: Pip; w: number; stationOf?(id: string): StationId | null; onSelect(id: string): void; onHover?(h: Hover): void; onClose(): void }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const left = Math.max(4, Math.min(p.w - 244, p.pip.x - 120));
  return <div className="oi-ftl-card" role="dialog" aria-label={`${p.pip.count} events`} style={{ left }}>
    <div className="oi-ftl-cardh"><span>{p.pip.count} events</span><button type="button" className="oi-ftl-x" aria-label="Close" onClick={p.onClose}>×</button></div>
    <ol className="oi-ftl-cardl">{cardLines(p.pip).map((l, i) => {
      const ks = KIND_STYLE[kindOf(l)], id = l.beadId ?? null, st = id && p.stationOf ? p.stationOf(id) : null, short = id ? shortId(id) : null;
      const body = <><span className="oi-ftl-ct">{clock(l.at)}</span><svg className="oi-ftl-cg" viewBox="-8 -8 16 16" width={14} height={14} style={{ ["--c" as string]: `var(${ks.css})` }} aria-hidden="true"><Glyph g={ks.glyph} /></svg>{short && <b className="oi-ftl-cid" style={{ color: st ? `var(--oi-station-${st})` : "var(--oi-tone-muted)" }}>{short}</b>}<span className="oi-ftl-cl">{shortWords(l.title) || ks.word}</span></>;
      return <li key={l.key} title={`${ks.word} · ${l.text}${l.title ? ` · ${l.title}` : ""}`}>{id
        ? <button type="button" ref={i === 0 ? first : undefined} className="oi-ftl-crow" onClick={() => p.onSelect(id)} onMouseEnter={e => p.onHover?.({ id, x: e.clientX, y: e.clientY })} onMouseLeave={() => p.onHover?.(null)} onFocus={e => { const r = e.currentTarget.getBoundingClientRect(); p.onHover?.({ id, x: r.left, y: r.top }); }} onBlur={() => p.onHover?.(null)}>{body}</button>
        : <div className="oi-ftl-crow static">{body}</div>}</li>;
    })}</ol>
  </div>;
}

export const floorTimelineStyles = `
.oi-ftl{position:relative;min-width:0;height:${H}px}
.oi-ftl-svg{display:block;overflow:hidden}
.oi-ftl-axis{stroke:var(--oi-border);stroke-width:1.5}
.oi-ftl-pip{--c:var(--oi-tone-info);color:var(--c)}
.oi-ftl-bg{fill:var(--oi-panel,var(--oi-bg));stroke:var(--c);stroke-width:1.4}
.oi-ftl-pip.many .oi-ftl-bg{fill:color-mix(in srgb,var(--c) 28%,var(--oi-panel,var(--oi-bg)))}
.oi-ftl-stroke{stroke:var(--c)}.oi-ftl-fill{fill:var(--c)}
.oi-ftl-count{font:700 9px ui-monospace,monospace;fill:var(--oi-text);pointer-events:none}
.oi-ftl-pip.earlier{opacity:.5}
.oi-ftl-pip.act{cursor:pointer}
.oi-ftl-pip.act:hover .oi-ftl-bg,.oi-ftl-pip.act:focus-visible .oi-ftl-bg{stroke-width:2.4;fill:color-mix(in srgb,var(--c) 22%,var(--oi-panel,var(--oi-bg)))}
.oi-ftl-pip:focus-visible{outline:none}
.oi-ftl-pip:focus-visible .oi-ftl-bg{stroke:var(--oi-focus,var(--c));stroke-width:2.6}
.oi-ftl-now line{stroke:var(--oi-accent,var(--oi-tone-running));stroke-width:1.5;stroke-dasharray:3 2}.oi-ftl-now path{fill:var(--oi-accent,var(--oi-tone-running))}
.oi-ftl-empty{position:absolute;left:12px;top:50%;transform:translateY(-50%);font-size:10px;color:var(--oi-muted);pointer-events:none}
.oi-ftl-pip.new .oi-ftl-bg{animation:oi-ftl-pop .5s ease-out 1}
@keyframes oi-ftl-pop{from{stroke-width:5;opacity:.4}to{stroke-width:1.4;opacity:1}}
@media (prefers-reduced-motion:reduce){.oi-ftl-pip.new .oi-ftl-bg{animation:none}}
.oi-ftl-card{position:absolute;bottom:calc(100% + 4px);z-index:5;width:240px;max-width:calc(100% - 8px);display:flex;flex-direction:column;border:1px solid var(--oi-border-strong,var(--oi-border));border-radius:8px;background:var(--oi-raised,var(--oi-panel));color:var(--oi-text);box-shadow:var(--oi-shadow-raised,0 6px 18px var(--oi-shadow))}
.oi-ftl-cardh{display:flex;align-items:center;justify-content:space-between;padding:4px 8px;border-bottom:1px solid var(--oi-border);font:600 10px system-ui,sans-serif;color:var(--oi-text-2,var(--oi-text))}
.oi-ftl-x{all:unset;cursor:pointer;width:22px;height:22px;display:grid;place-items:center;border-radius:6px;font-size:14px;color:var(--oi-text-2,var(--oi-text))}
.oi-ftl-x:hover,.oi-ftl-x:focus-visible{background:var(--oi-hover)}
.oi-ftl-cardl{list-style:none;margin:0;padding:2px;max-height:220px;overflow-y:auto}
.oi-ftl-crow{all:unset;box-sizing:border-box;display:grid;grid-template-columns:38px 14px auto minmax(0,1fr);align-items:center;column-gap:6px;width:100%;min-height:26px;padding:0 6px;border-radius:6px;cursor:pointer;font-size:11px}
.oi-ftl-crow.static{cursor:default}
.oi-ftl-crow:hover,.oi-ftl-crow:focus-visible{background:var(--oi-hover)}
.oi-ftl-crow:focus-visible{outline:1px solid var(--oi-focus,var(--oi-accent))}
.oi-ftl-ct{font:10px ui-monospace,monospace;color:var(--oi-tone-muted);white-space:nowrap}
.oi-ftl-cg .oi-ftl-stroke{stroke:var(--c)}.oi-ftl-cg .oi-ftl-fill{fill:var(--c)}
.oi-ftl-cid{font:700 10px ui-monospace,monospace}
.oi-ftl-cl{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--oi-text)}
`;
