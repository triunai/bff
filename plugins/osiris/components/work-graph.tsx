import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { GitCommit, GitGraph, GitRef, GitRepo, GitResult, GitScope, LaneRow } from "../git-types.ts";
import { legendItems } from "../day-ui.ts";
import { GRAPH_ROW_H, GRAPH_GUTTER_BUDGET, fullDate, laneColorCss, lanePitch, chipKind, commitMatches, conventional, loadedLabel, nearTail, visibleWindow, conventionalTone, dirtyLabel, latestLocalTip, mergeMarker, relativeAge, shortSha, sortChips, subjectSegments } from "../git-ui.ts";
import { commitMenu, runAction, type MenuItem } from "../commit-actions.ts";
import { capLanes, LANE_CAP } from "../git-graph.ts";
import { laneIdentity } from "../git-lane-identity.ts";
import { cleanText } from "../work/sanitize.ts";
import { copyWithToast } from "../work/copy-toast.ts";
import { CommitMenu, commitMenuStyles } from "./commit-menu.tsx";
import { GitWriteDialog, gitWriteDialogStyles, type GitDialogAction } from "./git-write-dialog.tsx";

const ROW_H = GRAPH_ROW_H, MAX_CHIPS = 4;
const laneVar = laneColorCss;

/** Subject text with W-NNN mentions as link buttons. Shared by the Changes list and the Inspector. */
export function SubjectText({ text, onThread }: { text: string; onThread(id: string): void }): ReactNode {
  return <>{subjectSegments(text).map((s, i) => s.thread
    ? <button key={i} type="button" className="oi-g-link" title={`Open ${s.thread}`} onClick={e => { e.stopPropagation(); onThread(s.thread!); }}>{s.text}</button>
    : <span key={i}>{s.text}</span>)}</>;
}
/** Conventional-commit subject: a `type(scope)` chip (tone by type; breaking = failure tone) then the readable remainder; a non-conventional
 * subject renders whole. The text is untrusted (commit data): cleaned of terminal escapes, rendered as text only. */
export function Subject({ subject, onThread }: { subject: string; onThread(id: string): void }) {
  const text = cleanText(subject), c = conventional(text);
  return <span className="oi-g-subj" title={text}>{c && <span className={`oi-g-tc t-${conventionalTone(c.type, c.breaking)}`}>{c.type}{c.scope ? `(${c.scope})` : ""}{c.breaking ? "!" : ""}</span>}<SubjectText text={c ? c.rest : text} onThread={onThread} /></span>;
}

function Chip({ name, refs, color }: { name: string; refs: GitRef[]; color: number }) {
  const kind = chipKind(name, refs);
  return <span className={`oi-g-chip ${kind}`} style={kind === "local" ? { color: laneVar(color), borderColor: laneVar(color) } : undefined} title={`${kind}: ${cleanText(name)}`}>{cleanText(name)}</span>;
}
function Chips({ names: raw, refs, color, latestLocal }: { names: string[]; refs: GitRef[]; color: number; latestLocal: string | null }) {
  const names = sortChips(raw, refs, latestLocal);
  if (!names.length) return null;
  return <span className="oi-g-chips">{names.slice(0, MAX_CHIPS).map(n => <Chip key={n} name={n} refs={refs} color={color} />)}{names.length > MAX_CHIPS && <span className="oi-g-more" title={names.slice(MAX_CHIPS).join(", ")}>+{names.length - MAX_CHIPS}</span>}</span>;
}

