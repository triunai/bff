import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { PaneTail, WorkSurfaceSnapshot } from "../../work/surface-types.ts";
import { headerSegs, TREE_KEYS, treeFromSnapshot, type Seg, type TreeLine, type TreeTerms } from "../../work/tree-layout.ts";

// The WORK tree, held to PARITY with beady-eye's README "arkham" frame (owner 23:00: "it has to look better than beady-eye"),
// then better where a GUI can be. work/tree-layout.ts computes every guide, column, tone and hint; this only paints them.
// Parity: one monospace grid; guides in the foreground at one weight; an id column padded to the widest id; in-progress
// glyph+id in the accent with a bold title; done rows dimmed; a right bloc flush right; the selected row as a full-width light
// band with an accent chip on glyph+id and a success chip on the agent; the "── wG:p2 ──" pane band; the key row.
// Better: hover = full title + what it waits on + the warning in plain English; click the id = open the inspector; click the
// arm = fold; a working agent's ◍ pulses (not under reduced motion); a cost chip when costs are wired; a wide-short strip.

export type BeadTreeProps = {
  snap: WorkSurfaceSnapshot; now: number; selectedId: string | null; tail?: PaneTail | null;
  onSelect(id: string): void;
  /** Click on an id chip: open the bead in the inspector (falls back to onSelect). */
  onInspect?(id: string): void;
  /** Per-bead cost text, once T1 wires costs. */
  costs?: ReadonlyMap<string, string>;
  /** "column" for a side panel; "strip" for the wide-short bottom strip (owner: the WORK tree moves to a bottom strip). */
  variant?: "column" | "strip";
  /** q: hide the strip / panel. */
  onClose?(): void;
  /** Jargon labels/definitions: pass { label: termLabel, def: termDef } from work/glossary.ts once fix/plain-words lands. */
  terms?: TreeTerms;
  /** Factory fusion (FactoryTreeRail): decorate and observe rows without forking the tree. `lead` draws right after the id chip,
   * `trail` first in the right bloc (folded = the row's kids are hidden), `onHoverRow` reports the pointer (null on leave), and
   * `roles` marks rows by a dependency chain in focus (focus / up = it waits on these / down = these wait on it / dim). */
  lead?(id: string): ReactNode;
  trail?(id: string, folded: boolean): ReactNode;
  onHoverRow?(id: string | null, anchor?: { x: number; y: number }, via?: { origin: string; kind: "pointer" | "focus" }): void;
  roles?: ReadonlyMap<string, "focus" | "up" | "down" | "dim">;
};

/** A segment in three widths; the container query picks one (full ≥ 520px, short ≥ 320px, tiny below). */
const Segs = ({ segs }: { segs: readonly Seg[] }) => <>{segs.map((s, i) => {
  const tiny = s.tiny ?? s.short;
  return <span key={i} title={s.short !== undefined ? s.text : undefined} className={`oi-bt-t-${s.tone}${s.live ? " oi-bt-live" : ""}${s.short !== undefined ? " oi-bt-hs" : ""}${tiny !== undefined ? " oi-bt-ht" : ""}`}>
    <span className="oi-bt-full">{s.text}</span>{s.short !== undefined && <span className="oi-bt-short">{s.short}</span>}{tiny !== undefined && <span className="oi-bt-tiny">{tiny}</span>}
  </span>;
})}</>;

