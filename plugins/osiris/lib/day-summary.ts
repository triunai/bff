// PURE day summary for the Calendar day inspector. No DOM, no IO, no clock. Owner 22:23: the day view "has to look more meaningful";
// today it is "2026-10-04 · 50 events" and then flat lists. This computes, from the SAME data, a headline, what shipped, decisions,
// commits grouped by conventional type/scope, notable items and linked threads. The raw lists stay below it (collapsed).
//
// Honesty rules: every classification names the signal it used. Nothing is inferred that the inputs cannot show. A merge's target
// branch is only known when the caller passes DayCommit.source; a migration is "a commit about a migration", not proof it was applied.
import type { DayCommit } from "../git-types.ts";
import { conventional, threadMentions } from "../git-ui.ts";
import type { SpineEvent } from "../spine-index.ts";
import { splitTrailers } from "./doc-reader.ts";

export type DayInput = {
  date: string;
  /** The calendar events of the day (commit / decision / log / thread-done). Commit events carry the sha in `ref`. */
  events: readonly SpineEvent[];
  /** Richer commit data when the caller has it (parents, branch group, time). Joined to commit events by sha. */
  commits?: readonly DayCommit[];
  /** Commit bodies by sha, when loaded: lets a real `Wrap:` trailer (or BREAKING CHANGE) win over the subject heuristic. */
  bodies?: ReadonlyMap<string, string>;
};

export type DayCommitLite = { sha: string; subject: string; branch: string | null; parents: number | null; at: number | null };
export type CommitGroup = { key: string; count: number; types: Record<string, number>; shas: string[]; subjects: string[] };
export type NotableKind = "merge" | "revert" | "crit" | "breaking" | "fix-of-fix" | "wrap";
export type Notable = { kind: NotableKind; sha: string; subject: string; why: string };
export type MergeItem = DayCommitLite & { via: "parents" | "subject"; toMain: boolean | null; fold: boolean };
export type DaySummary = {
  date: string;
  headline: string;
  counts: { commits: number; decisions: number; threadsDone: number; logs: number; merges: number; migrations: number };
  shipped: { threads: { title: string; ids: string[]; ref: string }[]; merges: MergeItem[]; migrations: DayCommitLite[] };
  decisions: { id: string | null; title: string; ref: string }[];
  groups: CommitGroup[];
  notable: Notable[];
  threads: string[];
  log: { title: string; ref: string }[];
};

