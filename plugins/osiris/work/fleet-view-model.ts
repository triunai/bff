// Live fleet count (pure): turns the server's FleetSnapshot into what the top-bar chip, the Overview card and the click-through list
// draw. Takes `now` so tests are deterministic. A missing snapshot (older server, no tracker chosen) is said in words, never shown as 0.
// "Live" is a HEURISTIC (a transcript written in the last few minutes), and every tooltip here says so.
import { PROVIDERS, PROVIDER_IDS, providerLabel, type ProviderId } from "./providers/registry.ts";
import type { FleetCount, FleetKind, FleetLane, FleetNow, FleetRole, FleetRuntime, FleetSnapshot, FleetState, FleetWaiting } from "./fleet-types.ts";
import { modelTier, tierTitle } from "./model-tiers.ts";
import { agentsWaitingText } from "./needs-you.ts";
import { countText, lastActivityText, usdText } from "./cost-cache-model.ts";

const DASH = "—";
export const NO_FLEET_TEXT = "Fleet count is not available yet. Restart Osiris, or choose a tracker in Work.";
const mins = (ms: number) => `${Math.round(ms / 60_000)} min`;

/** Largest-remainder apportionment (Claude-Code-Usage-Monitor's stacked bar): integer shares of `total` that sum to EXACTLY `total`
 * (3 equal parts of 100 = 34/33/33, not 33/33/33). All-zero input gives all zeros. Ties go to the earlier entry. */
export function largestRemainder(values: readonly number[], total = 100): number[] {
  const sum = values.reduce((a, b) => a + Math.max(0, b), 0);
  if (sum <= 0) return values.map(() => 0);
  const exact = values.map(v => (Math.max(0, v) / sum) * total);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => ({ i, r: e - Math.floor(e) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k].i]++;
  return out;
}

/** Model colour: the existing lane-colour tokens (no raw colours), one per model key; unknown stays muted. */
const MODEL_COLOUR: Readonly<Record<string, string>> = {
  sonnet: "var(--oi-lane-0)", haiku: "var(--oi-lane-1)", fable: "var(--oi-lane-2)", opus: "var(--oi-lane-3)",
  sol: "var(--oi-lane-4)", codex: "var(--oi-lane-5)", astra: "var(--oi-lane-6)",
};
export const modelColour = (key: string): string => MODEL_COLOUR[key] ?? "var(--oi-tone-muted)";

export interface Segment { key: string; label: string; letter: string; live: number; pct: number; colour: string }
const segmentsOf = (byModel: readonly FleetCount[]): Segment[] => {
  const live = byModel.filter(m => m.live > 0).sort((a, b) => b.live - a.live || a.label.localeCompare(b.label));
  const pct = largestRemainder(live.map(m => m.live));
  return live.map((m, i) => ({ key: m.key, label: m.label, letter: m.letter ?? modelTier(m.key).letter, live: m.live, pct: pct[i], colour: modelColour(m.key) }));
};
/** The header chip's bar: live agents per PROVIDER (runtime), in the provider mark colours (mockup .mbar, ADR D-137). */
const providerBarOf = (byRuntime: readonly FleetCount[]): Segment[] => {
  const live = byRuntime.filter(m => m.live > 0).sort((a, b) => b.live - a.live || a.label.localeCompare(b.label));
  const pct = largestRemainder(live.map(m => m.live));
  return live.map((m, i) => ({ key: m.key, label: m.label, letter: m.label.slice(0, 1), live: m.live, pct: pct[i], colour: `var(--oi-provider-${m.key})` }));
};
const rolesOf = (by: readonly FleetCount[]) => (["lead", "worker", "reviewer", "main"] as const).map(r => ({ role: r, live: by.find(c => c.key === r)?.live ?? 0 }));
/** The one plain-words definition of the live number, shown on the chip tooltip and the card. */
export const LIVE_DEFINITION = "Live = an agent's transcript was written in the last 5 minutes. Counts teammates, subagents, workflow agents, main sessions and Codex sessions.";
const heuristic = (liveMs: number, idleMs: number) =>
  `Live = an agent wrote to its transcript in the last ${mins(liveMs)}. Idle = ${mins(liveMs)} to ${mins(idleMs)}. This is a guess from file activity, not a status the agent reports.`;

