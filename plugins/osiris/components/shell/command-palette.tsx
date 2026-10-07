// ⌘K overlay. Search mode only HOSTS the existing search input: value / onChange / onSubmit come from the caller, which keeps
// every semantic it has today (Projects targeting, Trace switch, filters). Open View mode lists registered panels.
import { useEffect, useMemo, useRef, useState } from "react";
import { CMD, chordFor, formatChord } from "../../shell/keymap.ts";

const isMac = () => { try { return /mac|iphone|ipad/i.test(navigator.platform); } catch { return false; } };

export type PaletteSearch = { value: string; onChange: (value: string) => void; onSubmit: (value: string) => void; placeholder?: string; title?: string; ariaLabel?: string };
export type CommandPaletteProps =
  | { mode: "search"; onClose: () => void; search: PaletteSearch; children?: React.ReactNode }
  | { mode: "openView"; onClose: () => void; panels: { id: string; title: string }[]; onOpen: (id: string) => void };

export function CommandPalette(props: CommandPaletteProps) {
  const input = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState("");
  const [index, setIndex] = useState(0);
  const panels = props.mode === "openView" ? props.panels : null;
  const shown = useMemo(() => (panels ?? []).filter(p => p.title.toLowerCase().includes(filter.trim().toLowerCase())), [panels, filter]);
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null; // focus goes back to where the palette came from
    input.current?.focus(); input.current?.select();
    return () => { returnTo?.focus?.(); };
  }, []);
  useEffect(() => { setIndex(0); }, [filter, props.mode]);
  const close = props.onClose;
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (props.mode === "openView") {
      if (e.key === "ArrowDown") { e.preventDefault(); setIndex(i => shown.length ? (i + 1) % shown.length : 0); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setIndex(i => shown.length ? (i + shown.length - 1) % shown.length : 0); }
      else if (e.key === "Enter" && shown[index]) { e.preventDefault(); props.onOpen(shown[index].id); close(); }
    } else if (e.key === "Enter") { e.preventDefault(); props.search.onSubmit(props.search.value); close(); }
  };
  const search = props.mode === "search" ? props.search : null;
  const chord = chordFor(props.mode === "search" ? CMD.search : CMD.openView);
  const openerChord = chord ? formatChord(chord, isMac()) : "";
  return <div className="oi-pal-scrim" onPointerDown={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="oi-pal" role="dialog" aria-modal="true" aria-label={props.mode === "search" ? "Search" : "Open view"} onKeyDown={onKey}>
      <div className="oi-pal-head"><span>{props.mode === "search" ? "Search" : "Open view"}</span>{openerChord && <kbd title="Shortcut that opens this">{openerChord}</kbd>}</div>
      <div className="oi-pal-field"><span aria-hidden="true">{props.mode === "search" ? "⌕" : "▤"}</span>
        <input ref={input} role={props.mode === "openView" ? "combobox" : undefined} aria-expanded={props.mode === "openView" ? true : undefined} aria-controls={props.mode === "openView" ? "oi-pal-list" : undefined} aria-activedescendant={props.mode === "openView" && shown[index] ? `oi-pal-opt-${shown[index].id}` : undefined}
          aria-label={search ? search.ariaLabel ?? "Search recorded calls" : "Filter views"} title={search?.title}
          placeholder={search ? search.placeholder ?? "Search calls" : "Open view…"}
          value={search ? search.value : filter} onChange={e => (search ? search.onChange(e.target.value) : setFilter(e.target.value))} />
        <kbd>Esc</kbd></div>
      {props.mode === "openView" && <ul id="oi-pal-list" className="oi-pal-list" role="listbox" aria-label="Views">
        {shown.map((p, i) => <li key={p.id} id={`oi-pal-opt-${p.id}`} role="option" aria-selected={i === index} className={i === index ? "oi-pal-on" : ""} onPointerMove={() => setIndex(i)} onClick={() => { props.onOpen(p.id); close(); }}>{p.title}</li>)}
        {!shown.length && <li className="oi-pal-empty" role="presentation">No matching views</li>}
      </ul>}
      {props.mode === "search" && props.children}
    </div>
  </div>;
}

export const commandPaletteStyles = `
.oi-pal-scrim{position:fixed;inset:0;z-index:70;background:var(--oi-scrim);display:flex;justify-content:center;align-items:flex-start;padding:12vh 8px 0}
.oi-pal{width:min(480px,100%);background:var(--oi-raised);color:var(--oi-text);border:1px solid var(--oi-border-strong);border-radius:8px;box-shadow:var(--oi-shadow-raised);overflow:hidden;font-size:12px}
.oi-pal-head{display:flex;justify-content:space-between;align-items:center;padding:6px 10px 0;color:var(--oi-muted);font-size:10px}
.oi-pal-head kbd{font:inherit}
.oi-pal-field{display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--oi-border)}
.oi-pal-field input{flex:1;min-width:0;background:transparent;border:0;outline:none;color:inherit;font:inherit}
.oi-pal-field:focus-within{box-shadow:inset 0 -1px 0 var(--oi-accent)}
.oi-pal-field kbd{color:var(--oi-muted);font:inherit;font-size:10px}
.oi-pal-list{list-style:none;margin:0;padding:3px;max-height:40vh;overflow:auto}
.oi-pal-list li{padding:5px 8px;border-radius:4px;cursor:pointer}
.oi-pal-list li.oi-pal-on{background:var(--oi-selected)}
.oi-pal-list li.oi-pal-empty{color:var(--oi-muted);cursor:default}
`;
