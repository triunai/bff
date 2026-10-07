// Osiris themes as DATA. A theme is a value for every token below; it supplies the SAME --oi-* custom properties that
// ui-tokens.ts declares and every component already consumes, so switching theme changes no component code. Adding a theme
// is adding one entry to THEMES (the token test then holds it to every token and every contrast pair). Design: docs/design/ui-v2.md.
//
// Colour values are hex (#rrggbb, or #rrggbbaa for washes and hairlines) so theme/contrast.ts can measure them. Effect values
// (shadows, glows) are CSS and may reference other tokens with var().

/** Every token a theme must define, in display order. */
export const TOKEN_KEYS = [
  // Surfaces. ONE contained level per region (panel); raised is for overlays only; input is for field fills only.
  "bg", "panel", "raised", "input",
  // Lines: hairline between rows, strong rule between sections. Decoration only, never the sole signal.
  "border", "borderStrong",
  // Washes laid over a surface (alpha): pointer hover, selected row. A selected item = selected wash + selectedBorder ring
  // (via glowActive, a shadow, never a border) + selectedText ink.
  "hover", "selected", "selectedBorder", "selectedText",
  // Text tiers: primary, secondary, captions/metadata.
  "text", "text2", "muted",
  // Accent: the active / selected thing and the primary action. onAccent is ink on a solid accent fill; focus is the ring.
  "accent", "accentHover", "accentStrong", "onAccent", "focus",
  // Status tones (owner meaning, ui-tokens.ts): info blue, running cyan, success green, attention (needs a look), failure red.
  "info", "running", "success", "attention", "failure",
  // Drift: a mismatch between tracker and reality (claimed / no agent, agent / no bead, closed / worktree dirty). Deliberately
  // NOT a status tone: it is the one SOLID badge in the system (onDrift ink on a drift fill), so it reads as "the data disagrees".
  "drift", "onDrift",
  // Rework: the Factory's return conveyor ("sent back"), read by factory-floor.tsx as --oi-rework (10px badge text on the
  // panel, and a 14% bed). Its own colour: never the accent, a heat step, drift or attention (token test: ΔE).
  "rework",
  // Heat ramp for the Factory's heat mode, cold → hot. Fills, not text; heatInk() names the legible ink per step. Kept a
  // different colour from the accent at every step (token test: ΔE), so "hot" never reads as "selected".
  "heat0", "heat1", "heat2", "heat3", "heat4",
  // One hue FAMILY per heat mode (owner 01:11: "diff hues for diff tabs"), 5 steps each, 0 = cool/neutral, 4 = extreme. Age amber -> ember,
  // Rework violet, Blocking crimson, Cost cyan -> electric blue -> white-hot. heatColorVar/heatTextVar (work/heat-ramps.ts) name them.
  "heatAge0", "heatAge1", "heatAge2", "heatAge3", "heatAge4", "heatRework0", "heatRework1", "heatRework2", "heatRework3", "heatRework4", "heatBlock0", "heatBlock1", "heatBlock2", "heatBlock3", "heatBlock4", "heatCost0", "heatCost1", "heatCost2", "heatCost3", "heatCost4",
  // Branch / work-group identity hues. Carry no outcome meaning.
  "lane0", "lane1", "lane2", "lane3", "lane4", "lane5", "lane6", "lane7",
  // Elevation colours (overlays only).
  // Station accents (one per Factory station): what colours a bead id by where it is, and ON THE FLOOR events by where they happen.
  "stationIntake", "stationClaim", "stationBuild", "stationGate", "stationLand",
  // The ONE body colour shared by all five Factory machines (accents carry the station; the body never does).
  "machineBody",
  // Provider marks (Home mockup --p-claude / --p-codex / --p-gemini): the stacked cost bar, its legend and the provider chips.
  "providerClaude", "providerCodex", "providerGemini",
  "shadow", "scrim",
  // Effects (CSS values; "none" where a theme is calm). glow: text-shadow on emphasis. glowActive: box-shadow under the active /
  // selected element; it is COMBINED with other shadows, so a calm theme uses the transparent no-op "0 0 #0000", never "none".
// shadowRaised: box-shadow of overlays. tabUnderline: box-shadow marking the active tab. scanline: background-image.
  "glow", "glowActive", "shadowRaised", "tabUnderline", "scanline",
  // Type families (system stacks only, no web fonts).
  "fontUi", "fontMono", "fontHead",
  // Badge / status-background tint as a CSS percentage: color-mix(in srgb, var(--oi-tone-x) var(--oi-tint), transparent).
  "tint",
] as const;

