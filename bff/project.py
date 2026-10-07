"""Explicit repo bindings, safe adoption and read-only spine inspection."""

import json
import os
from pathlib import Path
import re
import shutil
import tempfile

from . import trusted_bin

PROFILE = {
    "schema_version": 1,
    "router": "hygiene.md",
    "spine": {
        "board": "docs/workstreams.md",
        "hot_state": "docs/hot-state.md",
        "decisions": "docs/decisions.md",
        "backlog": "docs/state-backlog.md",
        "journal": "docs/project-log.md",
        "seed": "docs/NEXT-SESSION-SEED.md",
    },
    "checks": {},
}
WS = re.compile(r"\bWS-\d{2,}\b")
CANONICAL_WS = re.compile(r"^### WS-(\d{2,})(?:\s+—\s+.+)?\s*$")


def repo_root(path=None):
    git = trusted_bin.which("git")
    if git is None:
        raise ValueError("git was not found in a trusted location; install git, then select a Git repository with --repo")
    result = trusted_bin.run([git, "-C", str(path or Path.cwd()), "rev-parse", "--show-toplevel"],
                             stdout=trusted_bin.PIPE, stderr=trusted_bin.PIPE, text=True)
    if result.returncode:
        raise ValueError("Select a Git repository with --repo")
    return Path(result.stdout.strip()).resolve()


def contained(repo, name):
    repo = repo.resolve()
    if not isinstance(name, str) or not name or Path(name).is_absolute() or ".." in Path(name).parts:
        raise ValueError("Profile path must be relative and contained: " + str(name))
    path = repo / name
    # Refuse all path symlinks, including contained ones: their ownership is ambiguous.
    current = repo
    for part in Path(name).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Symlink profile path refused: " + name)
    try:
        path.resolve().relative_to(repo)
    except ValueError:
        raise ValueError("Profile path escapes repository: " + name)
    return path


def load_profile(repo):
    profile = json.loads(contained(repo, ".bff.json").read_text())
    if not isinstance(profile, dict) or profile.get("schema_version") != 1:
        raise ValueError("Unsupported BFF profile schema")
    spine = profile.get("spine")
    if not isinstance(spine, dict) or set(spine) != set(PROFILE["spine"]):
        raise ValueError("Profile must bind all six spine paths")
    paths = {"router": contained(repo, profile.get("router"))}
    paths.update({key: contained(repo, value) for key, value in spine.items()})
    if len(set(paths.values())) != len(paths):
        raise ValueError("Profile paths must have separate authoritative homes")
    checks = profile.get("checks")
    if not isinstance(checks, dict):
        raise ValueError("Profile checks must be named argv lists")
    for name, argv in checks.items():
        if (not isinstance(name, str) or not name or not isinstance(argv, list) or not argv or
                any(not isinstance(arg, str) or "\x00" in arg for arg in argv) or not argv[0]):
            raise ValueError("Invalid named check argv: " + str(name))
    return profile, paths


def init_repo(repo, templates):
    repo = repo.resolve()
    if templates.is_symlink() or not templates.is_dir():
        raise ValueError("Repo templates unavailable in this distribution")
    payload = {}
    for directory, dirs, files in os.walk(str(templates), followlinks=False):
        base = Path(directory)
        for name in dirs:
            if (base / name).is_symlink():
                raise ValueError("Symlink template refused")
        for name in files:
            source = base / name
            if source.is_symlink() or not source.is_file():
                raise ValueError("Non-regular template refused")
            relative = source.relative_to(templates).as_posix()
            contained(repo, relative)
            payload[relative] = source.read_bytes()
    payload[".bff.json"] = (json.dumps(PROFILE, indent=2) + "\n").encode()
    required = {PROFILE["router"]} | set(PROFILE["spine"].values())
    if not required <= set(payload):
        raise ValueError("Incomplete repo templates")
    if os.path.lexists(str(repo / ".bff.json")):
        existing, _ = load_profile(repo)
        if existing == PROFILE and all(contained(repo, name).is_file() for name in payload):
            return {"repo": str(repo), "status": "already-initialized", "written": []}
        raise ValueError("Existing profile or incomplete adoption; refusing changes")
    # Entire target set and parent hierarchy are checked before creating anything.
    for name in payload:
        target = contained(repo, name)
        if os.path.lexists(str(target)):
            raise ValueError("Existing authoritative/template file; refusing changes: " + name)
        parent = target.parent
        while parent != repo:
            if parent.exists() and not parent.is_dir():
                raise ValueError("Template parent is not a directory: " + str(parent))
            parent = parent.parent
    stage = Path(tempfile.mkdtemp(prefix=".bff-init-", dir=str(repo)))
    created, directories = [], []
    try:
        for name, data in payload.items():
            staged = stage / name
            staged.parent.mkdir(parents=True, exist_ok=True)
            staged.write_bytes(data)
        # Profile is the final activation marker. Each completed file is linked exclusively.
        for name in sorted(payload, key=lambda item: (item == ".bff.json", item)):
            target = contained(repo, name)
            missing = []
            parent = target.parent
            while not parent.exists():
                missing.append(parent)
                parent = parent.parent
            for parent in reversed(missing):
                parent.mkdir()
                directories.append(parent)
            os.link(str(stage / name), str(target))
            created.append(target)
        return {"repo": str(repo), "status": "initialized", "written": [str(p.relative_to(repo)) for p in created]}
    except BaseException:
        for target in reversed(created):
            target.unlink()
        for directory in reversed(directories):
            directory.rmdir()
        raise
    finally:
        shutil.rmtree(str(stage))


