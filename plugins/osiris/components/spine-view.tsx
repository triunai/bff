import { AskAgentButton, dayContext, healthCheckContext, threadContext } from "../work/ask-agent/index.ts";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { demoOn } from "../demo/client.ts";
import { DEMO_REPO } from "../demo/constants.ts";
import type { rpcContract } from "../server";
import type { SpineRead } from "../spine-feed.ts";
import type { CommitMention, DocSection } from "../git-types.ts";
import { CALENDAR_KINDS, countKinds, dotsForDay, filterTotal, kindDef, kindLabel, monthKindTotals, pillsForDay, type KindFilter } from "../calendar-kinds.ts";
import { relativeAge, shortSha } from "../git-ui.ts";
import { commitBeads } from "../git-lane-identity.ts";
import { adrIdsIn, adrsOfThread, logsOfThread, threadsCitingAdr } from "../spine-links.ts";
import {
  archiveByMonth, displayTitle, groupThreads, healthBar, healthFigure, healthSummary, isSafeObsidianOpenUrl, newestEventDate, relativeTime, sortHealth,
  STATUS_LABEL, threadCounts, workProjection, type AdrLink, type SpineEvent, type SpineHealth, type SpineIndex, type SpineThread, type ThreadStatus,
} from "../spine-index.ts";
import type { ArchivedBeadRow } from "../work/archived-beads.ts";
import { pinRepoVia, type CallLike } from "../shell/app-wiring.ts";
import { hourStrip, monthSpend, spendChipText, spendLevel, spendStatus, spendTitle, weekSpend, monthDates, type SpendIndex } from "../spend-calendar.ts";
import { loadCalMode, saveCalMode, type CalMode } from "../lib/calendar-mode.ts";
import { dayKey, eventsByDay, localDayKey, monthCells, monthLabel, monthOf, shiftMonth, weekOf, type YearMonth } from "../spine-calendar.ts";

export type SpineSection = "work" | "calendar" | "health" | "archive";
export type SpineSelection =
  | { kind: "thread"; id: string; line: number }
  | { kind: "day"; date: string }
  | { kind: "check"; check: string }
  | { kind: "archive"; path: string }
  | null;
export type SpineState = {
  repo: string; setRepo(r: string): void; options: { label: string; path: string }[]; result: SpineRead | null; error: string | null; busy: boolean; refresh(): void;
  /** Extra (not in the leader's contract): false until the project list has been read once. */
  resolved: boolean;
};

type RepoChoice = { label: string; path: string };
const STORE = "osiris-spine-repos", MAX_RECENT = 8;
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function loadStore(): { last: string; recent: string[] } {
  try { const v = JSON.parse(localStorage.getItem(STORE) ?? "null"); if (v && typeof v.last === "string" && Array.isArray(v.recent)) return { last: v.last, recent: v.recent.filter((x: unknown) => typeof x === "string").slice(0, MAX_RECENT) }; } catch {}
  return { last: "", recent: [] };
}
function saveStore(last: string, recent: string[]) { try { localStorage.setItem(STORE, JSON.stringify({ last, recent: [last, ...recent.filter(r => r !== last)].slice(0, MAX_RECENT) })); } catch {} }
const abs = (p: string) => p.startsWith("/") && !p.includes("\0");
const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
/** "hot-state-size" -> "Hot state size": operator words for a check slug, nothing invented. */
const checkName = (c: string) => { const s = c.replace(/[-_]+/g, " ").trim(); return s ? s[0].toUpperCase() + s.slice(1) : c; };

/** Owns the spine rpc call, the project list, recents and the default-repo rules. Read-only: never writes or generates spine files. */
export function useSpine(enabled = true): SpineState {
  const rpc = useRpc<typeof rpcContract>(), sdk = useSdk();
  const [projects, setProjects] = useState<RepoChoice[]>([]), [store, setStore] = useState(loadStore), [repo, setRepoState] = useState(""), [resolved, setResolved] = useState(false);
  const [result, setResult] = useState<SpineRead | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const generation = useRef(0), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      let choices: RepoChoice[] = [];
      try {
        if (demoOn()) throw new Error("demo");
        const list = (await sdk.projects.list({})) as unknown as { name?: string; sources?: { type?: string; path?: string }[] }[];
        choices = (Array.isArray(list) ? list : []).flatMap(p => (p.sources ?? []).filter(s => s.type === "local_path" && typeof s.path === "string" && abs(s.path)).slice(0, 1).map(s => ({ label: p.name ?? s.path!, path: s.path! })));
      } catch {}
      if (cancelled) return;
      if (demoOn()) choices = [{ label: "demo-repo", path: DEMO_REPO }];
      setProjects(choices);
      const saved = demoOn() ? "" : loadStore().last;
      setRepoState(saved || choices[0]?.path || "");
      setResolved(true);
    })();
    return () => { cancelled = true; };
  }, [sdk, enabled]);
  const refreshNow = useCallback(async () => {
    if (!repo) return;
    const gen = ++generation.current;
    setBusy(true);
    try {
      const r = (await rpc.call("spineIndex", { repo })) as SpineRead;
      if (alive.current && gen === generation.current) { setResult(r); setError(null); }
    } catch (e) { if (alive.current && gen === generation.current) { setResult(null); setError(e instanceof Error ? e.message : String(e)); } }
    finally { if (alive.current && gen === generation.current) setBusy(false); }
  }, [rpc, repo]);
  useEffect(() => { if (!enabled) return; setResult(null); void refreshNow(); }, [refreshNow, enabled]);
  const setRepo = useCallback((path: string) => { if (!abs(path)) return; if (demoOn()) { setRepoState(path); return; } saveStore(path, store.recent); setStore(loadStore()); setRepoState(path); }, [store]);
  const options = useMemo(() => { const seen = new Set<string>(); return [...projects, ...store.recent.map(path => ({ label: baseName(path), path }))].filter(o => !seen.has(o.path) && !!seen.add(o.path)); }, [projects, store]);
  const refresh = useCallback(() => { void refreshNow(); }, [refreshNow]);
  return { repo, setRepo, options, result, error, busy, refresh, resolved };
}

/** ONE line of context: `◇ my-repo  main @ fb431f06  2h ago  ↻`. Selection and the absolute-path input live in the menu. */
export function SpineRepoLine({ spine }: { spine: SpineState }) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false), [manual, setManual] = useState(""), [pinErr, setPinErr] = useState<string | null>(null), box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  const ok = spine.result && spine.result.state === "ok" ? spine.result : null;
  const idx = ok?.index;
  const pick = (p: string) => { spine.setRepo(p); setOpen(false); };
  return <div className="oi-sp-repo" ref={box}>
    <button type="button" className="oi-sp-repo-name" aria-expanded={open} aria-haspopup="menu" title={spine.repo || "Choose a repo"} onClick={() => setOpen(v => !v)}>◇ {spine.repo ? baseName(spine.repo) : spine.resolved ? "Choose a repo" : "Loading projects"}</button>
    {idx && <span className="oi-sp-repo-meta" title={`generated ${idx.generatedAt}`}>{idx.repo.branch} @ {idx.repo.head.slice(0, 8)}{idx.generatedAt && ` · ${relativeTime(idx.generatedAt, Date.now())}`}{ok && ok.dropped > 0 && <span className="oi-sp-warn"> · {ok.dropped} malformed rows dropped</span>}</span>}
    {!idx && spine.repo && <span className="oi-sp-repo-meta">{spine.error ? "error" : !spine.result ? "loading" : spine.result.state === "missing" ? "no spine index" : "invalid spine index"}</span>}
    <button type="button" className="oi-sp-icon" aria-label="Refresh spine index" title="Refresh" disabled={!spine.repo || spine.busy} onClick={spine.refresh}>{spine.busy ? "…" : "↻"}</button>
    {open && <div className="oi-sp-menu" role="menu">
      {spine.options.map(o => <button key={o.path} type="button" role="menuitem" className={o.path === spine.repo ? "sel" : undefined} onClick={() => pick(o.path)}><b>{o.label}</b> <small>{o.path}</small></button>)}
      {spine.options.length === 0 && <p className="oi-sp-note">No BB project found.</p>}
      <form onSubmit={e => { e.preventDefault(); const p = manual.trim(); if (!abs(p)) return; void pinRepoVia(rpc as unknown as CallLike, p).then(r => { if (r.ok) { pick(r.path); setManual(""); setPinErr(null); } else setPinErr(r.reason); }); }}><input value={manual} onChange={e => { setManual(e.target.value); setPinErr(null); }} placeholder="Absolute repo path" aria-label="Manual repo path" /><button type="submit" disabled={!abs(manual.trim())}>Use</button></form>
      {pinErr && <p className="oi-sp-note" role="alert">{pinErr}</p>}
    </div>}
  </div>;
}

