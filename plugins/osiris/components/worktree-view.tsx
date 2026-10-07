import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { FileDiff, GitResult, GitStatus } from "../git-types.ts";
import { DiffView } from "./commit-inspector.tsx";
import { AREA_LABEL, flatRows, moveIndex, rowCounts, worktreeGroups, type WorktreeArea, type WorktreeRow, type WorktreeStats } from "../worktree-model.ts";
import { diffStatsLabel } from "../git-ui.ts";

export type HistoryTab = "commits" | "worktree";

/** Port of the mockup's tab strip for History (state 7): Commits | Working tree, the branch with ↑ahead ↓behind at the end. */
export function HistoryTabs({ tab, onTab, status }: { tab: HistoryTab; onTab(t: HistoryTab): void; status: GitStatus | null }) {
  const arrows = status ? `${status.branch ?? "(detached)"}${status.ahead !== null ? ` ↑${status.ahead}` : ""}${status.behind !== null ? ` ↓${status.behind}` : ""}` : "";
  return <div className="mk-ctabs" role="tablist" aria-label="History view">
    {([["commits", "Commits"], ["worktree", "Working tree"]] as const).map(([id, label]) => <button key={id} type="button" role="tab" className="mk-ct" aria-selected={tab === id} onClick={() => onTab(id)}>{label}</button>)}
    <span className="mk-end">{arrows && <span className="mk-note">{arrows}</span>}</span>
  </div>;
}

type DiffState = { state: "idle" } | { state: "loading" } | { state: "ok"; diff: FileDiff } | { state: "error"; reason: string };

/** History > Working tree: the file list on the left, the SAME DiffView the commit inspector uses on the right. Read-only. */
export function WorktreeView({ status, stats, loadDiff, busy, error }: {
  status: GitStatus | null; stats: WorktreeStats | null; busy: boolean; error: string | null;
  loadDiff(path: string, area: WorktreeArea): Promise<GitResult<FileDiff>>;
}) {
  const groups = useMemo(() => worktreeGroups(status?.entries ?? [], stats), [status, stats]);
  const rows = useMemo(() => flatRows(groups), [groups]);
  const [cursor, setCursor] = useState<string | null>(null), [open, setOpen] = useState<string | null>(null), [layout, setLayout] = useState<"unified" | "split">("unified");
  const [dv, setDv] = useState<DiffState>({ state: "idle" });
  const list = useRef<HTMLDivElement>(null);
  // The open row defaults to the first one (as the mockup shows) and falls back when the file leaves the list after a refresh.
  const openRow: WorktreeRow | undefined = rows.find(r => r.key === open) ?? rows[0];
  const cur = rows.find(r => r.key === cursor) ?? openRow;
  useEffect(() => {
    if (!openRow) { setDv({ state: "idle" }); return; }
    let off = false;
    setDv({ state: "loading" });
    loadDiff(openRow.path, openRow.area).then(
      r => { if (!off) setDv(r.ok ? { state: "ok", diff: r.value } : { state: "error", reason: r.reason }); },
      e => { if (!off) setDv({ state: "error", reason: e instanceof Error ? e.message : String(e) }); },
    );
    return () => { off = true; };
  }, [openRow?.key, stats, status]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Enter" && cur) { e.preventDefault(); setOpen(cur.key); return; }
    const n = moveIndex(e.key, rows.findIndex(r => r.key === cur?.key), rows.length);
    if (n === null) return;
    e.preventDefault(); setCursor(rows[n].key);
    list.current?.querySelector<HTMLElement>(`[data-k="${CSS.escape(rows[n].key)}"]`)?.scrollIntoView({ block: "nearest" });
  };
  if (error) return <div className="mk-cbody"><p className="mk-note err" role="alert">{error}</p></div>;
  if (!status) return <div className="mk-cbody"><p className="mk-note">{busy ? "Reading the working tree…" : "No repository selected."}</p></div>;
  const counts = openRow && dv.state === "ok" && dv.diff.kind === "text" && dv.diff.hunks.length > 0 ? diffStatsLabel(dv.diff).split(" ") : [];
  return <div className="mk-cbody" style={{ overflow: "hidden" }}><div className="mk-wt">
    <div className="mk-wtl" ref={list} tabIndex={0} role="listbox" aria-label="Changed files" aria-activedescendant={cur ? `wt-${cur.key}` : undefined} onKeyDown={onKey}>
      {groups.map(g => <div key={g.area}>
        <div className="mk-eyebrow">{g.label} <b>{g.rows.length}</b></div>
        {g.rows.map(r => <div key={r.key} id={`wt-${r.key}`} data-k={r.key} role="option" aria-selected={r.key === openRow?.key} className={`mk-wf${r.key === cur?.key ? " sel" : ""}`} title={r.origPath ? `${r.origPath} → ${r.path}` : r.path} onClick={() => { setCursor(r.key); setOpen(r.key); }}>
          <span style={{ color: r.letter === "A" || r.letter === "?" ? "var(--oi-tone-success)" : "var(--oi-tone-attention)", fontWeight: 700 }}>{r.letter}</span><span className="p">{r.path}</span><span className="st">{rowCounts(r)}</span>
        </div>)}
      </div>)}
      {rows.length === 0 && <p className="mk-note">No uncommitted changes.</p>}
      <p className="mk-note" style={{ marginTop: 12 }}>j / k move · Enter opens · the same diff viewer as a commit</p>
    </div>
    <div className="mk-diff">
      {openRow ? <>
        <div className="mk-dh"><b>{openRow.path}</b><span className="mk-chip" style={{ ["--c" as string]: "var(--oi-tone-info)" }}>{openRow.area}</span>
          {counts.map((c, i) => <span key={i} className={c.startsWith("+") ? "c-ok" : "c-fail"}>{c}</span>)}<span style={{ flex: 1 }} />
          <button type="button" className="mk-tbtn" title="Switch between unified and side-by-side" onClick={() => setLayout(l => l === "unified" ? "split" : "unified")}>{layout === "unified" ? "Unified" : "Split"} ▾</button></div>
        {dv.state === "ok" ? <DiffView diff={dv.diff} layout={layout} hideHead />
          : dv.state === "error" ? <p className="mk-note err" role="alert">{dv.reason}</p>
          : <p className="mk-note">Loading diff…</p>}
      </> : <p className="mk-note">{AREA_LABEL.staged}, {AREA_LABEL.unstaged.toLowerCase()} and {AREA_LABEL.untracked.toLowerCase()} files open here.</p>}
    </div>
  </div></div>;
}