/** Lane gutter for one row: arrivals from the previous row's edges (top half), node, departures (bottom half). */
function Gutter({ row, prev, width, avail }: { row: LaneRow; prev: LaneRow | null; width: number; avail: number }) {
  const pitch = lanePitch(width, avail), laneX = (l: number) => l * pitch + pitch / 2, sw = pitch < 9 ? 1.2 : 1.8, r = Math.min(4.5, pitch / 2);
  const merged = row.edges.some(e => e.kind === "merge"), mid = ROW_H / 2, w = Math.max(width, 1) * pitch;
  return <svg className="oi-g-lanes" width={w} height={ROW_H} viewBox={`0 0 ${w} ${ROW_H}`} aria-hidden="true">
    {/* Top half: lanes arriving from the previous row. A lane that ENDS into this commit ("fork" in layoutGraph) is drawn
        as a curve into the node instead of a straight arrival (review C-1 MED-2). */}
    {prev?.edges.filter(e => e.kind !== "fork" && !row.edges.some(f => f.kind === "fork" && f.from === e.to)).map((e, i) => <line key={`t${i}`} x1={laneX(e.to)} y1={0} x2={laneX(e.to)} y2={mid} stroke={laneVar(e.color)} strokeWidth={sw} />)}
    {row.edges.filter(e => e.kind === "fork").map((e, i) => <path key={`f${i}`} d={`M${laneX(e.from)} 0 C${laneX(e.from)} ${mid * 0.55} ${laneX(e.to)} ${mid * 0.45} ${laneX(e.to)} ${mid}`} fill="none" stroke={laneVar(e.color)} strokeWidth={sw} />)}
    {row.edges.filter(e => e.kind !== "fork").map((e, i) => e.from === e.to
      ? <line key={`b${i}`} x1={laneX(e.from)} y1={mid} x2={laneX(e.to)} y2={ROW_H} stroke={laneVar(e.color)} strokeWidth={sw} />
      : <path key={`b${i}`} d={`M${laneX(e.from)} ${mid} C${laneX(e.from)} ${mid + mid * 0.55} ${laneX(e.to)} ${mid + mid * 0.45} ${laneX(e.to)} ${ROW_H}`} fill="none" stroke={laneVar(e.color)} strokeWidth={sw} />)}
    {merged && <circle cx={laneX(row.lane)} cy={mid} r={r + 1.5} fill="var(--oi-bg)" stroke={laneVar(row.color)} strokeWidth={sw} />}
    <circle cx={laneX(row.lane)} cy={mid} r={r} fill={laneVar(row.color)} stroke={merged ? "none" : "var(--oi-bg)"} strokeWidth={1} />
  </svg>;
}

function RepoTabs({ repos, repo, onRepo, onAddRepo }: Pick<Parameters<typeof WorkGraph>[0], "repos" | "repo" | "onRepo" | "onAddRepo">) {
  const [adding, setAdding] = useState(false), [path, setPath] = useState("");
  const submit = () => { const p = path.trim(); if (p.startsWith("/") && !p.includes("\0")) { onAddRepo(p); setPath(""); setAdding(false); } };
  return <div className="oi-g-tabs" role="tablist">
    {legendItems(repos.map(r => r.name)).map(it => {
      const r = repos[it.index];
      const dirty = dirtyLabel(r.dirty), sel = r.path === repo;
      return <button key={`${it.key}|${r.path}`} type="button" role="tab" aria-selected={sel} className={`oi-g-tab${sel ? " sel" : ""}`} title={`${it.name} · ${r.path}${r.branch ? ` · ${r.branch}` : ""}${dirty ? ` · ${dirty}` : ""}`} onClick={() => onRepo(r.path)}><span className="oi-g-ldot" style={{ background: laneVar(it.color) }} aria-hidden="true" />{it.name}{dirty && <span className="oi-g-dirty" aria-label={dirty}> ●</span>}</button>;
    })}
    {adding
      ? <input className="oi-g-add" autoFocus placeholder="/absolute/path/to/repo" value={path} aria-label="Absolute repository path" onChange={e => setPath(e.target.value)} onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter") submit(); else if (e.key === "Escape") { setAdding(false); setPath(""); } }} onBlur={() => { if (!path.trim()) setAdding(false); }} />
      : <button type="button" className="oi-g-tab plus" title="Add a repository by absolute path" aria-label="Add repository" onClick={() => setAdding(true)}>+</button>}
  </div>;
}

