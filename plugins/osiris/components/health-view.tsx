import { healthContext } from "../work/ask-agent/index.ts";
import { useEffect, useRef, useState } from "react";
import { DEMO_OFF, useDemoOn } from "../demo/client.ts";
import type { HealthFix, HealthRow, Trend } from "../health-types.ts";
import { copyAllTask, fileGroups, groupRows, primaryActionLabel } from "../health-groups.ts";
import { copyWithToast } from "../work/copy-toast.ts";
import { SeamsHealthGroup } from "./seams-panel.tsx";
import type { SeamReport } from "../work/seam-guards/types.ts";
import { critCount } from "../work/seam-guards/surface.ts";
import { agentTask, barWidth, behindText, headerLine, multipleLabel, passLine, trendLabel, STATUS_WORD } from "../health-ui.ts";


/** Select a node's text so the owner can copy by hand when the clipboard API refuses. */
function selectText(el: HTMLElement | null) {
  try { if (!el) return; const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r); } catch { /* selection unavailable */ }
}

/** Copy-to-clipboard with the shared "Copied" flash; `onFail` runs when the clipboard API refuses. */
function useCopy() {
  const [copied, setCopied] = useState(false), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async (text: string, onFail?: () => void) => {
    try { if (!(await copyWithToast(text, 1))) throw new Error("clipboard"); setCopied(true); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1500); }
    catch { onFail?.(); }
  };
  return { copied, copy };
}

/** "Copy as agent task": a sibling of the row's select button, never nested inside it. */
function TaskButton({ row }: { row: HealthRow }) {
  const { copied, copy } = useCopy();
  return <div className="oi-hv-task"><button type="button" className="oi-hv-copy" onClick={() => copy(agentTask(row))} aria-label={`Copy ${row.title} as an agent task`}>{copied ? "Copied" : "Copy as agent task"}</button></div>;
}

/** The fix label, plus a command and its own Copy button (never nested in the row's select button). */
function FixArea({ fix }: { fix: HealthFix }) {
  const code = useRef<HTMLElement>(null), { copied, copy: doCopy } = useCopy();
  const copy = () => { if (fix.command) void doCopy(fix.command, () => selectText(code.current)); };
  return <div className="oi-hv-fix">
    <span className="oi-hv-fixl">{fix.label}</span>
    {fix.command && <span className="oi-hv-cmd"><code ref={code}>{fix.command}</code><button type="button" className="oi-hv-copy" onClick={copy} aria-label={`Copy command: ${fix.command}`}>{copied ? "Copied" : "Copy"}</button></span>}
  </div>;
}

/** The delta as a small chip: "▲ +64 since you last looked". */
function TrendChip({ t }: { t: Trend }) {
  return <span className={`oi-hv-trend ${t.direction}`} title={t.since}>{t.direction === "same" ? trendLabel(t) : `${trendLabel(t)} since you last looked`}</span>;
}

function Bar({ row }: { row: HealthRow }) {
  const r = row.ratio as number;
  return <span className={`oi-hv-bar ${row.status}`} role="img" aria-label={`${multipleLabel(r)}; log scale, the limit is the midline`}>
    <span className="oi-hv-track"><span className="oi-hv-fill" style={{ width: `${barWidth(r)}%` }} /><i className="oi-hv-mid" /></span>
    <small>{multipleLabel(r)}</small>
  </span>;
}

/** The ONE primary button: hands the item to `onDispatch` when the host wires one, else copies it as an agent task. */
function PrimaryAction({ row, onDispatch }: { row: HealthRow; onDispatch?(task: string): void }) {
  const { copied, copy } = useCopy(), demo = useDemoOn() && !!onDispatch; // copying a task is harmless; STARTING an agent is not
  const run = () => { const task = healthContext(row).prompt; if (onDispatch) onDispatch(task); else void copy(task); };
  return <button type="button" className="oi-hv-act" disabled={demo} title={demo ? DEMO_OFF : undefined} onClick={run} aria-label={`${primaryActionLabel(row)}: ${row.title}`}>{copied ? "Copied task" : primaryActionLabel(row)}</button>;
}

/** The raw command and its Copy live behind a disclosure; the fix label stays visible. */
function Details({ row }: { row: HealthRow }) {
  if (!row.fix?.command && row.status === "pass") return null;
  return <details className="oi-hv-details"><summary>Details</summary>
    {row.fix && <FixArea fix={row.fix} />}
    {row.status !== "pass" && <TaskButton row={row} />}
  </details>;
}

