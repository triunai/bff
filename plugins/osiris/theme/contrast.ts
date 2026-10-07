// WCAG 2.x contrast maths for the theme tokens (pure, no DOM). Colours are hex strings: #rgb, #rgba, #rrggbb or #rrggbbaa.
// A colour with alpha is composited over the colour beneath it before measuring, so a wash (hover / selected) is measured
// as the surface the text actually sits on, not as the bare tint.

export type Rgba = { r: number; g: number; b: number; a: number };

/** Parse a hex colour; throws on anything else, so a non-hex token in a contrast pair fails loudly instead of measuring 1:1. */
export function parseHex(hex: string): Rgba {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a hex colour: ${hex}`);
  let h = m[1];
  if (h.length <= 4) h = [...h].map(c => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

/** Source-over composite of `top` onto `under` (which is treated as opaque). */
export function composite(top: Rgba, under: Rgba): Rgba {
  const mix = (t: number, u: number) => t * top.a + u * (1 - top.a);
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
}

/** Relative luminance per WCAG 2.x (sRGB channel linearisation with the 0.04045 knee). */
export function luminance(c: Rgba): number {
  const lin = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** Contrast ratio of `fg` on a background built from `layers`, bottom first: ["#121314"] or ["#17181a", "#ffffff0a"] (a wash). */
export function contrast(fg: string, layers: readonly string[]): number {
  if (layers.length === 0) throw new Error("contrast needs at least one background layer");
  const [base, ...washes] = layers.map(parseHex);
  const bg = washes.reduce((under, top) => composite(top, under), { ...base, a: 1 });
  const ink = composite(parseHex(fg), bg);
  const [hi, lo] = [luminance(ink), luminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA thresholds: body text 4.5:1; large text (>= 18.66px bold / 24px) and non-text UI indicators 3:1. */
export const AA = { body: 4.5, large: 3 } as const;

/** CIELAB (D65) of an opaque colour, via linear sRGB → XYZ. For colour DIFFERENCE, not legibility. */
export function lab(c: Rgba): { L: number; a: number; b: number } {
  const lin = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [lin(c.r), lin(c.g), lin(c.b)];
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, y = 0.2126 * r + 0.7152 * g + 0.0722 * b, z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return { L: 116 * f(y) - 16, a: 500 * (f(x) - f(y)), b: 200 * (f(y) - f(z)) };
}

/** CIE76 ΔE between two hex colours (alpha ignored). ~2.3 is a just-noticeable difference; >= 20 reads as a different colour. */
export function deltaE(x: string, y: string): number {
  const p = lab(parseHex(x)), q = lab(parseHex(y));
  return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
}
