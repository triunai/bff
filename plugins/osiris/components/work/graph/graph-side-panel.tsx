import { useMemo, type ReactNode } from "react";
import type { WorkSurfaceSnapshot } from "../../../work/surface-types.ts";
import { boardCards, plainTitle, shortId, sidebarRows } from "../../../work/surface-model.ts";

/** Right-hand lists for the GRAPH tab, in plain English. Rows are buttons that select a bead (no nested buttons, no actions). */
export function GraphSidePanel({ snap, now, onSelect }: { snap: WorkSurfaceSnapshot; now: number; onSelect(id: string): void }) {
  const { open, claimed, agents } = useMemo(() => {
    const cards = boardCards(snap, now);
    const claimed = snap.issues.filter(i => i.assignee && (i.status === "open" || i.status === "in_progress")).sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));
    const seen = new Set<string>();
    const agents = sidebarRows(snap, now).filter(r => r.pane && !seen.has(r.id) && seen.add(r.id));
    return { open: cards.filter(c => c.workLane === "ready" && !c.assignee), claimed, agents };
  }, [snap, now]);
  const row = (id: string, title: string, sub: string | null, full = title) => <li key={id}><button type="button" className="oi-wgp-row" title={full} onClick={() => onSelect(id)}><span className="oi-wgp-id">{shortId(id)}</span><span className="oi-wgp-t">{title}</span>{sub && <span className="oi-wgp-sub">{sub}</span>}</button></li>;
  const list = (items: ReactNode[], empty: string) => items.length ? <ul>{items}</ul> : <p className="oi-wgp-empty">{empty}</p>;
  return <aside className="oi-wgp" aria-label="Who is working on what">
    <section><h3>Ready, nobody on it ({open.length})</h3><p className="oi-wgp-hint">Nothing is stopping these. Nobody has taken them yet.</p>
      {list(open.map(c => row(c.id, c.title, `P${c.priority}`)), "Nothing is ready and unclaimed.")}</section>
    <section><h3>Claimed ({claimed.length})</h3><p className="oi-wgp-hint">Someone has taken these and they are not finished.</p>
      {list(claimed.map(i => row(i.id, plainTitle(i.title), `taken by ${i.assignee}`, i.title)), "Nothing is claimed right now.")}</section>
    <section><h3>Agents working now ({agents.length})</h3><p className="oi-wgp-hint">Work that has a live agent window attached.</p>
      {list(agents.map(r => row(r.id, r.title, `in ${r.pane}${r.warn ? ` · ${r.warn}` : ""}`, r.fullTitle)), "No agent is working on anything right now.")}</section>
  </aside>;
}
