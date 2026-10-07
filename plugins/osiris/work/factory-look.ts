// The Factory's SCOPED look (owner 01:31-01:41): the GRAND Factory defaults to a Cyberpunk signature; "Match app theme"
// (look="app") uses the user's theme tokens instead. Every other surface follows the app theme exactly as today, because the
// override is scoped to [data-oi-factory-look] on the Factory root and nothing here touches :root or a theme definition.
// Contract: ONE shared machine body colour (--oi-machine-body) and ONE distinct accent per station (--oi-station-*), used for
// trim, numeral and glow. The art (components/work/factory-machines.tsx) reads them with var() fallbacks to the app tones, so
// it renders correctly even before the theme tokens carry them. This file holds NO colour literal: the Cyberpunk values are
// imported from the theme, the app look uses var() references.
import type { StationId } from "./station-rules.ts";
import { THEMES } from "../theme/tokens.ts";

export type FactoryLook = "cyberpunk" | "app";
export const FACTORY_LOOKS: readonly FactoryLook[] = ["cyberpunk", "app"];
export const DEFAULT_FACTORY_LOOK: FactoryLook = "cyberpunk";
export const LOOK_ATTR = "data-oi-factory-look";

/** The Cyberpunk signature: one body, five neons. NOT restated here: every value is read from the Cyberpunk theme in
 * theme/tokens.ts, which owns --oi-station-* and --oi-machine-body per theme (one hex per token per scope; pinned in
 * work/__tests__/station-tokens.test.ts). This file only decides WHERE they apply (the scoped selector). */
const CT = THEMES.cyberpunk.tokens;
export const CYBERPUNK_LOOK = {
  bg: CT.bg, panel: CT.panel, body: CT.machineBody, text: CT.text, muted: CT.muted,
  station: { intake: CT.stationIntake, claim: CT.stationClaim, build: CT.stationBuild, gate: CT.stationGate, land: CT.stationLand } as Record<StationId, string>,
} as const;
/** The Match-app look: the same variables resolved from the app's own tokens. */
export const APP_LOOK_VARS: Record<StationId, string> = {
  intake: "var(--oi-tone-info)", claim: "var(--oi-tone-running)", build: "var(--oi-tone-attention)", gate: "var(--oi-accent,var(--oi-tone-attention))", land: "var(--oi-tone-success)",
};
const stationDecls = (m: Record<StationId, string>) => (Object.keys(m) as StationId[]).map(s => `--oi-station-${s}:${m[s]};`).join("");

/** Append once to the Factory's styles. cyberpunk also strengthens the glow tokens inside the scope only. */
export const factoryLookStyles = `
[${LOOK_ATTR}="cyberpunk"]{--oi-bg:${CT.bg};--oi-panel:${CT.panel};--oi-raised:${CT.raised};--oi-border:${CT.border};--oi-border-strong:${CT.borderStrong};--oi-machine-body:${CYBERPUNK_LOOK.body};${stationDecls(CYBERPUNK_LOOK.station)}--oi-factory-glow:0 0 4px currentColor,0 0 16px color-mix(in srgb,currentColor 60%,transparent)}
[${LOOK_ATTR}="app"]{--oi-machine-body:color-mix(in srgb,var(--oi-text) 8%,var(--oi-panel));${stationDecls(APP_LOOK_VARS)}--oi-factory-glow:none}
[${LOOK_ATTR}="cyberpunk"] .oi-fm-glow{filter:blur(9px)}
[${LOOK_ATTR}="cyberpunk"] .oi-fm.on .oi-fm-glow{opacity:.5}
[${LOOK_ATTR}="cyberpunk"] .oi-fm-beam,[${LOOK_ATTR}="cyberpunk"] .oi-fm-lamp{filter:drop-shadow(0 0 5px var(--m))}
`;
