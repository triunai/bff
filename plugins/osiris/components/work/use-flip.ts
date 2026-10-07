import { useLayoutEffect, useRef, type RefObject } from "react";
import { FLIP_MS, planFlip, prefersReducedMotion, type Pt } from "../../work/flip.ts";

/** After every render, slide each `[data-flip-id]` card from its previous position to its new one (Web Animations API, ~200 ms, transform/opacity only). */
export function useFlip(root: RefObject<HTMLElement | null>, deps: readonly unknown[]): void {
  const prev = useRef<Map<string, Pt>>(new Map());
  useLayoutEffect(() => {
    const el = root.current; if (!el) return;
    const els = new Map<string, HTMLElement>(); const next = new Map<string, Pt>();
    el.querySelectorAll<HTMLElement>("[data-flip-id]").forEach(n => { const id = n.dataset.flipId!; const r = n.getBoundingClientRect(); els.set(id, n); next.set(id, { x: r.left, y: r.top }); });
    for (const s of planFlip(prev.current, next, prefersReducedMotion())) {
      const n = els.get(s.id); if (!n || typeof n.animate !== "function") continue;
      n.animate(s.kind === "move" ? [{ transform: `translate(${s.dx}px,${s.dy}px)` }, { transform: "none" }] : [{ opacity: 0 }, { opacity: 1 }], { duration: FLIP_MS, easing: "ease-out" });
    }
    prev.current = next;
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}
