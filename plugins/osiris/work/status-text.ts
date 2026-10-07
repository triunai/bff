// Copy-status text (pure, no I/O, no React): one paste-ready plain-text report derived from ONE WorkSurfaceSnapshot.
// The headline counts are the Factory/Board header counts (factoryAt at "now" -> countsLine); the columns are boardCards in lane order.
// Everything that came from a bead is untrusted text: cleanText strips escapes and control characters, redactSecrets masks tokens
// and home paths, and the tracker is named by its folder BASENAME only.
import type { Lane, WorkSurfaceSnapshot } from "./surface-types.ts";
import { boardCards, decisionsWaiting, formatAge, historyFromTimestamps, laneLabel, shortId } from "./surface-model.ts";
import { countsLine, factoryAt } from "./factory-model.ts";
import { cleanText, redactSecrets } from "./sanitize.ts";

const LANES: readonly Lane[] = ["action", "ready", "in_progress", "review", "blocked"];
const WARN: Record<string, string> = { "orphan-claim": "claimed but no pane", "stale-pane": "its pane is gone", "stale-claim": "the claim went quiet" };

// Copy status is pasted into chats: beyond redactSecrets (which masks only the user name of a home path), any absolute
// home or Windows user path becomes "<path>" (review W-7 MED-3; W-8: any case, either slash).
export const HOME_PATH = /(?:\/(?:Users|home)\/|[A-Za-z]:[\\/]Users[\\/])\S+/gi;
const safe = (s: string) => redactSecrets(cleanText(String(s ?? ""))).replace(HOME_PATH, "<path>").replace(/\s+/g, " ").trim();
const basename = (p: string) => safe(String(p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "tracker");
const pad = (n: number) => String(n).padStart(2, "0");
/** Local time as `2026-10-07T20:00:00+08:00`. */
export function localIso(ms: number): string {
  const d = new Date(ms), off = -d.getTimezoneOffset(), a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? "+" : "-"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** The headline counts line. ONE derivation: the Board header and the copied text both read this. */
export function headlineCounts(snap: WorkSurfaceSnapshot, now: number): string {
  const f = factoryAt(snap, historyFromTimestamps(snap), now, now);
  const total = Object.values(f.counts).reduce((a, n) => a + n, 0);
  return total === 0 ? "No work at this time" : countsLine(f.counts);
}

/**
 * "Something is wrong" rule: a bead is listed when bdi's tree carries an anomaly for it (orphan-claim, stale-pane, stale-claim),
 * or when its joined pane id is in snapshot.conflicts (one pane claimed by more than one bead). A conflict pane that no bead
 * joins to is listed by pane id. Sorted by bead id so the order is stable.
 */
export function wrongItems(snap: WorkSurfaceSnapshot): string[] {
  const title = new Map(snap.issues.map((i) => [i.id, i.title]));
  const why = new Map<string, Set<string>>(), paneOf = new Map<string, string>();
  for (const r of snap.tree) for (const n of r.nodes) {
    for (const a of n.anomalies) (why.get(n.id) ?? why.set(n.id, new Set()).get(n.id)!).add(WARN[a] ?? safe(String(a)));
    if (n.agent) paneOf.set(n.id, n.agent.paneId);
  }
  const conflicts = new Set(snap.conflicts), joined = new Set<string>();
  for (const [id, p] of paneOf) if (conflicts.has(p)) { joined.add(p); (why.get(id) ?? why.set(id, new Set()).get(id)!).add("shares its pane with another bead"); }
  const out = [...why.keys()].sort().map((id) => `${shortId(id)} ${safe(title.get(id) ?? id)} (${[...why.get(id)!].join(", ")})`);
  for (const p of [...conflicts].filter((c) => !joined.has(c)).sort()) out.push(`Pane ${safe(p)} is claimed by more than one bead`);
  return out;
}

export function statusText(snap: WorkSurfaceSnapshot, now: number): string {
  const out: string[] = [headlineCounts(snap, now)];
  const cards = boardCards(snap, now);
  for (const l of LANES) {
    const cs = cards.filter((c) => c.lane === l);
    if (cs.length) out.push("", `${laneLabel(l)} (${cs.length})`, ...cs.map((c) => `${safe(c.shortId)} ${safe(c.title)}`));
  }
  const dec = decisionsWaiting(snap, now);
  if (dec.length) out.push("", "Decisions waiting on you", ...dec.map((d) => `${safe(d.shortId)} ${safe(d.title)} (waiting ${formatAge(d.waitingMs)}${d.deferredSessions ? `, put off ${d.deferredSessions} session${d.deferredSessions === 1 ? "" : "s"}` : ""})`));
  const bad = wrongItems(snap);
  if (bad.length) out.push("", "Something is wrong", ...bad);
  out.push("", `Tracker: ${basename(snap.repo)} · generated ${localIso(now)}`);
  return out.join("\n");
}
