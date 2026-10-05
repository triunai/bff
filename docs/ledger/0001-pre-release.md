# 0001 — Pre-release foundations

Date: 2026-10-05 (backfilled; the work happened before the public repo existed) · Version: pre-release

This entry is reconstructed from `ARCHITECTURE.md`, `PROVENANCE.md`, the first commit and what the owner told us. The earlier private history is deliberately not in this repo, so this entry is short on detail on purpose.

## What changed
Three ideas existed before BFF was a package:
- A working method for repos: a "Doc-Spine" (state boards, hot state, decisions, findings), one router file (`hygiene.md`) that says what to do in what order, task contracts for agents, independent reviews and coordinated session wraps. It grew from earlier private workflows (a PrimeStack/BB-based setup).
- Osiris: a workbench plugin for BB. Native chat sits in the centre, Work on the left, current-workspace Changes on the right, and a separate Toolcalls sidebar you can search, for example `status:error tool:Bash provider:codex duration:>5s`.
- Herdr capture: a small process that reads recent local Claude Code and Codex transcripts and publishes metadata-only snapshots so Osiris can show tool calls.

BFF ("Built Fucking Fast") is the name for packaging these into one portable SDK: `bff init`, `bff check`, `bff hydrate`, `bff osiris`, `bff start`, `bff herdr`, `bff doctor`.

## Why
The method only helped the one repo it was born in. Every new repo meant re-explaining the same conventions to every agent. A portable bundle makes a fresh repo start with the same spine, the same skills and the same checks, and makes the tool-call inspection reusable.

## Decisions & alternatives rejected
- Repo docs own scope, facts, decisions and evidence; `hygiene.md` alone owns the order of verbs. Rejected: letting each skill carry its own copy of the procedure (they drift).
- One orchestrator writes the authoritative spine and mints numbers. Rejected: many lanes numbering things at once (collisions).
- Runtime task state stays in whatever backend the user picked. BFF does not add another mutable task database next to an existing one. Rejected: a built-in BFF task store.
- Beads, Gas and DSH adapters stay opt-in experiments until tested live. Rejected: claiming adapters that were never run.
- Telemetry must show its gaps: retained-history caps, missing identities, unknown outcomes. Rejected: a "complete fleet" percentage without a known denominator.

## What went wrong / surprised us
- Work ancestry, tool timing, task dependencies and Doc-Spine links look similar on screen but are different relations. Mixing them gives false stories (a recorded spawn edge is not proof of cause; "completed" is not "landed"). `ARCHITECTURE.md` now says this plainly.
- Herdr pane membership and BB thread mapping could not be verified from transcripts alone, so BFF says "unknown" instead of guessing.

## How it was verified
Nothing in this entry is a release claim. The first verification of this material is in entry 0002.

## Lessons
- Write down relations separately before drawing them together.
- A tool that cannot see something should say "unknown", not fill the gap with a guess.
- Packaging a method is a different job from inventing it. Keep private history out of the package.

## Links
- `ARCHITECTURE.md`, `PROVENANCE.md`
- Commit `aa6f3ce` (first public commit: CLI, templates, Osiris, installer)
- Still open at this point: full agent lineage and worktree joins, manual PTY capture, enforced hooks and CI, Beads/Gas/DSH adapters and evals.
