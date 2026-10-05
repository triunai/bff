"""One version source: `bff/__init__.py`. Everything else is a pin that must agree with it.

Used by the release builder (reads the version), `scripts/release.py` (rewrites the pins) and
`tests/test_version.py` (fails when a pin drifts). Standard library only.
"""
import json
from pathlib import Path
import re

SEMVER = re.compile(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)")
SOURCE_FILE = "bff/__init__.py"
SOURCE_PATTERN = re.compile(r'^__version__ = "(' + SEMVER.pattern + r')"$', re.M)

# (relative path, regex with exactly one capture group around the version, description).
# The pins are text pins on purpose: install.py/install.sh must run before any bff import.
TEXT_PINS = (
    ("install.py", re.compile(r'^__version__ = "(' + SEMVER.pattern + r')"$', re.M), "installer version"),
    ("install.sh", re.compile(r"^BFF_VERSION=(" + SEMVER.pattern + r")$", re.M), "one-line installer pin"),
    ("README.md", re.compile(r"bff/v(" + SEMVER.pattern + r")/install\.sh"), "README install URL"),
)
JSON_PINS = (("release-files.json", "release manifest version"), ("package.json", "development package version"))
LOCK = "package-lock.json"  # root `version` and `packages[""].version` track package.json


def read_version(root):
    """The authoritative version, parsed (not imported) from bff/__init__.py."""
    match = SOURCE_PATTERN.search((Path(root) / SOURCE_FILE).read_text())
    if not match:
        raise ValueError("No __version__ = \"X.Y.Z\" line in " + SOURCE_FILE)
    return match.group(1)


def _read(root, name):
    return (Path(root) / name).read_text()


def pins(root):
    """Return [(description, path, value)] for every pinned occurrence of the version."""
    found = []
    for name, pattern, description in TEXT_PINS:
        values = pattern.findall(_read(root, name))
        if not values:
            found.append((description, name, None))
        found.extend((description, name, value) for value in values)
    for name, description in JSON_PINS:
        found.append((description, name, json.loads(_read(root, name)).get("version")))
    lock = json.loads(_read(root, LOCK))
    found.append(("lockfile version", LOCK, lock.get("version")))
    found.append(("lockfile root package version", LOCK, lock.get("packages", {}).get("", {}).get("version")))
    return found


def check_pins(root):
    """Human-readable mismatches between the single source and every pin; empty means consistent."""
    version = read_version(root)
    return ["%s (%s) is %s, expected %s" % (description, name, value, version)
            for description, name, value in pins(root) if value != version]


def apply_version(root, version):
    """Rewrite every pin (and the source) to `version`. Returns the list of changed paths."""
    if not SEMVER.fullmatch(version):
        raise ValueError("Not a plain X.Y.Z version: " + version)
    root = Path(root)
    changed = []

    def rewrite(name, text):
        if text != _read(root, name):
            (root / name).write_text(text)
            changed.append(name)

    rewrite(SOURCE_FILE, SOURCE_PATTERN.sub('__version__ = "' + version + '"', _read(root, SOURCE_FILE)))
    for name, pattern, _ in TEXT_PINS:
        text = _read(root, name)
        if not pattern.search(text):
            raise ValueError("No version pin found in " + name)
        rewrite(name, pattern.sub(lambda m: m.group(0).replace(m.group(1), version), text))
    for name, _ in JSON_PINS:
        text = _read(root, name)
        # Substitute textually so the file's formatting and key order are untouched.
        rewritten, count = re.subn(r'("version":\s*")' + SEMVER.pattern + '"', r"\g<1>" + version + '"', text, count=1)
        if count != 1:
            raise ValueError("No version field in " + name)
        rewrite(name, rewritten)
    # The first two "version" keys of the lockfile are the root ones; dependency versions follow.
    rewritten, count = re.subn(r'("version":\s*")' + SEMVER.pattern + '"', r"\g<1>" + version + '"', _read(root, LOCK), count=2)
    if count != 2:
        raise ValueError("Unexpected lockfile layout in " + LOCK)
    rewrite(LOCK, rewritten)
    return changed
