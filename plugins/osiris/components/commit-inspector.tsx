import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { FileDiff, GitCommitDetail, GitFileStat, GitResult } from "../git-types.ts";
import { diffKindNote, diffStatsLabel, hunkRange, lineMarker, relativeAge, shortSha, splitRows, threadMentions, truncationNote } from "../git-ui.ts";
import { SubjectText } from "./work-graph.tsx";
import { AskAgentButton, commitContext } from "../work/ask-agent/index.ts";
import { inspectorModel } from "../commit-inspector-model.ts";

const stamp = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z" : "—");

type DiffState = { state: "idle" } | { state: "loading" } | { state: "ok"; diff: FileDiff } | { state: "error"; reason: string };

/** The unified diff of one file: header line, then hunks (old no · new no · marker · text). Scrolls sideways inside its own block only. */
export function DiffView({ diff, layout = "unified", hideHead = false }: { diff: FileDiff; layout?: "unified" | "split"; hideHead?: boolean }) {
  const note = diffKindNote(diff);
  return <div className={`oi-df${layout === "split" ? " split" : ""}`}>
    {!hideHead && <div className="oi-df-head">{diff.oldPath && diff.oldPath !== diff.path ? <>{diff.oldPath} → {diff.path}</> : diff.path}{diff.kind === "text" && diff.hunks.length > 0 && <span className="oi-df-stat"> {diffStatsLabel(diff)}</span>}</div>}
    {note && <div className="oi-df-note">{note}</div>}
    {diff.hunks.length > 0 && <div className="oi-df-scroll" tabIndex={0} role="group" aria-label={`Diff of ${diff.path}`}>
      {diff.hunks.map((h, hi) => <div key={hi} className="oi-df-hunk">
        <div className="oi-df-hh" title={hunkRange(h)}>{h.header || `@@ ${hunkRange(h)} @@`}{h.section && !h.header.includes(h.section) ? ` ${h.section}` : ""}</div>
        {layout === "split"
          ? splitRows(h.lines).map((r, li) => <div key={li} className="oi-df-sp">
            {([["l", r.left, "del"], ["r", r.right, "add"]] as const).map(([side, l, k]) => <div key={side} className={`oi-df-l ${l ? (l.kind === "ctx" ? "ctx" : k) : "empty"}`}>
              <span className="oi-df-no">{l ? (side === "l" ? l.oldNo : l.newNo) ?? "" : ""}</span><pre className="oi-df-tx">{l?.text ?? ""}</pre></div>)}
          </div>)
          : h.lines.map((l, li) => <div key={li} className={`oi-df-l ${l.kind}`}>
          <span className="oi-df-no">{l.oldNo ?? ""}</span><span className="oi-df-no">{l.newNo ?? ""}</span><span className="oi-df-mk" aria-hidden="true">{lineMarker(l.kind)}</span>
          <pre className="oi-df-tx">{l.text}{l.noNewlineAtEof && <small className="oi-df-nn"> ⏎ no newline at end of file</small>}</pre>
        </div>)}
      </div>)}
    </div>}
    {diff.truncated && <div className="oi-df-trunc">{truncationNote(diff.omittedLines)}</div>}
  </div>;
}

/** One changed file: a disclosure button; the diff is requested once, on first expand, and kept for later toggles. */
export function FileRow({ f, loadDiff }: { f: GitFileStat; loadDiff?: (path: string) => Promise<GitResult<FileDiff>> }) {
  const [open, setOpen] = useState(false);
  const [dv, setDv] = useState<DiffState>({ state: "idle" });
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next || dv.state !== "idle" || !loadDiff) return;
    setDv({ state: "loading" });
    loadDiff(f.path).then(
      r => { if (alive.current) setDv(r.ok ? { state: "ok", diff: r.value } : { state: "error", reason: r.reason }); },
      e => { if (alive.current) setDv({ state: "error", reason: e instanceof Error ? e.message : String(e) }); },
    );
  };
  return <li className="oi-gi-file">
    <button type="button" className="oi-gi-frow" aria-expanded={open} onClick={toggle} title={f.path}>
      <span className="car" aria-hidden="true">{open ? "▾" : "▸"}</span><span className="path">{f.path}</span>
      {f.binary ? <span className="num">binary</span> : <><span className="num oi-gi-add">+{f.additions ?? "—"}</span><span className="num oi-gi-del">−{f.deletions ?? "—"}</span></>}
    </button>
    {open && (!loadDiff ? <p className="oi-gi-note">Diff not available here.</p>
      : dv.state === "ok" ? <DiffView diff={dv.diff} />
      : dv.state === "error" ? <p className="oi-gi-note err" role="alert">{dv.reason}</p>
      : <p className="oi-gi-note">Loading diff…</p>)}
  </li>;
}

