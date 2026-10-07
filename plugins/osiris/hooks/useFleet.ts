import { useEffect, useState } from "react";
import { makeSeqGuard } from "../shell/app-wiring.ts";
import type { FleetSnapshot } from "../work/fleet-types.ts";

export type FleetCaller = { call(name: "fleetSnapshot", args: Record<string, never>): Promise<unknown> };
export type FleetState = { fleet: FleetSnapshot | null; error: string | null };

/** The live fleet answer for every panel, tracker chosen or not: polls the repo-free `fleetSnapshot` RPC every 10 s (the server answers
 *  from the ONE transcript feed on its 5 s throttle, with bead ids from the newest tracker join), paused while the tab is hidden, numbered
 *  so an older answer never overwrites a newer one. Null until the first answer: the UI then says "reading", never 0. */
export function useFleet(rpc: FleetCaller, enabled: boolean): FleetState {
  const [state, setState] = useState<FleetState>({ fleet: null, error: null });
  useEffect(() => {
    if (!enabled) return;
    let off = false;
    const seq = makeSeqGuard();
    const load = () => {
      if (document.hidden) return;
      const n = seq.next();
      rpc.call("fleetSnapshot", {}).then(r => {
        if (off || !seq.accept(n)) return;
        const res = r as { ok: boolean; value?: FleetSnapshot; reason?: string } | null;
        setState(prev => res?.ok && res.value ? { fleet: res.value, error: null } : { fleet: prev.fleet, error: res?.reason ?? "Could not read the agent fleet." });
      }, e => { if (!off && seq.accept(n)) setState(prev => ({ fleet: prev.fleet, error: String((e as Error)?.message ?? e) })); });
    };
    load();
    const t = setInterval(load, 10_000), vis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", vis);
    return () => { off = true; clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [rpc, enabled]);
  return enabled ? state : { fleet: null, error: null };
}
