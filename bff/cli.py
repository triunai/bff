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
        connection.request("GET", parsed.path + ("?" + parsed.query if parsed.query else ""))
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError("BB observer URL unavailable (HTTP " + str(response.status) + ")")
    finally:
        connection.close()
    if not webbrowser.open(url):
        raise ValueError("Browser could not open the reachable observer URL; use --print-url")
    print(url)
    return 0


GATES = {"dev": "this is a source checkout; update it with git pull", "uv": "uv tool upgrade bff",
         "brew": "brew upgrade bff"}
REINSTALL = "curl -fsSLO https://github.com/triunai/bff/releases/latest/download/install.sh && sh install.sh"


def self_update(args):
    from . import paths, state, update
    prefix = paths.install_prefix()
    if prefix is None:
        method = paths.install_method()
        if args.command == "rollback":
            print("bff rollback only applies to installs made by install.sh (this one is: " + method + ")")
        else:
            print(GATES.get(method, "re-run the installer: " + REINSTALL))
        return 1
    state_file = paths.state_path(prefix=prefix)
    if args.command == "rollback":
        update.rollback(prefix=prefix, state_file=state_file, yes=args.yes)
        return 0
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
    if target == __version__:
        print("bff " + __version__ + " is up to date")
        return 0
    print(__version__ + " -> " + target)
    if not args.yes:
        if not sys.stdin.isatty():
            print("no changes made; re-run with --yes to apply")
            return 0
        try:
            answer = input("Update bff " + __version__ + " -> " + target + "? [Y/n] ")
        except EOFError:
            answer = "n"
        if answer.strip().lower() not in ("", "y", "yes"):
            print("cancelled")
            return 0
    result = update.apply_update(target, prefix=prefix, base=base, require_attestation=args.require_attestation)
    if result["changes"]:
        print(result["changes"])
    print("updated bff " + __version__ + " -> " + result["version"])
    print("undo: bff rollback")
    return 0


