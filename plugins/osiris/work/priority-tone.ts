// ONE priority -> tone rule (pure). P0 or a critical (crit) item is the red accent, P1 is amber, everything else is normal. Every surface that draws
// priority (Board card rule and P chip, Factory crates, Needs-you rows, Home rows, the terminal Factory's id colour) asks THIS function and styles the
// answer with a theme token, so two surfaces can never disagree about what is urgent.
export type PriorityTone = "failure" | "attention" | "normal";
export type PriorityItem = { priority?: number | null; kind?: string | null };

export const priorityTone = (item: PriorityItem): PriorityTone => item.kind === "crit" || item.priority === 0 ? "failure" : item.priority === 1 ? "attention" : "normal";
/** The theme token a tone is drawn with (null = normal: no accent). Tokens only, never a literal colour. */
export const PRIORITY_TOKEN: Readonly<Record<PriorityTone, string | null>> = { failure: "--oi-tone-failure", attention: "--oi-tone-attention", normal: null };
export const priorityToken = (item: PriorityItem): string | null => PRIORITY_TOKEN[priorityTone(item)];
/** "oi-pt-failure" / "oi-pt-attention", or "" for a normal item; the class sets --oi-pt, the one custom property the surfaces read. */
export const ptClass = (item: PriorityItem): string => { const t = priorityTone(item); return t === "normal" ? "" : `oi-pt-${t}`; };

export const priorityToneStyles = `
.oi-pt-failure{--oi-pt:var(--oi-tone-failure)}.oi-pt-attention{--oi-pt:var(--oi-tone-attention)}
.oi-bd-card.oi-pt-failure,.oi-bd-card.oi-pt-attention,.oi-dec-row.oi-pt-failure,.oi-dec-row.oi-pt-attention,.oi-hm-dec.oi-pt-failure,.oi-hm-dec.oi-pt-attention{border-left:3px solid var(--oi-pt)}
.oi-bd-p.oi-pt-failure,.oi-bd-p.oi-pt-attention{color:var(--oi-pt)}
.oi-iso-crate.oi-pt-failure polygon,.oi-iso-crate.oi-pt-attention polygon{stroke:var(--oi-pt);stroke-width:2;stroke-opacity:1}
.oi-iso-crate.oi-pt-failure,.oi-iso-crate.oi-pt-attention{filter:drop-shadow(0 0 3px var(--oi-pt))}
.oi-iso-prio.oi-pt-failure,.oi-iso-prio.oi-pt-attention,.oi-ff-prio.oi-pt-failure,.oi-ff-prio.oi-pt-attention{fill:var(--oi-pt)}
.oi-ff-tok.oi-pt-failure .oi-ff-crate,.oi-ff-tok.oi-pt-attention .oi-ff-crate{stroke:var(--oi-pt);stroke-width:2}
.oi-ff-tok.oi-pt-failure,.oi-ff-tok.oi-pt-attention{filter:drop-shadow(0 0 3px var(--oi-pt))}
`;
