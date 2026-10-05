# Thread-aware Doc-Spine

Project context has different lifetimes. A single accumulating state file mixes current work with history and makes cold starts unreliable. Split those facts and connect them through a checked workstream key.

| Lifecycle | Purpose | Owner |
| --- | --- | --- |
| Hot state | Current resume block, at most one previous block and Owed | Orchestrator |
| Board | All active/parked work and literal Resume actions | Orchestrator |
| Decisions | Settled calls; supersede rather than delete | Orchestrator |
| Backlog | Open work/questions | Orchestrator |
| Journal | Append-only session history, newest first | Orchestrator |
| Evidence | Immutable reviews, traces and validation; folder README routes to them | Lanes produce, orchestrator indexes |
| Deferred debt | Tax, cost of leaving it, named payer/date and revisit trigger | Orchestrator, with owner acceptance |
| Staged findings | Durable facts and explicit permanent home; blank promotion means unfinished | Orchestrator |
| Handoff | Committed read-first/state/traps/facts/not-done/decisions/staffing/start-here seed | Orchestrator |

`WS-NN` is the join key. Board headings use `### WS-NN`. Every journal, decision and backlog entry starts its body with `WS: WS-NN` (comma-separated for several keys). Never guess legacy ownership: use an explicitly adopted migration policy. The checker prints the thread count; a surprising drop is a parser-canary failure, not automatic cleanup.

Only the orchestrator mints numeric IDs after sweeping all Git worktrees. Lanes propose placeholders and never edit authoritative spine files. Migration numbers are execution order and need their own project-specific allocator. Do not insert journal headings in a way that renumbers old cited entries.

One writer owns each worktree. Verify intended base before starting and again before integration. Commit each passing coherent step. Re-check reported negatives with a query known to match a positive control. Different-family review is preferred; record same-family verification honestly when the requested reviewer is unavailable.

Move the oldest resume block into the journal instead of deleting it. Seed and spine travel in one commit. Evidence is not rewritten after the fact: correction means a new dated artifact. Completed work needs proof from an independent verifier before it is treated as landed.

The convention owns rules and reasons. The router owns map and procedure order. Skills execute the router. Scripts enforce adopted machine rules. Generated indices are not another hand-kept authority.

Adopt stricter gates only on a clean measured baseline or explicit ratchet. Old debt stays visible. This bootstrap checker covers selected spine invariants; optional provenance headers, migration order, ratchet policy and remote enforcement require separate repo bindings. Do not imply a document rule is enforced merely because it is written here.

Obsidian is an additive learning source. Repo facts remain authoritative. Import selected improvements with source/version/hash and a reviewed permanent home; keep private case studies and whole-vault content outside public release artifacts.
