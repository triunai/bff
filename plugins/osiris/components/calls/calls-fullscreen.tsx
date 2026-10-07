import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Call } from "../../analytics.ts";
import { MenuSelect } from "../ui/menu-select.tsx";
import { brushDomain, callsFsModel, FS_TABS, TILE_HOME, WINDOW_PRESETS } from "../../work/calls-fullscreen-model.ts";
import type { CallsTab, ContextRow, DrawerModel, FsKpi, ProblemRow } from "../../work/calls-fullscreen-model.ts";
import type { TimeWindow } from "../../work/tool-dashboard-model.ts";
import type { FleetSnapshot } from "../../work/fleet-types.ts";
import { cleanText } from "../../work/sanitize.ts";

const PROVIDER_VAR: Record<string, string> = { CL: "var(--p-claude)", CX: "var(--p-codex)", GM: "var(--p-gemini)" };
const provChip = (chip: string) => <span className="oi-cfs-chip" style={{ "--c": PROVIDER_VAR[chip.slice(0, 2)] ?? "var(--oi-tone-muted)" } as React.CSSProperties}>{chip}</span>;
const TONE_CLASS: Record<string, string> = { run: "oi-cfs-run", fail: "oi-cfs-fail", acc: "oi-cfs-acc", att: "oi-cfs-att", muted: "" };
const TONE_VAR: Record<string, string> = { fail: "var(--oi-tone-failure)", att: "var(--oi-tone-attention)", muted: "var(--oi-tone-muted)" };
const tierClass = (t: string | null) => (t === "none" || t === null ? "oi-cfs-muted" : "oi-cfs-att");

export interface CallsFullscreenProps {
  calls: readonly Call[]; fleet: FleetSnapshot | null; now: number;
  presetMs: number; onPreset(ms: number): void;
  /** THE window state (the brush); null = the last `presetMs`. */
  brush: TimeWindow; onBrush(w: TimeWindow): void;
  selectedKey: string | null; onSelect(key: string | null): void;
  tab: CallsTab; onTab(t: CallsTab): void; onExit(): void;
  onOpenBead?(id: string): void;
  /** The Cost tab's body (the existing Cost & cache view), mounted inside the overlay. */
  costBody?: ReactNode;
  /** The Agents tab's body: the SAME FleetList the Calls > Agents tab renders. */
  agentsBody?: ReactNode;
}

