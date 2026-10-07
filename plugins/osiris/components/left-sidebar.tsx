import { DEMO_TERMINALS_OFF } from "../demo/gate.ts";
import { copyWithToast } from "../work/copy-toast.ts";
import { decisionsWaitingText } from "../work/needs-you.ts";
import { useEffect, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { HerdrPanesResult } from "../herdr-feed.ts";
import type { FocusView, NextUpItem, SessionRow } from "../sidebar-model.ts";
import type { WorkSurfaceSnapshot } from "../work/surface-types.ts";
import type { SidebarCommit } from "../work/sidebar-commits.ts";
import type { ProviderId } from "../work/providers/registry.ts";
import { herdrFixCommand } from "../terminal-model.ts";
import { GRAPH_ENABLED } from "../shell/panel-registry.ts";
import { SidebarBottom, sidebarBottomStyles } from "./work/sidebar-bottom.tsx";

export type SidebarSection = "goal" | "terminals" | "nextup" | "sessions";
export type SidebarTerminal = { id: string; label: string; cwdBase: string | null; agent: "herdr" | ProviderId | null; attached: boolean; status: string };
export type LeftSidebarProps = {
  /** Demo mode: no live terminals or Herdr panes are listed (demo/gate.ts). */
  demo?: boolean;
  goal: FocusView | null; goalState: "loading" | "missing" | "ok";
  terminals: SidebarTerminal[] | null; nextUp: NextUpItem[] | null; nextUpNote: string | null;
  sessions: SessionRow[]; sessionsSlot?: ReactNode; selectedSession: string | null;
  /** OPTIONAL bottom-panel extras. All absent = today's NEXT UP list; with `commits` and/or `snap` the section becomes pill tabs [Next up][Commits][Graph]. */
  commits?: SidebarCommit[]; onOpenCommit?(sha: string): void;
  snap?: WorkSurfaceSnapshot | null; now?: number; selectedBeadId?: string | null; onSelectBead?(id: string): void; onOpenGraph?(id: string): void;
  onGoal(): void; onTerminal(id: string): void; onNextUp(item: NextUpItem): void; onSession(row: SessionRow): void;
};

const STORE = "osiris-sidebar-sections";

/** Live Herdr panes (read-only `herdr pane list` through the server), refreshed while the section is open. A failed call is
 * shown as the unreachable note, never as an empty list. */
function useHerdrPanes(active: boolean): HerdrPanesResult | null {
  const rpc = useRpc<typeof rpcContract>();
  const [res, setRes] = useState<HerdrPanesResult | null>(null);
  useEffect(() => {
    if (!active) return;
    let off = false;
    const load = async () => {
      try { const r = await rpc.call("herdrPanes", {}) as HerdrPanesResult; if (!off) setRes(r); }
      catch (e) { if (!off) setRes({ state: "unreachable", panes: [], note: `Osiris could not ask Herdr (${String((e as Error)?.message ?? e).slice(0, 120)}). Reopen this panel to retry.` }); }
    };
    void load();
    const t = setInterval(load, 10_000);
    return () => { off = true; clearInterval(t); };
  }, [rpc, active]);
  return res;
}
const DEFAULTS: Record<SidebarSection, boolean> = { goal: true, terminals: true, nextup: true, sessions: false };
function loadOpen(): Record<SidebarSection, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? "null");
    if (raw && typeof raw === "object") return { goal: typeof raw.goal === "boolean" ? raw.goal : DEFAULTS.goal, terminals: typeof raw.terminals === "boolean" ? raw.terminals : DEFAULTS.terminals, nextup: typeof raw.nextup === "boolean" ? raw.nextup : DEFAULTS.nextup, sessions: typeof raw.sessions === "boolean" ? raw.sessions : DEFAULTS.sessions };
  } catch { /* storage unavailable or corrupt: defaults */ }
  return { ...DEFAULTS };
}
function saveOpen(v: Record<SidebarSection, boolean>) { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* best effort */ } }

/** A plain next step with a Copy button (the command is copied, never run). */
function CopyCommand(p: { command: string }) {
  const [done, setDone] = useState(false);
  return <div className="oi-sb-note"><code>{p.command}</code>{" "}<button type="button" className="oi-sb-copy" onClick={() => { void copyWithToast(p.command).then(ok => setDone(ok)); }}>{done ? "Copied" : "Copy"}</button></div>;
}

function Section(p: { id: SidebarSection; label: string; count?: number | string | null; open: boolean; toggle(): void; children: ReactNode }) {
  return <section className="oi-sb-sec" aria-label={p.label}>
    <button type="button" className="oi-sb-head" aria-expanded={p.open} onClick={p.toggle}>
      <span aria-hidden="true">{p.open ? "▾" : "▸"}</span><span className="oi-sb-label">{p.label}</span>
      {p.count !== null && p.count !== undefined && <span className="oi-sb-count">{p.count}</span>}
    </button>
    {p.open && <div className="oi-sb-body">{p.children}</div>}
  </section>;
}

