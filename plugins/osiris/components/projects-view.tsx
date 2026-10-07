import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { ProjectsRead } from "../projects-feed.ts";
import { badgeCounts, groupOf, projectSearchText, todayKey, type Outcome, type SpineV2, type Work } from "../projects.ts";
import { headerModel, HEALTH_RULES, projectsBodyState, staleLegend } from "../projects-board.ts";
import { Board, type ProjectSelection } from "./projects/board.tsx";
import { Portfolio } from "./projects/portfolio.tsx";
import { projectsBoardStyles } from "./projects/styles.ts";

export type { ProjectSelection };
const dash = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

function Pb({ b }: { b: "V" | "S" | "I" }) { return <span className={`oi-pj-pb ${b}`}>{b}</span>; }

/** Projects tab: portfolio table -> per-project board. Read-only; the data is whatever `*.spine.json` files the configured folder holds.
 * Pill, query and the open board live HERE (not in the leader), so going back from a board returns to the same filtered portfolio. */
/** openRequest: another surface (left sidebar NEXT UP) asks to open a project's board with one card selected; a new nonce re-applies it. */
export type ProjectOpenRequest = { project: string; workId: string; nonce: number } | null;
export function ProjectsView(p: { dir: string | null; onDir(dir: string | null): void; selection: ProjectSelection; onSelect(s: ProjectSelection): void; openRequest?: ProjectOpenRequest; onOpenApplied?(): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [result, setResult] = useState<ProjectsRead | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [pill, setPill] = useState("all"), [query, setQuery] = useState(""), [open, setOpen] = useState<string | null>(null), [dim, setDim] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false), [folderOpen, setFolderOpen] = useState(false), [folderText, setFolderText] = useState(""), [folderErr, setFolderErr] = useState<string | null>(null);
  const generation = useRef(0), alive = useRef(true), input = useRef<HTMLInputElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const refresh = useCallback(async () => {
    if (!p.dir) return; // no folder picked yet: nothing to read, the body asks for one
    const gen = ++generation.current;
    setBusy(true);
    try {
      const r = (await rpc.call("projectSpines", p.dir ? { dir: p.dir } : {})) as ProjectsRead;
      if (alive.current && gen === generation.current) { setResult(r); setError(null); }
    } catch (e) { if (alive.current && gen === generation.current) { setResult(null); setError(e instanceof Error ? e.message : String(e)); } }
    finally { if (alive.current && gen === generation.current) setBusy(false); }
  }, [rpc, p.dir]);
  useEffect(() => { setResult(null); setError(null); void refresh(); }, [refresh]);

  const today = todayKey();
  const projects = result && result.state === "ok" ? result.projects : null;
  const applied = useRef(0);
  useEffect(() => {
    const r = p.openRequest; if (!r || !projects || applied.current === r.nonce) return;
    const spine = projects.find(x => x.project.id === r.project); if (!spine) { applied.current = r.nonce; p.onOpenApplied?.(); return; }
    applied.current = r.nonce; setOpen(spine.project.id); setDim(null);
    const work = spine.work.find(w => w.id === r.workId); p.onSelect(work ? { kind: "card", project: spine.project.id, work } : null); p.onOpenApplied?.();
  }, [p.openRequest, projects]);
  const rows = useMemo(() => (projects ?? []).map(s => ({ spine: s, group: groupOf(s.project.domain), text: projectSearchText(s, today) })), [projects, today]);
  useEffect(() => { if (pill !== "all" && rows.length > 0 && !rows.some(r => r.group === pill)) setPill("all"); }, [rows, pill]);
  const openSpine = projects?.find(s => s.project.id === open) ?? null;
  const portfolioVisible = !!projects && !openSpine;

  // ⌘K / Ctrl+K RULE: while the portfolio is mounted and visible, a document-level CAPTURE listener owns the shortcut — it
  // preventDefaults, stops propagation and focuses the PROJECT search, so Osiris's global ⌘K (header call search) does not
  // fire. On a board, in an empty/error state, or on any other tab this view registers nothing, so the global ⌘K is unchanged.
  useEffect(() => {
    if (!portfolioVisible) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target, editor = t instanceof Element && !!t.closest("textarea,[contenteditable=true],[data-native-chat],.oi-pj-folder");
      if (!editor && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); input.current?.focus(); input.current?.select(); }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [portfolioVisible]);

  const totals = useMemo(() => badgeCounts((projects ?? []).flatMap(s => s.work)), [projects]);
  const applyFolder = () => {
    const t = folderText.trim();
    if (t !== "" && (!t.startsWith("/") || t.includes("\0"))) { setFolderErr("Folder must be an absolute path (or empty to clear it)."); return; }
    setFolderErr(null); setFolderOpen(false); setOpen(null); p.onSelect(null); p.onDir(t === "" ? null : t);
  };

  const hm = headerModel(projects ? projects.length : null, result ? result.dir : p.dir);
  const header = (
    <div className="oi-pj-head">
      <span className="oi-pj-sum">{hm.label}</span>
      <button type="button" className="oi-pj-btn quiet" title={hm.folderTitle} onClick={() => { setFolderText(p.dir ?? ""); setFolderErr(null); setFolderOpen(o => !o); }} aria-expanded={folderOpen}>Folder…</button>
      <button type="button" className="oi-pj-btn quiet" onClick={() => void refresh()} disabled={busy} title="Re-read the folder" aria-label="Refresh projects">{busy ? "…" : "↻"}</button>
      <span className="oi-pj-help">
        <button type="button" className="oi-pj-btn quiet" aria-expanded={helpOpen} aria-label="What the colours and badges mean" title="What the colours and badges mean" onClick={() => setHelpOpen(o => !o)}>?</button>
        {helpOpen ? (
          <div className="oi-pj-pop" role="dialog" aria-label="Legend and health rules">
            <b>Health rules</b>
            <ul>{HEALTH_RULES.map(r => <li key={r.tone}><span className={`oi-pj-chip t-${r.tone}`}>{r.tone}</span> {r.rule}</li>)}</ul>
            <b>Badges</b>
            <ul><li><Pb b="V" /> verified by evidence</li><li><Pb b="S" /> stated by the author</li><li><Pb b="I" /> inferred or suggested</li></ul>
            {projects ? <p className="oi-pj-dim">Cards: V {totals.V} · S {totals.S} · I {totals.I}.</p> : null}
            <p className="oi-pj-dim">{staleLegend()}</p>
            <b>Card stripe</b>
            <p className="oi-pj-dim">Green ready or healthy · yellow needs attention · red blocked · grey later · purple review.</p>
          </div>
        ) : null}
      </span>
      {folderOpen ? (
        <form className="oi-pj-folder" onSubmit={e => { e.preventDefault(); applyFolder(); }}>
          <input value={folderText} onChange={e => setFolderText(e.target.value)} placeholder="Absolute path to your projects folder" aria-label="Project spine folder" spellCheck={false} autoFocus />
          <button type="submit" className="oi-pj-btn">Use</button>
          {folderErr ? <span className="oi-pj-err">{folderErr}</span> : null}
        </form>
      ) : null}
    </div>
  );

  const state = projectsBodyState({ error, result, dir: p.dir });
  let body;
  if (state.kind === "error") body = <p className="oi-pj-note oi-pj-err" role="alert">{state.text}. Check the folder, then press ↻ to try again.</p>;
  else if (state.kind === "empty") body = <p className="oi-pj-note">{state.text}. A spine file is a <code>*.spine.json</code> project status file; use Folder… to point at the folder that holds them.</p>;
  else if (state.kind !== "ok" || !result || result.state !== "ok") body = <p className="oi-pj-note">{state.text}</p>;
  else if (openSpine) body = <Board spine={openSpine} today={today} dim={dim} setDim={setDim} selection={p.selection} onSelect={p.onSelect} onBack={() => { setOpen(null); setDim(null); }} />;
  else body = <Portfolio rows={rows} today={today} pill={pill} setPill={setPill} query={query} setQuery={setQuery} input={input} invalid={result.invalid} onOpen={id => { setOpen(id); setDim(null); p.onSelect(null); }} />;

  return <div className="oi-pj">{header}{body}</div>;
}

