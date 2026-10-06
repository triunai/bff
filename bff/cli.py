"""Small, explicit BFF entry points; no hooks or global configuration mutation."""

import argparse
import datetime
import http.client
import json
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.parse import urlsplit
import webbrowser

from . import __version__, osiris, state
from .paths import active_state_path
from .project import blocks, init_repo, inspect_spine, load_profile, repo_root, run_checks
from .prompt import confirm

OSIRIS_URL = "http://localhost:38886/plugins/tool-observer/overview"


def doctor():
    components = []
    for name, commands in (("BB", ("bb",)), ("Herdr", ("herdr",)), ("OMC", ("omc",)),
                           ("OMX", ("omx",)), ("Beads", ("bd", "br")), ("aeh", ("aeh",))):
        found = {command: shutil.which(command) for command in commands}
        components.append({"component": name, "executables": found,
                           "availability": "available" if any(found.values()) else "missing",
                           "integration": "unverified"})
    return {"components": components, "hooks": "not-installed-by-bff", "ci": "not-installed-by-bff",
            "note": "Executable availability does not establish a working integration."}


def launch_osiris(url, print_only):
    if print_only:
        print(url)
        return 0
    parsed = urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("Osiris launch requires an explicit local HTTP URL")
    check_osiris_plugin()
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=2)
    try:
        try:
            connection.request("GET", parsed.path + ("?" + parsed.query if parsed.query else ""))
        except OSError:
            raise ValueError("BB is not running at " + url + ". Start BB, then run bff osiris again "
                             "(if BB uses another address, pass --url).")
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError("BB observer URL unavailable (HTTP " + str(response.status) + ")")
    finally:
        connection.close()
    if not webbrowser.open(url):  # headless, SSH or WSL without a browser bridge: Osiris is up, so say where
        print("Osiris is running. Open this in your browser: " + url)
        return 0
    print(url)
    return 0


GATES = {"dev": "this is a source checkout; update it with git pull", "uv": "uv tool upgrade bff",
         "brew": "brew upgrade bff"}
REINSTALL = "curl -fsSLO https://github.com/triunai/bff/releases/latest/download/install.sh && sh install.sh"


def _rollback_plugin(args, paths, state):
    """True when the plugin rollback succeeded (or had nothing to do)."""
    bb = shutil.which("bb")
    if bb is None:
        print("BB not found" if args.plugin else "Osiris plugin: skipped (BB not found)")
        return not args.plugin
    state_file = paths.active_state_path()
    recorded = state.load(state_file).get("plugin")
    if not (isinstance(recorded, dict) and recorded.get("previous_source")):
        print("Osiris plugin: no previous source recorded")
        return True
    return osiris.rollback_plugin(bb, yes=args.yes, state_file=state_file,
                                  stdin=None if args.yes else sys.stdin) == 0


def _rollback_self(args, paths, update):
    prefix = paths.install_prefix()
    if prefix is None:
        print("bff rollback only applies to installs made by install.sh (this one is: " + paths.install_method() + ")")
        return False
    update.rollback(prefix=prefix, state_file=paths.state_path(prefix=prefix), yes=args.yes)
    return True


def run_rollback(args, paths, state, update):
    want_self, want_plugin = not args.plugin, not args.self_only
    ok = True
    if want_plugin:
        ok = _rollback_plugin(args, paths, state)
    if want_self:
        if paths.install_prefix() is None and want_plugin:
            print("bff itself: skipped (not a script install)")
        else:
            ok = _rollback_self(args, paths, update) and ok
    return 0 if ok else 1


def self_update(args):
    from . import paths, state, update
    if args.command == "rollback":
        return run_rollback(args, paths, state, update)
    prefix = paths.install_prefix()
    if prefix is None:
        print(GATES.get(paths.install_method(), "re-run the installer: " + REINSTALL))
        return 1
    state_file = paths.state_path(prefix=prefix)
    base = update.release_base()
    if base != update.DEFAULT_BASE:
        print("release source: " + base)
    latest = update.latest_version(base)
    if args.check:
        if latest is None:
            print("latest release unknown (offline?)")
            return 0
        available = tuple(map(int, latest.split("."))) > tuple(map(int, __version__.split(".")))
        print("bff " + __version__ + (" -> " + latest if available else " is up to date"))
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        def record(data):
            check = data.get("update_check") if isinstance(data.get("update_check"), dict) else {}
            check.update({"checked_at": stamp, "current": __version__, "latest": latest, "available": available})
            data["update_check"] = check
        state.update(state_file, record)
        return 0
    target = args.target or latest
    if target is None:
        print("latest release unknown (offline?)")
        return 1
    # An older "latest" is never offered as an update; a downgrade needs an explicit --version.
    if target == __version__ or (args.target is None and tuple(map(int, target.split("."))) < tuple(
            map(int, __version__.split(".")))):
        print("bff " + __version__ + " is up to date")
        return 0
    print(__version__ + " -> " + target)
    if not args.yes:
        if not sys.stdin.isatty():
            print("no changes made; re-run with --yes to apply")
            return 0
        if not confirm("Update bff " + __version__ + " -> " + target + "? [Y/n] ", sys.stdin, sys.stdout):
            print("cancelled")
            return 0
    result = update.apply_with_plugin(target, prefix=prefix, base=base, require_attestation=args.require_attestation)
    if result["changes"]:
        print(result["changes"])
    print("updated bff " + __version__ + " -> " + result["version"])
    print("undo: bff rollback")
    return 1 if result.get("plugin") == "failed" else 0