export function LeftSidebar(p: LeftSidebarProps) {
  const [open, setOpen] = useState(loadOpen);
  const toggle = (id: SidebarSection) => setOpen(prev => { const next = { ...prev, [id]: !prev[id] }; saveOpen(next); return next; });
  const g = p.goal;
  const tabbed = !!p.commits || !!p.snap;
  const herdr = useHerdrPanes(true); // always: a collapsed section must still show its count or a "!"
  const panes = p.demo ? [] : herdr?.panes ?? [];
  const bbCount = p.terminals?.length ?? 0;
  const terminalCount = herdr?.state === "unreachable" && bbCount === 0 ? "!" : p.terminals === null && !herdr ? null : bbCount + panes.length;
  return <div className="oi-sb" role="complementary" aria-label="Sidebar">
    <Section id="goal" label="GOAL" open={open.goal} toggle={() => toggle("goal")}>
      {p.goalState === "loading" ? <div className="oi-sb-note">…</div>
        : p.goalState === "missing" || !g ? <div className="oi-sb-note">No goal on the board</div>
        : <button type="button" className="oi-sb-row" title={g.title} onClick={p.onGoal}>
            <span className="oi-sb-l1">{g.title}</span>
            <span className="oi-sb-l2"><span className={g.status === "active" ? "oi-sb-running" : "oi-sb-success"}>{g.status === "active" ? "● active" : "✓ met"}</span> · since {g.since}</span>
            {g.ownerWaiting > 0 && <span className="oi-sb-l2 oi-sb-attention">{decisionsWaitingText(g.ownerWaiting)}</span>}
          </button>}
    </Section>
    <Section id="terminals" label="TERMINALS" count={terminalCount} open={open.terminals} toggle={() => toggle("terminals")}>
      {(p.terminals ?? []).map(t => <button type="button" key={t.id} className="oi-sb-row" title={`${t.label} · ${t.status}`} onClick={() => p.onTerminal(t.id)}>
            <span className="oi-sb-l1"><span className={t.attached ? "oi-sb-running" : "oi-sb-muted"} aria-hidden="true">●</span> {t.label}</span>
            <span className="oi-sb-l2">{[t.cwdBase, t.agent].filter(Boolean).join(" · ") || t.status}</span>
          </button>)}
      {panes.map(h => <div key={`herdr:${h.paneId}`} className="oi-sb-row" title={`Herdr pane ${h.paneId} · ${h.status}`}>
            <span className="oi-sb-l1"><span className={h.focused ? "oi-sb-running" : "oi-sb-muted"} aria-hidden="true">●</span> {h.title}</span>
            <span className="oi-sb-l2">{[h.cwd?.split("/").filter(Boolean).pop(), h.agent, h.status].filter(Boolean).join(" · ")}</span>
          </div>)}
      {bbCount === 0 && panes.length === 0 && <div className="oi-sb-note">{p.demo ? DEMO_TERMINALS_OFF : herdr ? herdr.note ?? "No terminals found." : "Looking for Herdr panes…"}</div>}
      {bbCount === 0 && panes.length === 0 && !p.demo && herdrFixCommand(herdr?.note) && <CopyCommand command={herdrFixCommand(herdr?.note)!} />}
    </Section>
    <Section id="nextup" label={tabbed ? (GRAPH_ENABLED ? "NEXT · COMMITS · GRAPH" : "NEXT · COMMITS") : "NEXT UP"} count={tabbed ? null : p.nextUp ? p.nextUp.length : null} open={open.nextup} toggle={() => toggle("nextup")}>
      <SidebarBottom nextUp={p.nextUp} nextUpNote={p.nextUpNote} onNextUp={p.onNextUp} snap={p.snap} now={p.now} selectedId={p.selectedBeadId} onSelectBead={p.onSelectBead} onOpenGraph={p.onOpenGraph} commits={p.commits} onOpenCommit={p.onOpenCommit} />
    </Section>
    <Section id="sessions" label="SESSIONS" count={p.sessionsSlot ? null : p.sessions.length} open={open.sessions} toggle={() => toggle("sessions")}>
      {p.sessionsSlot ? p.sessionsSlot
        : p.sessions.length === 0 ? <div className="oi-sb-note">No recorded sessions</div>
        : p.sessions.map(r => <button type="button" key={r.key} className={`oi-sb-row${p.selectedSession === r.key ? " oi-sb-sel" : ""}`} title={r.tooltip} aria-current={p.selectedSession === r.key ? "true" : undefined} onClick={() => p.onSession(r)}>
            <span className="oi-sb-l1"><span className="oi-sb-pill">{r.providerLabel}</span> {r.line1}</span>
            <span className="oi-sb-l2">{r.line2.replace(/(\d+ errors?)$/, "")}{r.errors > 0 ? <span className="oi-sb-failure">{r.errors} {r.errors === 1 ? "error" : "errors"}</span> : `${r.errors} errors`}</span>
          </button>)}
    </Section>
  </div>;
}

