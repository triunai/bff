/** Pure consumer of `.spine/spine-index.json` contract v1. Tolerant: unknown fields ignored, malformed rows dropped and counted. */
export type ThreadStatus = "active" | "parked" | "done" | "debt" | "emergency" | "other";
export type CalendarKind = "log" | "commit" | "thread-done" | "decision";
export type HealthStatus = "pass" | "warn" | "fail";
export type AdrLink = { id: string; title: string; where: "repo" | "vault"; path: string; obsidianUrl?: string };
export type SpineThread = { id: string; title: string; status: ThreadStatus; statusGlyph: string; line: number; resume?: string; refs: string[]; adrs: AdrLink[]; cold?: string[] };
export type SpineEvent = { date: string; kind: CalendarKind; title: string; ref: string; threadIds: string[]; source: "hot" | "cold" };
/** `value`/`limit` are OPTIONAL numeric fields (T5 is adding them); without both, no bar is drawn and the text shows. */
export type SpineHealth = { check: string; status: HealthStatus; detail: string; measured: string; value?: number; limit?: number; unit?: string; total?: number; oldest?: string };
/** `threads` is OPTIONAL: when the producer lists the threads an archive file holds (with titles), they win over the board join. */
export type SpineCold = { path: string; kind: string; period: string; threads?: { id: string; title?: string }[] };
/** Optional `focus` addendum (T5 2026-10-06): the board's current goal. ABSENT when there is no goal, never null. */
export type FocusItemStatus = "fixed" | "built" | "closed" | "owner-gate" | "open";
export type FocusItem = { id: string; label: string; status: FocusItemStatus; ref?: string; raw?: string };
export type SpineFocus = {
  goal: { title: string; line: number; status: "active" | "met"; since: string; metLine?: number };
  items: FocusItem[]; ownerGates: { label: string }[]; fleet?: { title: string; line: number };
};
export type SpineIndex = {
  focus?: SpineFocus;
  schemaVersion: 1; generatedAt: string; repo: { path: string; head: string; branch: string };
  router: { path: string; artifacts: { name: string; path: string; question: string; exists: boolean }[] };
  threads: SpineThread[]; calendar: SpineEvent[]; health: SpineHealth[]; cold: SpineCold[]; adrs: AdrLink[];
};
export type ParseResult = { ok: true; index: SpineIndex; dropped: number } | { ok: false; reason: string };

export const STATUS_ORDER: ThreadStatus[] = ["emergency", "active", "debt", "parked", "other", "done"];
const STATUSES = new Set<string>(STATUS_ORDER), KINDS = new Set(["log", "commit", "thread-done", "decision"]), HEALTH = new Set(["pass", "warn", "fail"]);
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A real calendar day, not just the shape: `2026-13-45` or `2026-02-31` would render an "undefined" month or never
 * appear in any grid cell, so they are dropped and counted like any other malformed row (review-1 F7). */
