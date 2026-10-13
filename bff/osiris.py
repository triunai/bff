"""Osiris plugin management over BB's machine-readable plugin list. Detects, prints, installs through `bb plugin install`.

Every function takes an injectable `bb` executable and `run` (a vetted subprocess runner) so tests use a fake. The pinned plugin
version comes from `compat.json`; a `path:` install is the developer channel and is never replaced without an explicit flag.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import uuid

from . import osiris_tui, paths, state, trusted_bin
from .prompt import answer_is_yes

PLUGIN_ID = "tool-observer"
BUNDLED_SOURCE = "bundled"  # compat.json source for an Osiris that ships inside the bff release archive
BUNDLE_PREFIX = "plugins/osiris/"
STABLE_DIRNAME = "osiris"  # <bff data dir>/osiris/<version>-<id>: outside releases/<ver>/, so a bff update or prune never strands BB


def _which(name):
    """Late-bound so a caller (or a test) that replaces trusted_bin.which is honoured by every default."""
    return osiris_tui.which(name)


def _run(argv, **kwargs):
    """The default runner: trusted_bin.run (argv[0] must be an absolute trusted program, minimal env) plus the shared tool variables bb and git need
    (and, on Windows, the variables a Windows program needs to start)."""
    return trusted_bin.run(argv, inherit=osiris_tui.tool_inherit(), **kwargs)


UNPUBLISHED = ("Osiris is not publicly released yet; nothing to install. "
               "Developers: bff osiris update --from <dir>.")
UNPUBLISHED_EXIT = 4  # distinct from 3, which means a prerequisite is missing
NEEDED_FOR = {"bd": "needed for the Work tab", "herdr": "needed to join terminal panes"}
NO_BB = "BB not found: run bff osiris setup to see what to install"
# BB ships a Windows x64 installer (bb-<version>-x64.exe on https://github.com/get-bb/bb/releases) and its npm package lists win32; it needs Node 22.19+.
POSIX_HINTS = {"node": "Install Node yourself: https://nodejs.org or brew install node",
               "bb": "Install BB yourself: npx bb-app@latest (needs {minimum} or newer)",
               "git": "Install git yourself: https://git-scm.com", "gh": ""}
WINDOWS_HINTS = {"node": "Install Node 22.19 or newer yourself: winget install OpenJS.NodeJS.LTS",
                 "bb": "Install BB yourself: npx bb-app@latest, or the Windows installer (bb-<version>-x64.exe) from https://github.com/get-bb/bb/releases (needs {minimum} or newer)",
                 "git": "Install git yourself: winget install Git.Git",
                 "gh": "Optional, verifies update provenance: winget install GitHub.cli",
                 "herdr": "Optional, joins terminal panes. Install Herdr for Windows from https://herdr.dev (Windows installer script: https://herdr.dev/install.ps1; read it before running)"}


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


def _data_root():
    return Path(str(paths.data_dir(prefix=paths.install_prefix())))


def _managed_bundle(source):
    """True for a plugin installed from bff's own stable copy (<data>/osiris/<version>-<id>): the release channel, not a dev path."""
    if _kind(source) != "path":
        return False
    directory = Path(_bare(source))
    wanted = _data_root() / STABLE_DIRNAME
    return directory.parent == wanted or directory.parent.resolve() == wanted.resolve()


def plugin_status(bb, run=_run, plugin_id=PLUGIN_ID):
    try:
        result = run([bb, "plugin", "list", "--json"], stdout=trusted_bin.PIPE, stderr=trusted_bin.PIPE,
                     universal_newlines=True, timeout=30)
    except (OSError, trusted_bin.TimeoutExpired) as error:
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
                "source": None, "kind": None, "stale_bundled": False, "managed_bundle": False, "display": None}
    source = str(entry.get("source") or "")
    return {"present": True, "id": plugin_id, "version": entry.get("version"), "enabled": bool(entry.get("enabled")),
            "status": entry.get("status"), "source": source, "kind": _kind(source),
            "stale_bundled": _stale_bundled(source), "managed_bundle": _managed_bundle(source), "display": entry.get("sourceDisplay") or source}


def _tool_version(argv, run):
    try:
        result = run(argv, stdout=trusted_bin.PIPE, stderr=trusted_bin.STDOUT, universal_newlines=True, timeout=10)
    except (OSError, trusted_bin.TimeoutExpired):
        return None
    match = re.search(r"\d+(?:\.\d+)+", result.stdout or "") if not result.returncode else None
    return match.group(0) if match else None