const FIELDS_WORK = ["title", "state_line", "next_action", "status", "horizon", "waiting_on", "date", "provenance", "verification", "evidence", "refs", "detail", "source", "outcome"] as const;
const FIELDS_OUTCOME = ["title", "summary", "horizon", "status", "provenance", "verification", "evidence", "source"] as const;
const show = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.join("\n") : "—";
  if (typeof v === "object") { const d = v as { value?: unknown; kind?: unknown }; return d.value ? `${d.value}${d.kind ? ` (${d.kind})` : ""}` : "—"; }
  return String(v);
};

/** Right-pane detail for the selected card or outcome; every field is shown, absence is `—`. */
export function ProjectInspector(p: { selection: ProjectSelection }) {
  const sel = p.selection;
  if (!sel) return <div className="oi-pj-insp"><p className="oi-pj-dim">Select a card or outcome to see its detail.</p></div>;
  const rec = (sel.kind === "card" ? sel.work : sel.outcome) as unknown as Record<string, unknown>;
  const fields = sel.kind === "card" ? FIELDS_WORK : FIELDS_OUTCOME;
  return (
    <div className="oi-pj-insp">
      <h3>{show(rec.title)}</h3>
      <div className="oi-pj-dim">{sel.kind === "card" ? "work" : "outcome"} · {sel.project} · {show(rec.id)}</div>
      {fields.filter(k => k !== "title").map(k => (<div key={k}><div className="oi-pj-k">{k}</div><pre>{show(rec[k])}</pre></div>))}
    </div>
  );
}

