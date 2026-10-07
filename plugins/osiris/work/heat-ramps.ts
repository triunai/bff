// One hue family per Factory heat mode (owner 01:11: "age rework and cost actually look diff ... we need diff hues for diff
// tabs"). PURE: names the theme tokens (theme/tokens.ts heatAge0..4, heatRework0..4, heatBlock0..4, heatCost0..4), never a
// colour value, so every theme (Dark, Cyberpunk, Match BB, derived custom) supplies them and a component only ever holds a
// var() name. The legacy shared ramp (--oi-heat-0..4) stays for anything not yet moved onto a per-mode family.
import { HEAT_FULL, HEAT_MODES, heatStep, type HeatMode } from "./factory-floor-model.ts";
import { FAMILY_DARK_INK_FROM, HEAT_FAMILY_KEYS, TOKEN_VAR, type HeatFamily } from "../theme/tokens.ts";

/** Which family each model heat mode draws from ("impact" is the Blocking tab). */
export const HEAT_MODE_FAMILY: Record<HeatMode, HeatFamily> = { age: "Age", rework: "Rework", impact: "Block", cost: "Cost" };
/** Steps from this one up take the page-black ink; below it, the light text ink (the theme audit holds every step to AA). */
export const DARK_INK_FROM = FAMILY_DARK_INK_FROM; // ONE definition: the theme audit measures the same rule

const clampStep = (step: number): number => Math.max(0, Math.min(4, Math.round(Number.isFinite(step) ? step : 0)));

/** The CSS custom-property NAME of a mode's ramp step, e.g. ("age", 3) -> "--oi-heat-age-3". Use as `var(${...})`. */
export const heatColorVar = (mode: HeatMode, step: number): string => TOKEN_VAR[HEAT_FAMILY_KEYS[HEAT_MODE_FAMILY[mode]][clampStep(step)]];
/** The legible card-text ink on that step (a var NAME): light on the dark end, page black on the bright end. */
export const heatTextVar = (mode: HeatMode, step: number): string => (clampStep(step) >= DARK_INK_FROM ? TOKEN_VAR.bg : TOKEN_VAR.text);
/** A mode's tab / legend-chip hue: its step-3 fill, bright enough to read as the mode's colour and clear of its neighbours. */
export const heatTabVar = (mode: HeatMode): string => heatColorVar(mode, 3);
/** Hatching laid OVER the step fill (a `background-image`), so blocking is not carried by hue alone (colour-blind safe). Only
 *  the Blocking mode hatches, and only from step 1 up; every other mode and step is null. */
export const heatPattern = (mode: HeatMode, step: number): string | null =>
  mode === "impact" && clampStep(step) >= 1 ? `repeating-linear-gradient(135deg,color-mix(in srgb,var(${heatTextVar(mode, step)}) ${Math.round(hatchOpacity(step) * 100)}%,transparent) 0 2px,transparent 2px 6px)` : null;

export type HeatSwatch = { step: number; label: string; colorVar: string; textVar: string };

const HOUR = 3_600_000;
/** The smallest whole number that lands on `step` for a whole-number scale (rework count, blocked beads), or null when none does. */
const wholeAt = (mode: HeatMode, step: number): number | null => { for (let n = 0; n <= 4 * HEAT_FULL[mode]; n++) if (heatStep(n / HEAT_FULL[mode]) === step) return n; return null; };
const trim = (n: number): string => String(Math.round(n * 100) / 100);
const money = (n: number): string => `$${n % 1 === 0 ? n : n.toFixed(2)}`;

/** The unit text of one swatch, from the SAME scale the model colours with (HEAT_FULL + heatStep), so it cannot drift from it. */
function swatchLabel(mode: HeatMode, step: number): string {
  const full = HEAT_FULL[mode], top = (k: number) => (full * k) / 4;
  if (mode === "age" || mode === "cost") {
    const fmt = mode === "age" ? (v: number) => `${trim(v / HOUR)} h` : money;
    return step === 0 ? (mode === "age" ? "new" : money(0)) : step === 4 ? `>${fmt(top(3))}` : `≤${fmt(top(step))}`;
  }
  const n = wholeAt(mode, step);
  if (n === null) return "–"; // a whole-number scale skips this step (rework 1× and 2× land on steps 2 and 4)
  const unit = mode === "rework" ? "×" : "";
  return step === 4 ? `${n}${unit}+` : `${n}${unit}`;
}

/** Five legend swatches, step 0 (cool/neutral) to 4 (extreme), each with its unit label and the vars to paint it. */
export const heatLegend = (mode: HeatMode): HeatSwatch[] =>
  [0, 1, 2, 3, 4].map(step => ({ step, label: swatchLabel(mode, step), colorVar: heatColorVar(mode, step), textVar: heatTextVar(mode, step) }));

/** One CSS block per heat mode, `.oi-ff[data-heat="<mode>"]{--ff-h0..4: that mode's family}` (impact uses the Blocking family). The Factory root
 *  carries data-heat, so these override the legacy shared ramp the floor defaults to; heat off matches no block and keeps the fallback. */
export const heatFamilyCss = (): string =>
  [...HEAT_MODES.map(m => `.oi-ff[data-heat="${m}"]{${[0, 1, 2, 3, 4].map(n => `--ff-h${n}:var(${heatColorVar(m, n)})`).join(";")}}`),
    ...HATCH_STEPS.map(n => `.oi-ff[data-heat="impact"] .oi-ff-svg.heat .heat-${n} .oi-ff-crate{fill:url(#${hatchPatternId(n)})}`)].join("\n");

/** Blocking steps that hatch (step 0 stays a plain neutral fill). An SVG rect has no background-image, so each step is an SVG
 *  <pattern> (in the floor's <defs>) that paints its own base fill AND the stripes; CSS then fills the crate with url(#id). */
export const HATCH_STEPS = [1, 2, 3, 4] as const;
export const hatchPatternId = (step: number): string => `oi-ff-hatch-block-${step}`;
/** The stripe ink and opacity for a hatch step: the step's own text ink, denser on hotter steps (heatPattern uses this same function). */
export const hatchInkVar = (step: number): string => heatTextVar("impact", step);
export const hatchOpacity = (step: number): number => (24 + 6 * clampStep(step)) / 100; // 30 / 36 / 42 / 48 %: a 30% floor so step 1 reads on a small crate