def prerequisites(system=None, which=_which, run=_run, compat=None, bb=None):
    import platform
    system = platform.system() if system is None else system
    compat = compat or load_compat()
    bb = bb or which("bb")
    rows = []

    def row(name, path, required, how, version=None, ok=None):
        found = path is not None
        rows.append({"name": name, "found": found, "version": version, "required": required, "how": how,
                     "ok": found if ok is None else ok})

    windows = system == "Windows"
    hints = WINDOWS_HINTS if windows else POSIX_HINTS
    if system == "Darwin":
        row("Homebrew", which("brew"), False, "Install Homebrew yourself: https://brew.sh")
    node = which("node")
    row("Node", node, bb is None, hints["node"], _tool_version([node, "--version"], run) if node else None)
    bb_version = _tool_version([bb, "--version"], run) if bb else None
    minimum = compat["bb_min"]
    recent = bb is not None and _version(bb_version) is not None and _version(bb_version) >= _version(minimum)
    row("BB", bb, True, hints["bb"].format(minimum=minimum), bb_version, recent)
    git = which("git")
    row("git", git, False, hints["git"], _tool_version([git, "--version"], run) if git else None)
    if windows:
        gh = which("gh")
        row("gh", gh, False, hints["gh"], _tool_version([gh, "--version"], run) if gh else None)
    herdr = which("herdr")
    row("herdr", herdr, False, hints["herdr"] if windows else "Install herdr yourself; bff doctor explains how",
        _tool_version([herdr, "--version"], run) if windows and herdr else None)
    row("bd", which("bd"), False, "Install bd (beads) yourself; bff doctor explains how")
    row("bdi", which("bdi"), False, "Optional" + ("" if system == "Darwin" else " off macOS") + ": install bdi yourself if you use it")
    return rows


def _print_plan(rows, out):
    _say(out, "Osiris setup plan")
    for item in rows:
        mark = "ok" if item["ok"] else ("MISSING" if item["required"] else "missing (optional)")
        if item["found"] and not item["ok"]:
            mark = "TOO OLD"
        note = item.get("note") or item["version"] or ("" if item["found"] else NEEDED_FOR.get(item["name"], ""))
        _say(out, "  {:<9} {:<18} {}".format(item["name"], mark, note))


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


def _release_root():
    return Path(__file__).resolve().parents[1]


def bundled_files(root=None):
    """{name inside plugins/osiris: sha256} the release manifest promises for the bundled plugin."""
    root = Path(root) if root is not None else _release_root()
    try:
        files = json.loads((root / "manifest.json").read_text(encoding="utf-8"))["files"]
    except (OSError, ValueError, KeyError, TypeError):
        raise ValueError("The bundled Osiris cannot be verified: no readable release manifest here. "
                         "Install bff from a release (install.sh / install.ps1), or use bff osiris update --from <dir> for a dev build.")
    found = {name[len(BUNDLE_PREFIX):]: digest for name, digest in files.items() if name.startswith(BUNDLE_PREFIX)}
    if "package.json" not in found:
        raise ValueError("This bff release carries no bundled Osiris plugin")
    return found


def stable_dir(version, files):
    """Where the bundled plugin lives for good. The id is a digest of the manifest entries, so changed content never reuses a name."""
    identity = hashlib.sha256(json.dumps(sorted(files.items())).encode("utf-8")).hexdigest()[:12]
    return _data_root() / STABLE_DIRNAME / ("osiris-" + version + "-" + identity)


def _inventory(directory):
    found = {}
    for current, dirs, names in os.walk(str(directory), followlinks=False):
        for name in dirs + names:
            if os.path.islink(os.path.join(current, name)):
                raise ValueError("symlink in the Osiris copy: " + os.path.join(current, name))
        for name in names:
            path = os.path.join(current, name)
            found[os.path.relpath(path, str(directory)).replace(os.sep, "/")] = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    return found


def materialize_bundled(version, root=None):
    """Copy the bundled plugin out of the release into its stable directory, byte-verified against the release manifest. Returns the directory."""
    root = Path(root) if root is not None else _release_root()
    expected = bundled_files(root)
    final = stable_dir(version, expected)
    if final.is_dir() and not final.is_symlink() and _inventory(final) == expected:
        return final
    parent = final.parent
    parent.mkdir(parents=True, exist_ok=True)
    staging = parent / (".stage-" + uuid.uuid4().hex)
    try:
        for name, wanted in expected.items():
            relative = Path(*name.split("/"))
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("unsafe path in the release manifest: " + name)
            source = root / "plugins" / "osiris" / relative
            if source.is_symlink() or not source.is_file():
                raise ValueError("the release is missing or has a non-regular bundled file: " + name)
            data = source.read_bytes()
            if hashlib.sha256(data).hexdigest() != wanted:
                raise ValueError("the release's bundled Osiris does not match its manifest (" + name + "); reinstall bff")
            (staging / relative).parent.mkdir(parents=True, exist_ok=True)
            (staging / relative).write_bytes(data)
        if _inventory(staging) != expected:
            raise ValueError("the copied Osiris does not match the release manifest; nothing was installed")
        if final.exists():
            shutil.rmtree(str(final))  # a stale or damaged copy of this exact name, owned by bff
        os.replace(str(staging), str(final))
    finally:
        if staging.exists():
            shutil.rmtree(str(staging), ignore_errors=True)
    return final


