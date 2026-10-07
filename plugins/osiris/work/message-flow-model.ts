// Message-flow model (pure, takes `now`): MessageEvents + fleet lanes -> edges (who -> whom), a per-lane inbox with an `answered` flag,
// and flags (lost hand-backs, unacknowledged DONE, idle-unanswered, unknown recipient). td-osi.21.2. Metadata only: no event carries a body.
import type { FleetLane, FleetSnapshot, MessageEvent, MessageProtocol } from "./fleet-types.ts";

export const HOUR_MS = 3_600_000, ACK_MS = 15 * 60_000, IDLE_MS = 5 * 60_000, FLAG_WINDOW_MS = 6 * HOUR_MS, MAX_FLAGS = 100, MAX_INBOX = 50;
/** Names that are real recipients without being a fleet lane: the main session and the team lead alias, plus the "*" broadcast. */
const KNOWN_ALIASES = new Set(["main", "team-lead", "*"]);
const DONES: ReadonlySet<MessageProtocol> = new Set(["DONE", "LANDABLE"]);

export type FlagKind = "lost-handback" | "unacknowledged-done" | "idle-unanswered" | "unknown-recipient";
export interface MessageEdge { from: string; to: string; hour: number; all: number; lastAt: number; protocol: MessageProtocol | null }
export interface InboxItem { at: number; from: string; kind: MessageEvent["kind"]; summary: string | null; protocol: MessageProtocol | null; answered: boolean }
export interface InboxLane { name: string; key: string | null; total: number; unanswered: number; items: InboxItem[] }
export interface FlowFlag { kind: FlagKind; /** The lane the problem is on (the one that should act). */ lane: string; /** That lane's fleet key when it is a known lane (fleet-model reads it for the "message" waiting state), else null. */ laneKey: string | null; other: string | null; at: number }
export interface FlowModel { edges: MessageEdge[]; inbox: InboxLane[]; flags: FlowFlag[] }

/** The part of a fleet lane the model reads. */
export interface LaneRef { key: string; label: string; state: FleetLane["state"]; lastAt: number | null }
/** Lane refs for the model from the WHOLE name index (up to FLEET_MAX_NAMES), lastAt from the capped lane list where the lane is in it. */
export function laneRefsOf(fleet: Pick<FleetSnapshot, "lanes" | "names"> | null | undefined): LaneRef[] {
  const lanes = fleet?.lanes ?? [], at = new Map(lanes.map(l => [l.key, l.lastAt]));
  if (!fleet?.names?.length) return lanes.map(l => ({ key: l.key, label: l.label, state: l.state, lastAt: l.lastAt }));
  return fleet.names.map(n => ({ key: n.key, label: n.label, state: n.state, lastAt: at.get(n.key) ?? null }));
}
const norm = (s: string) => s.trim().toLowerCase();
/** ONE alias table: the main session and the team lead are the same actor. */
const ALIAS: Readonly<Record<string, string>> = { "team-lead": "main" };
const aliasOf = (s: string) => { const n = norm(s); return ALIAS[n] ?? n; };
/** An actor resolver: a lane's key, its label and the main / team-lead alias all name ONE actor. Every "who sent / who replied / who got it"
 *  comparison goes through it (Codex M4: a reply stored under the lane label never matched a request addressed by agent id). */
type Actor = (s: string) => string;
const actorOver = (byName: ReadonlyMap<string, LaneRef>): Actor => s => { const a = aliasOf(s), l = byName.get(a); return l ? `lane:${norm(l.key)}` : a; };
const actor: Actor = aliasOf;

/** A `receive` the sender's own `send` already explains (same pair within a minute) is dropped, so one message counts once. */
export function dedupeMessages(events: readonly MessageEvent[], who: Actor = actor): MessageEvent[] {
  const sends = events.filter(e => e.kind === "send");
  return events.filter(e => e.kind !== "receive" || !sends.some(s => who(s.from) === who(e.from) && who(s.to) === who(e.to) && Math.abs(s.at - e.at) <= 60_000));
}

