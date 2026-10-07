// Plain-English text for the Token efficiency tile and tables (pure, so the words are tested).
import type { TokenEfficiency } from "./token-efficiency-model.ts";

export const tokText = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
export const kbText = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
export const ratioText = (r: number | null): string => (r === null ? "—" : r >= 10 ? `${r.toFixed(0)}x` : `${r.toFixed(2)}x`);

/** The tile: how many agents are near a wrap, with the Opus share and the cache write/read ratio as the sub-line. Never a bare zero when nothing was measured. */
export function efficiencyTileText(eff: TokenEfficiency | undefined): { value: string; sub: string; hint: string; bad: boolean } {
  const hint = "Where context, cache rebuilds and big tool outputs cost money. Sizes and counts only.";
  if (!eff) return { value: "—", sub: "this server build sends no efficiency numbers", hint, bad: false };
  if (!eff.coverage.calls) return { value: "—", sub: "no calls in this range", hint, bad: false };
  const over = eff.nearWrap.filter(a => a.wrap === "over").length, near = eff.nearWrap.length;
  const opus = eff.families.find(f => f.family === "opus"), all = eff.modelCache.reduce((n, m) => ({ w: n.w + m.writeTokens, r: n.r + m.readTokens }), { w: 0, r: 0 });
  return {
    value: near ? `${near} near a wrap` : "none near a wrap",
    sub: `${over} over ${tokText(eff.thresholds.wrap)} · Opus ${opus?.costShare == null ? "n/a" : `${Math.round(opus.costShare * 100)}%`} of spend · cache write/read ${ratioText(all.r > 0 ? all.w / all.r : null)}`,
    hint, bad: over > 0,
  };
}
