import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { usePortalScopeProps } from "../../lib/portal-scope.ts";
import { edgeActive, placeMenu, stepActive, typeahead, type MenuOption, type Placement } from "./menu-select-model.ts";

export type { MenuOption } from "./menu-select-model.ts";

/** The one themed dropdown. It replaces every native <select> (a native one opens the OS menu, which ignores the theme).
 *  Listbox pattern: the trigger is a button (aria-haspopup, aria-expanded); the list is a portalled role=listbox in the TOP LAYER
 *  (popover API), inside the trigger's own <dialog> when it sits in one, so it paints above modals. Up/Down/Home/End move,
 *  Enter/Space choose, Esc closes and returns focus to the trigger, typing jumps to a label, an outside press closes. */
export type MenuSelectProps = {
  value: string;
  options: readonly MenuOption[];
  onChange(value: string): void;
  ariaLabel?: string;
  /** Shown on the trigger when `value` matches no option (a "Move to…" action menu keeps value "" and so always shows this). */
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  className?: string;
  onClick?(e: React.MouseEvent): void;
};

export function MenuSelect(p: MenuSelectProps) {
  const [open, setOpen] = useState(false), [active, setActive] = useState(-1), [place, setPlace] = useState<Placement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null), buf = useRef({ text: "", at: 0 });
  const uid = useId(), scope = usePortalScopeProps();
  const current = p.options.findIndex(o => o.value === p.value);
  const shown = current >= 0 ? p.options[current].label : p.placeholder ?? "";

  const openMenu = useCallback(() => { if (p.disabled) return; setActive(current >= 0 && !p.options[current].disabled ? current : edgeActive(p.options, false)); setOpen(true); }, [p.disabled, p.options, current]);
  const close = useCallback((refocus: boolean) => { setOpen(false); setPlace(null); if (refocus) trigger.current?.focus(); }, []);
  const choose = (i: number) => { const o = p.options[i]; if (!o || o.disabled) return; close(true); if (o.value !== p.value) p.onChange(o.value); };

  // Place after the first paint of the list so its natural size is known, then show it in the top layer.
  useLayoutEffect(() => {
    if (!open) return;
    const el = list.current, t = trigger.current; if (!el || !t) return;
    try { (el as HTMLElement & { showPopover?: () => void }).showPopover?.(); } catch { /* already open */ }
    const r = t.getBoundingClientRect();
    setPlace(placeMenu(r, { width: window.innerWidth, height: window.innerHeight }, el.scrollWidth, el.scrollHeight));
    el.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { const n = e.target as Node; if (!list.current?.contains(n) && !trigger.current?.contains(n)) close(false); };
    const drift = (e: Event) => { if (!list.current?.contains(e.target as Node)) close(false); };
    document.addEventListener("pointerdown", away, true); window.addEventListener("resize", drift); window.addEventListener("scroll", drift, true);
    return () => { document.removeEventListener("pointerdown", away, true); window.removeEventListener("resize", drift); window.removeEventListener("scroll", drift, true); };
  }, [open, close]);
  useEffect(() => { if (open && active >= 0) document.getElementById(`${uid}-${active}`)?.scrollIntoView({ block: "nearest" }); }, [open, active, uid]);

  const onTriggerKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); openMenu(); }
  };
  const onListKey = (e: KeyboardEvent) => {
    const k = e.key; let handled = true;
    if (k === "ArrowDown") setActive(stepActive(p.options, active, 1));
    else if (k === "ArrowUp") setActive(stepActive(p.options, active < 0 ? 0 : active, -1));
    else if (k === "Home") setActive(edgeActive(p.options, false));
    else if (k === "End") setActive(edgeActive(p.options, true));
    else if (k === "Enter" || k === " ") choose(active);
    else if (k === "Escape") close(true);
    else if (k === "Tab") close(false);
    else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now(), b = buf.current; b.text = now - b.at > 700 ? k : b.text + k; b.at = now;
      const i = typeahead(p.options, b.text, active); if (i >= 0) setActive(i);
    } else handled = false;
    if (handled && k !== "Tab") { e.preventDefault(); e.stopPropagation(); }
  };

  const style: CSSProperties | undefined = place ? { left: place.left, top: place.top, minWidth: place.minWidth, maxHeight: place.maxHeight } : { left: 0, top: 0, visibility: "hidden" };
  const host = (typeof document !== "undefined" && (trigger.current?.closest("dialog") as HTMLElement | null)) || (typeof document !== "undefined" ? document.body : null);
  return <>
    <button ref={trigger} type="button" className={`oi-ms${p.className ? ` ${p.className}` : ""}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${uid}-list` : undefined} aria-label={p.ariaLabel} title={p.title} disabled={p.disabled}
      onClick={e => { p.onClick?.(e); if (!e.defaultPrevented) open ? close(false) : openMenu(); }} onKeyDown={onTriggerKey}>
      <span className="oi-ms-v">{shown}</span><span className="oi-ms-caret" aria-hidden="true">▾</span></button>
    {open && host && createPortal(
      <div {...scope} data-oi-menu="" ref={list} id={`${uid}-list`} popover="manual" role="listbox" tabIndex={-1} aria-label={p.ariaLabel ?? p.placeholder} aria-activedescendant={active >= 0 ? `${uid}-${active}` : undefined}
        className="oi-ms-list" data-flipped={place?.flipped ? "true" : "false"} style={style} onKeyDown={onListKey} onClick={e => e.stopPropagation()}>
        {p.options.map((o, i) => <div key={o.value || `__${i}`} id={`${uid}-${i}`} role="option" aria-selected={i === current} aria-disabled={o.disabled || undefined}
          className={`oi-ms-opt${i === active ? " active" : ""}`} onPointerMove={() => { if (!o.disabled && i !== active) setActive(i); }} onClick={() => choose(i)}>
          <span className="oi-ms-ck" aria-hidden="true">{i === current ? "✓" : ""}</span><span className="oi-ms-l">{o.label}</span>{o.hint ? <span className="oi-ms-h">{o.hint}</span> : null}</div>)}
      </div>, host)}
  </>;
}