def run_config(args):
    state_file = active_state_path()
    if args.action == "set":
        state.update(state_file, lambda data: state.set_config(data, args.key, args.value))
        value = state.get_config(state.load(state_file), args.key)
        print(args.key + " = " + str(value).lower())
        if args.key == "update.auto" and value is True:
            print("warning: bff will now install verified updates without asking. Undo with: "
                  "bff config set update.auto false", file=sys.stderr)
        return 0
    data = state.load(state_file)
    if args.action == "get":
        print(str(state.get_config(data, args.key)).lower())
        return 0
    for key in sorted(state.CONFIG_KEYS):
        value = state.get_config(data, key)
        print(key + " = " + str(value).lower() + ("" if value != state.CONFIG_KEYS[key][1] else " (default)"))
    return 0


def check_osiris_plugin():
    executable = shutil.which("bb")
    if executable is None:
        raise ValueError(osiris.NO_BB)
    status = osiris.plugin_status(executable)
    if not status["present"]:
        raise ValueError("Osiris plugin not installed: run bff osiris install")
    if status["status"] != "running" or not status["enabled"]:
        raise ValueError("Osiris plugin is " + str(status["status"] if status["status"] != "running" else "disabled")
                         + ": enable it in BB, or run bff osiris install")
    if status["kind"] == "path" and not status["stale_bundled"]:
        print("Osiris dev channel: " + status["display"])
        return
    compat = osiris.load_compat()["osiris"]
    if compat["published"] and status["version"] != compat["version"]:
        print("bff: Osiris " + str(status["version"]) + " is off the pinned " + compat["version"]
              + "; run bff osiris install", file=sys.stderr)


# Exit codes for the Osiris verbs (clig.dev): 0 ok, 1 failed, 2 usage error (argparse), 3 waiting on a prerequisite.
OSIRIS_FAMILY = ("osiris", "doctor", "update", "rollback")


def _install_flags(parser, hidden=False):
    def hide(text):
        return argparse.SUPPRESS if hidden else text
    parser.add_argument("-y", "--yes", action="store_true", help=hide("Do it without asking (needed when not in a terminal)"))
    parser.add_argument("--dry-run", action="store_true", help=hide("Print the plan; change nothing"))
    parser.add_argument("--from", dest="from_dir", metavar="DIR", help=hide("Install this gated build directory instead"))
    parser.add_argument("--ref", metavar="COMMIT", help=hide("Build this Osiris commit instead of the pinned one (advanced)"))
    parser.add_argument("--switch-to-release", action="store_true",
                        help=hide("Also replace a developer (path:) install that bff did not make"))
    parser.add_argument("--require-attestation", action="store_true",
                        help=hide("Refuse a bff update unless gh verifies its provenance"))


def _doctor_flags(parser):
    parser.add_argument("--json", action="store_true", help="Machine-readable report; installs nothing")
    parser.add_argument("--offline", action="store_true", help="Skip the network checks (latest release, private repo access)")
    parser.add_argument("-y", "--yes", action="store_true", help="Run the companion-tool install plan without asking")
    parser.add_argument("--no-upgrade", action="store_true", help="Companion tools: install missing ones only")


def _run_doctor(args):
    from .osiris_doctor import run_doctor
    return run_doctor(json_out=args.json, offline=args.offline, yes=args.yes, upgrade=not args.no_upgrade)


def _run_install(args):
    from .osiris_install import run_install
    if getattr(args, "legacy_version", None):  # `bff osiris update --version X`: plugin-only, off the pin
        return osiris.update(args.legacy_version, None, False, args.switch_to_release, args.yes)
    return run_install(yes=args.yes, dry_run=args.dry_run, from_dir=args.from_dir, ref=args.ref,
                       switch=args.switch_to_release, require_attestation=args.require_attestation)


def _open(args):
    if not args.print_url and not args.no_update_check:
        from .update_notice import daily_notice
        daily_notice(current=__version__, state_file=active_state_path(), stdin=sys.stdin, out=sys.stdout)
    return launch_osiris(args.url, args.print_url)