export type TokenKey = (typeof TOKEN_KEYS)[number];
export type ThemeTokens = Record<TokenKey, string>;
export type ThemeDef = { label: string; colorScheme: "dark" | "light"; tokens: ThemeTokens };

/** The custom property each token writes. Existing ui-tokens.ts names are reused; the rest are new and additive. */
export const TOKEN_VAR: Record<TokenKey, `--oi-${string}`> = {
  bg: "--oi-bg", panel: "--oi-panel", raised: "--oi-raised", input: "--oi-input",
  border: "--oi-border", borderStrong: "--oi-border-strong",
  hover: "--oi-hover", selected: "--oi-selected", selectedBorder: "--oi-selected-border", selectedText: "--oi-selected-text",
  text: "--oi-text", text2: "--oi-text-2", muted: "--oi-tone-muted",
  accent: "--oi-accent", accentHover: "--oi-accent-hover", accentStrong: "--oi-accent-strong", onAccent: "--oi-on-accent", focus: "--oi-focus",
  info: "--oi-tone-info", running: "--oi-tone-running", success: "--oi-tone-success", attention: "--oi-tone-attention", failure: "--oi-tone-failure",
  drift: "--oi-drift", onDrift: "--oi-on-drift",
  rework: "--oi-rework",
  heat0: "--oi-heat-0", heat1: "--oi-heat-1", heat2: "--oi-heat-2", heat3: "--oi-heat-3", heat4: "--oi-heat-4",
  heatAge0: "--oi-heat-age-0", heatAge1: "--oi-heat-age-1", heatAge2: "--oi-heat-age-2", heatAge3: "--oi-heat-age-3", heatAge4: "--oi-heat-age-4", heatRework0: "--oi-heat-rework-0", heatRework1: "--oi-heat-rework-1", heatRework2: "--oi-heat-rework-2", heatRework3: "--oi-heat-rework-3", heatRework4: "--oi-heat-rework-4", heatBlock0: "--oi-heat-block-0", heatBlock1: "--oi-heat-block-1", heatBlock2: "--oi-heat-block-2", heatBlock3: "--oi-heat-block-3", heatBlock4: "--oi-heat-block-4", heatCost0: "--oi-heat-cost-0", heatCost1: "--oi-heat-cost-1", heatCost2: "--oi-heat-cost-2", heatCost3: "--oi-heat-cost-3", heatCost4: "--oi-heat-cost-4",
  lane0: "--oi-lane-0", lane1: "--oi-lane-1", lane2: "--oi-lane-2", lane3: "--oi-lane-3",
  lane4: "--oi-lane-4", lane5: "--oi-lane-5", lane6: "--oi-lane-6", lane7: "--oi-lane-7",
  stationIntake: "--oi-station-intake", stationClaim: "--oi-station-claim", stationBuild: "--oi-station-build", stationGate: "--oi-station-gate", stationLand: "--oi-station-land", machineBody: "--oi-machine-body",
  providerClaude: "--oi-provider-claude", providerCodex: "--oi-provider-codex", providerGemini: "--oi-provider-gemini",
  shadow: "--oi-shadow", scrim: "--oi-scrim",
  glow: "--oi-glow", glowActive: "--oi-glow-active", shadowRaised: "--oi-shadow-raised", tabUnderline: "--oi-tab-underline", scanline: "--oi-scanline",
  fontUi: "--oi-font-ui", fontMono: "--oi-font-mono", fontHead: "--oi-font-head",
  tint: "--oi-tint",
};

