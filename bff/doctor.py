"""`bff doctor`: detect companion tools, plan installs/upgrades, run them only on consent.

Safety contract: argv lists only (no shell invocation), package-manager binaries resolved with
shutil.which, no privilege escalation, no downloaded-script piping, a timeout per step, every command printed
before it runs, stable releases only, and nothing runs without a prompt or --yes.
"""

import json
import re
import shutil
import subprocess
import sys
import urllib.request

from . import __version__
from .prompt import answer_is_yes

SELF_RELEASE_API = "https://api.github.com/repos/triunai/bff/releases/latest"
SELF_TIMEOUT = 3
SELF_TAG = re.compile(r"v(\d+\.\d+\.\d+)")
VERSION_TIMEOUT = 10
QUERY_TIMEOUT = 30
STEP_TIMEOUT = 600
SEMVER = re.compile(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-+]*)?")

# One entry per component, in dependency/execution order. `routes` lists package-manager routes
# in preference order; each route carries the package name and which manager's registry answers
# "latest stable". A recipe with no routes is manual: BFF prints the instruction, runs nothing.
# Package names were checked against upstream READMEs / registries on 2026-10-05 (see
# evidence/doctor-fix-2026-10-05.md for the source URL per tool).
RECIPES = (
    {"component": "BB", "executables": ("bb",), "routes": (),
     "manual": "Install BB from https://github.com/get-bb/bb (desktop release, or `npx bb-app@latest`). "
               "The upstream README documents no global package-manager install."},
    {"component": "Herdr", "executables": ("herdr",), "routes": (("brew", "herdr"),),
     "source": "https://herdr.dev"},
    {"component": "Beads", "executables": ("bd", "br"), "routes": (("brew", "beads"), ("npm", "@beads/bd")),
     "source": "https://github.com/gastownhall/beads"},
    {"component": "OMC", "executables": ("omc",), "routes": (("npm", "oh-my-claude-sisyphus"),),
     "source": "https://github.com/Yeachan-Heo/oh-my-claudecode"},
    {"component": "OMX", "executables": ("omx",), "routes": (("npm", "oh-my-codex"),),
     "source": "https://github.com/Yeachan-Heo/oh-my-codex",
     "note": "OMX also needs a working authenticated `codex` on PATH; BFF does not install Codex."},
    {"component": "gh", "executables": ("gh",), "routes": (("brew", "gh"),),
     "source": "https://cli.github.com",
     "note": "gh lets bff verify a release's build attestation; then sign in once with: gh auth login"},
    {"component": "aeh", "executables": ("aeh",), "routes": (),
     "manual": "aeh is a local prototype with no public package source; install it from your own release."},
)

# manager -> (install argv builder, upgrade argv builder, latest-version query argv builder)
MANAGERS = {
    "npm": (lambda pkg: ["install", "-g", pkg + "@latest"],
            lambda pkg: ["install", "-g", pkg + "@latest"],
            lambda pkg: ["view", pkg, "version"]),
    "brew": (lambda pkg: ["install", pkg],
             lambda pkg: ["upgrade", pkg],
             lambda pkg: ["info", "--json=v2", pkg]),
}
# Substrings of the executable's real path that show which manager owns it.
OWNER_MARKERS = {"npm": ("node_modules",), "brew": ("/Cellar/", "/Caskroom/")}


def _run(argv, timeout):
    # stdin=DEVNULL: output is captured, so a child that asks a question would wait unseen.
    return subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)


def parse_version(text):
    match = SEMVER.search(text or "")
    return match.group(0) if match else None


def version_key(version):
    core = re.split(r"[-+]", version, 1)[0]
    return tuple(int(part) for part in core.split("."))


def is_stable(version):
    return bool(version) and "-" not in version


