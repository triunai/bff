// Panel controls: the pill strip (a slot stacking several panels), "swap with centre" and the slot picker. Two homes:
// PanelFrame draws them as ONE 24px row above the panel; a panel with `inlineChrome` (the terminal) takes <PanelChrome/> into
// its own toolbar instead, so the frame adds no row above the terminal. View > Tab Bar "hidden" drops the row altogether.
import {useEffect, useRef, useState, type KeyboardEvent as ReactKeyEvent, type ReactNode} from "react";
import {SLOTS, type Layout, type LayoutAction, type PanelDef, type SlotId} from "../../shell/layout-types.ts";
import {TERMINAL_ID} from "../../shell/layout-model.ts";

const SLOT_LABEL: Record<SlotId, string> = {left: "Left", centre: "Centre", right: "Right", bottom: "Bottom"};

export type MaximiseProps = {maximised?: boolean; onToggleMaximise?: () => void};

export function PanelChrome({layout, slot, panel, registry, dispatch, maximised, onToggleMaximise}: {layout: Layout; slot: SlotId; panel: PanelDef; registry: readonly PanelDef[]; dispatch: (a: LayoutAction) => void} & MaximiseProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null), btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.shiftKey) { e.stopPropagation(); setOpen(false); btn.current?.focus(); } };
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey); document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, [open]);
  const stack = layout.slots[slot].panels, tabBar = layout.view.tabBar;
  const title = (id: string) => registry.find(p => p.id === id)?.title ?? id;
  // Esc while this control has focus closes its menu and stops there: it must not also reach the root Esc (which clears the selection).
  const onKeyDown = (e: ReactKeyEvent) => { if (open && e.key === "Escape" && !e.shiftKey) { e.stopPropagation(); setOpen(false); btn.current?.focus(); } };
  return <span className="oi-pc" ref={wrap} onKeyDown={onKeyDown}>
    {tabBar === "pills" && stack.length > 1
      ? <span className="oi-pc-pills" role="tablist" aria-label="Panels in this slot">{stack.map(id => <button key={id} type="button" role="tab" aria-selected={id === panel.id} className={id === panel.id ? "active" : ""} onClick={() => dispatch({type: "activate", panel: id})}>{title(id)}</button>)}</span>
      : tabBar === "hidden" ? null : <span className="oi-pc-title">{panel.title}</span>}
    {onToggleMaximise && <button type="button" className="oi-pc-btn oi-pc-max" aria-pressed={!!maximised} title={maximised ? "Restore the panel size" : "Maximise this panel to fill the centre column"} aria-label={maximised ? "Restore panel size" : "Maximise panel"} onClick={onToggleMaximise}>{maximised ? "⤡" : "⤢"}</button>}
    {slot !== "centre" && <button type="button" className="oi-pc-btn" title="Swap with centre" aria-label={`Swap ${panel.title} with centre`} onClick={() => dispatch({type: "swapWithCentre", panel: panel.id})}>⇄</button>}
    <button type="button" ref={btn} className="oi-pc-btn" aria-haspopup="menu" aria-expanded={open} title="Move panel" aria-label={`Move ${panel.title}`} onClick={() => setOpen(o => !o)}>⋮</button>
    {open && <span className="oi-pc-menu" role="menu" aria-label={`Move ${panel.title}`}>
      {SLOTS.map(s => <button key={s} type="button" role="menuitem" disabled={s === slot} onClick={() => { setOpen(false); dispatch({type: "moveTo", panel: panel.id, slot: s}); }}>{s === slot ? "✓ " : ""}Move to {SLOT_LABEL[s]}</button>)}
      {panel.id !== TERMINAL_ID && <><span className="oi-pc-sep" role="separator"/><button type="button" role="menuitem" onClick={() => { setOpen(false); dispatch({type: "close", panel: panel.id}); }}>Close</button></>}
    </span>}
  </span>;
}

/** The 24px header row (panels without their own toolbar). */
export function PanelFrame({children}: {children: ReactNode}) {
  return <div className="oi-pf">{children}</div>;
}

export const panelFrameStyles = `
.oi-pf{display:flex;align-items:center;height:24px;flex:none;padding:0 6px;border-bottom:1px solid var(--oi-border);background:var(--oi-bg);font-size:10px;min-width:0}
.oi-pc{position:relative;display:flex;align-items:center;gap:3px;min-width:0;flex:1}
.oi-pc-title{font-weight:600;color:var(--oi-muted);text-transform:uppercase;letter-spacing:.04em;margin-right:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-pc-pills{display:flex;gap:2px;margin-right:auto;min-width:0;overflow:hidden}
.oi-root .oi-pc-pills button{padding:1px 8px;font-size:10px;line-height:16px;border:0;border-radius:3px;white-space:nowrap}
.oi-root .oi-pc-pills button.active{background:transparent;color:var(--oi-text);box-shadow:var(--oi-tab-underline)}
.oi-root .oi-pc-btn{padding:0 5px;font-size:11px;line-height:18px;min-width:20px;text-align:center;flex:none}
.oi-pc-menu{position:absolute;top:100%;right:0;z-index:30;display:flex;flex-direction:column;gap:2px;min-width:150px;padding:4px;background:var(--oi-raised);border:1px solid var(--oi-border-strong);border-radius:6px;box-shadow:var(--oi-shadow-raised)}
.oi-root .oi-pc-menu button{font-size:11px;padding:3px 7px}.oi-root .oi-pc-menu button:disabled{opacity:.55;cursor:default}
.oi-pc-sep{border-top:1px solid var(--oi-border);margin:2px 0}
.oi-term-line .oi-pc{flex:0 0 auto;margin-left:4px}.oi-term-line .oi-pc-title{display:none}
`;