export const menuSelectStyles = `
button.oi-ms{appearance:none;margin:0;text-align:left;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;justify-content:space-between;gap:8px;min-height:24px;max-width:100%;padding:2px 8px;font:12px var(--oi-font-ui,system-ui,sans-serif);color:var(--oi-text);background:var(--oi-panel);border:1px solid var(--oi-border);border-radius:6px;line-height:1.3}
button.oi-ms:hover:not(:disabled){background:var(--oi-hover)}button.oi-ms:focus-visible,button.oi-ms[aria-expanded="true"]{outline:1px solid var(--oi-accent,var(--oi-tone-info));outline-offset:0}button.oi-ms:disabled{opacity:.5;cursor:default}
.oi-ms-v{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.oi-ms-caret{flex:none;color:var(--oi-muted);font-size:10px}
.oi-ms-list{position:fixed;inset:auto;margin:0;box-sizing:border-box;display:flex;flex-direction:column;gap:1px;padding:4px;overflow-y:auto;max-width:min(420px,calc(100vw - 16px));font:12px var(--oi-font-ui,system-ui,sans-serif);color:var(--oi-text);background:var(--oi-raised,var(--oi-panel));border:1px solid var(--oi-border-strong,var(--oi-border));border-radius:8px;box-shadow:0 8px 24px color-mix(in srgb,var(--oi-bg) 60%,transparent);outline:none}
.oi-ms-opt{display:grid;grid-template-columns:14px minmax(0,1fr) auto;align-items:center;gap:8px;padding:5px 8px;border-radius:5px;cursor:pointer;color:var(--oi-text)}
.oi-ms-opt.active{background:color-mix(in srgb,var(--oi-accent,var(--oi-tone-info)) 18%,transparent)}.oi-ms-opt[aria-selected="true"]{font-weight:600}.oi-ms-opt[aria-disabled="true"]{opacity:.45;cursor:default}
.oi-ms-ck{color:var(--oi-accent,var(--oi-tone-info))}.oi-ms-l{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.oi-ms-h{color:var(--oi-muted);font-size:11px;white-space:nowrap}
`;
