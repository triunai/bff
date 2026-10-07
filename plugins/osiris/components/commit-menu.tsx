import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { demoDisable, menuKeyStep, visibleItems, type MenuEntry, type MenuItem } from "../commit-actions.ts";
import { DEMO_OFF, useDemoOn } from "../demo/client.ts";
import { cleanText } from "../work/sanitize.ts";

/** Commit right-click menu (td-osi.14). Renders a MenuEntry[] from commit-actions.ts; it decides nothing: an enabled item hands its
 * action to `onRun`, a disabled item shows its reason and does nothing. Esc closes, arrows move, Enter/Space run, Right/Left
 * open/close the Copy Ref submenu, a pointer press outside closes. Every string shown is plain text (no HTML). */
export function CommitMenu(p: { x: number; y: number; entries: MenuEntry[]; onRun(item: MenuItem): void; onClose(): void }) {
  const [expanded, setExpanded] = useState<string | null>(null), [at, setAt] = useState(0), [pos, setPos] = useState({ x: p.x, y: p.y });
  const box = useRef<HTMLDivElement>(null), refs = useRef<(HTMLButtonElement | null)[]>([]);
  const demo = useDemoOn(), entries = demo ? demoDisable(p.entries, DEMO_OFF) : p.entries;
  const rows = visibleItems(entries, expanded);
  // Keep the menu on screen: measured once it exists, clamped to the viewport.
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.max(4, Math.min(p.x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(p.y, window.innerHeight - r.height - 4)) });
  }, [p.x, p.y, expanded]);
  useEffect(() => { refs.current[at]?.focus(); }, [at, expanded]);
  useEffect(() => {
    const away = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) p.onClose(); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [p.onClose]);
  const activate = (it: MenuItem) => {
    if (!it.enabled) return; // a disabled item states its reason; it never runs
    if (it.submenu) { setExpanded(e => (e === it.id ? null : it.id)); return; }
    p.onRun(it);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const r = menuKeyStep(rows.length, at, e.key);
    if (!r) return;
    e.preventDefault(); e.stopPropagation();
    const cur = rows[at];
    if (r.kind === "focus") setAt(r.index);
    else if (r.kind === "close") p.onClose();
    else if (r.kind === "activate" && cur) activate(cur);
    else if (r.kind === "open" && cur?.submenu && cur.enabled) { setExpanded(cur.id); setAt(at + 1); }
    else if (r.kind === "back" && expanded) { const parent = rows.findIndex(i => i.id === expanded); setExpanded(null); setAt(Math.max(0, parent)); }
  };
  let idx = -1;
  return <div ref={box} className="oi-cm" role="menu" aria-label="Commit actions" style={{ left: pos.x, top: pos.y }} onKeyDown={onKey}>
    {entries.map((e, k) => {
      if (e.type === "separator") return <hr key={`s${k}`} className="oi-cm-sep" />;
      const group = visibleItems([e], expanded);
      return group.map(it => {
        idx++; const i = idx, child = it.id.includes(":");
        return <button key={it.id} ref={el => { refs.current[i] = el; }} type="button" role="menuitem" tabIndex={i === at ? 0 : -1}
          className={`oi-cm-item${child ? " sub" : ""}${it.enabled ? "" : " off"}`} aria-disabled={!it.enabled} aria-haspopup={it.submenu ? "menu" : undefined} aria-expanded={it.submenu ? expanded === it.id : undefined}
          title={it.enabled ? undefined : it.reason} onClick={() => activate(it)} onMouseEnter={() => setAt(i)}>
          <span className="oi-cm-label">{cleanText(it.label)}{it.submenu ? " ›" : ""}</span>
          {it.shortcut && <span className="oi-cm-key">{it.shortcut}</span>}
          {!it.enabled && it.reason && <span className="oi-cm-why">{cleanText(it.reason)}</span>}
        </button>;
      });
    })}
  </div>;
}

export const commitMenuStyles = `
.oi-cm{position:fixed;z-index:60;min-width:220px;max-width:340px;padding:4px 0;color:var(--oi-text);background:var(--oi-raised);border:1px solid var(--oi-border);box-shadow:0 6px 18px var(--oi-shadow);font-size:12px}
.oi-cm-item{display:grid;grid-template-columns:1fr auto;gap:0 16px;align-items:baseline;width:100%;padding:3px 12px;text-align:left;font:inherit;color:inherit;background:transparent;border:0;cursor:pointer}
.oi-cm-item:hover:not(.off),.oi-cm-item:focus-visible:not(.off){background:var(--oi-selected);outline:none}
.oi-cm-item:focus-visible{outline:1px solid var(--oi-tone-info);outline-offset:-1px}
.oi-cm-item.sub{padding-left:26px;font-family:ui-monospace,monospace}
.oi-cm-item.off{color:var(--oi-tone-muted);cursor:not-allowed}
.oi-cm-key{color:var(--oi-tone-muted)}
.oi-cm-why{grid-column:1 / -1;font-size:10px;color:var(--oi-tone-muted)}
.oi-cm-sep{margin:3px 0;border:0;border-top:1px solid var(--oi-border)}
`;
