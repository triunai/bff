"""Explicit independent BB and Herdr launch requests; no configuration changes."""

import http.client
import json
import ntpath
import os
from pathlib import Path
import shlex
import sys
import tempfile

from . import osiris_tui, trusted_bin

OWNED_MARKER = "#!/bin/sh\n# BFF-owned Herdr launcher v1\n"
NO_HERDR_ON_WINDOWS = "herdr has no Windows build; use bff osiris factory directly (the text Factory runs in this terminal)."
DETACHED = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: a new terminal must outlive this command


def herdr_argv(executable, session=None):
    """The user's DEFAULT herdr session (plain `herdr`), or an explicitly named one; never a hardcoded private session."""
    if not executable:
        return None
    return [executable, "session", "attach", session] if session else [executable]


def display_command(argv):
    """A command line for people to copy: cmd-style double quotes on Windows, shell quoting elsewhere."""
    if osiris_tui.is_windows():
        return " ".join('"' + a + '"' if (" " in a or not a) else a for a in argv)
    return shlex.join(argv)


def windows_terminal():
    """Windows Terminal (wt.exe) when installed, else the system cmd.exe (used as `cmd /c start`). Both come from fixed directories."""
    return osiris_tui.which("wt") or osiris_tui.which("cmd")


def windows_terminal_argv(terminal, argv):
    """argv that opens `argv` in a new Windows terminal window: `wt.exe new-tab <command>`, else `cmd /c start "" <command>`."""
    if ntpath.basename(terminal).lower() == "wt.exe":
        return [terminal, "new-tab"] + list(argv)
    return [terminal, "/c", "start", ""] + list(argv)


def launch_plan(url, session=None):
    executable = osiris_tui.which("herdr")
    if osiris_tui.is_windows():
        terminal = windows_terminal()
    else:
        terminal = "/usr/bin/open" if sys.platform == "darwin" else trusted_bin.which("x-terminal-emulator")
    return {"bb": {"url": url, "action": "open-existing-running-observer"},
            "herdr": {"argv": herdr_argv(executable, session),
                      "session": session or "default",
                      "availability": "available" if executable else "missing",
                      "terminal": terminal,
                      "launcher": str(Path.home() / ".local/share/bff/launchers/osiris-herdr.command")
                      if sys.platform == "darwin" else None},
            "capture": {"automatic": False, "argv": ["bff", "herdr"],
                        "note": "Provider capture is an explicit separate command; pane membership remains unknown."}}


def write_launcher(path, argv):
    path = Path(path)
    for current in (path,) + tuple(path.parents):
        if current.is_symlink():
            raise ValueError("Herdr launcher symlink or parent refused")
    if path.exists():
        if not path.is_file() or not path.read_text(encoding="utf-8").startswith(OWNED_MARKER):
            raise ValueError("Refusing unrelated Herdr launcher")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, name = tempfile.mkstemp(prefix=".bff-launch-", dir=str(path.parent))
    temporary = Path(name)
    try:
        if hasattr(os, "fchmod"):  # absent on Windows, where mkstemp files are already private to the user profile
            os.fchmod(descriptor, 0o700)
        with os.fdopen(descriptor, "w") as stream:
            stream.write(OWNED_MARKER + "exec " + shlex.join(argv) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        if path.is_symlink():
            raise ValueError("Herdr launcher changed to symlink")
        os.replace(str(temporary), str(path))
    finally:
        if temporary.exists():
            temporary.unlink()
    return path


def start(args, url, open_observer):
    plan = launch_plan(url)
    if args.print_plan:
        print(json.dumps(plan, indent=2))
        return 0
    failed = False
    try:
        if open_observer(url, False) != 0:
            failed = True
    except (ValueError, OSError, http.client.HTTPException) as exc:
        print("BB observer unavailable: " + str(exc) + "; start BB separately.", file=sys.stderr)
        failed = True
    component = plan["herdr"]
    if component["argv"] is None:
        print(NO_HERDR_ON_WINDOWS if osiris_tui.is_windows() else "Herdr executable unavailable; install it separately.", file=sys.stderr)
        return 1
    try:
        if sys.platform == "darwin":
            launcher = write_launcher(component["launcher"], component["argv"])
            result = trusted_bin.run([component["terminal"], "-a", "Terminal", str(launcher)], timeout=10, inherit=trusted_bin.TOOL_INHERIT)
            if result.returncode:
                raise ValueError("Terminal launch request failed with exit " + str(result.returncode))
            print("Requested Herdr session " + component["session"] + " in a Terminal window; startup is unverified.")
        elif osiris_tui.is_windows() and component["terminal"]:
            trusted_bin.popen(windows_terminal_argv(component["terminal"], component["argv"]), creationflags=DETACHED, inherit=osiris_tui.tool_inherit())
            print("Requested Herdr session " + component["session"] + " in a terminal window; startup is unverified.")
        elif component["terminal"]:
            trusted_bin.popen([component["terminal"], "-e"] + component["argv"], start_new_session=True, inherit=trusted_bin.TOOL_INHERIT)
            print("Requested Herdr session " + component["session"] + " in a terminal window; startup is unverified.")
        else:
            print("Automatic terminal launch unsupported here. Run: " + display_command(component["argv"]))
            failed = True
    except (ValueError, OSError, trusted_bin.TimeoutExpired) as exc:
        print("Herdr launch unavailable: " + str(exc), file=sys.stderr)
        failed = True
    print("Provider capture is separate: bff herdr (recent capture is not a heartbeat).")
    return 1 if failed else 0
