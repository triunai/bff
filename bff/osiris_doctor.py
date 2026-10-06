"""`bff osiris doctor`: check everything Osiris needs, say WHY something does not work, and give ONE next action.

Read-only. The checks only look (which, --version, `bb plugin list`, `herdr status`, `bb terminal list`, one HTTP GET
of BB on localhost, and, unless --offline, the latest bff release and `git ls-remote` of the private Osiris repo).
The only thing it can change is the companion-tool plan of the old `bff doctor` (brew/npm installs), and that runs
only after an explicit [Y/n] (EOF is no) or --yes.

Exit codes: 0 nothing failed (warnings allowed); 1 at least one check failed.
"""
import http.client
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
from urllib.parse import urlsplit

from . import __version__, osiris, osiris_install, osiris_source, paths, update

OK, WARN, FAIL, INFO = "ok", "warn", "FAIL", "info"
BB_URL = "http://localhost:38886/"
HERDR_FEED = Path.home() / ".local" / "share" / "bff" / "herdr-feed.json"
FRESH_SECONDS = 30  # Osiris calls a capture stale after 30 s (herdr-feed.ts)


def herdr_allowlist(home=None):
    """The absolute herdr paths Osiris trusts (herdr-feed.ts herdrBinAllowlist); BB gives plugins a curated PATH."""
    home = Path.home() if home is None else Path(home)
    return ["/opt/homebrew/bin/herdr", "/usr/local/bin/herdr", str(home / ".local" / "bin" / "herdr")]


def _row(rows, name, status, detail, fix=None):
    rows.append({"check": name, "status": status, "detail": detail, "fix": fix})


def _quiet(run, argv, timeout=15):
    try:
        done = run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                   universal_newlines=True, timeout=timeout)
        return done.returncode, done.stdout or ""
    except (OSError, subprocess.SubprocessError):
        return None, ""


def is_wsl(release=None):
    try:
        text = release if release is not None else Path("/proc/sys/kernel/osrelease").read_text()
    except OSError:
        return False
    return "microsoft" in text.lower()


def check_platform(rows, system=None):
    system = system or platform.system()
    if system == "Windows":
        _row(rows, "platform", FAIL, "native Windows: BB runs on Windows only inside WSL2 (Ubuntu)",
             "install WSL2 (`wsl --install -d Ubuntu`), then install bff and BB inside Ubuntu")
    elif system == "Linux" and is_wsl():
        _row(rows, "platform", INFO, "WSL2: open Osiris in your Windows browser at " + BB_URL.rstrip("/"))
    else:
        _row(rows, "platform", OK, system)


def check_bff(rows, which, offline, env):
    method = paths.install_method()
    on_path = which("bff")
    mine = paths.command_path(prefix=paths.install_prefix()) if paths.install_prefix() else None
    detail = "bff " + __version__ + " (" + method + " install)"
    if mine is not None and (on_path is None or Path(on_path).resolve() != Path(str(mine)).resolve()):
        line = osiris_install_path_line(Path(str(mine)).parent)
        _row(rows, "bff", WARN, detail + "; `bff` on PATH is " + (on_path or "missing"), line)
    else:
        _row(rows, "bff", OK, detail)
    if offline or paths.install_prefix() is None:
        return
    latest = update.latest_version(update.release_base(env))
    if latest and osiris_install._newer(latest, __version__):
        _row(rows, "bff release", WARN, "bff " + latest + " is out (you have " + __version__ + ")", "bff osiris install")


def osiris_install_path_line(bin_dir):
    return "add " + str(bin_dir) + " to PATH: export PATH=\"" + str(bin_dir) + ":$PATH\" (in ~/.zprofile or ~/.bashrc)"


def check_bb(rows, which, run, compat, url):
    bb = which("bb")
    if bb is None:
        _row(rows, "BB", FAIL, "not found", "install BB: npx bb-app@latest (needs Node " + "22.19+), then bff osiris install")
        return None
    code, text = _quiet(run, [bb, "--version"])
    version = osiris._version(text)
    minimum = compat["bb_min"]
    if version is None or version < osiris._version(minimum):
        _row(rows, "BB", FAIL, "version " + (text.strip() or "unknown") + ", needs " + minimum, "update BB: npx bb-app@latest")
    else:
        _row(rows, "BB", OK, "bb " + text.strip())
    parsed = urlsplit(url)
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=2)
    try:
        connection.request("GET", "/")
        connection.getresponse()
        _row(rows, "BB running", OK, "answering at " + url)
    except (OSError, http.client.HTTPException):
        _row(rows, "BB running", FAIL, "nothing answers at " + url, "start BB (npx bb-app@latest, or the BB app), then bff osiris")
    finally:
        connection.close()
    return bb


