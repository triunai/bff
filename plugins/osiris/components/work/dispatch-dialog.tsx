import { useEffect, useRef, useState } from "react";
import { MenuSelect } from "../ui/menu-select.tsx";
import { pickFromPool, shortId } from "../../work/surface-model.ts";
import type { DispatchPreview, DispatchRequest, DispatchResult, Pools, Runtime } from "../../work/surface-types.ts";
import { capitalise, firstUse, termLabel } from "../../work/glossary.ts";
import { dispatchResultText, dispatchStatement, isThrottledPreview, previewErrorText } from "../../work/ui-text.ts";
import { RUNTIMES, SUGGESTED_MODELS, canConfirm, selectionKey } from "../../work/runtime-models.ts";

export type DispatchDialogProps = {
  repo: string; bead: { id: string; title: string }; pools: Pools;
  loadPreview(req: DispatchRequest): Promise<DispatchPreview>; dispatch(req: DispatchRequest): Promise<DispatchResult>;
  onClose(): void; onDone(r: DispatchResult): void;
};
type Prev = { state: "loading" } | { state: "ok"; p: Extract<DispatchPreview, { ok: true }>; key: string } | { state: "error"; reason: string };

/** Assign dialog: pick the agent + model, see exactly what will happen (preview + the one-write statement), then confirm. */
export function DispatchDialog(p: DispatchDialogProps) {
  const [init] = useState(() => pickFromPool(p.pools.implement) ?? { runtime: "claude" as Runtime, model: SUGGESTED_MODELS.claude[0], weight: 0 });
  const [runtime, setRuntime] = useState<Runtime>(init.runtime);
  const [model, setModel] = useState<string>(init.model);
  const [prev, setPrev] = useState<Prev>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DispatchResult | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [trust, setTrust] = useState(false); // "I trust this repo's hooks": reset with every new preview
  const [nonce, setNonce] = useState(0); // bumped after a failed dispatch: the single-use token is spent, so load a fresh preview
  const ref = useRef<HTMLDialogElement>(null);
  const live = useRef(p); live.current = p;
  const req: DispatchRequest = { repo: p.repo, beadId: p.bead.id, runtime, model: model || null };
  useEffect(() => { const d = ref.current; if (d && !d.open && typeof d.showModal === "function") d.showModal(); }, []);
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined; // stale guard: only the latest request may set the preview
    setPrev({ state: "loading" }); setTrust(false);
    live.current.loadPreview({ repo: p.repo, beadId: p.bead.id, runtime, model: model || null }).then(
      r => { if (!alive) return; setPrev(r.ok ? { state: "ok", p: r, key: selectionKey(runtime, model || null) } : { state: "error", reason: r.reason });
        if (!r.ok && isThrottledPreview(r.reason)) timer = setTimeout(() => setNonce(n => n + 1), 2100); }, // the server's 2 s per-bead preview throttle: retry once it lapses
      e => { if (alive) setPrev({ state: "error", reason: e instanceof Error ? e.message : String(e) }); });
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [p.repo, p.bead.id, runtime, model, nonce]);
  const pickRuntime = (r: Runtime) => { setRuntime(r); setModel(SUGGESTED_MODELS[r][0] ?? ""); setResult(null); };
  const models = SUGGESTED_MODELS[runtime].includes(model) || model === "" ? SUGGESTED_MODELS[runtime] : [model, ...SUGGESTED_MODELS[runtime]];
  // W-1B L8: Confirm only for a preview loaded FOR the current runtime+model (a stale preview never confirms a different selection).
  const ok = prev.state === "ok" && canConfirm({ key: prev.key, token: prev.p.token, hooks: prev.p.hooks }, runtime, model || null, busy, trust);
  const hooks = prev.state === "ok" ? prev.p.hooks ?? [] : [];
  const go = () => {
    if (prev.state !== "ok" || !ok) return;
    setBusy(true); setResult(null);
    // the preview's single-use token rides along; the server refuses a dispatch without it
    p.dispatch({ ...req, token: prev.p.token, ...(hooks.length ? { trustHooks: trust } : {}) }).then(r => { setResult(r); if (!r.ok) setNonce(n => n + 1); }, e => { setResult({ ok: false, stage: "validate", reason: e instanceof Error ? e.message : String(e) }); setNonce(n => n + 1); }).finally(() => setBusy(false));
  };
  const tip = firstUse(); // the first place each term appears in this dialog carries its definition
  const res = result ? dispatchResultText(result) : null;
  return <dialog ref={ref} className="oi-dd" aria-label={capitalise(termLabel("dispatch"))} onCancel={e => { e.preventDefault(); if (!busy) p.onClose(); }}>
    <h3 className="oi-dd-h" title={tip("dispatch")}>Assign <code>{shortId(p.bead.id)}</code> to an agent</h3>
    <div className="oi-dd-bead" title={tip("bead") ?? p.bead.title}>{p.bead.title}</div>
    <div className="oi-dd-row">
      <label>Agent <MenuSelect ariaLabel="Agent" value={runtime} disabled={busy} onChange={v => pickRuntime(v as Runtime)} options={RUNTIMES.map(r => ({ value: r, label: r }))} /></label>
      <label>Model <MenuSelect ariaLabel="Model" value={model} disabled={busy} onChange={v => { setModel(v); setResult(null); }} options={[...models.map(m => ({ value: m, label: m })), { value: "", label: "runtime default" }]} /></label>
    </div>
    <table className="oi-dd-pool" aria-label="Suggested agents (read-only)"><caption>Suggested mix of agents (read-only)</caption>
      <tbody>{(["implement", "review"] as const).flatMap(st => p.pools[st].map((e, i) => <tr key={`${st}${i}`}><td>{i === 0 ? st : ""}</td><td>{e.runtime}</td><td>{e.model}</td><td>{e.weight}%</td></tr>))}</tbody></table>
    <div className="oi-dd-prev" aria-live="polite">
      {prev.state === "loading" ? <div className="oi-dd-muted">Loading preview…</div>
        : prev.state === "error" ? <div className="oi-dd-err" role="alert">{previewErrorText(prev.reason)}</div>
        : <>
          <div>Branch <code>{prev.p.branch}</code></div>
          <div>Separate working copy <code>{prev.p.worktree}</code></div>
          <div title={tip("pane")}>{capitalise(termLabel("pane"))} name <code>{prev.p.paneTitle}</code></div>
          {hooks.length > 0 && <div className="oi-dd-hooks" role="alert">
            <div>This project runs its own scripts when an agent is assigned: {hooks.join(", ")}</div>
            <label><input type="checkbox" checked={trust} disabled={busy} onChange={e => setTrust(e.target.checked)} /> I trust the scripts in this project</label>
          </div>}
          <button type="button" className="oi-dd-link" aria-expanded={showPrompt} onClick={() => setShowPrompt(v => !v)}>{showPrompt ? "Hide the agent's instructions" : "Show the agent's instructions"}</button>
          {showPrompt && <pre className="oi-dd-prompt">{prev.p.prompt}</pre>}
        </>}
    </div>
    <p className="oi-dd-stmt">{dispatchStatement({ shortId: shortId(p.bead.id), branch: prev.state === "ok" ? prev.p.branch : null, runtime, model: model || null })}</p>
    {res && <div className={res.ok ? "oi-dd-ok" : "oi-dd-err"} role={res.ok ? "status" : "alert"}><strong>{res.headline}</strong><div>{res.detail}</div></div>}
    <div className="oi-dd-actions">
      {result?.ok ? <button type="button" className="oi-dd-go" onClick={() => p.onDone(result)}>Done</button>
        : <><button type="button" onClick={p.onClose} disabled={busy}>Cancel</button><button type="button" className="oi-dd-go" disabled={!ok} onClick={go}>{busy ? "Assigning…" : "Assign to agent"}</button></>}
    </div>
  </dialog>;
}