/** Values ported from the mockup (.ctabs .ct .wt .wtl .wf .diff .dh .eyebrow .chip .tbtn) onto the theme's --oi-* tokens. */
export const worktreeViewStyles = `
.mk-ctabs{display:flex;align-items:center;gap:2px;height:36px;padding:0 10px;border-bottom:1px solid var(--oi-border-strong);flex:none}
.mk-ct{height:36px;padding:0 10px;font-size:12.5px;color:var(--oi-tone-muted);background:transparent;border:0;cursor:pointer}
.mk-ct:hover{color:var(--oi-text)}.mk-ct[aria-selected="true"]{color:var(--oi-text);box-shadow:var(--oi-tab-underline)}
.mk-ct:focus-visible{outline:1px solid var(--oi-focus);outline-offset:-1px}
.mk-end{margin-left:auto;display:flex;gap:6px;align-items:center}
.mk-note{font:11px var(--oi-font-mono);color:var(--oi-tone-muted)}.mk-note.err{color:var(--oi-tone-failure)}
.mk-cbody{flex:1;min-height:0;overflow:auto;padding:14px 16px}
.mk-wt{display:grid;grid-template-columns:300px minmax(0,1fr);height:100%;min-height:0}
.mk-wtl{border-right:1px solid var(--oi-border);overflow:auto;padding-right:8px;outline:0}
.mk-wtl:focus-visible{box-shadow:inset 0 0 0 1px var(--oi-focus)}
.mk-eyebrow{display:flex;align-items:center;gap:8px;margin:10px 0 4px;font:600 10px var(--oi-font-head);letter-spacing:.09em;text-transform:uppercase;color:var(--oi-tone-muted)}
.mk-wtl>div:first-child .mk-eyebrow{margin-top:0}
.mk-eyebrow b{color:var(--oi-accent);text-shadow:var(--oi-glow)}
.mk-wf{display:flex;gap:8px;align-items:center;height:24px;padding:0 6px;border-radius:3px;font:12px var(--oi-font-mono);cursor:pointer;min-width:0}
.mk-wf:hover{background:var(--oi-hover)}.mk-wf.sel{background:var(--oi-selected);box-shadow:inset 2px 0 0 var(--oi-accent)}
.mk-wf .p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.mk-wf .st{font-size:10.5px;color:var(--oi-tone-muted)}
.mk-diff{overflow:auto;min-width:0;padding-left:12px}
.mk-diff .oi-df{margin:0;padding:0;border:0}.mk-diff .oi-df-scroll{overflow-x:auto}
.mk-dh{display:flex;gap:10px;align-items:baseline;margin-bottom:8px;font:12px var(--oi-font-mono)}
.mk-dh .c-ok{color:var(--oi-tone-success)}.mk-dh .c-fail{color:var(--oi-tone-failure)}
.mk-chip{display:inline-flex;align-items:center;gap:4px;padding:0 6px;border-radius:9px;font:600 10.5px/17px var(--oi-font-mono);white-space:nowrap;background:color-mix(in srgb,var(--c,var(--oi-tone-muted)) 16%,transparent);color:var(--c,var(--oi-text-2))}
.mk-tbtn{font:11px var(--oi-font-mono);color:var(--oi-tone-muted);padding:4px 8px;border-radius:6px;background:transparent;border:0;cursor:pointer}
.mk-tbtn:hover{background:var(--oi-hover);color:var(--oi-text)}
@media (max-width:900px){.mk-wt{grid-template-columns:minmax(0,1fr)}}
`;
