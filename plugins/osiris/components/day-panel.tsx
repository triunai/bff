import { kindDef } from "../calendar-kinds.ts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DayCommit, DayCommits, FileDiff, GitCommitDetail, GitResult } from "../git-types.ts";
import type { CalendarKind, SpineEvent } from "../spine-index.ts";
import { clockTime, dayTotals, groupBySource, humanDate, plural } from "../day-ui.ts";
import { relativeAge, shortSha } from "../git-ui.ts";
import { FileRow } from "./commit-inspector.tsx";
import { Subject, SubjectText } from "./work-graph.tsx";
import { laneIdentity } from "../git-lane-identity.ts";
import { mergeMarker } from "../git-ui.ts";
import { daySummary, type DaySummary } from "../lib/day-summary.ts";
import { AskAgentButton, dayContext } from "../work/ask-agent/index.ts";
import type { SpineThread } from "../spine-index.ts";
import { cleanText } from "../work/sanitize.ts";

/** First rows shown per branch group; "show N more" expands in place. */
export const GROUP_PAGE = 20;

type Detail = { state: "loading" } | { state: "ok"; detail: GitCommitDetail } | { state: "error"; reason: string };
type Loader = (sha: string) => Promise<GitResult<GitCommitDetail>>;

/** One commit row; expands (once-fetched, cached for the life of the row) to its file list, each file to its diff. */
function CommitRow({ c, loadCommit, loadDiff, onThread }: { c: DayCommit; loadCommit: Loader; loadDiff(sha: string, path: string): Promise<GitResult<FileDiff>>; onThread(id: string): void }) {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState<Detail | null>(null);
  const alive = useRef(true);
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
  return <li className="oi-dp-commit">
    <div className="oi-dp-row">
      <button type="button" className="oi-dp-toggle" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} commit ${shortSha(c.sha)}`} onClick={toggle}><span aria-hidden="true">{open ? "▾" : "▸"}</span></button>
      <span className="oi-dp-time" title={`committed ${new Date(c.committedAt).toISOString()} · ${relativeAge(c.committedAt, Date.now())}`}>{clockTime(c.committedAt)}</span>
      {(() => { const who = laneIdentity({ source: c.source, trailers: c.trailers, author: c.author }), mm = mergeMarker(c); return <>
        <span className="oi-dp-author" title={who.title}>{who.label}</span>
        {mm && <span className="oi-g-merge" title={mm.label} aria-label={mm.label}>{mm.glyph}</span>}</>; })()}
      <span className="oi-dp-subj"><Subject subject={c.subject} onThread={onThread} /></span>
      <span className="oi-dp-sha" title={c.sha}>{shortSha(c.sha)}</span>
    </div>
    {open && (!d || d.state === "loading" ? <p className="oi-dp-note">Loading files…</p>
      : d.state === "error" ? <p className="oi-dp-note err" role="alert">{d.reason}</p>
      : d.detail.files.length === 0 ? <p className="oi-dp-note">No file changes (e.g. empty or merge commit).</p>
      : <>
        <ul className="oi-gi-files oi-dp-files">{d.detail.files.map(f => <FileRow key={f.path} f={f} loadDiff={path => loadDiff(c.sha, path)} />)}</ul>
        {d.detail.filesTruncated && <p className="oi-dp-note warn">File list truncated.</p>}
      </>)}
  </li>;
}

function Group({ source, commits, ...rest }: { source: string; commits: DayCommit[]; loadCommit: Loader; loadDiff(sha: string, path: string): Promise<GitResult<FileDiff>>; onThread(id: string): void }) {
  const [all, setAll] = useState(false);
  const shown = all ? commits : commits.slice(0, GROUP_PAGE), hidden = commits.length - shown.length;
  return <section className="oi-dp-group">
    <h3 className="oi-dp-gh" title={source}>{source} <i>({commits.length})</i></h3>
    <ul className="oi-dp-list">{shown.map(c => <CommitRow key={c.sha} c={c} {...rest} />)}</ul>
    {hidden > 0 && <button type="button" className="oi-dp-more" onClick={() => setAll(true)}>show {hidden} more in {source}</button>}
  </section>;
}

/** UI v2 W16/W17: what the day amounted to (headline, shipped, notable, work by scope) from the same data as the lists below it. Plain text only. */
export function DaySummaryBlock({ s, onThread }: { s: DaySummary; onThread(id: string): void }) {
  const t = (x: string) => cleanText(x, 160);
  return <section className="oi-dp-sum" aria-label="Day summary">
    <p className="oi-dp-headline">{t(s.headline)}</p>
    <p className="oi-dp-counts">{plural(s.counts.commits, "commit")}{s.counts.merges > 0 && ` · ${plural(s.counts.merges, "merge")} \u21a9`}{s.counts.decisions > 0 && ` · ${plural(s.counts.decisions, "decision")}`}{s.counts.threadsDone > 0 && ` · ${s.counts.threadsDone} thread${s.counts.threadsDone === 1 ? "" : "s"} done`}{s.counts.migrations > 0 && ` · ${plural(s.counts.migrations, "migration")}`}</p>
    {s.shipped.threads.length > 0 && <><h3 className="oi-dp-gh">Shipped</h3><ul className="oi-dp-list">{s.shipped.threads.map((x, i) => <li key={`${x.ref}:${i}`} className="oi-dp-ev"><span className="oi-dp-subj" title={t(x.title)}><SubjectText text={t(x.title)} onThread={onThread} /></span></li>)}</ul></>}
    {s.notable.length > 0 && <><h3 className="oi-dp-gh">Notable</h3><ul className="oi-dp-list">{s.notable.map((x, i) => <li key={`${x.sha}:${i}`} className="oi-dp-ev"><span className="oi-dp-kind">{x.kind}</span><span className="oi-dp-subj" title={`${t(x.subject)} — ${t(x.why)}`}><SubjectText text={t(x.subject)} onThread={onThread} /></span><span className="oi-dp-sha">{shortSha(x.sha)}</span></li>)}</ul></>}
    {s.groups.length > 0 && <p className="oi-dp-groups">{s.groups.slice(0, 8).map(g => <span key={g.key} className="oi-dp-grp" title={Object.entries(g.types).map(([k, n]) => `${k} ${n}`).join(", ")}>{t(g.key)} \u00d7{g.count}</span>)}</p>}
  </section>;
}

export function DayPanel(p: {
  threads?: readonly SpineThread[]; date: string; data: DayCommits | null; busy: boolean; error: string | null; spineItems: SpineEvent[];
  loadCommit: Loader; loadDiff(sha: string, path: string): Promise<GitResult<FileDiff>>; onThread(id: string): void; onClose(): void;
}) {
  const totals = p.data ? dayTotals(p.data.commits) : null;
  const summary = p.data && p.data.commits.length > 0 ? daySummary({ date: p.date, events: p.spineItems, commits: p.data.commits }) : null;
  let body: ReactNode;
  if (p.error) body = <p className="oi-dp-note err" role="alert">{p.error}</p>;
  else if (!p.data) body = <p className="oi-dp-note">{p.busy ? "Loading commits…" : "No data for this day."}</p>;
  else if (p.data.commits.length === 0) body = <p className="oi-dp-note">No commits on this day.</p>;
  else body = groupBySource(p.data.commits).map(g => <Group key={g.source} source={g.source} commits={g.commits} loadCommit={p.loadCommit} loadDiff={p.loadDiff} onThread={p.onThread} />);
  return <div className="oi-dp">
    <div className="oi-dp-head">
      <h2 className="oi-dp-title">{humanDate(p.date)}</h2>
      {totals && <span className="oi-dp-totals">{plural(totals.commits, "commit")} · {plural(totals.branches, "branch", "branches")}{p.data?.truncated && ` · truncated at ${p.data.limit}`}</span>}
      <AskAgentButton ask={() => dayContext({ date: p.date, today: new Date().toLocaleDateString("en-CA"), commits: p.data?.commits ?? [], events: p.spineItems, threads: p.threads ?? [] })} />
      <button type="button" className="oi-dp-close" aria-label="Close day" onClick={p.onClose}>✕</button>
    </div>
    {summary && <DaySummaryBlock s={summary} onThread={p.onThread} />}
    {p.spineItems.length > 0 && <section className="oi-dp-spine">
      <h3 className="oi-dp-gh">Spine on this day <i>({p.spineItems.length})</i></h3>
      <ul className="oi-dp-list">{p.spineItems.map((e, i) => <li key={`${e.kind}:${e.ref}:${i}`} className="oi-dp-ev">
        <span className="oi-dp-glyph" style={{ color: `var(${kindDef(e.kind).token})` }} title={kindDef(e.kind).one} aria-label={kindDef(e.kind).one}>{kindDef(e.kind).glyph}</span>
        <span className="oi-dp-subj" title={e.ref}>{e.threadIds.length > 0 ? <SubjectText text={e.title} onThread={p.onThread} /> : e.title}</span>
        {e.threadIds.length > 0 && !/\bW-\d+\b/.test(e.title) && e.threadIds.map(t => <button key={t} type="button" className="oi-g-link" onClick={() => p.onThread(t)}>{t}</button>)}
      </li>)}</ul>
    </section>}
    {body}
  </div>;
}

/** Reuses the oi-gi-* / oi-df-* rules from commitInspectorStyles for the file rows and diffs; install both style blocks together. */
export const dayPanelStyles = `
.oi-dp{height:100%;overflow:auto;padding:8px;color:var(--oi-text);background:var(--oi-bg);font-size:12px}
.oi-dp-head{display:flex;align-items:baseline;gap:10px;padding-bottom:4px;border-bottom:1px solid var(--oi-border)}
.oi-dp-title{margin:0;font-size:13px;font-weight:600}.oi-dp-totals{flex:1;color:var(--oi-tone-muted)}
.oi-dp-close{flex:none;min-width:24px;min-height:24px;background:transparent;border:0;color:var(--oi-tone-muted);cursor:pointer}
.oi-dp-close:hover{color:var(--oi-text);background:var(--oi-hover)}.oi-dp-close:focus-visible,.oi-dp-toggle:focus-visible,.oi-dp-more:focus-visible{outline:1px solid var(--oi-tone-info);outline-offset:-1px}
.oi-dp-note{margin:4px 0;color:var(--oi-tone-muted)}.oi-dp-note.err{color:var(--oi-tone-failure)}.oi-dp-note.warn{color:var(--oi-tone-attention)}
.oi-dp-gh{margin:10px 0 2px;padding:3px 0;font-size:11px;font-weight:600;color:var(--oi-tone-muted);border-bottom:1px solid var(--oi-border);overflow-wrap:anywhere}
.oi-dp-gh i{font-style:normal;font-weight:400}
.oi-dp-list{list-style:none;margin:0;padding:0}
.oi-dp-row,.oi-dp-ev{display:flex;align-items:baseline;gap:8px;padding:1px 0;min-width:0}
.oi-dp-row:hover{background:var(--oi-hover)}
.oi-dp-toggle{flex:none;width:2ch;padding:0;background:transparent;border:0;color:var(--oi-tone-muted);font:inherit;cursor:pointer}
.oi-dp-time,.oi-dp-sha{flex:none;font-family:ui-monospace,monospace;color:var(--oi-tone-muted)}
.oi-dp-author{flex:none;max-width:14ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--oi-tone-muted)}
.oi-dp-subj{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-dp-sum{margin:6px 0 2px;padding:2px 0 2px 8px;border-left:2px solid var(--oi-border)}
.oi-dp-headline{margin:0 0 2px;font-weight:600;overflow-wrap:anywhere}.oi-dp-counts{margin:0;color:var(--oi-tone-muted)}
.oi-dp-kind{flex:none;padding:0 5px;color:var(--oi-tone-attention);border:1px solid currentColor;border-radius:8px;font-size:10px}
.oi-dp-groups{display:flex;flex-wrap:wrap;gap:4px 8px;margin:6px 0 0}.oi-dp-grp{padding:0 6px;color:var(--oi-tone-muted);border:1px solid var(--oi-border)}
.oi-dp-glyph{flex:none;width:1.5ch;text-align:center}
.oi-dp-files{margin:2px 0 4px 3ch}
.oi-dp-more{margin:2px 0;padding:1px 6px;background:transparent;border:1px solid var(--oi-border);color:var(--oi-tone-info);font:inherit;cursor:pointer}
.oi-dp-more:hover{background:var(--oi-hover)}
`;
