// The ONE glossary of Work-surface jargon: term -> plain label + one-sentence definition. Pure (no React); every view that shows one of
// these words routes it through here so the same thing has the same name on the Board, the inspector, the dispatch dialog and (as they
// adopt it) the Factory and the KPI strip. The first use of a term inside a view carries its definition as a tooltip (firstUse below).

export type TermKey = "bead" | "claim" | "pane" | "gate" | "rework" | "ghost" | "collision" | "stale" | "dispatch" | "lease" | "epic";
export type Term = {readonly label: string; readonly definition: string};

export const GLOSSARY: Readonly<Record<TermKey, Term>> = {
  bead: {label: "work item", definition: "One tracked piece of work, with a title, a priority and an owner."},
  claim: {label: "claim", definition: "An agent putting its name on a work item so nobody else starts it."},
  pane: {label: "agent terminal", definition: "The terminal window an agent works in."},
  gate: {label: "review", definition: "The check a finished work item must pass before it counts as done."},
  rework: {label: "sent back", definition: "A work item that failed review and went back to be fixed."},
  ghost: {label: "ghost claim", definition: "A claim whose agent terminal is gone, so nobody is really working on it."},
  collision: {label: "double claim", definition: "Two agents holding the same agent terminal at the same time."},
  stale: {label: "gone quiet", definition: "A claim or agent terminal that has shown no sign of life for a while."},
  dispatch: {label: "assign to an agent", definition: "Hand a work item to an agent: Osiris claims it, makes a separate working copy and starts the agent in a new terminal."},
  epic: {label: "epic", definition: "A group of related work items that belong together."},
  lease: {label: "claim time limit", definition: "How long a claim can stay silent before it counts as gone quiet."},
};
export const GLOSSARY_KEYS = Object.keys(GLOSSARY) as readonly TermKey[];

export const termLabel = (k: TermKey): string => GLOSSARY[k].label;
export const termDef = (k: TermKey): string => GLOSSARY[k].definition;
export const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** One per render of a view: the first call for a term returns its definition (for a `title`), every later call returns undefined,
 *  so only the first place a term appears in that view carries the tooltip. Fresh per render, so rendering stays pure. */
export function firstUse(): (k: TermKey) => string | undefined {
  const seen = new Set<TermKey>();
  return k => { if (seen.has(k)) return undefined; seen.add(k); return termDef(k); };
}