/** Calls, full screen: the mockup's state 2 (docs/design/2026-10-07-osiris-dashboard-harmony.html). Every tile reads ONE window. */
export function CallsFullscreen(p: CallsFullscreenProps) {
  const model = useMemo(() => callsFsModel({ calls: p.calls, fleet: p.fleet, now: p.now, presetMs: p.presetMs, brush: p.brush, selectedKey: p.selectedKey }), [p.calls, p.fleet, Math.floor(p.now / 60_000), p.presetMs, p.brush, p.selectedKey]);
  const stripRef = useRef<HTMLDivElement>(null), [drag, setDrag] = useState<{ a: number; b: number } | null>(null), opened = useRef(false);
  // The mockup opens with the worst problem's newest call in the drawer; done once, so closing the drawer with Esc stays closed.
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    if (p.selectedKey === null && model.problems[0]?.lastCallKey) p.onSelect(model.problems[0].lastCallKey);
  }, []);
  const frac = (e: { clientX: number }) => { const r = stripRef.current?.getBoundingClientRect(); return r && r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0; };
  const commit = () => {
    if (drag && Math.abs(drag.b - drag.a) > 0.01) {
      const d = brushDomain(p.now), [lo, hi] = drag.a < drag.b ? [drag.a, drag.b] : [drag.b, drag.a], span = d.t1 - d.t0;
      p.onBrush({ t0: Math.round(d.t0 + lo * span), t1: Math.round(d.t0 + hi * span) });
    }
    setDrag(null);
  };
  const max = Math.max(1, model.strip.max), tabs = FS_TABS;
  const shown = drag ? { left: Math.min(drag.a, drag.b) * 100, width: Math.abs(drag.b - drag.a) * 100 } : { left: model.windowFrac.left * 100, width: model.windowFrac.width * 100 };
  const stackMax = Math.max(0.001, ...model.spend.buckets.map(b => b.claudeH + b.codexH + b.geminiH));
  const px = (v: number) => Math.round((v / stackMax) * 110);
  const open = (t: CallsTab) => <button type="button" className="oi-cfs-open" onClick={() => p.onTab(t)}>{t} ⤢</button>;
  const d = model.drawer;
  return <div className="oi-cfs">
    <div className="oi-cfs-h"><b>Calls</b><span>full screen</span><span style={{ flex: 1 }} /><span>Esc closes the drawer, then full screen</span><button type="button" className="oi-cfs-btn" onClick={p.onExit} title="Leave full screen (Z)">✕ Exit <kbd>Z</kbd></button></div>
    <div className="oi-cfs-tabs" role="tablist" aria-label="Calls surface">
      {tabs.map((t, i) => t === "|" ? <span key={`s${i}`} className="oi-cfs-sep" /> : <button key={t} type="button" role="tab" className="oi-cfs-ct" aria-selected={p.tab === t} onClick={() => p.onTab(t)}>{t}</button>)}
      <span className="oi-cfs-end"><label className="oi-cfs-note">window: <MenuSelect ariaLabel="Window" value={String(p.presetMs)} onChange={v => { p.onBrush(null); p.onPreset(Number(v)); }} options={WINDOW_PRESETS.map(w => ({ value: String(w.ms), label: w.label }))} /></label><button type="button" className="oi-cfs-btn" onClick={p.onExit} title="Full screen (Z)">⛶<kbd>Z</kbd></button></span>
    </div>
    <div className="oi-cfs-grid">
      <div className="oi-cfs-main">
        {p.tab === "Cost" && p.costBody ? p.costBody : p.tab === "Agents" && p.agentsBody ? p.agentsBody : <>
          <div className="oi-cfs-stat">{model.kpis.map((k: FsKpi) => <div key={k.key}><div className={`v ${TONE_CLASS[k.tone]}`}>{k.value}</div><div className="k">{k.label}</div><div className="s">{k.sub}</div></div>)}</div>
          <div ref={stripRef} className="oi-cfs-brush" role="group" aria-label="All calls over 24 hours with the selected window"
            onPointerDown={e => { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); const f = frac(e); setDrag({ a: f, b: f }); }}
            onPointerMove={e => { if (drag) setDrag({ a: drag.a, b: frac(e) }); }} onPointerUp={commit} onPointerCancel={() => setDrag(null)}>
            {model.strip.buckets.map((b, i) => b.total > 0 && <i key={i} className="tick" style={{ left: `${(i / model.strip.buckets.length) * 100}%`, height: 6 + Math.round((b.total / max) * 22) }} />)}
            <div className="win" style={{ left: `${shown.left}%`, width: `${shown.width}%` }} />
            <span className="lab">{model.brushLabel}</span>
            {model.brushed && <button type="button" className="oi-cfs-reset" onPointerDown={e => e.stopPropagation()} onClick={() => p.onBrush(null)}>× reset to {WINDOW_PRESETS.find(w => w.ms === p.presetMs)?.label ?? "preset"}</button>}
          </div>
          <div className="oi-cfs-tiles">
            <section className="tile s8 nl"><div className="th"><span className="eyebrow">Spend / hour</span><span className="legend"><span><i style={{ background: "var(--p-claude)" }} />Claude</span><span><i style={{ background: "var(--p-codex)" }} />Codex</span><span><i style={{ background: "var(--p-gemini)" }} />Gemini</span></span>{open(TILE_HOME.spend)}</div>
              <div className="bars" style={{ height: 120 }}>{model.spend.buckets.map((b, i) => <span key={i}><i style={{ height: px(b.claudeH), background: "var(--p-claude)" }} /><i style={{ height: px(b.codexH), background: "var(--p-codex)" }} /><i style={{ height: px(b.geminiH), background: "var(--p-gemini)" }} /></span>)}</div>
              <div className="note">{model.spend.note}</div></section>
            <section className="tile s4"><div className="th"><span className="eyebrow">Live agents</span>{open(TILE_HOME.agents)}</div>
              <div className="big oi-cfs-run glow">{model.agents.live ?? "—"}</div>
              <div className="mbar" style={{ width: "100%", height: 14, margin: "8px 0" }}>{model.agents.segments.map(s => <i key={s.key} style={{ width: `${s.pct}%`, background: PROVIDER_VAR[s.chip] }} />)}</div>
              <div className="legend">{model.agents.segments.map(s => <span key={s.key}>{s.chip} {s.live}</span>)}</div>
              <div className="note" style={{ marginTop: 8 }}>{model.agents.note ?? <>{model.agents.roles}<br />{model.agents.needs}</>}</div></section>
            <section className="tile s7 nl"><div className="th"><span className="eyebrow">Worst problems</span><span className="note">errors and denials only</span>{open(TILE_HOME.problems)}</div>
              {model.problems.length === 0 && <div className="note">No errors or denials in this window.</div>}
              {model.problems.map((r: ProblemRow) => <button key={r.fingerprint} type="button" className="inc" onClick={() => r.lastCallKey && p.onSelect(r.lastCallKey)} title="Open the newest call of this problem"><span className="k">{r.count}</span><span>{cleanText(r.title, 60)}<small>{cleanText(r.lanes, 40)} · {cleanText(r.workspace, 30)}</small></span><span><span className="oi-cfs-chip" style={{ "--c": TONE_VAR[r.tone] } as React.CSSProperties}>{r.state}</span></span><span className="note">{r.age}</span></button>)}</section>
            <section className="tile s5"><div className="th"><span className="eyebrow">Busiest tools</span>{open(TILE_HOME.tools)}</div>
              {model.tools.map(r => <div key={r.tool} className="tool"><span className="mono">{cleanText(r.tool, 24)}</span><span><div className="hbar" style={{ width: `${r.pct}%` }} /></span><span className="r">{r.count}</span><span className="r oi-cfs-muted">{r.p50}</span></div>)}</section>
            <section className="tile s6 nl"><div className="th"><span className="eyebrow">Cost by model</span>{open(TILE_HOME.models)}</div>
              {model.models.length === 0 && <div className="note">No matched calls in this window.</div>}
              {model.models.map(r => <div key={r.model} className="trow"><span>{provChip(r.chip)} {cleanText(r.name, 28)}</span><span className="r">{r.usd}</span><span className="r oi-cfs-muted">{r.detail}</span></div>)}</section>
            <section className="tile s6"><div className="th"><span className="eyebrow">Message flow</span><span className="note">metadata only</span></div>
              {model.flow.length === 0 && <div className="note">No messages in this window.</div>}
              {model.flow.map((m, i) => <div key={`${m.at}-${i}`} className="msg"><span className="oi-cfs-muted">{m.time}</span><span className="x">{cleanText(m.text, 70)}</span><span className="oi-cfs-chip" style={{ "--c": m.tone === "fail" ? "var(--oi-tone-failure)" : "var(--oi-tone-info)" } as React.CSSProperties}>{m.chip}</span></div>)}</section>
          </div>
        </>}
      </div>
      {d && <Drawer d={d} onClose={() => p.onSelect(null)} onPick={p.onSelect} onOpenBead={p.onOpenBead} />}
    </div>
  </div>;
}