VISIBLE = "{osiris,rollback,config,herdr,start,init,check,hydrate}"
OSIRIS_EPILOG = """the three things you do:
  bff osiris install   install Osiris, and run it again any time to update (safe to re-run)
  bff osiris           open Osiris (the same as: bff osiris open)
  bff osiris doctor    check everything and print the one next step

undo an update: bff rollback.  Exit codes: 0 ok, 1 failed, 2 usage error, 3 waiting on a prerequisite."""


def main(argv=None):
    parser = argparse.ArgumentParser(prog="bff", description="BFF — Built Fucking Fast. Explicit, portable repo tooling.",
                                     epilog="Start here: bff osiris install, then bff osiris. Stuck? bff osiris doctor.")
    parser.add_argument("-V", "--version", action="version", version="bff " + __version__)
    commands = parser.add_subparsers(dest="command", required=True, metavar=VISIBLE)
    observer = commands.add_parser("osiris", help="Install, open and check Osiris (start here)",
                                   description="Osiris, the BB workbench for your agents.", epilog=OSIRIS_EPILOG,
                                   formatter_class=argparse.RawDescriptionHelpFormatter)
    observer.add_argument("-V", "--version", action="version", version="bff " + __version__)
    observer.add_argument("--url", default=OSIRIS_URL, help="Where BB serves Osiris (default: " + OSIRIS_URL + ")")
    observer.add_argument("--print-url", action="store_true", help="Print the URL only; no connection, no browser")
    observer.add_argument("--no-update-check", action="store_true", help="Skip the once-a-day update question for this run")
    observer.add_argument("--install", action="store_true", help=argparse.SUPPRESS)  # pre-0.2 spelling
    osiris_commands = observer.add_subparsers(dest="osiris_command", metavar="{install,open,doctor}")
    _install_flags(osiris_commands.add_parser(
        "install", help="Install or update bff and Osiris (safe to re-run)",
        description="Install Osiris, or update it: run it again any time. Plans first, asks once [Y/n], "
                    "verifies before it swaps anything, and keeps the previous version for bff rollback."))
    opener = osiris_commands.add_parser("open", help="Open Osiris in your browser (what bare `bff osiris` does)")
    opener.add_argument("--url", default=argparse.SUPPRESS, help="Where BB serves Osiris")
    opener.add_argument("--print-url", action="store_true", default=argparse.SUPPRESS, help="Print the URL only")
    opener.add_argument("--no-update-check", action="store_true", default=argparse.SUPPRESS,
                        help="Skip the once-a-day update question")
    _doctor_flags(osiris_commands.add_parser(
        "doctor", help="Check everything Osiris needs and print the one next step",
        description="Checks bff, BB, the Osiris plugin and build, Herdr, the BB terminal Osiris attaches to, beads, "
                    "PATH, private-source access and WSL. Changes nothing unless you answer [Y/n] (EOF is no)."))
    for alias in ("setup", "update"):  # hidden compatibility spellings of `install` (D-128)
        legacy = osiris_commands.add_parser(alias)
        _install_flags(legacy, hidden=True)
        legacy.add_argument("--version", dest="legacy_version", help=argparse.SUPPRESS)
        legacy.add_argument("--from-latest-staged", action="store_true", help=argparse.SUPPRESS)
    _doctor_flags(commands.add_parser("doctor"))  # hidden alias of `bff osiris doctor`
    back = commands.add_parser("rollback", help="Switch bff and the Osiris plugin back to the previous version")
    which = back.add_mutually_exclusive_group()
    which.add_argument("--self", dest="self_only", action="store_true", help="Roll back bff only")
    which.add_argument("--plugin", action="store_true", help="Roll back the Osiris plugin only")
    back.add_argument("-y", "--yes", action="store_true", help="Roll back without asking")
    upgrade = commands.add_parser("update")  # hidden alias: bff itself (then the plugin), same verified path
    upgrade.add_argument("--check", action="store_true", help=argparse.SUPPRESS)
    upgrade.add_argument("--version", dest="target", metavar="X.Y.Z", help=argparse.SUPPRESS)
    upgrade.add_argument("--require-attestation", action="store_true", help=argparse.SUPPRESS)
    upgrade.add_argument("-y", "--yes", action="store_true", help=argparse.SUPPRESS)
    config = commands.add_parser(
        "config", description="Settings: update.check (daily update notice, default on); update.auto (install verified "
        "updates without asking, default off, needs gh installed). Change one with: bff config set <name> true|false",
        help="Read or change bff settings (update.check, update.auto)")
    config_actions = config.add_subparsers(dest="action", required=True)
    config_actions.add_parser("list", help="Print every setting")
    config_get = config_actions.add_parser("get", help="Print one setting")
    config_get.add_argument("key")
    config_set = config_actions.add_parser("set", help="Change one setting")
    config_set.add_argument("key")
    config_set.add_argument("value")
    herdr = commands.add_parser("herdr", help="Save metadata (not content) of recent local Claude Code and Codex sessions for Osiris; it cannot tell which Herdr pane a session ran in")
    herdr.add_argument("--once", action="store_true", help="Write the session list once and exit (default: keep refreshing)")
    herdr.add_argument("--latest", type=int, default=8, help="How many of the newest sessions to include (default 8)")
    herdr.add_argument("--session", help="Capture only this session id, as shown by Claude Code or Codex")
    herdr.add_argument("--output", type=Path, default=Path.home() / ".local" / "share" / "bff" / "herdr-feed.json",
                       help="File to write the session list to (default: ~/.local/share/bff/herdr-feed.json)")
    herdr.add_argument("--interval", type=float, default=5, help="Capture interval in seconds, minimum 5")
    start = commands.add_parser("start", help="Open running BB Osiris and request an independent Herdr session")
    start.add_argument("--print-plan", action="store_true", help="Print argv and targets without launching or writing")
    for name, help_text in (("init", "Adopt a fresh Git repository; existing files are preserved"),
                            ("check", "Read and validate the bound spine"),
                            ("hydrate", "Print bound context without changing files")):
        command = commands.add_parser(name, help=help_text)
        command.add_argument("--repo", type=Path, help="Repository to use (default: the one you are in)")
        if name == "check":
            command.add_argument("--run", action="store_true", help="Explicitly execute the profile's named argv checks")
        elif name == "hydrate":
            command.add_argument("--ws", help="Select one canonical workstream block")
    args = parser.parse_args(argv)
    if args.command == "osiris" and args.install and (args.print_url or args.osiris_command):
        observer.error("--install is the old spelling of `bff osiris install`; use that alone")
    canary_printed = False
    try:
        if args.command == "start":
            from .launch import start
            return start(args, OSIRIS_URL, launch_osiris)
        if args.command == "herdr":
            try:
                from .herdr import capture
            except ImportError as exc:
                raise ValueError("Provider capture unavailable: " + str(exc))
            return capture(args)
        if args.command == "doctor":
            if args.json:  # v0.1.1's machine-readable shape, kept byte-compatible for scripts; runs nothing
                print(json.dumps(doctor(), indent=2))
                return 0
            return _run_doctor(args)
        if args.command in ("update", "rollback"):
            return self_update(args)
        if args.command == "config":
            return run_config(args)
        if args.command == "osiris":
            if args.osiris_command in ("install", "setup", "update"):
                return _run_install(args)
            if args.osiris_command == "doctor":
                return _run_doctor(args)
            if args.install:
                print("bff osiris --install is renamed: use bff osiris install", file=sys.stderr)
                from .osiris_install import run_install
                return run_install()
            return _open(args)
        repo = repo_root(args.repo)
        if args.command == "init":
            print(json.dumps(init_repo(repo, Path(__file__).resolve().parents[1] / "templates" / "repo"), indent=2))
            print("Next: edit hygiene.md, run bff check, then bd init", file=sys.stderr)
            return 0
        profile, paths = load_profile(repo)
        if args.command == "hydrate":
            selected = None
            if args.ws:
                board = paths["board"].read_text()
                selected = [(heading, body) for heading, body in blocks(board)
                            if heading == "### " + args.ws or heading.startswith("### " + args.ws + " — ")]
                if len(selected) != 1:
                    raise ValueError("Select exactly one existing canonical --ws")
            payload = [(str(paths[key].relative_to(repo)), paths[key].read_text())
                       for key in ("router", "seed", "hot_state")]
            if selected:
                payload.append(("selected " + args.ws, "".join(heading + body for heading, body in selected)))
            for name, content in payload:
                print("--- " + name + " ---\n" + content.rstrip() + "\n")
            return 0
        texts, workstreams, errors = inspect_spine(paths)
        print("Threads read: " + str(len(workstreams)))
        canary_printed = True
        for error in errors:
            print("ERROR: " + error)
        print("Limits: code-header and migration checking are not implemented; hooks/CI are not installed by BFF.")
        results = run_checks(profile, repo) if args.run and not errors else []
        print(json.dumps({"spine": "fail" if errors else "pass", "checks": results,
                          "execution": ("blocked-by-spine-errors" if args.run and errors else
                                        "ran" if results else "no-checks-configured" if args.run else "not-requested")}, indent=2))
        return 1 if errors or any(result["status"] != "pass" for result in results) else 0
    except (ValueError, OSError, KeyError, TypeError, UnicodeError, subprocess.TimeoutExpired, http.client.HTTPException) as exc:
        if args.command == "check" and not canary_printed:
            print("Threads read: unavailable (validation did not complete)")
        print("bff: " + str(exc), file=sys.stderr)
        return 1 if args.command in OSIRIS_FAMILY else 2