const GLYPH: Record<string, string> = { fixed: "✅", built: "✅", closed: "✅", "owner-gate": "⏭", open: "○" };
export function GoalInspector(p: { goal: FocusView | null }) {
  const g = p.goal;
  if (!g) return <div className="oi-sb-insp"><div className="oi-sb-note">No goal on the board</div></div>;
  return <div className="oi-sb-insp">
    <h3 className="oi-sb-insp-title">{g.title}</h3>
    <div className="oi-sb-l2"><span className={g.status === "active" ? "oi-sb-running" : "oi-sb-success"}>{g.status === "active" ? "● active" : "✓ met"}</span> · since {g.since} · <code>workstreams.md:{g.line}</code></div>
    {g.items.length > 0 && <ul className="oi-sb-items">{g.items.map(i => <li key={i.id}><span aria-hidden="true">{GLYPH[i.status] ?? "○"}</span> <span>{i.label}{i.ref && <> <code>{i.ref}</code></>}</span></li>)}</ul>}
    {g.ownerGates.length > 0 && <><div className="oi-sb-attention oi-sb-insp-h">OWNER DECISIONS WAITING</div><ol className="oi-sb-items">{g.ownerGates.map((l, i) => <li key={i}><span>{l}</span></li>)}</ol></>}
    {g.fleet && <div className="oi-sb-l2 oi-sb-insp-h">{g.fleet.title}</div>}
  </div>;
}

export const leftSidebarStyles = sidebarBottomStyles + `
.oi-sb-copy{font:inherit;color:var(--oi-text);background:transparent;border:1px solid var(--oi-border);border-radius:4px;padding:0 6px;cursor:pointer}
.oi-sb{display:flex;flex-direction:column;min-width:0;font-size:11px;color:var(--oi-text)}
.oi-sb-sec{min-width:0;margin-top:8px}
.oi-sb-head{display:flex;align-items:baseline;gap:5px;width:100%;padding:4px 6px;font:600 10px var(--oi-font-head,system-ui,sans-serif);letter-spacing:.08em;color:var(--oi-muted);background:transparent;border:0;cursor:pointer;text-align:left}
.oi-sb-head:hover{background:var(--oi-hover)}
.oi-sb-label{flex:1;min-width:0}
.oi-sb-count{font-variant-numeric:tabular-nums}
.oi-sb-body{display:flex;flex-direction:column;min-width:0;padding-bottom:3px}
.oi-sb-row{display:flex;flex-direction:column;justify-content:center;gap:1px;min-height:38px;min-width:0;width:100%;padding:3px 6px 3px 14px;font:inherit;color:inherit;text-align:left;background:transparent;border:0;border-radius:0;cursor:pointer}
.oi-sb-row:hover{background:var(--oi-hover)}
.oi-sb-sel{background:var(--oi-selected);box-shadow:inset 2px 0 0 var(--oi-accent),var(--oi-glow-active)}
.oi-sb-l1,.oi-sb-l2{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-sb-l2{color:var(--oi-muted);font-size:10px;font-variant-numeric:tabular-nums}
.oi-sb-note{padding:3px 6px 3px 14px;color:var(--oi-muted);overflow-wrap:anywhere}
.oi-sb-more{align-self:flex-start;margin:2px 6px 0 14px;padding:0;font:inherit;font-size:10px;color:var(--oi-tone-info);background:transparent;border:0;cursor:pointer}
.oi-sb-pill{display:inline-block;padding:0 5px;font-size:9px;color:var(--oi-text-2,var(--oi-muted));border-radius:8px;background:color-mix(in srgb,var(--oi-tone-muted) var(--oi-tint,16%),transparent)}
.oi-sb-muted{color:var(--oi-tone-muted)}
.oi-sb .oi-sb-running,.oi-sb-insp .oi-sb-running{color:var(--oi-tone-running)}
.oi-sb .oi-sb-success,.oi-sb-insp .oi-sb-success{color:var(--oi-tone-success)}
.oi-sb .oi-sb-attention,.oi-sb-insp .oi-sb-attention{color:var(--oi-tone-attention)}
.oi-sb .oi-sb-failure{color:var(--oi-tone-failure)}
.oi-sb-insp{display:flex;flex-direction:column;gap:6px;min-width:0;padding:8px;font-size:11px;color:var(--oi-text)}
.oi-sb-insp-title{margin:0;font-size:13px;overflow-wrap:anywhere}
.oi-sb-insp-h{font-size:10px;letter-spacing:.05em;margin-top:4px;overflow-wrap:anywhere}
.oi-sb-items{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:2px;overflow-wrap:anywhere}
ul.oi-sb-items{list-style:none;padding-left:0}
`;
