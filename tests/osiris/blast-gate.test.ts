import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blastPlan, blastSilo, type BlastFrame } from "../../plugins/osiris/work/blast-model.ts";
import { BLAST_MAX_AGENTS, BLAST_MAX_TARGETS, buildTeamPlan } from "../../plugins/osiris/work/team-dispatch/plan.ts";

const tok = (id: string, built: boolean, gateRole: "review" | "held" = "held") =>
  ({ id, title: id, station: "gate", stage: "review", blocked: false, waitingOn: [], sinceMs: 1000, heatStep: null, gateRole, built }) as BlastFrame["tokens"][number];
const frame = (tokens: BlastFrame["tokens"]): BlastFrame => ({ heatMode: "age" as BlastFrame["heatMode"], tokens, workers: [], locks: [] });

test("Gate blast skips held beads that were never built (open + review label)", () => {
  const f = frame([tok("td-built", true), tok("td-unbuilt", false)]);
  assert.deepEqual(blastSilo(f, "gate").map(t => t.id), ["td-built"]);
  assert.equal(blastPlan(f, "gate", null).matching, 1);
});

test("Gate blast still excludes beads already under review", () => {
  assert.deepEqual(blastSilo(frame([tok("td-a", true, "review")]), "gate"), []);
});

test("one cap: a 9-item blast builds 9 workers and the cap constants agree", () => {
  assert.equal(BLAST_MAX_TARGETS, BLAST_MAX_AGENTS - 1);
  const cards = Array.from({ length: BLAST_MAX_TARGETS }, (_, i) => ({ id: `td-${i + 1}`, title: `t${i + 1}` }));
  const r = buildTeamPlan({ cards, workers: cards.length, preset: "gate" });
  assert.ok(r.ok && r.plan.workers.length === BLAST_MAX_TARGETS);
});

test("dialog shows the blast cap, not the 6-worker team cap, when a blast is open", () => {
  const src = readFileSync(new URL("../../plugins/osiris/work/herdr-dispatch/dialog.tsx", import.meta.url), "utf8");
  assert.match(src, /const maxWorkers = p\.blast \? BLAST_MAX_TARGETS : TEAM_MAX_WORKERS/);
  assert.doesNotMatch(src, /max=\{TEAM_MAX_WORKERS\}/);
  assert.doesNotMatch(src, /at most \{TEAM_MAX_WORKERS\}/);
});