const NON_COLOUR: readonly TokenKey[] = ["glow", "glowActive", "shadowRaised", "tabUnderline", "scanline", "fontUi", "fontMono", "fontHead", "tint"];
/** Tokens that hold a colour (and so may appear in a contrast pair). */
export const COLOUR_KEYS: readonly TokenKey[] = TOKEN_KEYS.filter(k => !NON_COLOUR.includes(k));
export const HEAT_KEYS = ["heat0", "heat1", "heat2", "heat3", "heat4"] as const;
/** The per-mode heat families, each a 5-step ramp (token keys heatAge0..4 etc.). */
export const HEAT_FAMILIES = ["Age", "Rework", "Block", "Cost"] as const;
export type HeatFamily = (typeof HEAT_FAMILIES)[number];
export const HEAT_FAMILY_KEYS: Record<HeatFamily, readonly TokenKey[]> = {
  Age: ["heatAge0", "heatAge1", "heatAge2", "heatAge3", "heatAge4"],
  Rework: ["heatRework0", "heatRework1", "heatRework2", "heatRework3", "heatRework4"],
  Block: ["heatBlock0", "heatBlock1", "heatBlock2", "heatBlock3", "heatBlock4"],
  Cost: ["heatCost0", "heatCost1", "heatCost2", "heatCost3", "heatCost4"],
};
export const TONE_KEYS = ["info", "running", "success", "attention", "failure"] as const;
export const LANE_KEYS = ["lane0", "lane1", "lane2", "lane3", "lane4", "lane5", "lane6", "lane7"] as const;

const SANS = "ui-sans-serif,system-ui,-apple-system,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";