function Item({ row, sel, onSelect, onDispatch }: { row: HealthRow; sel: boolean; onSelect(id: string): void; onDispatch?(task: string): void }) {
  return <div className={`oi-hv-item ${row.status}${sel ? " sel" : ""}`}>
    <button type="button" className="oi-hv-sel" aria-pressed={sel} onClick={() => onSelect(row.id)}>
      <span className="oi-hv-h"><span className={`oi-hv-dot ${row.status}`} role="img" aria-label={STATUS_WORD[row.status]} title={STATUS_WORD[row.status]} /><b>{row.title}</b>{row.trend && <TrendChip t={row.trend} />}</span>
      <span className="oi-hv-fig">{row.figure}</span>
      {row.ratio != null && <Bar row={row} />}
    </button>
    {row.why && <p className="oi-hv-why">{row.why}</p>}
    <div className="oi-hv-acts"><PrimaryAction row={row} onDispatch={onDispatch} /></div>
    <Details row={row} />
  </div>;
}

function CopyAll({ rows }: { rows: HealthRow[] }) {
  const { copied, copy } = useCopy();
  return <button type="button" className="oi-hv-refresh" onClick={() => copy(copyAllTask(rows))}>{copied ? "Copied" : "Copy all as agent task"}</button>;
}

export function HealthBoard(p: {
  rows: HealthRow[]; header: { branch: string; shortHead: string; generatedAgo: string | null; behind: { count: number; capped: boolean } | null };
  selectedId: string | null; onSelect(id: string): void; onRefresh(): void; busy: boolean; note?: string | null;
  /** Integration seam: a parallel lane owns the herdr dispatch primitive. When set, each item's primary button sends its agent task here. */
  onDispatch?(task: string): void;
  /** Runtime seam guards: a crit group renders above everything else, and "No blockers" is never said while one is broken. */
  seams?: SeamReport | null;
}) {
  const [showOk, setShowOk] = useState<Record<string, boolean>>({});
  const open = p.rows.filter(r => r.status !== "pass"), b = behindText(p.header.behind), groups = groupRows(p.rows);
  return <div className="oi-hv">
    <div className="oi-hv-head">
      <span className="oi-hv-hl" title={headerLine(p.header)}>{headerLine(p.header)}</span>
      <span className={`oi-hv-chip ${b.tone}`}>{b.text}</span>
      {open.length > 0 && <CopyAll rows={p.rows} />}
      <button type="button" className="oi-hv-refresh" disabled={p.busy} title="Refreshes automatically when HEAD moves" onClick={p.onRefresh}>{p.busy ? "Refreshing…" : "Refresh"}</button>
    </div>
    {p.note && <p className="oi-hv-note" role="status">{p.note}</p>}
    <SeamsHealthGroup report={p.seams ?? null} />
    {open.length === 0 && critCount(p.seams ?? null) === 0 && <p className="oi-hv-calm">No blockers.</p>}
    {groups.map(g => g.collapsed
      ? <section key={g.id}>
          <button type="button" className="oi-hv-pass" aria-expanded={!!showOk[g.id]} onClick={() => setShowOk(v => ({ ...v, [g.id]: !v[g.id] }))}><span className="oi-hv-ok" aria-hidden="true">✓</span> {g.title} — {g.verdict}</button>
          {showOk[g.id] && <ul className="oi-hv-plist">{g.rows.map(r => <li key={r.id}><button type="button" className={`oi-hv-prow${r.id === p.selectedId ? " sel" : ""}`} aria-pressed={r.id === p.selectedId} onClick={() => p.onSelect(r.id)}><span className="oi-hv-ok" aria-hidden="true">✓</span><span className="oi-hv-pt">{r.title}</span><small>{r.figure}</small></button></li>)}</ul>}
        </section>
      : <section key={g.id}><h3 className="oi-hv-sh">{g.title} <i>{g.verdict}</i></h3>{g.open.map(r => <Item key={r.id} row={r} sel={r.id === p.selectedId} onSelect={p.onSelect} onDispatch={p.onDispatch} />)}</section>)}
  </div>;
}

/** The uncommitted file list as readable lines: top-level dir with a count, first 10 paths, then "+N more". */
function FileList({ list }: { list: string }) {
  const g = fileGroups(list);
  return <div className="oi-hv-files">{g.groups.map(d => <div key={d.dir} className="oi-hv-fg"><b>{d.dir === "." ? "(repo root)" : `${d.dir}/`} <small>{d.count}</small></b>
    <ul>{d.files.map(f => <li key={f}><code>{f}</code></li>)}</ul></div>)}
    {g.more > 0 && <p className="oi-hv-more">+{g.more} more</p>}
  </div>;
}

