# Changelog

All notable changes to BFF are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Versioning policy: [Semantic Versioning](https://semver.org/). While BFF is 0.x, a minor bump (0.Y.0) may change CLI behaviour or the install layout and a patch bump (0.1.Z) is additive or a fix. `bff/__init__.py` is the single version source; see `scripts/release.py`.

## [Unreleased]

### Added
- **Three commands** (D-128): `bff osiris install` installs Osiris and, run again, updates it (bff itself plus the Osiris build it pins); `bff osiris` (or `bff osiris open`) opens it; `bff osiris doctor` checks everything and prints the one next step. `bff osiris setup`, `bff osiris update`, `bff update`, `bff doctor` and `install.sh --setup` remain as undocumented aliases of the same code; `bff rollback` stays.
- `bff osiris install` plans first, asks once (`Install? [Y/n]`, EOF is no), and with no terminal changes nothing unless `-y/--yes` is given (exit 1, "Re-run with --yes"). `--dry-run` prints the plan. A re-run with nothing new changes nothing and fetches nothing.
- While Osiris is unpublished, `bff osiris install` builds the commit pinned in `compat.json` (`osiris.private`) from the private repository: SSH (BatchMode) or the GitHub CLI's credentials, HEAD verified to be the pinned commit, `npm ci --omit=dev --ignore-scripts`, then the repository's own stage-and-gate script. No access prints `gh auth login` as the next step. On a machine with staged builds (`~/.local/share/osiris-worktrees/install-*`) the newest one wins and nothing is fetched. `--ref` builds another commit; `BFF_OSIRIS_REPO_URL` points at a mirror.
- `bff osiris doctor` checks the platform (native Windows fails with the WSL2 step; WSL2 is named), bff and PATH, the latest bff release, BB present and answering, the Osiris plugin and whether a newer gated build exists, private-repo access, Herdr at a path Osiris trusts, the Herdr server, capture freshness (30 s, as Osiris judges it), whether BB has a running terminal Osiris can attach (why the Osiris terminal is empty), beads, git and gh. `--json`, `--offline`; exit 1 only when a check fails. The companion-tool plan of the old `bff doctor` follows, behind the same [Y/n].
- `install.ps1` checks WSL, prints the five WSL2 steps, offers once to run the Linux installer inside WSL (EOF is no) and exits 3.
- `bff init` ends with `Next: edit hygiene.md, run bff check, then bd init` (printed on stderr; stdout stays JSON).
- `bff config set update.auto true` prints a one-line warning and how to undo it; `bff config --help` explains `update.check` and `update.auto`.

### Changed
- The unpublished-Osiris message reads `Osiris is not publicly released yet; nothing to install.` (no internal decision id).
- Every installer failure (Python version, curl, download, checksum, archive, install) ends with one next action; `install.py` errors carry a `next` key.
- The daily update prompt reads `bff X is available (you have Y). Press Enter to update, n to skip [Y/n]`; the plugin step of `bff update` prints a progress line first; a missing `gh` names `https://cli.github.com` and the way around it.
- `bff osiris` with BB stopped says `BB is not running at <url>. Start BB, then run bff osiris again` instead of `[Errno 61]`.
- `bff herdr` options and `--repo`/`--url` have plain-words help.
- Exit codes for the Osiris commands (`bff osiris …`, `bff update`, `bff rollback`, `bff doctor`): 0 ok, 1 failed, 2 usage error, 3 waiting on a prerequisite. A failure used to exit 2.
- When no browser can be opened (SSH, headless, WSL without a bridge), `bff osiris` prints the URL and exits 0.

### Fixed
- A failed `bb plugin install` of a build with the same version as the running one (every 0.2.16 rc is `0.2.16-dev`) was reported as "Installed"; success now needs bb's exit 0 and BB serving that directory, else the previous source is restored.
- `install.sh` no longer runs an unrelated `install.py` that sits next to the downloaded script; only a bff tree counts as a local source.
- The PATH offer no longer says "Already added" because of a line another `--prefix` install added.
- `bff update` no longer offers an older "latest" release as an update.
- Every child process whose output bff captures gets an empty stdin, so none can wait unseen on a question.
- `bff rollback --plugin` no longer re-installs the previous plugin when there is no terminal to ask on; it prints `no changes made; re-run with --yes to apply`.
- `tests/test_bff.py` no longer fails on interpreters that write `__pycache__` next to an installed release the first time its launcher runs (found by the first CI run on Python 3.12; the 0.1.1 source tag still contains the old test).

## [0.1.1] - 2026-10-05

### Added
- `bff doctor` now installs missing companion tools and upgrades outdated ones, after showing the plan and asking `Install/update N items? [Y/n]`. `--yes` skips the prompt, `--no-upgrade` installs only, `--json` keeps the old read-only report. Routes are hardcoded and package-manager-only (Homebrew or npm); no sudo, no downloaded scripts. BB and aeh remain manual. Evidence: `evidence/doctor-fix-2026-10-05.md`.
- `bff doctor` also reports BFF's own version against the latest GitHub release (one unauthenticated API call, short timeout, fails soft to "unknown") and prints the pinned one-line install command when a newer release exists. It never runs it. `--offline` skips the call.
- `scripts/release.py`: bumps the version in one place, rewrites the pinned install URLs, runs the tests and the credential canary, builds the archive and prints (or, with `--publish`, runs) the tag and release commands.
- `CHANGELOG.md` (shipped in the archive) and an append-only learning ledger in `docs/ledger/`.
- GitHub Actions workflow running the Python test suite on push and pull request.

### Changed
- `bff/__init__.py` is now the only version source. The release builder reads it and refuses to build when `install.py`, `install.sh`, `release-files.json`, `package.json`, the lockfile or the README install URL disagree. `tests/test_version.py` fails on the same drift.
- `PROVENANCE.md` and the README no longer say BFF installs nothing: doctor may install third-party tools, only with consent.
- The README no longer states a version in prose; only its pinned install URLs carry one, and the release script rewrites them.

### Fixed
- `release-files.json` lists `bff/doctor.py`, so the release builder accepts the new module.

## [0.1.0] - 2026-10-05

First public release (MIT), a bootstrap stage rather than a finished product.

### Added
- Portable `bff` CLI: `init`, `check`, `hydrate` for adopting a fresh repo, `doctor` (read-only availability report), `start`, `herdr` and `osiris`.
- Fresh-repo templates: Doc-Spine files, one `hygiene.md` router and four task/review/wrap skills (task contract, hydrate, thermonuclear quality, thermonuclear wraps).
- Osiris, the BB workbench plugin, prebuilt: native chat in the centre, Work on the left, current-workspace Changes on the right, and a separate Toolcalls sidebar with search such as `status:error tool:Bash provider:codex duration:>5s`.
- `bff herdr`: bounded, metadata-only capture of local Claude Code and Codex transcripts.
- One-line pinned installer (`install.sh` / `install.py`): checksum and inventory verification, versioned releases under `~/.local/share/bff/releases/`, rollback with `--activate` and `--disable`.
- Release builder `scripts/build-bff-release.py` with a declared file list.

### Security
- The release builder rejects machine-specific paths and credential-shaped content (private keys, GitHub and Anthropic tokens, AWS key ids), and `tests/test_release.py` proves it with an archive canary.

### Not yet implemented
- Full agent lineage and worktree joins, manual terminal (PTY) capture, enforced hooks and CI adoption, Beads/Gas/DSH adapters and evals.

[Unreleased]: https://github.com/triunai/bff/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/triunai/bff/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/triunai/bff/releases/tag/v0.1.0
