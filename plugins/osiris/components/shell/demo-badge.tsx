import { DEMO_BADGE } from "../../demo/constants.ts";
import { useDemoOn } from "../../demo/client.ts";

/** Always visible in the header while demo data is shown, so nobody mistakes the synthetic board for their own work. */
export function DemoBadge() {
  return useDemoOn() ? <span className="oi-demo-badge" role="status" title="Everything on screen is synthetic. Use View, Exit demo data to leave.">{DEMO_BADGE}</span> : null;
}
export const demoBadgeStyles = `.oi-demo-badge{display:inline-flex;align-items:center;height:16px;padding:0 6px;border:1px solid var(--oi-accent);border-radius:3px;color:var(--oi-accent);font-size:9px;font-weight:700;letter-spacing:.08em}`;