/** Plain words per reason (td-osi.21.2). `badge` is the <= 3 word row label, `title` the row tooltip, `count` the phrase in the chip tooltip. */
export const WAITING_WORDS: Readonly<Record<FleetWaiting, { badge: string; title: string; count: string; shape: string }>> = {
  question: { badge: "question", title: "Waiting for your answer", count: "waiting for your answer", shape: "?" },
  permission: { badge: "Permission", title: "Waiting for permission", count: "waiting for permission", shape: "!" },
  "your-turn": { badge: "your turn", title: "Your turn", count: "your turn", shape: "↵" },
  message: { badge: "Unread", title: "Unread message", count: "unread message", shape: "✉" },
};
const needsTextOf = (n: number) => (n > 0 ? `${n} ${n === 1 ? "needs" : "need"} you` : "");
const needsTitleOf = (by: readonly FleetCount[] | undefined, n: number) => {
  if (n <= 0) return "";
  const parts = (by ?? []).filter(c => c.total > 0 && c.key in WAITING_WORDS && c.key !== "message").map(c => `${c.total} ${WAITING_WORDS[c.key as FleetWaiting].count}`);
  return `${needsTextOf(n)}${parts.length ? `: ${parts.join(", ")}` : ""}. Needs you = blocked on a person (a question, your turn, a permission), a guess from the transcript.`;
};
const unreadTextOf = (n: number) => (n > 0 ? `${n} unread` : "");
const unreadTitleOf = (n: number) => (n > 0 ? `${unreadTextOf(n)}: agents with a message nobody has answered yet. Not counted as needing you.` : "");

export interface ChipView {
  /** Lanes that need a person, "N need you" (empty when none), and the plain-words reasons for the tooltip. */
  needsYou: number; needsText: string; needsTitle: string; /** Header chip label: names what is waiting (agents), see needs-you.ts. */ chipNeedsText: string;
  /** Lanes with only an unanswered message: a separate small figure ("N unread"), never part of the headline. */
  unread: number; unreadText: string;
  big: string; sub: string; /** The window the big number is measured over, e.g. "5 min". */ window: string; segments: Segment[]; /** Live per provider, for the header chip's bar. */ providerBar: Segment[]; roles: { role: FleetRole; live: number }[];
  title: string; empty: string | null; live: number; spark: number[]; definition: string;
}
export function chipView(fleet?: FleetSnapshot | null): ChipView {
  if (!fleet) return { needsYou: 0, needsText: "", chipNeedsText: "", needsTitle: "", unread: 0, unreadText: "", big: DASH, sub: "", window: "", segments: [], providerBar: [], roles: [], title: NO_FLEET_TEXT, empty: NO_FLEET_TEXT, live: 0, spark: [], definition: LIVE_DEFINITION };
  const s = fleet.summary;
  const roles = rolesOf(s.byRole);
  const roleWords = roles.filter(r => r.live > 0).map(r => `${r.live} ${r.role}`).join(", ");
  const needsYou = s.needsYou ?? 0, needsTitle = needsTitleOf(s.byWaiting, needsYou), unread = s.unread ?? 0, unreadTitle = unreadTitleOf(unread);
  return {
    needsYou, needsText: needsTextOf(needsYou), chipNeedsText: agentsWaitingText(needsYou), needsTitle, unread, unreadText: unreadTextOf(unread),
    big: String(s.live), sub: `+${s.idle} idle`, window: mins(s.liveWindowMs), segments: segmentsOf(s.byModel), providerBar: providerBarOf(s.byRuntime), roles, empty: null, live: s.live,
    spark: norm(s.liveSpark ?? []), definition: LIVE_DEFINITION,
    title: `${s.live} live (last ${mins(s.liveWindowMs)}), ${s.idle} idle${roleWords ? ` (${roleWords})` : ""}.${needsTitle ? ` ${needsTitle}` : ""}${unreadTitle ? ` ${unreadTitle}` : ""} ${LIVE_DEFINITION} ${heuristic(s.liveWindowMs, s.idleWindowMs)}`,
  };
}

