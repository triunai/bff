"""`bff osiris install`: the ONE install-and-update path (D-128). Idempotent: a re-run with nothing new changes nothing.

Plan first, then one question, then do it:

1. bff itself (script installs only): the latest release, verified before the swap by `update.apply_update`
   (checksum, attestation when `gh` exists, safe extract, manifest, smoke test). Skipped when already current.
2. the Osiris plugin, from the first source that applies:
   `--from DIR` > the published pinned release (compat.json `published`) > the newest staged build on this machine
   (`~/.local/share/osiris-worktrees/install-*`, the developer box) > the private pinned commit, built and gated
   locally (`osiris_source`). Every candidate is gated on a fresh copy before BB installs it; a failed install
   restores the previous source. The stale plugin bundled inside old bff releases is never a candidate.

When bff itself changes, the plugin step runs from the NEW bff (`<prefix>/bin/bff osiris update --yes`, with
BFF_SKIP_SELF_UPDATE=1), so the plugin is always installed by the code that pins it.

Exit codes: 0 done or nothing to do; 1 failed, or consent needed on a non-TTY; 3 bff is fine but a prerequisite you
install yourself is missing (the list is printed in order).
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys

from . import __version__, osiris, osiris_source, paths, update
from .prompt import confirm

SKIP_SELF = "BFF_SKIP_SELF_UPDATE"
WAITING = 3


def _err(text):
    print(text, file=sys.stderr)


def _newer(a, b):
    return tuple(map(int, a.split("."))) > tuple(map(int, b.split(".")))


def plan_self(env=None):
    """{"action": "update"|"current"|"skip", "line", ...}; one cheap read of the latest SHA256SUMS."""
    env = os.environ if env is None else env
    if env.get(SKIP_SELF):
        return {"action": "skip", "line": None}
    prefix = paths.install_prefix()
    if prefix is None:
        method = paths.install_method()
        hint = {"dev": "a source checkout: update it with git pull", "uv": "uv tool upgrade bff",
                "brew": "brew upgrade bff"}.get(method, "not installed by install.sh: reinstall it to get updates")
        return {"action": "skip", "line": "bff " + __version__ + ": " + hint}
    base = update.release_base(env)
    latest = update.latest_version(base)
    if latest is None:
        return {"action": "skip", "line": "bff " + __version__ + ": latest release unknown (offline?), kept as is"}
    if not _newer(latest, __version__):
        return {"action": "current", "line": "bff " + __version__ + " is up to date"}
    return {"action": "update", "line": "bff " + __version__ + " -> " + latest + " (verified before the swap)",
            "version": latest, "prefix": prefix, "base": base}


def _managed(source, staging_root, builds_root):
    """A path: source bff may replace: a staged install-* build or one of bff's own builds."""
    if not source or osiris._kind(source) != "path":
        return False
    directory = Path(osiris._bare(source))
    parent = directory.parent.resolve() if directory.parent.exists() else directory.parent
    return directory.name.startswith("install-") and parent in {Path(staging_root).resolve(), Path(builds_root).resolve()}


def _same_dir(source, directory):
    return bool(source) and osiris._kind(source) == "path" and \
        Path(osiris._bare(source)).resolve() == Path(directory).resolve()


def plan_plugin(compat, status, *, from_dir=None, ref=None, staging_root=None, builds_root=None, switch=False,
                out=None):
    """What the plugin step would do, without changing anything or touching the network."""
    o = compat["osiris"]
    staging_root = staging_root or os.environ.get("OSIRIS_STAGING_DIR") or str(
        Path.home() / ".local" / "share" / "osiris-worktrees")
    builds_root = Path(builds_root or osiris_source.builds_dir())
    current = status["display"] + " (" + str(status["version"]) + ")" if status["present"] else "not installed"
    plan = {"current": current, "action": "install"}
    if from_dir:
        plan.update(kind="from", dir=Path(from_dir), label=str(from_dir))
    elif status["present"] and status["kind"] == "path" and not status["stale_bundled"] and not switch \
            and not _managed(status["source"], staging_root, builds_root):
        return dict(plan, action="keep", line="Osiris dev install " + current + " left as is (--switch-to-release replaces it)")
    elif o["published"]:
        target = osiris._target(compat)
        if status["present"] and osiris._healthy(status, o["version"]) and status["source"] == target:
            return dict(plan, action="current", line="Osiris " + o["version"] + " is up to date")
        plan.update(kind="release", source=target, version=o["version"], label=target)
    else:
        staged = osiris._pick_staged(staging_root, out=_Discard()) if Path(staging_root).is_dir() else None
        private = osiris_source.spec(compat)
        if staged is not None and ref is None:
            plan.update(kind="staged", dir=staged, label=staged.name + " (newest staged build on this machine)")
        elif private is not None:
            commit = ref or private["ref"]
            # A branch name (--ref) has no build dir until it is fetched and resolved to a commit.
            directory = builds_root / osiris_source.build_name(private.get("label") or private["version"], commit) \
                if osiris_source.SHA.fullmatch(commit) else None
            plan.update(kind="private", dir=directory, repo=private["repo"], ref=commit, builds_root=builds_root,
                        built=directory is not None and directory.exists() and osiris._unfit(directory) is None,
                        label="github.com/" + private["repo"] + " @ " + commit[:12] + " (private; built and gated here)")
        else:
            return dict(plan, action="none", line=osiris.UNPUBLISHED)
    if plan.get("dir") is not None and status["present"] and _same_dir(status["source"], plan["dir"]) \
            and osiris._healthy(status):
        return dict(plan, action="current", line="Osiris " + str(status["version"]) + " is up to date (" + plan["dir"].name + ")")
    plan["line"] = "Osiris " + current + " -> " + plan["label"]
    return plan


