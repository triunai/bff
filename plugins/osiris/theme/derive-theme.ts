// PURE custom-theme derivation for the colour picker (owner P0 22:57, td-osi.12.1). The user picks ONE accent (the emission
// colour) and optionally a base from a short graphite range; every token is DERIVED from those two inputs, never hand-set.
//
// The owner's 90/7/3 rule holds by construction: the neutral chassis (surfaces, borders, text) comes only from the base, the
// status tones / drift / heat / lanes stay the owner's Dark values, and the pick reaches ONLY the accent family (ACCENT_FAMILY).
// The guard is the SAME audit the presets pass (theme/audit.ts). A pick that fails is moved to the nearest passing variant
// (lightness first, then saturation, then hue) and the result says what moved and why.
import { auditTheme, hue, hueGap, reworkBedFailures, reworkClashes } from "./audit.ts";
import { contrast, deltaE, lab, parseHex } from "./contrast.ts";
import { DEFAULT_THEME, resolveTheme, THEMES, TOKEN_KEYS, TOKEN_VAR, TONE_KEYS, type ThemeName, type ThemeTokens, type TokenKey } from "./tokens.ts";

export const CUSTOM_THEME = "custom";
export type BaseName = "ink" | "graphite" | "carbon" | "slate";
export type CustomTheme = { accent: string; base: BaseName };
export type Nudge = { kind: "lightness" | "saturation" | "hue"; from: string; to: string; why: string[] };
export type Derived = { requested: CustomTheme; accent: string; tokens: ThemeTokens; nudge: Nudge | null; problems: string[] };

/** The short graphite range. `lift` mixes the owner's surfaces toward a cool grey (+) or toward black (−); 0 = the owner's own. */
export const BASES: Record<BaseName, { label: string; lift: number }> = {
  ink: { label: "Ink", lift: -0.35 }, graphite: { label: "Graphite", lift: 0 }, carbon: { label: "Carbon", lift: 0.03 }, slate: { label: "Slate", lift: 0.06 },
};
export const BASE_NAMES = Object.keys(BASES) as BaseName[];
export const DEFAULT_CUSTOM: CustomTheme = { accent: THEMES.dark.tokens.accent, base: "graphite" };
/** Suggested starting accents for the picker, one per free hue window (each passes the guard unchanged; pinned by test). */
export const SUGGESTED_ACCENTS: readonly { label: string; accent: string }[] = [
  { label: "Owner orange", accent: THEMES.dark.tokens.accent }, { label: "Amber", accent: "#dc8300" }, { label: "Lime", accent: "#7ee05a" },
  { label: "Orchid", accent: "#d86bf7" }, { label: "Magenta", accent: "#f05ad8" },
];

/** Tokens a pick may change. Everything else is the base's or the owner's, which is what keeps the chassis ~90% neutral. */
export const ACCENT_FAMILY: readonly TokenKey[] = ["accent", "accentHover", "accentStrong", "onAccent", "focus", "selected", "selectedBorder", "selectedText", "glowActive", "rework"];
/** Tokens the base may change. */
export type BaseKey = "bg" | "panel" | "raised" | "input" | "hover" | "border" | "borderStrong";
export const BASE_FAMILY: readonly BaseKey[] = ["bg", "panel", "raised", "input", "hover", "border", "borderStrong"];

// ---- colour maths (hex ↔ HSL, mixing) --------------------------------------------------------------------------------------
const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
const toHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a), y = parseHex(b);
  return toHex(x.r + (y.r - x.r) * t, x.g + (y.g - x.g) * t, x.b + (y.b - x.b) * t);
}
/** Same as mix but keeps a's alpha suffix (for #rrggbbaa hairlines/washes). */
const mixKeepAlpha = (a: string, b: string, t: number) => mix(a.slice(0, 7), b, t) + (a.length === 9 ? a.slice(7) : "");
export function toHsl(h: string): { h: number; s: number; l: number } {
  const { r, g, b } = parseHex(h), [R, G, B] = [r / 255, g / 255, b / 255];
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), l = (mx + mn) / 2, d = mx - mn;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: hue(h), s, l };
}
export function fromHsl(hh: number, s: number, l: number): string {
  const H = ((hh % 360) + 360) % 360, S = Math.max(0, Math.min(1, s)), L = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * L - 1)) * S, x = c * (1 - Math.abs(((H / 60) % 2) - 1)), m = L - c / 2;
  const [r, g, b] = H < 60 ? [c, x, 0] : H < 120 ? [x, c, 0] : H < 180 ? [0, c, x] : H < 240 ? [0, x, c] : H < 300 ? [x, 0, c] : [c, 0, x];
  return toHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}
const chroma = (h: string) => { const { a, b } = lab(parseHex(h)); return Math.hypot(a, b); };

