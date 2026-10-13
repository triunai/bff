"""`bff osiris factory|worktrees|prune`: run the Osiris terminal apps from the installed plugin.

The apps live in the Osiris plugin (`bin/osiris-tui.mjs`); BFF only locates the plugin directory and runs node on that script with a fixed
argv. Nothing is installed or written, and no shell is involved.
"""

import glob
import os
from pathlib import Path
import sys

from . import trusted_bin

SCRIPT = Path("bin") / "osiris-tui.mjs"
MODES = ("factory", "worktrees", "prune")


# Environment names a Windows program needs to start at all (node, git and cmd refuse or misbehave without SystemRoot and the profile variables).
# Never loader variables: trusted_bin.child_env still raises on those.
WINDOWS_INHERIT = ("SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "ProgramData",
                   "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "TEMP", "TMP", "USERNAME", "USERDOMAIN", "COMPUTERNAME", "ALLUSERSPROFILE", "PUBLIC",
                   "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS")
NODE_BUILD_ON_WINDOWS = "node.cmd/node.bat wrappers are refused on Windows (a batch file re-parses its arguments); install node.exe, for example: winget install OpenJS.NodeJS.LTS"


def is_windows(platform=None):
    return (platform or sys.platform).startswith("win")


def tool_inherit(platform=None):
    """The environment names a developer tool may inherit: the shared set everywhere, plus the Windows startup set on Windows."""
    return trusted_bin.TOOL_INHERIT + (WINDOWS_INHERIT if is_windows(platform) else ())


def windows_tool_dirs(home=None, expand=glob.glob):
    """FIXED Windows install locations for node, git, gh, bb, herdr and the terminal launcher, in preference order. Derived only from the user's home and constant
    Program Files paths (never PATH, never an environment override); version-manager directories are expanded by glob at call time, newest name first.
    Every hit still goes through trusted_bin's vetting, so this widens WHERE to look, never what is accepted."""
    home = str(home or Path.home()).rstrip("\\/")
    local, roaming = home + "\\AppData\\Local", home + "\\AppData\\Roaming"
    fixed = ["C:\\Program Files\\nodejs", "C:\\Program Files (x86)\\nodejs", "C:\\Program Files\\Git\\cmd", "C:\\Program Files\\GitHub CLI",
             local + "\\Programs\\Git\\cmd", local + "\\Programs\\GitHub CLI", local + "\\Volta\\bin", local + "\\Microsoft\\WinGet\\Links",
             local + "\\Microsoft\\WindowsApps", roaming + "\\npm", home + "\\scoop\\shims", home + "\\scoop\\apps\\nodejs\\current",
             home + "\\scoop\\apps\\nodejs-lts\\current", local + "\\Programs\\Herdr\\bin"]
    patterns = [local + "\\fnm\\node-versions\\*\\installation", roaming + "\\fnm\\node-versions\\*\\installation", roaming + "\\nvm\\v*", local + "\\nvm\\v*"]
    found = []
    for pattern in patterns:
        found.extend(sorted(expand(pattern), reverse=True))
    return fixed + found


def tool_policy(platform=None, home=None):
    """None on POSIX (the default list applies); on Windows a Policy that adds the Windows tool directories."""
    if not is_windows(platform):
        return None
    return trusted_bin.Policy(extra_dirs=tuple(windows_tool_dirs(home)))


def which(name, platform=None, home=None):
    """trusted_bin.which with the per-OS tool directories. On POSIX this is exactly trusted_bin.which(name)."""
    policy = tool_policy(platform, home)
    return trusted_bin.which(name) if policy is None else trusted_bin.which(name, policy)


def exit_code(returncode, platform=None):
    """The process exit code to report. Windows reports Ctrl+C as the unsigned NTSTATUS 0xC000013A: map it to the conventional 130."""
    if is_windows(platform) and returncode is not None and (returncode & 0xFFFFFFFF) == 0xC000013A:
        return 130
    return returncode


def _usable(directory):
    script = Path(directory) / SCRIPT
    return script.is_file() and not script.is_symlink()


def installed_plugin_dir():
    """The installed tool-observer plugin directory, the way `osiris-update` reads it from `bb plugin list`."""
    executable = which("bb")
    if executable is None:
        return None
    try:
        result = trusted_bin.run([executable, "plugin", "list"], capture_output=True, text=True, timeout=15, stdin=trusted_bin.DEVNULL, inherit=tool_inherit())
    except (OSError, trusted_bin.SubprocessError):
        return None
    inside = False
    for line in (result.stdout or "").splitlines():
        if line.startswith("tool-observer@"):
            inside = True
        elif inside and "source: path:" in line:
            return Path(line.split("source: path:", 1)[1].strip())
        elif inside and line and not line[0].isspace():
            inside = False
    return None


def locate_plugin():
    """OSIRIS_PLUGIN_DIR, else the installed plugin. Only a directory that ships the TUI script counts."""
    env = os.environ.get("OSIRIS_PLUGIN_DIR")
    for find in ((lambda: Path(env)) if env else (lambda: None), installed_plugin_dir):
        candidate = find()
        if candidate is not None and _usable(candidate):
            return candidate
    raise ValueError("No Osiris plugin with the terminal apps found; install a newer Osiris build (osiris-update) or set OSIRIS_PLUGIN_DIR")


def build_argv(mode, plugin, args):
    """Fixed argv: node, the plugin's script, the mode, then only the known flags."""
    if mode not in MODES:
        raise ValueError("Unknown Osiris terminal app: " + str(mode))
    node = which("node")
    if node is None:
        hint = " (install it with: winget install OpenJS.NodeJS.LTS)" if is_windows() else ""
        raise ValueError("node executable unavailable; the Osiris terminal apps need Node 22.6 or newer" + hint)
    if is_windows() and node.lower().endswith((".cmd", ".bat")):
        raise ValueError(NODE_BUILD_ON_WINDOWS)
    argv = [node, str(Path(plugin) / SCRIPT), mode, "--repo", str(Path(args.repo or Path.cwd()).resolve())]
    if mode == "prune":
        # The plugin only PLANS: removal lives in bff (osiris_prune), never in the plugin bundle, so --apply is never passed on.
        if args.min_idle_days is not None:
            argv.extend(["--min-idle-days", str(args.min_idle_days)])
        if args.json:
            argv.append("--json")
        return argv
    for flag, enabled in (("--all", getattr(args, "all", False)), ("--no-color", args.no_color), ("--once", args.once)):
        if enabled:
            argv.append(flag)
    for flag, value in (("--cols", args.cols), ("--interval", args.interval)):
        if value is not None:
            argv.extend([flag, str(value)])
    return argv


def run_tui(mode, args):
    plugin = locate_plugin()
    if mode == "prune" and args.apply:
        from .osiris_prune import apply_prune
        return apply_prune(plugin, args)
    argv = build_argv(mode, plugin, args)
    return exit_code(trusted_bin.run(argv, inherit=tool_inherit()).returncode)
