import { useEffect, useMemo, useRef, useState } from "react";
import { dispatchTeamToHerdr, dispatchToHerdr, herdrDispatchBinding, type DispatchOutcome } from "./client.ts";
import { approvalText, CONFIRM_TTL_MS, composePrompt, defaultProvider, dispatchButtonLabel, HERDR_CLIS, PROVIDER_CARDS, shortPath, type HerdrCli } from "./plan.ts";
import { MenuSelect } from "../../components/ui/menu-select.tsx";
import { DEMO_OFF, useDemoOn } from "../../demo/client.ts";
import { SUGGESTED_MODELS } from "../runtime-models.ts";
import { ANYWAY_LABEL, DOUBLE_CHECK_LABEL, anywayEnabled, doubleCheckPrompt, understandText, warningText, type DispatchGuard } from "../dispatch-guard.ts";
import { TEAM_DEFAULT_LEAD, TEAM_DEFAULT_WORKER, TEAM_MAX_WORKERS, buildTeamPlan, clampWorkers, type TeamCard } from "../team-dispatch/plan.ts";

type Found = { clis: HerdrCli[]; paths: Partial<Record<HerdrCli, string>> };
/** Model choices per CLI come from data (runtime-models.ts); a CLI with no list just runs its own default. */
const modelsFor = (cli: HerdrCli): string[] => (SUGGESTED_MODELS as Record<string, string[] | undefined>)[cli] ?? [];
const pick = (want: { cli: HerdrCli; model: string | null }, clis: HerdrCli[]) => { const cli = clis.includes(want.cli) ? want.cli : clis[0]; return { cli, model: cli === want.cli && modelsFor(cli).includes(want.model ?? "") ? want.model : null }; };
function Member(p: { label: string; value: { cli: HerdrCli; model: string | null }; clis: HerdrCli[]; disabled: boolean; onChange(v: { cli: HerdrCli; model: string | null }): void }) {
  return <label className="oi-hd-row">{p.label}
    <MenuSelect ariaLabel={`${p.label} agent`} value={p.value.cli} disabled={p.disabled} onChange={v => p.onChange({ cli: v as HerdrCli, model: null })} options={p.clis.map(c => ({ value: c, label: c }))} />
    <MenuSelect ariaLabel={`${p.label} model`} value={p.value.model ?? ""} disabled={p.disabled} onChange={v => p.onChange({ ...p.value, model: v || null })} options={[{ value: "", label: "default" }, ...modelsFor(p.value.cli).map(m => ({ value: m, label: m }))]} /></label>;
}
/** Shared confirm for Dispatch to Herdr: pick the agent, see exactly what happens, confirm. Any selection can open it with its own prompt.
 *  `subject` names what is being sent ("the status" by default). Team mode (an Opus lead + workers on these cards) is the same dialog, extended; never a second dialog. */
