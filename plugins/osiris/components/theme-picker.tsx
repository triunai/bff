import { useMemo, useState, type CSSProperties } from "react";
import { BASE_NAMES, BASES, customVars, DEFAULT_CUSTOM, deriveTheme, nudgeText, parseCustomTheme, SUGGESTED_ACCENTS, type BaseName, type CustomTheme } from "../theme/derive-theme.ts";
import { CONTRAST_PAIRS, THEME_LABEL, THEME_NAMES, type ThemeName } from "../theme/tokens.ts";

// The theme colour picker (owner P0 22:57, td-osi.12.1). The user picks ONE accent and a base from a short graphite range;
// theme/derive-theme.ts derives every token and guards it with the same audit the presets pass. A pick that fails is shown
// as the nearest passing colour with the reason, and THAT is what Apply saves, never the illegible request.
// No colour is written in this file (ui-tokens.test.ts): swatches and the preview take their values from the derived theme.

export type ThemePickerProps = {
  /** What is applied now: a preset name, or "custom" with its saved setting. */
  current: { name: ThemeName | "custom"; custom: CustomTheme | null };
  onApply(setting: CustomTheme): void;
  onPreset(name: ThemeName): void;
};

const vars = (m: Record<string, string>) => m as unknown as CSSProperties; // custom properties are valid style keys at runtime

export function ThemePicker(p: ThemePickerProps) {
  const [draft, setDraft] = useState<CustomTheme>(p.current.custom ?? DEFAULT_CUSTOM);
  const [hex, setHex] = useState(draft.accent);
  const d = useMemo(() => deriveTheme(draft), [draft]);
  const bases = useMemo(() => BASE_NAMES.map(b => ({ b, t: deriveTheme({ accent: d.accent, base: b }).tokens })), [d.accent]);
  const note = nudgeText(d), ok = d.problems.length === 0;
  const setAccent = (a: string) => { setHex(a); const c = parseCustomTheme({ accent: a, base: draft.base }); if (c) setDraft(c); };
  const currentText = p.current.name === "custom" && p.current.custom ? `Custom · ${p.current.custom.accent} on ${BASES[p.current.custom.base].label}` : THEME_LABEL[p.current.name as ThemeName] ?? "Dark";
  return <section className="oi-tp" aria-label="Theme colours">
    <div className="oi-tp-cur"><span>Current</span><b>{currentText}</b></div>

    <h3 className="oi-tp-h">Accent</h3>
    <div className="oi-tp-row">
      <input type="color" aria-label="Pick an accent colour" value={d.requested.accent} onChange={e => setAccent(e.target.value)} />
      <input className="oi-tp-hex" aria-label="Accent as hex" value={hex} spellCheck={false} maxLength={7} onChange={e => setAccent(e.target.value)} />
    </div>
    <div className="oi-tp-sugg" role="group" aria-label="Suggested accents">
      {SUGGESTED_ACCENTS.map(s => <button key={s.accent} type="button" className="oi-tp-sw" title={`${s.label} ${s.accent}`} aria-label={s.label} aria-pressed={d.requested.accent === s.accent} style={{ background: s.accent }} onClick={() => setAccent(s.accent)} />)}
    </div>

    <h3 className="oi-tp-h">Base</h3>
    <div className="oi-tp-bases" role="radiogroup" aria-label="Base tone" onKeyDown={e => {
      // WAI-ARIA radio group: arrows move AND select, wrapping; only the checked radio is in the tab order.
      const i = BASE_NAMES.indexOf(draft.base), step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = BASE_NAMES[(i + step + BASE_NAMES.length) % BASE_NAMES.length];
      setDraft({ ...draft, base: next });
      (e.currentTarget.children[BASE_NAMES.indexOf(next)] as HTMLButtonElement | undefined)?.focus();
    }}>
      {bases.map(({ b, t }) => <button key={b} type="button" role="radio" aria-checked={draft.base === b} tabIndex={draft.base === b ? 0 : -1} className="oi-tp-base" onClick={() => setDraft({ ...draft, base: b as BaseName })}>
        <span className="oi-tp-bsw" style={{ background: t.panel, boxShadow: `inset 0 -6px 0 ${t.bg}` }} aria-hidden="true" />{BASES[b].label}
      </button>)}
    </div>

    <h3 className="oi-tp-h">Preview</h3>
    <div className="oi-tp-prev" style={vars(customVars(d))}>
      <div className="oi-tp-pr oi-tp-sel"><span className="oi-tp-id">demo-3f1</span><span>Wire the export button</span></div>
      <div className="oi-tp-pr"><span className="oi-tp-id">demo-2c9</span><span>Define the schema</span><span className="oi-tp-chip">running</span></div>
      <div className="oi-tp-pr oi-tp-muted">captions stay grey · status stays its own colour</div>
      <button type="button" className="oi-tp-btn" tabIndex={-1}>Dispatch</button>
    </div>

    {note ? <p className={ok ? "oi-tp-nudge" : "oi-tp-err"} role="status">{note}</p>
      : <p className="oi-tp-ok" role="status">Legible: all {CONTRAST_PAIRS.length} contrast pairs and the distinctness rules pass.</p>}

    <div className="oi-tp-actions">
      <button type="button" className="oi-tp-apply" disabled={!ok} onClick={() => p.onApply({ accent: d.accent, base: draft.base })}>{d.nudge ? `Apply ${d.accent}` : "Apply"}</button>
      <span className="oi-tp-reset">Reset to preset:{THEME_NAMES.map(n => <button key={n} type="button" aria-pressed={p.current.name === n} onClick={() => p.onPreset(n)}>{THEME_LABEL[n]}</button>)}</span>
    </div>
  </section>;
}

