"""The ONE trusted-binary primitive for every child process in bff (ADR D-139, td-h1w.36). Standard library only, Python 3.9+.

Twin of Osiris `work/trusted-bin.ts`: same rules, one module. tests/test_trusted_bin_fitness.py fails when `subprocess`, `shutil.which`, `os.system`,
`os.popen`, `os.exec*`, `os.spawn*` or `pty` appear anywhere else in bff, scripts or install.py.

    RESOLVE  resolve(name) / which(name): an absolute program from a FIXED per-OS directory list. NEVER a PATH lookup, never an environment override.
             A regular executable owned by root or the current user, not writable by group/other; every directory above its REAL path owned by
             root/us and not world-writable; a symlink is followed with realpath and the TARGET re-checked. Refusals are typed (Vet.reason).
    SPAWN    run / popen / exec_replace re-vet the program at USE time, take an argv list (no shell), and build the child environment from a
             minimal explicit base (PATH of the fixed dirs, HOME, LANG, plus names the caller lists). Loader/injection variables
             (DYLD_*, LD_*, NODE_OPTIONS, NODE_PATH, PYTHON*, GIT_EXEC_PATH, GIT_CONFIG*, BASH_ENV, ENV, ...) are never inherited and raise if passed.

Only the winning candidate may be remembered; trust is never cached (this module caches nothing at all: every call re-validates).
Differences from the Osiris twin, on purpose: bff finds user-installed tools (npm globals, cargo, fnm/nvm/volta node installs), so the default
symlink rule is "the TARGET passes every check" instead of "a same-named Homebrew Cellar program", and a few user tool directories are in the list.
Windows is a preview: file mode and ownership are not evaluated there.
"""
import glob
import os
import re
import stat
import subprocess
import sys
from collections import namedtuple
from pathlib import Path

# Re-exported so the rest of bff never needs to import `subprocess` (the fitness test forbids it).
PIPE = subprocess.PIPE
STDOUT = subprocess.STDOUT
DEVNULL = subprocess.DEVNULL
TimeoutExpired = subprocess.TimeoutExpired
SubprocessError = subprocess.SubprocessError
CompletedProcess = subprocess.CompletedProcess
CalledProcessError = subprocess.CalledProcessError

LOADER_ENV = re.compile(r"^(?:DYLD_|LD_|PYTHON|PERL5|RUBY|GIT_EXEC_PATH$|GIT_CONFIG(?!_NOSYSTEM$)|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$"
                        r"|SHELLOPTS$|BASHOPTS$|IFS$|CDPATH$|PROMPT_COMMAND$|GCONV_PATH$|LOCPATH$|NLSPATH$)")
POSIX = hasattr(os, "getuid")
# Names a developer tool legitimately needs beyond the minimal base: terminal and identity, XDG dirs, proxies and CA bundles (a corporate network still works) and the
# ssh agent. Callers pass this (plus anything extra) as `inherit`; nothing here changes what a program LOADS.
TOOL_INHERIT = ("TERM", "USER", "LOGNAME", "TMPDIR", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
                "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS")

Vet = namedtuple("Vet", "ok path via reason detail")
Fs = namedtuple("Fs", "realpath stat exec_ok uid")
Policy = namedtuple("Policy", "dirs extra_dirs alias_targets root_only home fs",
                    defaults=(None, (), "trusted", False, None, None))
Policy.__doc__ = """dirs: search these INSTEAD of the default list (absolute). extra_dirs: searched after. alias_targets: "trusted" (the target must pass every check),
"none" (no symlink) or a compiled regex the real path must match. root_only: the file must be owned by root (implies no symlink). fs: test seam."""


class TrustRefused(OSError):
    """The program is not trusted, so nothing was executed. `reason` is a stable string (see REASONS); `detail` is for people."""

    def __init__(self, reason, detail):
        OSError.__init__(self, detail)
        self.reason = reason
        self.detail = detail


class TrustNotFound(TrustRefused, FileNotFoundError):
    """Not found: also a FileNotFoundError, so callers that already handle a missing executable keep working."""


REASONS = ("not-found", "not-absolute", "bad-name", "location", "not-regular-file", "not-executable", "writable", "foreign-owner",
           "not-root-owned", "untrusted-directory", "symlink-refused", "bad-argv")


def _real_fs():
    def exec_ok(path):
        return os.access(path, os.X_OK)
    return Fs(realpath=os.path.realpath, stat=os.stat, exec_ok=exec_ok, uid=os.getuid() if POSIX else None)


def system_dirs(home=None, platform=None):
    """The fixed per-OS list. Never derived from PATH or the environment."""
    home = str(home or Path.home())
    platform = platform or sys.platform
    if platform.startswith("win"):
        root = os.environ.get("SystemRoot") or "C:\\Windows"
        return [root + "\\System32", root, "C:\\Program Files\\Git\\cmd", "C:\\Program Files\\GitHub CLI", "C:\\Program Files\\nodejs"]
    common = [home + "/.local/bin"]
    if platform == "darwin":
        return ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin"] + common
    return ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin"] + common


