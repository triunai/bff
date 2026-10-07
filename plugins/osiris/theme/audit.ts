// The ONE implementation of every rule a theme must pass. The preset token tests and the colour picker (derive-theme.ts) both
// run this, so a custom theme is held to exactly what the presets are held to; there is no second copy to drift.
import { AA, contrast, deltaE, lab, luminance, parseHex } from "./contrast.ts";
import { badgeInk, badgeTintHex, CONTRAST_PAIRS, HEAT_FAMILIES, HEAT_FAMILY_KEYS, HEAT_KEYS, heatFamilyInk, heatInk, LANE_KEYS, REWORK_BED_PCT, tintPct, TONE_KEYS, type ThemeTokens, type TokenKey } from "./tokens.ts";

/** Hue in degrees (HSL), for "is this colour distinct from that one". */
export function hue(hex: string): number {
  const { r, g, b } = parseHex(hex), [R, G, B] = [r / 255, g / 255, b / 255];
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn;
  if (d === 0) return 0;
  const h = mx === R ? ((G - B) / d) % 6 : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return (h * 60 + 360) % 360;
}
export const hueGap = (a: string, b: string) => { const d = Math.abs(hue(a) - hue(b)); return Math.min(d, 360 - d); };

/** Every declared text-on-surface pair (WCAG AA: body 4.5, large/indicator 3). */
export function contrastFailures(t: ThemeTokens): string[] {
  return CONTRAST_PAIRS.flatMap(p => {
    const r = contrast(t[p.fg], p.on.map(k => t[k]));
    return r >= p.min ? [] : [`${p.fg} on ${p.on.join(" + ")} = ${r.toFixed(2)} (needs ${p.min}; ${p.use})`];
  });
}

/** Chips/badges: every tone, lane, drift, rework and accent legible on its own tint (the theme's --oi-tint). */
export function chipFailures(t: ThemeTokens): string[] {
  const pct = tintPct(t), a = badgeTintHex(pct);
  const inks = ["muted", "info", "running", "success", "attention", "failure", "drift", "rework", "accent", ...LANE_KEYS] as const;
  return inks.flatMap(k => (["bg", "panel", "raised"] as const).flatMap(s => {
    const ink = badgeInk(k), r = contrast(t[ink], [t[s], t[k] + a]);
    return r >= AA.body ? [] : [`chip ${ink} on ${s} + ${k}@${pct}% = ${r.toFixed(2)}`];
  }));
}

/** Status never reads as "selected": every tone >= 30 hue degrees from the accent; every lane >= 20 ΔE from it. */
export function accentProblems(t: ThemeTokens): string[] {
  return [
    ...TONE_KEYS.flatMap(k => (hueGap(t[k], t.accent) >= 30 ? [] : [`${k} ${t[k]} is ${hueGap(t[k], t.accent).toFixed(0)} deg from the accent ${t.accent}`])),
    ...LANE_KEYS.flatMap(k => (deltaE(t[k], t.accent) >= 20 ? [] : [`${k} ${t[k]} is ΔE ${deltaE(t[k], t.accent).toFixed(1)} from the accent ${t.accent}`])),
  ];
}

/** Drift: its own hue (>= 30 deg from failure, attention, accent, running, info, success) and a legible solid badge. */
export function driftProblems(t: ThemeTokens): string[] {
  const out = (["failure", "attention", "accent", "running", "info", "success"] as const).flatMap(k => (hueGap(t.drift, t[k]) >= 30 ? [] : [`drift ${t.drift} is ${hueGap(t.drift, t[k]).toFixed(0)} deg from ${k} ${t[k]}`]));
  if (contrast(t.onDrift, [t.drift]) < AA.body) out.push(`onDrift on drift = ${contrast(t.onDrift, [t.drift]).toFixed(2)}`);
  return out;
}

/** Heat: monotonic cold → hot, every step >= 20 ΔE from the accent, drift and selected text, each with a legible ink. */
export function heatProblems(t: ThemeTokens): string[] {
  const out: string[] = [];
  const lum = HEAT_KEYS.map(k => luminance(parseHex(t[k])));
  for (let i = 1; i < lum.length; i++) if (!(lum[i] > lum[i - 1])) out.push(`${HEAT_KEYS[i]} is not hotter (brighter) than ${HEAT_KEYS[i - 1]}`);
  for (const k of HEAT_KEYS) {
    for (const o of ["accent", "drift", "selectedText"] as const) if (deltaE(t[k], t[o]) < 20) out.push(`${k} ${t[k]} is ΔE ${deltaE(t[k], t[o]).toFixed(1)} from ${o} ${t[o]}`);
    const ink = heatInk(k);
    if (contrast(t[ink], [t[k]]) < AA.body) out.push(`${ink} on ${k} = ${contrast(t[ink], [t[k]]).toFixed(2)}`);
  }
  return out;
}