export interface CardView {
  /** The "Need you" figure: how many lanes are blocked on a person. */
  needYou: number; needYouText: string;
  /** Message-only waits, a separate small figure (not in needYou). */
  unread: number; unreadText: string;
  empty: string | null; number: string; sub: string; segments: Segment[]; roles: { role: FleetRole; live: number }[];
  runtimes: { key: FleetRuntime | string; label: string; live: number }[];
  kinds: { key: FleetKind | string; label: string; live: number; idle: number; total: number }[];
  windows: { id: string; label: string; n: number; title: string }[]; spark: number[]; definition: string; burnText: string; burnTitle: string; doneToday: number; doneText: string; title: string;
}
const startOfDay = (now: number) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
export function cardView(fleet: FleetSnapshot | null | undefined, now: number): CardView {
  if (!fleet) return { needYou: 0, needYouText: "", unread: 0, unreadText: "", empty: NO_FLEET_TEXT, number: DASH, sub: "", segments: [], roles: [], runtimes: [], kinds: [], windows: [], spark: [], definition: LIVE_DEFINITION, burnText: DASH, burnTitle: NO_FLEET_TEXT, doneToday: 0, doneText: DASH, title: NO_FLEET_TEXT };
  const s = fleet.summary, c = chipView(fleet);
  const day = startOfDay(now);
  const doneToday = fleet.lanes.filter(l => l.state === "done" && l.lastAt !== null && l.lastAt >= day).length;
  return {
    needYou: c.needsYou, needYouText: c.needsText, unread: c.unread, unreadText: c.unreadText,
    empty: null, number: String(s.live), sub: `${s.idle} idle · ${s.total} seen`, segments: c.segments, roles: c.roles, title: c.title,
    runtimes: s.byRuntime.map(r => ({ key: r.key, label: r.label, live: r.live })),
    kinds: (s.byKind ?? []).map(k => ({ key: k.key, label: k.label, live: k.live, idle: k.idle, total: k.total })),
    windows: [
      { id: "live", label: `live ${mins(s.liveWindowMs)}`, n: s.live, title: "Transcript written in the last 5 minutes." },
      { id: "active", label: `active ${mins(s.idleWindowMs)}`, n: s.live + s.idle, title: "Live plus idle: transcript written in the last 60 minutes." },
      { id: "seen", label: "seen 7 days", n: s.total, title: "Every agent whose transcript was written in the last 7 days." },
    ],
    spark: c.spark, definition: LIVE_DEFINITION,
    burnText: s.burnUsdPerHour === null ? "no priced calls this hour" : `${usdText(s.burnUsdPerHour)}/h`,
    burnTitle: "Spend over the last hour at list price: an estimate, not a bill. Calls on a model without a price are left out.",
    doneToday, doneText: `${doneToday} finished today`,
  };
}

// ---- the click-through list ----
export type FleetSort = "state" | "cost" | "name";
export interface FleetFilters { state?: FleetState | null; modelKey?: string | null; role?: FleetRole | null; workspace?: string | null; /** Only agents blocked on a person (a question, a permission), the same set the "n need you" count uses. */ needs?: boolean | null;
  /** The preset LAYER: composes with the facets above (both must pass). Unset = "everything" (no preset filter), so every non-popover caller keeps seeing all lanes. */ preset?: FleetPresetId | null }
