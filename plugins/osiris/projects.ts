/**
 * Project spine v2 model (PRIVATE Osiris build): a pure, tolerant reader plus every derived value the Projects view shows.
 * Behaviour spec: the owner's `build_board_v2.py` + `board-controls.js`. NO project data lives here: names, slugs and
 * ordering come from the files at runtime. Every function that depends on "now" takes `today` ("YYYY-MM-DD") so tests are
 * deterministic.
 */

/** The ONE staleness threshold: a spine (greyed), a card (STALE) and the legend all read it. */
export const STALE_DAYS = 14;
export const GROUP_ORDER = ["SaaS", "Clients", "Job & career", "Personal", "Other"] as const;
export type Group = (typeof GROUP_ORDER)[number];
export const HORIZONS = ["long", "medium", "short"] as const;
export const HORIZON_LABEL: Record<(typeof HORIZONS)[number], string> = { long: "L1 · direction", medium: "L2 · outcome", short: "L3 · slice" };
export const COLUMNS = ["now", "next", "waiting", "later", "done"] as const;
export type Column = (typeof COLUMNS)[number];
export const COLUMN_LABEL: Record<Column, string> = { now: "Now", next: "Next", waiting: "Waiting", later: "Later", done: "Done" };
export type Badge = "V" | "S" | "I";

export type Health = { level: string | null; why: string | null };
export type WorkDate = { value: string | null; kind: string | null };
export type Outcome = {
  id: string; title: string | null; summary: string | null; horizon: string | null; status: string | null;
  provenance: string | null; verification: string | null; evidence: string[]; source: string | null;
};
export type Work = {
  id: string; outcome: string | null; standalone_reason: string | null; title: string | null; state_line: string | null; next_action: string | null;
  status: string | null; horizon: string | null; waiting_on: string | null; date: WorkDate; provenance: string | null; verification: string | null;
  evidence: string[]; refs: string[]; detail: string | null; source: string | null;
};
export type Shipped = { title: string | null; date: string | null; verification: string | null; evidence: string[] };
export type Reconciled = { conflict: string | null; truth: string | null; how_checked: string | null };
export type ProjectMeta = { id: string; name: string; domain: string | null; one_liner: string | null; health: Health; freshness: string | null };
export type Overview = { current_outcome: string | null; next_milestone: string | null; next_action: string | null; waiting_on: string | null; latest_delivery: string | null };
export type SpineV2 = {
  schema_version: 2; project: ProjectMeta; overview: Overview; outcomes: Outcome[]; work: Work[]; shipped: Shipped[];
  reconciled: Reconciled[]; unknowns: string[];
  /** Malformed items skipped while parsing (outcomes, work, shipped, reconciled, unknowns). */
  dropped: number;
};
export type ParsedSpine = { ok: true; spine: SpineV2 } | { ok: false; reason: string };

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Tolerant: unknown fields ignored; a malformed list item is dropped and counted; `schema_version` must be 2 and `project.id`/`name` strings. */
export function parseSpineV2(value: unknown): ParsedSpine {
  if (!isRec(value)) return { ok: false, reason: "Not a JSON object." };
  if (value.schema_version !== 2) return { ok: false, reason: "schema_version must be 2." };
  const p = value.project;
  if (!isRec(p) || !str(p.id) || !str(p.name)) return { ok: false, reason: "project.id and project.name are required." };
  let dropped = 0;
  const list = <T>(v: unknown, one: (x: Record<string, unknown>) => T | null): T[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) { dropped++; return []; }
    const out: T[] = [];
    for (const x of v) { const r = isRec(x) ? one(x) : null; if (r) out.push(r); else dropped++; }
    return out;
  };
  const h = isRec(p.health) ? p.health : {};
  const o = isRec(value.overview) ? value.overview : {};
  const spine: SpineV2 = {
    schema_version: 2,
    project: { id: p.id as string, name: p.name as string, domain: str(p.domain), one_liner: str(p.one_liner), health: { level: str(h.level), why: str(h.why) }, freshness: str(p.freshness) },
    overview: { current_outcome: str(o.current_outcome), next_milestone: str(o.next_milestone), next_action: str(o.next_action), waiting_on: str(o.waiting_on), latest_delivery: str(o.latest_delivery) },
    outcomes: list(value.outcomes, x => str(x.id) ? { id: x.id as string, title: str(x.title), summary: str(x.summary), horizon: str(x.horizon), status: str(x.status), provenance: str(x.provenance), verification: str(x.verification), evidence: strs(x.evidence), source: str(x.source) } : null),
    work: list(value.work, x => {
      if (!str(x.id)) return null;
      const d = isRec(x.date) ? x.date : {};
      return { id: x.id as string, outcome: str(x.outcome), standalone_reason: str(x.standalone_reason), title: str(x.title), state_line: str(x.state_line), next_action: str(x.next_action), status: str(x.status), horizon: str(x.horizon), waiting_on: str(x.waiting_on), date: { value: str(d.value), kind: str(d.kind) }, provenance: str(x.provenance), verification: str(x.verification), evidence: strs(x.evidence), refs: strs(x.refs), detail: str(x.detail), source: str(x.source) };
    }),
    shipped: list(value.shipped, x => ({ title: str(x.title), date: str(x.date), verification: str(x.verification), evidence: strs(x.evidence) })),
    reconciled: list(value.reconciled, x => ({ conflict: str(x.conflict), truth: str(x.truth), how_checked: str(x.how_checked) })),
    unknowns: [],
    dropped: 0,
  };
  if (Array.isArray(value.unknowns)) { spine.unknowns = strs(value.unknowns); dropped += value.unknowns.length - spine.unknowns.length; } else if (value.unknowns !== undefined && value.unknowns !== null) dropped++;
  spine.dropped = dropped;
  return { ok: true, spine };
}

