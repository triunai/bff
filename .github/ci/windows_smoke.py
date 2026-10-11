#!/usr/bin/env python3
"""Windows CI smoke steps for .github/workflows/windows.yml (standard library only).

Each subcommand does one job, prints what it ran, and appends the full output of every child process to
$BFF_SMOKE_LOGS (default ./smoke-logs) so the workflow can upload it. Nothing here touches the real HOME or PATH:
every install goes to an explicit --prefix and the fake `gh` lives in its own directory that the workflow puts on PATH
for a single step only.
"""
import argparse
import tempfile
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile

REPO = Path(__file__).resolve().parents[2]
LOGS = Path(os.environ.get("BFF_SMOKE_LOGS", "smoke-logs")).resolve()
FAKE_GH = '''import json, os, shutil, sys
args = sys.argv[1:]
dist = os.environ["BFF_FAKE_GH_DIST"]
if args[:2] == ["auth", "status"]:
    sys.exit(0)
if args[:2] == ["release", "download"]:
    patterns, dest, i = [], None, 2
    while i < len(args):
        if args[i] in ("--pattern", "-p"):
            patterns.append(args[i + 1]); i += 2
        elif args[i] in ("--dir", "-D"):
            dest = args[i + 1]; i += 2
        elif args[i] in ("--repo", "-R"):
            i += 2
        else:
            i += 1
    import fnmatch
    hits = [n for n in sorted(os.listdir(dist)) if any(fnmatch.fnmatch(n, p) for p in patterns)]
    if not hits:
        sys.stderr.write("fake gh: no asset matches %r\\n" % patterns); sys.exit(1)
    for name in hits:
        shutil.copy(os.path.join(dist, name), os.path.join(dest, name))
    sys.exit(0)
sys.stderr.write("fake gh: unsupported arguments %r\\n" % args); sys.exit(2)
'''


def log_path(name):
    LOGS.mkdir(parents=True, exist_ok=True)
    return LOGS / (re.sub(r"[^A-Za-z0-9_.-]+", "_", name) + ".log")


def run(name, command, env=None, check=True, timeout=300):
    """Run a child process, echo and log its combined output, and return (returncode, output)."""
    shown = " ".join(str(c) for c in command)
    print("::group::" + name + "\n$ " + shown, flush=True)
    try:
        done = subprocess.run([str(c) for c in command], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              env=env, timeout=timeout)
        code, output = done.returncode, done.stdout.decode("utf-8", "replace")
    except (OSError, subprocess.TimeoutExpired) as exc:
        code, output = 127, "could not run: %r" % (exc,)
    print(output + "\n[exit %s]\n::endgroup::" % code, flush=True)
    with log_path(name).open("a", encoding="utf-8") as handle:
        handle.write("$ " + shown + "\n" + output + "\n[exit %s]\n" % code)
    if check and code != 0:
        raise SystemExit("FAILED (%s): %s" % (code, name))
    return code, output


def last_json(text):
    start = text.find("{")
    if start < 0:
        raise SystemExit("no JSON object in output:\n" + text)
    return json.loads(text[start:text.rfind("}") + 1])


def cmd_build(args):
    out = Path(args.out).resolve()
    shutil.rmtree(out, ignore_errors=True)
    run("build-release", [sys.executable, REPO / "scripts" / "build-bff-release.py", "--output", out])
    names = sorted(p.name for p in out.iterdir())
    print("dist:", names)
    archives = [n for n in names if re.fullmatch(r"bff-[0-9.]+\.tar\.gz", n)]
    if len(archives) != 1 or "SHA256SUMS" not in names:
        raise SystemExit("expected one archive plus SHA256SUMS, got %r" % names)
    for n in ("install.ps1", "install.sh", "compat.json"):
        if n not in names:
            raise SystemExit("release is missing loose asset " + n)


def cmd_fake_gh(args):
    """A stand-in for the GitHub CLI so install.ps1's real `gh release download` code path runs offline."""
    dest = Path(args.bindir).resolve()
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "fake_gh.py").write_text(FAKE_GH, encoding="utf-8")
    (dest / "gh.cmd").write_text('@echo off\r\n"%s" "%%~dp0fake_gh.py" %%*\r\n' % sys.executable, encoding="ascii")
    print("fake gh at", dest / "gh.cmd")


def extract(dist, into):
    archive = next(Path(dist).glob("bff-*.tar.gz"))
    shutil.rmtree(into, ignore_errors=True)
    into.mkdir(parents=True)
    with tarfile.open(archive, "r:gz") as tf:
        tf.extractall(str(into))
    return into / archive.name[:-len(".tar.gz")]


def bff_command(prefix):
    return Path(prefix) / "bin" / "bff.cmd"


def cmd_install_py(args):
    """install.py straight from the unpacked archive, as install.ps1 runs it (no PATH edit)."""
    prefix = Path(args.prefix).resolve()
    shutil.rmtree(prefix, ignore_errors=True)
    tree = extract(args.dist, Path(args.work).resolve())
    code, out = run("install-py", [sys.executable, tree / "install.py", "--prefix", prefix, "--no-modify-path", "--yes"])
    result = last_json(out)
    if Path(result["command"]).resolve() != bff_command(prefix).resolve() or not bff_command(prefix).is_file():
        raise SystemExit("install.py reported %r but %s is missing" % (result.get("command"), bff_command(prefix)))
    (Path(args.work).resolve() / "tree.txt").write_text(str(tree), encoding="utf-8")


