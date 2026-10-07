import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { FileDiff, GitResult } from "../git-types.ts";
import type { WriteOp } from "../work/git-write-rules.ts";
import { needsCleanTree, patchFileName, takesName, validRefName } from "../work/git-write-rules.ts";
import { scrub } from "../commit-actions.ts";
import { shortSha } from "../git-ui.ts";
import { cleanText } from "../work/sanitize.ts";
import { DiffView } from "./commit-inspector.tsx";

/** What the commit menu asked for. A NAME plus the sha: the server builds and validates the argv (threat model A1/A2). */
export type GitDialogAction = { kind: "compare-local"; sha: string } | { kind: "save-patch"; sha: string } | { kind: "git-write"; op: WriteOp; sha: string };
type Preview = { op: WriteOp; repo: string; branch: string | null; sha: string; shortSha: string; command: string; confirmWith: string | null; blocked: string | null; token: string | null };
type LocalDiff = { files: FileDiff[]; filesTruncated: boolean };

const TITLES: Record<string, string> = { "compare-local": "Compare to local changes", "save-patch": "Save as patch", "new-branch": "New branch", "new-tag": "New tag", checkout: "Checkout commit", "cherry-pick": "Cherry-pick commit", revert: "Revert commit" };
/** Shown for every action that lets git touch the working tree or create a commit (and for Compare): the one execution risk the confirm cannot show. */
const PROGRAMS_NOTE = "Git runs programs that a repository's own config names (filter drivers, a GPG signing program), even while it checks state. Osiris refuses this action when the repository defines one; hooks are always off.";
const EFFECT: Record<WriteOp, string> = {
  "new-branch": "Adds a local branch pointing at this commit. Nothing else moves.",
  "new-tag": "Adds a local lightweight tag at this commit. It is never pushed.",
  checkout: "Detaches HEAD at this commit. Refused if tracked files have uncommitted changes.",
  "cherry-pick": "Adds this commit's change as a NEW commit on the current branch. Aborted automatically on a conflict.",
  revert: "Adds a NEW commit on the current branch that undoes this commit. Aborted automatically on a conflict.",
};

/** One dialog for the menu's git items. compare-local and save-patch are read-only; git-write previews the exact command, shows the repo and
 * branch, and needs a typed short sha for checkout/cherry-pick/revert. It decides nothing: every rule is enforced again on the server. */