export function HealthInspector(p: { row: HealthRow | null; isDefault: boolean; onRefresh?(): void }) {
  const r = p.row;
  if (!r) return <div className="oi-hv oi-hv-insp"><p className="oi-hv-calm">No blockers right now.</p>{p.onRefresh && <button type="button" className="oi-hv-refresh" onClick={p.onRefresh}>Refresh</button>}</div>;
  const listDetail = r.id === "git:uncommitted" && r.detail;
  return <div className="oi-hv oi-hv-insp">
    {p.isDefault && <span className="oi-hv-eyebrow">Top fix</span>}
    <h2 className="oi-hv-it"><span className={`oi-hv-dot ${r.status}`} role="img" aria-label={STATUS_WORD[r.status]} title={STATUS_WORD[r.status]} /> {r.title}</h2>
    <p className="oi-hv-fig">{r.figure}</p>
    {r.why && <p className="oi-hv-why">{r.why}</p>}
    {r.fix && <FixArea fix={r.fix} />}
    <TaskButton row={r} />
    {listDetail ? <FileList list={listDetail} /> : r.detail && <pre className="oi-hv-detail">{r.detail}</pre>}
    {r.trend && <p className="oi-hv-tl"><TrendChip t={r.trend} /> <span>since {r.trend.since}</span></p>}
  </div>;
}