// Tokens only. The preview box carries the DERIVED theme's custom properties, so its rules below show the candidate, while the
// rest of the picker stays in the current theme.
export const themePickerStyles = `
.oi-tp{display:flex;flex-direction:column;gap:6px;min-width:0;max-width:340px;font-size:12px;color:var(--oi-text)}
.oi-tp-cur{display:flex;gap:8px;align-items:baseline;color:var(--oi-muted)}.oi-tp-cur b{color:var(--oi-text);font-weight:600}
.oi-tp-h{margin:8px 0 0;font:600 10px var(--oi-font-head,system-ui,sans-serif);letter-spacing:.08em;text-transform:uppercase;color:var(--oi-muted)}
.oi-tp-row{display:flex;gap:8px;align-items:center}
.oi-tp-row input[type=color]{width:34px;height:26px;padding:0;border:0;background:transparent;cursor:pointer}
.oi-tp-hex{width:9ch;padding:4px 6px;border:0;border-radius:3px;background:var(--oi-input,var(--oi-hover));color:var(--oi-text);font:12px var(--oi-font-mono,ui-monospace,monospace)}
.oi-tp-sugg{display:flex;gap:6px}
.oi-tp-sw{width:22px;height:22px;border:0;border-radius:50%;cursor:pointer}
.oi-tp-sw[aria-pressed="true"]{box-shadow:0 0 0 2px var(--oi-bg),0 0 0 4px var(--oi-text)}
.oi-tp-bases{display:flex;gap:4px;flex-wrap:wrap}
.oi-tp-base{display:flex;align-items:center;gap:6px;padding:3px 8px 3px 4px;border:0;border-radius:4px;background:transparent;color:var(--oi-text-2,var(--oi-text));font:inherit;cursor:pointer}
.oi-tp-base[aria-checked="true"]{background:var(--oi-selected);color:var(--oi-text)}
.oi-tp-bsw{width:16px;height:16px;border-radius:3px}
.oi-tp-prev{display:flex;flex-direction:column;gap:2px;padding:8px;border-radius:6px;background:var(--oi-panel);color:var(--oi-text);font:12px var(--oi-font-ui,system-ui,sans-serif)}
.oi-tp-pr{display:flex;gap:8px;align-items:center;padding:3px 6px}
.oi-tp-sel{background:var(--oi-selected);box-shadow:inset 2px 0 0 var(--oi-accent),var(--oi-glow-active);color:var(--oi-selected-text)}
.oi-tp-id{font:11px var(--oi-font-mono,ui-monospace,monospace);color:var(--oi-muted)}.oi-tp-sel .oi-tp-id{color:var(--oi-selected-text)}
.oi-tp-chip{margin-left:auto;padding:0 6px;border-radius:9px;font-size:10px;color:var(--oi-tone-running);background:color-mix(in srgb,var(--oi-tone-running) var(--oi-tint,16%),transparent)}
.oi-tp-muted{font-size:11px;color:var(--oi-muted)}
.oi-tp-btn{align-self:flex-start;margin:4px 6px 0;padding:4px 12px;border:0;border-radius:5px;background:var(--oi-accent);color:var(--oi-on-accent);font-weight:600}
.oi-tp-ok{margin:4px 0 0;font-size:11px;color:var(--oi-tone-success)}
.oi-tp-nudge{margin:4px 0 0;font-size:11px;line-height:1.45;color:var(--oi-tone-attention)}
.oi-tp-err{margin:4px 0 0;font-size:11px;color:var(--oi-tone-failure)}
.oi-tp-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px}
.oi-tp-apply{padding:5px 12px;border:0;border-radius:5px;background:var(--oi-accent);color:var(--oi-on-accent);font-weight:600;cursor:pointer}
.oi-tp-apply:disabled{opacity:.4;cursor:default}
.oi-tp-reset{display:flex;gap:4px;align-items:center;font-size:11px;color:var(--oi-muted)}
.oi-tp-reset button{padding:2px 7px;border:0;border-radius:3px;background:transparent;color:var(--oi-text-2,var(--oi-text));font:inherit;cursor:pointer}
.oi-tp-reset button[aria-pressed="true"]{box-shadow:var(--oi-tab-underline)}
.oi-tp-reset button:hover{background:var(--oi-hover)}
.oi-tp :focus-visible{outline:2px solid var(--oi-focus,var(--oi-accent));outline-offset:1px}
`;
