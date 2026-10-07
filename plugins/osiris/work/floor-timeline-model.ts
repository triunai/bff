// ON THE FLOOR as a horizontal icon-pip strip (fg-lead design, decision 8): pure layout. The input is the shell's existing
// floor log (LogLine from factory-floor-model.ts, plus `at`), so there is no second log builder. One pip per line, placed by
// time between t0 and t1; pips closer than MERGE_PX collapse into one count pip. No text is produced here beyond tooltips.
import type { LogKind, LogLine } from "./factory-floor-model.ts";
import type { TokenKey } from "../theme/tokens.ts";

export type Tone = LogLine["tone"];
/** A floor log line (LogLine already carries `kind` and `beadId` from its emit site). */
export type TimelineLine = LogLine & { at: number; earlier?: boolean };
export type PipGlyph = "chevron" | "bars" | "check" | "plus" | "back" | "cycle" | "lock" | "unlock";
export type Pip = { key: string; x: number; at: number; tone: Tone; kind: LogKind; glyph: PipGlyph; count: number; earlier: boolean; lines: readonly TimelineLine[]; beadId: string | null };
export type StripLayout = { pips: Pip[]; nowX: number; width: number };

/** First `n` words of a title (a pip card row never needs more). */
export const shortWords = (t: string | undefined, n = 3) => (t ?? "").trim().split(/\s+/).filter(Boolean).slice(0, n).join(" ");

export const MERGE_PX = 8, PAD_PX = 12, TIP_LINES = 6;
/** Every event kind has its OWN theme token and its OWN glyph (owner 01:38: "different colours"). Claim/Gate/Land/Intake use the
 * station accents; sent-back and reopened the rework heat family; locks the blocking hue with a padlock; unlock the clear tone. */
export const KIND_STYLE: Record<LogKind, { token: TokenKey; css: string; glyph: PipGlyph; word: string }> = {
  intake: { token: "stationIntake", css: "--oi-station-intake", glyph: "plus", word: "New" },
  claimed: { token: "stationClaim", css: "--oi-station-claim", glyph: "chevron", word: "Claimed" },
  gate: { token: "stationGate", css: "--oi-station-gate", glyph: "bars", word: "To the Gate" },
  landed: { token: "stationLand", css: "--oi-station-land", glyph: "check", word: "Landed" },
  sentBack: { token: "heatRework3", css: "--oi-heat-rework-3", glyph: "back", word: "Sent back" },
  reopened: { token: "heatRework4", css: "--oi-heat-rework-4", glyph: "cycle", word: "Reopened" },
  locked: { token: "failure", css: "--oi-tone-failure", glyph: "lock", word: "Locked" },
  unlocked: { token: "success", css: "--oi-tone-success", glyph: "unlock", word: "Unlocked" },
};
/** A line built without a kind (old fixtures): the closest kind for its tone. */
const TONE_KIND: Record<Tone, LogKind> = { failure: "locked", attention: "gate", success: "landed", info: "claimed" };
export const kindOf = (l: Pick<LogLine, "kind" | "tone">): LogKind => l.kind ?? TONE_KIND[l.tone];
const SEVERITY: Record<Tone, number> = { failure: 3, attention: 2, success: 1, info: 0 };

/** x of time `t` in [PAD, W-PAD]; a zero-length or inverted range puts everything at the right end (the "now" end), never NaN. */
export function xOf(t: number, t0: number, t1: number, width: number, pad = PAD_PX): number {
  const w = Math.max(0, width), lo = Math.min(pad, w / 2), hi = Math.max(lo, w - lo);
  if (!(t1 > t0)) return hi;
  const f = (t - t0) / (t1 - t0);
  return Number.isFinite(f) ? lo + Math.min(1, Math.max(0, f)) * (hi - lo) : hi;
}

/** Lay `lines` out over [t0, t1] on a strip `width` px wide. Oldest first; a pip joins the open cluster while it lies within
 * `gap` px of the cluster's FIRST pip (so a dense run splits into clusters of bounded width instead of chaining into one). A
 * cluster takes its most severe tone, its newest time, and sits at the mean of its members' x. */
export function layoutPips(lines: readonly TimelineLine[], t0: number, t1: number, width: number, now: number = t1, gap = MERGE_PX): StripLayout {
  const sorted = lines.filter(l => Number.isFinite(l.at)).slice().sort((a, b) => a.at - b.at);
  const groups: { first: number; xs: number[]; ls: TimelineLine[] }[] = [];
  for (const l of sorted) {
    const x = xOf(l.at, t0, t1, width), g = groups[groups.length - 1];
    if (g && x - g.first < gap) { g.xs.push(x); g.ls.push(l); } else groups.push({ first: x, xs: [x], ls: [l] });
  }
  const pips = groups.map<Pip>(g => {
    const top = g.ls.reduce((a, l) => (SEVERITY[l.tone] >= SEVERITY[a.tone] ? l : a), g.ls[0]), tone = top.tone, kind = kindOf(top), newest = g.ls[g.ls.length - 1];
    const x = g.xs.reduce((a, b) => a + b, 0) / g.xs.length;
    return { key: `${newest.key}#${g.ls.length}`, x, at: newest.at, tone, kind, glyph: KIND_STYLE[kind].glyph, count: g.ls.length, earlier: g.ls.every(l => !!l.earlier), lines: g.ls, beadId: g.ls.length === 1 ? g.ls[0].beadId ?? null : null };
  });
  return { pips, nowX: xOf(now, t0, t1, width), width };
}

const strip = (s: string) => s.replace(/^[🔒🔓↩↺]\s*/u, "");
/** A cluster's lines for the event-list card, newest first, capped. */
export const CARD_MAX = 12;
export const cardLines = (p: Pip): TimelineLine[] => p.lines.slice(-CARD_MAX).reverse();
/** Tooltip text: one line, or the newest TIP_LINES of a cluster (newest first) and "+n more". */
export function pipTip(p: Pip, clock: (at: number) => string): string {
  const one = (l: TimelineLine) => `${clock(l.at)} · ${strip(l.text)}${l.title ? ` · ${l.title}` : ""}`;
  if (p.count === 1) return one(p.lines[0]) + (p.earlier ? " (earlier, from history)" : "");
  const shown = p.lines.slice(-TIP_LINES).reverse().map(one);
  return [`${p.count} events`, ...shown, ...(p.count > TIP_LINES ? [`+${p.count - TIP_LINES} more`] : [])].join("\n");
}
