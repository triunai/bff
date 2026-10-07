import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FOCUSABLE, createFocusKeeper, isFullscreenKey, trapTarget, type FsKeyCtx, type FsKeyEvent } from "../../shell/factory-fullscreen.ts";

/** State only. Nothing is persisted: full screen always starts off. There is NO listener here: the Factory root's onKey calls
 * `handleKey(e, ctx)` (true = it toggled; the caller then stops the key), passing the shell's Mod+K chord state so a Z that
 * completes Mod+K Z (zen) is left alone. Esc is the shell's: it calls `exit` at the end of its own chain. `enabled:false`
 * force-resets to off (the Factory left the screen) and makes handleKey inert. */
export function useFactoryFullscreen(opts?: { enabled?: boolean }): { full: boolean; toggle(): void; exit(): void; handleKey(e: FsKeyEvent, ctx?: FsKeyCtx): boolean } {
  const [full, setFull] = useState(false);
  const enabled = opts?.enabled !== false;
  const toggle = useCallback(() => setFull(v => !v), []);
  const exit = useCallback(() => setFull(false), []);
  useEffect(() => { if (!enabled) setFull(false); }, [enabled]);
  const handleKey = useCallback((e: FsKeyEvent, ctx?: FsKeyCtx) => { if (!enabled || !isFullscreenKey(e, ctx)) return false; setFull(v => !v); return true; }, [enabled]);
  return { full, toggle, exit, handleKey };
}

/** The Factory in a CSS overlay. Children stay in ONE stable wrapper (`display:contents` when off, a fixed overlay when on), so
 * toggling never remounts the floor: camera, scrub and follow survive. On: body scroll locked, Tab trapped inside, focus
 * restored on exit. The overlay sits at `--oi-z-overlay` (50) over the Osiris nav, sidebars, bottom strip and inspector. */
export function FactoryFullscreen(p: { full: boolean; onExit(): void; children: ReactNode; /** The dialog's accessible name; the Factory by default. */ label?: string }) {
  const ref = useRef<HTMLDivElement>(null), keeper = useRef(createFocusKeeper(document));

  useEffect(() => {
    if (!p.full) return;
    keeper.current.remember();
    const body = document.body, prev = body.style.overflow;
    body.style.overflow = "hidden";
    ref.current?.focus();
    return () => {
      body.style.overflow = prev;
      keeper.current.restore();
    };
  }, [p.full]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!p.full || e.key !== "Tab") return;
    const root = ref.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.offsetParent !== null || el === document.activeElement);
    const next = trapTarget(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
    if (next === null) { e.preventDefault(); root.focus(); return; }
    e.preventDefault(); items[next].focus();
  };

  return <div ref={ref} tabIndex={-1} className={p.full ? "oi-fsx" : "oi-fsx-off"} data-fullscreen={p.full ? "on" : "off"} role={p.full ? "dialog" : undefined} aria-modal={p.full ? true : undefined} aria-label={p.full ? (p.label ?? "Factory, full screen") : undefined} onKeyDown={onKeyDown}>
    <style>{FULLSCREEN_CSS}</style>
    {p.children}
  </div>;
}

/** The BAR button: "⛶" to enter, "✕ Exit" while full. Put it in the shell's bar slot. */
export function FullscreenToggle(p: { full: boolean; onToggle(): void }) {
  return <button type="button" className="oi-fsx-toggle" onClick={p.onToggle} aria-pressed={p.full} aria-label={p.full ? "Exit full screen" : "Full screen"} data-tip={p.full ? "Leave full screen" : "True scale, every item, one scrolling page"} data-tip-key="Z">{p.full ? "✕ Exit" : <><i className="oi-tb-g" aria-hidden="true">⛶</i><span className="oi-tb-l">Full screen</span></>}</button>;
}

export const FULLSCREEN_CSS = `
.oi-fsx-off{display:contents}
.oi-fsx{position:fixed;inset:0;z-index:var(--oi-z-overlay,50);display:flex;flex-direction:column;background:var(--oi-bg);color:var(--oi-text);overflow:hidden;outline:none}
.oi-fsx>.oi-ff{flex:1;min-height:0;--ff-rail:300px}
.oi-fsx-toggle{font:600 12px ui-monospace,monospace;min-width:44px;min-height:30px;padding:0 10px;border:1px solid var(--oi-border);border-radius:8px;background:transparent;color:var(--oi-text);cursor:pointer}
.oi-fsx-toggle:hover{background:var(--oi-hover);border-color:var(--oi-border-strong)}
.oi-fsx-toggle:focus-visible{outline:2px solid var(--oi-focus,var(--oi-accent));outline-offset:1px}
.oi-fsx-toggle[aria-pressed=true]{border-color:var(--oi-accent)}
.oi-fsx .oi-ff-stage,.oi-ff.full .oi-ff-stage{position:relative}
.oi-fsx .oi-ff-side,.oi-ff.full .oi-ff-side{position:sticky;top:8px;flex:none;align-self:flex-start;width:280px;max-height:calc(100vh - 16px);overflow:auto} /* a real column of the stage: the silos get the remaining width, nothing overlays them */
.oi-fsx .oi-ff-side section,.oi-ff.full .oi-ff-side section{background:color-mix(in srgb,var(--oi-panel) 92%,transparent)}
@media (max-width:900px){.oi-fsx .oi-ff-side,.oi-ff.full .oi-ff-side{position:static;width:auto;max-height:none}}
`;
