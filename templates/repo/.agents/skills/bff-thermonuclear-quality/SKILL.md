---
name: bff-thermonuclear-quality
description: Perform a requested harsh maintainability review of implemented changes, focusing on structural simplification and architectural seams.
---

# Thermonuclear code quality

Read the task contract, repo rules and chosen diff. Pick three or four seams most likely to drift. Question structures that preserve incidental complexity when a simpler model could remove branches, wrappers or whole layers. Prefer the canonical module and direct typed boundaries over casts, pass-through abstractions and scattered special cases.

Treat a file crossing 1,000 lines as a decomposition smell requiring a concrete structural justification. Do not reject solely by line count or scatter a cohesive design into arbitrary helpers. Assess whether the change improves behavior-preserving structure, ownership, atomic updates and legibility.

Emit a small number of demonstrated findings: ID, severity, source location, reproduction/evidence, exact change request and invariant at risk. A green test suite does not settle maintainability. Reproduce serious claims and prove negative queries have positive controls.

Use the REVIEW row in hygiene.md for the fix/re-review loop. Serious findings and change requests need an explicit disposition; fixes get coherent verified commits and meaningful pins. Record disputes for the owner rather than silently dropping them. State reviewer family and independence honestly.