export interface FleetRow {
  key: string; state: FleetState; shape: string; stateWord: string; label: string; kind: FleetKind | "group"; group: boolean; beadId: string | null;
  runtime: FleetRuntime; needsYou: boolean; modelLetter: string; /** Provider code + model letter, e.g. "CL·O", "CX·C", "GM·G". */ modelChip: string; provider: FleetProvider; modelKey: string; modelTitle: string; role: FleetRole; workspace: string | null; branch: string | null;
  /** Why this lane needs a person (null when it does not), with the badge words, a shape (never colour alone) and the tooltip. */
  waiting: FleetWaiting | null; waitingWord: string; waitingShape: string; waitingTitle: string;
  /** The second line: "Bash · 42s" (running) / "Read · 2m ago" (finished) / "" (unknown). Long = a RUNNING tool past LONG_RUN_MS. Words from tool names and numbers only. */
  activity: string; activityRunning: boolean; activityLong: boolean;
  lastText: string; tokensText: string; tokensTitle: string; costText: string; costTitle: string; spark: number[]; depth: number; childCount: number; live: boolean;
  /** Only on a workspace header row (group-by "workspace"): its own lanes' live / need-you / total and the newest activity. */
  wsGroup?: WsGroup;
}
export interface WsGroup { live: number; needYou: number; total: number; newestAt: number | null; newestText: string }
export type FleetGroupBy = "tree" | "workspace";
/** A workspace header's label counts: "7 live · 2 need you" (the need-you part only when there is one). */
export const wsHeaderText = (g: Pick<WsGroup, "live" | "needYou">): string => `${g.live} live${g.needYou > 0 ? ` · ${g.needYou} need you` : ""}`;

export type FleetPresetId = "working" | "needs" | "everything";
/** What the popover opens with: the "Working now" preset pressed, every facet at All. */
export const DEFAULT_FILTERS: FleetFilters = { preset: "working" };
/** A preset is a LAYER over the facets, not a facet value: "Working now" = live (wrote in the last 5 min), "Needs you" = blocked on a person, "Everything" = no preset filter. */
const presetPass = (id: FleetPresetId, l: FleetLane): boolean => id === "working" ? l.state === "live" : id === "needs" ? !!l.waiting && l.waiting !== "message" : true;
export const PRESETS: readonly { id: FleetPresetId; label: string; apply: FleetFilters }[] = [
  { id: "working", label: "Working now", apply: { preset: "working" } },
  { id: "needs", label: "Needs you", apply: { preset: "needs" } },
  { id: "everything", label: "Everything", apply: { preset: "everything" } },
];
export const activePreset = (f: FleetFilters): FleetPresetId => f.preset ?? "everything";
/** True once any facet narrows the list further ("Custom" lights up beside the preset). */
export const facetsNarrowed = (f: FleetFilters): boolean => !!(f.state || f.modelKey || f.role || f.workspace || f.needs);
export const presetLabel = (id: FleetPresetId): string => PRESETS.find(p => p.id === id)?.label ?? "Custom";
export const showingText = (shown: number, total: number, f: FleetFilters): string => `Showing ${shown} of ${total} · ${presetLabel(activePreset(f))}`;
/** A SHAPE as well as a colour for each state (colour alone fails for colour-blind readers): filled, half, hollow. */
export const STATE_SHAPE: Readonly<Record<FleetState, string>> = { live: "●", idle: "◐", done: "○" };
const STATE_RANK: Record<FleetState, number> = { live: 0, idle: 1, done: 2 };

