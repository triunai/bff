import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { placeTip } from "../../work/tip-place.ts";

/** Props for a toolbar button that has a visible name, an aria-label and an INSTANT tooltip (no native title: it is slow and missing on some). */
export const tipProps = (label: string, desc: string, key?: string) => ({ "aria-label": label, "data-tip": desc, ...(key ? { "data-tip-key": key } : {}) });
/** The one delegated tooltip for the Factory: shows on pointer hover and on keyboard focus of any [data-tip] inside `root`, with no delay, in a layer above the scene and the inspector (a portal into the root, position:fixed), flipping to stay on screen. */
export function FactoryTipLayer({ root }: { root: RefObject<HTMLElement | null> }) {
  const [tip, setTip] = useState<{ text: string; key: string | null; rect: DOMRect } | null>(null), [at, setAt] = useState<{ x: number; y: number } | null>(null), box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current; if (!el) return;
    const show = (e: Event) => { const t = (e.target as Element | null)?.closest?.("[data-tip]") as HTMLElement | null; if (!t || !el.contains(t)) return; setAt(null); setTip({ text: t.dataset.tip ?? "", key: t.dataset.tipKey ?? null, rect: t.getBoundingClientRect() }); };
    const hide = () => setTip(null), esc = (e: KeyboardEvent) => { if (e.key === "Escape") setTip(null); };
    el.addEventListener("pointerover", show); el.addEventListener("focusin", show); el.addEventListener("pointerout", hide); el.addEventListener("focusout", hide); el.addEventListener("pointerdown", hide); el.addEventListener("keydown", esc);
    return () => { el.removeEventListener("pointerover", show); el.removeEventListener("focusin", show); el.removeEventListener("pointerout", hide); el.removeEventListener("focusout", hide); el.removeEventListener("pointerdown", hide); el.removeEventListener("keydown", esc); };
  }, [root]);
  useLayoutEffect(() => { if (!tip || !box.current) return; const b = box.current.getBoundingClientRect(); setAt(placeTip(tip.rect, { w: b.width, h: b.height }, { w: innerWidth, h: innerHeight })); }, [tip]);
  if (!tip || !root.current) return null;
  return createPortal(<div ref={box} className="oi-tip" role="tooltip" style={{ left: at?.x ?? 0, top: at?.y ?? 0, visibility: at ? "visible" : "hidden" }}>{tip.text}{tip.key && <kbd>{tip.key}</kbd>}</div>, root.current);
}
export const factoryTipStyles = `
.oi-tip{position:fixed;z-index:90;max-width:320px;padding:6px 9px;border:1px solid var(--oi-border-strong,var(--oi-border));border-radius:8px;background:var(--oi-panel);color:var(--oi-text);font:12px/1.35 system-ui,sans-serif;box-shadow:var(--oi-shadow-raised,0 6px 18px var(--oi-shadow));pointer-events:none}
.oi-tip kbd{margin-left:8px;padding:0 5px;border:1px solid var(--oi-border);border-radius:4px;font:600 11px ui-monospace,monospace;color:var(--oi-tone-muted)}
.oi-tb-l{display:none}
@media (min-width:1200px){.oi-tb-l{display:inline;margin-left:5px;font:600 11px ui-monospace,monospace;letter-spacing:.03em}}
`;
