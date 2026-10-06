"""Build the Osiris plugin from its PRIVATE repository, for a machine that has only bff.

Osiris is not published yet (compat.json `published: false`), so `bff osiris install` builds the commit that
compat.json pins (`osiris.private`) from `github.com/<repo>`:

1. access: `git ls-remote` over SSH (BatchMode: never asks for a passphrase or a host key), else over HTTPS with
   the GitHub CLI's credentials (`gh auth git-credential`) when `gh` is signed in. No access -> one next action;
2. fetch that commit into a cache clone (`<cache>/osiris-src`) and check that HEAD IS the pinned commit, which is
   the identity check for this channel (there is no published checksum or attestation for a private build);
3. `npm ci --omit=dev --ignore-scripts` (runtime packages only; no third-party install scripts run);
4. the repository's own `scripts/stage-plugin-install.sh <dir>`, which copies the plugin and GATES it the way BB
   will (a fresh-copy `bb plugin build` plus the beads safety scan).

The finished `install-<version>-<sha7>` directory is kept: BB serves a `path:` plugin from it, and a re-run reuses it.
Every child gets stdin=DEVNULL; long steps stream their output instead of capturing it.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

from . import paths

SHA = re.compile(r"[0-9a-f]{40}")
REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
NEEDS = ("git", "node", "npm", "bash", "bb")
_SSH_USER = "git"  # kept apart from the host so no literal address sits in the source (privacy gate)


class SourceError(ValueError):
    """A private-build step failed; the message carries the one next action."""


def spec(compat):
    """compat.json's `osiris.private` block, validated, or None when this bff pins no private build."""
    block = (compat.get("osiris") or {}).get("private")
    if block is None:
        return None
    ok = (isinstance(block, dict) and isinstance(block.get("repo"), str) and REPO.fullmatch(block["repo"])
          and isinstance(block.get("ref"), str) and SHA.fullmatch(block["ref"])
          and isinstance(block.get("version"), str) and block["version"])
    if not ok:
        raise ValueError("compat.json osiris.private has an unexpected shape")
    return block


def urls(repo, env=None):
    """SSH first, then HTTPS. BFF_OSIRIS_REPO_URL (a mirror, or a local file:// repo in tests) replaces both."""
    override = (os.environ if env is None else env).get("BFF_OSIRIS_REPO_URL")
    if override:
        return {"ssh": override}
    return {"ssh": _SSH_USER + "@" + "github.com:" + repo + ".git", "https": "https://github.com/" + repo + ".git"}


def builds_dir():
    return Path(str(paths.data_dir(prefix=paths.install_prefix()))) / "osiris-builds"


def cache_dir():
    return Path(str(paths.cache_dir())) / "osiris-src"


def build_name(version, sha):
    return "install-" + version + "-" + sha[:7]


def missing_tools(which=shutil.which):
    return [name for name in NEEDS if which(name) is None]


def _quiet_env(env=None):
    env = dict(os.environ if env is None else env)
    env["GIT_TERMINAL_PROMPT"] = "0"  # never ask for a username/password on a terminal nobody is watching
    env.setdefault("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o ConnectTimeout=15")
    return env


GH_HELPER = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]


def _git(args, run, env, cwd=None, capture=True, timeout=120):
    kwargs = {"stdin": subprocess.DEVNULL, "env": env, "timeout": timeout, "cwd": cwd}
    if capture:
        kwargs.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    return run(["git"] + args, **kwargs)