export function isCalendarDate(value: string): boolean {
  const m = DATE.exec(value); if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
/** Only `obsidian://open?` links are rendered: other Obsidian actions (`new`, `adv-uri`, ...) can WRITE to the vault,
 * and a repo's spine-index is untrusted input (review-1 F6). */
export const isSafeObsidianOpenUrl = (url: string | undefined): url is string => typeof url === "string" && /^obsidian:\/\/open\?[^\s"'<>]*$/.test(url);
const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter(str) : []);

function adr(v: unknown): AdrLink | null {
  if (!rec(v) || !str(v.id) || !str(v.title) || !str(v.path) || (v.where !== "repo" && v.where !== "vault")) return null;
  return { id: v.id, title: v.title, where: v.where, path: v.path, ...(str(v.obsidianUrl) ? { obsidianUrl: v.obsidianUrl } : {}), ...(str(v.date) && DATE.test(v.date) ? { date: v.date } : {}), ...(str(v.status) ? { status: v.status } : {}) };
}
function thread(v: unknown): SpineThread | null {
  if (!rec(v) || !str(v.id) || !str(v.title)) return null;
  // An unknown status from a newer producer degrades to "other" instead of hiding the thread.
  const status = (str(v.status) && STATUSES.has(v.status) ? v.status : "other") as ThreadStatus;
  return { id: v.id, title: v.title, status, statusGlyph: str(v.statusGlyph) ? v.statusGlyph : "", line: typeof v.line === "number" ? v.line : 0, ...(str(v.resume) ? { resume: v.resume } : {}), refs: strs(v.refs), adrs: Array.isArray(v.adrs) ? v.adrs.map(adr).filter((a): a is AdrLink => a !== null) : [], ...(Array.isArray(v.cold) ? { cold: strs(v.cold) } : {}) };
}
function event(v: unknown): SpineEvent | null {
  if (!rec(v) || !str(v.date) || !isCalendarDate(v.date) || !str(v.kind) || !KINDS.has(v.kind) || !str(v.title) || !str(v.ref)) return null;
  return { date: v.date, kind: v.kind as CalendarKind, title: v.title, ref: v.ref, threadIds: strs(v.threadIds), source: v.source === "cold" ? "cold" : "hot" };
}
function health(v: unknown): SpineHealth | null {
  if (!rec(v) || !str(v.check) || !str(v.status) || !HEALTH.has(v.status)) return null;
  return { check: v.check, status: v.status as HealthStatus, detail: str(v.detail) ? v.detail : "", measured: str(v.measured) ? v.measured : "", ...(num(v.value) ? { value: v.value } : {}), ...(num(v.limit) ? { limit: v.limit } : {}), ...(str(v.unit) && v.unit ? { unit: v.unit } : {}), ...(num(v.total) && Number.isInteger(v.total) && v.total >= 0 ? { total: v.total } : {}), ...(str(v.oldest) && /^\d{4}-\d{2}$/.test(v.oldest) ? { oldest: v.oldest } : {}) };
}
function cold(v: unknown): SpineCold | null {
  if (!rec(v) || !str(v.path) || !str(v.kind)) return null;
  const threads = Array.isArray(v.threads) ? v.threads.flatMap(t => (rec(t) && str(t.id) ? [{ id: t.id, ...(str(t.title) ? { title: t.title } : {}) }] : [])) : undefined;
  return { path: v.path, kind: v.kind, period: str(v.period) ? v.period : "", ...(threads ? { threads } : {}) };
}

const FOCUS_STATUSES = new Set<string>(["fixed", "built", "closed", "owner-gate", "open"]);
/** Tolerant `focus` parse. A missing/non-object/goal-less focus yields undefined (never null); malformed items and gates
 * are dropped and reported through `drop`. */
function parseFocus(v: unknown, drop: () => void): SpineFocus | undefined {
  if (!rec(v) || !rec(v.goal) || !str(v.goal.title) || !str(v.goal.since)) return undefined;
  const g = v.goal, line = num(g.line) ? g.line : 0;
  const goal: SpineFocus["goal"] = { title: g.title as string, line, status: g.status === "met" ? "met" : "active", since: g.since as string, ...(num(g.metLine) ? { metLine: g.metLine } : {}) };
  const items: FocusItem[] = [];
  for (const it of Array.isArray(v.items) ? v.items : []) {
    if (!rec(it) || !str(it.id) || !str(it.label) || !str(it.status) || !FOCUS_STATUSES.has(it.status)) { drop(); continue; }
    items.push({ id: it.id, label: it.label, status: it.status as FocusItemStatus, ...(str(it.ref) ? { ref: it.ref } : {}), ...(str(it.raw) ? { raw: it.raw } : {}) });
  }
  const ownerGates: { label: string }[] = [];
  for (const gate of Array.isArray(v.ownerGates) ? v.ownerGates : []) { if (rec(gate) && str(gate.label)) ownerGates.push({ label: gate.label }); else drop(); }
  const f = v.fleet;
  const fleet = rec(f) && str(f.title) ? { title: f.title, line: num(f.line) ? f.line : 0 } : undefined;
  return { goal, items, ownerGates, ...(fleet ? { fleet } : {}) };
}

export function parseSpineIndex(value: unknown): ParseResult {
  if (!rec(value)) return { ok: false, reason: "spine-index.json is not a JSON object." };
  if (value.schemaVersion !== 1) return { ok: false, reason: `Unsupported schemaVersion ${JSON.stringify(value.schemaVersion)}; this view reads v1.` };
  if (!rec(value.repo) || !str(value.repo.path)) return { ok: false, reason: "Missing repo.path." };
  let dropped = 0;
  const rows = <T,>(v: unknown, f: (x: unknown) => T | null): T[] => {
    if (!Array.isArray(v)) return [];
    const out: T[] = [];
    for (const item of v) { const r = f(item); if (r === null) dropped++; else out.push(r); }
    return out;
  };
  const router = rec(value.router) ? value.router : {};
  const artifacts = rows(router.artifacts, a => rec(a) && str(a.name) && str(a.path) ? { name: a.name, path: a.path, question: str(a.question) ? a.question : "", exists: a.exists === true } : null);
  const focus = parseFocus(value.focus, () => { dropped++; });
  const index: SpineIndex = {
    ...(focus ? { focus } : {}),
    schemaVersion: 1, generatedAt: str(value.generatedAt) ? value.generatedAt : "",
    repo: { path: value.repo.path, head: str(value.repo.head) ? value.repo.head : "", branch: str(value.repo.branch) ? value.repo.branch : "" },
    router: { path: str(router.path) ? router.path : "hygiene.md", artifacts },
    threads: rows(value.threads, thread), calendar: rows(value.calendar, event), health: rows(value.health, health), cold: rows(value.cold, cold), adrs: rows(value.adrs, adr),
  };
  return { ok: true, index, dropped };
}

/** Non-empty status groups in the fixed display order. */
export function groupThreads(threads: SpineThread[]): { status: ThreadStatus; threads: SpineThread[] }[] {
  return STATUS_ORDER.map(status => ({ status, threads: threads.filter(t => t.status === status) })).filter(g => g.threads.length > 0);
}
export function healthSummary(rows: SpineHealth[]): { pass: number; warn: number; fail: number } {
  const s = { pass: 0, warn: 0, fail: 0 };
  for (const r of rows) s[r.status]++;
  return s;
}
/** Newest calendar date (lexicographic works for YYYY-MM-DD), or null when there are no events. */
export function newestEventDate(events: SpineEvent[]): string | null {
  return events.reduce<string | null>((m, e) => (m === null || e.date > m ? e.date : m), null);
}
/** Cold file path -> ids of threads that list it. */
export function coldReferrers(index: Pick<SpineIndex, "threads">): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const t of index.threads) for (const p of t.cold ?? []) m.set(p, [...(m.get(p) ?? []), t.id]);
  return m;
}
export function groupColdByKind(cold: SpineCold[]): { kind: string; files: SpineCold[] }[] {
  const kinds = [...new Set(cold.map(c => c.kind))].sort();
  return kinds.map(kind => ({ kind, files: cold.filter(c => c.kind === kind).sort((a, b) => b.period.localeCompare(a.period)) }));
}

