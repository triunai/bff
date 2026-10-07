// The shape of demo/profile.json: AGGREGATE STATISTICS ONLY. Every leaf is a number (or a fixed-length array of numbers) under a key
// that is written here, so a profile can carry no title, id, name, path, branch or message by construction. The profile script
// (scripts/demo-profile.mjs) validates its output against this before writing, and demo.test.ts validates the committed file.
// Pure data and one pure function: no node imports, no I/O.

import { PROVIDER_IDS } from "../work/providers/registry.ts";
import type { ProviderId } from "../work/providers/registry.ts";

type Leaf = "n" | { arr: number };
export type Shape = Leaf | { [key: string]: Shape };
const n: Leaf = "n", arr = (len: number): Leaf => ({ arr: len });
export const DAYS = 30, WEEKS = 8;
const keys = (...k: string[]): Shape => Object.fromEntries(k.map(x => [x, n]));

export const PROFILE_SCHEMA: Shape = {
  schema: n,
  beads: { total: n, byStatus: keys("open", "in_progress", "closed", "blocked", "deferred"), byPriority: keys("p0", "p1", "p2", "p3", "p4"), byType: keys("epic", "task", "bug", "decision", "feature", "chore") },
  epics: { count: n, sizeBuckets: keys("s1to3", "s4to7", "s8to15", "s16plus") },
  deps: { maxDepth: n, byDepth: keys("d0", "d1", "d2", "d3plus"), blockEdgesPerBead: n },
  commits: { perDay: arr(DAYS), branchShare: keys("top1", "top2", "top3", "rest"), typeMix: keys("feat", "fix", "docs", "chore", "test", "refactor", "perf", "style", "merge", "other"), repos: n },
  decisions: { perWeek: arr(WEEKS) },
  threads: { perDay: arr(DAYS), byStatus: keys("active", "parked", "other", "debt", "done") },
  agents: { byRole: keys("main", "lead", "worker", "reviewer"), byModel: keys("opus", "sonnet", "fable", "haiku", "other"), byRuntime: keys(...PROVIDER_IDS) },
  cost: { perDayUsd: keys("min", "median", "max"), byModelShare: keys("opus", "sonnet", "fable", "haiku", "other"), cacheHit: keys("lo", "hi") },
  durations: { beadCycleHours: keys("p50", "p90"), sessionMinutes: keys("p50", "p90"), callSeconds: keys("p50", "p90") },
};

export interface Profile {
  schema: number;
  beads: { total: number; byStatus: Record<"open" | "in_progress" | "closed" | "blocked" | "deferred", number>; byPriority: Record<"p0" | "p1" | "p2" | "p3" | "p4", number>; byType: Record<"epic" | "task" | "bug" | "decision" | "feature" | "chore", number> };
  epics: { count: number; sizeBuckets: Record<"s1to3" | "s4to7" | "s8to15" | "s16plus", number> };
  deps: { maxDepth: number; byDepth: Record<"d0" | "d1" | "d2" | "d3plus", number>; blockEdgesPerBead: number };
  commits: { perDay: number[]; branchShare: Record<"top1" | "top2" | "top3" | "rest", number>; typeMix: Record<"feat" | "fix" | "docs" | "chore" | "test" | "refactor" | "perf" | "style" | "merge" | "other", number>; repos: number };
  decisions: { perWeek: number[] };
  threads: { perDay: number[]; byStatus: Record<"active" | "parked" | "other" | "debt" | "done", number> };
  agents: { byRole: Record<"main" | "lead" | "worker" | "reviewer", number>; byModel: Record<"opus" | "sonnet" | "fable" | "haiku" | "other", number>; byRuntime: Record<ProviderId, number> };
  cost: { perDayUsd: Record<"min" | "median" | "max", number>; byModelShare: Record<"opus" | "sonnet" | "fable" | "haiku" | "other", number>; cacheHit: Record<"lo" | "hi", number> };
  durations: { beadCycleHours: Record<"p50" | "p90", number>; sessionMinutes: Record<"p50" | "p90", number>; callSeconds: Record<"p50" | "p90", number> };
}

/** Every way `v` departs from the schema (unknown or missing key, a string, a non-finite or negative number, a wrong array length). [] = valid. */
export function validateProfile(v: unknown, shape: Shape = PROFILE_SCHEMA, at = "profile"): string[] {
  if (shape === "n") return typeof v === "number" && Number.isFinite(v) && v >= 0 ? [] : [`${at}: not a finite non-negative number`];
  if ("arr" in shape && typeof shape.arr === "number") return Array.isArray(v) && v.length === shape.arr ? v.flatMap((x, i) => validateProfile(x, "n", `${at}[${i}]`)) : [`${at}: not an array of ${shape.arr} numbers`];
  if (!v || typeof v !== "object" || Array.isArray(v)) return [`${at}: not an object`];
  const want = Object.keys(shape as object), got = Object.keys(v), out: string[] = [];
  for (const k of got) if (!want.includes(k)) out.push(`${at}.${k}: key is not in the schema`);
  for (const k of want) out.push(...(k in v ? validateProfile((v as Record<string, unknown>)[k], (shape as Record<string, Shape>)[k], `${at}.${k}`) : [`${at}.${k}: missing`]));
  return out;
}
