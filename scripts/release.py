#!/usr/bin/env python3
"""Cut a BFF release from one place.

    python3 scripts/release.py --bump patch          # or --version 0.2.0; default: current version
    python3 scripts/release.py --version 0.1.2 --publish

Steps: bump the single version source and rewrite every pin, require a matching CHANGELOG
section, run the unit tests and the credential canary, build the archive, then print the exact
git/gh commands. `--publish` runs those commands instead, but only from a clean, committed tree
with an authenticated `gh` and an unused tag. The push to main is a plain push, so git itself
refuses anything that is not a fast-forward; this script never overrides that. Standard library only.
"""
import argparse
from pathlib import Path
import re
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import versioning  # noqa: E402

REPOSITORY = Path(__file__).resolve().parents[1]
GITHUB_REPO = "triunai/bff"


def bumped(version, part):
    major, minor, patch = (int(x) for x in version.split("."))
    if part == "major":
        return "%d.0.0" % (major + 1)
    if part == "minor":
        return "%d.%d.0" % (major, minor + 1)
    return "%d.%d.%d" % (major, minor, patch + 1)


def changelog_section(root, version):
    """The body of `## [version] - date` in CHANGELOG.md; these are the release notes."""
    text = (Path(root) / "CHANGELOG.md").read_text()
    match = re.search(r"^## \[" + re.escape(version) + r"\] - \d{4}-\d{2}-\d{2}\s*\n(.*?)(?=^## \[|^\[[^\]]+\]: |\Z)",
                      text, re.M | re.S)
    if not match or not match.group(1).strip():
        raise ValueError("CHANGELOG.md has no dated, non-empty '## [%s] - YYYY-MM-DD' section" % version)
    return match.group(1).strip() + "\n"


def release_commands(version, archive_dir, notes_file, title=None):
    """The exact commands that publish `version`, as argv lists. Pure; nothing is run here."""
    tag = "v" + version
    archive_dir = Path(archive_dir)
    return [
        ["git", "push", "origin", "HEAD:main"],  # plain push: git refuses a non-fast-forward
        ["git", "tag", "-a", tag, "-m", "BFF " + version],
        ["git", "push", "origin", tag],
        ["gh", "release", "create", tag, str(archive_dir / ("bff-" + version + ".tar.gz")), str(archive_dir / "SHA256SUMS"),
         "--repo", GITHUB_REPO, "--verify-tag", "--title", title or ("BFF " + version), "--notes-file", str(notes_file)],
    ]


def run_checks(root, python=sys.executable):
    """Full unit suite, then the credential canary on its own so its result is visible."""
    for command in ([python, "-m", "unittest", "discover", "-s", "tests"],
                    [python, "-m", "unittest", "discover", "-s", "tests", "-p", "test_release.py", "-v"]):
        if subprocess.run(command, cwd=str(root)).returncode:
            raise SystemExit("Checks failed: " + " ".join(command))


def build_archive(root, output, python=sys.executable):
    result = subprocess.run([python, str(Path(root) / "scripts" / "build-bff-release.py"), "--output", str(output)],
                            capture_output=True, text=True)
    if result.returncode:
        raise SystemExit("Archive build failed (the canary may have flagged content):\n" + result.stderr)
    return result.stdout.strip()


def publish_guards(root, version):
    """Refuse to publish unless the tree is clean, gh is logged in and the tag is unused."""
    def out(*argv):
        return subprocess.run(list(argv), cwd=str(root), capture_output=True, text=True)
    problems = []
    if out("git", "status", "--porcelain").stdout.strip():
        problems.append("working tree is not clean; commit the version bump first")
    if out("gh", "auth", "status").returncode:
        problems.append("gh is not authenticated; run `gh auth login`")
    tag = "v" + version
    if out("git", "rev-parse", "-q", "--verify", "refs/tags/" + tag).returncode == 0:
        problems.append("tag %s already exists locally" % tag)
    elif out("git", "ls-remote", "--tags", "origin", tag).stdout.strip():
        problems.append("tag %s already exists on origin" % tag)
    return problems


def main(argv=None, root=REPOSITORY):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--version", help="Release this X.Y.Z (default: the current version)")
    target.add_argument("--bump", choices=("major", "minor", "patch"), help="Increment the current version")
    parser.add_argument("--output", type=Path, default=Path("/tmp/bff-release"))
    parser.add_argument("--skip-tests", action="store_true", help="Skip the unit tests and canary (not for real releases)")
    parser.add_argument("--title", help="GitHub release title (default: 'BFF X.Y.Z')")
    parser.add_argument("--publish", action="store_true", help="Run the git/gh commands instead of printing them")
    args = parser.parse_args(argv)
    root = Path(root)
    current = versioning.read_version(root)
    version = args.version or (bumped(current, args.bump) if args.bump else current)
    if not versioning.SEMVER.fullmatch(version):
        raise SystemExit("Not a plain X.Y.Z version: " + version)
    if args.publish and args.skip_tests:
        raise SystemExit("--publish refuses --skip-tests")
    changed = versioning.apply_version(root, version)
    print("version %s -> %s; rewrote: %s" % (current, version, ", ".join(changed) or "nothing (already pinned)"))
    problems = versioning.check_pins(root)
    if problems:
        raise SystemExit("Pins still disagree: " + "; ".join(problems))
    try:
        notes = changelog_section(root, version)
    except ValueError as error:
        raise SystemExit(str(error))
    if not args.skip_tests:
        run_checks(root)
    print(build_archive(root, args.output))
    args.output.mkdir(parents=True, exist_ok=True)
    notes_file = args.output / "RELEASE_NOTES.md"
    notes_file.write_text(notes)
    commands = release_commands(version, args.output, notes_file, args.title)
    if not args.publish:
        print("\nCommit the version bump, then run:")
        for command in commands:
            print("  " + " ".join("'%s'" % part if " " in part else part for part in command))
        return 0
    problems = publish_guards(root, version)
    if problems:
        raise SystemExit("Not publishing: " + "; ".join(problems))
    for command in commands:
        print("$ " + " ".join(command))
        if subprocess.run(command, cwd=str(root)).returncode:
            raise SystemExit("Command failed; stopping before later steps: " + " ".join(command))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
