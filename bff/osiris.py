"""Osiris plugin management over BB's machine-readable plugin list. Detects, prints, installs through `bb plugin install`.

Every function takes an injectable `bb` executable and `run` (subprocess runner) so tests use a fake. The pinned plugin
version comes from `compat.json`; a `path:` install is the developer channel and is never replaced without an explicit flag.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

from . import paths, state
from .prompt import answer_is_yes

PLUGIN_ID = "tool-observer"
UNPUBLISHED = ("No public Osiris release is pinned for this bff yet (owner decision D1). "
               "Developers: bff osiris update --from <dir>.")
NO_BB = "BB not found: run bff osiris setup to see what to install"


def load_compat(root=None):
    root = Path(root) if root is not None else Path(__file__).resolve().parents[1]
    try:
        data = json.loads((root / "compat.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError("compat.json unreadable: " + str(error))
    osiris = data.get("osiris") if isinstance(data, dict) else None
    ok = (isinstance(osiris, dict) and data.get("schema_version") == 1 and _version(data.get("bb_min")) is not None
          and all(isinstance(osiris.get(key), str) and osiris[key] for key in ("id", "version", "source"))
          and isinstance(osiris.get("published"), bool)
          and (osiris.get("commit") is None or isinstance(osiris["commit"], str)))
    if not ok:
        raise ValueError("compat.json has an unexpected shape")
    return data


def _version(text):
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", text) if isinstance(text, str) else None
    return tuple(int(part) for part in match.groups()) if match else None


def _say(out, text=""):
    (out if out is not None else sys.stdout).write(text + "\n")


def _bare(source):
    return source[len("path:"):] if source.startswith("path:") else source


def _kind(source):
    return source.split(":", 1)[0] if ":" in source else "path"


def _stale_bundled(source):
    if _kind(source) != "path":
        return False
    directory = Path(_bare(source))
    if directory.parts[-2:] != ("plugins", "osiris"):
        return False
    for ancestor in directory.parents:
        if paths.RELEASE_NAME.fullmatch(ancestor.name) or (
                (ancestor / "bff" / "cli.py").is_file() and (ancestor / "install.py").is_file()):
            return True
    return False


def plugin_status(bb, run=subprocess.run, plugin_id=PLUGIN_ID):
    try:
        result = run([bb, "plugin", "list", "--json"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                     universal_newlines=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError("Could not run bb plugin list: " + str(error) + "; check that BB runs, then retry")
    if result.returncode:
        raise ValueError("bb plugin list failed with exit " + str(result.returncode) + "; update BB or run bb plugin list --json yourself")
    try:
        listing = json.loads(result.stdout)
        plugins = listing["plugins"]
        if not isinstance(plugins, list):
            raise TypeError("plugins is not a list")
    except (ValueError, KeyError, TypeError):
        raise ValueError("bb plugin list --json returned unreadable output; update BB to 0.45.0 or newer")
    entry = next((p for p in plugins if isinstance(p, dict) and p.get("id") == plugin_id), None)
    if entry is None:
        return {"present": False, "id": plugin_id, "version": None, "enabled": False, "status": None,
                "source": None, "kind": None, "stale_bundled": False, "display": None}
    source = str(entry.get("source") or "")
    return {"present": True, "id": plugin_id, "version": entry.get("version"), "enabled": bool(entry.get("enabled")),
            "status": entry.get("status"), "source": source, "kind": _kind(source),
            "stale_bundled": _stale_bundled(source), "display": entry.get("sourceDisplay") or source}


def _tool_version(argv, run):
    try:
        result = run(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    match = re.search(r"\d+(?:\.\d+)+", result.stdout or "") if not result.returncode else None
    return match.group(0) if match else None


def prerequisites(system=None, which=shutil.which, run=subprocess.run, compat=None, bb=None):
    import platform
    system = platform.system() if system is None else system
    compat = compat or load_compat()
    bb = bb or which("bb")
    rows = []

    def row(name, path, required, how, version=None, ok=None):
        found = path is not None
        rows.append({"name": name, "found": found, "version": version, "required": required, "how": how,
                     "ok": found if ok is None else ok})

    if system == "Darwin":
        row("Homebrew", which("brew"), False, "Install Homebrew yourself: https://brew.sh")
    node = which("node")
    row("Node", node, bb is None, "Install Node yourself: https://nodejs.org or brew install node",
        _tool_version([node, "--version"], run) if node else None)
    bb_version = _tool_version([bb, "--version"], run) if bb else None
    minimum = compat["bb_min"]
    recent = bb is not None and _version(bb_version) is not None and _version(bb_version) >= _version(minimum)
    row("BB", bb, True, "Install BB yourself: npx bb-app@latest (needs " + minimum + " or newer)", bb_version, recent)
    row("git", which("git"), False, "Install git yourself: https://git-scm.com",
        _tool_version([which("git"), "--version"], run) if which("git") else None)
    row("herdr", which("herdr"), False, "Install herdr yourself; bff doctor explains how")
    row("bd", which("bd"), False, "Install bd (beads) yourself; bff doctor explains how")
    row("bdi", which("bdi"), False, "Optional" + ("" if system == "Darwin" else " off macOS") + ": install bdi yourself if you use it")
    return rows


def _print_plan(rows, out):
    _say(out, "Osiris setup plan")
    for item in rows:
        mark = "ok" if item["ok"] else ("MISSING" if item["required"] else "missing (optional)")
        if item["found"] and not item["ok"]:
            mark = "TOO OLD"
        _say(out, "  {:<9} {:<18} {}".format(item["name"], mark, item["version"] or ""))


def _confirm(prompt, stdin, out):
    stdin = stdin if stdin is not None else sys.stdin
    if not stdin.isatty():
        return None
    _say(out, prompt + " [Y/n]")
    return answer_is_yes(stdin.readline())


def with_ref(source, ref):
    head, sep, tail = source.rpartition("@")
    return (head if sep and "/" not in tail and ":" not in tail else source) + "@" + ref


def _target(compat):
    osiris = compat["osiris"]
    return with_ref(osiris["source"], osiris["commit"]) if osiris["commit"] else osiris["source"]


def _install(bb, run, source):
    try:
        return run([bb, "plugin", "install", _bare(source), "--yes"], timeout=600).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _healthy(status, version=None):
    ok = status["present"] and status["status"] == "running" and status["enabled"]
    return ok and (version is None or status["version"] == version)


def _record(state_file, status, previous):
    path = state_file if state_file is not None else paths.active_state_path()

    def mutate(data):
        data["plugin"] = {"id": status["id"], "source": status["source"], "version": status["version"],
                          "previous_source": previous}
    state.update(path, mutate)


def _install_checked(bb, run, out, state_file, source, version, before):
    """Install `source`, require a healthy plugin at `version`; on failure restore the previous source. 0 or 1."""
    previous = before["source"] if before["present"] else None
    _install(bb, run, source)
    try:
        after = plugin_status(bb, run)
    except ValueError:
        after = {"present": False}
    if after.get("present") and _healthy(after, version):
        _record(state_file, after, previous)
        _say(out, "Installed Osiris " + str(after["version"]) + " from " + after["display"] + ".")
        return 0, after
    _say(out, "Osiris install did not verify (wanted running " + str(version) + "); nothing was recorded.")
    if previous:
        restored = _install(bb, run, previous)
        _say(out, "Restored the previous plugin source " + previous if restored else
             "Could not restore the previous source; run: bb plugin install " + _bare(previous) + " --yes")
    return 1, after


def _plugin_step(compat, bb, run, out, stdin, state_file, yes, dry_run, switch, target=None, version=None):
    osiris = compat["osiris"]
    status = plugin_status(bb, run, osiris["id"])
    if status["present"] and status["kind"] == "path" and not status["stale_bundled"] and not switch:
        _say(out, "Osiris dev channel: " + status["display"] + " (" + str(status["version"]) + "), left as is. "
             "Use --switch-to-release to replace it.")
        return 0
    if status["stale_bundled"]:
        _say(out, "your Osiris plugin comes from an old bff bundle (" + str(status["version"]) + ")")
    if not osiris["published"]:
        _say(out, UNPUBLISHED)
        return 3
    target = target or _target(compat)
    version = version or osiris["version"]
    if status["present"] and _healthy(status, version) and status["source"] == target:
        _say(out, "Osiris " + version + " is up to date (" + status["display"] + ").")
        return 0
    plan = "Plan: bb plugin install " + target + " --yes (replaces " + (status["display"] if status["present"] else "nothing") + ")"
    if dry_run:
        _say(out, plan + " [dry run, nothing changed]")
        return 0
    if not yes:
        answer = _confirm(plan + ". Install?", stdin, out)
        if answer is None:
            _say(out, plan + "\nRe-run with --yes to install.")
            return 0
        if not answer:
            _say(out, "Left as is.")
            return 0
    return _install_checked(bb, run, out, state_file, target, version, status)[0]


def _resolve_bb(bb, which=shutil.which):
    bb = bb or which("bb")
    if bb is None:
        raise ValueError(NO_BB)
    return bb


def setup(yes=False, dry_run=False, switch_to_release=False, stdin=None, out=None, bb=None, run=subprocess.run,
          state_file=None, which=shutil.which, system=None, compat=None):
    compat = compat or load_compat()
    rows = prerequisites(system, which, run, compat, bb)
    _print_plan(rows, out)
    missing = [item for item in rows if item["required"] and not item["ok"]]
    if missing:
        _say(out, "bff is installed; Osiris is waiting on prerequisites. Install these yourself, in order:")
        for item in rows:
            if not item["ok"] and (item["required"] or item["name"] in ("Homebrew", "Node")):
                _say(out, "  " + item["name"] + ": " + item["how"])
        return 3
    return _plugin_step(compat, bb or which("bb"), run, out, stdin, state_file, yes, dry_run, switch_to_release)


def _pick_staged(root, out):
    entries = []
    for entry in sorted(Path(root).glob("install-*")):
        match = re.match(r"install-(\d+(?:\.\d+)*)", entry.name)
        entries.append((tuple(int(p) for p in match.group(1).split(".")) if match else (), entry.name, entry))
    for _, name, entry in sorted(entries, reverse=True):
        reason = _unfit(entry)
        if reason is None:
            return entry
        _say(out, "skipped " + name + ": " + reason)
    return None


def _unfit(entry):
    if entry.is_symlink():
        return "is itself a symlink"
    if not entry.is_dir():
        return "is not a directory"
    for current, dirs, files in os.walk(str(entry), followlinks=False):
        for name in dirs + files:
            if os.path.islink(os.path.join(current, name)):
                return "contains a symlink (" + os.path.relpath(os.path.join(current, name), str(entry)) + ")"
    if not (entry / "node_modules" / "@xterm" / "xterm").is_dir():
        return "has no node_modules/@xterm/xterm"
    return None


def _from_dir(compat, directory, bb, run, out, state_file):
    status = plugin_status(bb, run, compat["osiris"]["id"])
    if status["present"] and status["kind"] == "path" and Path(_bare(status["source"])).resolve() == directory.resolve() \
            and _healthy(status):
        _say(out, "already up to date: " + status["display"])
        return 0
    workdir = Path(tempfile.mkdtemp(prefix="bff-osiris-gate-"))
    copy = workdir / "plugin"
    try:
        shutil.copytree(str(directory), str(copy), symlinks=True)
        built = run([bb, "plugin", "build", "."], cwd=str(copy), timeout=600).returncode == 0
    except (OSError, shutil.Error, subprocess.TimeoutExpired):
        built = False
    if not built:
        _say(out, "Gate FAILED: BB could not build " + str(directory) + "; not installing (copy left at " + str(workdir) + ")")
        return 1
    shutil.rmtree(str(workdir), ignore_errors=True)
    wanted = None
    try:
        wanted = json.loads((directory / "package.json").read_text(encoding="utf-8")).get("version")
    except (OSError, ValueError, AttributeError):
        pass
    code, _ = _install_checked(bb, run, out, state_file, str(directory), wanted, status)
    if code == 0 and status["present"]:
        _say(out, "rollback: bb plugin install " + _bare(status["source"]) + " --yes")
    return code


def update(version=None, from_dir=None, from_latest_staged=False, switch_to_release=False, yes=False, stdin=None,
           out=None, bb=None, run=subprocess.run, state_file=None, staging_root=None, which=shutil.which, compat=None):
    if sum(bool(flag) for flag in (version, from_dir, from_latest_staged)) > 1:
        raise ValueError("Choose one of --version, --from or --from-latest-staged")
    compat = compat or load_compat()
    bb = _resolve_bb(bb, which)
    if from_dir or from_latest_staged:
        if from_dir:
            directory = Path(from_dir)
            reason = _unfit(directory)
            if reason:
                _say(out, "Refusing " + str(directory) + ": " + reason)
                return 1
        else:
            root = staging_root or os.environ.get("OSIRIS_STAGING_DIR") or str(Path.home() / ".local" / "share" / "osiris-worktrees")
            directory = _pick_staged(root, out)
            if directory is None:
                _say(out, "No usable install-* build under " + str(root))
                return 1
            _say(out, "picked " + directory.name)
        return _from_dir(compat, directory, bb, run, out, state_file)
    if version:
        if not compat["osiris"]["published"]:
            _say(out, UNPUBLISHED)
            return 3
        _say(out, "off pin: compat.json pins " + compat["osiris"]["version"])
        return _plugin_step(compat, bb, run, out, stdin, state_file, yes, False, switch_to_release,
                            with_ref(compat["osiris"]["source"], "v" + version), version)
    return _plugin_step(compat, bb, run, out, stdin, state_file, yes, False, switch_to_release)


def rollback_plugin(bb, run=subprocess.run, out=None, state_file=None, yes=False, stdin=None):
    path = state_file if state_file is not None else paths.active_state_path()
    recorded = state.load(path).get("plugin")
    previous = recorded.get("previous_source") if isinstance(recorded, dict) else None
    if not previous:
        raise ValueError("No previous Osiris plugin is recorded; nothing to roll back")
    if not yes and stdin is not None and _confirm("Re-install " + _bare(previous) + "?", stdin, out) is False:
        _say(out, "Left as is.")
        return 0
    _install(bb, run, previous)
    status = plugin_status(bb, run, recorded.get("id") or PLUGIN_ID)
    if not _healthy(status):
        _say(out, "Rollback did not verify; the recorded state is unchanged.")
        return 1
    _record(path, status, recorded.get("source"))
    _say(out, "Rolled back to " + status["display"] + " (" + str(status["version"]) + ").")
    return 0
