# BFF — Built Fucking Fast

Your repo’s operating model, reproducible: a thread-aware Doc-Spine, one `hygiene.md` router, task contracts, independent quality reviews, coordinated wraps, a checked context graph, and Osiris for tool-call inspection in BB.

**BFF is a bootstrap-stage release.** See [CHANGELOG.md](CHANGELOG.md) for what each version ships. It ships the portable CLI, fresh-repo conventions/skills and Osiris’s native-chat workbench plus separate searchable Toolcalls tab. Automatic hook/CI adoption, full agent lineage/landing visualizations, manual terminal recording and live Beads/Gas/DSH eval adapters remain future work. Existing OMC/OMX/Claude/Codex configuration stays user-owned.

## Install

Requires Python 3.9+, curl, and Git for repo adoption. BB and Herdr are separate upstream applications; install/run them through their own supported setup before opening their interfaces. The bootstrap installs no Python/Node dependencies or agent runtimes.

```sh
curl -fsSL https://raw.githubusercontent.com/triunai/bff/v0.1.1/install.sh | sh
```

The pinned bootstrap downloads the release archive, verifies its checksum and file inventory, preserves a version under `~/.local/share/bff/releases/`, and exposes `~/.local/bin/bff`. It reports a missing PATH entry without editing shell startup files. Use the printed absolute command in that case. Checksum and archive share the GitHub publisher trust boundary; this is not an independently signed release.

From a downloaded source/release directory, `sh install.sh` installs locally. Use `--prefix <scratch-directory>` to rehearse safely.

## Open Osiris

With BB running:

```sh
bff osiris --install
```

This explicitly installs the included prebuilt plugin through BB and opens Osiris. BB 0.45+ and its public SDK 0.6.15 surface are the tested baseline; upstream compatibility still applies. Main Osiris keeps native chat central, Work on the left and current-workspace Changes on the right; Trace and Problems replace that inspection pane. **Toolcalls** is a separate BB sidebar entry with its own search and failure view across scanned retained history. Search examples: `status:error`, `tool:Bash`, `provider:codex`, `duration:>5s`.

`bff start` opens the existing BB workbench and requests an independent named Herdr session in a terminal (macOS and platforms providing `x-terminal-emulator`). It does not install BB/Herdr or prove Herdr startup. `bff start --print-plan` is read-only. `bff osiris --print-url` prints the local URL.

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

Osiris source and prebuilt assets live in `plugins/osiris`. Python CLI and TypeScript UI/server stay separate inside one SDK. See component notices for upstream licensing. MIT for BFF-authored code.
