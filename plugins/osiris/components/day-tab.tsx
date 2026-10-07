import { useEffect, useRef, useState } from "react";
import type { DayCommit, GitCommitDetail, GitResult } from "../git-types.ts";
import { groupBySource } from "../day-ui.ts";
import { shortDate } from "../lib/day-sections.ts";
import { shortSha } from "../git-ui.ts";
import { cleanText } from "../work/sanitize.ts";

type Detail = { state: "loading" } | { state: "ok"; detail: GitCommitDetail } | { state: "error"; reason: string };

function DayCommitRow({ c, beads, loadCommit }: { c: DayCommit; beads: readonly string[]; loadCommit(sha: string): Promise<GitResult<GitCommitDetail>> }) {
  const [open, setOpen] = useState(false), [d, setD] = useState<Detail | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next || d) return;
    setD({ state: "loading" });
    loadCommit(c.sha).then(
      r => { if (alive.current) setD(r.ok ? { state: "ok", detail: r.value } : { state: "error", reason: r.reason }); },
      e => { if (alive.current) setD({ state: "error", reason: e instanceof Error ? e.message : String(e) }); },
    );
  };
  const subject = cleanText(c.subject, 200);
  return <div className={`mk-dc${open ? " sel" : ""}`} onClick={toggle} role="button" tabIndex={0} aria-expanded={open} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}>
    <span className="s" title={subject}>{subject}</span>
    <span className="m"><span className="mono" title={c.sha}>{shortSha(c.sha)}</span>{beads.map(b => <span key={b} className="mk-chip mk-idc">{b}</span>)}</span>
    {open && <div style={{ marginTop: 4 }}>{!d || d.state === "loading" ? <p className="mk-note">Loading files…</p>
      : d.state === "error" ? <p className="mk-note err" role="alert">{d.reason}</p>
      : d.detail.files.length === 0 ? <p className="mk-note">No file changes (e.g. empty or merge commit).</p>
      : d.detail.files.map(f => <div key={f.path} className="mk-ff"><span className="c-att" aria-hidden="true">{" "}</span><span className="p" title={f.path}>{f.path}</span>
        {f.binary ? <span className="mk-note">binary</span> : <><span className="c-ok">+{f.additions ?? "—"}</span><span className="c-fail">{"−"}{f.deletions ?? "—"}</span></>}</div>)}</div>}
  </div>;
}

/** The right panel's "Day" tab (state 8): the selected day's commits grouped by branch; a commit opens to its files with +/-. */
export function DayTab(p: { day: string | null; commits: readonly DayCommit[] | null; busy: boolean; error: string | null; beads?: ReadonlyMap<string, readonly string[]>; onlyShas?: readonly string[] | null; onShowAll?(): void; loadCommit(sha: string): Promise<GitResult<GitCommitDetail>> }) {
  if (!p.day) return <p className="mk-note">Select a day in the Calendar to see its commits here.</p>;
  if (p.error) return <p className="mk-note err" role="alert">{p.error}</p>;
  if (!p.commits) return <p className="mk-note">{p.busy ? "Loading commits…" : "No data for this day."}</p>;
  const only = p.onlyShas ? new Set(p.onlyShas) : null, commits = only ? p.commits.filter(c => only.has(c.sha)) : p.commits;
  return <div className="mk-daytab">
    <div className="mk-eyebrow">{shortDate(p.day)} · {only ? "merges" : "commits"} <b>{commits.length}</b>{only && <button type="button" className="mk-tbtn" onClick={p.onShowAll}>Show all {p.commits.length}</button>}</div>
    <p className="mk-note" style={{ margin: "2px 0 6px" }}>The same commits view as History, filtered to this day.</p>
    {commits.length === 0 && <p className="mk-note">{only ? "No merges on this day." : "No commits on this day."}</p>}
    {groupBySource(commits).map(g => <div key={g.source}><div className="mk-br">{g.source}</div>{g.commits.map(c => <DayCommitRow key={c.sha} c={c} beads={p.beads?.get(c.sha) ?? []} loadCommit={p.loadCommit} />)}</div>)}
  </div>;
}

/** Values ported from the mockup (.br .dc .ff) onto the theme's --oi-* tokens. */
export const dayTabStyles = `
.mk-daytab{padding:8px;overflow:auto;height:100%;box-sizing:border-box}
.mk-br{font:600 10.5px var(--oi-font-mono);color:var(--oi-text-2);margin:10px 0 2px}
.mk-dc{display:flex;flex-direction:column;gap:2px;padding:6px;border-radius:3px;border-bottom:1px solid var(--oi-border);cursor:pointer}
.mk-dc:hover{background:var(--oi-hover)}.mk-dc.sel{background:var(--oi-selected);box-shadow:inset 2px 0 0 var(--oi-accent)}
.mk-dc:focus-visible{outline:1px solid var(--oi-focus);outline-offset:-1px}
.mk-dc .s{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mk-dc .m{display:flex;gap:6px;font:10.5px var(--oi-font-mono);color:var(--oi-tone-muted);align-items:center}
.mk-ff{display:flex;gap:8px;font:11px var(--oi-font-mono);height:20px;align-items:center}
.mk-ff .p{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mk-ff .c-att{color:var(--oi-tone-attention);width:1ch}
.mk-ff .c-ok,.mk-daytab .c-ok{color:var(--oi-tone-success)}.mk-ff .c-fail{color:var(--oi-tone-failure)}
`;
