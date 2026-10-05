# Project hygiene — canonical router

This router owns artifact locations and verb order. [Doc-Spine](docs/conventions/doc-spine.md) owns rules and reasons. Skills execute this router. `.bff.json` contains machine bindings only; if a binding drifts from this map, resolve it explicitly rather than maintaining two layouts.

| Artifact | Home |
| --- | --- |
| Now | docs/hot-state.md |
| Workstreams | docs/workstreams.md |
| Decisions | docs/decisions.md |
| Open work | docs/state-backlog.md |
| Journal | docs/project-log.md |
| Seed | docs/NEXT-SESSION-SEED.md |
| Evidence router | docs/ai/README.md |
| Staged findings | docs/findings/README.md |
| Build/review rules | docs/conventions/guardrails.md |

| Verb | Steps in order |
| --- | --- |
| HYDRATE | Confirm tree, branch, dirty state and ownership; inspect worktrees and newer committed state as clues; read seed, hot state, this router, chosen workstream and referenced contract/evidence; report traps and literal next action. Do not switch trees merely because a timestamp is newer. |
| PARK | Collect the current worker's committed evidence/checkpoint; update the orchestrator-owned workstream status and literal Resume action; record unfinished work and owed decisions; commit authorized spine changes with the seed. |
| PICK UP | Read the workstream, Resume and references; confirm intended base, ownership and check scope; set active state; perform the next action. |
| REVIEW | Select three or four demonstrated drift seams; obtain independent review, preferring a different family; reproduce each serious finding; fix each accepted finding in its own verified commit; pin the violated invariant; re-review the fixes; route lows and disputes explicitly. |
| WRAP | Walk Owed and run bff check; collect lane handoffs; index immutable evidence; update board, decisions, backlog and any staged findings/debt; move older resume blocks into the journal; record the session; update hot state; write the seed; re-run bff check; commit spine and seed together. |
| LAND | Confirm base and that lanes did not edit the spine; verify actual checks on an isolated verification tree; obtain independent review and resolve/re-review serious findings; record promise-to-proof rows with source/target identities and independent verifier; integrate verified commits; update spine and seed together. |

Machine checks: `bff check` validates the bound spine. `bff check --run` additionally executes explicitly configured argv checks in `.bff.json`. No project checks are configured initially. Configure real commands and inspect actual test execution before treating a suite as evidence.

Enforcement status: installation does not configure Git hooks, CI, branch protection or automatic model review. Run checks explicitly. When binding those systems later, label each check as blocking or advisory and preserve existing hook ownership.
