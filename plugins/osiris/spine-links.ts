// Thread <-> log <-> ADR links, derived ONLY from text the spine index already carries (thread titles/resume/refs, calendar event titles, the
// index's adrs list). Pure: no IO. Decisions are not read from decisions.md here; the producer's `adrs` list (D-135 sealing path) is the source.
import type { AdrLink, SpineEvent, SpineIndex, SpineThread } from "./spine-index.ts";

const ADR_RE = /\bD-\d+\b/gi;
/** Distinct, upper-cased D-NNN ids cited in a piece of text. */
export const adrIdsIn = (text: string): string[] => [...new Set((text.match(ADR_RE) ?? []).map(x => x.toUpperCase()))];

/** Calendar entries (log + decision) that cite the thread. */
export const logsOfThread = (index: Pick<SpineIndex, "calendar">, threadId: string): SpineEvent[] =>
  index.calendar.filter(e => (e.kind === "log" || e.kind === "decision") && e.threadIds.includes(threadId));

/** ADR ids a thread cites: its own `adrs`, plus D-NNN in its title/resume/refs and in the titles of the logs that cite it. */
function citedIds(index: Pick<SpineIndex, "calendar">, t: SpineThread): string[] {
  const text = [t.title, t.resume ?? "", ...t.refs, ...logsOfThread(index, t.id).map(e => e.title)].join("\n");
  return [...new Set([...t.adrs.map(a => a.id.toUpperCase()), ...adrIdsIn(text)])];
}

/** The ADRs a thread cites, resolved against the index's adr list (unknown D-NNN ids are dropped: no path, nothing to link to). */
export function adrsOfThread(index: Pick<SpineIndex, "calendar" | "adrs" | "threads">, t: SpineThread): AdrLink[] {
  const known = new Map<string, AdrLink>([...index.adrs, ...t.adrs].map(a => [a.id.toUpperCase(), a]));
  return citedIds(index, t).flatMap(id => known.get(id) ?? []);
}

/** The reverse link: every thread that cites ADR `adrId`. */
export function threadsCitingAdr(index: Pick<SpineIndex, "calendar" | "threads">, adrId: string): SpineThread[] {
  const id = adrId.toUpperCase();
  return index.threads.filter(t => citedIds(index, t).includes(id));
}
