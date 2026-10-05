# 0003 — v0.1.1: doctor installs and upgrades companion tools

Date: 2026-10-05 · Version: 0.1.1

## What changed
`bff doctor` used to print which companion tools exist. Now it also:
- reads each installed version from the tool's own `--version` and the latest stable from `brew info` or `npm view`;
- shows a table and a plan of installs (missing tools) and upgrades (outdated tools);
- asks once, `Install/update N items? [Y/n]`; `--yes` skips the question, `--no-upgrade` installs only, no TTY and no `--yes` changes nothing;
- runs items one at a time, prints each command first, re-detects afterwards, carries on after a failure and exits 1 with a summary if anything failed;
- keeps `--json` as the old read-only report.

Tools covered: Herdr (brew), Beads (brew, or npm), OMC and OMX (npm). BB and aeh stay manual; doctor prints instructions only.

## Why
The owner's ask, in their words: "doctor should say missing dependencies and proceed to download all of them iteratively… latest stable… hardcode the download-all part for now". A report that names the gap but leaves the fix to the user is half a tool.

## Decisions & alternatives rejected
- Hardcoded recipe table, one entry per tool, with package names checked against upstream READMEs and registries (sources in `evidence/doctor-fix-2026-10-05.md`). Rejected: a generic resolver or searching the web at run time; "hardcode for now" was the instruction.
- Package managers only (Homebrew or npm). No `curl | sh`, no sudo, no shell strings: every step is an argv list with a timeout. Rejected: running vendor install scripts, which is unreviewable code from the network.
- Consent first: a printed plan and a prompt, or an explicit `--yes`. Rejected: silent installs.
- Upgrades go through the manager that owns the executable (found from its real path), to the latest stable only. If the owner cannot be told (installed some other way) doctor skips and says why. Rejected: guessing a manager and creating a second copy.
- `br` (beads_rust) counts as "Beads present" but is never installed. Rejected: treating two different tools as one to install.
- No new install routes beyond the verified ones. BB has no documented global package-manager install, so it is manual rather than invented.

## What went wrong / surprised us
- `release-files.json` did not list the new `bff/doctor.py`, so the release builder rejected it as an "unreviewed distributable file" and the release test failed. The allowlist doing its job, but a step we forgot.
- An old test assumed plain `doctor` prints JSON. That became a table by design, so the test now calls `doctor --json` with the same assertions.
- `PROVENANCE.md` said Herdr, Beads, OMC and OMX "are not installed or bundled". True for the archive, false for what doctor can now do. Fixed in a separate commit so the claim matched the behaviour.
- In the dry run, the planned OMC upgrade command pointed at an `npm` inside a temporary shell-manager directory (fnm). It was the real npm in use, but the path is transient. The plan prints exactly what will run, which is how we saw it.
- Slice boundaries in the commit history are not clean: the execution code landed with the first slice, the CLI wiring in the second.

## How it was verified
- Unit tests with a fake machine (`which` and `subprocess` mocked): everything present, one missing, one outdated, `--yes` versus non-TTY, prompt yes and no, a failing install with the rest continuing and exit 1, `--no-upgrade`, manual tools never run, missing package manager, foreign-owned executable skipped, `--json` unchanged. 50 Python tests passed at the time; 22 observer tests passed.
- Real dry run on the owner's machine with stdin closed: planned "install Beads" and "upgrade OMC", changed nothing, exit 0.
- First real run on the owner's machine: installed Beads 1.3.1 with `brew` (which pulled in dolt 2.4.1 as a dependency) and upgraded OMC from 5.6.0 to 5.6.1 using npm from fnm. BB and aeh were reported as manual.
- Not verified: Herdr's own install docs (only the Homebrew formula), execution on Linux or Windows, and any BB global install route.

## Lessons
- "Install it for me" is a security feature request in disguise. Constrain the mechanism (argv only, package managers only, consent) and the feature gets safer, not weaker.
- Print the exact command before running it. It is the cheapest audit trail and it exposed the transient path.
- When an allowlist rejects your new file, that is the allowlist working. Update it deliberately.
- A dry run on the real machine finds things unit tests with mocks cannot.

## Links
- Commits `4129444`, `69d784f`, `60d9946`, `47138e3`
- `bff/doctor.py`, `tests/test_doctor.py`, `evidence/doctor-fix-2026-10-05.md`, `PROVENANCE.md`