export function buildFlowModel(events: readonly MessageEvent[], lanes: readonly LaneRef[], now: number): FlowModel {
  // Two lanes can share a label (a respawned lead): the non-done, newest one wins, whatever the input order.
  const better = (a: LaneRef, b: LaneRef) => (a.state === "done") !== (b.state === "done") ? a.state !== "done" : (a.lastAt ?? -Infinity) > (b.lastAt ?? -Infinity);
  const byName = new Map<string, LaneRef>();
  for (const l of lanes) { const k = norm(l.label), had = byName.get(k); if (!had || better(l, had)) byName.set(k, l); }
  for (const l of lanes) { const k = norm(l.key); if (!byName.has(k)) byName.set(k, l); } // a SendMessage may address a lane by its agent id
  const actor = actorOver(byName); // shadows the alias-only default: lane refs resolve ids and labels to one actor
  const all = dedupeMessages(events, actor).filter(e => e.at <= now + 60_000).sort((a, b) => b.at - a.at); // newest first
  const delivered = all.filter(e => e.kind !== "spawn");

  // Edges: every kind but a bare `spawn` is a message; a spawn is the prompt itself, shown too (it is who-starts-whom).
  const em = new Map<string, MessageEdge>();
  for (const e of all) {
    const k = `${actor(e.from)}\u0000${actor(e.to)}`, x = em.get(k) ?? { from: e.from, to: e.to, hour: 0, all: 0, lastAt: 0, protocol: null };
    x.all++; if (now - e.at <= HOUR_MS) x.hour++;
    if (e.at >= x.lastAt) { x.lastAt = e.at; x.protocol = e.protocol; }
    em.set(k, x);
  }
  const edges = [...em.values()].sort((a, b) => b.lastAt - a.lastAt);

  // Answered: the recipient later sent anything back to the sender, or later sent a DONE/LANDABLE to anyone.
  const sendsBy = new Map<string, MessageEvent[]>();
  for (const e of all) if (e.kind === "send") { const k = actor(e.from), a = sendsBy.get(k) ?? []; a.push(e); sendsBy.set(k, a); }
  // A hand-back is a report, not a question: informational, never unanswered (a LOST one stays open and raises its own flag).
  const answered = (m: MessageEvent): boolean => m.kind === "handback" || (sendsBy.get(actor(m.to)) ?? []).some(s => s.at > m.at && (actor(s.to) === actor(m.from) || (s.protocol !== null && DONES.has(s.protocol))));

  const ib = new Map<string, InboxLane>();
  for (const m of delivered) {
    const known = byName.get(norm(m.to)), k = known ? norm(known.label) : actor(m.to), lane = ib.get(k) ?? { name: known?.label ?? m.to, key: known?.key ?? null, total: 0, unanswered: 0, items: [] };
    const a = answered(m);
    lane.total++; if (!a) lane.unanswered++;
    if (lane.items.length < MAX_INBOX) lane.items.push({ at: m.at, from: m.from, kind: m.kind, summary: m.summary, protocol: m.protocol, answered: a });
    ib.set(k, lane);
  }
  const inbox = [...ib.values()].sort((a, b) => b.unanswered - a.unanswered || (b.items[0]?.at ?? 0) - (a.items[0]?.at ?? 0));

  const flags: FlowFlag[] = [], seen = new Set<string>();
  const add = (f: Omit<FlowFlag, "laneKey">, dedupe: string) => { if (!seen.has(dedupe)) { seen.add(dedupe); flags.push({ ...f, laneKey: byName.get(norm(f.lane))?.key ?? null }); } };
  for (const e of delivered) {
    if (now - e.at > FLAG_WINDOW_MS) break; // sorted newest first
    if (e.kind === "handback-lost") add({ kind: "lost-handback", lane: e.to, other: e.from, at: e.at }, `l|${e.at}|${norm(e.from)}|${norm(e.to)}`);
    if (e.kind !== "send") continue;
    if (!byName.has(norm(e.to)) && !KNOWN_ALIASES.has(norm(e.to))) add({ kind: "unknown-recipient", lane: e.from, other: e.to, at: e.at }, `u|${norm(e.from)}|${norm(e.to)}`);
    if (e.protocol && DONES.has(e.protocol) && now - e.at >= ACK_MS && !(sendsBy.get(actor(e.to)) ?? []).some(s => s.at > e.at && actor(s.to) === actor(e.from)))
      add({ kind: "unacknowledged-done", lane: e.to, other: e.from, at: e.at }, `d|${norm(e.from)}|${norm(e.to)}|${e.at}`);
  }
  for (const l of inbox) {
    const lane = byName.get(norm(l.name));
    if (!lane || lane.state !== "idle" || lane.lastAt === null || now - lane.lastAt < IDLE_MS) continue;
    const it = l.items.find(i => !i.answered && now - i.at <= HOUR_MS && i.kind !== "handback-lost");
    if (it) add({ kind: "idle-unanswered", lane: l.name, other: it.from, at: it.at }, `i|${norm(l.name)}`);
  }
  flags.sort((a, b) => b.at - a.at);
  return { edges, inbox, flags: flags.slice(0, MAX_FLAGS) };
}