export function WorkGraph(p: { repos: GitRepo[]; repo: string; onRepo(path: string): void; onAddRepo(path: string): void; graph: GitGraph | null; rows: LaneRow[]; busy: boolean; error: string | null; scope: GitScope; onScope(s: GitScope): void; selectedSha: string | null; onSelectCommit(sha: string): void; onThread(id: string): void; onRefresh(): void; /** Request the next older page; the host owns the git read (read-only reader). Omit to keep the single window. */ onLoadMore?(): void }) {
  const { graph } = p, now = Date.now();
  const [compact, setCompact] = useState(false), [scroll, setScroll] = useState({ top: 0, h: 600, w: 0 }), listRef = useRef<HTMLDivElement | null>(null);
  const real = p.rows.reduce((m, r) => Math.max(m, r.width, r.lane + 1, ...r.edges.map(e => Math.max(e.from, e.to) + 1)), 1);
  const [search, setSearch] = useState("");
  const laidOut = compact && real > LANE_CAP ? capLanes(p.rows, LANE_CAP).rows : p.rows;
  const byShaMap = new Map<string, GitCommit>((graph?.commits ?? []).map(c => [c.sha, c]));
  // The search keeps only the matching commits (a bead id, a thread id, or any text); the full list returns when the box is emptied.
  const rows = search.trim() ? laidOut.filter(r => { const c = byShaMap.get(r.sha); return !!c && commitMatches(c, search); }) : laidOut;
  const rpc = useRpc<typeof rpcContract>();
  const [menu, setMenu] = useState<{ x: number; y: number; sha: string; entries: ReturnType<typeof commitMenu> } | null>(null), [note, setNote] = useState<string | null>(null);
  const [gitDialog, setGitDialog] = useState<{ action: GitDialogAction; subject: string } | null>(null);
  const menuRow = useRef<HTMLElement | null>(null), noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadPatch = (sha: string): Promise<GitResult<string>> => rpc.call("gitCommitPatch", { repo: p.repo, sha }) as Promise<GitResult<string>>;
  const say = (t: string) => { setNote(t); if (noteTimer.current) clearTimeout(noteTimer.current); noteTimer.current = setTimeout(() => setNote(null), 2000); };
  const writeText = async (t: string) => { if (!(await copyWithToast(t, 1))) throw new Error("clipboard"); };
  const menuFor = (c: GitCommit) => commitMenu({ sha: c.sha, parents: c.parents, author: c.author, authoredAt: c.authoredAt, subject: c.subject, refs: c.refs }, { now: Date.now(), loadPatch, gitActions: true });
  const openMenu = (c: GitCommit, x: number, y: number, el: HTMLElement) => { menuRow.current = el; p.onSelectCommit(c.sha); setMenu({ x, y, sha: c.sha, entries: menuFor(c) }); };
  const closeMenu = () => { setMenu(null); menuRow.current?.focus(); };
  const runItem = (it: MenuItem) => {
    setMenu(null); menuRow.current?.focus(); if (!it.action) return;
    // The git kinds open the confirm dialog (it owns the rpc calls and the typed confirmation); only clipboard kinds go through runAction.
    if (it.action.kind === "compare-local" || it.action.kind === "save-patch" || it.action.kind === "git-write") { const sha = it.action.sha; setGitDialog({ action: it.action, subject: byShaMap.get(sha)?.subject ?? "" }); return; }
    runAction(it.action, { writeText, loadPatch }).then(r => say(r.ok ? "Copied" : `Not copied: ${r.reason}`), () => say("Not copied: the clipboard is not available"));
  };
  // Seed the measured size once the list exists (it only mounts with a graph), so the first scroll cannot jump the gutter budget.
  useEffect(() => { const el = listRef.current; if (el) setScroll(s0 => ({ ...s0, w: el.clientWidth || s0.w, h: el.clientHeight || s0.h })); }, [!!graph, p.repos.length]);
  const width = compact && real > LANE_CAP ? LANE_CAP : real, avail = scroll.w ? Math.max(240, Math.round(scroll.w * 0.6)) : GRAPH_GUTTER_BUDGET, gutterW = width * lanePitch(width, avail) + 4;
  const win = visibleWindow(scroll.top, scroll.h, rows.length, ROW_H);
  const rowMin = gutterW > 240 ? { minWidth: gutterW + 420 } : undefined; // very wide gutter: the list scrolls sideways instead of squeezing the subject
  const tip = latestLocalTip(graph), tipRow = tip ? rows.find(r => r.sha === tip.sha) : undefined;
  const key = (sha: string) => (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.onSelectCommit(sha); } };
  const seg = (s: GitScope, label: string) => <button type="button" className={`oi-g-seg${p.scope === s ? " on" : ""}`} aria-pressed={p.scope === s} onClick={() => p.onScope(s)}>{label}</button>;
  const lanesBtn = (c: boolean, label: string) => <button type="button" className={`oi-g-seg${compact === c ? " on" : ""}`} aria-pressed={compact === c} onClick={() => setCompact(c)}>{label}</button>;
  return <div className="oi-g">
    <RepoTabs repos={p.repos} repo={p.repo} onRepo={p.onRepo} onAddRepo={p.onAddRepo} />
    {p.repos.length === 0 ? <p className="oi-g-note">No git repositories found under ~/Repos — add one with +</p> : <>
      <div className="oi-g-bar">
        <span className="oi-g-segs" role="group" aria-label="Branch scope">{seg("main", "Main only")}{seg("all", "All branches")}</span>
        <span className="oi-g-segs" role="group" aria-label="Lane display">{lanesBtn(false, "All lanes")}{lanesBtn(true, `Compact (${LANE_CAP})`)}</span>
        <span className="oi-g-meta" title={compact && real > LANE_CAP ? `${real} lanes in this window; lanes beyond ${LANE_CAP} are folded into the last column` : `${real} lane${real === 1 ? "" : "s"} drawn`}>{real} lane{real === 1 ? "" : "s"}{compact && real > LANE_CAP ? ` · showing ${LANE_CAP}` : ""}</span>
        <span className="oi-g-meta">{graph ? loadedLabel(graph.commits.length, graph.truncated && !!p.onLoadMore) : "—"}</span>
        <span className="oi-g-meta" title="Each coloured line is one branch and keeps its colour. The arrow marks a merge commit.">colour = branch · ↩ merge</span>
        {graph?.truncated && !p.onLoadMore && <span className="oi-g-meta warn">truncated at {graph.limit}</span>}
        <span className="oi-g-fill" />
        <input type="search" className="oi-g-search" aria-label="Search commits" placeholder="Search commits: td-…, bd-…, W-…, or text" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === "Escape" && search) { e.stopPropagation(); setSearch(""); } }} />
        {search.trim() && <span className="oi-g-meta" role="status">{rows.length} of {laidOut.length} match{graph?.truncated ? " (loaded commits only)" : ""}</span>}
        <button type="button" className="oi-g-icon" aria-label="Refresh graph" title="Refresh" disabled={p.busy} onClick={p.onRefresh}>{p.busy ? "…" : "↻"}</button>
      </div>
      {p.error && <p className="oi-g-note err" role="alert">{p.error}</p>}
      {!p.error && !graph && <p className="oi-g-note">{p.busy ? "Loading graph…" : "—"}</p>}
      {graph && tip && graph.latestLocal && <div className={`oi-g-dev${p.selectedSha === tip.sha ? " sel" : ""}`} role="button" tabIndex={0} aria-pressed={p.selectedSha === tip.sha} title="Latest local branch — what is in dev" onClick={() => p.onSelectCommit(tip.sha)} onKeyDown={key(tip.sha)}>
        <span className="oi-g-devlabel">In dev</span>
        <Chip name={graph.latestLocal} refs={graph.refs} color={tipRow?.color ?? 0} />
        <Subject subject={tip.subject} onThread={p.onThread} />
        <span className="oi-g-age">{relativeAge(tip.committedAt, now)}</span>
      </div>}
      {graph && !p.error && graph.commits.length > 0 && rows.length === 0 && <p className="oi-g-note">No loaded commit matches “{cleanText(search)}”.</p>}
      {graph && !p.error && graph.commits.length === 0 && <p className="oi-g-note">No commits in this scope.</p>}
      {graph && <div className="oi-g-list" role="list" ref={listRef} onScroll={e => {
        const el = e.currentTarget, top = el.scrollTop, h = el.clientHeight || 600;
        setScroll(s0 => ({ top, h, w: el.clientWidth || s0.w }));
        if (p.onLoadMore && graph.truncated && !p.busy && !p.error && nearTail(visibleWindow(top, h, rows.length, ROW_H).end, rows.length)) p.onLoadMore();
      }}><div style={{ height: win.start * ROW_H }} aria-hidden="true" />{rows.slice(win.start, win.end).map((row, k) => {
        const i = win.start + k, c = byShaMap.get(row.sha);
        if (!c) return null;
        const sel = p.selectedSha === c.sha;
        const mm = mergeMarker(c), who = laneIdentity({ branch: row.branch, trailers: c.trailers, author: c.author });
        return <div key={c.sha} role="listitem" aria-posinset={i + 1} aria-setsize={rows.length}><div className={`oi-g-row${sel ? " sel" : ""}`} style={rowMin} tabIndex={0} aria-label={`Commit ${shortSha(c.sha)}: ${cleanText(c.subject)}${mm ? " (merge)" : ""}`} aria-current={sel} aria-haspopup="menu" onClick={() => p.onSelectCommit(c.sha)}
          onContextMenu={(e: MouseEvent<HTMLElement>) => { e.preventDefault(); openMenu(c, e.clientX, e.clientY, e.currentTarget); }}
          onKeyDown={(e: KeyboardEvent<HTMLElement>) => {
            if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); openMenu(c, r.left + 24, r.bottom, e.currentTarget); }
            else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && !(window.getSelection()?.toString())) { e.preventDefault(); writeText(c.sha).then(() => say("Copied"), () => say("Not copied: the clipboard is not available")); }
            else key(c.sha)(e);
          }}>
          <Gutter row={row} prev={i > 0 ? rows[i - 1] : null} width={width} avail={avail} />
          <Chips names={c.refs} refs={graph.refs} color={row.color} latestLocal={graph.latestLocal} />
          {mm && <span className="oi-g-merge" title={mm.label} aria-hidden="true">{mm.glyph}</span>}
          <Subject subject={c.subject} onThread={p.onThread} />
          <span className="oi-g-who" title={who.title} style={who.kind === "lane" ? { color: laneVar(row.color) } : undefined}>{who.label}</span>
          <span className="oi-g-sha">{shortSha(c.sha).slice(0, 7)}</span>
          <span className="oi-g-date" title={`${new Date(c.committedAt).toISOString()} \u00b7 ${relativeAge(c.committedAt, now)}`}>{fullDate(c.committedAt)}</span>
        </div></div>;
      })}<div style={{ height: (rows.length - win.end) * ROW_H }} aria-hidden="true" /></div>}
    </>}
    {gitDialog && <GitWriteDialog repo={p.repo} action={gitDialog.action} subject={gitDialog.subject} onClose={() => { setGitDialog(null); menuRow.current?.focus(); }} onDone={p.onRefresh} />}
    {menu && <CommitMenu x={menu.x} y={menu.y} entries={menu.entries} onRun={runItem} onClose={closeMenu} />}
    <div className="oi-g-note-live" role="status" aria-live="polite">{note}</div>
  </div>;
}