export function GitWriteDialog(p: { repo: string; action: GitDialogAction; subject: string; onClose(): void; onDone(): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const { action } = p, op = action.kind === "git-write" ? action.op : null;
  const [name, setName] = useState(""), [typed, setTyped] = useState(""), [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null), [done, setDone] = useState<string | null>(null);
  const [pv, setPv] = useState<Preview | null>(null), [diff, setDiff] = useState<LocalDiff | null>(null), [patch, setPatch] = useState<string | null>(null);
  const alive = useRef(true), box = useRef<HTMLDivElement>(null);
  useEffect(() => { alive.current = true; box.current?.focus(); return () => { alive.current = false; }; }, []);
  const settle = <T,>(r: GitResult<T>, ok: (v: T) => void) => { if (!alive.current) return; setBusy(false); if (r.ok) { setErr(null); ok(r.value); } else setErr(r.reason); };
  const fail = () => { if (alive.current) { setBusy(false); setErr("the request failed"); } };
  const review = () => {
    if (!op) return;
    setBusy(true); setPv(null); setTyped("");
    (rpc.call("gitWritePreview", { repo: p.repo, op, sha: action.sha, ...(takesName(op) ? { name } : {}) }) as Promise<GitResult<Preview>>).then(r => settle(r, setPv), fail);
  };
  useEffect(() => {
    setBusy(true);
    if (action.kind === "compare-local") (rpc.call("gitLocalDiff", { repo: p.repo, sha: action.sha }) as Promise<GitResult<LocalDiff>>).then(r => settle(r, setDiff), fail);
    else if (action.kind === "save-patch") (rpc.call("gitFormatPatch", { repo: p.repo, sha: action.sha }) as Promise<GitResult<string>>).then(r => settle(r, setPatch), fail);
    else if (op && !takesName(op)) review();
    else setBusy(false);
  }, []);
  const run = () => {
    if (!pv?.token || !op) return;
    setBusy(true);
    (rpc.call("gitWriteRun", { repo: p.repo, op, sha: action.sha, ...(takesName(op) ? { name } : {}), token: pv.token, ...(pv.confirmWith ? { confirm: typed } : {}) }) as Promise<{ ok: true; message: string } | { ok: false; reason: string }>).then(r => {
      if (!alive.current) return; setBusy(false); setPv(null);
      if (r.ok) { setDone(r.message); p.onDone(); } else setErr(r.reason);
    }, fail);
  };
  const save = () => {
    if (patch === null) return;
    const a = document.createElement("a"), url = URL.createObjectURL(new Blob([patch], { type: "text/x-patch" }));
    a.href = url; a.download = patchFileName(action.sha, p.subject); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDone(`Saved ${a.download} through your browser's download`);
  };
  const nameOk = !op || !takesName(op) || validRefName(name);
  const canRun = !!pv?.token && !pv.blocked && !busy && (!pv.confirmWith || typed.trim() === pv.confirmWith);
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); p.onClose(); } };
  const title = TITLES[op ?? action.kind];
  return <div className="oi-gw-back"><div ref={box} tabIndex={-1} className="oi-gw" role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKey}>
    <div className="oi-gw-title">{title} <span className="oi-gw-sha">{shortSha(action.sha)}</span></div>
    <div className="oi-gw-sub" title={p.subject}>{cleanText(p.subject)}</div>
    {op && <p className="oi-gw-eff">{EFFECT[op]}</p>}
    {((op && needsCleanTree(op)) || action.kind === "compare-local") && <p className="oi-gw-eff" data-note="programs">{PROGRAMS_NOTE}</p>}
    {op && takesName(op) && !done && <div className="oi-gw-row">
      <input className="oi-gw-in" autoFocus placeholder={op === "new-tag" ? "tag name" : "branch name"} aria-label={op === "new-tag" ? "Tag name" : "Branch name"} value={name} maxLength={200}
        onChange={e => { setName(e.target.value); setPv(null); setErr(null); }} onKeyDown={e => { if (e.key === "Enter" && nameOk && !busy) review(); }} />
      <button type="button" className="oi-gw-btn" disabled={!nameOk || busy} onClick={review}>Review</button>
    </div>}
    {op && name !== "" && !nameOk && !done && <div className="oi-gw-warn" role="alert">Use letters, digits and . _ - / only; it cannot start with a dash.</div>}
    {pv && !done && <div className="oi-gw-box">
      <div className="oi-gw-k">Command</div><code className="oi-gw-cmd">{cleanText(pv.command)}</code>
      <div className="oi-gw-k">Repository</div><div>{cleanText(scrub(pv.repo))}</div>
      <div className="oi-gw-k">Current branch</div><div>{pv.branch ? cleanText(pv.branch) : "(detached HEAD)"}</div>
      {pv.blocked && <div className="oi-gw-warn" role="alert">{cleanText(pv.blocked)}</div>}
      {pv.confirmWith && !pv.blocked && <label className="oi-gw-k">Type <b>{pv.confirmWith}</b> to confirm
        <input className="oi-gw-in" autoFocus value={typed} maxLength={16} aria-label="Type the short commit id to confirm" onChange={e => setTyped(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && canRun) run(); }} /></label>}
    </div>}
    {action.kind === "compare-local" && diff && <div className="oi-gw-diffs">
      {diff.files.length === 0 ? <p className="oi-gw-eff">No tracked file differs from this commit.</p> : diff.files.map(f => <DiffView key={f.path} diff={f} />)}
      {diff.filesTruncated && <p className="oi-gw-warn">Only the first files are shown.</p>}
      <p className="oi-gw-eff">Tracked files only: the working tree compared with this commit.</p>
    </div>}
    {action.kind === "save-patch" && patch !== null && !done && <p className="oi-gw-eff">Patch ready ({patch.length.toLocaleString()} characters). Your browser chooses where it is saved.</p>}
    {busy && <div className="oi-gw-eff" role="status">Working…</div>}
    {err && <div className="oi-gw-warn" role="alert">{cleanText(err)}</div>}
    {done && <div className="oi-gw-ok" role="status">{cleanText(done)}</div>}
    <div className="oi-gw-actions">
      {action.kind === "save-patch" && patch !== null && !done && <button type="button" className="oi-gw-btn go" onClick={save}>Save patch</button>}
      {op && pv && !done && <button type="button" className="oi-gw-btn go" disabled={!canRun} onClick={run}>{op === "new-branch" ? "Create branch" : op === "new-tag" ? "Create tag" : title}</button>}
      <button type="button" className="oi-gw-btn" onClick={p.onClose}>{done ? "Close" : "Cancel"}</button>
    </div>
  </div></div>;
}

export const gitWriteDialogStyles = `
.oi-gw-back{position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;background:var(--oi-shadow)}
.oi-gw{max-width:min(760px,92vw);max-height:86vh;overflow:auto;min-width:340px;padding:12px 16px;color:var(--oi-text);background:var(--oi-raised);border:1px solid var(--oi-border);font-size:12px;outline:none}
.oi-gw-title{font-weight:600;font-size:13px}.oi-gw-sha{font-family:ui-monospace,monospace;color:var(--oi-tone-muted);font-weight:400}
.oi-gw-sub{color:var(--oi-tone-muted);margin:2px 0 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oi-gw-eff{color:var(--oi-tone-muted);margin:6px 0}
.oi-gw-row{display:flex;gap:6px;margin:6px 0}
.oi-gw-in{flex:1;font:inherit;padding:3px 6px;color:inherit;background:var(--oi-panel);border:1px solid var(--oi-border)}
.oi-gw-box{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:8px 0;padding:8px 0;border-top:1px solid var(--oi-border);border-bottom:1px solid var(--oi-border)}
.oi-gw-k{color:var(--oi-tone-muted)}.oi-gw-box label.oi-gw-k{grid-column:1 / -1;display:flex;gap:8px;align-items:center}
.oi-gw-cmd{font-family:ui-monospace,monospace;word-break:break-all}
.oi-gw-warn{grid-column:1 / -1;margin:6px 0;color:var(--oi-tone-failure)}
.oi-gw-ok{margin:6px 0;color:var(--oi-tone-success)}
.oi-gw-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
.oi-gw-btn{font:inherit;padding:3px 12px;color:inherit;background:transparent;border:1px solid var(--oi-border);cursor:pointer}
.oi-gw-btn.go{background:var(--oi-selected)}
.oi-gw-btn:disabled{color:var(--oi-tone-muted);cursor:not-allowed}
.oi-gw-btn:focus-visible,.oi-gw-in:focus-visible{outline:1px solid var(--oi-tone-info);outline-offset:-1px}
`;
