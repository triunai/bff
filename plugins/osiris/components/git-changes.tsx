import type { GitCommit, GitStatus, GitStatusEntry } from "../git-types.ts";
import { relativeAge, shortSha } from "../git-ui.ts";
import { Subject } from "./work-graph.tsx";

const CODE: Record<string, string> = { M: "M", T: "M", A: "A", D: "D", R: "R", C: "A", U: "U", "?": "?" };
const code = (c: string) => CODE[c] ?? (c.trim() || "·");
const label = (c: string) => ({ M: "modified", T: "type changed", A: "added", C: "copied", D: "deleted", R: "renamed", U: "unmerged", "?": "untracked" } as Record<string, string>)[c] ?? "unchanged";

function Group({ title, items, pick }: { title: string; items: GitStatusEntry[]; pick(e: GitStatusEntry): string }) {
  return <section className="oi-gc-group"><h3 className="oi-gc-h">{title} <i>{items.length || "—"}</i></h3>
    {items.map(e => <div key={`${title}:${e.path}`} className="oi-gc-file" title={e.origPath ? `${e.origPath} → ${e.path}` : e.path}><span className={`oi-gc-code c${code(pick(e))}`} title={label(pick(e))}>{code(pick(e))}</span><span className="oi-gc-path">{e.origPath ? `${e.origPath} → ` : ""}{e.path}</span></div>)}
  </section>;
}

export function GitChanges(p: { status: GitStatus | null; recent: GitCommit[]; busy: boolean; error: string | null; onSelectCommit(sha: string): void; selectedSha: string | null; onThread(id: string): void }) {
  const s = p.status, now = Date.now();
  const staged = s?.entries.filter(e => e.x !== " " && e.x !== "?" && e.x !== "!") ?? [];
  const unstaged = s?.entries.filter(e => e.y !== " " && e.y !== "?" && e.y !== "!") ?? [];
  const untracked = s?.entries.filter(e => e.x === "?" && e.y === "?") ?? [];
  return <div className="oi-gc">
    {p.error && <p className="oi-gc-note err" role="alert">{p.error}</p>}
    {!p.error && !s && <p className="oi-gc-note">{p.busy ? "Loading changes…" : "—"}</p>}
    {s && <>
      <div className="oi-gc-head"><b>{s.branch ?? "(detached)"}</b><span title="commits ahead of upstream">↑{s.ahead ?? "—"}</span><span title="commits behind upstream">↓{s.behind ?? "—"}</span><span className="oi-gc-up">{s.upstream ?? "—"}</span></div>
      {s.entries.length === 0 && <p className="oi-gc-note">Working tree clean.</p>}
      {staged.length > 0 && <Group title="Staged" items={staged} pick={e => e.x} />}
      {unstaged.length > 0 && <Group title="Unstaged" items={unstaged} pick={e => e.y} />}
      {untracked.length > 0 && <Group title="Untracked" items={untracked} pick={() => "?"} />}
      {s.truncated && <p className="oi-gc-note warn">List truncated — more changes exist than are shown.</p>}
    </>}
    <section className="oi-gc-group"><h3 className="oi-gc-h">Recent commits <i>{p.recent.length || "—"}</i></h3>
      {p.recent.map(c => <div key={c.sha} className={`oi-gc-commit${p.selectedSha === c.sha ? " sel" : ""}`} role="button" tabIndex={0} aria-pressed={p.selectedSha === c.sha} onClick={() => p.onSelectCommit(c.sha)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.onSelectCommit(c.sha); } }}>
        <Subject subject={c.subject} onThread={p.onThread} />
        <span className="oi-gc-meta" title={c.author}>{c.author || "—"}</span>
        <span className="oi-gc-meta age">{relativeAge(c.committedAt, now)}</span>
        <span className="oi-gc-sha">{shortSha(c.sha)}</span>
      </div>)}
    </section>
  </div>;
}

export const gitChangesStyles = `
.oi-gc{height:100%;overflow:auto;color:var(--oi-text);background:var(--oi-bg);font-size:12px}
.oi-gc-note{margin:0;padding:6px 8px;color:var(--oi-tone-muted)}
.oi-gc-note.err{color:var(--oi-tone-failure)}
.oi-gc-note.warn{color:var(--oi-tone-attention)}
.oi-gc-head{display:flex;gap:10px;align-items:baseline;padding:4px 8px;border-bottom:1px solid var(--oi-border);background:var(--oi-panel)}
.oi-gc-up{color:var(--oi-tone-muted)}
.oi-gc-h{margin:0;padding:3px 8px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--oi-tone-muted);border-bottom:1px solid var(--oi-border)}
.oi-gc-h i{font-style:normal;font-weight:400}
.oi-gc-file{display:flex;gap:8px;align-items:center;height:20px;padding:0 8px}
.oi-gc-file:hover,.oi-gc-commit:hover{background:var(--oi-hover)}
.oi-gc-code{flex:none;width:1.4ch;text-align:center;font-family:ui-monospace,monospace;font-weight:600}
.oi-gc-code.cM{color:var(--oi-tone-attention)}.oi-gc-code.cA,.oi-gc-code.c\\?{color:var(--oi-tone-success)}
.oi-gc-code.cD,.oi-gc-code.cU{color:var(--oi-tone-failure)}.oi-gc-code.cR{color:var(--oi-tone-info)}
.oi-gc-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace}
.oi-gc-commit{display:flex;gap:8px;align-items:center;height:22px;padding:0 8px;white-space:nowrap;cursor:pointer;outline-offset:-1px}
.oi-gc-commit.sel{background:var(--oi-selected)}
.oi-gc-commit:focus-visible{outline:1px solid var(--oi-tone-info)}
.oi-gc-meta{flex:none;max-width:110px;overflow:hidden;text-overflow:ellipsis;color:var(--oi-tone-muted)}
.oi-gc-meta.age{width:5.5ch;text-align:right}
.oi-gc-sha{flex:none;font-family:ui-monospace,monospace;color:var(--oi-tone-muted)}
`;
