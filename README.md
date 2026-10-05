# BFF — Built Fucking Fast

## Why the name?

Because "Enterprise Agentic Software Development Lifecycle Orchestration Framework" has multiple implementations already, this is just what works for me

And because speed is not how quickly an agent can emit code.

Speed is:

- not rederiving existing common shapes that were already spotted once before
- not repeating decisions that were already made
- not reviewing your own work with bias and calling it independent
- not losing context at the end of a thread
- not discovering three days later that the test suite never exercised the path
- not burning tokens recovering from preventable tool mistakes

Measure the work, keep the evidence & leave less bullshit for the next run.

# The actual Why

Agentic development gets slow in surprisingly stupid ways.

The model forgets what it was doing. Two agents edit the same assumption. A review says "looks good." Nobody remembers why a migration exists. A tool call fails, the agent burns another ten thousand tokens recovering from it, and the only record left is a red line in a transcript nobody will read again.

BFF exists because "the model has a big context window" is not an engineering methodology.

It gives a repository an operating model:

- a thread-aware Doc-Spine for durable project state
- one `hygiene.md` router for execution order
- explicit task contracts
- independent quality review
- coordinated wraps instead of ceremonial summaries
- a checked context graph
- Osiris for inspecting what your agents actually did

The point is not to make agents type faster.

The point is to stop paying them to rediscover the same repo.

> If an agent cannot tell you what it changed, why it changed, what proved it, and where the evidence lives, the work is not finished.

BFF is opinionated about that.

It is deliberately not opinionated about which model you worship this month.

Claude, Codex, OMC, OMX and the rest remain yours.

---

## The operating model

A normal agent session tends to look like this:

```text
prompt
  -> enormous context dump
  -> edits
  -> tests, probably
  -> "done"
  -> next session starts archaeology
```

BFF expects something closer to:

```text
intent
  -> hydrate relevant context
  -> bind a task contract
  -> execute in an owned lane
  -> produce committed evidence
  -> independent review
  -> verify fitness
  -> wrap durable state
  -> leave the repo smarter than you found it
```

The repository is the memory.

The chat is just a process.

That distinction matters.

---

## Osiris

Agents are software. Software gets instrumented.

Osiris is BFF's tool-call workbench for BB.

It observes Claude Code and Codex execution, lets you inspect retained traces, search tool calls, isolate failures, and examine what happened around them instead of accepting the agent's recollection of what happened.

```text
status:error
tool:Bash
provider:codex
duration:>5s
```

The current release includes:

- native-chat inspection inside the BB workbench
- a separate searchable Toolcalls surface
- trace inspection
- problem grouping
- retained-history scanning
- local Claude Code and Codex capture through Herdr

Osiris is intentionally evidence-first.

A shell exit code is an observation. It is not necessarily a failure.

A successful command is an observation. It is not necessarily progress.

That distinction is where this is going.

---

## Install

BFF requires Python 3.9+, Git and `curl` for repo adoption.

BB and Herdr are upstream applications. BFF does not quietly install agent runtimes, rewrite your shell profile, seize your hooks or pretend it owns your machine.

```sh
curl -fsSL https://raw.githubusercontent.com/triunai/bff/v0.1.1/install.sh | sh
```

The pinned bootstrap:

- downloads the tagged release archive
- verifies its checksum and expected file inventory
- preserves the release under `~/.local/share/bff/releases/`
- exposes `~/.local/bin/bff`
- tells you if that directory is missing from `PATH`
- does not edit your shell startup files

Checksum and archive share GitHub's publisher trust boundary. This is not an independently signed distribution. Adults may make their own threat-model decisions.

To rehearse installation without touching the normal prefix:

```sh
sh install.sh --prefix /tmp/bff-test
```

---

## Open Osiris

With BB already running:

```sh
bff osiris --install
```

BFF installs the included prebuilt Osiris plugin through BB and opens it.

The tested baseline is BB 0.45+ against public SDK 0.6.15. Upstream compatibility remains upstream compatibility; BFF does not claim clairvoyance.

Main Osiris keeps the useful thing in the middle: the conversation.

Work stays on the left. Changes stay on the right. Trace and Problems can replace the inspection pane when you need to stop guessing and look at what the agent actually did.

Toolcalls also exists as a standalone BB sidebar surface for broader retained-history inspection.

Useful searches:

```text
status:error
tool:Bash
provider:codex
duration:>5s
```

---

## Start the workbench

```sh
bff start
```

This opens the existing BB workbench and requests an independent named Herdr session in a terminal on supported platforms.

It does not install either application.

It does not claim that a process started merely because it asked nicely.

For the plan without execution:

```sh
bff start --print-plan
```

For the Osiris URL only:

```sh
bff osiris --print-url
```

---

## Doctor