export const THEMES = {
  /** Default. Owner palette override (22:32): "black chassis + glowing status LED". NEUTRAL graphite blacks (the earlier warm
   *  blacks read brown), orange ON TOP as signal; roughly 90% black/graphite, 7% grey/white, 3% orange. Accent surfaces are
   *  TRANSPARENT orange, never an opaque brown. Values are the owner's except where marked "derived" (with the reason). */
  dark: {
    label: "Dark",
    colorScheme: "dark",
    tokens: {
      bg: "#07090c", panel: "#0b0e12", raised: "#171c22", input: "#11151a", // owner surfaces 0 / 1 / 3 (hover/raised) / 2
      border: "#232a32", borderStrong: "#303842",
      hover: "#171c22", selected: "#ff7a181a", selectedBorder: "#ff7a1859", selectedText: "#ff9a4a", // .10 bg, .35 border
      // muted = the owner's #9AA3AE. text2 is derived (the owner gives two text greys, the token set has three). The owner's
      // "faint" #626B76 measures 3.17-3.69:1, below AA for 10-11px captions, so it is NOT a text token (non-text use only).
      text: "#f4f6f8", text2: "#c5ccd4", muted: "#9aa3ae",
      accent: "#ff7a18", accentHover: "#ff9138", accentStrong: "#e96000", onAccent: "#07090c", focus: "#ff7a18",
      // Owner status set. running is derived (#67E8F9): the owner's set has no "running", and info #38BDF8 is taken.
      info: "#38bdf8", running: "#67e8f9", success: "#34d399", attention: "#dceb4f", failure: "#fb7185",
      drift: "#a78bfa", onDrift: "#07090c", // the owner's purple: the one status hue nothing else uses
      rework: "#ffc9de", // re-picked: peach sat ΔE 25.6 from the #FF9A4A selected text, rose #f9a8d4 ΔE 14.8 from lane5
      heat0: "#3b1a0e", heat1: "#6e2410", heat2: "#b2341a", heat3: "#ffd27a", heat4: "#fff1d0", // heat3 was #ffc45c: ΔE 23 from selectedText
      heatAge0: "#2e2112", heatAge1: "#6b4710", heatAge2: "#9c5a0e", heatAge3: "#ff8c1f", heatAge4: "#ffb36b",
      heatRework0: "#2a1236", heatRework1: "#5a1f78", heatRework2: "#a82aa0", heatRework3: "#e060f0", heatRework4: "#f8b4ff",
      heatBlock0: "#2e0d15", heatBlock1: "#6a1228", heatBlock2: "#b01a3c", heatBlock3: "#ff3d62", heatBlock4: "#ff9aae",
      heatCost0: "#0a2a36", heatCost1: "#0e5f80", heatCost2: "#1f5ce6", heatCost3: "#5ecbff", heatCost4: "#f4fdff",
      lane0: "#6fa8f0", lane1: "#5ccfa6", lane2: "#c99ae6", lane3: "#e8d27a",
      lane4: "#62cde3", lane5: "#ec8aa8", lane6: "#b8cc62", lane7: "#9aa2f2",
      stationIntake: "#7ea6ff", stationClaim: "#f5c542", stationBuild: "#ff9a4a", stationGate: "#eb33ff", stationLand: "#46e07a", // five hues, each >= 4.5:1 on panel and ΔE >= 12 from the attention / success / failure / running tones and each other (pinned)
      machineBody: "#131920",
      providerClaude: "#ffb13d", providerCodex: "#34d399", providerGemini: "#38bdf8", // the mockup's Dark --p-* values
      shadow: "#00000099", scrim: "#000000c2",
      glow: "none",
      glowActive: "inset 0 0 0 1px var(--oi-selected-border),0 0 14px -4px #ff7a1833", // owner: border .35 + glow .20
      shadowRaised: "0 12px 32px -8px #000000cc",
      tabUnderline: "inset 0 -2px 0 var(--oi-accent)",
      scanline: "none",
      fontUi: SANS, fontMono: MONO, fontHead: SANS,
      tint: "10%", // owner: status backgrounds at 10%
    },
  },
  /** Near-black base, three neons (magenta accent, cyan running, acid-yellow attention/focus). Fold 2 ("more ... add some shadows"):
   *  stronger hairlines, a two-layer glow on emphasis, a neon glow UNDER active elements, neon-rimmed floating overlays and a
   *  glowing tab underline. Depth comes from shadows, never from extra boxes. */
  cyberpunk: {
    label: "Cyberpunk",
    colorScheme: "dark",
    tokens: {
      bg: "#05080d", panel: "#0a1119", raised: "#101b28", input: "#0c141d", // lane AC: blue-black control room (owner brief 2026-10-07), not violet-black
      border: "#7a9cc42b", borderStrong: "#7a9cc459", // subtle blue-grey outlines; the cyan lives in the grid and the road centre lines
      hover: "#00e5ff14", selected: "#ff4fd82e", selectedBorder: "#ff4fd859", selectedText: "#eaf6ff",
      text: "#eaf6ff", text2: "#b0c0e0", muted: "#8a98bc",
      accent: "#ff4fd8", accentHover: "#ff7ae3", accentStrong: "#e03cbf", onAccent: "#05050b", focus: "#f4ff3a",
      info: "#5aa9ff", running: "#00e5ff", success: "#3dff9a", attention: "#f4ff3a", failure: "#ff5c7a",
      drift: "#ff8c1a", onDrift: "#05050b",
      rework: "#7cffd9", // neon mint: the one free neon (violet sat within ΔE 10 of lane2, coral within ΔE 21 of drift and heat)
      heat0: "#2b0a0a", heat1: "#6b1414", heat2: "#d42a2a", heat3: "#ffd21f", heat4: "#fffbd1",
      heatAge0: "#2e2112", heatAge1: "#6b4710", heatAge2: "#9c5a0e", heatAge3: "#ff8c1f", heatAge4: "#ffb36b",
      heatRework0: "#2a1236", heatRework1: "#5a1f78", heatRework2: "#a82aa0", heatRework3: "#e060f0", heatRework4: "#f8b4ff",
      heatBlock0: "#2e0d15", heatBlock1: "#6a1228", heatBlock2: "#b01a3c", heatBlock3: "#ff3d62", heatBlock4: "#ff9aae",
      heatCost0: "#0a2a36", heatCost1: "#0e5f80", heatCost2: "#1f5ce6", heatCost3: "#5ecbff", heatCost4: "#f4fdff",
      lane0: "#5aa9ff", lane1: "#3dff9a", lane2: "#c77dff", lane3: "#ffb13d",
      lane4: "#00e5ff", lane5: "#ff7ab8", lane6: "#b8ff3d", lane7: "#9a9aff",
      stationIntake: "#6aa8ff", stationClaim: "#2fb8e8", stationBuild: "#ffcc33", stationGate: "#eb33ff", stationLand: "#2fd070", // brief: cyan/blue Intake+Claim, yellow Build, magenta Gate, green Land
      machineBody: "#101b28",
      providerClaude: "#ffb13d", providerCodex: "#3dff9a", providerGemini: "#5aa9ff", // the mockup's Cyberpunk --p-* values
      shadow: "#000000b3", scrim: "#000000cc",
      glow: "0 0 4px currentColor,0 0 14px color-mix(in srgb,currentColor 55%,transparent)",
      glowActive: "0 0 0 1px color-mix(in srgb,var(--oi-accent) 35%,transparent),0 6px 22px -6px color-mix(in srgb,var(--oi-accent) 75%,transparent)",
      shadowRaised: "0 0 0 1px color-mix(in srgb,var(--oi-tone-running) 30%,transparent),0 18px 48px -12px #000000e6,0 0 30px -8px color-mix(in srgb,var(--oi-tone-running) 40%,transparent)",
      tabUnderline: "inset 0 -2px 0 var(--oi-accent),0 10px 16px -12px var(--oi-accent)",
      scanline: "repeating-linear-gradient(180deg,#ffffff0a 0 1px,#00000000 1px 3px)",
      fontUi: SANS, fontMono: MONO, fontHead: MONO,
      tint: "16%",
    },
  },
} as const satisfies Record<string, ThemeDef>;