def detect(recipe):
    """Return (executable path or None, installed version or None). Best effort, never raises."""
    for name in recipe["executables"]:
        path = shutil.which(name)
        if not path:
            continue
        try:
            result = _run([path, "--version"], VERSION_TIMEOUT)
            return path, parse_version((result.stdout or "") + " " + (result.stderr or ""))
        except (OSError, subprocess.SubprocessError):
            return path, None
    return None, None


def owner_of(path):
    try:
        real = str(__import__("pathlib").Path(path).resolve())
    except OSError:
        return None
    for manager, markers in OWNER_MARKERS.items():
        if any(marker in real for marker in markers):
            return manager
    return None


def latest_stable(manager, package):
    binary = shutil.which(manager)
    if not binary:
        return None
    try:
        result = _run([binary] + MANAGERS[manager][2](package), QUERY_TIMEOUT)
        if result.returncode:
            return None
        if manager == "brew":
            version = json.loads(result.stdout)["formulae"][0]["versions"]["stable"]
        else:
            version = result.stdout.strip()
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, IndexError):
        return None
    version = parse_version(version)
    return version if is_stable(version) else None


def available_route(recipe):
    for manager, package in recipe["routes"]:
        binary = shutil.which(manager)
        if binary:
            return manager, package, binary
    return None


def fetch_latest_release(timeout=SELF_TIMEOUT, opener=urllib.request.urlopen):
    """Latest published BFF release as X.Y.Z, or None. One unauthenticated call; never raises."""
    request = urllib.request.Request(SELF_RELEASE_API, headers={
        "Accept": "application/vnd.github+json", "User-Agent": "bff-doctor/" + __version__})
    try:
        with opener(request, timeout=timeout) as response:
            tag = json.loads(response.read(1024 * 1024).decode("utf-8")).get("tag_name")
    except Exception:  # offline, rate-limited, timeout, bad JSON: all mean "unknown", never a failure
        return None
    match = SELF_TAG.fullmatch(tag) if isinstance(tag, str) else None
    return match.group(1) if match else None


def check_self(installed=None, fetch=None):
    """Compare BFF's own version with the latest release. status: current | outdated | ahead | unknown."""
    installed = installed or __version__
    latest = (fetch or fetch_latest_release)()
    info = {"installed": installed, "latest": latest, "status": "unknown", "command": None}
    if latest:
        if version_key(installed) < version_key(latest):
            info.update(status="outdated", command="bff update")
        elif version_key(installed) > version_key(latest):
            info["status"] = "ahead"
        else:
            info["status"] = "current"
    return info


def render_self(info, out):
    out.write("BFF %s installed; " % info["installed"])
    if info["status"] == "unknown":
        out.write("latest release unknown (GitHub not reachable or no answer)\n\n")
    elif info["status"] == "outdated":
        out.write("latest release is %s (outdated)\n  update: %s\n  (printed only; BFF never runs it for you)\n\n"
                  % (info["latest"], info["command"]))
    elif info["status"] == "ahead":
        out.write("newer than the latest release %s (development build)\n\n" % info["latest"])
    else:
        out.write("up to date with release %s\n\n" % info["latest"])


def survey(upgrade=True, registry=True):
    """Inspect every recipe; no changes are made. Queries the registry only when useful (never when registry=False)."""
    rows = []
    for recipe in RECIPES:
        path, installed = detect(recipe)
        route = available_route(recipe)
        row = {"component": recipe["component"], "path": path, "installed": installed, "latest": None,
               "action": "none", "reason": "", "argv": None, "recipe": recipe}
        if recipe["routes"] and route and registry:
            row["latest"] = latest_stable(route[0], route[1])
        if path is None:
            if not recipe["routes"]:
                row.update(action="manual", reason=recipe["manual"])
            elif route is None:
                row.update(action="skip", reason="no supported package manager found ("
                           + ", ".join(m for m, _ in recipe["routes"]) + ")")
            else:
                row.update(action="install", argv=[route[2]] + MANAGERS[route[0]][0](route[1]), manager=route[0])
        elif upgrade and row["latest"] and installed and version_key(installed) < version_key(row["latest"]):
            if not recipe["routes"]:
                row.update(action="manual", reason=recipe["manual"])
            else:
                owner = owner_of(path)
                match = next((r for r in recipe["routes"] if r[0] == owner and shutil.which(r[0])), None)
                if match:
                    row.update(action="upgrade", manager=match[0],
                               argv=[shutil.which(match[0])] + MANAGERS[match[0]][1](match[1]))
                else:
                    row.update(action="skip", reason="installed outside a known package manager; upgrade it where you installed it")
        rows.append(row)
    return rows