export function BeadTree(p: BeadTreeProps) {
  const [showDone, setShowDone] = useState(false);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [find, setFind] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const lay = useMemo(() => treeFromSnapshot(p.snap, p.now, { selectedId: p.selectedId, showDone, tail: p.tail ?? null, folded, costs: p.costs, terms: p.terms }), [p.snap, p.now, p.selectedId, showDone, p.tail, folded, p.costs, p.terms]);
  const beads = lay.lines.filter((l): l is Extract<TreeLine, { kind: "bead" }> => l.kind === "bead");
  const hs = headerSegs(lay.header);
  const toggleFold = (id: string) => setFolded(f => { const n = new Set(f); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const roots = beads.filter(b => b.guide.length === 4).map(b => b.id);
  const allFolded = roots.length > 0 && roots.every(id => folded.has(id));
  const jump = (q: string) => {
    const n = q.trim().toLowerCase(); if (!n) return;
    const from = beads.findIndex(b => b.id === p.selectedId);
    const hit = [...beads.slice(from + 1), ...beads.slice(0, from + 1)].find(b => b.id.toLowerCase().includes(n) || b.fullTitle.toLowerCase().includes(n));
    if (hit) p.onSelect(hit.id);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (e.key === "a") { e.preventDefault(); setShowDone(v => !v); return; }
    if (e.key === "/") { e.preventDefault(); setFind(""); return; }
    if (e.key === "?") { e.preventDefault(); e.stopPropagation(); setHelp(v => !v); return; }
    if (e.key === "Escape" && help) { e.preventDefault(); e.stopPropagation(); setHelp(false); return; }
    if (e.key === "q" && p.onClose) { e.preventDefault(); p.onClose(); return; }
    const els = Array.from(box.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []);
    const at = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Enter" && at >= 0) { e.preventDefault(); const id = els[at].dataset.id; if (id) p.onSelect(id); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" || !els.length) return;
    e.preventDefault();
    els[e.key === "ArrowDown" ? Math.min(els.length - 1, at + 1) : Math.max(0, at - 1)].focus();
  };
  const style = { "--idw": String(Math.max(1, lay.idWidth)) } as unknown as CSSProperties;
  const tail = lay.tail && <section className="oi-bt-tail" aria-label={`Pane ${lay.tail.label}`}>
    <div className="oi-bt-tailh" title={`The last lines on ${lay.tail.label}, the pane of ${lay.tail.beadId}`}>{lay.tail.label}</div>
    <pre>{lay.tail.truncated ? "…\n" : ""}{lay.tail.lines.join("\n")}</pre>
  </section>;
  return <div className={`oi-bt oi-bt-${p.variant ?? "column"}`} style={style} ref={box} tabIndex={-1} onKeyDown={onKey} role="tree" aria-label="Work tree">
    <div className="oi-bt-root">
      <button type="button" className="oi-bt-name" aria-expanded={!allFolded} title={allFolded ? "Unfold every tree" : "Fold every tree"} onClick={() => setFolded(allFolded ? new Set() : new Set(roots))}>{allFolded ? "▸" : "▾"} {lay.header.tracker}</button>
      <span className="oi-bt-hl"><Segs segs={hs.left} /></span>
      <span className="oi-bt-hr"><Segs segs={hs.right} /></span>
    </div>
    <div className="oi-bt-body">
      <div className="oi-bt-lines">{lay.lines.map(l => {
        if (l.kind === "bead") return <div role="treeitem" aria-selected={l.selected} aria-expanded={l.foldable ? !l.folded : undefined} data-row="1" data-id={l.id} tabIndex={l.selected ? 0 : -1} key={l.key} className={`oi-bt-row oi-bt-${l.state}${l.selected ? " oi-bt-sel" : ""}${l.drift ? " oi-bt-drift" : ""}${p.roles?.has(l.id) ? ` oi-bt-r-${p.roles.get(l.id)}` : ""}`} title={l.hint} onClick={() => p.onSelect(l.id)} onMouseEnter={p.onHoverRow ? () => p.onHoverRow!(l.id, undefined, { origin: l.id, kind: "pointer" }) : undefined} onMouseLeave={p.onHoverRow ? () => p.onHoverRow!(null, undefined, { origin: l.id, kind: "pointer" }) : undefined}
          onFocus={p.onHoverRow ? e => { const r = e.currentTarget.getBoundingClientRect(); p.onHoverRow!(l.id, { x: r.right, y: r.top + r.height / 2 }, { origin: l.id, kind: "focus" }); } : undefined}
          onBlur={p.onHoverRow ? e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) p.onHoverRow!(null, undefined, { origin: l.id, kind: "focus" }); } : undefined}>
          {l.foldable ? <button type="button" className="oi-bt-guide oi-bt-arm" aria-label={l.folded ? `Unfold ${l.shortId}` : `Fold ${l.shortId}`} onClick={e => { e.stopPropagation(); toggleFold(l.id); }}>{l.guide}</button>
            : <span className="oi-bt-guide" aria-hidden="true">{l.guide}</span>}
          <button type="button" className="oi-bt-chip" title={`Open ${l.id} in the inspector`} onClick={e => { e.stopPropagation(); (p.onInspect ?? p.onSelect)(l.id); }}><span className="oi-bt-glyph" aria-hidden="true">{l.glyph}</span> <span className="oi-bt-id">{l.shortId}</span></button>
          {p.lead?.(l.id)}
          <span className="oi-bt-title">{l.title}</span>
          <span className="oi-bt-right">{p.trail?.(l.id, l.folded)}<Segs segs={l.right} /></span>
        </div>;
        if (l.kind === "pane") return <div key={l.key} className="oi-bt-row oi-bt-pane" title={l.hint}>
          <span className="oi-bt-guide" aria-hidden="true">{l.guide}</span><span className={`oi-bt-t-success${l.live ? " oi-bt-live" : ""}`}>◍ {l.label} {l.state}</span><span className="oi-bt-title oi-bt-cwd">{l.cwd ?? ""}</span>
        </div>;
        return <div key={l.key} className={`oi-bt-row oi-bt-${l.kind}${l.kind === "group" && l.drift ? " oi-bt-drift" : ""}`} title={l.kind === "group" ? l.hint : undefined}>
          <span className="oi-bt-guide" aria-hidden="true">{l.guide}</span><span className={l.kind === "group" ? (l.drift ? "oi-bt-t-drift" : "oi-bt-t-attention") : "oi-bt-t-muted"}>{l.text}</span>
        </div>;
      })}</div>
      {tail}
    </div>
    {find !== null && <form className="oi-bt-find" onSubmit={e => { e.preventDefault(); jump(find); }}>
      <input autoFocus aria-label="Find a bead by id or title" value={find} placeholder="find id or title, Enter = next" onChange={e => setFind(e.target.value)} onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setFind(null); box.current?.focus(); } }} />
    </form>}
    <div className="oi-bt-keys" aria-label="Keys">{TREE_KEYS.map(k => <span key={k.key}><kbd>{k.key}</kbd> {k.key === "a" && showDone ? "hide done" : k.label}</span>)}</div>
    {help && <p className="oi-bt-help">a show or hide finished beads · ? these keys · / find by id or title (Enter = next, Esc = close) · q hide · Up/Down move · Enter select · click an id to inspect it · click an arm to fold</p>}
  </div>;
}