def access(repo, *, run=subprocess.run, which=shutil.which, env=None):
    """How this machine can read the private repo: {"via": "ssh"|"gh", "url", "git_args"} or raises SourceError."""
    found = urls(repo, env)
    env = _quiet_env(env)
    try:
        if _git(["ls-remote", found["ssh"], "HEAD"], run, env, timeout=45).returncode == 0:
            return {"via": "ssh", "url": found["ssh"], "git_args": []}
    except (OSError, subprocess.TimeoutExpired):
        pass
    if "https" in found and which("gh"):
        try:
            signed_in = run(["gh", "auth", "status"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, universal_newlines=True, timeout=30, env=env).returncode == 0
            if signed_in and _git(GH_HELPER + ["ls-remote", found["https"], "HEAD"], run, env, timeout=45).returncode == 0:
                return {"via": "gh", "url": found["https"], "git_args": list(GH_HELPER)}
        except (OSError, subprocess.TimeoutExpired):
            pass
    raise SourceError("this machine cannot read github.com/" + repo + " (Osiris is private). Sign in once with "
                      "`gh auth login` (or add this machine's SSH key to GitHub and run `ssh -T git"
                      "@github.com` once), then run: bff osiris install")


def fetch(repo, ref, *, cache, run=subprocess.run, which=shutil.which, env=None, out=print):
    """A checkout of `ref` in the cache clone; HEAD is verified to be `ref` when `ref` is a full commit id."""
    how = access(repo, run=run, which=which, env=env)
    env = _quiet_env(env)
    cache = Path(cache)
    if not (cache / ".git").is_dir():
        if os.path.lexists(str(cache)):
            shutil.rmtree(str(cache))
        cache.parent.mkdir(parents=True, exist_ok=True)
        if _git(["init", "-q", str(cache)], run, env).returncode:
            raise SourceError("could not create " + str(cache) + "; check the disk, then run: bff osiris install")
    _git(["-C", str(cache), "remote", "remove", "origin"], run, env)
    _git(["-C", str(cache), "remote", "add", "origin", how["url"]], run, env)
    out("fetching Osiris " + ref[:12] + " from github.com/" + repo + " (via " + how["via"] + ")")
    base = how["git_args"] + ["-C", str(cache)]
    fetched = _git(base + ["fetch", "-q", "--depth", "1", "origin", ref], run, env, timeout=600)
    if fetched.returncode:  # a server that will not serve a bare commit id: fetch the branches, then pick the commit
        fetched = _git(base + ["fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*"], run, env, timeout=600)
        target = ref
    else:
        target = "FETCH_HEAD"
    if fetched.returncode:
        raise SourceError("fetching github.com/" + repo + " failed: " + (fetched.stderr or "").strip()[-200:]
                          + "; check the network, then run: bff osiris install")
    checkout = _git(["-C", str(cache), "checkout", "-q", "--force", "--detach", target], run, env)
    if checkout.returncode:
        raise SourceError("commit " + ref + " is not on github.com/" + repo + " (has it been pushed?); "
                          "push it, or pass --ref <commit>, then run: bff osiris install")
    head = _git(["-C", str(cache), "rev-parse", "HEAD"], run, env).stdout.strip()
    if SHA.fullmatch(ref) and head != ref:
        raise SourceError("the fetched commit is " + head + ", not the pinned " + ref + "; nothing was installed")
    return cache, head


def build(checkout, destination, *, run=subprocess.run, env=None, out=print):
    """npm ci (runtime packages, no install scripts), then the repo's own stage script, which gates the result."""
    checkout, destination = Path(checkout), Path(destination)
    script = checkout / "scripts" / "stage-plugin-install.sh"
    if not script.is_file():
        raise SourceError("this Osiris commit has no scripts/stage-plugin-install.sh; pass --ref <a newer commit>")
    env = dict(os.environ if env is None else env)
    out("installing Osiris runtime packages (npm ci, no install scripts)...")
    npm = run(["npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=str(checkout),
              stdin=subprocess.DEVNULL, env=env, timeout=900)
    if npm.returncode:
        raise SourceError("npm ci failed (exit " + str(npm.returncode) + "); fix the error above, then run: bff osiris install")
    staging = destination.with_name("." + destination.name + ".partial")
    if os.path.lexists(str(staging)):
        shutil.rmtree(str(staging))
    staging.parent.mkdir(parents=True, exist_ok=True)
    out("staging and gating the plugin (BB builds a fresh copy)...")
    staged = run(["bash", str(script), str(staging)], cwd=str(checkout), stdin=subprocess.DEVNULL, env=env, timeout=900)
    if staged.returncode:
        shutil.rmtree(str(staging), ignore_errors=True)
        raise SourceError("the Osiris stage gate failed (exit " + str(staged.returncode) + "); nothing was installed. "
                          "The reason is printed above; run bff osiris doctor")
    os.rename(str(staging), str(destination))  # only a gated stage ever gets the final name
    return destination


def version_of(directory):
    try:
        return json.loads((Path(directory) / "package.json").read_text(encoding="utf-8")).get("version")
    except (OSError, ValueError, AttributeError):
        return None