function Drawer({ d, onClose, onPick, onOpenBead }: { d: DrawerModel; onClose(): void; onPick(key: string): void; onOpenBead?(id: string): void }) {
  const failed = d.status === "error" || d.status === "denied";
  return <aside className="oi-cfs-drawer" aria-label="Selected call"><button type="button" className="oi-cfs-x" title="Close (Esc)" aria-label="Close the call drawer" onClick={onClose}>×</button><div className="eyebrow">Call</div>
    <h3 className="oi-cfs-title">{cleanText(d.tool, 40)}</h3>
    <div className="note"><span className={failed ? "oi-cfs-fail" : ""}>{d.status}{d.exit ? ` · ${cleanText(d.exit, 40)}` : ""}</span> · {cleanText(d.lane, 40)} {provChip(d.chip)}</div>
    <dl className="kv">
      <dt>Timing</dt><dd>{d.timing}</dd>
      <dt>Work item</dt><dd>{d.workItem ? <button type="button" className="oi-cfs-chip oi-cfs-idc" style={{ "--c": "var(--oi-tone-info)" } as React.CSSProperties} onClick={() => onOpenBead?.(d.workItem!)} title="Open this work item">{cleanText(d.workItem, 30)}</button> : <span className="oi-cfs-muted">not recorded</span>}</dd>
      <dt>Workspace</dt><dd>{d.workspace ? cleanText(d.workspace, 60) : <span className="oi-cfs-muted">not recorded</span>}</dd>
      <dt>Tokens</dt><dd className="mono" style={{ fontSize: 11.5 }}>{d.tokens ? <>{d.tokens.line1}<br />{d.tokens.line2}</> : <span className="oi-cfs-muted">not matched</span>}</dd>
      <dt>Est. price</dt><dd>{d.price ? <><b className="mono">{d.price.request}</b> <span className="oi-cfs-muted">request</span>{d.price.each && <><br /><span className="oi-cfs-muted mono" style={{ fontSize: 11 }}>{d.price.each}</span></>}</> : <span className="oi-cfs-muted">n/a</span>}</dd>
    </dl>
    {d.tier && <div className="oi-cfs-tier"><span className={tierClass(d.tier.tier)} style={{ fontSize: 14 }}>{d.tier.glyph}</span><span><b>{d.tier.words}.</b> {d.tier.explanation}{d.tier.matchedBy && <><br /><span className="note">{d.tier.matchedBy} · transcript line found</span></>}</span></div>}
    <div className="note" style={{ marginBottom: 8 }}>Tiers: ● exact (own request) · ◐ shared · ○ not matched (reason shown)</div>
    <div className="eyebrow" style={{ margin: "10px 0 4px" }}>Context · 3 before / 3 after</div>
    {d.context.map((r: ContextRow) => <button key={r.key} type="button" className={`ctx${r.current ? " cur" : ""}`} aria-current={r.current || undefined} onClick={() => !r.current && onPick(r.key)}><span className="oi-cfs-muted">{r.time}</span><span>{cleanText(r.tool, 24)}</span><span className="r">{r.dur}</span><span className={`r ${tierClass(r.tier)}`}>{r.glyph}{r.tier === "none" || r.tier === null ? " n/m" : ""}</span></button>)}
  </aside>;
}

