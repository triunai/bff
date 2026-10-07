// Health ↔ Work link (owner 19:08): Health's "owner decisions waiting" blocker row and the Work surface's "Decisions waiting
// on you" panel show the SAME count from ONE source, decisionsWaiting(), whenever a Work snapshot exists for the repo Health
// is reading. Without one, Health keeps its own row (the spine's focus gates) unchanged.
import type { HealthRow } from "../health-types.ts";
import { orderRows } from "../health-model.ts";
import type { WorkSurfaceSnapshot } from "./surface-types.ts";
import { decisionsWaiting, formatAge } from "./surface-model.ts";

export function withBeadsDecisions(rows: HealthRow[], snap: WorkSurfaceSnapshot | null, now: number): HealthRow[] {
  if (!snap) return rows;
  const d = decisionsWaiting(snap, now), n = d.length, top = d[0];
  const row: HealthRow = {
    id: "owner-decisions", group: "blocker", status: n > 0 ? "warn" : "pass", title: "Owner decisions",
    figure: n === 0 ? "nothing waiting on you" : `${n} decision${n === 1 ? "" : "s"} waiting on you · oldest ${formatAge(Math.max(...d.map(x => x.waitingMs)))}`,
    why: n > 0 ? `Work gated on you cannot move until you decide${top && top.deferredSessions > 0 ? `; the longest has been carried over ${top.deferredSessions} session${top.deferredSessions === 1 ? "" : "s"}` : ""}.` : "",
    fix: n > 0 ? { label: "Open Work and answer the top one in “Decisions waiting on you”" } : null,
    metric: n,
    ...(n ? { detail: d.slice(0, 5).map(x => `${x.shortId} · ${x.title}`).join("\n") } : {}),
  };
  return orderRows([...rows.filter(r => r.id !== "owner-decisions"), row]);
}
