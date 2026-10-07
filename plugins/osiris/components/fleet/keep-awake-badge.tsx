import { useEffect, useState } from "react";
import { keepAwakeTooltip } from "../../work/keep-awake.ts";

export type KeepAwakeCaller = { call(name: "keepAwakeStatus", args: Record<string, never>): Promise<unknown> };
type Status = { supported: boolean; enabled: boolean; active: boolean; live: number };

/** Top-bar coffee glyph, shown only while Osiris is actually holding the Mac awake (macOS, setting on, agents live). Polls the server every 15 s. */
export function KeepAwakeBadge({ rpc }: { rpc: KeepAwakeCaller }) {
  const [st, setSt] = useState<Status | null>(null);
  useEffect(() => {
    let off = false;
    const load = () => { if (document.hidden) return; rpc.call("keepAwakeStatus", {}).then(r => { if (!off) setSt(r as Status); }, () => { if (!off) setSt(null); }); };
    load();
    const t = setInterval(load, 15_000);
    return () => { off = true; clearInterval(t); };
  }, [rpc]);
  if (!st?.supported || !st.enabled || !st.active) return null;
  const tip = keepAwakeTooltip(st.live);
  return <span role="img" aria-label={tip} title={tip} style={{ cursor: "default", marginRight: 6 }}>☕</span>;
}
