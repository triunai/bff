# 0005 — Triage before dispatch, a work ledger, and a tool bake-off

Date: 2026-10-07 · Version: none (process and design record; no BFF release)

## What changed
Nothing in BFF's code. This entry records a build whose method is the lesson, and the design direction it set for Osiris' Work surface.
- A tech-debt run that started as "launch 21 agents" became: map first, close what is already fixed, fix the rest in isolated lanes, integrate, gate, fast-forward.
- Beads (`bd`) was adopted as the work ledger for that run. The orchestrator is the single writer; lanes report, they do not write the ledger.
- Four community tools around Beads were scored in a bake-off. None became the base. Pieces of each were chosen to port.
- The Work surface is being built with itself: its own build slices are tracked as beads that it will display.

## Why
The ask was parallelism. The real question was how much work there was. Agents are cheap to launch and expensive to trust, so the first spend went on finding out what was still true before spending on lanes.

## The run, with numbers
- Phase 0: three read-only mappers produced cards for 21 open threads in about 4 minutes. 13 of 21 were already fixed or obsolete. Each was closed with evidence: the cited commit checked as an ancestor of main, and the covering tests re-run (61/61 and 68/68 on one set, 169/169 on another).
- Phase 1: six fix lanes ran in about 6 minutes, each in its own worktree off one explicit base commit, each with a disjoint file lease. Result: 4 ready to land, 1 partial, 1 stopped. 0 file collisions. 2 lease deviations, both explained and checked.
- The stopped lane: its brief called the change "decision-free". It found that every one of its swaps would alter live customer-facing output, so it made no commits and asked for a ruling. The brief's premise was false; the lane's refusal was the correct result.
- Integration: a branch merged the four ready lanes with no conflicts. The full gate on the combined tree passed: 680 test files, 10,025 tests (12 skipped, 2 todo), plus the RPC contract check, plus two wiring tests that cannot load in an isolated worktree and so had to run on the combined tree. Then a fast-forward to main.

## Bake-off: four tools, none a base
Scored out of 45 on nine criteria, each tool cloned and run in a sandbox where possible:
- beady-eye 30, Mardi Gras 25, Foolery 22, BeadBoard 21.
- Take from each: beady-eye's agent-to-bead join (which agent works which bead), Mardi Gras's dispatch recipe (prompt assembly, idempotent pane launch), Foolery's wave planner (what can run together), BeadBoard's dependency graph, ported wholesale.
- Why no base: each assumes things Osiris cannot. Examples from the notes: no worktree awareness, multiple writers by design, a different state vocabulary, or code that cannot be embedded (a Go terminal UI, a separate web server).

## Decisions & alternatives rejected
- Triage before dispatch. Rejected: launching 21 lanes and sorting it out afterwards.
- One writer to the ledger (the orchestrator). Rejected: letting each lane update its own bead, which is how two writers disagree about one claim.
- Explicit base commit and file lease per lane; the combined tree is gated by the orchestrator, not by lane prose. Rejected: trusting a lane's "green", since two tests could only run on the combined tree.
- Port the good parts, adopt no tool wholesale. Rejected: picking the top scorer as a base because it scored highest.
- Run the real thing on the real system's own work (the Work surface tracks its own build). Rejected: a demo dataset, which never exposes the awkward cases.

## What went wrong / surprised us
- Safety catch: initialising the tracker silently pointed its sync at a shared remote repository. An evaluator running a tool in a sandbox saw the remote, did not run any write against it, and reported it. Nothing was published. Checking the sync remote is now a step in the setup procedure, before any tool that can write is run.
- One lane's handback text was lost and came back as a placeholder. The result was reconstructed from git, which is why the orchestrator reads git and does not trust prose.
- One lane launched a real external code review against something its brief listed as a non-goal. The result was caught at reconciliation and held back from landing until read.
- A stale metric: the fleet status script reported a wrong base and an inflated file count for these lanes because it does not read the per-fleet base line. Its numbers were discarded rather than reported.
- One lane edited a file outside its lease because the stale comment it was fixing actually lived there. The check surfaced it; the edit was correct and was accepted with the deviation recorded.

## How it was verified
- Every "already fixed" claim: cited commit confirmed as an ancestor of main, and its tests re-run by the orchestrator.
- Every lane: diff compared with its lease; its tests re-run by the orchestrator, not copied from the handback.
- Combined tree: full gate and contract check re-run there. Not verified: the remote-side hooks (the integration branch was never sent anywhere) and visual behaviour of one randomisation change. The run's evidence file says so.

## Lessons
- Triage before dispatch was worth more than parallelism: about 4 minutes of mapping cancelled 13 of 21 lanes.
- An agent's "done" is a claim. Verify it against git and by re-running, every time.
- A lane that stops on a false premise is working. Make stopping cheap and expected.
- Disjoint leases, one base commit, and gating the combined tree is what makes "0 collisions" a measurement and not luck.
- Score tools against your own constraints. A high score on someone else's constraints is not a base.
- Check where a tool syncs before you let it write.

## Links
- Design direction: the Work surface takes the agent-to-bead join, dispatch recipe, wave planner and graph above; see the Osiris design notes.
- Still open: the Work surface itself (this entry records its method, not its delivery) and open-sourcing the generic Work view in BFF.
