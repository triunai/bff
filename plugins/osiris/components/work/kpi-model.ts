// Pure model for the compact KPI strip: READY n · ACTIVE n/m · BLOCKED n (oldest) · REVIEW n · STALE n. Values come from kpis(); nothing is recomputed.
import { formatAge } from "../../work/surface-model.ts";
import type { Kpis } from "../../work/surface-types.ts";
import type { KpiKey } from "../../work/ui-text.ts";

export type KpiChip = { key: Exclude<KpiKey, "collision">; label: string; value: string; note: string | null };

export function kpiChips(k: Kpis): KpiChip[] {
  return [
    { key: "ready", label: "READY", value: String(k.ready), note: null },
    { key: "active", label: "ACTIVE", value: `${k.active}/${k.activeCap}`, note: null },
    { key: "blocked", label: "BLOCKED", value: String(k.blocked), note: k.blockedOldestMs === null ? null : `oldest ${formatAge(k.blockedOldestMs)}` },
    { key: "review", label: "REVIEW", value: String(k.review), note: null },
    { key: "stale", label: "STALE", value: String(k.stale), note: null },
  ];
}