export const projectsViewStyles = `
.oi-pj,.oi-pj-insp{display:flex;flex-direction:column;gap:6px;min-width:0;min-height:0;color:var(--oi-text);font-size:11px;padding:8px 12px;overflow:auto}.oi-pj{flex:1;height:100%}
.oi-pj-insp{border-left:1px solid var(--oi-border)}.oi-pj-insp h3{margin:0;font-size:13px}.oi-pj-insp pre{margin:0 0 6px;white-space:pre-wrap;word-break:break-word;font:inherit}
.oi-pj button,.oi-pj input{font:inherit;color:inherit}
.oi-pj-head{position:relative;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;flex:none;color:var(--oi-tone-muted)}.oi-pj-sum{min-width:0}
.oi-pj-path{font-family:monospace;word-break:break-all;color:var(--oi-text)}.oi-pj-dim{color:var(--oi-tone-muted)}.oi-pj-err{color:var(--oi-tone-failure)}.oi-pj-small{font-size:10.5px}
.oi-pj-btn{background:transparent;border:1px solid var(--oi-border);padding:1px 8px;cursor:pointer;color:var(--oi-text)}.oi-pj-btn:hover:not(:disabled){background:var(--oi-hover)}.oi-pj-btn:disabled{opacity:.5;cursor:default}
.oi-pj-folder{display:flex;flex-basis:100%;gap:6px;align-items:center}.oi-pj-folder input{flex:1;min-width:0;background:var(--oi-bg);border:1px solid var(--oi-border);padding:3px 6px;color:var(--oi-text)}
.oi-pj-note{color:var(--oi-tone-muted);margin:6px 0}
.oi-pj-ctl{position:sticky;top:-8px;z-index:2;display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:6px 0;background:var(--oi-bg);border-bottom:1px solid var(--oi-border)}
.oi-pj-pills{display:flex;gap:4px;overflow-x:auto}.oi-pj-pill{flex:none;display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border:1px solid transparent;border-radius:999px;background:transparent;color:var(--oi-tone-muted);cursor:pointer}
.oi-pj-pill:hover{background:var(--oi-hover);color:var(--oi-text)}.oi-pj-pill[aria-selected="true"]{background:var(--oi-selected);border-color:var(--oi-border);color:var(--oi-text)}.oi-pj-pc{color:var(--oi-tone-muted);font-variant-numeric:tabular-nums}.oi-pj-pill[aria-selected="true"] .oi-pj-pc{color:var(--oi-tone-info)}
.oi-pj-search{display:flex;align-items:center;gap:6px;flex:1 1 220px;max-width:420px;margin-left:auto;padding:0 8px;border:1px solid var(--oi-border);background:var(--oi-panel)}.oi-pj-search:focus-within{border-color:var(--oi-tone-info)}
.oi-pj-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;padding:5px 0;color:var(--oi-text)}.oi-pj-search kbd{font:inherit;font-size:10px;color:var(--oi-tone-muted)}
.oi-pj-x{background:transparent;border:0;cursor:pointer;color:var(--oi-tone-muted);font-size:14px;padding:0 3px}.oi-pj-x:hover{color:var(--oi-text)}
.oi-pj-count{margin:2px 0;color:var(--oi-tone-muted)}
.oi-pj-empty{padding:32px 12px;text-align:center}.oi-pj-empty p{color:var(--oi-tone-muted)}
.oi-pj-scroll{overflow:auto;min-width:0;flex:1}
`+projectsBoardStyles;
