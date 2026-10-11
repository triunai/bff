import { planView } from "../../work/plan-windows.ts";
import type { PlanReply } from "../../work/plan-windows.ts";

/** Calls > Cost & cache: the 5-hour and weekly plan windows with reset countdown and run-out forecast (headroom maths, see work/plan-windows.ts). No feed, no numbers. */
export function PlanWindowsTiles({ reply, now }: { reply: PlanReply | null; now: number }) {
  const v = planView(reply, now);
  if (v.state !== "ok") return <div className="oi-ov-card" title="Your plan's 5-hour and weekly usage limits, read from the osiris-bridge mod."><span className="oi-ov-title">Plan windows</span><span className="oi-ov-num">—</span><span className="oi-ov-sub" title={v.note}>{v.note}</span></div>;
  return <>{v.tiles.map(t => <div key={t.kind} className="oi-ov-card" title={v.note || "Percent of the plan window used, from the engine's rate-limit readings. The forecast is the recent burn rate carried forward."}>
    <span className="oi-ov-title">{t.title}</span><span className={`oi-ov-num${t.bad ? " oi-cc-bad" : ""}`}>{t.value}</span><span className="oi-ov-sub" title={t.sub}>{t.sub}{v.note ? " · feed may lag" : ""}</span></div>)}</>;
}
