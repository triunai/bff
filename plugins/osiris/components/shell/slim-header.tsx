import type { ReactNode } from "react";
import { NEEDS_WORDS, SEARCH_PLACEHOLDER, SPEND_WORDS } from "../../shell/chrome-model.ts";
// The ONE top bar (ADR D-137: ported from the approved mockup docs/design/2026-10-07-osiris-dashboard-harmony.html, header.top).
// Left to right: ◆ OSIRIS, the repo selector, the search box, then on the right NEEDS YOU, `extra` (the red seams / herdr chips, ☕ and the
// LIVE fleet chip, all passed in by the host), $/hour, Theme: <name> and View. The Herdr/BB/All scope switch lives in View ▸ Scope.
// Without `chrome` (thread panel / calls-only builds) it is the logo, the source tabs and `extra`.
export type SlimSource = { id: string; label: string };
export type SlimChrome = {
  repo: string; onRepo: () => void;
  /** Opens the command palette (the existing ⌘K search, which also jumps to an id). */
  onSearch: () => void; searchChord?: string;
  needs: { n: number; /** Agents-waiting wording for screen readers (work/needs-you.ts). */ label: string; title: string; onClick: () => void };
  spend: { amount: string; title: string; onClick: () => void };
  theme: { label: string; onClick: (anchor: { left: number; top: number }) => void };
  onMenu: (anchor: { left: number; top: number }) => void;
};
export type SlimHeaderProps = { title: string; sources: SlimSource[]; source: string; onSource: (id: string) => void; onLogo: (anchor: { left: number; top: number }) => void; menuOpen?: boolean;
  /** Right-hand slot: seams / herdr chips, keep-awake and the fleet chip. */
  extra?: ReactNode; chrome?: SlimChrome };

export function SlimHeader({ title, sources, source, onSource, onLogo, menuOpen, extra, chrome }: SlimHeaderProps) {
  const below = (e: { currentTarget: HTMLElement }) => { const r = e.currentTarget.getBoundingClientRect(); return { left: Math.max(4, r.right - 260), top: r.bottom + 2 }; };
  const ids = sources.map(s => s.id);
  return <header className="oi-slim">
    <button type="button" className="oi-slim-logo" aria-haspopup="menu" aria-expanded={!!menuOpen} aria-label={`${title} menu`} title="View, layout and workbench actions" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onLogo({ left: r.left, top: r.bottom + 2 }); }}><span aria-hidden="true">◆</span> {title.toUpperCase()}</button>
    {chrome ? <>
      <button type="button" className="oi-slim-repo" title="Tracker and repo" onClick={chrome.onRepo}>{chrome.repo}</button>
      <button type="button" className="oi-slim-search" aria-label="Search or jump to an id" onClick={chrome.onSearch}><span aria-hidden="true">⌕</span><span className="oi-slim-search-t">{SEARCH_PLACEHOLDER}</span>{chrome.searchChord ? <kbd>{chrome.searchChord}</kbd> : null}</button>
      <div className="oi-slim-right">
        <button type="button" className={`oi-slim-num oi-slim-need${chrome.needs.n > 0 ? " on" : ""}`} aria-label={chrome.needs.label || NEEDS_WORDS.join(" ")} title={chrome.needs.title} onClick={chrome.needs.onClick}><span className="n">{chrome.needs.n}</span><span className="w">{NEEDS_WORDS[0]}<br />{NEEDS_WORDS[1]}</span></button>
        {extra ? <div className="oi-slim-extra">{extra}</div> : null}
        <button type="button" className="oi-slim-num oi-slim-spend" title={chrome.spend.title} onClick={chrome.spend.onClick}><span className="n">{chrome.spend.amount}</span><span className="w">{SPEND_WORDS[0]}<br />{SPEND_WORDS[1]}</span></button>
        <button type="button" className="oi-slim-ghost" aria-haspopup="menu" title="View ▸ Theme" onClick={e => chrome.theme.onClick(below(e))}>{chrome.theme.label}</button>
        <button type="button" className="oi-slim-ghost" aria-haspopup="menu" aria-expanded={!!menuOpen} onClick={e => chrome.onMenu(below(e))}>View</button>
      </div></>
    : <>
      <div className="oi-slim-seg" role="tablist" aria-label="Observation source">
        {sources.map(s => <button type="button" role="tab" key={s.id} aria-selected={source === s.id} tabIndex={source === s.id ? 0 : -1} onClick={() => onSource(s.id)}
          onKeyDown={e => { let i = ids.indexOf(s.id); if (e.key === "ArrowRight") i = (i + 1) % ids.length; else if (e.key === "ArrowLeft") i = (i + ids.length - 1) % ids.length; else if (e.key === "Home") i = 0; else if (e.key === "End") i = ids.length - 1; else return; e.preventDefault(); onSource(ids[i]); (e.currentTarget.parentElement?.children[i] as HTMLButtonElement | undefined)?.focus(); }}>{s.label}</button>)}
      </div>
      <div className="oi-slim-right">{extra ? <div className="oi-slim-extra">{extra}</div> : null}</div></>}
  </header>;
}

