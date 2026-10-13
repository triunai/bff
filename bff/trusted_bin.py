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

WINDOWS (td-h1w.11, rules written down; every one is exercised by tests/test_trusted_bin_windows.py with a simulated platform):
  W1 The directory list is FIXED from SystemRoot / ProgramFiles / ProgramFiles(x86) / ProgramW6432 / LOCALAPPDATA / APPDATA / USERPROFILE. PATH and PATHEXT are never read.
  W2 Directories compare as ntpath.normcase(normpath()) (case, slash direction and trailing separators do not matter). Absolute means drive-letter rooted; UNC is refused.
  W3 A program is name + one of .exe .com .cmd .bat in a FIXED extension order (not the environment's PATHEXT). Names with ':' (alternate data streams), wildcards or
     trailing dots/spaces are refused.
  W4 File mode and owner are not evaluated (NTFS ACLs are not visible to stat). Instead the real path and its directory must not sit under a user-writable temp root
     (TEMP, TMP, LOCALAPPDATA\\Temp, SystemRoot\\Temp).
  W5 .cmd/.bat never runs directly: only through the vetted SystemRoot\\System32\\cmd.exe /d /s /c, and only when no argument (or the program path) contains
     & | < > ^ % ! " or a newline. Every argument is then quoted.
  W6 The child environment is minimal: PATH (fixed dirs, ';'), SystemRoot, ComSpec (FIXED to System32\\cmd.exe), USERPROFILE, LOCALAPPDATA, APPDATA, TEMP, TMP, a CONSTANT PATHEXT.
  W7 exec_replace runs the child, waits, and exits with its return code (Windows has no exec-replace).
"""
import glob
import ntpath
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
Policy = namedtuple("Policy", "dirs extra_dirs alias_targets root_only home fs platform",
                    defaults=(None, (), "trusted", False, None, None, None))
Policy.__doc__ = """dirs: search these INSTEAD of the default list (absolute). extra_dirs: searched after. alias_targets: "trusted" (the target must pass every check),
"none" (no symlink) or a compiled regex the real path must match. root_only: the file must be owned by root (implies no symlink). fs: test seam.
platform: test seam, a sys.platform value (default: the running one)."""


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


WIN_EXTS = (".exe", ".com", ".cmd", ".bat")
WIN_BATCH = (".cmd", ".bat")
WIN_PATHEXT = ".COM;.EXE;.BAT;.CMD"
WIN_METACHARS = frozenset('&|<>^%!"\r\n')
WIN_BAD_NAME = frozenset('<>"|?*:\0')


def _is_win(platform=None):
    return (platform or sys.platform).startswith("win")


def _is_abs(path, win):
    if not win:
        return os.path.isabs(path)
    drive, rest = ntpath.splitdrive(path)
    return bool(drive) and not drive.startswith(("\\\\", "//")) and rest[:1] in ("\\", "/")


def _norm(path):
    return ntpath.normcase(ntpath.normpath(path))


def _in_dirs(directory, dirs, win):
    if not win:
        return directory in dirs
    return _norm(directory) in {_norm(d) for d in dirs}


def _win_env_dir(env, name):
    """An absolute drive-rooted directory from the environment, or None. Read each call; never from PATH."""
    value = env.get(name)
    return value if value and _is_abs(value, True) else None


def _win_root(env):
    return _win_env_dir(env, "SystemRoot") or "C:\\Windows"


def _win_temp_roots(env):
    roots = [_win_env_dir(env, "TEMP"), _win_env_dir(env, "TMP"), _win_root(env) + "\\Temp"]
    local = _win_env_dir(env, "LOCALAPPDATA")
    if local:
        roots.append(local + "\\Temp")
    return sorted({_norm(r) for r in roots if r})


def _win_system_dirs(env):
    root = _win_root(env)
    out = [root + "\\System32", root]
    for var in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"):
        base = _win_env_dir(env, var)
        if base:
            out += [base + "\\Git\\cmd", base + "\\Git\\bin", base + "\\GitHub CLI", base + "\\nodejs"]
    if not any(_win_env_dir(env, v) for v in ("ProgramFiles", "ProgramW6432")):
        out += ["C:\\Program Files\\Git\\cmd", "C:\\Program Files\\Git\\bin", "C:\\Program Files\\GitHub CLI", "C:\\Program Files\\nodejs"]
    seen, unique = set(), []
    for d in out:
        if _norm(d) not in seen:
            seen.add(_norm(d))
            unique.append(d)
    return unique


def _win_tool_dirs(home, env, globber):
    local = _win_env_dir(env, "LOCALAPPDATA") or home + "\\AppData\\Local"
    roaming = _win_env_dir(env, "APPDATA") or home + "\\AppData\\Roaming"
    files = [d for d in (_win_env_dir(env, "ProgramFiles"), _win_env_dir(env, "ProgramW6432")) if d] or ["C:\\Program Files"]
    fixed = [local + "\\Microsoft\\WinGet\\Links", home + "\\scoop\\shims", roaming + "\\npm", local + "\\Volta\\bin", home + "\\.volta\\bin",
             home + "\\.cargo\\bin", home + "\\.bun\\bin"]
    patterns = [local + "\\Programs\\Python\\Python3*", local + "\\Programs\\Python\\Python3*\\Scripts"]
    for base in files:
        patterns += [base + "\\Python3*", base + "\\Python3*\\Scripts"]
    patterns += [local + "\\fnm\\node-versions\\*\\installation", roaming + "\\fnm\\node-versions\\*\\installation", roaming + "\\nvm\\v*", local + "\\nvm\\v*"]
    found = []
    for pattern in patterns:
        found.extend(sorted(globber(pattern), reverse=True))
    return fixed + found


def system_dirs(home=None, platform=None, env=None):
    """The fixed per-OS list. Never derived from PATH or the environment's PATH."""
    home = str(home or Path.home())
    platform = platform or sys.platform
    if platform.startswith("win"):
        return _win_system_dirs(os.environ if env is None else env)
    common = [home + "/.local/bin"]
    if platform == "darwin":
        return ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin"] + common
    return ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin"] + common


def tool_dirs(home=None, platform=None, env=None, globber=glob.glob):
    """User-level install locations for the developer tools bff looks for (cargo, volta, fnm/nvm/mise node installs). Glob patterns are expanded at call time;
    every hit still has to pass the file and directory-chain checks, so a directory someone else can write is refused."""
    home = str(home or Path.home())
    if _is_win(platform):
        return _win_tool_dirs(home, os.environ if env is None else env, globber)
    fixed = [home + "/.cargo/bin", home + "/.volta/bin", home + "/.bun/bin", home + "/.npm-global/bin"]
    patterns = [home + "/.local/share/fnm/node-versions/*/installation/bin", home + "/.nvm/versions/node/*/bin", home + "/.local/share/mise/installs/node/*/bin"]
    found = []
    for pattern in patterns:
        found.extend(sorted(glob.glob(pattern), reverse=True))
    return fixed + found


def default_dirs(home=None, platform=None):
    return system_dirs(home, platform) + tool_dirs(home, platform)


def _effective_dirs(policy):
    base = list(policy.dirs) if policy.dirs is not None else default_dirs(policy.home, policy.platform)
    return base + list(policy.extra_dirs or ())


def _trusted_dir(st, uid):
    return (st.st_uid == 0 or st.st_uid == uid) and not (st.st_mode & 0o002)


def _bad(reason, detail):
    return Vet(False, None, None, reason, detail)


def _vet_windows(candidate, policy):
    """Rules W1-W4. File mode and owner are not evaluated; the real path must not live under a user-writable temp root."""
    if not candidate or "\0" in candidate or not _is_abs(candidate, True):
        return _bad("not-absolute", "the program path must be absolute and drive-rooted (a bare name would be found through PATH)")
    base = ntpath.basename(candidate)
    if any(c in WIN_BAD_NAME or ord(c) < 32 for c in candidate[2:]) or not base or base != base.rstrip(". "):
        return _bad("bad-name", "the program path contains characters Windows treats specially")
    fs = policy.fs or _real_fs()
    directory = ntpath.dirname(candidate)
    target = "none" if policy.root_only else policy.alias_targets
    resolved_alias = hasattr(target, "match") and bool(target.match(candidate))
    dirs = _effective_dirs(policy)
    if not _in_dirs(directory, dirs, True) and not resolved_alias:
        return _bad("location", directory + " is not one of the fixed program directories")
    try:
        real = fs.realpath(candidate)
        if real.startswith("\\\\?\\") and not real.startswith("\\\\?\\UNC"):
            real = real[4:]
        st = fs.stat(real)
    except OSError:
        return _bad("not-found", candidate + " does not exist")
    aliased = _norm(real) != _norm(candidate)
    if aliased and not _in_dirs(directory, dirs, True):
        return _bad("location", candidate + " is a symlink outside the fixed program directories")
    if aliased:
        if target == "none":
            return _bad("symlink-refused", candidate + " is a symlink and this program must be a plain file")
        if hasattr(target, "match") and not target.match(real):
            return _bad("symlink-refused", candidate + " leads to " + real + ", which is not an allowed target")
    if not _is_abs(real, True) or ntpath.splitext(real)[1].lower() not in WIN_EXTS:
        return _bad("not-executable", real + " is not a drive-rooted program with an executable extension")
    if not stat.S_ISREG(st.st_mode):
        return _bad("not-regular-file", real + " is not a regular file")
    if not fs.exec_ok(real):
        return _bad("not-executable", real + " is not executable")
    for probe in (_norm(real), _norm(directory)):
        for temp in _win_temp_roots(os.environ):
            if probe == temp or probe.startswith(temp + "\\"):
                return _bad("untrusted-directory", real + " is under the user-writable temp directory " + temp)
    return Vet(True, real, candidate, None, None)


def vet_path(candidate, policy=None):
    """Validate ONE absolute candidate and return Vet(ok, real_path, candidate, reason, detail)."""
    policy = policy or Policy()
    candidate = str(candidate)
    if _is_win(policy.platform):
        return _vet_windows(candidate, policy)
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
    win = _is_win(policy.platform)
    if _is_abs(name, win):
        candidates = [name]
    elif not name or "/" in name or "\\" in name or "\0" in name or name in (".", "..") or name.startswith("-") or (
            win and (any(c in WIN_BAD_NAME for c in name) or name != name.rstrip(". "))):
        return _bad("bad-name", "a program name must be a plain file name")
    elif win:
        suffixes = ("",) if ntpath.splitext(name)[1].lower() in WIN_EXTS else WIN_EXTS
        candidates = [ntpath.join(d, name + s) for d in _effective_dirs(policy) for s in suffixes]
    else:
        candidates = [os.path.join(d, name) for d in _effective_dirs(policy)]
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


def _win_child_env(source, path_extra, home, platform):
    root = _win_root(source)
    out = {"PATH": ";".join(list(path_extra) + system_dirs(home, platform, source)), "SystemRoot": root, "ComSpec": root + "\\System32\\cmd.exe", "PATHEXT": WIN_PATHEXT,
           "USERPROFILE": source.get("USERPROFILE") or home, "HOME": home}
    for name in ("LOCALAPPDATA", "APPDATA", "TEMP", "TMP"):
        if source.get(name):
            out[name] = source[name]
    return out


def child_env(extra=None, inherit=(), path_extra=(), home=None, source=None, platform=None):
    """A minimal explicit environment: PATH (fixed dirs + path_extra), HOME, LANG, then the names in `inherit`, then `extra` (None removes). Loader variables raise."""
    source = os.environ if source is None else source
    if _is_win(platform):
        home = home or source.get("USERPROFILE") or str(Path.home())
        out = _win_child_env(source, path_extra, home, platform)
    else:
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
    platform = policy.platform if policy else None
    if _is_win(platform) and ntpath.splitext(verdict.path)[1].lower() in WIN_BATCH:
        return _batch_via_cmd(items, verdict, policy)
    return items, verdict


def _batch_via_cmd(items, verdict, policy):
    """Rule W5: a .cmd/.bat runs only through the vetted System32 cmd.exe, and only when nothing in the line can be reinterpreted by cmd."""
    policy = policy or Policy()  # the default-policy callers (doctor, update) pass None; real Windows crashed on policy.platform
    for item in [verdict.path] + items:
        if WIN_METACHARS & set(item):
            raise TrustRefused("bad-argv", "refusing a cmd.exe metacharacter (& | < > ^ % ! \" or a newline) in " + repr(item))
    cmd = vet_path(_win_root(os.environ) + "\\System32\\cmd.exe", Policy(dirs=(_win_root(os.environ) + "\\System32",), platform=policy.platform, fs=policy.fs))
    if not cmd.ok:
        raise TrustRefused(cmd.reason, "cmd.exe is not a trusted program (" + cmd.reason + "): " + cmd.detail)
    line = '"' + cmd.path + '" /d /s /c ""' + verdict.path + '"' + "".join(' "' + a + '"' for a in items[1:]) + '"'
    # cmd.exe is the executable; `via` stays the batch file's candidate so its directory joins the child's PATH.
    return line, Vet(True, cmd.path, verdict.via, None, None)


def _spawn_kwargs(verdict, env, inherit, policy=None):
    platform = policy.platform if policy else None
    return {"executable": verdict.path, "shell": False,
            "env": child_env(extra=env, inherit=inherit, path_extra=[_dirname(verdict.via, platform)], platform=platform)}


def _dirname(path, platform):
    return ntpath.dirname(path) if _is_win(platform) else os.path.dirname(path)


def run(argv, policy=None, env=None, inherit=(), **kwargs):
    """subprocess.run, vetted: argv[0] must be an absolute trusted program (use which()/resolve() first), argv is a list, no shell, minimal env. Raises TrustRefused
    (an OSError; TrustNotFound is also a FileNotFoundError) before anything executes. Other keywords (stdin, stdout, stderr, timeout, cwd, text, ...) pass through."""
    for forbidden in ("shell", "executable", "preexec_fn"):
        if forbidden in kwargs:
            raise TypeError("trusted_bin.run does not accept " + forbidden)
    items, verdict = _vet_argv(argv, policy)
    return subprocess.run(items, **dict(kwargs, **_spawn_kwargs(verdict, env, inherit, policy)))


def popen(argv, policy=None, env=None, inherit=(), **kwargs):
    """subprocess.Popen, vetted like run()."""
    for forbidden in ("shell", "executable", "preexec_fn"):
        if forbidden in kwargs:
            raise TypeError("trusted_bin.popen does not accept " + forbidden)
    items, verdict = _vet_argv(argv, policy)
    return subprocess.Popen(items, **dict(kwargs, **_spawn_kwargs(verdict, env, inherit, policy)))


def exec_replace(target, argv, env, policy=None):
    """Replace this process with `target` (a re-exec of OUR OWN install: pass own_policy(target)). The caller's env continues, minus loader variables."""
    policy = policy or own_policy(target)
    verdict = vet_path(str(target), policy)
    if not verdict.ok:
        raise TrustRefused(verdict.reason, "cannot restart into " + str(target) + " (" + verdict.reason + "): " + verdict.detail)
    clean = {k: v for k, v in env.items() if not LOADER_ENV.match(k)}
    if _is_win(policy.platform):
        # Rule W7: Windows has no exec-replace; run, wait, exit with the child's code.
        done = run([verdict.path] + [str(a) for a in argv][1:], policy=policy, env=clean)
        sys.exit(done.returncode)
    os.execve(verdict.path, [str(a) for a in argv], clean)