export function CommitInspector(p: { detail: GitCommitDetail | null; busy: boolean; error: string | null; onThread(id: string): void; loadDiff?: (path: string) => Promise<GitResult<FileDiff>>; branch?: string | null }) {
  // Hooks first: every early return below comes after them.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const d = p.detail, now = Date.now();
  if (p.error) return <div className="oi-gi"><p className="oi-gi-note err" role="alert">{p.error}</p></div>;
  if (!d) return <div className="oi-gi"><p className="oi-gi-note">{p.busy ? "Loading commit…" : "Select a commit."}</p></div>;
  const m = inspectorModel(d, p.branch ?? null), full = openFor === d.sha, c = m.counts;
  const threads = threadMentions(d.subject, d.body);
  return <div className="oi-gi">
    <h2 className="oi-gi-subject">{m.title.chip && <span className={`oi-g-tc t-${m.title.chip.tone}`}>{m.title.chip.text}</span>}{m.merge && <span className="oi-g-merge" title={m.merge.label} aria-label={m.merge.label}>{m.merge.glyph} </span>}<SubjectText text={m.title.rest} onThread={p.onThread} /></h2>
    <AskAgentButton ask={() => commitContext(d)} />
    <p className="oi-gi-who"><span title={m.identity.title}>{m.identity.label}</span> · {stamp(d.committedAt)} · {relativeAge(d.committedAt, now)} · <span className="mono" title={d.sha}>{shortSha(d.sha)}</span></p>
    <h3 className="oi-gi-h">Message{m.message.collapsed && <i>{m.message.lines} lines</i>}</h3>
    {m.message.text ? <>
      <pre className="oi-gi-body"><SubjectText text={full || !m.message.collapsed ? m.message.text : m.message.preview} onThread={p.onThread} /></pre>
      {m.message.collapsed && <button type="button" className="oi-gi-toggle" aria-expanded={full} onClick={() => setOpenFor(full ? null : d.sha)}>{full ? "Show less" : "Show full message"}</button>}
    </> : <p className="oi-gi-note">No message body.</p>}
    {(m.trailers.length > 0 || threads.length > 0) && <>
      <h3 className="oi-gi-h">Links</h3>
      <dl className="oi-gi-kv">
        {m.trailers.map((t, i) => <Fragment key={i}><dt>{t.key}</dt><dd><SubjectText text={t.value} onThread={p.onThread} /></dd></Fragment>)}
        {threads.length > 0 && <><dt>threads</dt><dd>{threads.map(t => <button key={t} type="button" className="oi-g-link" onClick={() => p.onThread(t)}>{t}</button>).reduce<ReactNode[]>((a, x, i) => (i ? [...a, " ", x] : [x]), [])}</dd></>}
      </dl>
    </>}
    <h3 className="oi-gi-h">Files <i>{c.files || "—"}</i>{c.files > 0 && <i className="oi-gi-tot"><span className="oi-gi-add">+{c.additions}</span> <span className="oi-gi-del">−{c.deletions}</span>{c.binary > 0 && ` · ${c.binary} binary`}</i>}</h3>
    {d.files.length === 0 ? <p className="oi-gi-note">No file changes (e.g. empty or merge commit).</p> : <ul className="oi-gi-files">{d.files.map(f => <FileRow key={`${d.sha}:${f.path}`} f={f} loadDiff={p.loadDiff} />)}</ul>}
    {d.filesTruncated && <p className="oi-gi-note warn">File list truncated — totals cover only the files shown.</p>}
    <p className="oi-gi-note oi-gi-sha"><span className="mono">{d.sha}</span>{d.parents.length > 0 && <> · parent{d.parents.length > 1 ? "s" : ""} <span className="mono">{d.parents.map(shortSha).join(" ")}</span></>}</p>
  </div>;
}

