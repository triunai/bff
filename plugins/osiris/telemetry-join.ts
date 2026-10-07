/**
 * Joins transcript units to work: per bead and per lane, tokens + cost + hit % + misses + model.
 * The shared key is the LANE NAME, which appears as (a) the bead claim actor, (b) the subagent
 * transcript name, (c) the Herdr pane title. Join order is exact-first and never guesses:
 *   1. bead claim actor / assignee == lane name (unique bead only)
 *   2. a `bead=<id>` tag found in the transcript (the tag only, never text)
 *   3. a pane carrying the same lane name whose title leads with a bead's short id
 *   else unmatched, listed with a reason. Pure; no fs.
 */
import { aggregate } from "./cache-economics.ts";
import type { UsageRow } from "./cache-economics.ts";
import { analyzeUnit } from "./cache-misses.ts";
import type { MissEvent, MissOptions } from "./cache-misses.ts";

export interface TelemetryUnit {
    /** Lane name as found in the transcript, or null (main session, or an anonymous subagent). */
    lane: string | null;
    sessionId: string;
    agentId: string | null;
    rows: UsageRow[];
    /** The `bead=<id>` value if the transcript carried one. */
    beadTag: string | null;
}
export interface BeadRef { id: string; assignee: string | null; claimActor?: string | null }
export interface PaneRef { paneId?: string; title: string; lane?: string | null }

export type JoinVia = "actor" | "tag" | "pane";
export interface Telemetry {
    requests: number;
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    hitRate: number | null;
    missTokens: number;
    /** Dollars, or null when any model was unpriced. Never a silent $0. */
    cost: number | null;
    pricedCost: number;
    missEvents: MissEvent[];
    models: string[];
    /** Model with the most requests. */
    model: string | null;
}
export interface LaneTelemetry extends Telemetry { lane: string; sessionId: string; agentId: string | null; beadId: string | null; via: JoinVia | null; paneId: string | null }
export interface BeadTelemetry extends Telemetry { beadId: string; lanes: string[]; via: JoinVia[] }
export interface Unmatched { lane: string | null; sessionId: string; agentId: string | null; reason: "no-lane-name" | "no-match" | "ambiguous" }
export interface JoinResult {
    byBead: BeadTelemetry[];
    byLane: LaneTelemetry[];
    unmatched: Unmatched[];
    coverage: { lanes: number; matched: number; laneNamed: number };
}

/** `td-osi.21` -> `osi.21`, mirroring paneTitleFor's shortId (a pane title is `<shortId> · <title>`). */
export const shortBeadId = (id: string) => id.replace(/^[a-z]+-/i, "");
export const paneShortId = (title: string) => title.split(" · ")[0].trim();

function telemetryOf(rows: UsageRow[], miss: MissOptions | undefined): Telemetry {
    const u = aggregate(rows, () => "all")[0];
    const counts = new Map<string, number>();
    for (const r of rows)
        if (r.model)
            counts.set(r.model, (counts.get(r.model) ?? 0) + 1);
    const models = [...counts.keys()].sort(), top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const m = analyzeUnit("all", rows, miss);
    return u
        ? { requests: u.requests, input: u.input, output: u.output, cacheWrite: u.cacheWrite5m + u.cacheWrite1h, cacheRead: u.cacheRead, hitRate: u.hitRate, missTokens: m.missTokens, cost: u.cost, pricedCost: u.pricedCost, missEvents: m.missEvents, models, model: top?.[0] ?? null }
        : { requests: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, hitRate: null, missTokens: 0, cost: 0, pricedCost: 0, missEvents: [], models: [], model: null };
}

export function joinUnitsToWork(units: TelemetryUnit[], beads: BeadRef[], panes: PaneRef[], miss?: MissOptions): JoinResult {
    const beadIds = new Set(beads.map(b => b.id));
    const byActor = new Map<string, Set<string>>();
    for (const b of beads)
        for (const who of [b.claimActor, b.assignee])
            if (who)
                (byActor.get(who) ?? byActor.set(who, new Set()).get(who)!).add(b.id);
    const byShort = new Map<string, string[]>();
    for (const b of beads)
        (byShort.get(shortBeadId(b.id)) ?? byShort.set(shortBeadId(b.id), []).get(shortBeadId(b.id))!).push(b.id);

    const byLane: LaneTelemetry[] = [], unmatched: Unmatched[] = [];
    for (const u of units) {
        let beadId: string | null = null, via: JoinVia | null = null, paneId: string | null = null, ambiguous = false;
        const pane = u.lane ? panes.find(p => p.lane === u.lane) : undefined;
        paneId = pane?.paneId ?? null;
        const actors = u.lane ? byActor.get(u.lane) : undefined;
        if (actors?.size === 1) { beadId = [...actors][0]; via = "actor"; }
        else if (actors && actors.size > 1)
            ambiguous = true;
        if (!beadId && u.beadTag && beadIds.has(u.beadTag)) { beadId = u.beadTag; via = "tag"; ambiguous = false; }
        if (!beadId && pane) {
            const hits = byShort.get(paneShortId(pane.title)) ?? [];
            if (hits.length === 1) { beadId = hits[0]; via = "pane"; ambiguous = false; }
        }
        const t = telemetryOf(u.rows, miss);
        if (!beadId)
            unmatched.push({ lane: u.lane, sessionId: u.sessionId, agentId: u.agentId, reason: ambiguous ? "ambiguous" : u.lane ? "no-match" : "no-lane-name" });
        byLane.push({ ...t, lane: u.lane ?? `main:${u.sessionId}`, sessionId: u.sessionId, agentId: u.agentId, beadId, via, paneId });
    }

    const groups = new Map<string, TelemetryUnit[]>();
    byLane.forEach((l, i) => { if (l.beadId) (groups.get(l.beadId) ?? groups.set(l.beadId, []).get(l.beadId)!).push(units[i]); });
    const byBead: BeadTelemetry[] = [...groups].map(([beadId, us]) => {
        const lanes = byLane.filter(l => l.beadId === beadId);
        return { ...telemetryOf(us.flatMap(x => x.rows), miss), beadId, lanes: lanes.map(l => l.lane).sort(), via: [...new Set(lanes.map(l => l.via!))].sort() };
    }).sort((a, b) => (b.pricedCost - a.pricedCost) || a.beadId.localeCompare(b.beadId));
    return { byBead, byLane, unmatched, coverage: { lanes: units.length, matched: byLane.filter(l => l.beadId).length, laneNamed: units.filter(u => u.lane).length } };
}