/** The mockup's state-2 CSS, mapped onto the --oi-* tokens (--bg -> --oi-bg, --muted -> --oi-tone-muted, ...). Provider colours are the lane palette. */
export const callsFullscreenStyles = `
.oi-cfs{--p-claude:var(--oi-lane-3);--p-codex:var(--oi-lane-1);--p-gemini:var(--oi-lane-0);flex:1;min-height:0;display:flex;flex-direction:column;background:var(--oi-bg);color:var(--oi-text);font:13px/1.4 var(--oi-font-ui)}
.oi-cfs *{box-sizing:border-box}
.oi-cfs button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
.oi-cfs button:focus-visible,.oi-cfs [tabindex]:focus-visible{outline:2px solid var(--oi-focus,var(--oi-accent));outline-offset:1px}
.oi-cfs .mono{font-family:var(--oi-font-mono)}
.oi-cfs-muted{color:var(--oi-tone-muted)}
.oi-cfs-run{color:var(--oi-tone-running)}.oi-cfs-att{color:var(--oi-tone-attention)}.oi-cfs-fail{color:var(--oi-tone-failure)}.oi-cfs-acc{color:var(--oi-accent)}
.oi-cfs .glow{text-shadow:var(--oi-glow)}
.oi-cfs .note,.oi-cfs-note{font:11px var(--oi-font-mono);color:var(--oi-tone-muted)}
.oi-cfs .eyebrow{font:600 10px var(--oi-font-head);letter-spacing:.09em;text-transform:uppercase;color:var(--oi-tone-muted);display:flex;align-items:center;gap:8px}
.oi-cfs-chip{display:inline-flex;align-items:center;gap:4px;padding:0 6px;border-radius:9px;font:600 10.5px/17px var(--oi-font-mono);white-space:nowrap;background:color-mix(in srgb,var(--c,var(--oi-tone-muted)) 16%,transparent);color:var(--c,var(--oi-text-2))}
.oi-cfs-idc{cursor:pointer}.oi-cfs-idc:hover{text-decoration:underline}
.oi-cfs-h{display:flex;align-items:center;gap:10px;height:34px;padding:0 14px;border-bottom:1px solid var(--oi-border);font:11px var(--oi-font-mono);color:var(--oi-tone-muted);background-image:var(--oi-scanline)}
.oi-cfs-h b{color:var(--oi-text);font:600 12px var(--oi-font-head)}
.oi-cfs-btn{font:11px var(--oi-font-mono);color:var(--oi-text-2);padding:4px 9px;min-height:30px;border-radius:6px;background:var(--oi-hover)}
.oi-cfs-btn:hover{color:var(--oi-text)}
.oi-cfs-btn kbd{font:10px var(--oi-font-mono);color:var(--oi-tone-muted);margin-left:4px}
.oi-cfs-tabs{display:flex;align-items:center;gap:2px;height:36px;padding:0 10px;border-bottom:1px solid var(--oi-border-strong)}
.oi-cfs-ct{height:36px;padding:0 10px;font-size:12.5px;color:var(--oi-tone-muted)}
.oi-cfs-ct:hover{color:var(--oi-text)}
.oi-cfs-ct[aria-selected=true]{color:var(--oi-text);box-shadow:var(--oi-tab-underline)}
.oi-cfs-sep{width:1px;height:16px;background:var(--oi-border-strong);margin:0 6px}
.oi-cfs-end{margin-left:auto;display:flex;gap:6px;align-items:center}
.oi-cfs-grid{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 380px}
.oi-cfs-main{overflow:auto;padding:12px 16px;min-width:0}
.oi-cfs-stat{display:flex;flex-wrap:wrap;gap:0;margin:4px 0 0}
.oi-cfs-stat>div{padding:0 14px;border-left:1px solid var(--oi-border)}
.oi-cfs-stat>div:first-child{padding-left:0;border-left:0}
.oi-cfs-stat .v{font:700 18px/1.1 var(--oi-font-mono);font-variant-numeric:tabular-nums}
.oi-cfs-stat .k{font:600 9.5px var(--oi-font-head);letter-spacing:.08em;text-transform:uppercase;color:var(--oi-tone-muted)}
.oi-cfs-stat .s{font:10px var(--oi-font-mono);color:var(--oi-tone-muted)}
.oi-cfs-brush{position:relative;height:30px;margin:6px 0 14px;border-radius:3px;background:var(--oi-panel);overflow:hidden;touch-action:none;cursor:ew-resize;user-select:none}
.oi-cfs-brush .tick{position:absolute;bottom:0;width:2px;background:color-mix(in srgb,var(--oi-tone-running) 55%,transparent)}
.oi-cfs-brush .win{position:absolute;top:0;bottom:0;background:color-mix(in srgb,var(--oi-accent) 14%,transparent);box-shadow:inset 1px 0 0 var(--oi-accent),inset -1px 0 0 var(--oi-accent);pointer-events:none}
.oi-cfs-brush .lab{position:absolute;right:6px;top:2px;font:10px var(--oi-font-mono);color:var(--oi-tone-muted);pointer-events:none}
.oi-cfs-reset{position:absolute;left:6px;top:4px;font:10px var(--oi-font-mono);color:var(--oi-text-2);padding:0 6px;border-radius:4px;background:var(--oi-hover)}
.oi-cfs-tiles{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:0}
.oi-cfs .tile{padding:12px 14px 14px;border-top:1px solid var(--oi-border);min-width:0}
.oi-cfs .tile+.tile{border-left:1px solid var(--oi-border)}
.oi-cfs .tile.s8{grid-column:span 8}.oi-cfs .tile.s4{grid-column:span 4}.oi-cfs .tile.s7{grid-column:span 7}.oi-cfs .tile.s5{grid-column:span 5}.oi-cfs .tile.s6{grid-column:span 6}
.oi-cfs .tile.nl{border-left:0}
.oi-cfs .tile .th{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.oi-cfs-open{margin-left:auto;font:11px var(--oi-font-mono);color:var(--oi-tone-muted);min-height:24px}
.oi-cfs-open:hover{color:var(--oi-text)}
.oi-cfs .big{font:800 40px/1 var(--oi-font-mono);font-variant-numeric:tabular-nums}
.oi-cfs .mbar{display:inline-flex;border-radius:3px;overflow:hidden;background:color-mix(in srgb,var(--oi-text) 12%,transparent)}
.oi-cfs .mbar i{display:block;height:100%}
.oi-cfs .legend{display:flex;gap:12px;font:10.5px var(--oi-font-mono);color:var(--oi-tone-muted)}
.oi-cfs .legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px}
.oi-cfs .bars{display:flex;align-items:flex-end;gap:3px;margin:6px 0 4px}
.oi-cfs .bars span{flex:1;display:flex;flex-direction:column-reverse;min-width:0}
.oi-cfs .bars i{display:block}
.oi-cfs .inc{display:grid;grid-template-columns:48px minmax(0,1fr) 64px 64px;gap:8px;align-items:center;min-height:30px;width:100%;text-align:left;border-bottom:1px solid var(--oi-border);font-size:12px}
.oi-cfs .inc:hover{background:var(--oi-hover)}
.oi-cfs .inc>*{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-cfs .inc .k{font:700 12px var(--oi-font-mono);color:var(--oi-tone-failure)}
.oi-cfs .inc small{display:block;font:10px var(--oi-font-mono);color:var(--oi-tone-muted)}
.oi-cfs .hbar{height:6px;border-radius:3px;background:color-mix(in srgb,var(--oi-tone-running) 60%,transparent)}
.oi-cfs .tool{display:grid;grid-template-columns:90px minmax(0,1fr) 48px 50px;gap:8px;align-items:center;height:24px;border-bottom:1px solid var(--oi-border);font-size:12px}
.oi-cfs .tool .r,.oi-cfs .trow .r{text-align:right;font-family:var(--oi-font-mono);font-variant-numeric:tabular-nums}
.oi-cfs .trow{display:grid;grid-template-columns:minmax(0,1fr) 70px 70px;gap:8px;height:24px;align-items:center;border-bottom:1px solid var(--oi-border);font-size:12px}
.oi-cfs .msg{display:flex;gap:8px;font:11px var(--oi-font-mono);height:22px;align-items:center;border-bottom:1px solid var(--oi-border);min-width:0}
.oi-cfs .msg .x{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;color:var(--oi-text-2)}
.oi-cfs-drawer{border-left:1px solid var(--oi-border-strong);background:var(--oi-panel);overflow:auto;padding:12px 14px;box-shadow:-18px 0 40px -24px var(--oi-scrim)}
.oi-cfs-x{float:right;color:var(--oi-tone-muted);font-size:14px;width:44px;height:44px;margin:-10px -10px 0 0;border-radius:4px}
.oi-cfs-x:hover{background:var(--oi-hover);color:var(--oi-text)}
.oi-cfs-title{margin:6px 0 2px;font:600 15px var(--oi-font-mono)}
.oi-cfs .kv{display:grid;grid-template-columns:76px 1fr;gap:4px 10px;font-size:11.5px;margin:10px 0 8px}
.oi-cfs .kv dt{color:var(--oi-tone-muted)}.oi-cfs .kv dd{margin:0;min-width:0}
.oi-cfs-tier{display:flex;gap:8px;align-items:flex-start;padding:8px;border-radius:5px;background:color-mix(in srgb,var(--oi-tone-attention) 8%,transparent);font-size:12px;margin:8px 0}
.oi-cfs-tier b{font-family:var(--oi-font-mono)}
.oi-cfs .ctx{font:11px var(--oi-font-mono);display:grid;grid-template-columns:62px minmax(0,1fr) 56px 54px;gap:6px;min-height:22px;width:100%;text-align:left;align-items:center;border-bottom:1px solid var(--oi-border)}
.oi-cfs .ctx>*{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.oi-cfs .ctx:hover{background:var(--oi-hover)}
.oi-cfs .ctx.cur{background:var(--oi-selected);box-shadow:inset 2px 0 0 var(--oi-accent)}
.oi-cfs .ctx .r{text-align:right}
@media (max-width:1100px){.oi-cfs-grid{grid-template-columns:minmax(0,1fr)}.oi-cfs-drawer{position:fixed;inset:70px 0 0 auto;width:min(380px,100%);z-index:2}}
@media (max-width:820px){.oi-cfs .tile{grid-column:1/-1!important;border-left:0!important}}
`;