export function costView(l: Pick<FleetLane, "costUsd" | "pricedUsd" | "runtime">): { text: string; title: string } {
  if (l.costUsd !== null) return { text: usdText(l.costUsd), title: "Estimate at list price." };
  if (l.runtime !== "claude") return { text: DASH, title: `${providerLabel(l.runtime)} sessions carry no price, so there is no estimate.` };
  if (l.pricedUsd > 0) return { text: `${usdText(l.pricedUsd)}+`, title: "At least this much: part of the work used a model without a price." };
  return { text: "unpriced", title: "This agent used a model without a price, so there is no estimate." };
}
const norm = (spark: readonly number[]): number[] => { const m = Math.max(0, ...spark); return spark.map(v => (m > 0 ? Math.max(0, v) / m : 0)); };
/** Human blockers first, then unread-only lanes, then the rest (review-folds LOW-2: an unread message is not a blocker). */
const waitingRank = (l: FleetLane) => (!l.waiting ? 2 : l.waiting === "message" ? 1 : 0);
const costSortValue = (l: FleetLane) => l.costUsd ?? l.pricedUsd;
const cmp = (sort: FleetSort) => (a: FleetLane, b: FleetLane): number => {
  const byTime = (b.lastAt ?? 0) - (a.lastAt ?? 0);
  if (sort === "cost") return costSortValue(b) - costSortValue(a) || byTime;
  if (sort === "name") return a.label.localeCompare(b.label) || byTime;
  // Default sort: lanes that need you first, then live / idle / done, newest first.
  return waitingRank(a) - waitingRank(b) || STATE_RANK[a.state] - STATE_RANK[b.state] || byTime;
};
export function filterLanes(lanes: readonly FleetLane[], f: FleetFilters): FleetLane[] {
  return lanes.filter(l => (!f.state || l.state === f.state) && (!f.modelKey || l.modelKey === f.modelKey) && (!f.role || l.role === f.role) && (!f.workspace || l.workspace === f.workspace) && (!f.needs || (!!l.waiting && l.waiting !== "message")) && presetPass(f.preset ?? "everything", l));
}
const waitingFields = (w: FleetWaiting | null) => ({ waiting: w, waitingWord: w ? WAITING_WORDS[w].badge : "", waitingShape: w ? WAITING_WORDS[w].shape : "", waitingTitle: w ? WAITING_WORDS[w].title : "" });
/** A running tool older than this gets the attention token on the row's second line. */
export const LONG_RUN_MS = 5 * 60_000;
const ageWord = (ms: number): string => { const s = Math.floor(Math.max(0, ms) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };
export function activityView(n: FleetNow | null | undefined, now: number): { activity: string; activityRunning: boolean; activityLong: boolean } {
  if (!n) return { activity: "", activityRunning: false, activityLong: false };
  const age = now - n.since;
  return { activity: n.running ? `${n.tool} · ${ageWord(age)}` : `${n.tool} · ${ageWord(age)} ago`, activityRunning: n.running, activityLong: n.running && age > LONG_RUN_MS };
}
export type FleetProvider = ProviderId;
/** Display order of the providers, and the two-letter code on a row's model chip. */
export const PROVIDER_ORDER: readonly FleetProvider[] = PROVIDER_IDS;
export const PROVIDER_LABEL: Readonly<Record<FleetProvider, string>> = Object.fromEntries(PROVIDERS.map(p => [p.id, p.label.toUpperCase()])) as Record<FleetProvider, string>;
const PROVIDER_CODE: Readonly<Record<FleetProvider, string>> = Object.fromEntries(PROVIDERS.map(p => [p.id, p.chip])) as Record<FleetProvider, string>;
/** The provider is read from the lane's own data (its runtime, then its model id), never from a fixed list of models. */
export const providerOf = (l: Pick<FleetLane, "runtime" | "model" | "modelKey">): FleetProvider =>
  l.runtime === "codex" ? "codex" : PROVIDERS.find(p => p.id !== "claude" && p.id !== "codex" && p.match.test(`${l.modelKey} ${l.model ?? ""}`))?.id ?? "claude";
const modelChipOf = (l: FleetLane) => `${PROVIDER_CODE[providerOf(l)]}·${l.modelLetter}`;
/** Tier words plus the full model id from the data, so the single letter is never the only clue. */
const modelTitleOf = (l: FleetLane) => { const t = tierTitle(modelTier(l.model), l.role === "lead" || l.role === "worker" ? l.role : null); return l.model ? `${t} (${l.model})` : t; };
const rowOf = (l: FleetLane, now: number, depth: number, childCount: number): FleetRow => {
  const cost = costView(l);
  return {
    key: l.key, state: l.state, shape: STATE_SHAPE[l.state], stateWord: l.state, label: l.label, kind: l.kind, group: false, beadId: l.beadId, runtime: l.runtime, needsYou: !!l.waiting && l.waiting !== "message",
    modelLetter: l.modelLetter, modelChip: modelChipOf(l), provider: providerOf(l), modelKey: l.modelKey, modelTitle: modelTitleOf(l),
    role: l.role, workspace: l.workspace, branch: l.branch, ...waitingFields(l.waiting ?? null), ...activityView(l.now, now), lastText: lastActivityText(l.lastAt, now), tokensText: countText(l.tokensIn + l.tokensOut), tokensTitle: `${countText(l.tokensIn)} in, ${countText(l.tokensOut)} out`, costText: cost.text, costTitle: cost.title,
    spark: norm(l.spark), depth, childCount, live: l.state === "live",
  };
};
/** The sibling-group name for a lane with no known parent: the text before the first `-` of its LANE NAME (`fg-board` -> `fg`). */
const prefixOf = (l: FleetLane): string | null => {
  if (l.labelFrom !== "lane") return null;
  const i = l.label.indexOf("-");
  return i >= 2 ? l.label.slice(0, i) : null;
};
/** A synthetic row that only groups siblings (never a lane, never counted anywhere): state = its best member's. */
const groupRowOf = (prefix: string, members: readonly FleetLane[]): FleetRow => {
  const best = members.reduce((a, m) => (STATE_RANK[m.state] < STATE_RANK[a] ? m.state : a), "done" as FleetState);
  return {
    key: `group:${prefix}`, state: best, shape: STATE_SHAPE[best], stateWord: best, label: `${prefix}-`, kind: "group", group: true, beadId: null, runtime: "claude",
    modelLetter: "", modelChip: "", provider: "claude", modelKey: "", needsYou: false, modelTitle: "", role: "worker", workspace: null, branch: null, ...waitingFields(null), ...activityView(null, 0), lastText: "", tokensText: "", tokensTitle: "", costText: "", costTitle: "",
    spark: [], depth: 0, childCount: members.length, live: best === "live",
  };
};
/** Filtered + sorted rows as the coordinator -> leads -> workers tree: a lane whose parent is also in the list nests under it (depth,
 *  childCount); top-level lanes with no known parent that share a lane-name prefix (`fg-`, `fin-`) go under one synthetic group row.
 *  Cycles cannot hang it. */
export function listRows(fleet: FleetSnapshot, filters: FleetFilters = {}, sort: FleetSort = "state", now: number = fleet.summary.at, groupBy: FleetGroupBy = "tree"): FleetRow[] {
  const lanes = filterLanes(fleet.lanes, filters).sort(cmp(sort));
  if (groupBy === "workspace") return workspaceRows(lanes, now);
  const present = new Set(lanes.map(l => l.key));
  const kids = new Map<string, FleetLane[]>();
  const roots: FleetLane[] = [];
  for (const l of lanes) {
    if (l.parentKey && l.parentKey !== l.key && present.has(l.parentKey)) kids.set(l.parentKey, [...(kids.get(l.parentKey) ?? []), l]);
    else roots.push(l);
  }
  const byPrefix = new Map<string, FleetLane[]>();
  for (const l of roots) { const p = prefixOf(l); if (p && l.role !== "main") byPrefix.set(p, [...(byPrefix.get(p) ?? []), l]); }
  const out: FleetRow[] = [], seen = new Set<string>(), grouped = new Set<string>();
  const walk = (l: FleetLane, depth: number) => {
    if (seen.has(l.key)) return;
    seen.add(l.key);
    const k = kids.get(l.key) ?? [];
    out.push(rowOf(l, now, depth, k.length));
    for (const c of k) walk(c, depth + 1);
  };
  for (const r of roots) {
    const p = prefixOf(r), members = p && r.role !== "main" ? byPrefix.get(p) : undefined;
    if (p && members && members.length > 1) {
      if (grouped.has(p)) continue;
      grouped.add(p);
      out.push(groupRowOf(p, members));
      for (const m of members) walk(m, 1);
    } else walk(r, 0);
  }
  for (const l of lanes) walk(l, 0); // only a parent cycle leaves anything unvisited
  return out;
}

const NO_WS = "No workspace";
/** A synthetic workspace header: never a lane, never counted; carries its own lanes' counts and newest activity. */
const wsHeaderOf = (key: string, name: string, own: readonly FleetLane[], depth: number, now: number): FleetRow => {
  const best = own.reduce((a, m) => (STATE_RANK[m.state] < STATE_RANK[a] ? m.state : a), "done" as FleetState);
  const newestAt = own.reduce<number | null>((a, m) => (m.lastAt !== null && (a === null || m.lastAt > a) ? m.lastAt : a), null);
  return {
    ...groupRowOf(name, own), key, label: name, depth, state: best, shape: STATE_SHAPE[best], stateWord: best, live: best === "live", childCount: own.length,
    wsGroup: { live: own.filter(m => m.state === "live").length, needYou: own.filter(m => m.waiting && m.waiting !== "message").length, total: own.length, newestAt, newestText: lastActivityText(newestAt, now) },
  };
};
/** Group-by "workspace": lanes (already filtered + sorted) under one header per workspace name, headers by newest activity then name,
 *  "No workspace" last. A `repo/worktree` workspace nests one level under `repo` when `repo` is itself a group; inside a workspace a lane
 *  nests under its parent only when the parent shares that workspace. */
function workspaceRows(lanes: readonly FleetLane[], now: number): FleetRow[] {
  const by = new Map<string, FleetLane[]>();
  for (const l of lanes) by.set(l.workspace ?? "", [...(by.get(l.workspace ?? "") ?? []), l]);
  const newest = (n: string) => (by.get(n) ?? []).reduce((a, l) => Math.max(a, l.lastAt ?? 0), 0);
  const parentOf = (n: string) => { const i = n.indexOf("/"); return i > 0 && by.has(n.slice(0, i)) ? n.slice(0, i) : null; };
  const children = new Map<string, string[]>();
  const tops: string[] = [];
  for (const n of by.keys()) {
    if (n === "") continue;
    const p = parentOf(n);
    if (p) children.set(p, [...(children.get(p) ?? []), n]); else tops.push(n);
  }
  const subtree = (n: string): number => Math.max(newest(n), ...(children.get(n) ?? []).map(newest));
  const order = (names: string[]) => names.sort((a, b) => subtree(b) - subtree(a) || a.localeCompare(b));
  const out: FleetRow[] = [];
  const emit = (name: string, depth: number) => {
    const own = by.get(name) ?? [], present = new Set(own.map(l => l.key)), kids = new Map<string, FleetLane[]>(), roots: FleetLane[] = [];
    for (const l of own) {
      if (l.parentKey && l.parentKey !== l.key && present.has(l.parentKey)) kids.set(l.parentKey, [...(kids.get(l.parentKey) ?? []), l]);
      else roots.push(l);
    }
    out.push(wsHeaderOf(`group:ws:${name}`, name || NO_WS, own, depth, now) /* "No workspace" = group:ws: (a real workspace is never empty), so "none" cannot collide (review-wsgroup MED) */);
    const seen = new Set<string>();
    const walk = (l: FleetLane, d: number) => {
      if (seen.has(l.key)) return;
      seen.add(l.key);
      const k = kids.get(l.key) ?? [];
      out.push(rowOf(l, now, d, k.length));
      for (const c of k) walk(c, d + 1);
    };
    for (const r of roots) walk(r, depth + 1);
    for (const l of own) walk(l, depth + 1); // only a parent cycle leaves anything unvisited
    for (const c of order(children.get(name) ?? [])) emit(c, depth + 1);
  };
  for (const n of order(tops)) emit(n, 0);
  if (by.has("")) emit("", 0);
  return out;
}

export interface FilterChip { id: string; label: string; count: number; on: boolean; apply: FleetFilters; /** Model chips: the badge letter and the full model id(s) from the data. */ letter?: string; title?: string; /** Model chips: which provider the model belongs to, from the data (the eyebrow above a run of chips). */ provider?: FleetProvider }
export interface FilterGroups { state: FilterChip[]; model: FilterChip[]; role: FilterChip[]; workspace: FilterChip[] }
/** Chips with counts for the list header; a chip toggles its own filter (clicking an active one clears it). */
export function filterGroups(fleet: FleetSnapshot, f: FleetFilters): FilterGroups {
  const count = <T,>(get: (l: FleetLane) => T) => { const m = new Map<T, number>(); for (const l of fleet.lanes) m.set(get(l), (m.get(get(l)) ?? 0) + 1); return m; };
  const chips = <T extends string>(m: Map<T | null, number>, cur: T | null | undefined, field: keyof FleetFilters, label: (k: T) => string): FilterChip[] =>
    [...m.entries()].filter((e): e is [T, number] => e[0] !== null).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, n]) => ({ id: `${field}:${k}`, label: label(k), count: n, on: cur === k, apply: { [field]: cur === k ? null : k } }));
  const modelLabel = new Map(fleet.lanes.map(l => [l.modelKey, modelTier(l.model).label] as const));
  const states = count(l => l.state);
  return {
    state: (["live", "idle", "done"] as const).map(s => ({ id: `state:${s}`, label: s, count: states.get(s) ?? 0, on: f.state === s, apply: { state: f.state === s ? null : s } })),
    model: chips(count(l => l.modelKey), f.modelKey, "modelKey", k => modelLabel.get(k) ?? k).map(c => {
      const k = c.id.slice("modelKey:".length), ls = fleet.lanes.filter(l => l.modelKey === k), ids = [...new Set(ls.map(l => l.model).filter(Boolean))];
      return { ...c, letter: ls[0]?.modelLetter, provider: ls[0] ? providerOf(ls[0]) : "claude", title: `${c.label}${ids.length ? ` (${ids.join(", ")})` : ""}` };
    }).sort((a, b) => PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider)),
    role: chips(count(l => l.role), f.role, "role", k => k),
    workspace: chips(count(l => l.workspace), f.workspace, "workspace", k => k),
  };
}