// ---------- dates (all string-based; `today` is "YYYY-MM-DD")
export function todayKey(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dayNumber(v: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ""));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const back = new Date(t);
  return back.getUTCMonth() === +m[2] - 1 && back.getUTCDate() === +m[3] ? Math.floor(t / 86400000) : null;
}
/** Whole days from `date` to `today`; null when either is not a valid ISO day (python `days_since`). */
export function daysSince(date: string | null | undefined, today: string): number | null {
  const a = dayNumber(date), b = dayNumber(today);
  return a === null || b === null ? null : b - a;
}

// ---------- grouping
const GROUP_OF: Record<string, Group> = { freelance: "Clients", saas: "SaaS", career: "Job & career", personal: "Personal" };
export function groupOf(domain: string | null | undefined): Group { return GROUP_OF[String(domain ?? "")] ?? "Other"; }
const nameKey = (p: SpineV2) => p.project.name.toLowerCase();
/** Fixed group order; within a group sorted by project name (case-folded code-unit order, id as tie-break). Empty groups omitted. */
export function groupProjects(projects: SpineV2[]): { group: Group; projects: SpineV2[] }[] {
  return GROUP_ORDER.map(group => ({
    group,
    projects: projects.filter(p => groupOf(p.project.domain) === group).sort((a, b) => (nameKey(a) < nameKey(b) ? -1 : nameKey(a) > nameKey(b) ? 1 : a.project.id < b.project.id ? -1 : a.project.id > b.project.id ? 1 : 0)),
  })).filter(g => g.projects.length > 0);
}

// ---------- badges, columns
export function badge(item: { verification?: string | null; provenance?: string | null; status?: string | null }): Badge {
  if (item.verification === "verified") return "V";
  if (item.provenance === "inferred" || item.status === "suggested") return "I";
  return "S";
}
export function colOf(work: { status?: string | null }): Column {
  const s = work.status;
  return s === "now" || s === "next" || s === "waiting" || s === "done" ? s : "later";
}
export function horizonOf(work: { horizon?: string | null }): (typeof HORIZONS)[number] {
  const h = work.horizon || "short";
  return h === "long" || h === "medium" ? h : "short";
}
/** Cards for one board cell. A horizon outside long/medium/short never matches a row in the reference (it is not shown); kept identical. */
export function cellWork(spine: SpineV2, horizon: string, col: Column): Work[] {
  return spine.work.filter(w => (w.horizon || "short") === horizon && colOf(w) === col);
}
export function badgeCounts(items: { verification?: string | null; provenance?: string | null; status?: string | null }[]): Record<Badge, number> {
  const n: Record<Badge, number> = { V: 0, S: 0, I: 0 };
  for (const i of items) n[badge(i)]++;
  return n;
}