def check_plugin(rows, bb, run, compat, staging_root=None, builds_root=None):
    try:
        status = osiris.plugin_status(bb, run, compat["osiris"]["id"])
    except ValueError as error:
        _row(rows, "Osiris plugin", FAIL, str(error), "bff osiris doctor again once BB runs")
        return None
    if not status["present"]:
        _row(rows, "Osiris plugin", FAIL, "not installed in BB", "bff osiris install")
        return status
    state = str(status["status"]) + ("" if status["enabled"] else ", disabled")
    if status["stale_bundled"]:
        _row(rows, "Osiris plugin", FAIL, "the stale plugin bundled inside an old bff (" + str(status["version"]) + ")",
             "bff osiris install")
    elif status["status"] != "running" or not status["enabled"]:
        _row(rows, "Osiris plugin", FAIL, str(status["version"]) + " is " + state, "enable it in BB (Settings > Plugins), or bff osiris install")
    else:
        _row(rows, "Osiris plugin", OK, str(status["version"]) + " running, from " + status["display"])
    plan = osiris_install.plan_plugin(compat, status, staging_root=staging_root, builds_root=builds_root)
    if plan["action"] == "install":
        _row(rows, "Osiris build", WARN, "a newer gated build is available: " + plan["label"], "bff osiris install")
    elif plan["action"] in ("current", "keep"):
        _row(rows, "Osiris build", OK, plan["line"])
    return status


def check_private_access(rows, compat, run, which, offline, status, staging_root=None):
    private = osiris_source.spec(compat)
    if private is None or compat["osiris"]["published"]:
        return
    if offline:
        _row(rows, "Osiris source", INFO, "github.com/" + private["repo"] + " access not checked (--offline)")
        return
    try:
        how = osiris_source.access(private["repo"], run=run, which=which)
        _row(rows, "Osiris source", OK, "can read github.com/" + private["repo"] + " (via " + how["via"] + ")")
    except osiris_source.SourceError as error:
        root = Path(staging_root or os.environ.get("OSIRIS_STAGING_DIR") or Path.home() / ".local" / "share" / "osiris-worktrees")
        level = INFO if root.is_dir() else WARN  # a developer box builds from its staged dirs instead
        _row(rows, "Osiris source", level, str(error).split(". Sign in")[0], "gh auth login, then bff osiris install")


def check_herdr(rows, which, run, home=None, feed=None, now=None, env=None, allowlist=None):
    env = os.environ if env is None else env
    herdr = which("herdr")
    allowlist = herdr_allowlist(home) if allowlist is None else allowlist
    personal = str((Path.home() if home is None else Path(home)) / ".local" / "bin" / "herdr")
    trusted = [p for p in allowlist if os.access(p, os.X_OK)]
    override = env.get("OSIRIS_HERDR_BIN")
    if herdr is None and not trusted:
        _row(rows, "Herdr", WARN, "not installed: no terminal panes in Osiris", "brew install herdr (or see https://herdr.dev)")
        return None
    if not trusted and not (override and os.path.isabs(override)):
        _row(rows, "Herdr", FAIL, "found at " + herdr + ", but Osiris only trusts " + ", ".join(allowlist),
             "ln -s " + herdr + " " + personal + "  (then restart BB)")
    else:
        _row(rows, "Herdr", OK, "Osiris will use " + (override if override else trusted[0]))
    binary = trusted[0] if trusted else herdr
    code, text = _quiet(run, [binary, "status", "server", "--json"])
    try:
        server = json.loads(text) if code == 0 else {}
    except ValueError:
        server = {}
    if server.get("running"):
        _row(rows, "Herdr server", OK, "running " + str(server.get("version", "")))
    else:
        _row(rows, "Herdr server", WARN, "not running", "open a terminal in BB and run: herdr")
    feed = Path(feed) if feed is not None else HERDR_FEED
    now = time.time() if now is None else now
    try:
        captured = json.loads(feed.read_text(encoding="utf-8")).get("capturedAt") / 1000.0
        age = now - captured
        if age <= FRESH_SECONDS:
            _row(rows, "Herdr capture", OK, "fresh (" + str(int(age)) + " s old)")
        else:
            _row(rows, "Herdr capture", WARN, "stale: last capture " + _ago(age) + " ago",
                 "run `bff herdr` in a terminal and leave it running")
    except (OSError, ValueError, TypeError, AttributeError):
        _row(rows, "Herdr capture", WARN, "no capture feed yet", "run `bff herdr` in a terminal and leave it running")
    return server