/** Install beside the other style blocks; tokens only. */
export const healthViewStyles = `
.oi-hv{box-sizing:border-box;min-width:0;max-width:100%;padding:8px;color:var(--oi-text);font-size:12px;overflow-wrap:anywhere}
.oi-hv-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding-bottom:6px;border-bottom:1px solid var(--oi-border)}
.oi-hv-hl{flex:1 1 auto;min-width:0;font-family:ui-monospace,monospace;color:var(--oi-tone-muted)}
.oi-hv-chip{flex:none;padding:0 6px;border:1px solid var(--oi-border);font-size:11px;color:var(--oi-tone-muted)}.oi-hv-chip.pass{color:var(--oi-tone-success)}.oi-hv-chip.warn{color:var(--oi-tone-attention)}
.oi-hv-refresh,.oi-hv-copy{flex:none;padding:1px 8px;background:transparent;border:1px solid var(--oi-border);color:var(--oi-tone-info);font:inherit;cursor:pointer}
.oi-hv-refresh:hover:not(:disabled),.oi-hv-copy:hover{background:var(--oi-hover)}.oi-hv-refresh:disabled{color:var(--oi-tone-muted);cursor:default}
.oi-hv-refresh:focus-visible,.oi-hv-copy:focus-visible,.oi-hv-sel:focus-visible,.oi-hv-pass:focus-visible,.oi-hv-prow:focus-visible{outline:1px solid var(--oi-tone-info);outline-offset:-1px}
.oi-hv-note{margin:6px 0;color:var(--oi-tone-attention)}.oi-hv-calm{margin:10px 0;color:var(--oi-tone-muted)}
.oi-hv-sh{margin:12px 0 4px;font-size:11px;font-weight:600;color:var(--oi-tone-muted);text-transform:uppercase;letter-spacing:.04em}.oi-hv-sh i{font-style:normal;font-weight:400}
.oi-hv-item{margin:4px 0;border-left:2px solid var(--oi-tone-attention)}.oi-hv-item.fail{border-left-color:var(--oi-tone-failure)}.oi-hv-item:hover{background:var(--oi-hover)}.oi-hv-item.sel{background:var(--oi-selected)}
.oi-hv-sel{display:flex;flex-direction:column;gap:2px;width:100%;box-sizing:border-box;text-align:left;background:transparent;border:0;padding:4px 8px;color:inherit;font:inherit;cursor:pointer;overflow-wrap:anywhere}
.oi-hv-h{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;min-width:0}.oi-hv-h b{min-width:0}
.oi-hv-st{font-size:10px;font-weight:700;color:var(--oi-tone-attention)}.oi-hv-st.fail{color:var(--oi-tone-failure)}.oi-hv-st.pass{color:var(--oi-tone-success)}.oi-hv-st.unknown{color:var(--oi-tone-muted)}
.oi-hv-fig{color:var(--oi-tone-muted);margin:0}
.oi-hv-trend{padding:0 5px;border:1px solid var(--oi-border);font-size:10px;color:var(--oi-tone-muted)}.oi-hv-trend.worse{color:var(--oi-error);border-color:var(--oi-error)}.oi-hv-trend.better{color:var(--oi-tone-success);border-color:var(--oi-tone-success)}
.oi-hv-bar{display:flex;align-items:center;gap:8px;max-width:100%;margin-top:2px}.oi-hv-track{position:relative;flex:1 1 60px;min-width:40px;max-width:300px;height:8px;background:var(--oi-panel);border:1px solid var(--oi-border);box-sizing:border-box}
.oi-hv-fill{display:block;height:100%;background:var(--oi-tone-attention)}.oi-hv-bar.fail .oi-hv-fill{background:var(--oi-tone-failure)}.oi-hv-mid{position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:var(--oi-text)}
.oi-hv-bar small{flex:none;font-size:10px;color:var(--oi-tone-muted);white-space:nowrap}
.oi-hv-why{margin:0;padding:0 8px 2px;color:var(--oi-text)}
.oi-hv-task{padding:0 8px 6px}.oi-hv-insp .oi-hv-task{padding-left:0;padding-right:0}
.oi-hv-fix{display:flex;flex-direction:column;gap:3px;padding:2px 8px 6px}.oi-hv-fixl{color:var(--oi-tone-info)}
.oi-hv-cmd{display:flex;align-items:flex-start;gap:6px;min-width:0}.oi-hv-cmd code{flex:1 1 auto;min-width:0;padding:2px 6px;background:var(--oi-panel);border:1px solid var(--oi-border);font-family:ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;user-select:all}
.oi-hv-pass{display:block;width:100%;margin-top:12px;text-align:left;background:transparent;border:0;padding:3px 0;color:var(--oi-tone-muted);font:inherit;cursor:pointer;overflow-wrap:anywhere}.oi-hv-pass:hover{color:var(--oi-text)}
.oi-hv-plist{list-style:none;margin:2px 0 0;padding:0}
.oi-hv-prow{display:flex;align-items:baseline;gap:8px;width:100%;box-sizing:border-box;text-align:left;background:transparent;border:0;padding:2px 8px;color:inherit;font:inherit;cursor:pointer}.oi-hv-prow:hover{background:var(--oi-hover)}.oi-hv-prow.sel{background:var(--oi-selected)}
.oi-hv-ok{flex:none;color:var(--oi-tone-success)}.oi-hv-pt{flex:1;min-width:0;overflow-wrap:anywhere}.oi-hv-prow small{color:var(--oi-tone-muted);overflow-wrap:anywhere;text-align:right}
.oi-hv-eyebrow{display:inline-block;margin-bottom:4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--oi-accent)}
.oi-hv-insp .oi-hv-why,.oi-hv-insp .oi-hv-fix{padding-left:0;padding-right:0}.oi-hv-it{margin:0 0 4px;font-size:13px;font-weight:600}
.oi-hv-detail{margin:8px 0;padding:6px 8px;background:var(--oi-input,transparent);border-left:2px solid var(--oi-border-strong,var(--oi-border));font-family:ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;box-sizing:border-box}
.oi-hv-tl{margin:6px 0;color:var(--oi-tone-muted)}
.oi-hv-dot{display:inline-block;flex:none;width:8px;height:8px;border-radius:50%;background:var(--oi-tone-attention);align-self:center}.oi-hv-dot.fail{background:var(--oi-tone-failure)}.oi-hv-dot.pass{background:var(--oi-tone-success)}.oi-hv-dot.unknown{background:var(--oi-tone-muted)}
.oi-hv-sh i{margin-left:6px;color:var(--oi-tone-attention)}
.oi-hv-acts{padding:2px 8px 4px}.oi-hv-act{padding:2px 10px;background:transparent;border:1px solid var(--oi-tone-info);color:var(--oi-tone-info);font:inherit;cursor:pointer}.oi-hv-act:hover{background:var(--oi-hover)}.oi-hv-act:focus-visible,.oi-hv-details summary:focus-visible{outline:1px solid var(--oi-tone-info);outline-offset:-1px}
.oi-hv-details{padding:0 8px 6px;color:var(--oi-tone-muted)}.oi-hv-details summary{cursor:pointer;width:max-content}.oi-hv-details .oi-hv-fix,.oi-hv-details .oi-hv-task{padding-left:0;padding-right:0}
.oi-hv-files{margin:8px 0}.oi-hv-fg{margin:0 0 6px}.oi-hv-fg ul{list-style:none;margin:2px 0 0;padding:0 0 0 10px}.oi-hv-fg code{font-family:ui-monospace,monospace;color:var(--oi-text)}.oi-hv-fg small,.oi-hv-more{color:var(--oi-tone-muted)}.oi-hv-more{margin:2px 0}
`;