// Tokens only (ui-tokens.test.ts scans .tsx). One monospace grid; 20px rows; the title is the only column that shrinks.
export const beadTreeStyles = `
.oi-bt{display:flex;flex-direction:column;min-width:0;font:12px/1 var(--oi-font-mono,ui-monospace,monospace);color:var(--oi-text);outline:none;container-type:inline-size}
.oi-bt button{font:inherit;color:inherit;background:transparent;border:0;padding:0;margin:0;cursor:pointer}
.oi-bt-root{display:flex;align-items:baseline;gap:12px;min-width:0;padding:6px 8px 4px;white-space:nowrap}
.oi-bt-name{font-weight:700}
.oi-bt-hl{display:flex;gap:12px;min-width:0}
.oi-bt-hr{display:flex;gap:16px;margin-left:auto;font-variant-numeric:tabular-nums}
.oi-bt-hr .oi-bt-t-muted,.oi-bt-right .oi-bt-t-muted{color:var(--oi-text-2,var(--oi-text))}
.oi-bt-body{min-width:0}
.oi-bt-row{display:flex;align-items:center;gap:8px;width:100%;min-width:0;height:20px;padding:0 8px;box-sizing:border-box;cursor:default}
.oi-bt-row[data-row]{cursor:pointer}
.oi-bt-row[data-row]:hover{background:var(--oi-hover)}
.oi-bt-row[data-row]:focus-visible{outline:2px solid var(--oi-focus,var(--oi-accent));outline-offset:-2px}
.oi-bt-guide{flex:none;white-space:pre;color:var(--oi-text-2,var(--oi-text))}
.oi-bt-arm:hover{color:var(--oi-text)}
.oi-bt-chip{flex:none;display:inline-flex;gap:0;padding:0 2px;border-radius:2px;white-space:pre}
.oi-bt-glyph{display:inline-block;width:1ch;text-align:center}
.oi-bt-id{display:inline-block;width:calc(var(--idw)*1ch);text-align:left}
.oi-bt-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-bt-right{flex:none;display:flex;gap:16px;padding-left:8px;white-space:nowrap;font-variant-numeric:tabular-nums}
.oi-bt-right>span{padding:0 4px;border-radius:2px}
.oi-bt-active .oi-bt-chip{color:var(--oi-accent)}
.oi-bt-active .oi-bt-title{font-weight:700}
.oi-bt-done .oi-bt-chip,.oi-bt-done .oi-bt-title{color:var(--oi-muted)}
.oi-bt-blocked .oi-bt-glyph{color:var(--oi-tone-failure)}
.oi-bt-sel,.oi-bt-sel:hover{background:var(--oi-text);color:var(--oi-bg)}
.oi-bt-sel .oi-bt-guide,.oi-bt-sel .oi-bt-title,.oi-bt-sel .oi-bt-right .oi-bt-t-muted{color:var(--oi-bg)}
.oi-bt-sel .oi-bt-chip{background:var(--oi-accent);color:var(--oi-on-accent)}
.oi-bt-sel.oi-bt-done .oi-bt-chip,.oi-bt-sel.oi-bt-open .oi-bt-chip{background:var(--oi-muted);color:var(--oi-bg)}
.oi-bt-sel.oi-bt-blocked .oi-bt-chip,.oi-bt-sel.oi-bt-blocked .oi-bt-glyph{background:var(--oi-tone-failure);color:var(--oi-bg)}
.oi-bt-sel .oi-bt-t-success{background:var(--oi-tone-success);color:var(--oi-bg)}
.oi-bt-sel .oi-bt-t-attention{background:var(--oi-tone-attention);color:var(--oi-bg)}
.oi-bt-t-muted{color:var(--oi-muted)}.oi-bt-t-success{color:var(--oi-tone-success)}.oi-bt-t-attention{color:var(--oi-tone-attention)}
.oi-bt-t-failure{color:var(--oi-tone-failure)}.oi-bt-t-info{color:var(--oi-tone-info)}
.oi-bt-t-drift{padding:0 6px;border-radius:9px;color:var(--oi-drift);background:color-mix(in srgb,var(--oi-drift) var(--oi-tint,16%),transparent)}
.oi-bt-sel .oi-bt-t-drift{background:var(--oi-drift);color:var(--oi-on-drift)}
.oi-bt-drift{box-shadow:inset 2px 0 0 var(--oi-drift)}
.oi-bt-pane .oi-bt-cwd{color:var(--oi-text)}
.oi-bt-r-focus,.oi-bt-r-focus:hover{background:var(--oi-hover);box-shadow:inset 2px 0 0 var(--oi-accent)}
.oi-bt-r-up{box-shadow:inset 2px 0 0 var(--oi-tone-failure)}.oi-bt-r-down{box-shadow:inset 2px 0 0 var(--oi-tone-running)}
.oi-bt-r-dim{opacity:.45}
@keyframes oi-bt-pulse{0%,100%{opacity:1}50%{opacity:.45}}
.oi-bt-live{animation:oi-bt-pulse 1.6s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.oi-bt-live{animation:none}}
.oi-bt-tail{margin:6px 0 0}
.oi-bt-tailh{display:flex;align-items:center;gap:8px;padding:0 8px;color:var(--oi-text)}
.oi-bt-tailh::before,.oi-bt-tailh::after{content:"";flex:1;border-top:1px solid var(--oi-muted)}
.oi-bt-tail pre{margin:6px 0 0;padding:0 16px;font:inherit;line-height:1.45;color:var(--oi-text);white-space:pre-wrap;overflow-wrap:anywhere}
.oi-bt-find{padding:6px 8px 0}
.oi-bt-find input{width:100%;padding:4px 6px;border:0;border-radius:3px;background:var(--oi-input,var(--oi-hover));color:var(--oi-text);font:inherit}
.oi-bt-keys{display:flex;gap:24px;padding:8px 8px 6px;color:var(--oi-text-2,var(--oi-text))}
.oi-bt-keys kbd{font:inherit;color:var(--oi-text)}
.oi-bt-help{margin:0 8px 6px;font:11px/1.45 var(--oi-font-ui,system-ui,sans-serif);color:var(--oi-muted)}
.oi-bt-short,.oi-bt-tiny{display:none}
.oi-bt-strip{height:100%;min-height:0}
.oi-bt-strip .oi-bt-body{flex:1;min-height:0;display:flex;flex-direction:column}
.oi-bt-strip .oi-bt-lines{flex:1;min-height:0;overflow-y:auto}
.oi-bt-strip .oi-bt-tail{flex:none;max-height:40%;overflow:auto}
.oi-bt-strip .oi-bt-keys{padding-top:4px}
@container (max-width:520px){.oi-bt-hs .oi-bt-short{display:inline}.oi-bt-hs .oi-bt-full{display:none}.oi-bt-right{gap:8px}.oi-bt-hr{gap:10px}.oi-bt-keys{gap:12px;flex-wrap:wrap}}
@container (max-width:320px){.oi-bt-ht .oi-bt-tiny{display:inline}.oi-bt-ht .oi-bt-full,.oi-bt-ht .oi-bt-short{display:none}.oi-bt-row{gap:6px;padding:0 4px}.oi-bt-hl{display:none}}
@container (min-width:900px){.oi-bt-strip .oi-bt-lines{columns:52ch auto;column-gap:24px;column-fill:auto;overflow-x:auto;overflow-y:hidden;height:100%}.oi-bt-strip .oi-bt-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(32ch,34%);gap:16px}.oi-bt-strip .oi-bt-row{break-inside:avoid}.oi-bt-strip .oi-bt-tail{margin:0;max-height:none;height:100%}}
`;