export function HerdrDispatchDialog(p: { prompt: string; title: string; subject?: string; team?: { cards: TeamCard[]; epic?: string | null }; /** A locked / owner-gated / blocked / critical item (work/dispatch-guard.ts): warns, defaults to a read-only double-check, and gates "Dispatch anyway" behind a checkbox. */ guard?: DispatchGuard | null; onClose(): void; onDone?(o: DispatchOutcome): void }) {
  const [lead, setLead] = useState(TEAM_DEFAULT_LEAD), [worker, setWorker] = useState(TEAM_DEFAULT_WORKER);
  const [count, setCount] = useState(() => clampWorkers(undefined, p.team?.cards.length ?? 1));
  const [teamMsg, setTeamMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const built = useMemo(() => p.team ? buildTeamPlan({ cards: p.team.cards, lead, worker, workers: count, epic: p.team.epic }) : null, [p.team, lead, worker, count]);
  const [found, setFound] = useState<Found | null>(null);
  const [cli, setCli] = useState<HerdrCli | "">("");
  const [first, setFirst] = useState("");
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false), demo = useDemoOn();
  const [ticked, setTicked] = useState(false);
  const [out, setOut] = useState<DispatchOutcome | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  const subject = p.subject ?? "the status";
  useEffect(() => { const d = ref.current; if (d && !d.open && typeof d.showModal === "function") d.showModal(); }, []);
  useEffect(() => { const t = setTimeout(() => setExpired(true), CONFIRM_TTL_MS); return () => clearTimeout(t); }, []);
  useEffect(() => {
    let alive = true; const b = herdrDispatchBinding();
    if (!b) { setFound({ clis: [], paths: {} }); return; }
    b.call("herdrClis", {}).then(r => { if (alive) { setFound({ clis: r.clis, paths: r.paths ?? {} }); setCli(defaultProvider(r.clis, b.lastCli?.(), b.liveCli?.())); if (r.clis.length) { setLead(l => pick(l, r.clis)); setWorker(w => pick(w, r.clis)); } } }, () => { if (alive) setFound({ clis: [], paths: {} }); });
    return () => { alive = false; };
  }, []);
  const text = composePrompt(first, p.prompt);
  const none = !!found && !found.clis.length;
  const go = (kind: "send" | "check" = "send") => {
    if (demo) return;
    if (kind === "check" && p.guard) {
      if (!cli || busy || expired) return;
      setBusy(true); setOut(null);
      void dispatchToHerdr({ prompt: doubleCheckPrompt(p.guard, text), cli, title: `Double-check: ${p.title}` }).then(o => { setOut(o); p.onDone?.(o); }).finally(() => setBusy(false));
      return;
    }
    if (p.guard && !anywayEnabled(p.guard, ticked)) return;
    if (p.team) {
      if (!built?.ok || busy || expired || !found?.clis.length) return;
      setBusy(true); setTeamMsg(null);
      void dispatchTeamToHerdr(built.plan).then(o => setTeamMsg(o)).finally(() => setBusy(false));
      return;
    }
    if (!cli || busy || expired) return;
    setBusy(true); setOut(null);
    try { herdrDispatchBinding()?.rememberCli?.(cli); } catch { /* a preference only */ }
    void dispatchToHerdr({ prompt: text, cli, title: p.title }).then(o => { setOut(o); p.onDone?.(o); }).finally(() => setBusy(false));
  };
  const done = teamMsg?.ok === true || out?.ok === true;
  const hasClis = !!found?.clis.length;
  const card = cli ? PROVIDER_CARDS[cli] : null;
  const repo = herdrDispatchBinding()?.repo;
  return <dialog ref={ref} className="oi-hd" aria-label={p.team ? "Dispatch team" : "Dispatch to Herdr"} onCancel={e => { e.preventDefault(); if (!busy) p.onClose(); }}>
    {p.team ? <>
      <h2 className="oi-hd-h">Dispatch team</h2>
      <div className="oi-hd-sub">Opens a new tab in your default Herdr session with one lead pane and one pane per worker. The agents claim their own beads; Osiris changes nothing in the tracker. Nothing runs until you confirm.</div>
      {hasClis && <><Member label="Lead" value={lead} clis={found!.clis} disabled={busy || done} onChange={setLead} />
        <Member label="Workers" value={worker} clis={found!.clis} disabled={busy || done} onChange={setWorker} />
        <label className="oi-hd-row">Worker count <input type="number" aria-label="Worker count" min={1} max={TEAM_MAX_WORKERS} value={count} disabled={busy || done} onChange={e => setCount(clampWorkers(Number(e.target.value), p.team!.cards.length))} /><small className="oi-hd-note">{p.team.cards.length} card{p.team.cards.length === 1 ? "" : "s"} selected, at most {TEAM_MAX_WORKERS} workers</small></label></>}
      {none && <p className="oi-hd-err" role="alert">No agent program ({HERDR_CLIS.join(", ")}) was found, so a team cannot be started here.</p>}
      {built && !built.ok && <p className="oi-hd-err" role="alert">{built.reason}</p>}
      {built?.ok && [built.plan.lead, ...built.plan.workers].map((pane, i) => <details key={i} className="oi-hd-text"><summary>{pane.label} ({pane.cli}{pane.model ? ` / ${pane.model}` : ""}, {pane.cards.length} card{pane.cards.length === 1 ? "" : "s"})</summary><pre>{pane.role === "lead" ? "Coordinates and reviews; does not implement." : "Works its own cards in its own git worktree."}{"\n"}{pane.cards.map(c => `${c.id}: ${c.title}`).join("\n")}{"\n"}The full instructions are written and sealed by Osiris when you dispatch.</pre></details>)}
      {teamMsg && <p className={teamMsg.ok ? "oi-hd-note" : "oi-hd-err"} role={teamMsg.ok ? "status" : "alert"}>{teamMsg.message}</p>}
    </> : <>
    <h2 className="oi-hd-h">Dispatch {subject} to a new agent</h2>
    <div className="oi-hd-sub">Opens a new agent in your default Herdr session, seeded with {p.subject ? "the text shown below" : "the same text Copy status gives you"}. Nothing is claimed, and no worktree is made.</div>
    <div className="oi-hd-step"><div className="oi-hd-eyebrow">1 · Agent</div><div className="oi-hd-prov" role="group" aria-label="Agent">
      {HERDR_CLIS.map(c => { const ok = !!found?.clis.includes(c), pc = PROVIDER_CARDS[c];
        return <button key={c} type="button" className={`oi-hd-pc${ok ? "" : " oi-hd-off"}`} aria-pressed={cli === c} disabled={busy || done || !ok} onClick={() => setCli(c)}>
          <span className="oi-hd-nm"><span className={`oi-hd-pv oi-hd-pv-${c}`}>{pc.code}</span> {pc.label}</span>
          <span className="oi-hd-sel">{pc.models.map((m, i) => <span key={m} className={`oi-hd-chip${i === 0 && cli === c ? " oi-hd-chip-on" : ""}`}>{m}</span>)}</span>
          <small>{found === null ? "looking…" : ok ? `✓ found · ${shortPath(found.paths[c] ?? c)}` : "not installed"}</small>
        </button>; })}
    </div></div>
    <div className="oi-hd-step"><div className="oi-hd-eyebrow">2 · Where</div><div className="oi-hd-radio">
      <label><input type="radio" name="oi-hd-where" checked readOnly /> New tab in your default Herdr session <span className="oi-hd-note">(recommended)</span></label>
      <label className="oi-hd-off"><input type="radio" name="oi-hd-where" disabled /> Split the current pane <span className="oi-hd-note">(not available yet)</span></label>
    </div><div className="oi-hd-note oi-hd-folder">folder: {repo ? `${repo.split("/").filter(Boolean).pop() ?? repo} (the tracker's repo)` : "your home folder"}</div></div>
    <div className="oi-hd-step"><div className="oi-hd-eyebrow">3 · Prompt</div>
      <input className="oi-hd-inp" aria-label="What should it do? (optional, goes first)" placeholder="What should it do? (optional, goes first)" value={first} maxLength={500} disabled={busy || done} onChange={e => setFirst(e.target.value)} />
      <pre className="oi-hd-pre" aria-label={`The text that will be sent (${text.length} characters)`}>{text}</pre></div>
    <div className="oi-hd-step"><div className="oi-hd-eyebrow">4 · Approval</div><div className="oi-hd-note oi-hd-appr">{approvalText(cli)}</div></div>
    </>}
    {!p.team && none && <p className="oi-hd-err" role="alert">No agent program ({HERDR_CLIS.join(", ")}) was found. Confirming will copy the text and open the Terminal tab instead.</p>}
    {out && <p className={out.ok ? "oi-hd-note" : "oi-hd-err"} role={out.ok ? "status" : "alert"}>{out.ok ? `Started in pane ${out.paneId}.` : out.message}</p>}
    {p.guard && !done && <div className="oi-hd-guard" role="alert" data-guard={p.guard.state}><b>Heads up.</b> {warningText(p.guard)}<label className="oi-hd-ack"><input type="checkbox" checked={ticked} disabled={busy} onChange={e => setTicked(e.target.checked)} /> {understandText(p.guard)}</label></div>}
    <div className="oi-hd-btns">
      <span className="oi-hd-note oi-hd-ttl" role="status">{expired && !done ? "The preview expired · close and reopen to confirm" : "confirm within 2 min · then the preview expires"}</span>
      <button type="button" className="oi-hd-ghost" onClick={p.onClose} disabled={busy}>{done ? "Close" : "Cancel"}</button>
      {!done && p.guard && <button type="button" className="oi-hd-go" onClick={() => go("check")} disabled={busy || found === null || expired || !hasClis || demo} title={demo ? DEMO_OFF : undefined}>{busy ? "Dispatching…" : DOUBLE_CHECK_LABEL}</button>}
      {!done && p.guard && <button type="button" className="oi-hd-anyway" onClick={() => go()} disabled={busy || found === null || expired || !anywayEnabled(p.guard, ticked) || (!!p.team && (!hasClis || !built?.ok)) || demo} title={demo ? DEMO_OFF : undefined}>{busy ? "Dispatching…" : ANYWAY_LABEL}</button>}
      {!done && !p.guard && p.team && <button type="button" className="oi-hd-go" onClick={() => go()} disabled={busy || found === null || expired || !hasClis || !built?.ok || demo} title={demo ? DEMO_OFF : undefined}>{busy ? "Dispatching…" : "Dispatch team"}</button>}
      {!done && !p.guard && !p.team && <button type="button" className="oi-hd-go" onClick={() => go()} disabled={busy || found === null || expired || demo} title={demo ? DEMO_OFF : undefined}>{busy ? "Dispatching…" : none ? "Copy and open Terminal" : dispatchButtonLabel("tab")}</button>}
    </div>
  </dialog>;
}

