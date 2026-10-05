# Changelog

All notable changes to BFF are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Versioning policy: [Semantic Versioning](https://semver.org/). While BFF is 0.x, a minor bump (0.Y.0) may change CLI behaviour or the install layout and a patch bump (0.1.Z) is additive or a fix. `bff/__init__.py` is the single version source; see `scripts/release.py`.

## [Unreleased]

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