def run_config(args):
    state_file = active_state_path()
    if args.action == "set":
        state.update(state_file, lambda data: state.set_config(data, args.key, args.value))
        print(args.key + " = " + str(state.get_config(state.load(state_file), args.key)).lower())
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
        raise ValueError("Osiris plugin not installed: run bff osiris setup")
    if status["status"] != "running" or not status["enabled"]:
        raise ValueError("Osiris plugin is " + str(status["status"] if status["status"] != "running" else "disabled")
                         + ": enable it in BB, or run bff osiris setup")
    if status["kind"] == "path" and not status["stale_bundled"]:
        print("Osiris dev channel: " + status["display"])
        return
    compat = osiris.load_compat()["osiris"]
    if compat["published"] and status["version"] != compat["version"]:
        print("bff: Osiris " + str(status["version"]) + " is off the pinned " + compat["version"]
              + "; run bff osiris update", file=sys.stderr)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="bff", description="BFF — Built Fucking Fast. Explicit, portable repo tooling.")
    parser.add_argument("--version", action="version", version="bff " + __version__)
    commands = parser.add_subparsers(dest="command", required=True)
    doc = commands.add_parser("doctor", help="Report companion tools; offer to install missing and upgrade outdated ones")
    doc.add_argument("--json", action="store_true", help="Machine-readable availability report; runs nothing")
    doc.add_argument("--yes", action="store_true", help="Run the install/upgrade plan without prompting")
    doc.add_argument("--no-upgrade", action="store_true", help="Install missing tools only; do not upgrade")
    doc.add_argument("--offline", action="store_true", help="Skip the one GitHub call that checks BFF's own latest release")
    start = commands.add_parser("start", help="Open running BB Osiris and request an independent Herdr session")
    start.add_argument("--print-plan", action="store_true", help="Print argv and targets without launching or writing")
    herdr = commands.add_parser("herdr", help="Capture bounded local Claude/Codex transcript metadata; Herdr pane membership is unknown")
    herdr.add_argument("--once", action="store_true", help="Publish one feed and exit")
    herdr.add_argument("--latest", type=int, default=8)
    herdr.add_argument("--session", help="Exact native provider session identity")
    herdr.add_argument("--output", type=Path, default=Path.home() / ".local" / "share" / "bff" / "herdr-feed.json")
    herdr.add_argument("--interval", type=float, default=5, help="Capture interval in seconds, minimum 5")
    for name, help_text in (("init", "Adopt a fresh Git repository; existing files are preserved"),
                            ("check", "Read and validate the bound spine"),
                            ("hydrate", "Print bound context without changing files")):
        command = commands.add_parser(name, help=help_text)
        command.add_argument("--repo", type=Path)
        if name == "check":
            command.add_argument("--run", action="store_true", help="Explicitly execute the profile's named argv checks")
        elif name == "hydrate":
            command.add_argument("--ws", help="Select one canonical workstream block")
    observer = commands.add_parser("osiris", help="Open the BB observer, or set up and update the Osiris plugin")
    observer.add_argument("--url", default=OSIRIS_URL)
    observer.add_argument("--print-url", action="store_true", help="Print only; no connection or browser launch")
    observer.add_argument("--install", action="store_true", help="Deprecated: renamed to bff osiris setup")
    osiris_commands = observer.add_subparsers(dest="osiris_command")
    setup = osiris_commands.add_parser("setup", help="Check prerequisites and install the pinned Osiris plugin through BB")
    setup.add_argument("--yes", action="store_true", help="Install without asking (never replaces a path: dev install)")
    setup.add_argument("--dry-run", action="store_true", help="Print the plan; change nothing")
    setup.add_argument("--switch-to-release", action="store_true", help="Replace a path: dev install with the pinned release")
    upgrade = osiris_commands.add_parser("update", help="Move the Osiris plugin to the pinned release or a local build")
    upgrade.add_argument("--version", help="Install this release instead of the pinned one")
    source = upgrade.add_mutually_exclusive_group()
    source.add_argument("--from", dest="from_dir", help="Gate a build directory on a copy, then install it")
    source.add_argument("--from-latest-staged", action="store_true", help="Same, for the newest usable staged install-* build")
    upgrade.add_argument("--switch-to-release", action="store_true", help="Replace a path: dev install with the pinned release")
    upgrade.add_argument("--yes", action="store_true", help="Install without asking")
    upgrade = commands.add_parser("update", help="Update bff itself to the latest verified release")
    upgrade.add_argument("--check", action="store_true", help="Only report the latest release; change nothing")
    upgrade.add_argument("--version", dest="target", metavar="X.Y.Z", help="Install this release instead of the latest")
    upgrade.add_argument("--require-attestation", action="store_true", help="Refuse to update unless gh verifies provenance")
    upgrade.add_argument("--yes", action="store_true", help="Update without prompting")
    back = commands.add_parser("rollback", help="Switch bff back to the previous release")
    back.add_argument("--yes", action="store_true", help="Roll back without prompting")
    observer.add_argument("--no-update-check", action="store_true", help="Skip the once-a-day update notice for this run")
    config = commands.add_parser("config", help="Read or change bff settings (update.check, update.auto)")
    config_actions = config.add_subparsers(dest="action", required=True)
    config_actions.add_parser("list", help="Print every setting")
    config_get = config_actions.add_parser("get", help="Print one setting")
    config_get.add_argument("key")
    config_set = config_actions.add_parser("set", help="Change one setting")
    config_set.add_argument("key")
    config_set.add_argument("value")
    args = parser.parse_args(argv)
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
            if args.json:
                print(json.dumps(doctor(), indent=2))
                return 0
            from .doctor import run_doctor
            return run_doctor(assume_yes=args.yes, upgrade=not args.no_upgrade, offline=args.offline)
        if args.command in ("update", "rollback"):
            return self_update(args)
        if args.command == "config":
            return run_config(args)
        if args.command == "osiris":
            if args.osiris_command == "setup":
                return osiris.setup(args.yes, args.dry_run, args.switch_to_release)
            if args.osiris_command == "update":
                return osiris.update(args.version, args.from_dir, args.from_latest_staged, args.switch_to_release, args.yes)
            if args.install:
                if args.print_url:
                    raise ValueError("Choose --install or the read-only --print-url")
                print("bff osiris --install is renamed: use bff osiris setup", file=sys.stderr)
                return osiris.setup()
            if not args.print_url and not args.no_update_check:
                from .update_notice import daily_notice
                daily_notice(current=__version__, state_file=active_state_path(), stdin=sys.stdin, out=sys.stdout)
            return launch_osiris(args.url, args.print_url)
        repo = repo_root(args.repo)
        if args.command == "init":
            print(json.dumps(init_repo(repo, Path(__file__).resolve().parents[1] / "templates" / "repo"), indent=2))
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
        return 2
