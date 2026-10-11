import { useEffect, useState } from "react";
import { makeSeqGuard } from "../shell/app-wiring.ts";
import type { PlanReply } from "../work/plan-windows.ts";

export type ModFeedCaller = { call(name: "modFeed", args: { limit?: number }): Promise<unknown> };
/** Polls the modFeed RPC every 30 s while `enabled` (paused while the tab is hidden; an older answer never overwrites a newer one). `null` = no answer (no feed, or the server build predates modFeed). */
export function usePlanWindows(rpc: ModFeedCaller, enabled: boolean): PlanReply | null {
  const [reply, setReply] = useState<PlanReply | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let off = false;
    const seq = makeSeqGuard();
    const load = () => {
      if (document.hidden) return;
      const n = seq.next();
      rpc.call("modFeed", { limit: 200 }).then(r => { if (!off && seq.accept(n)) setReply(r && typeof r === "object" ? (r as PlanReply) : null); }, () => { if (!off && seq.accept(n)) setReply(null); });
    };
    load();
    const t = setInterval(load, 30_000), vis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", vis);
    return () => { off = true; clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [rpc, enabled]);
  return reply;
}
