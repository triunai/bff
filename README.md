# BFF — Built Fucking Fast

**The repository is the memory. The chat is just a process.**

[![Python 3.9+](https://img.shields.io/badge/python-3.9%2B-3776AB)](#install)
[![TypeScript](https://img.shields.io/badge/osiris-TypeScript-3178C6)](plugins/osiris)
[![Node 24 (dev only)](https://img.shields.io/badge/node-24%20(dev%20only)-5FA04E)](#rollback-and-development)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Release](https://img.shields.io/github/v/release/triunai/bff)](https://github.com/triunai/bff/releases)

BFF is a portable CLI and a set of repo conventions for running coding agents without losing the plot: a thread-aware Doc-Spine, one `hygiene.md` router, task contracts, independent quality reviews, coordinated wraps and a checked context graph. Osiris, its workbench for BB, shows what the agents actually did.

![Osiris workbench: native chat in the centre, Work threads on the left, current-workspace Changes on the right](docs/assets/osiris-workbench.png)

*Osiris in BB: native chat in the centre, Work on the left, Changes on the right.*

## What BFF is

Most agent work starts as a prompt and ends as archaeology: someone scrolls a chat to find out what was decided, what ran, and whether it passed. BFF replaces that with a loop that leaves artifacts in the repository:

```text
intent -> hydrate -> contract -> lane -> evidence -> review -> fitness -> wrap
```

Each step writes to the repo or reads from it. The chat is disposable; the spine, the contracts, the commits and the check output are not. Boring ownership rules are cheaper than clever merge conflicts: one orchestrator writes spine state and mints numbers, and lanes write committed evidence in their own worktrees.

## Capabilities

What v0.1.1 ships:

- **Repo adoption.** `bff init` lays down the Doc-Spine files, the `hygiene.md` router and four skills; existing files are preserved. `bff check` validates the bound spine; `bff hydrate` prints bound context for one workstream without changing files.
- **Project checks.** `bff check --run` executes the argv commands you declare in `.bff.json`, with your machine permissions, and reports the result. A shell exit code is an observation, not a verdict: verify that the tests actually ran.
- **Osiris workbench for BB.** Native chat in the centre, Work on the left, current-workspace Changes on the right, with Trace and Problems replacing the right pane when needed.
- **Toolcalls explorer.** A separate BB sidebar entry with its own search and failure view across scanned retained history.
- **Provider capture.** `bff herdr` records bounded, metadata-only snapshots of local Claude Code and Codex transcripts.
- **Companion tools.** `bff doctor` reports Herdr, Beads, OMC, OMX, BB and aeh, and with your consent installs missing tools and upgrades outdated ones.
- **Verified install and rollback.** Pinned one-line installer with checksum and file-inventory verification, preserved versions, and `--activate` / `--disable`.

## Install

Requires Python 3.9+, curl and Git. BB and Herdr are separate upstream applications; install them through their own supported setup. The bootstrap installs no Python or Node dependencies and no agent runtimes.

```sh
curl -fsSL https://raw.githubusercontent.com/triunai/bff/v0.1.1/install.sh | sh
bff doctor     # what is present, what is missing, what it would do
```

If `bff` is not on your PATH, the installer prints the absolute command to use. It does not edit shell startup files.

The pinned bootstrap downloads the release archive, verifies its checksum and file inventory, preserves a version under `~/.local/share/bff/releases/`, and exposes `~/.local/bin/bff`. Checksum and archive share the GitHub publisher trust boundary; this is not an independently signed release. From a downloaded source or release directory, `sh install.sh` installs locally; `--prefix <scratch-directory>` rehearses safely.

## Osiris

With BB running:

```sh
bff osiris --install
```

This installs the included prebuilt plugin through BB and opens Osiris. BB 0.45+ and its public SDK 0.6.15 surface are the tested baseline; upstream compatibility still applies.

Main Osiris keeps native chat central, Work on the left and current-workspace Changes on the right. Trace and Problems replace the right pane. **Toolcalls** is a separate sidebar entry with its own search and failure view across scanned retained history. Search examples: `status:error`, `tool:Bash`, `provider:codex`, `duration:>5s`.

![Toolcalls: searchable list of recorded tool calls across scanned threads](docs/assets/osiris-toolcalls.png)

*Toolcalls, filtered with `status:error`.*

![Failed-call inspector: metadata for one selected failed tool call](docs/assets/osiris-failed-call.png)

*Selected-call inspector for a failed call. It shows the metadata the collector actually has, not an inferred root cause.*

![Osiris in use: opening Toolcalls, searching, selecting a failed call](docs/assets/osiris-demo.gif)

Osiris reports retained-history caps, scan failures and unknown outcomes as such: no complete-fleet percentage without a known denominator, and no recovered or root-cause labels without evidence. Metadata exports exclude prompts, tool inputs and outputs, and credentials. Details: [plugins/osiris/README.md](plugins/osiris/README.md).

`bff start` opens the existing BB workbench and requests an independent named Herdr session in a terminal (macOS and platforms providing `x-terminal-emulator`). It does not install BB or Herdr or prove Herdr startup. `bff start --print-plan` is read-only. `bff osiris --print-url` prints the local URL.

## How it works

```text
 your repo                                   your machine
+-------------------------------+          +--------------------------------+
| hygiene.md   (verb order)     |          | Claude Code / Codex transcripts|
| Doc-Spine    (scope, facts,   |          +---------------+----------------+
|   decisions, evidence)        |                          | bff herdr
| .bff.json    (check argv)     |                          | (bounded, metadata only)
| .agents/skills/bff-*          |                          v
+---------------+---------------+          +--------------------------------+
                | bff init/check/hydrate   | namespaced metadata feed       |
                v                          +---------------+----------------+
+-------------------------------+                          |
| BFF CLI (Python, stdlib only) |                          v
+-------------------------------+          +--------------------------------+
                                           | Osiris (TypeScript, BB plugin) |
 BB retained thread history ------------>  | Work | chat | Changes/Trace   |
                                           | Toolcalls                      |
                                           +--------------------------------+
```

The repo owns scope, decisions, evidence and process ordering. `hygiene.md` is the single procedure router; skills execute it. Osiris reads two distinct sources, BB's retained lifecycle history and BFF's local provider capture, and does not guess identity across them. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Architecture

```text
bff/                    Python CLI
  cli.py                  argument parsing, subcommand dispatch
  project.py              init / check / hydrate over the bound spine
  doctor.py               companion-tool report, install and upgrade plan
  herdr.py, herdr_observer.py
                          bounded local Claude/Codex transcript capture
  launch.py               start / osiris launchers
plugins/osiris/         Osiris, a BB plugin (TypeScript + TSX, prebuilt in dist/)
  app.tsx, server.ts      UI and server halves
  analytics.ts            call metadata, search and outcome handling
  herdr-feed.ts, live-observer.ts
                          consume the feed written by `bff herdr`
templates/repo/         what `bff init` writes: hygiene.md, docs/ spine, skills, CI
install.sh, install.py  pinned installer: verify, preserve, activate, disable
scripts/                release builder and release script
tests/                  Python unittest suite and Osiris tests
```

Four parts, kept separate: the Python CLI, the TypeScript UI and server inside one BB plugin, the Herdr capture bridge, and the conventions that `bff init` puts into a repository.

## Stack

| Part | Technology | Notes |
| --- | --- | --- |
| CLI | Python 3.9+ | Unit tests with `unittest` |
| Workbench | TypeScript / TSX, BB plugin SDK 0.6.15 | Prebuilt assets in `plugins/osiris/dist`; React and the SDK come from the BB host; Zod is bundled in the server artifact |
| Host | BB 0.45+ | Separate upstream application, tested baseline |
| Capture | Herdr bridge (`bff herdr`) | Reads local Claude Code and Codex transcripts, writes metadata only |
| Installer | POSIX `sh` + Python | Checksum and file-inventory verification, versioned releases, rollback |
| Dev tooling | Node 24, npm | Osiris tests and rebuild only; not needed to use BFF |
| CI | GitHub Actions | Python test suite on push and pull request |

## Why the name

Because the alternative is reconstructing yesterday from a chat log. Measure the work. Keep the evidence. Leave less bullshit for the next run.

## Check and install companion tools

```sh
bff doctor              # table of found/missing tools, versions, planned actions, then asks once
bff doctor --yes        # run the plan without prompting
bff doctor --no-upgrade # install missing tools only
bff doctor --offline    # skip the one GitHub call that checks BFF's own version
bff doctor --json       # machine-readable availability report; runs nothing
```

`bff doctor` first compares BFF's own version with the latest GitHub release (one unauthenticated call, 3-second timeout; any failure prints `unknown`). If a newer release exists it prints the pinned one-line install command for that tag and does not run it. It then checks Herdr, Beads, OMC, OMX, BB and aeh. For each it reads the installed version from the tool's own `--version` and the latest stable version from `brew info` or `npm view`, then plans installs for missing tools and upgrades for outdated ones. It asks `Install/update N items? [Y/n]`; with no TTY and no `--yes` it prints the plan and changes nothing. Items run one at a time, each command is printed first, and the executable is re-detected afterwards; one failure does not stop the rest, but the exit code is then 1 with an installed / upgraded / already current / failed / skipped summary.

Hardcoded routes: Herdr via `brew install herdr`; Beads via `brew install beads` (or `npm install -g @beads/bd`); OMC via `npm install -g oh-my-claude-sisyphus@latest`; OMX via `npm install -g oh-my-codex@latest`. BB and aeh have no documented package-manager route, so doctor only prints manual instructions. Upgrades go through the package manager that owns the executable, to the latest stable release only. No sudo, no shell strings, no downloaded scripts.

## Observe Claude Code and Codex sessions

```sh
bff herdr
```

Keep this foreground capture running. In Toolcalls or Osiris, choose **••• → Source → Herdr / local provider capture**. It reads bounded recent local Claude/Codex transcript files and publishes metadata-only snapshots every five seconds. `--once`, `--latest 1..32` and exact `--session` are available.

Claude Bash and Codex commandExecution calls are included; manually typed terminal commands are not. Herdr pane membership and BB-thread mappings are unverified. Capture freshness is not a process heartbeat. BB retained events and local provider capture stay distinct sources; no cross-source identity guess or complete-history claim.

To install and open the two interfaces, then keep provider capture running, this is also one shell line:

```sh
curl -fsSL https://raw.githubusercontent.com/triunai/bff/v0.1.1/install.sh | sh && "$HOME/.local/bin/bff" osiris --install && "$HOME/.local/bin/bff" start && "$HOME/.local/bin/bff" herdr
```

## Adopt a fresh repo

```sh
bff init --repo /path/to/repo
bff check --repo /path/to/repo
bff hydrate --repo /path/to/repo --ws WS-01
```

`init` preserves existing files. Existing spines need a deliberate binding/migration. Repo docs own scope, facts, decisions and evidence; `hygiene.md` alone owns verb order. One orchestrator owns authoritative spine writes and numbering. Lanes write committed evidence in their own worktrees.

Canonical skills are under `.agents/skills/bff-*`: task contract, hydrate, thermonuclear quality, thermonuclear wraps. Read them directly or bind them through your agent’s supported skill discovery. Global skills and Claude aliases are not installed implicitly.

Configure real project test/build/fitness argv in `.bff.json`. `bff check --run` explicitly executes those commands with normal machine permissions. Verify actual test execution and teeth-check important invariants. Check output states the implemented subset and enforcement limits; installation does not overwrite hooks, configure branch protection or initiate model reviews.

Obsidian remains an additive teaching source: hydrate selected notes, record provenance and promote reviewed improvements into one permanent repo home. No private vault, application case study, credentials or historical sessions are bundled. See [architecture](ARCHITECTURE.md) and [source boundary](PROVENANCE.md).

## Rollback and development

`python3 install.py --activate <preserved-release>` restores a preserved CLI; `--disable` removes only the owned command link. Project files and runtime state remain intact.

```sh
python3 -m unittest discover -s tests -q
npm ci  # development only; Node 24 for Osiris tests
npm run test:osiris
python3 scripts/build-bff-release.py --output /tmp/bff-release
```

Osiris source and prebuilt assets live in `plugins/osiris`. Python CLI and TypeScript UI/server stay separate inside one SDK. See component notices for upstream licensing.

## Status

BFF is a **bootstrap-stage release**. [CHANGELOG.md](CHANGELOG.md) records what each version ships; [docs/roadmap.md](docs/roadmap.md) lists candidates, not commitments.

Not implemented yet, and not claimed above:

- Full agent lineage and worktree joins, and landing visualizations.
- Manual terminal (PTY) recording.
- Enforced hooks and automatic CI adoption. Installation does not overwrite hooks or configure branch protection.
- Live Beads / Gas / DSH adapters and their evals.
- Osiris call-inspector improvements (untruncated values, captured inputs and error text, error classification); see the roadmap.

Existing OMC / OMX / Claude / Codex configuration stays user-owned. No private vault, application case study, credentials or historical sessions are bundled; see the [source boundary](PROVENANCE.md).

## License

MIT for BFF-authored code ([LICENSE](LICENSE)). Osiris carries its own notices for upstream components: [plugins/osiris/THIRD_PARTY_NOTICES.txt](plugins/osiris/THIRD_PARTY_NOTICES.txt).
