import { useEffect, useMemo, useState } from "react";
import { makeSeqGuard } from "../shell/app-wiring.ts";
import { DEFAULT_RANGE } from "../work/calls-range.ts";
import type { RangeId } from "../work/calls-range.ts";
import { telemetryMaps } from "../work/telemetry-model.ts";
import type { TelemetryMaps, WorkTelemetry } from "../work/telemetry-model.ts";

export type TelemetryCaller = { call(name: "workTelemetry", args: { repo: string; range?: RangeId }): Promise<unknown> };
export type WorkTelemetryState = { telemetry: WorkTelemetry | null; error: string | null; maps: TelemetryMaps | null };

/** Polls the workTelemetry RPC for one repo while `enabled` (every 10 s, paused while the tab is hidden, numbered so an older answer
 *  never overwrites a newer one). Cost, critical path and live lanes stay null until the first answer: the Factory then says "not connected". */
export function useWorkTelemetry(rpc: TelemetryCaller, repo: string, enabled: boolean, range: RangeId = DEFAULT_RANGE): WorkTelemetryState {
  const [state, setState] = useState<{ repo: string; telemetry: WorkTelemetry | null; error: string | null }>({ repo: "", telemetry: null, error: null });
  useEffect(() => {
    if (!enabled || !repo) return;
    let off = false;
    const seq = makeSeqGuard();
    const load = () => {
      if (document.hidden) return;
      const n = seq.next();
      rpc.call("workTelemetry", { repo, range }).then(r => {
        if (off || !seq.accept(n)) return;
        const res = r as { ok: boolean; value?: WorkTelemetry; reason?: string } | null;
        setState(res?.ok && res.value ? { repo, telemetry: res.value, error: null } : { repo, telemetry: null, error: res?.reason ?? "Could not read cost data." });
      }, e => { if (!off && seq.accept(n)) setState({ repo, telemetry: null, error: String((e as Error)?.message ?? e) }); });
    };
    load();
    const t = setInterval(load, 10_000), vis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", vis);
    return () => { off = true; clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [rpc, repo, enabled, range]);
  const mine = enabled && state.repo === repo ? state : { repo, telemetry: null, error: null };
  const maps = useMemo(() => telemetryMaps(mine.telemetry), [mine.telemetry]);
  return { telemetry: mine.telemetry, error: mine.error, maps };
}