There are enough agent-development tools now that remembering which package manager owns which one has become an embarrassing use of human memory.

So:

```sh
bff doctor
```

Useful forms:

```sh
bff doctor              # inspect, plan, ask once
bff doctor --yes        # execute the plan
bff doctor --no-upgrade # install missing tools only
bff doctor --offline    # skip BFF's release check
bff doctor --json       # report only; machine-readable
```

`doctor` checks BFF, Herdr, Beads, OMC, OMX, BB and aeh.

For tools with documented package-manager ownership, it compares the installed version with the latest stable version and plans the appropriate install or upgrade.

For tools without a supported automated route, it says so.

No `sudo`.

No shell-string roulette.

No piping mystery installers into another mystery installer.

Each action is printed before execution, run independently, and verified afterwards. One failure does not prevent unrelated work from continuing.

Current routes:

```text
Herdr  -> brew
Beads  -> brew / npm
OMC    -> npm
OMX    -> npm
BB     -> manual
aeh    -> manual
```

---

## Observe Claude Code and Codex

```sh
bff herdr
```

Keep it running in the foreground.

Then choose:

```text
••• -> Source -> Herdr / local provider capture
```

Osiris receives bounded snapshots from recent local Claude Code and Codex transcripts every five seconds.

Available selectors include:

```sh
bff herdr --once
bff herdr --latest 4
bff herdr --session <exact-session>
```

Claude Bash calls and Codex `commandExecution` calls are currently observable.

Commands you typed yourself are not magically Claude's commands.

Herdr pane membership is not currently proven.

BB thread identity is not guessed.

A fresh capture timestamp is not called a heartbeat.

Different evidence sources stay different until there is evidence that they are the same thing.

That sounds pedantic until the first time bad telemetry convinces you of something that never happened.

---

## Adopt a repository

```sh
bff init --repo /path/to/repo
bff check --repo /path/to/repo
bff hydrate --repo /path/to/repo --ws WS-01
```

`init` does not flatten an existing repository into BFF's preferred worldview.

Existing files are preserved.

Existing documentation systems require an explicit binding or migration.

The ownership model is intentionally boring:

```text
repo docs     -> scope, facts, decisions, evidence
hygiene.md    -> execution order
orchestrator  -> authoritative spine writes and numbering
lanes         -> committed evidence in their own worktrees
```

Boring ownership rules are cheaper than clever merge conflicts.

Canonical BFF skills live under:

```text
.agents/skills/bff-*
```

Current skills cover task contracts, hydration, thermonuclear quality review and thermonuclear wraps.

Use them through your agent's supported discovery mechanism.

BFF does not silently install global aliases and then act surprised when your existing setup breaks.

---

## Fitness before confidence

Configure actual project checks in `.bff.json`.

Then:

```sh
bff check --run
```

This executes the configured test, build and fitness commands with the normal permissions of the machine running BFF.

A green command is evidence.

It is not theology.

Important invariants should have teeth checks. Critical paths should have real tests. The output tells you what BFF actually verified and where enforcement stops.

Installation does not silently:

- rewrite Git hooks
- configure branch protection
- enable CI
- manufacture model reviews
- declare your repository correct

Those are engineering decisions, so BFF leaves them visible.

---

## Context is promoted, not dumped

Obsidian and other external knowledge sources are additive teaching material.

Hydrate what matters.

Record where it came from.

Promote reviewed knowledge into one durable home in the repository.

Do not turn a private vault into a second undocumented runtime dependency and then wonder why nobody else can reproduce the project.

See:

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [PROVENANCE.md](PROVENANCE.md)

Private vaults, credentials, historical sessions and someone's heroic laptop state are not part of the distribution.

---

## Rollback

Releases are preserved.

Activate one:

```sh
python3 install.py --activate <preserved-release>
```

Disable the owned command link:

```sh
python3 install.py --disable
```

Neither operation pretends your project files or runtime state belong to BFF.

---

## Development

```sh
python3 -m unittest discover -s tests -q

npm ci
npm run test:osiris

python3 scripts/build-bff-release.py \
  --output /tmp/bff-release
```

Node 24 is used for Osiris development tests.

Osiris source and prebuilt assets live under:

```text
plugins/osiris
```

The Python CLI and TypeScript UI/server are separate components shipped in one SDK.

See component notices for upstream licensing.

BFF-authored code is MIT.

---

## Status

BFF is bootstrap-stage software.

That means two things:

1. it already has a real job;
2. it is not going to lie about jobs it cannot do yet.

Current gaps include automatic hook/CI adoption, complete agent-lineage and landing visualization, manual terminal recording, and live Beads/Gas/DSH evaluation adapters.

Those are roadmap items, not creatively worded existing features.

See [CHANGELOG.md](CHANGELOG.md) for the exact shipped surface by release.

---