def tool_dirs(home=None):
    """User-level install locations for the developer tools bff looks for (cargo, volta, fnm/nvm/mise node installs). Glob patterns are expanded at call time;
    every hit still has to pass the file and directory-chain checks, so a directory someone else can write is refused."""
    home = str(home or Path.home())
    fixed = [home + "/.cargo/bin", home + "/.volta/bin", home + "/.bun/bin", home + "/.npm-global/bin"]
    patterns = [home + "/.local/share/fnm/node-versions/*/installation/bin", home + "/.nvm/versions/node/*/bin", home + "/.local/share/mise/installs/node/*/bin"]
    found = []
    for pattern in patterns:
        found.extend(sorted(glob.glob(pattern), reverse=True))
    return fixed + found


def default_dirs(home=None, platform=None):
    return system_dirs(home, platform) + tool_dirs(home)


def _effective_dirs(policy):
    base = list(policy.dirs) if policy.dirs is not None else default_dirs(policy.home)
    return base + list(policy.extra_dirs or ())


def _trusted_dir(st, uid):
    return (st.st_uid == 0 or st.st_uid == uid) and not (st.st_mode & 0o002)


def _bad(reason, detail):
    return Vet(False, None, None, reason, detail)


def vet_path(candidate, policy=None):
    """Validate ONE absolute candidate and return Vet(ok, real_path, candidate, reason, detail)."""
    policy = policy or Policy()
    candidate = str(candidate)
    if not candidate or "\0" in candidate or not os.path.isabs(candidate):
        return _bad("not-absolute", "the program path must be absolute (a bare name would be found through PATH)")
    fs = policy.fs or _real_fs()
    directory = os.path.dirname(candidate)
    target = "none" if policy.root_only else policy.alias_targets
    resolved_alias = hasattr(target, "match") and bool(target.match(candidate))
    if directory not in _effective_dirs(policy) and not resolved_alias:
        return _bad("location", directory + " is not one of the fixed program directories")
    try:
        real = fs.realpath(candidate)
        st = fs.stat(real)
    except OSError:
        return _bad("not-found", candidate + " does not exist")
    aliased = real != candidate
    if aliased and directory not in _effective_dirs(policy):
        return _bad("location", candidate + " is a symlink outside the fixed program directories")
    if aliased:
        if target == "none":
            return _bad("symlink-refused", candidate + " is a symlink and this program must be a plain file")
        if hasattr(target, "match") and not target.match(real):
            return _bad("symlink-refused", candidate + " leads to " + real + ", which is not an allowed target")
    if not stat.S_ISREG(st.st_mode):
        return _bad("not-regular-file", real + " is not a regular file")
    if not fs.exec_ok(real):
        return _bad("not-executable", real + " is not executable")
    if POSIX or policy.fs is not None:
        uid = fs.uid
        if policy.root_only and st.st_uid != 0:
            return _bad("not-root-owned", real + " is not owned by root")
        if st.st_uid != 0 and st.st_uid != uid:
            return _bad("foreign-owner", real + " belongs to another user")
        if st.st_mode & 0o022:
            return _bad("writable", real + " is writable by group or other")
        try:
            walk = os.path.dirname(real)
            while True:
                if not _trusted_dir(fs.stat(walk), uid):
                    return _bad("untrusted-directory", walk + " (above " + real + ") is foreign-owned or world-writable")
                parent = os.path.dirname(walk)
                if parent == walk:
                    break
                walk = parent
        except OSError:
            return _bad("not-found", "a directory above " + real + " cannot be inspected")
    return Vet(True, real, candidate, None, None)


def resolve(name, policy=None):
    """Find `name` in the fixed directories (first trusted wins), re-validating every time. `name` may be a plain file name or an absolute path whose
    directory is in the list. Returns the Vet of the winner, or the most informative refusal."""
    policy = policy or Policy()
    if os.path.isabs(name):
        candidates = [name]
    elif not name or "/" in name or "\\" in name or "\0" in name or name in (".", "..") or name.startswith("-"):
        return _bad("bad-name", "a program name must be a plain file name")
    else:
        suffixes = ("", ".exe", ".cmd", ".bat") if not POSIX else ("",)
        candidates = [os.path.join(d, name + s) for d in _effective_dirs(policy) for s in suffixes]
    worst = None
    for candidate in candidates:
        verdict = vet_path(candidate, policy)
        if verdict.ok:
            return verdict
        if worst is None or (worst.reason == "not-found" and verdict.reason != "not-found"):
            worst = verdict
    return worst or _bad("not-found", name + " was not found in " + ", ".join(_effective_dirs(policy)))