// ---- derivation -----------------------------------------------------------------------------------------------------------
/** Rework candidates, in a fixed order (determinism): pastels around the wheel. The first that clears every rule wins. */
const REWORK_CANDIDATES = ["#ffc9de", "#f5d0fe", "#c7f9e5", "#fde2b3", "#d6e4ff", "#ffd6cc", "#e9d5ff", "#d1fae5", "#fbcfe8", "#cffafe"];

function baseSurfaces(base: BaseName): Pick<ThemeTokens, BaseKey> {
  const d = THEMES.dark.tokens, { lift } = BASES[base];
  const toward = lift >= 0 ? "#9aa6b4" : "#000000", t = Math.abs(lift);
  return { bg: mix(d.bg, toward, t), panel: mix(d.panel, toward, t), raised: mix(d.raised, toward, t), input: mix(d.input, toward, t), hover: mix(d.hover, toward, t), border: mixKeepAlpha(d.border, toward, t), borderStrong: mixKeepAlpha(d.borderStrong, toward, t) };
}

/** Build the full token set for one accent on one base (no guard). */
export function buildTokens(accent: string, base: BaseName): ThemeTokens {
  const d = THEMES.dark.tokens;
  const t: ThemeTokens = { ...d, ...baseSurfaces(base) };
  t.accent = accent;
  t.accentHover = mix(accent, "#ffffff", 0.12);
  t.accentStrong = mix(accent, "#000000", 0.12);
  t.focus = accent;
  t.selected = `${accent}1a`; // owner: accent surfaces are transparent, .10
  t.selectedBorder = `${accent}59`; // .35
  t.selectedText = mix(accent, "#ffffff", 0.25);
  t.glowActive = `inset 0 0 0 1px var(--oi-selected-border),0 0 14px -4px ${accent}33`; // .20 glow
  // Ink on the solid accent: the page black when it reads on all three accent fills, else the light text.
  const fills = [t.accent, t.accentHover, t.accentStrong];
  t.onAccent = fills.every(f => contrast(t.bg, [f]) >= 4.5) ? t.bg : t.text;
  t.rework = REWORK_CANDIDATES.find(c => reworkOk({ ...t, rework: c })) ?? REWORK_CANDIDATES.reduce((best, c) => (minReworkGap({ ...t, rework: c }) > minReworkGap({ ...t, rework: best }) ? c : best));
  return t;
}
/** Rework's own rules (from the shared audit) plus its body-text contrast on every surface; the full audit runs after. */
const reworkOk = (t: ThemeTokens) => reworkClashes(t).length === 0 && reworkBedFailures(t).length === 0 && (["bg", "panel", "raised"] as const).every(s => contrast(t.rework, [t[s]]) >= 4.5);
const minReworkGap = (t: ThemeTokens) => Math.min(...(["accent", "selectedText", "drift", "attention", "heat0", "heat1", "heat2", "heat3", "heat4"] as const).map(k => deltaE(t.rework, t[k])));

/** The guard: the shared preset audit (incl. the neutral chassis) plus "the accent is an EMISSION": Lab chroma >= 30, never grey. */
export function customProblems(t: ThemeTokens): string[] {
  const out = auditTheme(t, { chassis: true });
  if (chroma(t.accent) < 30) out.unshift(`accent ${t.accent} is too grey to be a signal (chroma ${chroma(t.accent).toFixed(0)}, needs 30)`);
  return out;
}

const norm = (h: string) => h.trim().toLowerCase();

/** Cheap accent-only checks that the full audit would also fail, run first so the search skips most candidates without
 *  building a theme. Never a looser rule: a candidate that passes this still has to pass customProblems(). */
function quickReject(accent: string, surf: ReturnType<typeof baseSurfaces>): boolean {
  const d = THEMES.dark.tokens;
  if (chroma(accent) < 30) return true;
  for (const k of [...TONE_KEYS, "drift" as const]) if (hueGap(d[k], accent) < 30) return true;
  for (const on of [[surf.bg], [surf.panel], [surf.raised], [surf.panel, `${accent}1a`], [surf.bg, `${accent}1a`]]) if (contrast(accent, on) < 4.5) return true;
  return false;
}

/** Pick → full theme. Deterministic. Nudge order: lightness (nearest first, lighter before darker at equal distance),
 *  then saturation (up), then hue (nearest passing hue, each with its own lightness search). */