def _ago(seconds):
    for unit, size in (("d", 86400), ("h", 3600), ("min", 60)):
        if seconds >= size:
            return str(int(seconds // size)) + " " + unit
    return str(int(seconds)) + " s"


def check_terminals(rows, bb, run, server):
    """Why the Osiris centre terminal is empty: it attaches only BB terminals on this machine (host scope)."""
    code, text = _quiet(run, [bb, "machine", "list", "--json"])
    try:
        machines = [m for m in json.loads(text) if isinstance(m, dict)] if code == 0 else []
    except ValueError:
        machines = []
    connected = [m for m in machines if m.get("status") == "connected"]
    if not connected:
        _row(rows, "BB terminals", FAIL, "BB reports no connected machine, so there is nothing to attach",
             "start BB, then bff osiris doctor")
        return
    sessions = []
    for machine in connected[:4]:
        code, text = _quiet(run, [bb, "terminal", "list", "--machine", str(machine.get("id")), "--json"])
        try:
            sessions += json.loads(text).get("sessions", []) if code == 0 else []
        except (ValueError, AttributeError):
            pass
    live = [s for s in sessions if isinstance(s, dict) and s.get("status") == "running"]
    if live:
        _row(rows, "BB terminals", OK, str(len(live)) + " running BB terminal(s) Osiris can attach")
        return
    outside = " Herdr is running outside BB, which Osiris cannot attach." if server and server.get("running") else ""
    _row(rows, "BB terminals", WARN, "BB has no running terminal on this machine (" + str(len(sessions))
         + " listed), so the Osiris terminal stays empty." + outside,
         "open a terminal in BB, run `herdr` in it, then press Rediscover (↻) in Osiris")


def check_tools(rows, which):
    for name, why in (("bd", "the Work tab (beads)"), ("git", "the Changes view"), ("gh", "provenance checks and the private Osiris fetch")):
        if which(name):
            _row(rows, name, OK, "found")
        else:
            _row(rows, name, WARN if name != "gh" else INFO, "missing: needed for " + why,
                 {"bd": "brew install beads", "git": "install git", "gh": "brew install gh, then gh auth login"}[name])


def run_checks(*, offline=False, run=subprocess.run, which=shutil.which, env=None, compat=None, system=None,
               url=None, staging_root=None, builds_root=None, home=None, feed=None, now=None, herdr_paths=None):
    env = os.environ if env is None else env
    compat = compat or osiris.load_compat()
    rows = []
    check_platform(rows, system)
    check_bff(rows, which, offline, env)
    bb = check_bb(rows, which, run, compat, url or env.get("BB_SERVER_URL") or BB_URL)
    status = check_plugin(rows, bb, run, compat, staging_root, builds_root) if bb else None
    check_private_access(rows, compat, run, which, offline, status, staging_root)
    server = check_herdr(rows, which, run, home, feed, now, env, herdr_paths)
    if bb:
        check_terminals(rows, bb, run, server)
    check_tools(rows, which)
    return rows


def render(rows, out):
    width = max([len(r["check"]) for r in rows] or [5])
    for r in rows:
        out.write("  {:<5} {:<{w}}  {}\n".format(r["status"], r["check"], r["detail"], w=width))
        if r["fix"] and r["status"] in (FAIL, WARN):
            out.write("  {:<5} {:<{w}}  fix: {}\n".format("", "", r["fix"], w=width))
    first = next((r for r in rows if r["status"] == FAIL), None) or next((r for r in rows if r["status"] == WARN), None)
    out.write("\nNext: " + (first["fix"] if first and first["fix"] else "nothing; Osiris is ready (bff osiris)") + "\n")


def run_doctor(*, json_out=False, offline=False, yes=False, upgrade=True, stdin=None, out=None, **kw):
    from . import doctor as tools  # the companion-tool plan (old `bff doctor`)
    out = sys.stdout if out is None else out
    stdin = sys.stdin if stdin is None else stdin
    rows = run_checks(offline=offline, **kw)
    failed = any(r["status"] == FAIL for r in rows)
    if json_out:
        companions = [{"component": r["component"], "executables": {name: shutil.which(name) for name in r["executables"]}}
                      for r in tools.RECIPES]
        out.write(json.dumps({"checks": rows, "companions": companions, "ok": not failed}, indent=2) + "\n")
        return 1 if failed else 0
    out.write("bff osiris doctor\n")
    render(rows, out)
    out.write("\nCompanion tools\n")
    # offline=True: bff's own release was checked above. registry: --offline also skips the npm/brew "latest" queries.
    code = tools.run_doctor(assume_yes=yes, upgrade=upgrade, stdin=stdin, stdout=out, offline=True, registry=not offline)
    return 1 if failed or code else 0