const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
export const herdrDispatchStyles = `
.oi-hd{width:min(640px,calc(100vw - 32px));max-width:none;max-height:84vh;overflow:auto;background:var(--oi-raised,var(--oi-panel));color:var(--oi-text);border:0;border-radius:10px;box-shadow:var(--oi-shadow-raised,0 0 0 1px var(--oi-border));padding:16px 18px;font:13px system-ui,sans-serif}
.oi-hd::backdrop{background:var(--oi-scrim)}
.oi-hd-h{margin:0 0 2px;font:600 15px ${MONO}}.oi-hd-sub{font-size:12px;color:var(--oi-muted);margin-bottom:12px}
.oi-hd-step{margin:12px 0}.oi-hd-eyebrow{font:600 10px ${MONO};letter-spacing:.09em;text-transform:uppercase;color:var(--oi-muted);margin-bottom:6px}
.oi-hd-prov{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.oi-hd-pc{padding:10px;border:0;border-radius:7px;background:var(--oi-panel);color:inherit;text-align:left;display:flex;flex-direction:column;gap:4px;min-width:0;cursor:pointer}
.oi-hd-pc:hover:not(:disabled){background:var(--oi-hover)}
.oi-hd-pc[aria-pressed="true"]{background:var(--oi-selected);box-shadow:inset 0 0 0 1px var(--oi-selected-border,var(--oi-accent))}
.oi-hd-pc small{font:10.5px ${MONO};color:var(--oi-muted)}.oi-hd-nm{font:600 13px system-ui,sans-serif;display:flex;gap:6px;align-items:center}
.oi-hd-off{opacity:.5;cursor:not-allowed}.oi-hd-sel{display:flex;gap:4px;flex-wrap:wrap}
.oi-hd-chip,.oi-hd-pv{display:inline-flex;align-items:center;gap:4px;padding:0 6px;border-radius:9px;font:600 10.5px/17px ${MONO};white-space:nowrap;--c:var(--oi-muted);background:color-mix(in srgb,var(--c) 16%,transparent);color:var(--c)}
.oi-hd-chip-on{--c:var(--oi-accent)}.oi-hd-pv{--c:var(--oi-lane-3)}.oi-hd-pv-codex{--c:var(--oi-lane-1)}.oi-hd-pv-gemini{--c:var(--oi-lane-0)}
.oi-hd-radio{display:flex;flex-direction:column;gap:4px}.oi-hd-radio label{display:flex;gap:8px;align-items:center;font-size:12.5px}
.oi-hd-note{font:11px ${MONO};color:var(--oi-muted)}.oi-hd-folder{margin-top:4px}.oi-hd-appr{color:var(--oi-text-2,var(--oi-text))}
.oi-hd-inp{width:100%;box-sizing:border-box;height:28px;padding:0 8px;border:0;border-radius:5px;background:var(--oi-input,var(--oi-bg));color:var(--oi-text);font:12px system-ui,sans-serif}
.oi-hd-pre{margin:6px 0 0;padding:8px 10px;border-radius:6px;background:var(--oi-input,var(--oi-bg));font:11px/1.5 ${MONO};color:var(--oi-text-2,var(--oi-text));white-space:pre-wrap;max-height:150px;overflow:auto}
.oi-hd-err{color:var(--oi-tone-failure);margin:6px 0}
.oi-hd-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;align-items:center}.oi-hd-ttl{margin-right:auto}
.oi-hd-btns button{font:12px system-ui,sans-serif;padding:5px 11px;border:0;border-radius:6px;background:var(--oi-hover);color:var(--oi-text);cursor:pointer}
.oi-hd-btns .oi-hd-ghost{background:transparent;color:var(--oi-text-2,var(--oi-text))}
.oi-hd-btns .oi-hd-go{background:var(--oi-accent);color:var(--oi-on-accent,var(--oi-bg));font-weight:600;box-shadow:var(--oi-glow-active,none)}
.oi-hd-guard{margin:10px 0 0;padding:8px 10px;border-radius:6px;font-size:12px;background:color-mix(in srgb,var(--oi-tone-attention) 14%,transparent);color:var(--oi-text);box-shadow:inset 3px 0 0 var(--oi-tone-attention)}
.oi-hd-guard[data-guard="locked"],.oi-hd-guard[data-guard="critical"]{background:color-mix(in srgb,var(--oi-tone-failure) 14%,transparent);box-shadow:inset 3px 0 0 var(--oi-tone-failure)}
.oi-hd-ack{display:flex;gap:8px;align-items:center;margin-top:6px;font-weight:600}
.oi-hd-btns .oi-hd-anyway{background:transparent;color:var(--oi-text-2,var(--oi-text));box-shadow:inset 0 0 0 1px var(--oi-border-strong,var(--oi-border))}
.oi-hd-btns button:disabled{opacity:.5;cursor:not-allowed}
.oi-hd button:focus-visible,.oi-hd input:focus-visible{outline:2px solid var(--oi-focus,var(--oi-accent));outline-offset:1px}
`;