class _Discard:
    def write(self, _text):
        pass


def prerequisites_for(plan, rows, which=shutil.which):
    """Required-and-missing items, in the order to install them."""
    missing = [r for r in rows if r["required"] and not r["ok"]]
    if plan.get("kind") == "private" and not plan.get("built"):
        have = {r["name"] for r in missing}
        for tool in osiris_source.missing_tools(which):
            label = {"node": "Node", "npm": "Node", "bb": "BB"}.get(tool, tool)
            if label not in have:
                have.add(label)
                missing.append({"name": label, "how": {"git": "Install git yourself: https://git-scm.com",
                                                        "bash": "Install bash yourself (your package manager)",
                                                        "Node": "Install Node yourself: https://nodejs.org or brew install node"}
                                .get(label, "Install " + label + " yourself")})
    return missing


def _execute_plugin(plan, compat, bb, run, out, state_file):
    if plan["kind"] == "release":
        status = osiris.plugin_status(bb, run, compat["osiris"]["id"])
        return osiris._install_checked(bb, run, out, state_file, plan["source"], plan["version"], status)[0]
    directory = plan["dir"]
    if plan["kind"] == "private" and not plan.get("built"):
        try:
            checkout, head = osiris_source.fetch(plan["repo"], plan["ref"], cache=osiris_source.cache_dir(),
                                                 run=run, out=lambda line: osiris._say(out, line))
            private = osiris_source.spec(compat)
            directory = Path(plan["builds_root"]) / osiris_source.build_name(private.get("label") or private["version"], head)
            if not directory.exists():
                osiris_source.build(checkout, directory, run=run, out=lambda line: osiris._say(out, line))
        except osiris_source.SourceError as error:
            _err("bff: " + str(error))
            return 1
    elif plan["kind"] in ("from", "staged"):
        reason = osiris._unfit(directory)
        if reason:
            _err("bff: refusing " + str(directory) + ": " + reason)
            return 1
    return osiris._from_dir(compat, directory, bb, run, out, state_file)


def run_install(*, yes=False, dry_run=False, from_dir=None, ref=None, switch=False, require_attestation=False,
                stdin=None, out=None, run=subprocess.run, which=shutil.which, state_file=None, compat=None,
                staging_root=None, builds_root=None, env=None):
    stdin = sys.stdin if stdin is None else stdin
    out = sys.stdout if out is None else out
    env = os.environ if env is None else env
    compat = compat or osiris.load_compat()
    state_file = state_file if state_file is not None else paths.active_state_path()
    me = plan_self(env)
    bb = which("bb")
    rows = osiris.prerequisites(None, which, run, compat, bb)
    status = osiris.plugin_status(bb, run, compat["osiris"]["id"]) if bb else {"present": False}
    plugin = plan_plugin(compat, status, from_dir=from_dir, ref=ref, staging_root=staging_root,
                         builds_root=builds_root, switch=switch) if bb else {"action": "blocked"}
    osiris._say(out, "bff osiris install plan")
    if me["line"]:
        osiris._say(out, "  " + me["line"])
    missing = prerequisites_for(plugin, rows, which) if plugin["action"] in ("install", "blocked") else []
    if plugin["action"] != "blocked":
        osiris._say(out, "  " + plugin["line"])
    for item in rows:
        if not item["required"] and not item["ok"]:
            osiris._say(out, "  note: " + item["name"] + " missing (optional): " + item["how"])
    change_self = me["action"] == "update"
    change_plugin = plugin["action"] == "install"
    if missing and not change_self:
        osiris._say(out, "Osiris is waiting on prerequisites. Install these yourself, in order, then run bff osiris install:")
        for item in missing:
            osiris._say(out, "  " + item["name"] + ": " + item["how"])
        return WAITING
    if not change_self and not change_plugin:
        osiris._say(out, "Nothing to do: everything is up to date.")
        return 0
    if dry_run:
        osiris._say(out, "[dry run] nothing changed")
        return 0
    if not yes:
        if not stdin.isatty():
            _err("bff osiris install: nothing changed; this needs your OK. Re-run with --yes (or run it in a terminal).")
            return 1
        if not confirm("Install? [Y/n] ", stdin, out):
            osiris._say(out, "Nothing changed.")
            return 0
    if change_self:
        try:
            result = update.apply_update(me["version"], prefix=me["prefix"], base=me["base"],
                                         require_attestation=require_attestation, out=out)
        except ValueError as error:
            _err("bff: update failed, nothing changed: " + str(error))
            return 1
        if result.get("changes"):
            osiris._say(out, result["changes"])
        osiris._say(out, "undo: bff rollback")
        if missing:
            osiris._say(out, "Osiris is waiting on prerequisites; install them, then run bff osiris install:")
            for item in missing:
                osiris._say(out, "  " + item["name"] + ": " + item["how"])
            return WAITING
        # The NEW bff installs the plugin it pins (old code must never pick the plugin for new code).
        outcome = update.plugin_step(me["prefix"], run=run, which=which, out=lambda line: osiris._say(out, line))
        return 0 if outcome in ("ok", "skipped", "unpublished") else (WAITING if outcome == "waiting" else 1)
    return _execute_plugin(plugin, compat, bb, run, out, state_file)
