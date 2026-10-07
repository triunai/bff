#!/usr/bin/env python3
"""Privacy gate: scan git-tracked files (and a release tarball) for personal or machine-specific strings.

Usage: privacy_gate.py [REPO] [--archive PATH.tar.gz]
Prints one `path:line: pattern-name` per hit and never the matched text.
Exit 1 on any hit, 0 when clean, 2 on usage or IO error.
"""
import argparse
import fnmatch
import os
import re
import sys
import tarfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bff import trusted_bin  # noqa: E402

PATTERNS = (
    ("home-path-posix", re.compile(rb"/(?:Users|home)/[^/\s]+/")),
    ("home-path-windows", re.compile(rb"[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s]+[\\/]", re.I)),
    ("email", re.compile(rb"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")),
    ("private-key", re.compile(rb"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----")),
    ("github-token", re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b")),
    ("anthropic-key", re.compile(rb"\bsk-ant-[A-Za-z0-9_-]{30,}\b")),
    ("aws-key", re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
)
DENYLIST_ENV = "BFF_PRIVACY_DENYLIST"
ALLOWLIST = Path(__file__).resolve().with_name("privacy-allowlist.txt")
MAX_MEMBER = 10 * 1024 * 1024


def load_allowlist(path):
    rules = []
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 2)
        if len(parts) < 3:
            raise ValueError("%s:%d: expected '<path-glob> <pattern-name> <reason>'" % (path.name, number))
        rules.append((parts[0], parts[1]))
    return rules


def denylist_terms():
    terms = [t.strip().lower().encode("utf-8") for t in os.environ.get(DENYLIST_ENV, "").splitlines()]
    return [t for t in terms if t]


def is_binary(data):
    return b"\0" in data[:8192]


def scan_bytes(label, data, allow, terms):
    """Return sorted (label, line, pattern-name) hits for one file's bytes."""
    if is_binary(data):
        return []
    hits = set()
    for number, line in enumerate(data.split(b"\n"), 1):
        lowered = line.lower()
        for name, regex in PATTERNS:
            if regex.search(line):
                hits.add((label, number, name))
        if any(term in lowered for term in terms):
            hits.add((label, number, "denylist"))
    return sorted(h for h in hits if not any(fnmatch.fnmatchcase(h[0], g) and h[2] == n for g, n in allow))


def tracked_files(repo):
    git = trusted_bin.which("git")
    if git is None:
        raise OSError("git was not found in a trusted location")
    out = trusted_bin.run([git, "-C", str(repo), "ls-files", "-z"], capture_output=True, check=True).stdout
    return [p.decode("utf-8", "surrogateescape") for p in out.split(b"\0") if p]


def scan_repo(repo, allow, terms):
    hits, scanned = [], set()
    for rel in tracked_files(repo):
        path = Path(repo) / rel
        if path.is_symlink() or not path.is_file():
            continue
        scanned.add(rel)
        hits += scan_bytes(rel, path.read_bytes(), allow, terms)
    return hits, scanned


def scan_archive(archive, allow, terms):
    hits, scanned = [], set()
    with tarfile.open(archive, "r:*") as tf:
        for member in tf:
            if not member.isreg() or member.size > MAX_MEMBER:
                continue
            label = "archive:" + member.name
            scanned.add(label)
            hits += scan_bytes(label, tf.extractfile(member).read(), allow, terms)
    return hits, scanned


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("repo", nargs="?", default=".")
    parser.add_argument("--archive", metavar="PATH.tar.gz")
    parser.add_argument("--allowlist", default=str(ALLOWLIST), help=argparse.SUPPRESS)
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 2 if exc.code else 0
    try:
        allow = load_allowlist(Path(args.allowlist))
        terms = denylist_terms()
        hits, scanned = scan_repo(args.repo, allow, terms)
        if args.archive:
            more, seen = scan_archive(args.archive, allow, terms)
            hits, scanned = hits + more, scanned | seen
    except (OSError, ValueError, trusted_bin.CalledProcessError, tarfile.TarError) as exc:
        print("privacy gate: error: " + type(exc).__name__, file=sys.stderr)
        return 2
    for label, number, name in hits:
        print("%s:%d: %s" % (label, number, name))
    if hits:
        print("privacy gate: %d hit(s) in %d file(s)" % (len(hits), len({h[0] for h in hits})))
        return 1
    print("privacy gate: clean (%d files)" % len(scanned))
    return 0


if __name__ == "__main__":
    sys.exit(main())