def _install(bb, run, source):
    try:
        return run([bb, "plugin", "install", _bare(source), "--yes"], timeout=600).returncode == 0
    except (OSError, trusted_bin.TimeoutExpired):
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


def _plugin_step(compat, bb, run, out, stdin, state_file, yes, dry_run, switch, target=None, version=None, root=None):
    osiris = compat["osiris"]
    status = plugin_status(bb, run, osiris["id"])
    if (status["present"] and status["kind"] == "path" and not status["stale_bundled"] and not status["managed_bundle"]
            and not switch):
        _say(out, "Osiris dev channel: " + status["display"] + " (" + str(status["version"]) + "), left as is. "
             "Use --switch-to-release to replace it.")
        return 0
    if status["stale_bundled"]:
        _say(out, "your Osiris plugin comes from an old bff bundle (" + str(status["version"]) + ")")
    if not osiris["published"]:
        _say(out, UNPUBLISHED)
        return UNPUBLISHED_EXIT
    version = version or osiris["version"]
    bundled = osiris["source"] == BUNDLED_SOURCE and target is None
    if bundled:
        target = "path:" + str(stable_dir(version, bundled_files(root)))
    else:
        target = target or _target(compat)
    if status["present"] and _healthy(status, version) and status["source"] == target:
        _say(out, "Osiris " + version + " is up to date (" + status["display"] + ").")
        return 0
    plan = ("Plan: bb plugin install " + _bare(target) + " --yes (bundled with this bff, copied there and verified first; replaces "
            if bundled else "Plan: bb plugin install " + target + " --yes (replaces ") + (status["display"] if status["present"] else "nothing") + ")"
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
    if bundled:
        try:
            materialize_bundled(version, root)
        except (ValueError, OSError) as error:
            _say(out, "Could not prepare the bundled Osiris: " + str(error))
            return 1
    return _install_checked(bb, run, out, state_file, target, version, status)[0]


def _resolve_bb(bb, which=_which):
    bb = bb or which("bb")
    if bb is None:
        raise ValueError(NO_BB)
    return bb


def setup(yes=False, dry_run=False, switch_to_release=False, stdin=None, out=None, bb=None, run=_run,
          state_file=None, which=_which, system=None, compat=None, root=None):
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
    return _plugin_step(compat, bb or which("bb"), run, out, stdin, state_file, yes, dry_run, switch_to_release, root=root)


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
    except (OSError, shutil.Error, trusted_bin.TimeoutExpired):
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
           out=None, bb=None, run=_run, state_file=None, staging_root=None, which=_which, compat=None, root=None):
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
            return UNPUBLISHED_EXIT
        if compat["osiris"]["source"] == BUNDLED_SOURCE:
            if version != compat["osiris"]["version"]:
                _say(out, "This bff bundles Osiris " + compat["osiris"]["version"] + " only; install a different bff to get " + version + ".")
                return 1
            return _plugin_step(compat, bb, run, out, stdin, state_file, yes, False, switch_to_release, root=root)
        _say(out, "off pin: compat.json pins " + compat["osiris"]["version"])
        return _plugin_step(compat, bb, run, out, stdin, state_file, yes, False, switch_to_release,
                            with_ref(compat["osiris"]["source"], "v" + version), version)
    return _plugin_step(compat, bb, run, out, stdin, state_file, yes, False, switch_to_release, root=root)


def rollback_plugin(bb, run=_run, out=None, state_file=None, yes=False, stdin=None):
    path = state_file if state_file is not None else paths.active_state_path()
    recorded = state.load(path).get("plugin")
    previous = recorded.get("previous_source") if isinstance(recorded, dict) else None
    if not previous:
        raise ValueError("No previous Osiris plugin is recorded; nothing to roll back")
    if not yes:
        answer = _confirm("Re-install " + _bare(previous) + "?", stdin, out)
        if answer is None:  # no terminal to ask on: never apply without consent
            _say(out, "no changes made; re-run with --yes to apply")
            return 0
        if not answer:
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