export const dispatchDialogStyles = `
.oi-dd{width:min(520px,92vw);padding:12px;font-size:11px;color:var(--oi-text);background:var(--oi-bg);border:1px solid var(--oi-border);border-radius:8px;box-shadow:0 8px 28px var(--oi-shadow)}
.oi-dd::backdrop{background:var(--oi-scrim)}
.oi-dd-h{margin:0;font-size:13px}
.oi-dd-bead{margin:2px 0 8px;color:var(--oi-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-dd-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.oi-dd-pool{width:100%;margin-bottom:6px;font-size:10px;color:var(--oi-muted);border-collapse:collapse}
.oi-dd-pool caption{text-align:left}
.oi-dd-pool td{padding:0 6px 0 0}
.oi-dd-prev{display:flex;flex-direction:column;gap:2px;align-items:flex-start;min-width:0;overflow-wrap:anywhere}
.oi-dd-prompt{align-self:stretch;margin:2px 0 0;max-height:160px;overflow:auto;padding:4px 6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;white-space:pre-wrap;border:1px solid var(--oi-border);border-radius:4px;background:var(--oi-panel)}
.oi-dd-link{padding:0;font:inherit;font-size:10px;color:var(--oi-tone-info);background:transparent;border:0;cursor:pointer}
.oi-dd-stmt{margin:8px 0;padding:6px 8px;border:1px solid var(--oi-tone-attention);border-radius:4px;overflow-wrap:anywhere}
.oi-dd-hooks{align-self:stretch;margin:4px 0;padding:4px 6px;border:1px solid var(--oi-tone-attention);border-radius:4px}
.oi-dd-muted{color:var(--oi-muted)}
.oi-dd-err{color:var(--oi-tone-failure)}
.oi-dd-ok{color:var(--oi-tone-success)}
.oi-dd-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}
.oi-dd-actions button{padding:3px 10px;font:inherit;color:var(--oi-text);background:transparent;border:1px solid var(--oi-border);border-radius:4px;cursor:pointer}
.oi-dd-actions .oi-dd-go{background:var(--oi-selected);border-color:var(--oi-tone-info)}
.oi-dd-actions button:disabled{color:var(--oi-muted);cursor:not-allowed}
`;
