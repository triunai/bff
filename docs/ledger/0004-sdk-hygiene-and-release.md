# 0004 — SDK hygiene and the v0.1.1 release

Date: 2026-10-05 · Version: 0.1.1

## What changed
BFF now behaves more like a small proper SDK:
- `CHANGELOG.md` in Keep-a-Changelog format, with a semver policy line and `0.1.0` / `0.1.1` sections rebuilt from git history and `evidence/`.
- One version source. `bff/__init__.py` holds `__version__`; `scripts/versioning.py` reads it and checks or rewrites every pin (`install.py`, `install.sh`, `release-files.json`, `package.json`, the lockfile root and the README install URLs). The release builder reads the same source and refuses to build if a pin disagrees. `tests/test_version.py` fails on the same drift.
- `scripts/release.py`: bump, rewrite pins, require a CHANGELOG section, run tests and the canary, build the archive and print the exact `git` / `gh` commands. `--publish` runs them, only from a clean tree, with `gh` logged in and an unused tag.
- `bff doctor` compares BFF's own version with the latest GitHub release (one unauthenticated call, 3-second timeout, "unknown" on any failure). When outdated it prints the pinned install command for the new tag and never runs it. `--offline` skips the call.
- A tiny GitHub Actions workflow that runs the Python unit tests on push and pull request.
- This ledger.

## Why
v0.1.0 had the version number written in seven places and no record of what changed. The first time someone bumped it, one would be missed and the one-line installer would install the wrong thing. A release should be a command with checks, not a memory exercise.

## Decisions & alternatives rejected
- Parse the version from `bff/__init__.py` as text; do not import it. `install.py` and `install.sh` run before any BFF code can be trusted or imported. Rejected: making them import the package.
- Keep the pins as real text in the files and test them, instead of generating them at install time. Rejected: templating the installer, which would make the pinned URL in the README untestable by reading it.
- Doctor prints the update command; it does not run it. The brief was explicit: no automatic `curl | sh`. Rejected: self-updating.
- Validate the release tag as exactly `vX.Y.Z` before putting it in a printed command, so a hostile API response cannot inject shell text. Rejected: printing the tag as given.
- The push to `main` is a plain push, so git refuses anything that is not a fast-forward. Rejected: any override flag in the release script, and a test checks none appears.
- Notes come from the CHANGELOG section. Rejected: hand-written release notes, which drift from the changelog.
- CI only runs the standard-library Python tests. The Osiris Node tests need dependencies and Node 24, so they stay a local check for now.

## What went wrong / surprised us
- A multi-line shell command used `&&` after a failing edit step, but a later separate line still ran, so a commit was made with a missing CHANGELOG and two failing tests. It was caught immediately, the unpushed commit was undone and redone correctly. Lesson: chain with `&&` all the way to the commit, and read the test result before committing.
- Writing the release-script tests found a real bug: the notes file was written before its output directory existed. Only a test that mocked out the builder exposed it.
- The README had a version in a prose sentence as well as in the URLs. The prose one is gone; a hidden second pin is how drift happens.
- The lockfile also carries the root version. It was not in the original list of places, and only the pin test's `>= 8 pins` guard made us count them.
- Local safety hooks blocked a few commands whose text only mentioned dangerous words. Messages were moved into files; the commands themselves never did anything dangerous.

## How it was verified
- `python3 -m unittest discover -s tests`: 56 tests after slice 1, 65 after the release script, 75 after the doctor self-check, all OK. The release run adds the final counts in `evidence/v0.1.1-release-2026-10-05.md`.
- The version test deliberately breaks each pin in a scratch copy and expects a failure, then restores it.
- A real bump-and-build on a scratch copy runs no `git` or `gh` (checked by spying on subprocess calls).
- Real call to the GitHub API: `bff doctor` printed "BFF 0.1.0 installed; up to date with release 0.1.0" before the release existed.
- The remote install rehearsal and the release outcome are recorded in the evidence file, because they can only be known after publishing.

## Lessons
- Make the thing that must stay in sync derive from one place, then add a test that fails when it does not.
- Anything you do by hand at release time will be done wrong once. Script it, then let the script refuse unsafe states.
- A guard counts: assert that a pattern matches something, or an empty match passes forever.
- Tests with mocks find bugs in your control flow; real runs find bugs in your assumptions. Do both.

## Links
- Commits for this release are listed in `CHANGELOG.md` and `evidence/v0.1.1-release-2026-10-05.md`
- `scripts/versioning.py`, `scripts/release.py`, `tests/test_version.py`, `tests/test_release_script.py`, `tests/test_doctor_self.py`, `.github/workflows/tests.yml`
- Still open: full agent lineage and worktree joins, manual PTY capture, enforced hooks and CI adoption, Beads/Gas/DSH adapters and evals.

## Addendum: release outcome (appended after publishing)
- v0.1.1 was published from `7f4afcd`: plain push to `main`, annotated tag, GitHub release with the archive and `SHA256SUMS`. Details and numbers are in `evidence/v0.1.1-release-2026-10-05.md`.
- The remote install rehearsal passed: the pinned `install.sh` from the tag, read first, installed into a scratch prefix; `bff --version` and `bff doctor --json` worked. The installer then upgraded the owner's real install in place and kept the old release for rollback.
- Surprise: the first CI run on GitHub failed on Python 3.12. An installer test compared an installed release before and after running its launcher, and that Python wrote `__pycache__` there; the local Python did not. The product was fine, the test was too strict about bytecode. We fixed the test (still a byte-exact comparison of release content) and did not move the tag.
- Lesson: "green on my machine" is one interpreter. A CI run on a different Python found a test that depended on how the local one caches bytecode. We should have run CI on a branch before tagging; the release script now has an obvious place to add that check.
