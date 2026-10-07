import { useState, type ReactNode } from "react";

/** FULL calendar: a compact strip that expands to the SHARED git graph (the host passes the WorkGraph element; this file draws no graph of its own). */
export function CalendarGraphStrip({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <section className="mk-gstrip" aria-label="Git graph for the selected days">
    <button type="button" className="mk-gstrip-h" aria-expanded={open} onClick={() => setOpen(o => !o)}><span aria-hidden="true">{open ? "▾" : "▸"}</span> Git graph · {label} · <b>{count}</b> {count === 1 ? "commit" : "commits"}</button>
    {open && <div className="mk-gstrip-b">{children}</div>}
  </section>;
}

export const calendarGraphStripStyles = `
.mk-gstrip{margin-top:12px;border:1px solid var(--oi-border)}
.mk-gstrip-h{width:100%;text-align:left;padding:6px 10px;background:transparent;border:0;cursor:pointer;color:var(--oi-tone-muted);font:11px var(--oi-font-mono)}.mk-gstrip-h:hover{background:var(--oi-hover);color:var(--oi-text)}
.mk-gstrip-b{height:360px;display:flex;flex-direction:column;border-top:1px solid var(--oi-border);overflow:hidden}
`;
