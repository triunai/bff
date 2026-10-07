import type { ReactNode } from "react";
import type { Loc } from "../../shell/nav-history.ts";
import type { StatusItem } from "../../shell/chrome-model.ts";
// The ONE bottom status bar (mockup footer.status, ADR D-137): items come from shell/chrome-model.ts statusBar(); this only renders them.
export type StatusBarProps = { left: StatusItem[]; right: StatusItem[]; onNavigate: (loc: Loc) => void;
  /** Refresh for a stale Herdr capture (the existing refresh path). */ refresh?: { busy: boolean; onRefresh: () => void };
  /** Transient copy message (role=status). */ message?: string; providersTitle?: string };

export function StatusBar({ left, right, onNavigate, refresh, message, providersTitle }: StatusBarProps) {
  const cell = (s: StatusItem): ReactNode => s.link
    ? <button type="button" key={s.id} className="oi-sb-link" title={s.title} onClick={() => onNavigate(s.link!)}>{s.text}</button>
    : <span key={s.id} className={`oi-sb-${s.tone ?? "plain"}${s.id === "head" ? " oi-footer-head" : ""}`} title={s.title} style={s.provider ? { color: `var(--oi-provider-${s.provider})` } : undefined}>{s.text}</span>;
  const providers = right.filter(r => r.id.startsWith("provider-"));
  return <footer className="oi-footer oi-statusbar" aria-label="Status">
    {left.map(cell)}
    {refresh && <button type="button" className="oi-footer-refresh" title="Re-read the Herdr capture now" disabled={refresh.busy} onClick={refresh.onRefresh}>{refresh.busy ? "Refreshing…" : "Refresh"}</button>}
    <span role="status" className="oi-copy-status">{message}</span>
    <span className="oi-sb-sp" />
    {right.filter(r => !r.id.startsWith("provider-") && r.id !== "price").map(cell)}
    <span title={providersTitle}>{providers.map((p, i) => <span key={p.id}>{i ? " · " : " "}{cell(p)}</span>)}</span>
    {right.filter(r => r.id === "price").map(cell)}
  </footer>;
}

export const statusBarStyles = `
.oi-statusbar{gap:14px;padding:0 12px;min-height:24px;max-height:24px;font-size:11px;background:var(--oi-panel);border-top:1px solid var(--oi-border)}
.oi-sb-sp{flex:1!important}
.oi-sb-ok{color:var(--oi-tone-success)}
.oi-sb-bad{color:var(--oi-tone-failure);font-weight:600}
.oi-sb-warn{color:var(--oi-tone-attention)}
.oi-sb-muted{color:var(--oi-muted)}
.oi-statusbar .oi-sb-link{padding:0;border:0;background:transparent;color:var(--oi-accent);font:inherit;font-size:11px;cursor:pointer;text-decoration:underline}
.oi-statusbar .oi-sb-link:focus-visible{outline:1px solid var(--oi-focus,var(--oi-accent));outline-offset:1px}
`;