/** I2 (owner 17:11): Osiris is a PROJECTION of the spine, never an authority. The per-thread WORK projection lists
 * the owner's fields in a fixed order; a field spine-index v1 does not carry is `value: null` with a reason, and the
 * UI shows it as unavailable — never inferred from neighbouring data. */
export type WorkField = { label: string; value: string | null; why?: string };
const NOT_CARRIED = "not carried by spine-index v1";
export function workProjection(t: SpineThread, calendar: readonly SpineEvent[]): WorkField[] {
  const mine = calendar.filter(e => e.threadIds.includes(t.id));
  const latest = mine.reduce<string | null>((m, e) => (m === null || e.date > m ? e.date : m), null);
  return [
    { label: "Contract", value: null, why: NOT_CARRIED },
    { label: "Pins", value: null, why: NOT_CARRIED },
    { label: "Decisions/ADRs", value: String(t.adrs.length) },
    { label: "Fitness", value: null, why: NOT_CARRIED },
    { label: "Review", value: null, why: NOT_CARRIED },
    { label: "Evidence", value: null, why: `${NOT_CARRIED}; ${mine.length} calendar entr${mine.length === 1 ? "y" : "ies"} reference this thread${latest ? ` (latest ${latest})` : ""}` },
    { label: "Resume", value: t.resume ?? null, why: t.resume ? undefined : "no Resume: line on the board" },
  ];
}

/** Operator-facing status words (DR-21): never show the raw enum value. */
export const STATUS_LABEL: Record<ThreadStatus, string> = { emergency: "Emergency", active: "Active", debt: "Tech debt", parked: "Parked", done: "Done", other: "Other" };