/** A theme that follows the BB host (today's behaviour). It writes NO custom properties: ui-tokens.ts tokenCss derives the
 *  original --oi-* names from BB's variables, and HOST_DEFAULTS derives every name v2 added. */
export const HOST_THEME = "match-bb";
export type TokenThemeName = keyof typeof THEMES;
export type ThemeName = TokenThemeName | typeof HOST_THEME;
/** Menu order (owner): Dark (default), Cyberpunk, Match BB. */
export const THEME_NAMES: readonly ThemeName[] = [...(Object.keys(THEMES) as TokenThemeName[]), HOST_THEME];
export const THEME_LABEL: Record<ThemeName, string> = { dark: THEMES.dark.label, cyberpunk: THEMES.cyberpunk.label, [HOST_THEME]: "Match BB" };
export const DEFAULT_THEME: ThemeName = "dark";

export const isThemeName = (x: unknown): x is ThemeName => x === HOST_THEME || (typeof x === "string" && Object.prototype.hasOwnProperty.call(THEMES, x));
/** Any persisted or user-supplied value → a real theme. Unknown, stale or missing names fall back to Dark. */
export const resolveTheme = (x: unknown): ThemeName => (isThemeName(x) ? x : DEFAULT_THEME);

/** The CSS custom-property map for a theme (unknown name → Dark), plus color-scheme. Match BB → {} (nothing overridden). */
export function themeVars(name: unknown): Record<string, string> {
  const n = resolveTheme(name);
  if (n === HOST_THEME) return {};
  const def: ThemeDef = THEMES[n];
  const out: Record<string, string> = {};
  for (const k of TOKEN_KEYS) out[TOKEN_VAR[k]] = def.tokens[k];
  out["color-scheme"] = def.colorScheme;
  return out;
}

/** Host-derived values for the names v2 adds (tokenCss already derives the rest). Used by Match BB, and as the base layer
 *  under every theme. light-dark() follows BB's colour scheme exactly as tokenCss does. */
