"""`bff osiris prune --apply`: remove the worktrees the Osiris plugin classified SAFE.

The plugin only PLANS (`osiris-tui.mjs prune --json`); the removal lives here on purpose, because the plugin bundle must never mutate a worktree.
Every SAFE entry is re-checked immediately before removal, then removed with a plain `git worktree remove` (never --force, never a branch delete).
"""

import json
import os
from pathlib import Path
import sys

from . import trusted_bin

PROTECTED_BRANCHES = ("main", "master")
KEEP_INSTALLS = 3


def _git(repo, *argv):
    git = trusted_bin.which("git")
    if git is None:
        raise ValueError("git was not found in a trusted location")
    return trusted_bin.run([git, "-C", str(repo)] + list(argv), capture_output=True, text=True, timeout=60, stdin=trusted_bin.DEVNULL, inherit=trusted_bin.TOOL_INHERIT)


def fetch_plan(plugin, repo, min_idle_days=None):
    """The plugin's own plan, so there is one classifier: {"safe": [...], "review": [...], "keep": [...], "opts": {...}}."""
    node = trusted_bin.which("node")
    if node is None:
        raise ValueError("node executable unavailable; the Osiris terminal apps need Node 22.6 or newer")
    argv = [node, str(Path(plugin) / "bin" / "osiris-tui.mjs"), "prune", "--json", "--repo", str(repo)]
    if min_idle_days is not None:
        argv += ["--min-idle-days", str(min_idle_days)]
    done = trusted_bin.run(argv, capture_output=True, text=True, timeout=120, stdin=trusted_bin.DEVNULL, inherit=trusted_bin.TOOL_INHERIT)
    try:
        plan = json.loads(done.stdout)["plan"]
    except (ValueError, KeyError, TypeError):
        raise ValueError("The Osiris plugin returned no prune plan (exit " + str(done.returncode) + "): " + (done.stderr or "").strip()[:200])
    return plan


def worktree_table(repo):
    """{real path: {"locked": bool, "head": sha}} from `git worktree list --porcelain`; the first entry is the main worktree."""
    done = _git(repo, "worktree", "list", "--porcelain")
    if done.returncode:
        raise ValueError("git worktree list failed: " + (done.stderr or "").strip()[:200])
    table, current, main = {}, None, None
    for line in done.stdout.splitlines():
        if line.startswith("worktree "):
            current = os.path.realpath(line[9:])
            table[current] = {"locked": False, "head": None}
            main = main or current
        elif current and line.startswith("HEAD "):
            table[current]["head"] = line[5:].strip()
        elif current and (line == "locked" or line.startswith("locked ")):
            table[current]["locked"] = True
    return table, main


def protected_dirs(plan, plugin):
    """The installed plugin dir, the located plugin dir and the newest KEEP_INSTALLS install-* siblings of either."""
    keep = set()
    for item in (plan.get("opts", {}).get("installed"), plugin):
        if not item:
            continue
        real = Path(os.path.realpath(item))
        keep.add(str(real))
        try:
            installs = sorted((d for d in real.parent.iterdir() if d.name.startswith("install-") and d.is_dir()), key=lambda d: d.stat().st_mtime, reverse=True)
        except OSError:
            installs = []
        keep.update(str(d.resolve()) for d in installs[:KEEP_INSTALLS])
    return keep


def recheck(entry, table, main, keep, repo):
    """None when the entry may be removed now, else the reason it must be skipped."""
    path = os.path.realpath(entry["path"])
    info = table.get(path)
    if info is None:
        return "no longer a worktree of this repository"
    if path == main:
        return "main worktree"
    if path in keep:
        return "installed plugin or one of the newest installs"
    if info["locked"]:
        return "locked"
    status = _git(path, "status", "--porcelain")
    if status.returncode or status.stdout.strip():
        return "uncommitted or untracked changes" if not status.returncode else "git status failed"
    tip = _git(path, "rev-parse", "HEAD")
    if tip.returncode:
        return "no readable HEAD"
    refs = ["--remotes"]
    for name in PROTECTED_BRANCHES:
        if _git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/" + name).returncode == 0:
            refs.append("refs/heads/" + name)
    count = _git(repo, "rev-list", "--count", tip.stdout.strip(), "--not", *refs)
    if count.returncode or count.stdout.strip() != "0":
        return "commits not on any remote or main"
    return None


def apply_prune(plugin, args, out=None, stdin=None, plan=None):
    out = out or sys.stdout
    repo = Path(args.repo or Path.cwd()).resolve()
    plan = plan if plan is not None else fetch_plan(plugin, repo, args.min_idle_days)
    safe = plan.get("safe", [])
    print("SAFE %d, REVIEW %d, KEEP %d (REVIEW and KEEP are never touched)" % (len(safe), len(plan.get("review", [])), len(plan.get("keep", []))), file=out)
    for entry in safe:
        print("  would remove " + entry["path"] + "  [" + str(entry.get("branch")) + "]  " + str(entry.get("reason", "")), file=out)
    if not safe:
        return 0
    if not args.yes:
        stream = stdin or sys.stdin
        if not stream.isatty():
            print("no terminal to ask on; re-run with --yes to remove these worktrees", file=sys.stderr)
            return 2
        print("Remove %d worktree(s)? [y/N] " % len(safe), end="", file=out, flush=True)
        if stream.readline().strip().lower() not in ("y", "yes"):
            print("no changes made", file=out)
            return 0
    table, main = worktree_table(repo)
    keep = protected_dirs(plan, plugin)
    removed, skipped = [], []
    for entry in safe:
        reason = recheck(entry, table, main, keep, repo)
        if reason is None:
            done = _git(repo, "worktree", "remove", entry["path"])
            if done.returncode:
                reason = "git refused: " + (done.stderr or "").strip().splitlines()[-1][:160] if (done.stderr or "").strip() else "git refused"
        if reason is None:
            removed.append(entry["path"])
            print("removed " + entry["path"], file=out)
        else:
            skipped.append(entry["path"])
            print("skipped " + entry["path"] + ": " + reason, file=out)
    _git(repo, "worktree", "prune")
    print("removed %d, skipped %d; no branch was deleted" % (len(removed), len(skipped)), file=out)
    return 0
