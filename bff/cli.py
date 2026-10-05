"""Small, explicit BFF entry points; no hooks or global configuration mutation."""

import argparse
import http.client
import json
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.parse import urlsplit
import webbrowser

from . import __version__
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


def launch_osiris(url, print_only, install=False):
    if install and print_only:
        raise ValueError("Choose --install or the read-only --print-url")
    if print_only:
        print(url)
        return 0
    parsed = urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("Osiris launch requires an explicit local HTTP URL")
    if install:
        executable = shutil.which("bb")
        if executable is None:
            raise ValueError("BB executable unavailable; install BB separately")
        bundle = Path(__file__).resolve().parents[1] / "plugins" / "osiris"
        if not bundle.is_dir() or bundle.is_symlink() or not (bundle / "package.json").is_file():
            raise ValueError("No bundled Osiris plugin in this release")
        result = subprocess.run([executable, "plugin", "install", str(bundle), "--yes"], timeout=120)
        if result.returncode:
            raise ValueError("BB plugin install failed with exit " + str(result.returncode))
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
    observer = commands.add_parser("osiris", help="Open the existing BB observer after checking the local URL")
    observer.add_argument("--url", default=OSIRIS_URL)
    observer.add_argument("--print-url", action="store_true", help="Print only; no connection or browser launch")
    observer.add_argument("--install", action="store_true", help="Explicitly install the bundled prebuilt observer through BB, then open it")
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
        if args.command == "osiris":
            return launch_osiris(args.url, args.print_url, args.install)
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