export const HOST_DEFAULTS: Record<string, string> = {
  "--oi-raised": "var(--popover,var(--oi-panel))",
  "--oi-input": "color-mix(in srgb,var(--oi-text) 5%,var(--oi-bg))",
  "--oi-border-strong": "color-mix(in srgb,var(--oi-text) 20%,var(--oi-bg))",
  "--oi-text-2": "color-mix(in srgb,var(--oi-text) 78%,var(--oi-bg))",
  "--oi-on-accent": "var(--primary-foreground,Canvas)",
  "--oi-focus": "var(--ring,var(--oi-accent))",
  "--oi-drift": "light-dark(#9c2fb0,#e58cf5)",
  "--oi-on-drift": "light-dark(#ffffff,#16061c)",
  "--oi-rework": "light-dark(#a8481f,#ffb38a)",
  "--oi-heat-0": "light-dark(#fdeee0,#3b1a0e)",
  "--oi-heat-1": "light-dark(#f8c9a0,#6e2410)",
  "--oi-heat-2": "light-dark(#e8743a,#b2341a)",
  "--oi-heat-3": "light-dark(#b8361a,#ffc45c)",
  "--oi-heat-4": "light-dark(#6e1a0c,#fff1d0)",
  "--oi-heat-age-0": "light-dark(#fdf3e0,#2e2112)",
  "--oi-heat-age-1": "light-dark(#f6d9a0,#6b4710)",
  "--oi-heat-age-2": "light-dark(#e8a23a,#9c5a0e)",
  "--oi-heat-age-3": "light-dark(#b8620e,#ff8c1f)",
  "--oi-heat-age-4": "light-dark(#6e3406,#ffb36b)",
  "--oi-heat-rework-0": "light-dark(#f8e8fc,#2a1236)",
  "--oi-heat-rework-1": "light-dark(#e8c0f4,#5a1f78)",
  "--oi-heat-rework-2": "light-dark(#c46ade,#a82aa0)",
  "--oi-heat-rework-3": "light-dark(#8a2aa8,#e060f0)",
  "--oi-heat-rework-4": "light-dark(#4c1262,#f8b4ff)",
  "--oi-heat-block-0": "light-dark(#fdeaee,#2e0d15)",
  "--oi-heat-block-1": "light-dark(#f6c0cc,#6a1228)",
  "--oi-heat-block-2": "light-dark(#e8607a,#b01a3c)",
  "--oi-heat-block-3": "light-dark(#b01a3c,#ff3d62)",
  "--oi-heat-block-4": "light-dark(#6a0e24,#ff9aae)",
  "--oi-heat-cost-0": "light-dark(#e6f6fc,#0a2a36)",
  "--oi-heat-cost-1": "light-dark(#b0e0f4,#0e5f80)",
  "--oi-heat-cost-2": "light-dark(#4a9ee8,#1f5ce6)",
  "--oi-heat-cost-3": "light-dark(#1a54c8,#5ecbff)",
  "--oi-heat-cost-4": "light-dark(#0a1e4c,#f4fdff)",
  "--oi-station-intake": "light-dark(#2a58c8,#7ea6ff)",
  "--oi-station-claim": "light-dark(#6b6b00,#f5c542)",
  "--oi-station-build": "light-dark(#a8480a,#ff9a4a)",
  "--oi-station-gate": "light-dark(#a21caf,#eb33ff)",
  "--oi-station-land": "light-dark(#157a38,#46e07a)",
  "--oi-machine-body": "light-dark(#f0f2f6,#131920)",
  "--oi-provider-claude": "light-dark(#b45309,#ffb13d)",
  "--oi-provider-codex": "light-dark(#157a38,#34d399)",
  "--oi-provider-gemini": "light-dark(#0369a1,#38bdf8)",
  "--oi-glow": "none",
  "--oi-glow-active": "0 0 #0000",
  "--oi-shadow-raised": "0 12px 32px -8px var(--oi-shadow)",
  "--oi-tab-underline": "inset 0 -2px 0 var(--oi-accent)",
  "--oi-scanline": "none",
  "--oi-font-ui": SANS,
  "--oi-font-mono": MONO,
  "--oi-font-head": SANS,
  "--oi-selected-border": "color-mix(in srgb,var(--oi-accent) 35%,transparent)",
  "--oi-selected-text": "var(--oi-text)",
  "--oi-accent-hover": "color-mix(in srgb,var(--oi-accent) 85%,var(--oi-text))",
  "--oi-accent-strong": "color-mix(in srgb,var(--oi-accent) 85%,var(--oi-bg))",
  "--oi-tint": "16%",
};

/** The theme stylesheet: the host-default layer first, then one rule per token theme keyed by attribute
 *  (`<sel>[data-oi-theme="x"]`, specificity 0,2,0, so it beats both tokenCss and the host layer). The attribute (not an inline
 *  style) is the switch, so a portalled overlay carrying the same attribute gets the same tokens (the Ops portal lesson).
 *  Match BB has no rule: its attribute matches nothing, so the host layer and tokenCss show through. */
export function themeCss(selectors: readonly string[] = [".oi-root", "[data-bb-portaled-overlay]"]): string {
  const decl = (m: Record<string, string>) => Object.entries(m).map(([p, v]) => `${p}:${v}`).join(";");
  const host = `${selectors.join(",")}{${decl(HOST_DEFAULTS)}}`;
  const themed = (Object.keys(THEMES) as TokenThemeName[]).map(n => `${selectors.map(s => `${s}[data-oi-theme="${n}"]`).join(",")}{${decl(themeVars(n))}}`);
  return [host, ...themed].join("\n");
}

/** Every text-on-surface pair the UI actually draws, measured in EVERY token theme by the token test.
 *  `on` is the background stack, bottom first: a wash token is measured composited over its surface.
 *  min 4.5 = body text (Osiris sets most text at 10-13px, so tones and captions are body text); 3 = large text / non-text indicator. */
export type ContrastPair = { fg: TokenKey; on: readonly TokenKey[]; min: 4.5 | 3; use: string };