export const commitInspectorStyles = `
.oi-gi{height:100%;overflow:auto;padding:8px;color:var(--oi-text);background:var(--oi-bg);font-size:12px}
.oi-gi-note{margin:4px 0;color:var(--oi-tone-muted)}
.oi-gi-note.err{color:var(--oi-tone-failure)}
.oi-gi-note.warn{color:var(--oi-tone-attention)}
.oi-gi-subject{margin:0 0 6px;font-size:13px;font-weight:600;overflow-wrap:anywhere}
.oi-gi-body{margin:0 0 8px;white-space:pre-wrap;font:inherit;overflow-wrap:anywhere}
.oi-gi-kv{display:grid;grid-template-columns:max-content 1fr;gap:1px 12px;margin:0 0 8px}
.oi-gi-kv dt{color:var(--oi-tone-muted)}
.oi-gi-kv dd{margin:0;overflow-wrap:anywhere}
.oi-gi-kv .mono{font-family:ui-monospace,monospace}
.oi-gi-h{margin:8px 0 2px;padding:3px 0;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--oi-tone-muted);border-bottom:1px solid var(--oi-border)}
.oi-gi-h i{font-style:normal;font-weight:400}
.oi-gi-files{list-style:none;margin:0;padding:0;font-family:ui-monospace,monospace}
.oi-gi-frow{display:flex;align-items:baseline;gap:6px;width:100%;padding:1px 0;background:transparent;border:0;text-align:left;font:inherit;color:inherit;cursor:pointer;white-space:nowrap}
.oi-gi-frow:hover{background:var(--oi-hover)}.oi-gi-frow:focus-visible{outline:1px solid var(--oi-tone-info);outline-offset:-1px}
.oi-gi-frow .car{flex:none;width:1ch;color:var(--oi-tone-muted)}
.oi-gi-frow .path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.oi-gi-frow .num{flex:none;padding-left:10px;color:var(--oi-tone-muted)}
.oi-df{margin:2px 0 6px 1ch;border-left:1px solid var(--oi-border);padding-left:6px;min-width:0;font-family:ui-monospace,monospace}
.oi-df-head{color:var(--oi-text);overflow-wrap:anywhere}.oi-df-stat,.oi-df-note,.oi-df-trunc{color:var(--oi-tone-muted)}
.oi-df-trunc{padding:1px 0}
.oi-df-scroll{overflow-x:auto;max-width:100%}.oi-df-scroll:focus-visible{outline:1px solid var(--oi-tone-info)}
.oi-df-hunk{min-width:max-content}
.oi-df-hh{color:var(--oi-tone-info);background:color-mix(in srgb,var(--oi-tone-info) 8%,transparent);padding:3px 8px;margin-top:8px;font-size:11px;white-space:pre}
.oi-df-l{display:flex;font-size:12px;line-height:19px;color:var(--oi-tone-muted)}
.oi-df-l.add{background:color-mix(in srgb,var(--oi-tone-success) 10%,transparent);color:color-mix(in srgb,var(--oi-tone-success) 70%,var(--oi-text))}
.oi-df-l.del{background:color-mix(in srgb,var(--oi-tone-failure) 10%,transparent);color:color-mix(in srgb,var(--oi-tone-failure) 70%,var(--oi-text))}
.oi-df-no{flex:none;min-width:40px;padding:0 8px 0 0;text-align:right;color:var(--oi-tone-muted);opacity:.7;user-select:none}
.oi-df-mk{flex:none;width:2ch;text-align:center;user-select:none}
.oi-df-l.add .oi-df-mk{color:var(--oi-tone-success)}.oi-df-l.del .oi-df-mk{color:var(--oi-tone-failure)}
.oi-df-sp{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.oi-df-l.ctx{color:var(--oi-text-2)}.oi-df-l.empty{background:color-mix(in srgb,var(--oi-tone-muted) 6%,transparent)}
.oi-df-tx{margin:0;font:inherit;white-space:pre}.oi-df-nn{color:var(--oi-tone-muted);font-style:italic}
.oi-gi-add{color:var(--oi-tone-success)}.oi-gi-del{color:var(--oi-tone-failure)}
.oi-gi-total{margin:4px 0;color:var(--oi-tone-muted)}
.oi-gi-who{margin:0 0 4px;color:var(--oi-tone-muted)}.oi-gi-who .mono,.oi-gi-sha .mono{font-family:ui-monospace,monospace}
.oi-gi-toggle{margin:0 0 6px;padding:1px 8px;font:inherit;color:var(--oi-tone-info);background:transparent;border:1px solid var(--oi-border);cursor:pointer}
.oi-gi-toggle:hover{background:var(--oi-hover)}.oi-gi-toggle:focus-visible{outline:1px solid var(--oi-tone-info)}
.oi-gi-tot{margin-left:10px;text-transform:none;letter-spacing:0}
.oi-gi-sha{overflow-wrap:anywhere}
.oi-gi-subject .oi-g-tc{margin-right:8px;vertical-align:1px}
`;
