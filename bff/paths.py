"""Where bff keeps things on each OS.

POSIX: data `<prefix>/share/bff`, command dir `<prefix>/bin`, prefix defaults to `~/.local`.
Windows: data `%LOCALAPPDATA%\\bff` (`<home>\\AppData\\Local\\bff` when unset), command dir `<data>\\bin`.

Testing and relocation hook: when `BFF_PREFIX` is set and no `prefix` is passed, it is the prefix
(POSIX) or the data directory (Windows). Every function takes keyword-only overrides `env`, `system`,
`home` and `prefix`, so tests never touch the real home. Pure path logic: no subprocess, no network.
"""
import os
import platform
import re
from pathlib import Path, PureWindowsPath

# Single definition of the release directory name; install.py keeps its own startup-safe copy.
RELEASE_NAME = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{12}")


def _context(env, system, home):
    env = os.environ if env is None else env
    system = platform.system() if system is None else system
    home = Path.home() if home is None else Path(home)
    return env, system, home


def _prefix(env, prefix):
    if prefix is not None:
        return Path(prefix)
    return Path(env["BFF_PREFIX"]) if env.get("BFF_PREFIX") else None


def _win(path):
    return PureWindowsPath(str(path))


def data_dir(*, env=None, system=None, home=None, prefix=None):
    env, system, home = _context(env, system, home)
    chosen = _prefix(env, prefix)
    if system == "Windows":
        if chosen is not None:
            return _win(chosen)
        base = env.get("LOCALAPPDATA")
        return _win(base if base else _win(home) / "AppData" / "Local") / "bff"
    return (chosen if chosen is not None else home / ".local") / "share" / "bff"


def bin_dir(*, env=None, system=None, home=None, prefix=None):
    env, system, home = _context(env, system, home)
    if system == "Windows":
        return data_dir(env=env, system=system, home=home, prefix=prefix) / "bin"
    chosen = _prefix(env, prefix)
    return (chosen if chosen is not None else home / ".local") / "bin"


def releases_dir(**kw):
    return data_dir(**kw) / "releases"


def state_path(**kw):
    return data_dir(**kw) / "state.json"


def cache_dir(*, env=None, system=None, home=None, prefix=None):
    env, system, home = _context(env, system, home)
    if system == "Windows":
        return data_dir(env=env, system=system, home=home, prefix=prefix) / "cache"
    xdg = env.get("XDG_CACHE_HOME")
    if xdg and os.path.isabs(xdg):
        return Path(xdg) / "bff"
    return home / ".cache" / "bff"


def command_path(*, env=None, system=None, home=None, prefix=None):
    env, system, home = _context(env, system, home)
    name = "bff.cmd" if system == "Windows" else "bff"
    return bin_dir(env=env, system=system, home=home, prefix=prefix) / name


def _parts(path):
    return [part for part in str(path).replace("\\", "/").split("/") if part]


def _contains(parts, sequence):
    n = len(sequence)
    return any(parts[i:i + n] == sequence for i in range(len(parts) - n + 1))


def install_method(module_file=None, *, env=None, system=None, home=None, prefix=None):
    """One of script, uv, brew, dev, unknown, from where the running bff package lives."""
    if module_file is None:
        from bff import __file__ as module_file
    package = Path(module_file).resolve().parent
    releases = releases_dir(env=env, system=system, home=home, prefix=prefix)
    try:
        relative = package.relative_to(Path(str(releases)).resolve())
    except ValueError:
        relative = None
    if (relative is not None and len(relative.parts) == 2 and relative.parts[1] == "bff"
            and RELEASE_NAME.fullmatch(relative.parts[0])):
        return "script"
    parts = _parts(package)
    if _contains(parts, ["uv", "tools"]):
        return "uv"
    if "Cellar" in parts:
        return "brew"
    root = package.parent
    if (root / ".git").exists() and (root / "install.py").exists():
        return "dev"
    return "unknown"


SHIM_OWNED = re.compile(r"REM bff-owned release=(" + RELEASE_NAME.pattern + ")")


def shim_release(text):
    """The release id a Windows `bff.cmd` shim points at (its `REM bff-owned release=<id>` line), else None."""
    for line in text.splitlines()[:3]:
        found = SHIM_OWNED.fullmatch(line.strip())
        if found:
            return found.group(1)
    return None


def install_prefix(module_file=None, *, system=None):
    """The prefix P when the running package is `P/share/bff/releases/<RELEASE_NAME>/bff/` (Windows:
    `P/releases/<RELEASE_NAME>/bff/`, P being the data directory), else None."""
    system = platform.system() if system is None else system
    if module_file is None:
        from bff import __file__ as module_file
    package = Path(module_file).resolve().parent
    release = package.parent
    releases = release.parent
    data = releases.parent
    if (system == "Windows" and package.name == "bff" and RELEASE_NAME.fullmatch(release.name)
            and releases.name == "releases"):
        return data
    if (package.name == "bff" and RELEASE_NAME.fullmatch(release.name) and releases.name == "releases"
            and data.name == "bff" and data.parent.name == "share"):
        return data.parent.parent
    return None


def active_state_path(module_file=None, **kw):
    """The running install's own state file (under its prefix), else the default location."""
    return state_path(prefix=install_prefix(module_file), **kw)