const SURFACES: readonly (readonly TokenKey[])[] = [["bg"], ["panel"], ["raised"]];
const WASHED: readonly (readonly TokenKey[])[] = [["panel", "hover"], ["panel", "selected"], ["bg", "hover"], ["bg", "selected"]];
const body = (fg: TokenKey, on: readonly (readonly TokenKey[])[], use: string): ContrastPair[] => on.map(o => ({ fg, on: o, min: 4.5, use }));

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...body("text", [...SURFACES, ["input"], ...WASHED], "primary text, rows, inputs"),
  ...body("text2", [...SURFACES, ...WASHED], "secondary text"),
  ...body("muted", [...SURFACES, ...WASHED], "captions, ids, timestamps, empty states (10-11px)"),
  ...body("accent", [...SURFACES, ["panel", "selected"]], "links, active nav item, logo"),
  ...TONE_KEYS.flatMap(t => body(t, [...SURFACES, ["panel", "selected"]], "status words, stat numerals, lane headings")),
  ...LANE_KEYS.flatMap(l => body(l, [["bg"], ["panel"]], "work-group labels (12px 600)")),
  { fg: "onAccent", on: ["accent"], min: 4.5, use: "ink on a solid accent button" },
  { fg: "onAccent", on: ["accentHover"], min: 4.5, use: "ink on a hovered accent button" },
  { fg: "onAccent", on: ["accentStrong"], min: 4.5, use: "ink on a pressed accent button" },
  ...body("selectedText", [["panel", "selected"], ["bg", "selected"], ["raised", "selected"]], "the selected item's label"),
  ...body("drift", [...SURFACES, ["panel", "selected"]], "mismatch word and row edge"),
  { fg: "onDrift", on: ["drift"], min: 4.5, use: "ink on the solid DRIFT badge" },
  ...body("rework", [...SURFACES, ["panel", "selected"]], "Factory return-lane badge text (10px)"),
  // The WORK tree's selected row (beady-eye arkham parity): a full-width light band (text colour) with page-black ink, and
  // status chips on it in page-black ink. The accent chip is onAccent on accent (above).
  { fg: "bg", on: ["text"], min: 4.5, use: "ink on the WORK tree's light selection band" },
  ...(["success", "attention", "failure", "muted"] as const).map((k): ContrastPair => ({ fg: "bg", on: [k], min: 4.5, use: `page-black ink on a ${k} chip in the selection band` })),
  ...(["bg", "panel", "raised"] as const).map((s): ContrastPair => ({ fg: "focus", on: [s], min: 3, use: "focus ring (non-text)" })),
  { fg: "accent", on: ["panel"], min: 3, use: "selected-row left edge (non-text)" },
];

/** Per-mode heat families: steps from this one up take the page-black ink, below it the light text (audit: heatFamilyProblems). */
export const FAMILY_DARK_INK_FROM = 3;
export const heatFamilyInk = (step: number): TokenKey => (step >= FAMILY_DARK_INK_FROM ? "bg" : "text");

/** The legible ink on a heat step: light text on the dark (ember) end, the page black on the hot (yellow-white) end. */
export const heatInk = (step: (typeof HEAT_KEYS)[number]): TokenKey => (step === "heat3" || step === "heat4" ? "bg" : "text");

/** Badges and chips are a tint + ink pair (never an outline): the ink is the tone itself (see badgeInk), on the tone at the
 *  theme's `tint` over the surface. CSS: `color-mix(in srgb, var(--oi-tone-x) var(--oi-tint), transparent)`. Dark uses the
 *  owner's 10%; Cyberpunk and the host layer use this default. The token test measures every tone and lane at each theme's tint. */
export const BADGE_TINT_PCT = 16;
/** A theme's tint token ("10%") as a number. */
export const tintPct = (t: ThemeTokens): number => Number(/^(\d+(?:\.\d+)?)%$/.exec(t.tint)?.[1] ?? NaN);
/** The same tint as a two-digit hex alpha, for measuring: 16% of 255, rounded. */
export const badgeTintHex = (pct: number = BADGE_TINT_PCT): string => Math.round((pct / 100) * 255).toString(16).padStart(2, "0");
/** The ink for a badge of a given hue: the hue itself, EXCEPT the neutral (muted) badge, which uses text2. Grey ink on its own
 *  grey tint is the weakest badge pair (it failed AA on the first Dark overlay, 4.28:1); the Ops console's neutral badge makes
 *  the same move. */
export const badgeInk = (tint: TokenKey): TokenKey => (tint === "muted" ? "text2" : tint);

/** The Factory return lane's bed: rework at this share over the panel (factory-floor.tsx `.oi-ff-lanebed`, 14%). */
export const REWORK_BED_PCT = 14;
