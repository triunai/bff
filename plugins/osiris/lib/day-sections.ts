// PURE view model for the Calendar's DAY SUMMARY (state 8): a title line, SHIPPED / DECISIONS / THREADS / NOTABLE rows. Every string is
// derived from the day's own commits and spine events (via daySummary); nothing is composed from outside them. A slot with no data is
// returned empty and the view prints an honest "—".
import { conventional } from "../git-ui.ts";
import type { DaySummary, Notable } from "./day-summary.ts";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-06" -> "Tue 6 Oct" (the mockup's form, no year). Unparseable input is returned unchanged. */
export function shortDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return t.getUTCMonth() !== +m[2] - 1 ? date : `${WD[t.getUTCDay()]} ${t.getUTCDate()} ${MO[t.getUTCMonth()]}`;
}

export type DaySections = {
  title: string;
  shipped: { beads: string[]; merges: number; mergeShas: string[] };
  decisions: string[];
  /** `label` is "W-12 export" (the id plus the thread's short name); just the id when no title is known. */
  threads: { id: string; label: string }[];
  /** `summary` is a count line ("2 reverts · 1 fix of a fix"); `items` lists every subject in full for a hover/expand. */
  notable: { summary: string; items: string[] };
};

/** Cut at a word boundary, never mid-word; an ellipsis marks the cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1), at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : text.slice(0, max)).replace(/[\s·,;:-]+$/, "")}…`;
}

/** "W-12 · export streaming landed" -> "export": the first segment of the title, at most two words, the leading id stripped. */
export function threadName(id: string, title: string | undefined): string {
  const t = (title ?? "").replace(new RegExp(`^\\W*${id}\\W*`, "i"), "").split(/\s[·—–:(|]\s?|[·—–:(|]/)[0] ?? "";
  return t.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(" ");
}

const GENERIC_MERGE = /^Merge (branch|pull request|remote-tracking branch|tag)\b/;
const readable = (subject: string) => { const c = conventional(subject); return (c ? c.rest : subject).trim(); };
const NOTABLE_LABEL: Record<Notable["kind"], string> = { merge: "merge", revert: "revert", crit: "CRIT", breaking: "breaking", "fix-of-fix": "fix of a fix", wrap: "wrap" };
const NOTABLE_SUMMARY: Record<Notable["kind"], (n: number) => string> = {
  merge: n => `${n} ${n === 1 ? "merge" : "merges"}`, revert: n => `${n} ${n === 1 ? "revert" : "reverts"}`, crit: n => `${n} CRIT`, breaking: n => `${n} breaking`,
  "fix-of-fix": n => `${n} fix-of-fix`, wrap: n => `${n} ${n === 1 ? "wrap" : "wraps"}`,
};
const DATED = /\b(\d{4}-\d{2}-\d{2})\b/;
export type DaySectionsOpts = { threadTitles?: ReadonlyMap<string, string>; adrs?: readonly { id: string; title: string; date?: string }[] };

/** `beads` = sha -> bead ids from the day's commits (trailers AND subjects, via commitBeads). `opts.adrs` adds decisions whose heading carries the day's date. */
export function daySections(s: DaySummary, beads: ReadonlyMap<string, readonly string[]> = new Map(), opts: DaySectionsOpts = {}): DaySections {
  const n = s.counts.commits;
  // Headline: the day's own "thread done" titles, else the subjects of real (non-generic) merges; with neither, just the counts.
  const heads = s.shipped.threads.map(t => t.title.trim()).filter(Boolean);
  const mergeHeads = s.shipped.merges.filter(m => !GENERIC_MERGE.test(m.subject)).map(m => readable(m.subject));
  const picked = [...new Set(heads.length ? heads : mergeHeads)].slice(0, 2);
  const fallback = `${n} ${n === 1 ? "commit" : "commits"} · ${s.threads.length} ${s.threads.length === 1 ? "thread" : "threads"}`;
  const day = shortDate(s.date);
  const seen = new Set<string>(), beadIds: string[] = [];
  for (const sha of [...beads.keys()]) for (const id of beads.get(sha) ?? []) if (!seen.has(id)) { seen.add(id); beadIds.push(id); }
  const rest = s.notable.filter(x => x.kind !== "merge");
  const counts = new Map<Notable["kind"], number>();
  for (const x of rest) counts.set(x.kind, (counts.get(x.kind) ?? 0) + 1);
  const decisions = s.decisions.map(d => d.id).filter((x): x is string => !!x);
  for (const a of opts.adrs ?? []) if ((a.date ?? DATED.exec(a.title)?.[1]) === s.date && !decisions.includes(a.id)) decisions.push(a.id);
  return {
    title: `${day} · ${picked.length ? picked.join("; ") : fallback}`,
    shipped: { beads: beadIds, merges: s.shipped.merges.length, mergeShas: s.shipped.merges.map(m => m.sha) },
    decisions,
    threads: s.threads.map(id => { const name = threadName(id, opts.threadTitles?.get(id)); return { id, label: name ? `${id} ${name}` : id }; }),
    notable: { summary: [...counts].map(([k, c]) => NOTABLE_SUMMARY[k](c)).join(" · "), items: rest.slice(0, 50).map(x => `${NOTABLE_LABEL[x.kind]} · ${readable(x.subject)}`) },
  };
}