export function deriveTheme(setting: CustomTheme): Derived {
  const base = BASES[setting.base] ? setting.base : "graphite";
  const requested = { accent: norm(setting.accent), base };
  const first = buildTokens(requested.accent.slice(0, 7), base), firstProblems = customProblems(first);
  if (firstProblems.length === 0) return { requested, accent: first.accent, tokens: first, nudge: null, problems: [] };
  const { h, s, l } = toHsl(requested.accent), surf = baseSurfaces(base);
  const tryAt = (hh: number, ss: number, ll: number) => {
    if (ll < 0 || ll > 1) return null;
    const a = fromHsl(hh, ss, ll);
    if (quickReject(a, surf)) return null;
    const t = buildTokens(a, base);
    return customProblems(t).length === 0 ? t : null;
  };
  const lightness = (hh: number, ss: number) => { for (let d = 0; d <= 60; d++) for (const dl of d === 0 ? [0] : [d, -d]) { const t = tryAt(hh, ss, l + dl / 100); if (t) return t; } return null; };
  const done = (kind: Nudge["kind"], t: ThemeTokens): Derived => ({ requested, accent: t.accent, tokens: t, nudge: { kind, from: requested.accent, to: t.accent, why: firstProblems.slice(0, 3) }, problems: [] });
  let t = lightness(h, s);
  if (t) return done("lightness", t);
  for (let ss = Math.max(s, 0.55); ss <= 1.0001; ss += 0.05) { t = lightness(h, ss); if (t) return done("saturation", t); }
  for (let dh = 2; dh <= 180; dh += 2) for (const hh of [h + dh, h - dh]) { t = lightness(hh, Math.max(s, 0.7)); if (t) return done("hue", t); }
  return { requested, accent: first.accent, tokens: first, nudge: null, problems: firstProblems }; // unreachable for the shipped palette; reported, never applied
}

/** Plain-English line for the picker ("Adjusted for legibility: …"): names every dimension that moved, and the first reason. */
export function nudgeText(d: Derived): string | null {
  if (d.problems.length) return `No legible variant near ${d.requested.accent}: ${d.problems[0]}`;
  if (!d.nudge) return null;
  const a = toHsl(d.nudge.from), b = toHsl(d.nudge.to), grey = chroma(d.nudge.from) < 30, moved: string[] = [];
  if (!grey && hueGap(d.nudge.from, d.nudge.to) >= 1) { const c = clashWith(d.nudge.from); moved.push(`hue ${Math.round(a.h)}° → ${Math.round(b.h)}°${c ? ` (${c} owns that hue)` : ""}`); }
  if (Math.abs(b.s - a.s) >= 0.05) moved.push(`saturation ${Math.round(a.s * 100)}% → ${Math.round(b.s * 100)}%`);
  if (Math.abs(b.l - a.l) >= 0.01) moved.push(`lightness ${Math.round(a.l * 100)}% → ${Math.round(b.l * 100)}%`);
  return `Adjusted for legibility: ${d.nudge.from} → ${d.nudge.to} (${moved.join(", ") || "rounding"}) because ${d.nudge.why[0]}`;
}
const clashWith = (accent: string) => { const t = THEMES.dark.tokens; return [...TONE_KEYS, "drift" as const].find(k => hueGap(t[k], accent) < 30) ?? null; };

// ---- applying + persisting ------------------------------------------------------------------------------------------------
/** CSS custom-property map, like themeVars() (same TOKEN_VAR names, plus color-scheme). */
export function customVars(d: Derived): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of TOKEN_KEYS) out[TOKEN_VAR[k]] = d.tokens[k];
  out["color-scheme"] = "dark";
  return out;
}
/** One rule for the custom theme, keyed by the same attribute as the presets (root + portalled overlays). */
export function customThemeCss(d: Derived, selectors: readonly string[] = [".oi-root", "[data-bb-portaled-overlay]"]): string {
  return `${selectors.map(s => `${s}[data-oi-theme="${CUSTOM_THEME}"]`).join(",")}{${Object.entries(customVars(d)).map(([p, v]) => `${p}:${v}`).join(";")}}`;
}
/** Persisted value → a valid setting or null (6-digit hex accent, a known base). Anything else is ignored, never applied. */
export function parseCustomTheme(x: unknown): CustomTheme | null {
  if (!x || typeof x !== "object") return null;
  const { accent, base } = x as Record<string, unknown>;
  if (typeof accent !== "string" || !/^#[0-9a-fA-F]{6}$/.test(accent.trim())) return null;
  return { accent: norm(accent), base: typeof base === "string" && Object.prototype.hasOwnProperty.call(BASES, base) ? (base as BaseName) : "graphite" };
}
/** The theme the app should show: "custom" only with a valid saved setting; otherwise the preset rules (unknown → Dark). */
export function resolveThemeChoice(name: unknown, custom: unknown): { name: ThemeName | typeof CUSTOM_THEME; derived: Derived | null } {
  if (name === CUSTOM_THEME) { const c = parseCustomTheme(custom); return c ? { name: CUSTOM_THEME, derived: deriveTheme(c) } : { name: DEFAULT_THEME, derived: null }; }
  return { name: resolveTheme(name), derived: null };
}
