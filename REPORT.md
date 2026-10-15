# Blast gate: contradictory counts and unbuilt "waiting items" (td-rk5.19)

Branch `fix/blast-gate-counts`, from origin/main e9bd6be. Repo: bff, `plugins/osiris`.

## Bug 1: worker counts disagree
- `work/herdr-dispatch/dialog.tsx:100` hard-coded `TEAM_MAX_WORKERS` (6) in the input `max` and the "at most N workers" note, and in the `onChange` clamp.
- The `count` state (line 37) was clamped to the blast cap (9 = `BLAST_MAX_TARGETS`, `team-dispatch/blast-silos.ts:10-11`), so "Worker count 9" sat next to "at most 6 workers" and "1 lead + 9 workers".
- Fix: one `maxWorkers = p.blast ? BLAST_MAX_TARGETS : TEAM_MAX_WORKERS`, used by the state, the input and the note.

## Bug 2: Gate blast picked unbuilt beads
- `work/blast-model.ts:46` took every token with `station === "gate" && gateRole === "held"`.
- The Gate station is label-only: `isReview` (`surface-model.ts:22`) is `status !== "closed"` plus a review label (needs-dual-gate, reconciled, ready-to-land). An `open` bead that carries one of those labels is at the Gate and, past the reviewer threshold, "held", so it was blasted.
- Fix: `FactoryCard.built` / `FloorToken.built` (= `status === "in_progress"`); the Gate blast requires `built`. The intended review-ready state was unclear in the code, so it is made explicit here: in_progress + review label. If another status should count (e.g. blocked/deferred), change `built` in `factory-model.ts`.
- Not changed: the floor still DRAWS those open+labelled beads at the Gate (display unchanged). Whether they should be there is a separate call.

## Tests
`tests/osiris/blast-gate.test.ts`: 2 of 4 fail before the fix (unbuilt bead selected; dialog uses the team cap), all 4 pass after.

## Gates
- `npm run test:osiris`: 21 pass, 2 fail. The 2 failures (analytics "shared fixtures", server.test.mjs) fail identically on origin/main.
- `tsc --noEmit`: no `tsc` in this worktree; ran TypeScript 6.0.3 borrowed from another repo: 144 output lines, none in the touched files (pre-existing environment noise).
- Could NOT verify: the dialog in a browser (no Chrome tooling allowed); the `built` flag against live bd data.
