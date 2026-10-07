import { useEffect, useMemo, useRef, useState } from "react";
import { historyFromTimestamps } from "../../work/surface-model.ts";
import { buildGraphModel } from "../../work/graph/graph.ts";
import { toBeadIssues } from "../../work/graph/adapter.ts";
import { blockChain, chainRoles } from "../../work/block-chain.ts";
import type { HeatMode } from "../../work/factory-floor-model.ts";
import { STATION_TEXT, elapsedText, floorAt, floorLine, groupKey, trailOf, type FloorFrame, type StationId } from "../../work/factory-floor-model.ts";
import { isoFxOf, pulsesOf, stationStats, tipLines, type PulseKind } from "../../work/iso-layout.ts";
import type { FactoryFloor } from "./factory-floor.tsx";
import { IsoStage, isoStageStyles, type IsoHover } from "./iso-stage.tsx";

/** The isometric Factory as a STANDALONE view: it computes its own frame (floorAt with silo widths) and hands it to IsoStage, then
 * adds what the shell would otherwise own: a one-line summary, the hover card and a short key. It takes FactoryFloor's props (by
 * type, so they cannot drift) plus an optional time. A shell that already holds the frame mounts IsoStage directly instead.
 * Arrows: solid = waits on, dashed = waits on it; the hovered (else selected) bead's chain is lit and the rest dims. */
type FloorProps = Parameters<typeof FactoryFloor>[0];
/** `look`: "cyberpunk" (default) sets data-oi-factory-look on the root so the scoped Cyberpunk palette (fg-machines' factoryLookStyles: --oi-machine-body and --oi-station-<id>) applies to THIS view only; "app" leaves the user's chosen theme. `archived`: the Land vault's count (omit = no vault). */
export type FactoryIsoProps = FloorProps & { at?: number | null; look?: "cyberpunk" | "app"; archived?: number | null; archivedToday?: number | null; archivedDelta?: number | null; heat?: HeatMode | null };