/** A thread id that cites the same ADR; selects that thread when the host wires it, else a plain chip. */
function ThreadLink({ t, onSelect }: { t: SpineThread; onSelect?: (t: SpineThread) => void }) {
  return <button type="button" className="oi-sp-chip link" disabled={!onSelect} title={`${t.id} also cites this decision: ${t.title}`} onClick={() => onSelect?.(t)}>{t.id}</button>;
}

function AdrChip({ adr }: { adr: AdrLink }) {
  const label = `${adr.id} ${adr.title}`;
  if (adr.where === "vault" && isSafeObsidianOpenUrl(adr.obsidianUrl)) return <a className="oi-sp-chip link" href={adr.obsidianUrl} rel="noreferrer noopener" title={adr.path}>{label}</a>;
  return <span className="oi-sp-chip" title={adr.path}>{label}{adr.where === "repo" ? ` · ${adr.path}` : ""}</span>;
}

type WorkFilter = "all" | "emergency" | "active" | "debt" | "cold";
type OnSelect = (s: SpineSelection) => void;
const isDecision = (a: AdrLink) => a.id.startsWith("D-");
const sameThread = (t: SpineThread, s: SpineSelection) => s?.kind === "thread" && s.id === t.id && s.line === t.line;

function ThreadRow({ t, selection, onSelect }: { t: SpineThread; selection: SpineSelection; onSelect: OnSelect }) {
  const sel = sameThread(t, selection);
  return <button type="button" className={`oi-sp-row${sel ? " sel" : ""}`} aria-pressed={sel} onClick={() => onSelect({ kind: "thread", id: t.id, line: t.line })}>
    <b>{t.id}</b><span className="t">{displayTitle(t.id, t.title)}</span>{t.adrs.length > 0 && <small>ADR {t.adrs.length}</small>}
  </button>;
}
function EmergencyCard({ t, selection, onSelect }: { t: SpineThread; selection: SpineSelection; onSelect: OnSelect }) {
  const sel = sameThread(t, selection), adrs = t.adrs.filter(a => !isDecision(a)), decisions = t.adrs.filter(isDecision), headline = decisions[0] ?? adrs[0];
  return <button type="button" className={`oi-sp-card${sel ? " sel" : ""}`} aria-pressed={sel} onClick={() => onSelect({ kind: "thread", id: t.id, line: t.line })}>
    <span className="h"><b>{t.id}</b><span className="t">{displayTitle(t.id, t.title)}</span></span>
    <span className="oi-sp-state fail">{STATUS_LABEL.emergency}</span>
    <span className="oi-sp-kv"><span>ADR {adrs.length || "—"}</span><span>Decisions {decisions.length || "—"}</span></span>
    {headline && <span className="oi-sp-headline">{headline.id} · {headline.title}</span>}
  </button>;
}
function WorkView({ index, selection, onSelect }: { index: SpineIndex; selection: SpineSelection; onSelect: OnSelect }) {
  const [filter, setFilter] = useState<WorkFilter>("all");
  const c = threadCounts(index), groups = groupThreads(index.threads);
  const show = (status: ThreadStatus) => filter === "all" || (filter === "emergency" ? status === "emergency" : filter === "active" ? status === "active" : filter === "debt" ? status === "debt" : status !== "emergency" && status !== "active" && status !== "debt");
  if (!c.total) return <p className="oi-sp-note">No workstreams in the index.</p>;
  const fb = (f: WorkFilter, label: string, n: number) => <button type="button" title={filter === f ? "Show all workstreams" : `Show only ${label.toLowerCase()}`} className={`oi-sp-count${filter === f ? " on" : ""}${f === "debt" && n > 0 ? " attn" : ""}${f === "emergency" && n > 0 ? " fail" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(cur => (cur === f ? "all" : f))}>{label} <b>{n}</b></button>;
  return <div className="oi-sp-work">
    <div className="oi-sp-counts"><span className="oi-sp-title">WORK <b>{c.total}</b></span>{fb("emergency", "Emergency", c.emergency)}{fb("active", "Active", c.active)}{fb("debt", "Tech debt", c.debt)}{fb("cold", "Cold", c.cold)}</div>
    {!groups.some(g => show(g.status) && g.threads.length > 0) && <p className="oi-sp-note">No workstreams in this group.</p>}
    {groups.filter(g => show(g.status)).map(g => g.status === "emergency"
      ? <section key={g.status}><h3 className="oi-sp-h fail">{STATUS_LABEL[g.status]} <i>{g.threads.length}</i></h3>{g.threads.map(t => <EmergencyCard key={`${t.id}:${t.line}`} t={t} selection={selection} onSelect={onSelect} />)}</section>
      : g.status === "done"
        ? <details key={g.status} className="oi-sp-fold"><summary className="oi-sp-h">{STATUS_LABEL[g.status]} <i>{g.threads.length}</i></summary>{g.threads.map(t => <ThreadRow key={`${t.id}:${t.line}`} t={t} selection={selection} onSelect={onSelect} />)}</details>
        : <section key={g.status}><h3 className="oi-sp-h">{STATUS_LABEL[g.status]} <i>{g.threads.length}</i></h3>{g.threads.map(t => <ThreadRow key={`${t.id}:${t.line}`} t={t} selection={selection} onSelect={onSelect} />)}</section>)}
  </div>;
}

/** Kind filter shared by the month grid (canvas) and the day inspector (right pane): they are siblings, so it lives in a tiny module store, not in storage. */
let kindFilter: KindFilter = "all";
const kindSubs = new Set<() => void>();
const setKindFilter = (f: KindFilter) => { kindFilter = f; kindSubs.forEach(fn => fn()); };
const subscribeKind = (fn: () => void) => { kindSubs.add(fn); return () => { kindSubs.delete(fn); }; };
const useKindFilter = () => useSyncExternalStore(subscribeKind, () => kindFilter, () => "all" as KindFilter);
const kindStyle = (token: string) => ({ "--k": `var(${token})` }) as CSSProperties;

function KindPill({ kind, text }: { kind: Parameters<typeof kindDef>[0]; text: string }) {
  const d = kindDef(kind);
  return <span className="oi-sp-pill" data-kind={kind} style={kindStyle(d.token)}><i aria-hidden="true">{d.glyph}</i>{text}</span>;
}

function KindTabs({ totals, filter, spendText }: { totals: ReturnType<typeof countKinds>; filter: KindFilter; /** the month's spend for the Spend tab; undefined hides the tab (no telemetry yet) */ spendText?: string }) {
  const tabs: { id: KindFilter; label: string; token?: string; glyph?: string }[] = [{ id: "all", label: "All" }, ...CALENDAR_KINDS.filter(k => k.kind !== "spend" || spendText !== undefined).map(k => ({ id: k.kind as KindFilter, label: k.label[0].toUpperCase() + k.label.slice(1), token: k.token, glyph: k.glyph }))];
  const move = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number) => {
    let n = i;
    if (e.key === "ArrowRight") n = (i + 1) % tabs.length; else if (e.key === "ArrowLeft") n = (i + tabs.length - 1) % tabs.length; else if (e.key === "Home") n = 0; else if (e.key === "End") n = tabs.length - 1; else return;
    e.preventDefault(); setKindFilter(tabs[n].id); (e.currentTarget.parentElement?.children[n] as HTMLButtonElement | undefined)?.focus();
  };
  return <div className="oi-sp-ktabs" role="tablist" aria-label="Filter calendar by kind">{tabs.map((t, i) =>
    <button key={t.id} type="button" role="tab" aria-selected={filter === t.id} tabIndex={filter === t.id ? 0 : -1} className="oi-sp-ktab" data-kind={t.id} style={t.token ? kindStyle(t.token) : undefined} onClick={() => setKindFilter(t.id)} onKeyDown={e => move(e, i)}>
      {t.glyph && <i aria-hidden="true">{t.glyph}</i>}{t.label}<b>{t.id === "spend" ? spendText : filterTotal(totals, t.id)}</b></button>)}</div>;
}

/** Spend under the tabs, in the view's own scale: Month = total + daily sparkline, Week = a bar per day, Day = the hourly strip. Honest labels beside it. */
function SpendStrip({ ix, view, month, week, day }: { ix: SpendIndex; view: CalView; month: YearMonth; week: string[]; day: string }) {
  if (view === "month") {
    const m = monthSpend(ix, month.year, month.month0), max = Math.max(0, ...m.bars.map(b => b.pricedUsd));
    return <div className="oi-sp-spend" data-view="month"><b className="oi-sp-spend-t">{monthLabel(month)}{m.text ? ` · ${m.text}` : ""}</b>
      <span className="oi-sp-spark" role="img" aria-label={`Daily spend, ${monthLabel(month)}`}>{m.bars.map(b => <i key={b.date} data-status={b.status} title={`${b.date} · ${spendTitle(ix, b.date)}`} style={{ height: `${b.status === "spent" ? Math.max(8, max > 0 ? (b.pricedUsd / max) * 100 : 8) : 8}%` }} />)}</span>
      <small>{m.note}</small></div>;
  }
  if (view === "week") {
    const w = weekSpend(ix, week);
    return <div className="oi-sp-spend" data-view="week"><b className="oi-sp-spend-t">Week{w.text ? ` · ${w.text}` : ""}</b>
      <span className="oi-sp-wbars">{w.days.map(d => <span key={d.date} className="oi-sp-wbar" data-status={d.status} title={d.label}><i style={{ height: `${d.status === "spent" ? Math.max(6, d.ratio * 100) : 6}%` }} /><small>{d.date.slice(8)}</small><em>{d.status === "spent" ? spendChipText({ usd: d.usd, tokens: d.tokens }) : d.status === "not-captured" ? "not captured" : "—"}</em></span>)}</span>
      <small>{w.note}</small></div>;
  }
  const h = hourStrip(ix, day);
  return <div className="oi-sp-spend" data-view="day"><b className="oi-sp-spend-t">{day}{h.text ? ` · ${h.text}` : ""}</b>
    <span className="oi-sp-hours" role="img" aria-label={`Hourly spend, ${day}`}>{h.hours.map(x => <i key={x.hour} title={`${String(x.hour).padStart(2, "0")}:00 · ${spendChipText({ usd: x.pricedUsd, tokens: x.tokens })}`} style={{ height: `${Math.max(x.ratio * 100, h.status === "spent" ? 4 : 0)}%` }} />)}</span>
    <span className="oi-sp-hour-ticks" aria-hidden="true"><small>00</small><small>06</small><small>12</small><small>18</small><small>23</small></span>
    <small>{h.note}</small></div>;
}

type CalView = "month" | "week" | "day";
const CAL_MODES_UI = ["lite", "full"] as const;
function CalendarView({ events, selection, onSelect, summary, detail, graphStrip, spend }: { events: SpineEvent[]; selection: SpineSelection; onSelect: OnSelect; summary?: ReactNode; detail?: ReactNode; graphStrip?(dates: string[]): ReactNode; spend?: SpendIndex | null }) {
  const byDay = useMemo(() => eventsByDay(events), [events]);
  const today = localDayKey(), newest = newestEventDate(events);
  const [month, setMonth] = useState<YearMonth>(() => monthOf(newest ?? today) ?? monthOf(today)!);
  const [view, setView] = useState<CalView>("month");
  const [mode, setModeState] = useState<CalMode>(() => loadCalMode());
  const setMode = (m: CalMode) => { setModeState(m); saveCalMode(m); };
  const lite = mode === "lite";
  const filter = useKindFilter();
  if (!events.length) return <p className="oi-sp-note">No completed-work events in the index.</p>;
  const selected = selection?.kind === "day" ? selection.date : null;
  const totals = monthKindTotals(events, month.year, month.month0);
  const showSpend = !!spend && (filter === "all" || filter === "spend");
  const eventsOf = (key: string) => (byDay.get(key) ?? []).filter(e => filter === "all" || e.kind === filter);
  const maxDay = Math.max(1, ...[...byDay.keys()].filter(k => k.startsWith(`${month.year}-${String(month.month0 + 1).padStart(2, "0")}`)).map(k => eventsOf(k).length));
  // FULL: the previous calendar's cell, which carries the day's own kind chips ("113 commits", "4 log", "+1") and a heat tint.
  const fullCell = (key: string, label: number | string) => {
    const list = eventsOf(key), n = list.length, sel = key === selected;
    const sp = showSpend && spend && spendStatus(spend, key) === "spent" ? spend.byDate.get(key)! : null;
    const level = filter === "spend" ? (spend ? spendLevel(spend, key, monthDates(month.year, month.month0)) : 0) : n === 0 ? 0 : n > maxDay * 0.66 ? 3 : n > maxDay * 0.33 ? 2 : 1;
    const { shown, more } = pillsForDay(countKinds(list), "all", 2);
    return <button key={key} type="button" className={`oi-sp-day d${level}${key === today ? " today" : ""}${sel ? " sel" : ""}`} aria-pressed={sel} aria-label={`${key}${n ? `, ${n} events` : ""}${sp ? `, ${spendTitle(spend!, key)}` : ""}`} onClick={() => onSelect(sel ? null : { kind: "day", date: key })}>
      <span className="n">{label}</span>
      <span className="pills">{shown.map(p => <KindPill key={p.kind} kind={p.kind} text={p.label} />)}{more > 0 && <span className="oi-sp-more-n">+{more}</span>}{sp && <KindPill kind="spend" text={spendChipText(sp)} />}</span>
    </button>;
  };
  const cell = (key: string, label: number | string) => {
    if (!lite) return fullCell(key, label);
    const counts = countKinds(eventsOf(key)), dots = dotsForDay(counts), commits = counts.commit ?? 0, sel = key === selected;
    const sp = showSpend && spend && spendStatus(spend, key) === "spent" ? spendLevel(spend, key, monthDates(month.year, month.month0)) : 0;
    return <button key={key} type="button" className={`mk-d${sel ? " sel" : ""}${key === today ? " today" : ""}`} aria-pressed={sel} aria-label={`${key}${dots.length ? `, ${dots.map(d => d.title).join(", ")}` : ""}${sp ? `, ${spendTitle(spend!, key)}` : ""}`} onClick={() => onSelect(key === selected ? null : { kind: "day", date: key })}>
      <span>{label}</span>
      <span className="dots">{dots.map(d => <i key={d.kind} data-kind={d.kind} title={d.title} style={{ ["--c" as string]: `var(${d.token})` }} />)}{sp > 0 && <i data-kind="spend" data-level={sp} title={spendTitle(spend!, key)} style={{ ["--c" as string]: `var(${kindDef("spend").token})` }} />}</span>
      {sel && commits > 0 && <span className="mk-note" style={{ fontSize: 10 }}>{kindLabel("commit", commits)}</span>}
    </button>;
  };
  const cells = monthCells(month.year, month.month0);
  const anchor = selected ?? (month.year === monthOf(today)!.year && month.month0 === monthOf(today)!.month0 ? today : dayKey(month.year, month.month0, 1));
  const week = view === "week" ? weekOf(anchor) : [];
  return <div className="oi-sp-cal">
    <div className="mk-ctabs" role="tablist" aria-label="Calendar view">
      {(["month", "week", "day"] as const).map(v => <button key={v} type="button" role="tab" className="mk-ct" aria-selected={view === v} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>)}
      <span className="mk-end"><span className="mk-mode" role="group" aria-label="Calendar detail">{CAL_MODES_UI.map(m => <button key={m} type="button" className="mk-tbtn" data-mode={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{m === "lite" ? "Lite" : "Full"}</button>)}</span>{!lite && <b className="oi-sp-month">{monthLabel(month)}</b>}{!lite && selected && <button type="button" className="oi-sp-clear" title="Show every day again" onClick={() => onSelect(null)}>× All days</button>}<button type="button" className="mk-tbtn" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button><button type="button" className="mk-tbtn" onClick={() => { setMonth(monthOf(today)!); onSelect({ kind: "day", date: today }); }}>Today</button><button type="button" className="mk-tbtn" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>›</button></span>
    </div>
    <div className="mk-cbody">
      {!lite && <KindTabs totals={totals} filter={filter} spendText={spend ? (monthSpend(spend, month.year, month.month0).text || "—") : undefined} />}
      {showSpend && <SpendStrip ix={spend!} view={view} month={month} week={weekOf(anchor)} day={anchor} />}
      {view !== "day" && !lite && <><div className="oi-sp-wd">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(x => <span key={x}>{x}</span>)}</div>
        <div className="oi-sp-grid oi-sp-fullgrid" style={{ gridTemplateRows: `repeat(${view === "week" ? 1 : Math.ceil(cells.length / 7)},minmax(64px,1fr))` }}>
          {view === "month" ? cells.map((d, i) => d === null ? <span key={`b${i}`} className="oi-sp-blank" /> : fullCell(dayKey(month.year, month.month0, d), d)) : week.map(k => fullCell(k, Number(k.slice(8))))}</div></>}
      {view !== "day" && lite && <div className={`mk-cal${view === "week" ? " week" : ""}`}>
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(x => <div key={x} className="dw">{x}</div>)}
        {view === "month" ? cells.map((d, i) => d === null ? <div key={`b${i}`} className="mk-d o" /> : cell(dayKey(month.year, month.month0, d), d))
          : week.map(k => cell(k, Number(k.slice(8))))}
      </div>}
      {!lite && graphStrip?.(view === "week" ? week : selected ? [selected] : [])}
      {(lite ? summary : detail ?? summary) ?? (selected ? null : <p className="mk-note" style={{ marginTop: 14 }}>Select a day to see what happened.</p>)}
    </div>
  </div>;
}

function HealthItem({ h, selection, onSelect }: { h: SpineHealth; selection: SpineSelection; onSelect: OnSelect }) {
  const bar = healthBar(h), sel = selection?.kind === "check" && selection.check === h.check;
  return <button type="button" className={`oi-sp-hitem ${h.status}${sel ? " sel" : ""}`} aria-pressed={sel} onClick={() => onSelect({ kind: "check", check: h.check })}>
    <span className="h"><b>{checkName(h.check)}</b><span className="m">{(h.status !== "pass" && healthFigure(h)) || h.measured || "—"}</span></span>
    {h.detail && <span className="d">{h.detail}</span>}
    {bar ? <span className="oi-sp-bar" role="img" aria-label={`${bar.value.toLocaleString("en-US")} against a limit of ${bar.limit.toLocaleString("en-US")}`}><span style={{ width: `${Math.min(100, Math.max(0, bar.ratio * 100))}%` }} /><small>{bar.ratio >= 1.5 ? `${bar.ratio >= 10 ? Math.round(bar.ratio) : bar.ratio.toFixed(1)}× limit` : `${Math.round(bar.ratio * 100)}% of limit`}</small></span> : null}
  </button>;
}
function HealthView({ index, selection, onSelect }: { index: SpineIndex; selection: SpineSelection; onSelect: OnSelect }) {
  const s = healthSummary(index.health), g = sortHealth(index);
  if (!index.health.length) return <p className="oi-sp-note">No health checks in the index.</p>;
  return <div className="oi-sp-health">
    <div className="oi-sp-hero"><span className="pass"><b>{s.pass}</b> PASS</span><span className="warn"><b>{s.warn}</b> WARN</span><span className="fail"><b>{s.fail}</b> FAIL</span></div>
    {g.fail.length > 0 && <section><h3 className="oi-sp-h fail">Fail <i>{g.fail.length}</i></h3>{g.fail.map(h => <HealthItem key={h.check} h={h} selection={selection} onSelect={onSelect} />)}</section>}
    {g.warn.length > 0 && <section><h3 className="oi-sp-h warn">Warnings <i>{g.warn.length}</i></h3>{g.warn.map(h => <HealthItem key={h.check} h={h} selection={selection} onSelect={onSelect} />)}</section>}
    {g.pass.length > 0 && <section><h3 className="oi-sp-h">Passing <i>{g.pass.length}</i></h3>{g.pass.map(h => <button key={h.check} type="button" className={`oi-sp-row${selection?.kind === "check" && selection.check === h.check ? " sel" : ""}`} onClick={() => onSelect({ kind: "check", check: h.check })}><span className="ok">✓</span><span className="t">{checkName(h.check)}</span><small>{h.measured}</small></button>)}</section>}
  </div>;
}

type ArchiveFile = ReturnType<typeof archiveByMonth>[number]["files"][number];
function ArchiveFileView({ file, selection, onSelect }: { file: ArchiveFile; selection: SpineSelection; onSelect: OnSelect }) {
  const [all, setAll] = useState(false), LIMIT = 30, list = all ? file.threads : file.threads.slice(0, LIMIT);
  const sel = selection?.kind === "archive" && selection.path === file.path;
  return <div className="oi-sp-file">
    <button type="button" className={`oi-sp-row${sel ? " sel" : ""}`} aria-pressed={sel} onClick={() => onSelect({ kind: "archive", path: file.path })}><b>{file.period || "—"}</b><span className="t">{baseName(file.path)}</span><small>{file.threads.length}</small></button>
    {list.map(t => <div key={t.id} className="oi-sp-line"><b>{t.id}</b>{t.title && <span className="t">{displayTitle(t.id, t.title)}</span>}</div>)}
    {file.threads.length > LIMIT && <button type="button" className="oi-sp-more" onClick={() => setAll(v => !v)}>{all ? "Show fewer" : `+${file.threads.length - LIMIT} more`}</button>}
  </div>;
}
/** Read-only extra for the Archive canvas: closed beads from the bd snapshot (work/archived-beads.ts), shown ABOVE the spine's months. `filtered` is the vault's id count (a chip + clear) or null for every archived bead. */
export type ArchiveBeads = { rows: readonly ArchivedBeadRow[]; filtered: number | null; onClear(): void; onSelect(id: string): void; /** Why the beads cannot be listed (no tracker snapshot yet / read error). Shown as "Archive unavailable" with this as its detail. */ unavailable?: string };
function ArchivedBeadsSection({ beads }: { beads: ArchiveBeads }) {
  const [all, setAll] = useState(false), detailId = useId(), LIMIT = 40, list = all ? beads.rows : beads.rows.slice(0, LIMIT);
  if (beads.unavailable !== undefined) return <section className="oi-sp-beads" aria-label="Archived beads"><p className="oi-sp-note" role="status" aria-describedby={detailId} title={beads.unavailable}>Archive unavailable</p><span id={detailId} hidden>{beads.unavailable}</span></section>;
  return <section className="oi-sp-beads" aria-label="Archived beads">
    <h3 className="oi-sp-h">Archived beads <i>{beads.rows.length}</i>{beads.filtered !== null && <button type="button" className="oi-sp-clear" title="Show every archived bead again" onClick={beads.onClear}>{beads.filtered} archived · ✕ clear</button>}</h3>
    {beads.rows.length === 0 ? <p className="oi-sp-note">No archived beads.</p> : list.map(r => <button key={r.id} type="button" className="oi-sp-row" title={r.title} onClick={() => beads.onSelect(r.id)}><b>#{r.shortId}</b><span className="t">{r.title}</span><small>{r.at === null ? "—" : new Date(r.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}{r.from ? ` · from ${r.from}` : ""}</small></button>)}
    {beads.rows.length > LIMIT && <button type="button" className="oi-sp-more" onClick={() => setAll(v => !v)}>{all ? "Show fewer" : `+${beads.rows.length - LIMIT} more`}</button>}
  </section>;
}
function ArchiveView({ index, selection, onSelect }: { index: SpineIndex; selection: SpineSelection; onSelect: OnSelect }) {
  const months = archiveByMonth(index), total = months.reduce((n, m) => n + m.count, 0);
  return <div className="oi-sp-archive">
    {!months.length ? <p className="oi-sp-note">No archived files in the index.</p> : <>
      <div className="oi-sp-counts"><span className="oi-sp-title">ARCHIVE <b>{total}</b> workstreams</span></div>
      {months.map(m => <section key={m.month}><h3 className="oi-sp-h">{m.month} <i>{m.count}</i></h3>{m.files.map(f => <ArchiveFileView key={f.path} file={f} selection={selection} onSelect={onSelect} />)}</section>)}
    </>}
  </div>;
}

/** Centre canvas: the repo line plus the section view. Missing/invalid are one clear instruction, never a fake board. */
/** `health`, when given, replaces the legacy Health view and renders even without an index (repo facts still apply). */
export function SpineCanvas({ spine, section, selection, onSelect, health, beads, daySummary, dayDetail, graphStrip, spend }: { spine: SpineState; section: SpineSection; selection: SpineSelection; onSelect(s: SpineSelection): void; health?: ReactNode; beads?: ArchiveBeads; daySummary?: ReactNode; dayDetail?: ReactNode; graphStrip?(dates: string[]): ReactNode; spend?: SpendIndex | null }) {
  const r = spine.result;
  return <div className="oi-sp">
    <SpineRepoLine spine={spine} />
    {section === "archive" && beads && spine.repo && <ArchivedBeadsSection beads={beads} />}
    {!spine.repo ? <p className="oi-sp-note">{spine.resolved ? "No BB project found. Open the repo menu above and enter an absolute repo path." : "Loading projects."}</p>
      : section === "health" && health ? <div className="oi-sp-body">{health}</div>
      : spine.error ? <p className="oi-sp-err" role="alert">{spine.error}</p>
      : !r ? <p className="oi-sp-note">Loading spine index.</p>
      : r.state === "missing" ? <div className="oi-sp-note"><p>No spine index found. {r.hint}</p><p className="oi-sp-path">Looked at {r.path}</p></div>
      : r.state === "invalid" ? <div className="oi-sp-err" role="alert"><p>Spine index could not be used: {r.reason}</p>{r.path && <p className="oi-sp-path">{r.path}</p>}</div>
      : <div className="oi-sp-body" key={`${r.path}:${section}`}>
        {section === "work" && <WorkView index={r.index} selection={selection} onSelect={onSelect} />}
        {section === "calendar" && <CalendarView events={r.index.calendar} selection={selection} onSelect={onSelect} summary={daySummary} detail={dayDetail} graphStrip={graphStrip} spend={spend} />}
        {section === "health" && <HealthView index={r.index} selection={selection} onSelect={onSelect} />}
        {section === "archive" && <ArchiveView index={r.index} selection={selection} onSelect={onSelect} />}
      </div>}
  </div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <div className="oi-sp-field"><dt>{label}</dt><dd>{children}</dd></div>; }
/** sha -> bead ids (from the day's commits' Refs trailers, via the ONE extractor commitRefs); the Calendar events themselves carry no trailers. */
export type DayBeads = ReadonlyMap<string, readonly string[]>;
export const beadsBySha = (commits: readonly { sha: string; subject?: string; trailers?: Parameters<typeof commitBeads>[0]["trailers"] }[]): DayBeads => new Map(commits.map(c => [c.sha, commitBeads(c)] as const));
type DayHandlers = { onOpenCommit?: (sha: string) => void; onOpenDoc?: (ev: SpineEvent) => void; beads?: DayBeads; citedBy?: (e: SpineEvent) => SpineThread[]; onOpenThread?: (id: string) => void; onOpenBead?: (id: string) => void };
function DayRow({ e, onOpenCommit, onOpenDoc, beads, citedBy, onOpenThread, onOpenBead }: { e: SpineEvent } & DayHandlers) {
  const bead = e.kind === "commit" ? beads?.get(e.ref) ?? [...(beads ?? [])].find(([sha]) => sha.startsWith(e.ref) || e.ref.startsWith(sha))?.[1] : undefined;
  const cites = e.kind === "decision" ? (citedBy?.(e) ?? []).filter(t => !e.threadIds.includes(t.id)) : [];
  const main = <><span className="t">{e.title}</span>{e.kind === "commit" && <small className="mono" title={e.ref}>{shortSha(e.ref)}</small>}</>;
  // Thread and bead ids are their own buttons (siblings of the row's action, never nested inside it): thread -> the thread inspector, bead -> the bead inspector.
  const links = <>{bead?.map(b => <button key={b} type="button" className="oi-sp-idlink mono oi-sp-bead" disabled={!onOpenBead} title={`Open bead ${b}`} onClick={() => onOpenBead?.(b)}>{b}</button>)}{[...e.threadIds, ...cites.map(t => t.id)].map(id => <button key={id} type="button" className="oi-sp-idlink" disabled={!onOpenThread} title={`Open ${id}`} onClick={() => onOpenThread?.(id)}>{id}</button>)}{e.source === "cold" && <small>archived</small>}</>;
  // Commit rows open the commit, decision and log rows open the doc section; thread-done rows have no target in this pane, so they stay plain text.
  const act = e.kind === "commit" ? () => onOpenCommit?.(e.ref) : e.kind === "decision" || e.kind === "log" ? () => onOpenDoc?.(e) : null;
  const enabled = e.kind === "commit" ? !!onOpenCommit : !!onOpenDoc;
  return <div className="oi-sp-line oi-sp-rowwrap">{act ? <button type="button" className="oi-sp-act" disabled={!enabled} onClick={act}>{main}</button> : <span className="oi-sp-plain">{main}</span>}{links}</div>;
}
function DayEvents({ events, filter, onOpenCommit, onOpenDoc, beads, citedBy, onOpenThread, onOpenBead }: { events: SpineEvent[]; filter: KindFilter } & DayHandlers) {
  const [open, setOpen] = useState<Record<string, boolean>>({}), SHOW = 8;
  return <>{CALENDAR_KINDS.filter(k => filter === "all" || k.kind === filter).map(k => {
    const list = events.filter(e => e.kind === k.kind);
    if (!list.length) return null;
    const shown = open[k.kind] ? list : list.slice(0, SHOW);
    return <section key={k.kind}><h3 className="oi-sp-h" style={kindStyle(k.token)}><i className="oi-sp-glyph" aria-hidden="true">{k.glyph}</i>{kindLabel(k.kind, list.length)}</h3>
      {shown.map((e, i) => <DayRow key={`${e.ref}:${i}`} e={e} onOpenCommit={onOpenCommit} onOpenDoc={onOpenDoc} beads={beads} citedBy={citedBy} onOpenThread={onOpenThread} onOpenBead={onOpenBead} />)}
      {list.length > SHOW && <button type="button" className="oi-sp-more" onClick={() => setOpen(o => ({ ...o, [k.kind]: !o[k.kind] }))}>{open[k.kind] ? "Show fewer" : `+${list.length - SHOW} more`}</button>}
    </section>;
  })}</>;
}

/** FULL calendar body under the grid: the day's log / decision / thread-done lists (kind filter applies) and the commits block (branch groups, bead chips, expandable files) passed in as `commits`. */
export function DayFullDetail({ events, commits, onOpenDoc, onOpenThread, onOpenBead }: { events: SpineEvent[]; commits: ReactNode } & Pick<DayHandlers, "onOpenDoc" | "onOpenThread" | "onOpenBead">) {
  const filter = useKindFilter();
  return <div className="mk-fulldetail"><DayEvents events={events.filter(e => e.kind !== "commit")} filter={filter} onOpenDoc={onOpenDoc} onOpenThread={onOpenThread} onOpenBead={onOpenBead} />{(filter === "all" || filter === "commit") && commits}</div>;
}

export type DocView = { state: "loading" | "ok" | "error"; section?: DocSection; error?: string; event: SpineEvent };
/** A doc section as plain wrapped text (never HTML), with the commits it names as buttons. */
function DocPanel({ doc, onBack, onOpenCommit }: { doc: DocView; onBack?: () => void; onOpenCommit?: (sha: string) => void }) {
  const s = doc.section;
  return <div className="oi-sp-insp">
    <button type="button" className="oi-sp-crumb" onClick={onBack} disabled={!onBack}>← Back to {doc.event.date}</button>
    <h2 className="oi-sp-ih">{doc.state === "ok" && s ? s.heading || doc.event.title : doc.event.title}</h2>
    {doc.state === "loading" ? <p className="oi-sp-note">Loading…</p>
      : doc.state === "error" || !s ? <p className="oi-sp-note oi-sp-err" role="alert">{doc.error || "Could not read this section."}</p>
      : <>
        <p className="oi-sp-path">{s.path}:{s.line}</p>
        <pre className="oi-sp-doc">{s.text}</pre>
        {s.truncated && <p className="oi-sp-note">Truncated: the section continues in the file.</p>}
        {s.shas.length > 0 && <section><h3 className="oi-sp-h">Commits named here<i>{s.shas.length}</i></h3>
          {s.shas.map(sha => <button key={sha} type="button" className="oi-sp-row oi-sp-mention" disabled={!onOpenCommit} onClick={() => onOpenCommit?.(sha)} title={sha}><small className="mono">{shortSha(sha)}</small></button>)}</section>}
      </>}
  </div>;
}

/** Right pane: depth for the selection; with no (matching) selection, a short section summary. */
export type ThreadMentions = { state: "idle" | "loading" | "ok" | "error"; commits: CommitMention[]; error?: string };

/** "Commits mentioning W-NNN": one muted line for idle/loading/empty/error, else a clickable list (subject, age, short sha, author). */
function MentionList({ id, mentions, onOpenCommit }: { id: string; mentions: ThreadMentions; onOpenCommit?: (sha: string) => void }) {
  const now = Date.now();
  return <section className="oi-sp-mentions"><h3 className="oi-sp-h">Commits mentioning {id}{mentions.state === "ok" && <i>{mentions.commits.length}</i>}</h3>
    {mentions.state === "idle" || mentions.state === "loading" ? <p className="oi-sp-note">Loading commits…</p>
      : mentions.state === "error" ? <p className="oi-sp-note oi-sp-err" role="alert">{mentions.error || "Could not read commits."}</p>
      : mentions.commits.length === 0 ? <p className="oi-sp-note">No commits mention {id}</p>
      : mentions.commits.map(c => <button key={c.sha} type="button" className="oi-sp-row oi-sp-mention" disabled={!onOpenCommit} onClick={() => onOpenCommit?.(c.sha)} title={`${c.sha}\n${c.subject}`}>
        <span className="t">{c.subject}</span><small>{relativeAge(c.committedAt, now)}</small><small className="mono">{shortSha(c.sha)}</small><small>{c.author}</small></button>)}
  </section>;
}

export function SpineInspector({ spine, section, selection, mentions, onOpenCommit, onOpenDoc, doc, onBackToDay, dayBeads, onSelectThread, onOpenThread, onOpenBead }: { spine: SpineState; section: SpineSection; selection: SpineSelection; mentions?: ThreadMentions; onOpenCommit?: (sha: string) => void; onOpenDoc?: (ev: SpineEvent) => void; doc?: DocView | null; onBackToDay?: () => void; dayBeads?: DayBeads; onSelectThread?: (t: SpineThread) => void; onOpenThread?: (id: string) => void; onOpenBead?: (id: string) => void }) {
  const filter = useKindFilter();
  const r = spine.result && spine.result.state === "ok" ? spine.result : null;
  if (!r) return <div className="oi-sp-insp"><p className="oi-sp-note">No spine index loaded.</p></div>;
  const index = r.index;
  if (section === "work" && selection?.kind === "thread") {
    const t = index.threads.find(x => x.id === selection.id && x.line === selection.line) ?? index.threads.find(x => x.id === selection.id);
    if (t) return <div className="oi-sp-insp"><h2 className="oi-sp-ih"><b>{t.id}</b> {displayTitle(t.id, t.title)}</h2><AskAgentButton ask={() => threadContext(t, index.calendar)} />
      <dl><Field label="Status">{STATUS_LABEL[t.status]}</Field><Field label="Source"><code>workstreams.md:{t.line}</code></Field>
        {(() => { const rows = workProjection(t, index.calendar), kept = rows.filter(f => f.value !== null), missing = rows.filter(f => f.value === null && f.label !== "Resume").map(f => f.label.toLowerCase()), mine = index.calendar.filter(e => e.threadIds.includes(t.id)), calN = mine.length, latest = mine.reduce<string | null>((m, e) => (m === null || e.date > m ? e.date : m), null); return <>{kept.map(f => <Field key={f.label} label={f.label}>{f.value}</Field>)}<Field label="Calendar entries">{calN ? `${calN}${latest ? ` · latest ${latest}` : ""}` : "—"}</Field>{missing.length > 0 && <Field label="Not recorded"><span className="oi-sp-absent">{missing.join(", ")} — the board does not carry these yet (W-195 receipts)</span></Field>}</>; })()}
        {(() => { const adrs = adrsOfThread(index, t), logs = logsOfThread(index, t.id); return <>
          {adrs.length > 0 && <Field label="Decisions / ADRs"><span className="oi-sp-chips">{adrs.map(a => <span key={a.id} className="oi-sp-adr"><AdrChip adr={a} />{threadsCitingAdr(index, a.id).filter(x => x.id !== t.id).map(x => <ThreadLink key={`${x.id}:${x.line}`} t={x} onSelect={onSelectThread} />)}</span>)}</span></Field>}
          {logs.length > 0 && <Field label="Logs"><span className="oi-sp-chips">{logs.slice(0, 12).map((e, i) => <button key={`${e.ref}:${i}`} type="button" className="oi-sp-chip link" disabled={!onOpenDoc} title={`${e.kind} ${e.date}: ${e.title}`} onClick={() => onOpenDoc?.(e)}>{e.date} {e.title}</button>)}{logs.length > 12 && <small>+{logs.length - 12} more</small>}</span></Field>}</>; })()}
        {t.refs.length > 0 && <Field label="Refs"><span className="oi-sp-chips">{t.refs.map(x => <code key={x}>{x}</code>)}</span></Field>}
        {(t.cold?.length ?? 0) > 0 && <Field label="Archived in"><span className="oi-sp-chips">{t.cold!.map(x => <code key={x}>{x}</code>)}</span></Field>}
      </dl>{mentions && <MentionList id={t.id} mentions={mentions} onOpenCommit={onOpenCommit} />}</div>;
  }
  if (section === "calendar" && selection?.kind === "day") {
    if (doc) return <DocPanel doc={doc} onBack={onBackToDay} onOpenCommit={onOpenCommit} />;
    const all = index.calendar.filter(e => e.date === selection.date), events = all.filter(e => filter === "all" || e.kind === filter);
    return <div className="oi-sp-insp"><h2 className="oi-sp-ih">{selection.date} <small>{events.length} events{events.length !== all.length ? ` of ${all.length}` : ""}</small></h2><AskAgentButton ask={() => dayContext({ date: selection.date, today: new Date().toLocaleDateString("en-CA"), commits: all.filter(e => e.kind === "commit").map(e => ({ sha: e.ref, subject: e.title })), events: all.filter(e => e.kind !== "commit"), threads: index.threads })} />{events.length === 0 ? <p className="oi-sp-note">{all.length ? "Nothing of this kind on this day." : "Nothing recorded."}</p> : <DayEvents key={selection.date} events={events} filter={filter} onOpenThread={onOpenThread} onOpenBead={onOpenBead} beads={dayBeads} citedBy={e => [...new Map(adrIdsIn(e.title).flatMap(id => threadsCitingAdr(index, id)).map(t => [t.id, t] as const)).values()]} onOpenCommit={onOpenCommit} onOpenDoc={onOpenDoc} />}</div>;
  }
  if (section === "health" && selection?.kind === "check") {
    const h = index.health.find(x => x.check === selection.check);
    if (h) { const bar = healthBar(h); return <div className="oi-sp-insp"><h2 className="oi-sp-ih">{checkName(h.check)} <span className={`oi-sp-state ${h.status}`}>{h.status.toUpperCase()}</span></h2><AskAgentButton ask={() => healthCheckContext(h)} />
      <dl><Field label="Check"><code>{h.check}</code></Field><Field label="Measured">{h.measured || "—"}</Field><Field label="Detail">{h.detail || "—"}</Field>{bar ? <Field label="Limit">{bar.value.toLocaleString("en-US")} of {bar.limit.toLocaleString("en-US")}{h.unit ? ` ${h.unit}` : ""} ({Math.round(bar.ratio * 100)}%)</Field> : h.limit === 0 ? <Field label="Limit">expected 0{h.unit ? ` ${h.unit}` : ""}</Field> : h.value === undefined ? <Field label="Limit"><span className="oi-sp-absent">— not a threshold check</span></Field> : <Field label="Limit"><span className="oi-sp-absent">— not set by the producer</span></Field>}</dl></div>; }
  }
  if (section === "archive" && selection?.kind === "archive") {
    const f = archiveByMonth(index).flatMap(m => m.files).find(x => x.path === selection.path);
    if (f) return <div className="oi-sp-insp"><h2 className="oi-sp-ih">{baseName(f.path)}</h2><dl><Field label="Path"><code>{f.path}</code></Field><Field label="Kind">{f.kind}</Field><Field label="Period">{f.period || "—"}</Field><Field label="Workstreams">{f.threads.length}</Field></dl></div>;
  }
  const c = threadCounts(index), hs = healthSummary(index.health);
  return <div className="oi-sp-insp">{section === "work" ? <p className="oi-sp-note">{c.total} workstreams · {c.emergency} emergency · {c.active} active · {c.cold} cold. Select one for its contract, decisions and source line.</p>
    : section === "calendar" ? <p className="oi-sp-note">{index.calendar.length} events, newest {newestEventDate(index.calendar) ?? "—"}. Select a day to see what happened.</p>
    : section === "health" ? <p className="oi-sp-note">{hs.pass} pass · {hs.warn} warn · {hs.fail} fail. Select a check for its full detail.</p>
    : <p className="oi-sp-note">{index.cold.length} archive files. Select one for its path and period.</p>}</div>;
}

/** Transitional composition (nav + canvas + inspector side by side) until the shell wires the pieces itself. */

export const spineViewStyles = `
.oi-sp-mention .mono{font-family:ui-monospace,monospace}.oi-sp-mention:disabled{cursor:default}

.oi-sp,.oi-sp-insp{display:flex;flex-direction:column;gap:6px;min-width:0;min-height:0;color:var(--oi-text);font-size:11px;padding:8px 12px;overflow:auto}.oi-sp{flex:1;height:100%}.oi-sp-insp{border-left:1px solid var(--oi-border)}
.oi-sp-body{display:flex;flex-direction:column;flex:1;min-height:0}
.oi-sp button,.oi-sp-insp button{font:inherit;color:inherit}
.oi-sp-repo{position:relative;display:flex;align-items:center;gap:10px;flex:none;color:var(--oi-tone-muted)}.oi-sp-repo-name{background:transparent;border:0;padding:2px 0;font-weight:600;color:var(--oi-text);cursor:pointer}.oi-sp-repo-name:hover{text-decoration:underline}.oi-sp-repo-meta{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.oi-sp-warn{color:var(--oi-tone-attention)}
.oi-sp-icon{background:transparent;border:0;cursor:pointer;padding:2px 6px;font-size:13px;color:var(--oi-tone-muted)}.oi-sp-icon:hover:not(:disabled){background:var(--oi-hover);color:var(--oi-text)}.oi-sp-icon:disabled{opacity:.5;cursor:default}
.oi-sp-menu{position:absolute;top:100%;left:0;z-index:5;min-width:300px;max-width:min(560px,90vw);display:flex;flex-direction:column;background:var(--oi-panel);border:1px solid var(--oi-border);padding:4px}.oi-sp-menu>button{display:flex;gap:8px;text-align:left;background:transparent;border:0;padding:4px 6px;cursor:pointer}.oi-sp-menu>button:hover{background:var(--oi-hover)}.oi-sp-menu>button.sel{background:var(--oi-selected)}.oi-sp-menu small{color:var(--oi-tone-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.oi-sp-menu form{display:flex;gap:4px;margin-top:4px}.oi-sp-menu input{flex:1;min-width:0;background:var(--oi-bg);color:var(--oi-text);border:1px solid var(--oi-border);padding:3px 5px;font-size:11px}.oi-sp-menu form button{background:transparent;border:1px solid var(--oi-border);padding:3px 8px;cursor:pointer}
.oi-sp-note{color:var(--oi-tone-muted);margin:4px 0}.oi-sp-err{color:var(--oi-tone-failure);margin:4px 0}.oi-sp-path{font-family:monospace;word-break:break-all}
.oi-sp-counts{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 14px;margin-bottom:4px}.oi-sp-title{font-weight:600;letter-spacing:.04em}.oi-sp-title b{font-size:15px}
.oi-sp-count.attn b{color:var(--oi-tone-attention)}.oi-sp-count.fail b{color:var(--oi-tone-failure)}.oi-sp-count{background:transparent;border:0;border-bottom:1px solid transparent;padding:1px 4px;border-radius:3px;cursor:pointer;color:var(--oi-tone-muted)}.oi-sp-count b{color:var(--oi-text)}.oi-sp-count:hover{background:var(--oi-hover);color:var(--oi-text)}.oi-sp-count.on{color:var(--oi-text);border-bottom-color:var(--oi-text)}
.oi-sp-h{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--oi-tone-muted);margin:10px 0 3px;font-weight:600}.oi-sp-h i{font-style:normal;margin-left:4px}.oi-sp-h.fail{color:var(--oi-tone-failure)}.oi-sp-h.warn{color:var(--oi-tone-attention)}.oi-sp-fold>summary{cursor:pointer}
.oi-sp-row{display:flex;gap:10px;align-items:baseline;width:100%;text-align:left;background:transparent;border:0;padding:2px 6px;cursor:pointer;min-width:0}.oi-sp-row:hover{background:var(--oi-hover)}.oi-sp-row.sel{background:var(--oi-selected)}.oi-sp-row b{flex:none;min-width:48px}.oi-sp-row .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.oi-sp-row small,.oi-sp-line small{flex:none;color:var(--oi-tone-muted)}.oi-sp-row .ok{color:var(--oi-tone-success);flex:none}
.oi-sp-card{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;background:transparent;border:1px solid var(--oi-tone-failure);padding:6px 8px;margin:3px 0;cursor:pointer}.oi-sp-card:hover{background:var(--oi-hover)}.oi-sp-card.sel{background:var(--oi-selected)}.oi-sp-card .h{display:flex;gap:10px}.oi-sp-card .t{flex:1;min-width:0}.oi-sp-kv{display:flex;flex-wrap:wrap;gap:2px 14px;color:var(--oi-tone-muted)}.oi-sp-headline{color:var(--oi-tone-muted)}.oi-sp-state{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}.oi-sp-state.fail{color:var(--oi-tone-failure)}.oi-sp-state.warn{color:var(--oi-tone-attention)}.oi-sp-state.pass{color:var(--oi-tone-success)}
.oi-sp-clear{margin-left:8px;padding:0 6px;font:inherit;font-size:11px;color:var(--oi-tone-info);background:transparent;border:1px solid var(--oi-border);border-radius:9px;cursor:pointer}.oi-sp-clear:hover{background:var(--oi-hover)}.oi-sp-cal{display:flex;flex-direction:column;flex:1;min-height:0;gap:4px}.oi-sp-cal-nav{display:flex;align-items:baseline;justify-content:space-between;flex:none}.oi-sp-cal-nav b{font-size:13px;letter-spacing:.04em;text-transform:uppercase}.oi-sp-cal-nav button{background:transparent;border:0;padding:1px 8px;cursor:pointer;color:var(--oi-tone-muted)}.oi-sp-cal-nav button:hover{color:var(--oi-text);background:var(--oi-hover)}
.mk-cal{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border:1px solid var(--oi-border);margin-top:8px}
.mk-cal .dw{font:600 9.5px var(--oi-font-head);letter-spacing:.1em;color:var(--oi-tone-muted);padding:6px;border-bottom:1px solid var(--oi-border-strong);text-transform:uppercase}
.mk-d{height:62px;padding:5px 6px;border:0;border-right:1px solid var(--oi-border);border-bottom:1px solid var(--oi-border);background:transparent;font:11px var(--oi-font-mono);color:var(--oi-text-2);cursor:pointer;display:flex;flex-direction:column;align-items:flex-start;gap:3px;text-align:left;min-width:0;overflow:hidden}
.mk-cal.week .mk-d{height:110px}
.mk-d:nth-child(7n){border-right:0}.mk-d:hover{background:var(--oi-hover)}.mk-d.sel{background:var(--oi-selected);box-shadow:inset 0 2px 0 var(--oi-accent)}.mk-d.o{color:var(--oi-tone-muted);opacity:.5;cursor:default}.mk-d.today>span:first-child{text-decoration:underline}
.mk-d:focus-visible{outline:1px solid var(--oi-focus);outline-offset:-1px}
.oi-sp-fullgrid{flex:none;min-height:0}
.mk-mode{display:inline-flex;margin-right:6px;border:1px solid var(--oi-border);border-radius:6px}.mk-mode .mk-tbtn[aria-pressed=true]{color:var(--oi-text);background:var(--oi-selected)}
.mk-d .dots{display:flex;gap:2px;flex-wrap:wrap}.mk-d .dots i{width:5px;height:5px;border-radius:50%;background:var(--c)}
.mk-d .dots i[data-kind=spend]{border-radius:1px;opacity:calc(.25 + .2 * var(--lv,1))}.mk-d .dots i[data-level="1"]{--lv:1}.mk-d .dots i[data-level="2"]{--lv:2}.mk-d .dots i[data-level="3"]{--lv:3}.mk-d .dots i[data-level="4"]{--lv:4}
.oi-sp-spend{display:flex;flex-direction:column;gap:3px;margin:6px 0 2px;min-width:0}.oi-sp-spend-t{font-size:12px;overflow-wrap:anywhere}.oi-sp-spend small{color:var(--oi-tone-muted);font-size:10px}
.oi-sp-spark,.oi-sp-hours{display:flex;align-items:flex-end;gap:2px;height:28px}.oi-sp-spark i,.oi-sp-hours i{flex:1;min-width:2px;background:var(--oi-kind-spend);border-radius:1px 1px 0 0}.oi-sp-spark i:not([data-status=spent]){background:var(--oi-border);opacity:.6}
.oi-sp-hour-ticks{display:flex;justify-content:space-between}
.oi-sp-wbars{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px;align-items:end}.oi-sp-wbar{display:flex;flex-direction:column;align-items:center;gap:1px;height:64px;justify-content:flex-end;min-width:0}.oi-sp-wbar i{width:70%;background:var(--oi-kind-spend);border-radius:1px 1px 0 0;max-height:36px;min-height:2px}.oi-sp-wbar[data-status=none] i,.oi-sp-wbar[data-status=not-captured] i{background:var(--oi-border)}.oi-sp-wbar small{font-size:10px}.oi-sp-wbar em{font-style:normal;font-size:9px;color:var(--oi-tone-muted);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-sp-month{font-size:13px;letter-spacing:.04em;text-transform:uppercase;margin-right:6px}
.oi-sp-wd,.oi-sp-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:1px}.oi-sp-wd{flex:none;color:var(--oi-tone-muted);text-transform:uppercase;font-size:10px;letter-spacing:.04em}.oi-sp-wd span{padding:0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oi-sp-grid{flex:1;min-height:0;background:var(--oi-border);border:1px solid var(--oi-border)}.oi-sp-blank{background:var(--oi-bg)}
.oi-sp-day{display:flex;flex-direction:column;align-items:flex-start;gap:1px;min-width:0;min-height:0;overflow:hidden;text-align:left;border:0;padding:3px 5px;background:var(--oi-bg);cursor:pointer;color:var(--oi-tone-muted);position:relative}.oi-sp-day:hover{background:var(--oi-hover)}.oi-sp-day.d1{background:color-mix(in srgb,var(--oi-text) 3%,var(--oi-bg));color:var(--oi-text)}.oi-sp-day.d2{background:color-mix(in srgb,var(--oi-text) 7%,var(--oi-bg));color:var(--oi-text)}.oi-sp-day.d3{background:color-mix(in srgb,var(--oi-text) 12%,var(--oi-bg));color:var(--oi-text)}.oi-sp-day.sel{background:var(--oi-selected);outline:1px solid var(--oi-tone-info);outline-offset:-1px;color:var(--oi-text)}
.oi-sp-day .n{font-weight:600}.oi-sp-day.today .n{text-decoration:underline}.oi-sp-day .pills{display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:0;max-width:100%;overflow:hidden}.oi-sp-more-n{color:var(--oi-tone-muted);font-size:10px;padding-left:2px}
.oi-sp-pill{display:inline-flex;align-items:center;gap:4px;max-width:100%;min-width:0;box-sizing:border-box;padding:0 6px;border-radius:999px;font-size:10px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:color-mix(in srgb,var(--k) 15%,transparent);color:var(--k)}.oi-sp-pill i,.oi-sp-ktab i,.oi-sp-glyph{font-style:normal;flex:none}
.oi-sp-ktabs{display:flex;flex-wrap:wrap;gap:4px;flex:none}.oi-sp-ktab{display:inline-flex;align-items:center;gap:5px;border:1px solid transparent;border-radius:999px;padding:2px 10px;background:color-mix(in srgb,var(--k,var(--oi-text)) 10%,transparent);color:var(--k,var(--oi-text));cursor:pointer}.oi-sp-ktab b{font-weight:600;color:var(--oi-text)}.oi-sp-ktab:hover{background:color-mix(in srgb,var(--k,var(--oi-text)) 20%,transparent)}.oi-sp-ktab[aria-selected=true]{background:color-mix(in srgb,var(--k,var(--oi-text)) 22%,transparent);border-color:var(--k,var(--oi-text))}.oi-sp-ktab:focus-visible,.oi-sp-act:focus-visible,.oi-sp-crumb:focus-visible{outline:2px solid var(--oi-tone-info);outline-offset:1px}
.oi-sp-insp .oi-sp-act{width:100%;text-align:left;background:transparent;border:0;cursor:pointer;padding:2px 4px}.oi-sp-act:hover:not(:disabled){background:var(--oi-hover)}.oi-sp-act:disabled{cursor:default}.oi-sp-line .mono{font-family:ui-monospace,monospace}.oi-sp-crumb{align-self:flex-start;background:transparent;border:0;padding:2px 0;cursor:pointer;color:var(--oi-tone-muted)}.oi-sp-crumb:hover:not(:disabled){color:var(--oi-text);text-decoration:underline}
.oi-sp-h[style]{color:var(--k)}.oi-sp-pill[data-kind=log],.oi-sp-ktab[data-kind=log]{color:var(--oi-text)}.oi-sp-glyph{margin-right:5px}.oi-sp-doc{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;font-size:11px}
.oi-sp-hero{display:flex;flex-wrap:wrap;gap:8px 36px;padding:12px 0 8px;border-bottom:1px solid var(--oi-border);letter-spacing:.06em;font-weight:600}.oi-sp-hero b{font-size:34px;line-height:1;margin-right:6px}.oi-sp-hero .pass{color:var(--oi-tone-success)}.oi-sp-hero .warn{color:var(--oi-tone-attention)}.oi-sp-hero .fail{color:var(--oi-tone-failure)}
.oi-sp-hitem{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;background:transparent;border:0;border-left:2px solid var(--oi-tone-attention);padding:4px 8px;margin:3px 0;cursor:pointer}.oi-sp-hitem.fail{border-left-color:var(--oi-tone-failure)}.oi-sp-hitem:hover{background:var(--oi-hover)}.oi-sp-hitem.sel{background:var(--oi-selected)}.oi-sp-hitem .h{display:flex;gap:12px;justify-content:space-between}.oi-sp-hitem .m{color:var(--oi-tone-muted)}.oi-sp-hitem .d{color:var(--oi-tone-muted)}.oi-sp-nolimit{color:var(--oi-tone-muted);font-style:italic}
.oi-sp-bar{position:relative;display:flex;align-items:center;gap:8px;height:8px;margin-top:2px;max-width:420px}.oi-sp-bar>span{display:block;height:100%;background:var(--oi-tone-attention);flex:none}.oi-sp-hitem.fail .oi-sp-bar>span{background:var(--oi-tone-failure)}.oi-sp-bar small{color:var(--oi-tone-muted);font-size:10px;white-space:nowrap}
.oi-sp-file{margin-bottom:6px}.oi-sp-line{display:flex;gap:10px;align-items:baseline;padding:1px 6px 1px 66px;min-width:0}.oi-sp-line b{flex:none}.oi-sp-line .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.oi-sp-more{background:transparent;border:0;color:var(--oi-tone-muted);cursor:pointer;padding:2px 6px 2px 66px;text-align:left;text-decoration:underline}
.oi-sp-insp .oi-sp-line{padding-left:0}.oi-sp-insp .oi-sp-more{padding-left:0}.oi-sp-ih{font-size:12px;margin:0 0 4px;font-weight:600;overflow-wrap:anywhere}.oi-sp-ih small{color:var(--oi-tone-muted);font-weight:400}
.oi-sp-insp dl{margin:0;display:flex;flex-direction:column;gap:5px}.oi-sp-field dt{color:var(--oi-tone-muted);font-size:10px;text-transform:uppercase;letter-spacing:.04em}.oi-sp-field dd{margin:0;overflow-wrap:anywhere}.oi-sp-absent{color:var(--oi-tone-muted)}
.oi-sp-rowwrap .oi-sp-act{display:flex;gap:10px;align-items:baseline;flex:1;width:auto;min-width:0}.oi-sp-plain{display:flex;gap:10px;flex:1;min-width:0}.oi-sp-idlink{flex:none;background:transparent;border:0;padding:0;font:inherit;font-size:11px;color:var(--oi-tone-info);text-decoration:underline;cursor:pointer}.oi-sp-idlink:disabled{color:var(--oi-tone-muted);text-decoration:none;cursor:default}.oi-sp-bead{color:var(--oi-tone-info)}.oi-sp-adr{display:inline-flex;flex-wrap:wrap;gap:3px 4px;align-items:baseline}
.oi-sp-chips{display:flex;flex-wrap:wrap;gap:3px 8px}.oi-sp code,.oi-sp-insp code,.oi-sp-chip{font-family:monospace;font-size:10px;word-break:break-all}.oi-sp-chip.link{color:var(--oi-tone-info);text-decoration:none}
`;