export interface PanelGroup {
  id: "state" | "model" | "role" | "workspace"; label: string;
  /** The default chip: selected while the group has no value, picking it clears the group. */
  all: { count: number; on: boolean; apply: FleetFilters };
  /** The chips to show: the top `limit` by count, plus any selected one, or every chip when expanded. */
  chips: FilterChip[];
  /** Chips folded into "+k more" (0 when nothing is folded). */
  more: number;
  /** Lanes the group cannot select (no value for this field, e.g. no workspace). chips + unlabelled = all.count. */
  unlabelled: number;
}
const GROUP_FIELD = { state: "state", model: "modelKey", role: "role", workspace: "workspace" } as const;
const GROUP_LABEL = { state: "Status", model: "Model", role: "Role", workspace: "Workspace" } as const;
/** The list header as four labelled groups, each with an "All" chip. Model values come from the data, never a fixed list. */
export function filterPanel(fleet: FleetSnapshot, f: FleetFilters, expanded: ReadonlySet<string> = new Set(), limit = 5): PanelGroup[] {
  const g = filterGroups(fleet, f);
  return (["state", "model", "role", "workspace"] as const).map(id => {
    const all = g[id], field = GROUP_FIELD[id];
    const needs = fleet.lanes.filter(l => !!l.waiting && l.waiting !== "message").length;
    const chips = id === "state" ? [...all, ...(needs > 0 || f.needs ? [{ id: "needs:you", label: "needs you", count: needs, on: !!f.needs, apply: { needs: f.needs ? null : true } }] : [])] : all;
    const open = expanded.has(id) || chips.length <= limit + 1;
    const shown = open ? chips : chips.filter((c, i) => i < limit || c.on);
    return { id, label: GROUP_LABEL[id], all: { count: fleet.lanes.length, on: !f[field] && !(id === "state" && f.needs), apply: id === "state" ? { state: null, needs: null } : { [field]: null } }, chips: shown, more: chips.length - shown.length,
      unlabelled: fleet.lanes.length - all.reduce((n, c) => n + c.count, 0) };
  });
}