const MAIN = /^(main|master|trunk)$/;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Merge: two or more parents when known; otherwise git's own merge subjects or a `merge(...)` conventional type. */
function mergeOf(c: DayCommitLite): MergeItem | null {
  const conv = conventional(c.subject);
  const bySubject = /^Merge (branch|pull request|remote-tracking branch|tag)\b/.test(c.subject) || conv?.type.toLowerCase() === "merge";
  const fold = /\bfold(s|ed|ing)?\b/i.test(c.subject);
  if (!((c.parents ?? 0) > 1) && !bySubject && !fold) return null;
  // Only git's own shape names a target: "... into main" / "into 'main'" as the LAST token ("into the Work surface" is prose).
  const into = /\binto ['"]?([\w./-]+)['"]?\s*$/.exec(c.subject)?.[1] ?? null;
  const toMain = c.branch !== null ? MAIN.test(c.branch) : into !== null ? MAIN.test(into) : null;
  return { ...c, branch: c.branch ?? (toMain === false ? into : null), via: (c.parents ?? 0) > 1 ? "parents" : "subject", toMain, fold };
}

/** A commit about a migration: a db/migration/sql type or scope, or the word "migration" in the subject. */
const isMigration = (s: string) => { const c = conventional(s); return /^(db|migrations?|sql)$/i.test(c?.scope ?? "") || /^(db|migration)$/i.test(c?.type ?? "") || /\bmigrations?\b/i.test(s); };
const groupKey = (s: string) => { const c = conventional(s); return c ? (c.scope ?? c.type).toLowerCase() : "other"; };
const EXPLICIT_REFIX = /\b(fix(es|ing)? (the |a )?(previous |earlier |last )?fix|re-?fix|fix-of-fix|follow-?up fix|fix(es)? regression)\b/i;
const WRAP_SUBJECT = /\bwrap(-session| session|s|ped|-up| up)?\b/i;

export function daySummary(input: DayInput): DaySummary {
  const evs = input.events.filter(e => e.date === input.date);
  const rich = new Map((input.commits ?? []).map(c => [c.sha, c]));
  // Commits: every commit event, joined to its rich record when present; rich-only commits (no event) are included too.
  const seen = new Set<string>(), commits: DayCommitLite[] = [];
  const add = (sha: string, subject: string) => {
    if (seen.has(sha)) return; seen.add(sha);
    const r = rich.get(sha);
    commits.push({ sha, subject: r?.subject ?? subject, branch: r?.source ?? null, parents: r ? r.parents.length : null, at: r?.committedAt ?? null });
  };
  for (const e of evs) if (e.kind === "commit") add(e.ref, e.title);
  for (const c of input.commits ?? []) add(c.sha, c.subject);
  // Chronological when times are known (oldest first), so "the second fix" really is the later one.
  const order = commits.every(c => c.at !== null) ? [...commits].sort((a, b) => a.at! - b.at! || (a.sha < b.sha ? -1 : 1)) : commits;

  const merges = order.map(mergeOf).filter((m): m is MergeItem => m !== null);
  const mergeShas = new Set(merges.map(m => m.sha));
  const migrations = order.filter(c => isMigration(c.subject));

  const groups = new Map<string, CommitGroup>();
  for (const c of order) {
    if (mergeShas.has(c.sha)) continue; // merges are summarised as merges, not as a scope's work
    const key = groupKey(c.subject), g = groups.get(key) ?? { key, count: 0, types: {}, shas: [], subjects: [] };
    const t = conventional(c.subject)?.type.toLowerCase() ?? "other";
    g.count++; g.types[t] = (g.types[t] ?? 0) + 1; g.shas.push(c.sha); g.subjects.push(c.subject);
    groups.set(key, g);
  }
  const grouped = [...groups.values()].sort((a, b) => (a.key === "other" ? 1 : 0) - (b.key === "other" ? 1 : 0) || b.count - a.count || (a.key < b.key ? -1 : 1));

  const notable: Notable[] = [];
  const fixSeen = new Map<string, number>();
  for (const c of order) {
    const conv = conventional(c.subject), body = input.bodies?.get(c.sha);
    const m = merges.find(x => x.sha === c.sha);
    if (m) notable.push({ kind: "merge", sha: c.sha, subject: c.subject, why: `${m.fold ? "fold" : "merge"}${m.toMain === true ? " to main" : m.toMain === false ? ` on ${m.branch}` : " (target branch unknown)"}` });
    if (/^Revert "/.test(c.subject) || conv?.type.toLowerCase() === "revert") notable.push({ kind: "revert", sha: c.sha, subject: c.subject, why: "revert" });
    if (/\bCRIT\b/.test(c.subject)) notable.push({ kind: "crit", sha: c.sha, subject: c.subject, why: "CRIT in the subject" });
    if (conv?.breaking || (body && /^BREAKING[ -]CHANGE:/m.test(body))) notable.push({ kind: "breaking", sha: c.sha, subject: c.subject, why: conv?.breaking ? "breaking (!)" : "BREAKING CHANGE in the body" });
    if (conv?.type.toLowerCase() === "fix") {
      const key = groupKey(c.subject), n = (fixSeen.get(key) ?? 0) + 1;
      fixSeen.set(key, n);
      if (EXPLICIT_REFIX.test(c.subject)) notable.push({ kind: "fix-of-fix", sha: c.sha, subject: c.subject, why: "says it fixes a fix" });
      else if (n >= 2 && key !== "other") notable.push({ kind: "fix-of-fix", sha: c.sha, subject: c.subject, why: `fix #${n} to ${key} this day` });
    }
    const wrapTrailer = body ? splitTrailers(body).trailers.find(t => t.key.toLowerCase() === "wrap") : undefined;
    if (wrapTrailer) notable.push({ kind: "wrap", sha: c.sha, subject: c.subject, why: `Wrap: ${wrapTrailer.value}` });
    else if (WRAP_SUBJECT.test(c.subject)) notable.push({ kind: "wrap", sha: c.sha, subject: c.subject, why: "looks like a wrap (subject; no trailer seen)" });
  }

  const decisions = evs.filter(e => e.kind === "decision").map(e => {
    const id = /\b(D-\d+)\b/.exec(e.title)?.[1] ?? /\b(D-\d+)\b/.exec(e.ref)?.[1] ?? null;
    return { id, title: id ? e.title.replace(new RegExp(`^\\s*${id}\\s*[·:—-]?\\s*`), "") : e.title, ref: e.ref };
  });
  const threadsDone = evs.filter(e => e.kind === "thread-done").map(e => ({ title: e.title, ids: e.threadIds, ref: e.ref }));
  const log = evs.filter(e => e.kind === "log").map(e => ({ title: e.title, ref: e.ref }));
  const threads = [...new Set([...evs.flatMap(e => e.threadIds), ...threadMentions(...evs.map(e => e.title), ...order.map(c => c.subject))])];
  const shippedMerges = merges.filter(m => m.toMain !== false);

  const parts: string[] = [];
  if (threadsDone.length) parts.push(`${plural(threadsDone.length, "thread")} done`);
  if (shippedMerges.length) parts.push(`${shippedMerges.length} merged${shippedMerges.every(m => m.toMain === true) ? " to main" : ""}`);
  if (migrations.length) parts.push(plural(migrations.length, "migration"));
  if (decisions.length) parts.push(plural(decisions.length, "decision"));
  if (order.length) {
    const top = grouped[0];
    const mostly = top && top.key !== "other" && top.count >= 3 && top.count / order.length >= 0.3 ? `, mostly ${top.key}` : "";
    parts.push(`${plural(order.length, "commit")}${mostly}`);
  }
  const alarms = notable.filter(n => n.kind === "revert" || n.kind === "crit").length;
  if (alarms) parts.push(`${alarms} to look at`);
  if (!parts.length && log.length) parts.push(plural(log.length, "log entry", "log entries"));

  return {
    date: input.date,
    headline: parts.length ? parts.join(" · ") : "Nothing recorded on this day",
    counts: { commits: order.length, decisions: decisions.length, threadsDone: threadsDone.length, logs: log.length, merges: merges.length, migrations: migrations.length },
    shipped: { threads: threadsDone, merges: shippedMerges, migrations },
    decisions, groups: grouped, notable, threads, log,
  };
}