def which(name, policy=None):
    """The validated CANDIDATE path (the alias a user would type, e.g. ~/.local/bin/bb), or None. Replaces shutil.which: no PATH, no cache."""
    verdict = resolve(name, policy)
    return verdict.via if verdict.ok else None


def which_real(name, policy=None):
    verdict = resolve(name, policy)
    return verdict.path if verdict.ok else None


def self_python():
    """The interpreter running right now, vetted for file and directory-chain trust only (its location is whatever started us)."""
    path = sys.executable
    verdict = vet_path(path, Policy(dirs=(os.path.dirname(path),)))
    if not verdict.ok:
        raise TrustRefused(verdict.reason, "the running Python is not a trusted program: " + verdict.detail)
    return path


def own_policy(program):
    """Policy for a program inside a directory the caller manages (an install prefix's bin/): location is the caller's, every other check applies."""
    return Policy(dirs=(os.path.dirname(str(program)),))


def child_env(extra=None, inherit=(), path_extra=(), home=None, source=None):
    """A minimal explicit environment: PATH (fixed dirs + path_extra), HOME, LANG, then the names in `inherit`, then `extra` (None removes). Loader variables raise."""
    source = os.environ if source is None else source
    home = home or source.get("HOME") or str(Path.home())
    lang = source.get("LANG", "")
    path = os.pathsep.join(list(path_extra) + system_dirs(home))
    out = {"PATH": path, "HOME": home, "LANG": lang if re.match(r"^[A-Za-z0-9_.@-]{1,32}$", lang) else "en_US.UTF-8"}
    for name in inherit:
        if LOADER_ENV.match(name):
            raise ValueError("refusing to inherit " + name + " into a child process")
        if name in source:
            out[name] = source[name]
    for key, value in (extra or {}).items():
        if LOADER_ENV.match(key):
            raise ValueError("refusing to pass " + key + " to a child process")
        if value is None:
            out.pop(key, None)
        elif "\0" in value:
            raise ValueError("NUL in the value of " + key)
        else:
            out[key] = value
    return out


def _vet_argv(argv, policy):
    if not isinstance(argv, (list, tuple)) or not argv:
        raise TrustRefused("bad-argv", "argv must be a non-empty list")
    items = [os.fspath(a) if isinstance(a, os.PathLike) else a for a in argv]
    if not all(isinstance(a, str) and "\0" not in a for a in items):
        raise TrustRefused("bad-argv", "argv must be strings without NUL")
    verdict = vet_path(items[0], policy)
    if not verdict.ok:
        error = TrustNotFound if verdict.reason == "not-found" else TrustRefused
        raise error(verdict.reason, os.path.basename(items[0]) + " is not a trusted program (" + verdict.reason + "): " + verdict.detail)
    return items, verdict


def _spawn_kwargs(verdict, env, inherit):
    return {"executable": verdict.path, "shell": False,
            "env": child_env(extra=env, inherit=inherit, path_extra=[os.path.dirname(verdict.via)])}


def run(argv, policy=None, env=None, inherit=(), **kwargs):
    """subprocess.run, vetted: argv[0] must be an absolute trusted program (use which()/resolve() first), argv is a list, no shell, minimal env. Raises TrustRefused
    (an OSError; TrustNotFound is also a FileNotFoundError) before anything executes. Other keywords (stdin, stdout, stderr, timeout, cwd, text, ...) pass through."""
    for forbidden in ("shell", "executable", "preexec_fn"):
        if forbidden in kwargs:
            raise TypeError("trusted_bin.run does not accept " + forbidden)
    items, verdict = _vet_argv(argv, policy)
    return subprocess.run(items, **dict(kwargs, **_spawn_kwargs(verdict, env, inherit)))


def popen(argv, policy=None, env=None, inherit=(), **kwargs):
    """subprocess.Popen, vetted like run()."""
    for forbidden in ("shell", "executable", "preexec_fn"):
        if forbidden in kwargs:
            raise TypeError("trusted_bin.popen does not accept " + forbidden)
    items, verdict = _vet_argv(argv, policy)
    return subprocess.Popen(items, **dict(kwargs, **_spawn_kwargs(verdict, env, inherit)))


def exec_replace(target, argv, env, policy=None):
    """Replace this process with `target` (a re-exec of OUR OWN install: pass own_policy(target)). The caller's env continues, minus loader variables."""
    policy = policy or own_policy(target)
    verdict = vet_path(str(target), policy)
    if not verdict.ok:
        raise TrustRefused(verdict.reason, "cannot restart into " + str(target) + " (" + verdict.reason + "): " + verdict.detail)
    clean = {k: v for k, v in env.items() if not LOADER_ENV.match(k)}
    os.execve(verdict.path, [str(a) for a in argv], clean)
