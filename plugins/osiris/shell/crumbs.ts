// Location -> breadcrumb trail (pure). ONE table per view: its label, and how its two deeper levels are worded.
// A crumb's target is the location truncated to that level; the last crumb has no target (it is where you are).
import type { Loc, ViewId } from "./nav-history.ts";

export type Crumb = { label: string; target: Loc | null };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WORK_MODES: Record<string, string> = { beads: "Graph", board: "Board", factory: "Factory", threads: "Threads", projects: "Projects" };
const HISTORY_SUBS: Record<string, string> = { commits: "Commits", "working-tree": "Working tree" };
const asIs = (v: string) => v;
const short = (v: string) => (v.length > 24 ? `${v.slice(0, 23)}…` : v);
const month = (v: string) => MONTHS[Number(v.slice(5, 7)) - 1] ?? v;
const day = (v: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v), d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  return m && d ? `${DAYS[d.getUTCDay()]} ${+m[3]} ${MONTHS[+m[2] - 1].slice(0, 3)}` : v;
};
const sha = (v: string) => (/^[0-9a-f]{12,40}$/.test(v) ? v.slice(0, 7) : v);
const lookup = (t: Record<string, string>) => (v: string) => t[v] ?? v;

/** view -> [view label, sub-level wording, item-level wording]. The only place a level's text is decided. */
export const CRUMB_TABLE: Record<ViewId, [string, (v: string) => string, (v: string) => string]> = {
  home: ["Home", asIs, asIs],
  terminal: ["Terminal", asIs, short],
  work: ["Work", lookup(WORK_MODES), short],
  calls: ["Calls", asIs, short],
  history: ["History", lookup(HISTORY_SUBS), sha],
  calendar: ["Calendar", month, day],
  health: ["Health", asIs, short],
  archive: ["Archive", short, short],
};

export function crumbsOf(loc: Loc): Crumb[] {
  const [label, subText, itemText] = CRUMB_TABLE[loc.view];
  const levels: { label: string; target: Loc }[] = [{ label, target: { view: loc.view } }];
  if (loc.sub !== undefined) levels.push({ label: subText(loc.sub), target: { view: loc.view, sub: loc.sub } });
  if (loc.item !== undefined) levels.push({ label: itemText(loc.item), target: { ...(loc.sub !== undefined ? { view: loc.view, sub: loc.sub } : { view: loc.view }), item: loc.item } });
  return levels.map((l, i) => ({ label: l.label, target: i === levels.length - 1 ? null : l.target }));
}
