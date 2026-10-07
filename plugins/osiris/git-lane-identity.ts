// Who/what a commit belongs to, for the graph's identity column (W-193c g). Every commit in this repo has the same author, so
// the author column says nothing; the lane does. PURE: no DOM, no IO. Inputs are UNTRUSTED text; everything returned is cleaned.
import type { GitTrailer } from "./git-types.ts";
import { cleanText } from "./work/sanitize.ts";

export type LaneIdentity = {
  /** Short text for the column: lane, else first Refs id, else agent, else the author. */
  label: string;
  kind: "lane" | "refs" | "agent" | "author";
  lane: string | null;
  refs: string[];
  agent: string | null;
  /** Everything known, one line, for the cell's tooltip. */
  title: string;
};

/** Branch prefixes that name WHO is working rather than WHAT kind of change: `wip/<lane>` is the fleet convention. */
const LANE_PREFIX = /^(?:wip|lane|agent|parallel)\/(.+)$/;
const CAP = 40;
const clean = (s: string): string => cleanText(s, 200).trim();

/** `wip/t1-y2-git` -> "t1-y2-git"; `feat/x` and `main` are branch names, not lanes (null). */
export function laneFromBranch(branch: string | null | undefined): string | null {
  if (!branch) return null;
  const m = LANE_PREFIX.exec(clean(branch));
  return m && m[1] ? m[1].slice(0, CAP) : null;
}

const trailerValues = (ts: readonly GitTrailer[] | undefined, key: string): string[] => (ts ?? []).filter(t => t.key.toLowerCase() === key.toLowerCase()).map(t => clean(t.value)).filter(Boolean);

/** "Claude Sonnet 5.5 <noreply@anthropic.com>" -> "Sonnet 5.5". Names without the "Claude " prefix are kept as written, minus the address. */
export function agentFromCoAuthor(v: string): string | null {
  const name = clean(v.replace(/<[^>]*>/g, "")).replace(/^Claude\s+/i, "");
  return name ? name.slice(0, CAP) : null;
}

/** THE commit -> work-id extractor: the `Refs:` trailer tokens (thread W-NNN, decision D-NNN, bead td-xxx). `"bead"` keeps only bead ids (not W-/D-NNN).
 * Every surface that shows a commit's bead id (the Commits column, the Calendar day rows) calls this; never re-parse trailers elsewhere. */
export function commitRefs(trailers: readonly GitTrailer[] | undefined, only?: "bead"): string[] {
  const all = trailerValues(trailers, "Refs").flatMap(v => v.split(/[,\s]+/)).filter(Boolean).slice(0, 8);
  return only === "bead" ? all.filter(r => !/^[WD]-\d+$/i.test(r)) : all;
}

/** Bead ids written in free text (a subject such as "fix(x): … (td-osi.12)"): the tracker's `td-` ids only, so ordinary hyphenated words never match. */
export const beadIdsIn = (text: string | undefined): string[] => [...new Set((text ?? "").match(/\btd-[a-z0-9]+(?:\.\d+)*\b/gi) ?? [])];
/** A commit's bead ids: the `Refs:` trailer (commitRefs) AND ids in its subject, de-duplicated, trailer first. */
export const commitBeads = (c: { subject?: string; trailers?: readonly GitTrailer[] }): string[] => [...new Set([...commitRefs(c.trailers, "bead"), ...beadIdsIn(c.subject)])];

export function laneIdentity(c: { branch?: string | null; source?: string | null; trailers?: readonly GitTrailer[]; author?: string }): LaneIdentity {
  const lane = trailerValues(c.trailers, "Lane")[0]?.slice(0, CAP) ?? laneFromBranch(c.branch) ?? laneFromBranch(c.source);
  const refs = commitRefs(c.trailers);
  const agent = trailerValues(c.trailers, "Agent")[0]?.slice(0, CAP) ?? trailerValues(c.trailers, "Co-Authored-By").map(agentFromCoAuthor).find((x): x is string => !!x) ?? null;
  const author = clean(c.author ?? "");
  const kind: LaneIdentity["kind"] = lane ? "lane" : refs.length ? "refs" : agent ? "agent" : "author";
  const label = lane ?? refs[0] ?? agent ?? (author || "—");
  const title = [lane && `lane ${lane}`, refs.length > 0 && `refs ${refs.join(", ")}`, agent && `agent ${agent}`, author && `author ${author}`].filter(Boolean).join(" · ") || "no lane information";
  return { label, kind, lane, refs, agent, title };
}