// ---------- portfolio cells
export type HealthView = { level: string; glyph: string; stale: boolean; label: string; tip: string };
export function healthView(spine: SpineV2, today: string): HealthView {
  const lvl = (spine.project.health.level ?? "").toLowerCase();
  const age = daysSince(spine.project.freshness, today);
  const stale = age === null || age > STALE_DAYS;
  const glyph = ({ green: "●", yellow: "◐", red: "■" } as Record<string, string>)[lvl] ?? "○";
  return { level: lvl || "none", glyph, stale, label: `${glyph} ${lvl || "—"}${stale ? " · stale" : ""}`, tip: `${lvl || "unknown"} — ${spine.project.health.why ?? ""} (as of ${spine.project.freshness ?? "?"})` };
}
export type Delivery = { title: string; badge: "V" | "S" | null; date: string | null };
export function latestDelivery(spine: SpineV2): Delivery | null {
  const sh = [...spine.shipped].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  if (sh.length === 0) { const t = spine.overview.latest_delivery; return t ? { title: t, badge: null, date: null } : null; }
  const s = sh[0];
  return { title: s.title ?? "—", badge: s.verification === "verified" ? "V" : "S", date: s.date };
}
export function phase(spine: SpineV2): "?" | ">" { return spine.work.some(w => w.status === "now") ? ">" : "?"; }
/** Days since the most recent VERIFIED delivery; null when none. */
export function ageSinceVerified(spine: SpineV2, today: string): number | null {
  const ages = spine.shipped.filter(s => s.verification === "verified").map(s => daysSince(s.date, today)).filter((d): d is number => d !== null);
  return ages.length ? Math.min(...ages) : null;
}

// ---------- board cards and outcome gutter
export type CardLines = { title: string; outcomeTag: string; badge: Badge; doneUnverified: boolean; line3: string; next: string | null };
const dash = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? "—" : v);
export function cardLines(work: Work): CardLines {
  const col = colOf(work), b = badge(work);
  const line3 = col === "waiting" ? `waiting on: ${dash(work.waiting_on)}` : work.date.value && work.date.kind === "planned" ? `due ${work.date.value}` : dash(work.state_line);
  return { title: dash(work.title), outcomeTag: `[${dash(work.outcome)}]`, badge: b, doneUnverified: col === "done" && b !== "V", line3, next: work.next_action && col !== "done" ? work.next_action : null };
}
export type Rollup = { outcome: Outcome; served: number; counts: Record<Badge, number>; text: string };
export function outcomeRollups(spine: SpineV2): Rollup[] {
  return spine.outcomes.map(outcome => {
    const served = spine.work.filter(w => w.outcome === outcome.id), counts = badgeCounts(served);
    return { outcome, served: served.length, counts, text: `${dash(outcome.horizon)} · serves ${served.length} · ${counts.V}V ${counts.S}S ${counts.I}I` };
  });
}
export function recentlyShipped(spine: SpineV2, n = 6): Shipped[] { return [...spine.shipped].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")).slice(0, n); }
export function topUnknowns(spine: SpineV2, n = 8): string[] { return spine.unknowns.slice(0, n); }

// ---------- search and pills
export function normalize(text: string): string { return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase().replace(/\s+/g, " ").trim(); }
/** Every portfolio cell, joined. `today` adds the health-stale and age cells (omitted when not given). */
export function projectSearchText(spine: SpineV2, today?: string): string {
  const o = spine.overview, d = latestDelivery(spine);
  const age = today === undefined ? null : ageSinceVerified(spine, today);
  return [
    today === undefined ? spine.project.health.level ?? "" : healthView(spine, today).label, spine.project.name, o.current_outcome, phase(spine), o.next_milestone, o.next_action, o.waiting_on,
    d ? `${d.title} ${d.badge ?? ""} ${d.date ?? ""}` : "", age === null ? "" : `${age}d`,
  ].filter(x => x !== null && x !== "").join(" ");
}
export type FilterRow = { group: string; text: string };
export type FilterResult<T> = { visible: T[]; countsByPill: Record<string, number>; pills: string[]; total: number; label: string };
/** Pills = "all" + each group present (in row order). Counts honour the search; visible honours pill AND search. */
export function filterProjects<T extends FilterRow>(rows: T[], pill: string, query: string): FilterResult<T> {
  const terms = normalize(query).split(" ").filter(Boolean);
  const matching = rows.filter(r => { const t = normalize(r.text); return terms.every(term => t.includes(term)); });
  const pills = ["all", ...new Set(rows.map(r => r.group))];
  const countsByPill: Record<string, number> = {};
  for (const p of pills) countsByPill[p] = matching.filter(r => p === "all" || r.group === p).length;
  const visible = matching.filter(r => pill === "all" || r.group === pill);
  const label = `${visible.length} of ${rows.length} projects${pill === "all" ? "" : ` · ${pill}`}${terms.length ? ` · “${query.trim()}”` : ""}`;
  return { visible, countsByPill, pills, total: rows.length, label };
}
