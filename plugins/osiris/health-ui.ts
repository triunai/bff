import type { HealthRow, Trend } from "./health-types.ts";

/** Percent width of a log-scale bar: the limit sits at the half-way mark, a tenfold overshoot at 75, a hundredfold at 100. */
export function barWidth(ratio: number): number {
  if (!(ratio > 0)) return 0;
  if (ratio < 1) return ratio * 50;
  return Math.min(100, 50 + 25 * Math.log10(ratio));
}

/** Multiple first when over the limit, a share of it otherwise. */
export function multipleLabel(ratio: number): string {
  if (ratio >= 10) return `${Math.round(ratio)}× limit`;
  if (ratio >= 1.5) return `${ratio.toFixed(1)}× limit`;
  return `${Math.round(ratio * 100)}% of limit`;
}

export function trendLabel(t: Trend): string {
  const n = Math.abs(t.delta).toLocaleString("en-US");
  return t.direction === "worse" ? `▲ +${n}` : t.direction === "better" ? `▼ −${n}` : "= no change";
}

/** One collapsed line for the passing rows; at most four names, then "+N more". */
export function passLine(rows: HealthRow[]): string {
  if (!rows.length) return "";
  const names = rows.slice(0, 4).map(r => r.title).join(", "), more = rows.length - 4;
  return `${rows.length} passing — ${names}${more > 0 ? `, +${more} more` : ""}`;
}

export function headerLine(h: { branch: string; shortHead: string; generatedAgo: string | null }): string {
  return `${h.branch || "detached"} @ ${h.shortHead}${h.generatedAgo ? ` · index ${h.generatedAgo}` : ""}`;
}

export function behindText(b: { count: number; capped: boolean } | null): { text: string; tone: "pass" | "warn" | "muted" } {
  if (!b) return { text: "no index to compare", tone: "muted" };
  if (b.count <= 0) return { text: "up to date with HEAD", tone: "pass" };
  return { text: `${b.count}${b.capped ? "+" : ""} commit${b.count === 1 && !b.capped ? "" : "s"} behind HEAD`, tone: "warn" };
}

/** One word per status; the view reads this too, so a new status cannot render as `undefined`. */
export const STATUS_WORD = { fail: "FAIL", warn: "WARN", unknown: "UNKNOWN", pass: "PASS" } as const;
/** One paragraph an owner can paste to an agent: what is wrong, why, the fix, the command and the producer's detail (cut to 400). */
export function agentTask(row: HealthRow): string {
  const detail = (row.detail ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  return `Osiris Health — ${row.title} (${STATUS_WORD[row.status]}): ${row.figure}. ${row.why ? `${row.why} ` : ""}Fix: ${row.fix?.label.replace(/\.$/, "") ?? "investigate"}.${row.fix?.command ? ` Run: ${row.fix.command}` : ""}${detail ? ` Detail: ${detail}` : ""}`;
}
