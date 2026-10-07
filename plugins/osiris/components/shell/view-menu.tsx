// The ONE Osiris menu, anchored at the logo (owner 19:21). Rows are plain buttons inside a role=menu container (never a
// button inside a button); a submenu header is a button with aria-expanded and its choices render as a sibling group.
import { useEffect, useRef, useState } from "react";
import type { Layout, LayoutAction } from "../../shell/layout-types.ts";
import { formatChord } from "../../shell/keymap.ts";
import type { ViewItem } from "../../shell/view-items.ts";

export type ViewMenuProps = { layout: Layout; items: ViewItem[]; onAction: (a: LayoutAction) => void; onCommand: (id: string) => void; onClose: () => void; anchor: { left: number; top: number }; /** A submenu to show open at once (the header's Theme button opens it on "theme"). */ initialOpen?: string };
const isMac = () => { try { return /mac|iphone|ipad/i.test(navigator.platform); } catch { return false; } };

export function ViewMenu({ layout, items, onAction, onCommand, onClose, anchor, initialOpen }: ViewMenuProps) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<string | null>(initialOpen ?? null);
  const mac = isMac();
  const rows = () => Array.from(root.current?.querySelectorAll<HTMLButtonElement>("button[role^='menuitem']:not(:disabled)") ?? []);
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    rows()[0]?.focus();
    // The logo that opened the menu is not "outside": its own click toggles the menu shut (otherwise this closes it and the click reopens it).
    const away = (e: PointerEvent) => { if ((e.target as Element | null)?.closest?.(".oi-slim-logo, .oi-slim-ghost")) return; if (root.current && !root.current.contains(e.target as Node)) onClose(); };
    document.addEventListener("pointerdown", away, true);
    return () => { document.removeEventListener("pointerdown", away, true); returnTo?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const select = (item: ViewItem) => {
    if (item.submenu) { setOpen(o => o === item.id ? null : item.id); return; }
    if (item.disabled || item.onSelect === undefined) return;
    if (typeof item.onSelect === "string") onCommand(item.onSelect); else onAction(item.onSelect);
    onClose();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    const list = rows(); const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus(); };
    if (e.key === "ArrowDown") go(i + 1); else if (e.key === "ArrowUp") go(i - 1); else if (e.key === "Home") go(0); else if (e.key === "End") go(list.length - 1);
    else if (e.key === "ArrowRight" && document.activeElement?.getAttribute("aria-haspopup") === "menu" && document.activeElement.getAttribute("aria-expanded") !== "true") { e.preventDefault(); (document.activeElement as HTMLButtonElement).click(); }
    else if (e.key === "ArrowLeft" && open) { e.preventDefault(); const id = open; setOpen(null); requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(`[data-item="${id}"]`)?.focus()); }
    else if (e.key === "Tab") { e.preventDefault(); onClose(); }
  };
  const row = (item: ViewItem, nested: boolean) => {
    if (item.kind === "separator") return <hr key={item.id} className="oi-vm-sep" />;
    if (item.kind === "note") return <p key={item.id} className="oi-vm-note">{item.label}</p>;
    const isSub = !!item.submenu; const check = item.checked !== undefined;
    const role = isSub ? "menuitem" : check ? "menuitemcheckbox" : "menuitem";
    return <div key={item.id} className="oi-vm-block">
      <button type="button" role={role} data-item={item.id} aria-checked={isSub || !check ? undefined : !!item.checked} aria-haspopup={isSub ? "menu" : undefined} aria-expanded={isSub ? open === item.id : undefined} disabled={item.disabled} className={`oi-vm-row${nested ? " oi-vm-nested" : ""}`} onClick={() => select(item)}>
        <span className="oi-vm-mark" aria-hidden="true">{check ? (item.checked ? "✓" : "") : ""}</span>
        <span className="oi-vm-label">{item.label}</span>
        {item.hint && <span className="oi-vm-hint">{item.hint}</span>}
        {item.shortcut && <kbd className="oi-vm-kbd">{formatChord(item.shortcut, mac)}</kbd>}
        {isSub && <span className="oi-vm-caret" aria-hidden="true">{open === item.id ? "▾" : "▸"}</span>}
      </button>
      {isSub && open === item.id && <div role="group" aria-label={item.label}>{item.submenu!.map(s => row(s, true))}</div>}
    </div>;
  };
  return <div ref={root} role="menu" aria-label="Osiris menu" className="oi-view-menu-pop" style={{ left: anchor.left, top: anchor.top }} data-layout-version={layout.version} onKeyDown={onKey}>{items.map(i => row(i, false))}</div>;
}

export const viewMenuStyles = `
.oi-view-menu-pop{position:fixed;z-index:60;min-width:236px;max-width:min(320px,calc(100vw - 16px));max-height:calc(100vh - 40px);overflow:auto;background:var(--oi-raised);color:var(--oi-text);border:1px solid var(--oi-border-strong);border-radius:6px;box-shadow:var(--oi-shadow-raised);padding:3px;font-size:11px}
.oi-vm-row{display:flex;align-items:center;gap:6px;width:100%;min-height:24px;padding:3px 8px 3px 4px;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.oi-vm-row:hover:not(:disabled),.oi-vm-row:focus-visible{background:var(--oi-selected);outline:none}
.oi-vm-row:focus-visible{box-shadow:inset 0 0 0 1px var(--oi-accent)}
.oi-vm-row:disabled{color:var(--oi-muted);cursor:default}
.oi-vm-nested{padding-left:20px}
.oi-vm-mark{width:14px;flex:none;text-align:center;color:var(--oi-accent)}
.oi-vm-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-vm-hint{color:var(--oi-muted);font-variant-numeric:tabular-nums}
.oi-vm-kbd{margin-left:auto;padding-left:14px;color:var(--oi-muted);font:inherit;font-size:10px;white-space:nowrap;text-align:right}
.oi-vm-caret{color:var(--oi-muted);margin-left:4px}
.oi-vm-sep{border:0;border-top:1px solid var(--oi-border);margin:3px 2px}
.oi-vm-note{margin:4px 8px;color:var(--oi-muted);font-size:10px;line-height:1.35}
`;