export const slimHeaderStyles = `
.oi-slim{display:flex;align-items:center;gap:14px;height:40px;padding:0 12px;border-bottom:1px solid var(--oi-border-strong,var(--oi-border));background-image:var(--oi-scanline);flex:none;box-sizing:border-box}
.oi-slim-logo{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 6px;border:0;border-radius:4px;background:transparent;color:var(--oi-text);font:inherit;font-size:13px;font-weight:700;letter-spacing:.06em;cursor:pointer}
.oi-slim-logo span{color:var(--oi-accent);text-shadow:var(--oi-glow,none)}
.oi-slim-repo{height:26px;padding:3px 8px;border:0;border-radius:6px;background:transparent;color:var(--oi-muted);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.oi-slim-repo:hover{background:var(--oi-selected);color:var(--oi-text)}
.oi-slim-extra{display:flex;align-items:center;gap:6px}
.oi-slim-right{display:flex;align-items:center;gap:14px;margin-left:auto;min-width:0}
.oi-slim-search{display:inline-flex;align-items:center;gap:8px;height:26px;min-width:0;flex:0 1 300px;max-width:28vw;padding:0 10px;border:0;border-radius:6px;background:var(--oi-input,var(--oi-raised));color:var(--oi-muted);font:inherit;font-size:12px;cursor:pointer}
.oi-slim-search:hover{color:var(--oi-text)}
.oi-slim-search-t{flex:1;min-width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-slim-search kbd{margin-left:auto;font:inherit;font-size:10px;color:var(--oi-muted)}
.oi-slim-num{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 10px;border:0;border-radius:999px;background:transparent;color:var(--oi-text);font:inherit;font-size:11px;cursor:pointer}
.oi-slim-num:hover{background:var(--oi-selected)}
.oi-slim-num .n{font-size:17px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
.oi-slim-spend .n{font-size:14px;color:var(--oi-accent)}
.oi-slim-num .w{font-size:9.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--oi-muted);line-height:1.1;text-align:left}
.oi-slim-need.on .n{color:var(--oi-tone-attention);text-shadow:var(--oi-glow,none)}
.oi-slim-ghost{height:26px;padding:4px 8px;border:0;border-radius:6px;background:transparent;color:var(--oi-muted);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
.oi-slim-ghost:hover,.oi-slim-ghost[aria-expanded="true"]{background:var(--oi-selected);color:var(--oi-text)}
@media(max-width:900px){.oi-slim{gap:8px}.oi-slim-right{gap:6px}.oi-slim-search-t,.oi-slim-search kbd,.oi-slim-num .w{display:none}.oi-slim-search{flex:none;padding:0 8px}}
.oi-slim-logo:hover,.oi-slim-logo[aria-expanded="true"]{background:var(--oi-selected)}
.oi-slim-seg{display:inline-flex;gap:1px;padding:1px}
.oi-slim-seg button{height:18px;white-space:nowrap;padding:0 8px;border:0;border-radius:3px;background:transparent;color:var(--oi-muted);font:inherit;font-size:10px;cursor:pointer}
.oi-slim-seg button[aria-selected="true"]{background:transparent;color:var(--oi-text);box-shadow:var(--oi-tab-underline)}
.oi-slim-logo:focus-visible,.oi-slim-seg button:focus-visible,.oi-slim-search:focus-visible,.oi-slim-ghost:focus-visible,.oi-slim-repo:focus-visible,.oi-slim-num:focus-visible{outline:1px solid var(--oi-focus,var(--oi-accent));outline-offset:1px}
`;
