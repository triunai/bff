# Self-healing guardrails and fitness functions

Put actual deterministic checks at useful junctures. Keep baseline correctness distinct from optional advisory review. Match commands to this repo's language and real module boundaries; a universal SDK cannot choose its application contracts.

Each check needs a name, explicit argv, scope and result. Missing tools, skips, cancellations and failed wrappers are not passing checks. Read the runner's actual verdict and test inventory; verify tests executed rather than trusting a green process label.

For a scanner/fitness function, prove the expected corpus is nonempty. Feed a deliberately broken input through the real scanner and see it fail, then restore and see it pass. Existing accepted debt may shrink; unexplained growth must not silently become a new baseline.

Group recurring findings by violated invariant. Repair the smallest meaningful cause and add a regression test, architecture assertion, type constraint or explicit policy pin. Do not weaken assertions to make the suite green. High/Medium closure requires pin evidence when the repo adopts that rule. No such automated closure gate is installed by this bootstrap.

Review fragile seams independently. Gate configuration and seam manifests are themselves guarded seams. A queued/launched review is not a completed review. A dedup key needs relevant diff, base and policy identity; a failed launch must remain retryable.

Receipts are useful when a named downstream check consumes them. Bind receipts to actual source/tree/base, policy, argv, runner identity and result. Do not create unused receipt ledgers. Independent landing evidence and remote CI results remain distinct from local check receipts.

Apply new rules advisory-first until their baseline is measured and useful; use explicit cutoffs for legacy debt. A pause should have reason and expiry if supported. Baseline checks remain active. Client hooks can be bypassed; configured CI is not proof of branch protection or a completed hosted run.

Configure `.bff.json` checks as argv arrays, for example a project's verified test command. `bff check --run` executes exactly those commands with normal machine permissions. This is an explicit local runner, not an OS sandbox, automatic review fleet or deployment gate.
