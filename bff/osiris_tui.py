"""`bff osiris factory|worktrees|prune`: run the Osiris terminal apps from the installed plugin.

The apps live in the Osiris plugin (`bin/osiris-tui.mjs`); BFF only locates the plugin directory and runs node on that script with a fixed
argv. Nothing is installed or written, and no shell is involved.
"""

import os
from pathlib import Path

from . import trusted_bin

SCRIPT = Path("bin") / "osiris-tui.mjs"
MODES = ("factory", "worktrees", "prune")


def _usable(directory):
    script = Path(directory) / SCRIPT
    return script.is_file() and not script.is_symlink()


def installed_plugin_dir():
    """The installed tool-observer plugin directory, the way `osiris-update` reads it from `bb plugin list`."""
    executable = trusted_bin.which("bb")
    if executable is None:
        return None
    try:
        result = trusted_bin.run([executable, "plugin", "list"], capture_output=True, text=True, timeout=15, stdin=trusted_bin.DEVNULL, inherit=trusted_bin.TOOL_INHERIT)
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
    node = trusted_bin.which("node")
    if node is None:
        raise ValueError("node executable unavailable; the Osiris terminal apps need Node 22.6 or newer")
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
    return trusted_bin.run(argv, inherit=trusted_bin.TOOL_INHERIT).returncode