/** The per-mode heat families (Age, Rework, Block, Cost): each ramp brightens step by step, card text passes AA on every step,
 *  any two families are >= 40 ΔE apart at steps 2 and 3 (so a tab is told by its hue), and Cost tops out white-hot while no other
 *  family does. Deliberately NOT held to the accent / drift distance the shared ramp keeps: the owner asked for amber ageing
 *  and violet rework, which sit near Dark's orange accent and drift. */
export function heatFamilyProblems(t: ThemeTokens): string[] {
  const out: string[] = [];
  for (const f of HEAT_FAMILIES) {
    const keys = HEAT_FAMILY_KEYS[f];
    for (let i = 1; i < keys.length; i++) if (!(luminance(parseHex(t[keys[i]])) > luminance(parseHex(t[keys[i - 1]])))) out.push(`${keys[i]} is not lighter than ${keys[i - 1]}`);
    keys.forEach((k, i) => { const ink = heatFamilyInk(i); if (contrast(t[ink], [t[k]]) < AA.body) out.push(`${ink} on ${k} = ${contrast(t[ink], [t[k]]).toFixed(2)}`); });
  }
  for (const s of [2, 3]) for (const a of HEAT_FAMILIES) for (const b of HEAT_FAMILIES) if (a < b) { const d = deltaE(t[HEAT_FAMILY_KEYS[a][s]], t[HEAT_FAMILY_KEYS[b][s]]); if (d < 40) out.push(`${a} vs ${b} step ${s} ΔE ${d.toFixed(1)} < 40`); }
  if (luminance(parseHex(t[HEAT_FAMILY_KEYS.Cost[4]])) < 0.85) out.push("cost top step is not white-hot");
  for (const f of HEAT_FAMILIES) if (f !== "Cost" && luminance(parseHex(t[HEAT_FAMILY_KEYS[f][4]])) >= 0.7) out.push(`${f} top step is white-hot (only cost may be)`);
  return out;
}

/** Rework: >= 25 ΔE from accent, selected text, drift, attention, heat; >= 20 from text, tones, lanes; AA on its bed. */
export function reworkClashes(t: ThemeTokens): string[] {
  const near = (k: TokenKey, min: number) => (deltaE(t.rework, t[k]) >= min ? [] : [`${k} ΔE ${deltaE(t.rework, t[k]).toFixed(1)} < ${min}`]);
  return [...(["accent", "selectedText", "drift", "attention", ...HEAT_KEYS] as const).flatMap(k => near(k, 25)), ...(["text", ...TONE_KEYS, ...LANE_KEYS] as const).flatMap(k => near(k, 20))];
}
export function reworkBedFailures(t: ThemeTokens): string[] {
  const bed = [t.panel, t.rework + badgeTintHex(REWORK_BED_PCT)];
  return (["rework", "text"] as const).flatMap(k => (contrast(t[k], bed) >= AA.body ? [] : [`${k} on the rework bed = ${contrast(t[k], bed).toFixed(2)}`]));
}

/** Owner 22:32: "black chassis + glowing status LED". Neutral/cool greys (B >= R, Lab chroma <= 8); accent surfaces transparent. */
export function chassisProblems(t: ThemeTokens): string[] {
  const out: string[] = [];
  for (const k of ["bg", "panel", "raised", "input", "hover", "border", "borderStrong", "text", "text2", "muted"] as const) {
    const c = parseHex(t[k]), { a, b } = lab(c), chroma = Math.hypot(a, b);
    if (c.r > c.b) out.push(`${k} ${t[k]} is warm (R > B)`);
    if (chroma > 8) out.push(`${k} ${t[k]} has chroma ${chroma.toFixed(1)} (> 8)`);
  }
  for (const k of ["selected", "selectedBorder"] as const) { const al = parseHex(t[k]).a; if (al >= 0.36) out.push(`${k} ${t[k]} is not transparent (alpha ${al.toFixed(2)})`); }
  return out;
}

/** Effects: shadows only (no border/outline drawing), and glowActive never `none` (it is appended inside a shadow list). */
export const BOX = /\b(solid|dashed|dotted|double|groove|ridge)\b|(^|[;{\s])(border|outline)(-[a-z]+)?\s*:/;
export function effectProblems(t: ThemeTokens): string[] {
  const out = (["glow", "glowActive", "shadowRaised", "tabUnderline"] as const).flatMap(k => (BOX.test(t[k]) ? [`${k} draws a box: ${t[k]}`] : []));
  if (/\bnone\b/.test(t.glowActive)) out.push("glowActive is `none` (invalid inside a shadow list)");
  return out;
}

/** Everything. `chassis` adds the owner's neutral-chassis rule (Dark and anything derived from it). */
export function auditTheme(t: ThemeTokens, opts: { chassis?: boolean } = {}): string[] {
  return [
    ...contrastFailures(t), ...chipFailures(t), ...accentProblems(t), ...driftProblems(t), ...heatProblems(t), ...heatFamilyProblems(t),
    ...reworkClashes(t).map(m => `rework: ${m}`), ...reworkBedFailures(t), ...effectProblems(t),
    ...(opts.chassis ? chassisProblems(t) : []),
  ];
}
