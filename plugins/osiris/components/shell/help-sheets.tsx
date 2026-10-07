import { useEffect } from "react";
import { shortcutRows } from "../../shell/shortcut-sheet.ts";
import { GLOSSARY, TAB_GUIDE } from "../../shell/help-content.ts";

// Two small modal sheets: Keyboard Shortcuts (generated from KEYMAP) and Help (glossary + what each tab is for). Esc or the × closes.
function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }; document.addEventListener("keydown", k, true); return () => document.removeEventListener("keydown", k, true); }, [onClose]);
  return <div className="oi-sheet-back" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="oi-sheet" role="dialog" aria-modal="true" aria-label={label}><button type="button" className="oi-sheet-x" aria-label={`Close ${label}`} onClick={onClose}>×</button><h2>{label}</h2>{children}</div>
  </div>;
}

export function ShortcutSheet({ isMac, onClose }: { isMac: boolean; onClose: () => void }) {
  return <Sheet label="Keyboard shortcuts" onClose={onClose}>
    <table className="oi-sheet-keys"><tbody>{shortcutRows(isMac).map(r => <tr key={r.command}><td><kbd>{r.keys}</kbd></td><td>{r.label}</td></tr>)}</tbody></table>
  </Sheet>;
}

export function HelpPanel({ onClose, onShortcuts }: { onClose: () => void; onShortcuts: () => void }) {
  return <Sheet label="Help" onClose={onClose}>
    <h3>What each tab is for</h3>
    <dl>{TAB_GUIDE.map(t => <div key={t.tab}><dt>{t.tab}</dt><dd>{t.purpose}</dd></div>)}</dl>
    <h3>Words you will see</h3>
    <dl>{GLOSSARY.map(g => <div key={g.term}><dt>{g.term}</dt><dd>{g.meaning}</dd></div>)}</dl>
    <p><button type="button" className="oi-sheet-link" onClick={onShortcuts}>Keyboard shortcuts</button></p>
  </Sheet>;
}

export const helpSheetStyles = `
.oi-sheet-back{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--oi-bg) 55%,transparent)}
.oi-sheet{position:relative;max-width:520px;width:calc(100% - 24px);max-height:80vh;overflow:auto;padding:14px 18px;border:1px solid var(--oi-border-strong,var(--oi-border));border-radius:8px;background:var(--oi-panel,var(--oi-bg));color:var(--oi-text);font-size:12px}
.oi-sheet h2{margin:0 0 8px;font-size:14px}.oi-sheet h3{margin:12px 0 4px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--oi-muted)}
.oi-sheet-x{position:absolute;top:6px;right:8px;border:0;background:transparent;color:var(--oi-muted);font-size:16px;cursor:pointer}
.oi-sheet dl{margin:0;display:grid;gap:6px}.oi-sheet dt{font-weight:600}.oi-sheet dd{margin:0;color:var(--oi-muted)}
.oi-sheet-keys{border-collapse:collapse;width:100%}.oi-sheet-keys td{padding:3px 6px}.oi-sheet-keys td:first-child{white-space:nowrap;width:1%}
.oi-sheet kbd{font:inherit;padding:1px 6px;border:1px solid var(--oi-border);border-radius:4px}
.oi-sheet-link{border:0;background:transparent;color:var(--oi-accent);cursor:pointer;font:inherit;padding:0}
.oi-sheet button:focus-visible{outline:1px solid var(--oi-focus,var(--oi-accent));outline-offset:1px}
`;
