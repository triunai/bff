# BFF learning ledger

An append-only learning journal for the BFF project. One entry per milestone. It exists so the owner (and anyone else) can revisit the journey and learn from it: what we did, why, what we rejected, what went wrong and how we knew it worked.

## Rules

- Append only. Never rewrite an old entry to look smarter. If an old claim turns out wrong, say so in the new entry and link back.
- One entry per milestone, numbered `NNNN-short-slug.md`.
- Short, plain sentences. Write for a learner who was not in the room.
- Public-safe only. No secrets, tokens, private customer or case-study content, machine paths or private notes. `PROVENANCE.md` still holds: private history stays out of this repo.
- Verification means commands and their results, not "it worked".
- The ledger lives in the repo only. It is not part of the release archive.

## Entry template

```markdown
# NNNN — Title

Date: YYYY-MM-DD · Version: x.y.z (or "pre-release")

## What changed
## Why
## Decisions & alternatives rejected
## What went wrong / surprised us
## How it was verified
## Lessons
## Links
```

## Index

| # | Entry | Milestone |
|---|---|---|
| 0001 | [Pre-release foundations](0001-pre-release.md) | Where BFF came from: Doc-Spine, Osiris workbench, Herdr capture |
| 0002 | [v0.1.0 publication](0002-v0.1.0-publication.md) | Sanitised public release, archive canary, one-line install |
| 0003 | [v0.1.1 doctor install/update](0003-doctor-install-update.md) | `bff doctor` installs and upgrades companion tools, with consent |
| 0004 | [SDK hygiene and the v0.1.1 release](0004-sdk-hygiene-and-release.md) | One version source, a release script, a changelog, self-version check, CI |