def blocks(text):
    """Yield level-three entries, preserving their raw content for hydration."""
    matches = list(re.finditer(r"^### .+$", text, flags=re.MULTILINE))
    return [(match.group(), text[match.end():matches[index + 1].start() if index + 1 < len(matches) else len(text)])
            for index, match in enumerate(matches)]


def inspect_spine(paths):
    texts = {key: path.read_text() for key, path in paths.items()}
    errors, workstreams, done, journal_claims = [], [], set(), set()
    entries = blocks(texts["board"])
    for heading, body in entries:
        match = CANONICAL_WS.fullmatch(heading)
        if not match:
            if "WS-" in heading:
                errors.append("Malformed workstream heading: " + heading)
            continue
        key = "WS-" + match.group(1)
        workstreams.append(key)
        lines = [line.strip() for line in body.splitlines() if line.strip()]
        if not lines or lines[0] != "WS: " + key:
            errors.append("First body line must be WS: " + key)
        if re.search(r"^Status:.*\bDONE\b", body, flags=re.MULTILINE | re.IGNORECASE):
            done.add(key)
    if not workstreams:
        errors.append("Board has no canonical workstreams")
    for kind, key, pattern in (
            ("workstream", "board", r"^### (WS-\d{2,})\b"),
            ("decision", "decisions", r"^### (D-\d+)\b"),
            ("backlog", "backlog", r"^### (#\d+)\b"),
            ("journal", "journal", r"^### (\d{4}-\d{2}-\d{2}#\d+)\b")):
        identifiers = re.findall(pattern, texts[key], flags=re.MULTILINE)
        duplicates = sorted({item for item in identifiers if identifiers.count(item) > 1})
        for identifier in duplicates:
            errors.append("Duplicate " + kind + " ID: " + identifier)
        if kind != "workstream":
            for heading, body in blocks(texts[key]):
                if not re.match(pattern[1:], heading):
                    errors.append("Malformed " + kind + " heading: " + heading)
                    continue
                lines = [line.strip() for line in body.splitlines() if line.strip()]
                if not lines or not re.fullmatch(r"WS: WS-\d{2,}(?:, WS-\d{2,})*", lines[0]):
                    errors.append("First body line must claim WS for " + heading)
                elif kind == "journal":
                    journal_claims.update(WS.findall(lines[0]))
    known = set(workstreams)
    for name, text in texts.items():
        for reference in sorted(set(WS.findall(text)) - known):
            errors.append("Unresolved workstream reference in " + name + ": " + reference)
        for malformed in re.findall(r"\bWS-[A-Za-z0-9_-]+", text):
            if not WS.fullmatch(malformed):
                errors.append("Malformed workstream reference in " + name + ": " + malformed)
    for key in sorted(done - journal_claims):
        errors.append("Done workstream lacks journal claim: " + key)
    return texts, workstreams, errors


def run_checks(profile, repo):
    results = []
    for name, argv in profile["checks"].items():
        try:
            # A bare program name is found in the fixed trusted directories (never PATH); a path must itself be absolute and trusted.
            # An absolute path is the user's explicit choice in their own profile (location is theirs; ownership, mode and directory-chain checks still apply).
            absolute = "/" in argv[0]
            program = argv[0] if absolute else trusted_bin.which(argv[0])
            if program is None:
                raise FileNotFoundError("no trusted program named " + argv[0])
            result = trusted_bin.run([program] + list(argv[1:]), policy=trusted_bin.own_policy(program) if absolute else None, cwd=str(repo), timeout=120, text=True,
                                     inherit=trusted_bin.TOOL_INHERIT, stdout=trusted_bin.PIPE, stderr=trusted_bin.PIPE)
            results.append({"name": name, "argv": argv,
                            "status": "pass" if result.returncode == 0 else "nonzero",
                            "returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr})
        except FileNotFoundError as exc:
            results.append({"name": name, "argv": argv, "status": "missing-executable", "error": str(exc)})
        except (OSError, trusted_bin.TimeoutExpired, UnicodeError) as exc:
            results.append({"name": name, "argv": argv, "status": "tool-error", "error": str(exc)})
    return results