def render(rows, out):
    out.write("%-8s %-8s %-12s %-12s %s\n" % ("TOOL", "STATUS", "INSTALLED", "LATEST", "NOTE"))
    for row in rows:
        status = "found" if row["path"] else "missing"
        note = {"install": "will install", "upgrade": "will upgrade", "manual": "manual install",
                "skip": "skipped", "none": ""}[row["action"]]
        out.write("%-8s %-8s %-12s %-12s %s\n" % (row["component"], status, row["installed"] or "-",
                                                  row["latest"] or "-", note))
    planned = [r for r in rows if r["action"] in ("install", "upgrade")]
    out.write("\nPlanned actions:\n")
    for row in rows:
        if row["action"] in ("install", "upgrade"):
            out.write("  %s %s: %s\n" % (row["action"], row["component"], " ".join(row["argv"])))
        elif row["action"] in ("manual", "skip"):
            out.write("  %s %s: %s\n" % (row["action"], row["component"], row["reason"]))
        if row["recipe"].get("note") and row["action"] != "none":
            out.write("    note: %s\n" % row["recipe"]["note"])
    if not planned:
        out.write("  nothing to install or upgrade\n")
    return planned


def execute(rows, out):
    """Run planned items one at a time, re-detecting after each. Returns the summary dict."""
    summary = {"installed": [], "upgraded": [], "already current": [], "failed": [], "skipped": []}
    for row in rows:
        name = row["component"]
        if row["action"] == "none":
            summary["already current"].append(name)
        elif row["action"] in ("manual", "skip"):
            summary["skipped"].append(name)
        else:
            out.write("\n$ %s\n" % " ".join(row["argv"]))
            out.flush()
            try:
                result = subprocess.run(row["argv"], timeout=STEP_TIMEOUT)
                failure = "exit %s" % result.returncode if result.returncode else None
            except (OSError, subprocess.SubprocessError) as error:
                failure = type(error).__name__
            if not failure:
                path, version = detect(row["recipe"])
                if path is None or version is None:
                    failure = "installed but executable does not resolve with a version"
            if failure:
                out.write("FAILED %s: %s\n" % (name, failure))
                summary["failed"].append(name)
            else:
                out.write("ok %s %s\n" % (name, version))
                summary["installed" if row["action"] == "install" else "upgraded"].append(name)
    return summary


def run_doctor(assume_yes=False, upgrade=True, stdin=None, stdout=None, offline=False, fetch_latest=None, registry=True):
    stdin = stdin if stdin is not None else sys.stdin
    out = stdout if stdout is not None else sys.stdout
    if not offline:
        render_self(check_self(fetch=fetch_latest), out)
    rows = survey(upgrade=upgrade, registry=registry)
    planned = render(rows, out)
    if not planned:
        return 0
    if not assume_yes:
        if not stdin.isatty():
            out.write("\nNon-interactive and --yes not given: no changes made.\n")
            return 0
        out.write("\nInstall/update %d items? [Y/n] " % len(planned))
        out.flush()
        if not answer_is_yes(stdin.readline()):
            out.write("No changes made.\n")
            return 0
    summary = execute(rows, out)
    out.write("\nSummary: " + "; ".join("%s: %s" % (k, ", ".join(v) or "-") for k, v in summary.items()) + "\n")
    return 1 if summary["failed"] else 0
