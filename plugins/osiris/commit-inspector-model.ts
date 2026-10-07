// PURE model for the commit inspector (W-193c h): a readable commit, not a wall of text. Sections: title, who/when, message
// (collapsed past a short preview), trailers, files with counts. All text is untrusted and cleaned here, once.
import type { GitCommitDetail, GitTrailer } from "./git-types.ts";
import { conventional, conventionalTone, mergeMarker, type TypeTone } from "./git-ui.ts";
import { laneIdentity, type LaneIdentity } from "./git-lane-identity.ts";
import { splitTrailers } from "./lib/doc-reader.ts";
import { cleanText } from "./work/sanitize.ts";

export const PREVIEW_LINES = 4, PREVIEW_CHARS = 280;

export type InspectorModel = {
  title: { chip: { text: string; tone: TypeTone } | null; rest: string };
  merge: { glyph: string; label: string } | null;
  identity: LaneIdentity;
  /** Message without its trailer paragraph; `preview` is what shows while collapsed; `collapsed` = there is more than the preview. */
  message: { text: string; preview: string; collapsed: boolean; lines: number };
  trailers: GitTrailer[];
  counts: { files: number; additions: number; deletions: number; binary: number };
};

export function inspectorModel(d: GitCommitDetail, branch: string | null = null): InspectorModel {
  const subject = cleanText(d.subject), conv = conventional(subject);
  const split = splitTrailers(cleanText(d.body ?? "", 64 * 1024));
  const text = split.body.trim(), all = text ? text.split("\n") : [];
  const head = all.slice(0, PREVIEW_LINES).join("\n"), preview = head.length > PREVIEW_CHARS ? head.slice(0, PREVIEW_CHARS).trimEnd() + "…" : head;
  const collapsed = all.length > PREVIEW_LINES || head.length > PREVIEW_CHARS;
  return {
    title: { chip: conv ? { text: `${conv.type}${conv.scope ? `(${conv.scope})` : ""}${conv.breaking ? "!" : ""}`, tone: conventionalTone(conv.type, conv.breaking) } : null, rest: conv ? conv.rest : subject },
    merge: mergeMarker(d),
    identity: laneIdentity({ branch, trailers: split.trailers, author: d.author }),
    message: { text, preview, collapsed, lines: all.length },
    trailers: split.trailers,
    counts: { files: d.files.length, additions: d.files.reduce((n, f) => n + (f.additions ?? 0), 0), deletions: d.files.reduce((n, f) => n + (f.deletions ?? 0), 0), binary: d.files.filter(f => f.binary).length },
  };
}