const RIDE_MS = 4000;
const reducedMotion = () => { try { return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export function FactoryIso(p: FactoryIsoProps) {
  const { snap, now } = p;
  const [reduced, setReduced] = useState(reducedMotion);
  const [hover, setHover] = useState<IsoHover | null>(null);
  const [fresh, setFresh] = useState<ReadonlyMap<string, { kind: PulseKind; until: number }>>(() => new Map()); // what each crate just did, kept for a moment (ONE timer for all)
  const [stn, setStn] = useState<{ id: StationId; x: number; y: number } | null>(null);
  const prevRef = useRef<FloorFrame | null>(null);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const q = matchMedia("(prefers-reduced-motion: reduce)"), on = () => setReduced(q.matches);
    q.addEventListener?.("change", on); return () => q.removeEventListener?.("change", on);
  }, []);
  const events = useMemo(() => historyFromTimestamps(snap), [snap]);
  const graph = useMemo(() => buildGraphModel(toBeadIssues(snap)), [snap]);
  const t = p.at ?? now;
  const frame = useMemo(() => floorAt(snap, events, t, now, { prev: prevRef.current, reducedMotion: true, silos: true, heat: p.heat ?? "age", graph, thresholds: p.thresholds ?? null, critical: p.critical ?? null, costs: p.costs ?? null, scopeWaits: p.scopeWaits ?? null, transcriptLive: p.transcriptLive ?? null }), [snap, events, t, now, graph, p.heat, p.thresholds, p.critical, p.costs, p.scopeWaits, p.transcriptLive]);
  useEffect(() => { prevRef.current = frame; }, [frame]);
  useEffect(() => { // a bead that just moved plays its one effect for RIDE_MS (sent-back ones also ride the return lane), then the entry is dropped
    const now0 = pulsesOf(frame);
    if (!now0.size) return;
    const until = Date.now() + RIDE_MS; setFresh(m => { const n = new Map(m); for (const [id, kind] of now0) n.set(id, { kind, until }); return n; });
    const id = setTimeout(() => setFresh(m => new Map([...m].filter(([, v]) => v.until > Date.now()))), RIDE_MS + 50);
    return () => clearTimeout(id);
  }, [frame]);
  const live = useMemo(() => [...fresh].filter(([, v]) => v.until > Date.now()), [fresh, frame]); // eslint-disable-line react-hooks/exhaustive-deps
  const pulses = useMemo(() => (reduced ? new Map<string, PulseKind>() : new Map(live.map(([id, v]) => [id, v.kind] as const))), [live, reduced]);
  const lane = useMemo(() => new Set(live.filter(([, v]) => v.kind === "back").map(([id]) => id)), [live]);
  const fx = useMemo(() => isoFxOf(frame, now), [frame, now]);
  const tokenAt = useMemo(() => new Map(frame.tokens.map(k => [k.id, k])), [frame]);
  const where = (id: string): StationId | null => tokenAt.get(id)?.station ?? null;
  const done = (id: string) => where(id) === "land" || (!tokenAt.has(id) && graph.nodes.find(n => n.id === id)?.status === "closed");
  const hovered = hover ? tokenAt.get(hover.id) ?? null : null;
  const focusId = hovered?.id ?? (p.selectedId && tokenAt.has(p.selectedId) ? p.selectedId : null);
  const chain = useMemo(() => (focusId ? blockChain(graph, focusId, id => (tokenAt.get(id)?.station ?? null) === "land" || (!tokenAt.has(id) && graph.nodes.find(n => n.id === id)?.status === "closed")) : null), [focusId, graph, tokenAt]);
  const roles = useMemo(() => chainRoles(chain, frame.tokens.map(k => k.id)), [chain, frame]);
  const trail = useMemo(() => (hovered ? trailOf(snap, events, hovered.id, t, now) : []), [hovered?.id, snap, events, t, now]); // eslint-disable-line react-hooks/exhaustive-deps
  const groupOf = useMemo(() => new Map(groupKey(frame).map(g => [g.tone, g.label])), [frame]);
  const worker = hovered ? frame.workers.find(w => w.beadId === hovered.id) ?? null : null;
  const empty = frame.stations.every(s => s.count === 0);
  return <div className="oi-iso" data-oi-factory-look={p.look === "app" ? undefined : "cyberpunk"}>
    <div className="oi-iso-line" aria-live="polite">{empty ? "No work items on the floor." : floorLine(frame)}</div>
    <div className="oi-iso-stage">
      <IsoStage frame={frame} selectedId={p.selectedId} onSelect={p.onSelect} onHover={setHover} chainEdges={chain?.edges ?? []} roles={roles} reduced={reduced} fx={fx} lane={lane} pulses={pulses} hoverId={hovered?.id ?? null} onStation={setStn} hoverStation={stn?.id ?? null} archived={p.archived ?? null} archivedToday={p.archivedToday ?? null} archivedDelta={p.archivedDelta ?? null} heat={p.heat ?? null} />
    </div>
    <div className="oi-iso-legend">
      <span>crate = one work item at its station</span>
      <span className="oi-iso-t-failure">red crate with ⊘ and a padlock = waiting or locked</span>
      <span className="oi-iso-t-accent">dashed ring = critical path</span>
      <span>bot = an agent (letter = model)</span>
      <span>arrows: solid = waits on, dashed = waits on it</span>
    </div>
    {stn && !hovered && (() => { const st = frame.stations.find(x => x.id === stn.id)!, n = stationStats(frame)[stn.id];
      return <div className="oi-iso-tip" style={{ left: Math.min(stn.x + 14, (typeof innerWidth === "number" ? innerWidth : 1200) - 340), top: stn.y + 14 }}>
        <span className="oi-iso-tip-head">{STATION_TEXT[stn.id].label}: {st.count} here</span>
        <span className="oi-iso-tip-muted">{STATION_TEXT[stn.id].sub}</span>
        {stn.id !== "land" && <span className="oi-iso-tip-plain">{n.waiting} waiting · {n.working} in progress{st.overflow > 0 ? ` · ${st.overflow} not drawn` : ""}</span>}
        {n.oldestMs !== null && <span className="oi-iso-tip-plain">oldest here {elapsedText(n.oldestMs)} · typical {elapsedText(n.p50Ms)}</span>}
        <span className={st.bottleneck ? "oi-iso-tip-failure" : "oi-iso-tip-muted"}>{st.bottleneck ? `over its limit of ${st.threshold}` : Number.isFinite(st.threshold) ? `limit ${st.threshold}` : "no limit"}</span>
      </div>; })()}
    {hovered && hover && hover.x >= 0 && <div className="oi-iso-tip" style={{ left: Math.min(hover.x + 14, (typeof innerWidth === "number" ? innerWidth : 1200) - 340), top: hover.y + 14 }}>
      {tipLines(hovered, { frame, epic: groupOf.get(hovered.group) ?? frame.factory.rows.find(r => r.toneIndex === hovered.group)?.label ?? null, trail, where, done, via: worker?.via ?? null, clock }).map((l, k) => <span key={k} className={`oi-iso-tip-${l.tone}`}>{l.text}</span>)}
    </div>}
  </div>;
}

export const factoryIsoStyles = `${isoStageStyles}
.oi-iso{display:flex;flex-direction:column;min-width:0;font:13px system-ui,sans-serif;color:var(--oi-text)}
.oi-iso-line{padding:8px 12px;font:12px ui-monospace,monospace;color:var(--oi-tone-muted)}
.oi-iso-stage{position:relative;margin:0 12px;border:1px solid var(--oi-border);border-radius:10px;overflow:hidden;background:radial-gradient(ellipse at 50% 62%,color-mix(in srgb,var(--oi-raised) 40%,var(--oi-bg)),var(--oi-bg) 78%)}
.oi-iso-legend{display:flex;gap:6px 16px;flex-wrap:wrap;padding:6px 12px;font-size:11px;color:var(--oi-tone-muted);opacity:.8}
.oi-iso-t-failure{color:var(--oi-tone-failure)}.oi-iso-t-accent{color:var(--oi-accent,var(--oi-tone-info))}
.oi-iso-tip[hidden]{display:none}
.oi-iso-tip{position:fixed;z-index:50;pointer-events:none;display:flex;flex-direction:column;gap:2px;max-width:340px;padding:8px 10px;border-radius:8px;background:var(--oi-raised);color:var(--oi-text);font-size:12px;box-shadow:var(--oi-shadow-raised,0 4px 14px var(--oi-shadow))}
.oi-iso-tip-head{font-weight:700;color:var(--oi-text)}.oi-iso-tip-muted{color:var(--oi-tone-muted)}.oi-iso-tip-plain{font:11px ui-monospace,monospace;color:var(--oi-text)}
.oi-iso-tip-failure{color:var(--oi-tone-failure)}.oi-iso-tip-running{color:var(--oi-tone-running)}.oi-iso-tip-attention{color:var(--oi-tone-attention)}
`;