export const workGraphStyles = commitMenuStyles + gitWriteDialogStyles + `
.oi-g{position:relative;display:flex;flex-direction:column;min-height:0;height:100%;color:var(--oi-text);background:var(--oi-bg);font-size:12px}
.oi-g button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;padding:0}
.oi-g-tabs{display:flex;align-items:stretch;overflow-x:auto;flex:none;border-bottom:1px solid var(--oi-border);background:var(--oi-panel);scrollbar-width:thin}
.oi-g .oi-g-tab{display:inline-flex;align-items:center;gap:6px;flex:none;max-width:220px;overflow:hidden;text-overflow:ellipsis;padding:4px 10px;white-space:nowrap;color:var(--oi-tone-muted);border-right:1px solid var(--oi-border)}
.oi-g-ldot{flex:none;width:7px;height:7px;border-radius:50%}
.oi-g-tab:hover{background:var(--oi-hover)}
.oi-g-tab.sel{color:var(--oi-text);background:var(--oi-bg);box-shadow:inset 0 -2px 0 var(--oi-tone-info)}
.oi-g .oi-g-tab.plus{padding:4px 10px}
.oi-g-dirty{color:var(--oi-tone-attention)}
.oi-g-add{font:inherit;font-family:ui-monospace,monospace;min-width:240px;padding:3px 6px;color:var(--oi-text);background:var(--oi-bg);border:1px solid var(--oi-border);border-radius:0}
.oi-g-bar{display:flex;align-items:center;gap:10px;flex:none;padding:3px 8px;border-bottom:1px solid var(--oi-border)}
.oi-g-segs{display:inline-flex;border:1px solid var(--oi-border)}
.oi-g .oi-g-seg{padding:1px 10px;white-space:nowrap;color:var(--oi-tone-muted)}
.oi-g .oi-g-seg+.oi-g-seg{border-left:1px solid var(--oi-border)}
.oi-g .oi-g-seg.on{color:var(--oi-text);background:var(--oi-selected)}
.oi-g-meta{color:var(--oi-tone-muted)}
.oi-g-meta.warn{color:var(--oi-tone-attention)}
.oi-g-fill{flex:1}
.oi-g-search{font:inherit;width:240px;max-width:40%;padding:1px 6px;color:var(--oi-text);background:var(--oi-bg);border:1px solid var(--oi-border);border-radius:0}.oi-g-search:focus-visible{outline:2px solid var(--oi-accent)}
.oi-g .oi-g-icon{padding:0 6px;color:var(--oi-tone-muted)}
.oi-g-icon:hover:not(:disabled){color:var(--oi-text)}
.oi-g-note{margin:0;padding:8px;color:var(--oi-tone-muted)}
.oi-g-note.err{color:var(--oi-tone-failure)}
.oi-g-dev{display:flex;align-items:center;gap:8px;flex:none;height:${ROW_H}px;padding:0 8px;border-bottom:1px solid var(--oi-border);background:var(--oi-panel);cursor:pointer;min-width:0}
.oi-g-dev:hover{background:var(--oi-hover)}
.oi-g-dev.sel,.oi-g-row.sel{background:var(--oi-selected)}
.oi-g-devlabel{color:var(--oi-tone-info);font-weight:600;flex:none}
.oi-g-list{flex:1;min-height:0;overflow:auto}
.oi-g-row{display:flex;align-items:center;gap:8px;height:${ROW_H}px;padding-right:8px;white-space:nowrap;cursor:pointer;outline-offset:-1px}
.oi-g-row:hover{background:var(--oi-hover)}
.oi-g-row.sel:hover{background:var(--oi-selected)}
.oi-g-row:focus-visible,.oi-g-dev:focus-visible{outline:1px solid var(--oi-tone-info)}
.oi-g-lanes{flex:none;display:block;margin-left:4px}
.oi-g-chips{display:inline-flex;gap:4px;flex:none}
.oi-g-chip{padding:0 5px;line-height:16px;border:1px solid var(--oi-border);font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;flex:none}
.oi-g-chip.remote{color:var(--oi-tone-muted)}
.oi-g-chip.tag{color:var(--oi-tone-attention);border-color:var(--oi-tone-attention);border-style:dashed}
.oi-g-chip.head{color:var(--oi-tone-info);border-color:var(--oi-tone-info)}
.oi-g-more{color:var(--oi-tone-muted)}
.oi-g-subj{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.oi-g-type{color:var(--oi-tone-muted)}
.oi-g .oi-g-link{color:var(--oi-tone-info);text-decoration:underline;text-underline-offset:2px}
.oi-g-link:hover{color:var(--oi-text)}
.oi-g-who{flex:none;width:110px;overflow:hidden;text-overflow:ellipsis;color:var(--oi-tone-muted)}
.oi-g-merge{flex:none;color:var(--oi-tone-muted)}
.oi-g-tc{flex:none;margin-right:6px;padding:0 5px;line-height:16px;font-size:11px;border:1px solid currentColor;border-radius:8px}
.oi-g-tc.t-info{color:var(--oi-tone-info)}.oi-g-tc.t-success{color:var(--oi-tone-success)}.oi-g-tc.t-attention{color:var(--oi-tone-attention)}.oi-g-tc.t-failure{color:var(--oi-tone-failure)}.oi-g-tc.t-muted{color:var(--oi-tone-muted)}
.oi-g-note-live{position:absolute;right:12px;bottom:8px;pointer-events:none;color:var(--oi-text);background:var(--oi-panel);padding:0 8px}
.oi-g-note-live:empty{display:none}
.oi-g-age{flex:none;width:5.5ch;text-align:right;color:var(--oi-tone-muted)}
.oi-g-sha{flex:none;width:7ch;font-family:ui-monospace,monospace;color:var(--oi-tone-muted)}
.oi-g-date{flex:none;width:16ch;text-align:right;color:var(--oi-tone-muted);font-variant-numeric:tabular-nums}
`;
