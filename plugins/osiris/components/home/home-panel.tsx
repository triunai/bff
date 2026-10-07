import { useEffect, useMemo, useState } from "react";
import { callKey, type Call } from "../../analytics.ts";
import type { Incident } from "../../triage.ts";
import { incidentRows } from "../../work/tool-dashboard-model.ts";
import { homeView, type HomeInputs } from "../../work/home-model.ts";
import type { LedgerRead } from "../../work/fleet-ledger.ts";
import type { FleetLane } from "../../work/fleet-types.ts";
import type { WorkSurfaceSnapshot } from "../../work/surface-types.ts";
import { decisionsWaiting } from "../../work/surface-model.ts";
import { rangeLabel, type RangeId } from "../../work/calls-range.ts";
import { HomeCanvas, type HomeTarget } from "./home-canvas.tsx";

type Rpc = { call(name: string, input: unknown): Promise<unknown> };
export interface HomePanelProps {
  rpc: Rpc; repo: string; now: number; snap: WorkSurfaceSnapshot | null; range: RangeId; onRange(r: RangeId): void;
  fleet: HomeInputs["fleet"]; telemetry: HomeInputs["telemetry"]; healthRows: HomeInputs["healthRows"]; status: HomeInputs["status"]; commits: HomeInputs["commits"];
  calls: readonly Call[]; incidents: readonly Incident[]; neighbours(c: Call): Call[];
  onOpen(t: HomeTarget): void; onOpenCommit(sha: string): void; onAnswer(beadId: string): void; onGoToPane(lane: FleetLane): void;
}

/** Home: gathers what the app already holds (no second fetch of anything but the run ledger) and hands it to the pure model. */
export function HomePanel(p: HomePanelProps) {
  const [ledger, setLedger] = useState<LedgerRead | null>(null);
  useEffect(() => {
    if (!p.repo) { setLedger(null); return; }
    let off = false;
    p.rpc.call("fleetIncidents", { repo: p.repo }).then(r => { if (!off) setLedger(r as LedgerRead); }, () => { if (!off) setLedger({ state: "invalid", reason: "the read failed" }); });
    return () => { off = true; };
  }, [p.rpc, p.repo]);
  const byKey = useMemo(() => new Map(p.calls.map(c => [callKey(c), c] as const)), [p.calls]);
  const view = useMemo(() => {
    const problems = incidentRows(p.incidents, p.calls, p.now, "events").map(r => ({ ...r, callKey: p.incidents.find(i => i.fingerprint === r.fingerprint)?.callKeys.at(-1) ?? null }));
    return homeView({ now: p.now, decisions: p.snap ? decisionsWaiting(p.snap, p.now) : [], fleet: p.fleet, telemetry: p.telemetry, windowLabel: rangeLabel(p.range), healthRows: p.healthRows, problems,
      status: p.status, commits: p.commits, beadIds: p.snap?.issues.map(i => i.id) ?? [], ledger });
  }, [p.now, p.snap, p.fleet, p.telemetry, p.range, p.healthRows, p.incidents, p.calls, p.status, p.commits, ledger]);
  const callOf = (key: string | null) => { const call = key ? byKey.get(key) : undefined; return call ? { call, neighbours: p.neighbours(call) } : null; };
  return <HomeCanvas view={view} snap={p.snap} now={p.now} range={p.range} onRange={p.onRange} callOf={callOf} onOpen={p.onOpen} onOpenCommit={p.onOpenCommit} onAnswer={p.onAnswer} onGoToPane={p.onGoToPane} />;
}