def cmd_activate(args):
    """Activation path: --activate of the staged release, --disable, then activate again."""
    prefix = Path(args.prefix).resolve()
    tree = Path((Path(args.work).resolve() / "tree.txt").read_text(encoding="utf-8"))
    releases = sorted(p.name for p in (prefix / "releases").iterdir() if p.is_dir())
    if len(releases) != 1:
        raise SystemExit("expected one staged release under %s, got %r" % (prefix / "releases", releases))
    py = [sys.executable, tree / "install.py", "--prefix", prefix, "--no-modify-path", "--yes"]
    run("activate-1", py + ["--activate", releases[0]])
    run("disable", py + ["--disable"])
    if bff_command(prefix).exists():
        raise SystemExit("--disable left %s behind" % bff_command(prefix))
    run("activate-2", py + ["--activate", releases[0]])
    cmd_verify(argparse.Namespace(prefix=str(prefix), tag="after-activate"))


def cmd_verify(args):
    """The user-visible check: the installed bff.cmd really starts and answers."""
    cmd = bff_command(args.prefix)
    tag = args.tag
    if not cmd.is_file():
        raise SystemExit("missing " + str(cmd))
    code, out = run(tag + "-version", ["cmd", "/c", cmd, "--version"])
    if not re.search(r"bff\s+[0-9]+\.[0-9]+\.[0-9]+", out):
        raise SystemExit("--version printed no version: " + out)
    code, out = run(tag + "-osiris-help", ["cmd", "/c", cmd, "osiris", "--help"])
    if "factory" not in out:
        raise SystemExit("osiris --help does not mention factory: " + out)
    # `doctor` may legitimately exit 1 on a CI box missing optional tools; a crash is what must fail.
    code, out = run(tag + "-doctor-json", ["cmd", "/c", cmd, "doctor", "--json"])
    json.loads(out[out.find("{"):out.rfind("}") + 1])
    code, out = run(tag + "-doctor", ["cmd", "/c", cmd, "doctor", "--offline", "--no-upgrade", "--yes"], check=False)
    if code not in (0, 1) or "Traceback" in out:
        raise SystemExit("doctor crashed (exit %s)" % code)


def cmd_negative(args):
    """A deliberately broken bff.cmd must be caught by verify; if verify passes, the smoke test is blind."""
    cmd = bff_command(args.prefix)
    good = cmd.read_bytes()
    try:
        cmd.write_bytes(b"@echo off\r\n\"C:\\does\\not\\exist\\python.exe\" %*\r\n")
        try:
            cmd_verify(argparse.Namespace(prefix=args.prefix, tag="negative"))
        except SystemExit as exc:
            print("negative test OK: broken bff.cmd rejected (%s)" % exc)
            return
        raise SystemExit("NEGATIVE TEST FAILED: verify accepted a broken bff.cmd")
    finally:
        cmd.write_bytes(good)


def cmd_tui(args):
    """prune (dry run) and factory --once against a fixture git repo, through the installed bff.cmd and the checkout's Osiris plugin."""
    cmd = bff_command(args.prefix)
    repo = Path(tempfile.mkdtemp(prefix="bff-fixture-")) / "repo"
    repo.mkdir()
    git_env = dict(os.environ, GIT_AUTHOR_NAME="ci", GIT_AUTHOR_EMAIL="ci@example.invalid", GIT_COMMITTER_NAME="ci", GIT_COMMITTER_EMAIL="ci@example.invalid")
    for step in (["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "fixture"]):
        run("tui-fixture-git", ["git", "-C", repo] + step, env=git_env)
    env = dict(os.environ, OSIRIS_PLUGIN_DIR=str(Path(args.plugin).resolve()))
    code, out = run("tui-prune", ["cmd", "/c", cmd, "osiris", "prune", "--repo", repo], env=env)
    if "Traceback" in out:
        raise SystemExit("prune crashed: " + out)
    if shutil.which("node"):
        code, out = run("tui-factory", ["cmd", "/c", cmd, "osiris", "factory", "--repo", repo, "--once", "--no-color"], env=env)
        if not out.strip() or "Traceback" in out:
            raise SystemExit("factory printed nothing useful: " + out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="step", required=True)
    for name, fn, opts in (
        ("build", cmd_build, ("out",)), ("fake-gh", cmd_fake_gh, ("bindir",)),
        ("install-py", cmd_install_py, ("dist", "prefix", "work")), ("activate", cmd_activate, ("prefix", "work")),
        ("verify", cmd_verify, ("prefix",)), ("tui", cmd_tui, ("prefix", "plugin")), ("negative", cmd_negative, ("prefix",)),
    ):
        p = sub.add_parser(name)
        for o in opts:
            p.add_argument("--" + o, required=True)
        if name == "verify":
            p.add_argument("--tag", default="verify")
        p.set_defaults(fn=fn)
    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