/** Footer status line: everything comes straight from the index. `shortHead` is the first 8 chars of repo.head. */
export function spineStatus(index: SpineIndex) {
  const c = threadCounts(index), h = healthSummary(index.health);
  return { branch: index.repo.branch, shortHead: index.repo.head.slice(0, 8), generatedAt: index.generatedAt, active: c.active, emergency: c.emergency, healthFail: h.fail, healthWarn: h.warn };
}
/** Work header counts. total = emergency + active + debt + cold; debt is its own bucket (DR-24); cold = parked + other + done. */
export function threadCounts(index: Pick<SpineIndex, "threads">) {
  const total = index.threads.length, emergency = index.threads.filter(t => t.status === "emergency").length, active = index.threads.filter(t => t.status === "active").length;
  // DR-24: tech debt is red-flagged work (every verified CRIT becomes a "🔴 TECH DEBT" board line), so it is its own
  // bucket and never filed under Cold. Cold = parked + other + done. total = emergency + active + debt + cold.
  const debt = index.threads.filter(t => t.status === "debt").length;
  return { total, emergency, active, debt, cold: total - emergency - active - debt };
}
/** Health rows split by severity, each keeping the index's own order. */
export function sortHealth(index: Pick<SpineIndex, "health">): { fail: SpineHealth[]; warn: SpineHealth[]; pass: SpineHealth[] } {
  return { fail: index.health.filter(h => h.status === "fail"), warn: index.health.filter(h => h.status === "warn"), pass: index.health.filter(h => h.status === "pass") };
}
/** A bar only when the row carries BOTH numeric value and limit (limit > 0). Nothing is parsed out of `detail`/`measured` text. `ratio` is value/limit, unclamped. */
export function healthBar(h: SpineHealth): { value: number; limit: number; ratio: number } | null {
  return h.value !== undefined && h.limit !== undefined && h.limit > 0 ? { value: h.value, limit: h.limit, ratio: h.value / h.limit } : null;
}
export type ArchiveThread = { id: string; title: string | null };
export type ArchiveFile = { path: string; kind: string; period: string; threads: ArchiveThread[] };
export type ArchiveMonth = { month: string; files: ArchiveFile[]; count: number };
/** Archive browser model: months (newest first) -> snapshot files (newest first) -> threads. A file's month is the first
 * YYYY-MM in its period, else in its path, else "Undated" (sorted last). Threads come from the producer's `cold[].threads`
 * when present, else from threads whose `cold` lists the file, with titles joined from the board (null when the id is not
 * on the board). */
export function archiveByMonth(index: Pick<SpineIndex, "cold" | "threads">): ArchiveMonth[] {
  const refs = coldReferrers(index), titles = new Map(index.threads.map(t => [t.id, t.title]));
  const monthOf = (c: SpineCold) => /(\d{4}-\d{2})/.exec(c.period)?.[1] ?? /(\d{4}-\d{2})/.exec(c.path)?.[1] ?? "Undated";
  const byMonth = new Map<string, ArchiveFile[]>();
  for (const c of index.cold) {
    const threads: ArchiveThread[] = c.threads ? c.threads.map(t => ({ id: t.id, title: t.title ?? titles.get(t.id) ?? null })) : (refs.get(c.path) ?? []).map(id => ({ id, title: titles.get(id) ?? null }));
    const m = monthOf(c);
    byMonth.set(m, [...(byMonth.get(m) ?? []), { path: c.path, kind: c.kind, period: c.period, threads }]);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => (a === "Undated" ? 1 : b === "Undated" ? -1 : b.localeCompare(a)))
    .map(([month, files]) => { const sorted = [...files].sort((a, b) => b.period.localeCompare(a.period) || a.path.localeCompare(b.path)); return { month, files: sorted, count: sorted.reduce((n, f) => n + f.threads.length, 0) }; });
}
/** Deterministic relative time ("just now", "5m ago", "3h ago", "2d ago"); unparsable input is returned unchanged. */
export function relativeTime(iso: string, now: Date | number): string {
  const t = Date.parse(iso); if (Number.isNaN(t)) return iso;
  const s = Math.round(((typeof now === "number" ? now : now.getTime()) - t) / 1000);
  if (s < 0) return "just now";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400)}d ago`;
  return `${Math.floor(s / (86400 * 30))}mo ago`;
}

const fmtN = (n: number) => n.toLocaleString("en-US");
/** One operator sentence for a FAIL/WARN check, built only from the producer's numeric fields (T5 addendum ~19:30):
 * "2,539 lines · limit 150", "1 of 66 drifted files · limit 0", "115 entries · limit 0 · oldest 2026-06".
 * null when the check is not numeric (e.g. calendar-sources) — the caller shows the producer's `measured` text. */
export function healthFigure(h: SpineHealth): string | null {
  if (h.value === undefined) return null;
  const unit = h.unit ? ` ${h.unit}` : "";
  const head = h.total !== undefined ? `${fmtN(h.value)} of ${fmtN(h.total)}${unit}` : `${fmtN(h.value)}${unit}`;
  const limit = h.limit === undefined ? null : h.limit === 0 ? "expected 0" : `limit ${fmtN(h.limit)}${unit}`;
  return [head, limit, h.oldest ? `oldest ${h.oldest}` : null].filter(Boolean).join(" · ");
}

/** Board and archive titles often repeat their own id ("W-131 · Upgrading…": 142/221 board, 43/188 archive on the real
 * index). Rows already print the id, so strip ONLY an exact leading id + separator; anything else is left as written. */
export function displayTitle(id: string, title: string | null): string {
  if (!title) return "";
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return title.replace(new RegExp(`^${esc}\\s*[·:—–-]\\s*`), "") || title;
}
