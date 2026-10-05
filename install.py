#!/usr/bin/env python3
"""Install BFF into an isolated, content-addressed namespace (Python 3.9+)."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sys
import tempfile
import uuid

# Keep startup stdlib-only: release verification precedes any packaged module import.
__version__ = "0.1.0"

SOURCE = Path(__file__).resolve().parent
RELEASE_NAME = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{12}")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inventory(root):
    """Inventory actual files; caches are not release inputs. Never follow links."""
    files = {}
    for directory, dirs, names in os.walk(str(root), followlinks=False):
        base = Path(directory)
        for name in list(dirs):
            path = base / name
            if path.is_symlink():
                raise ValueError("Symlink directory refused: " + str(path))
            if name == "__pycache__":
                dirs.remove(name)
        for name in names:
            path = base / name
            if path.is_symlink() or not path.is_file():
                raise ValueError("Non-regular release input: " + str(path))
            files[path.relative_to(root).as_posix()] = digest(path.read_bytes())
    return files


def source_files(source):
    """An explicit distribution allowlist, independent of the repository tree."""
    selected = {}
    package = source / "bff"
    if package.is_symlink() or not package.is_dir():
        raise ValueError("Missing regular bff package")
    for name, value in inventory(package).items():
        if "/" in name or not name.endswith(".py"):
            raise ValueError("Unexpected package input: " + name)
        selected["bff/" + name] = value
    if not {"bff/__init__.py", "bff/__main__.py", "bff/cli.py"} <= set(selected):
        raise ValueError("Incomplete bff package")
    templates = source / "templates"
    if templates.is_symlink() or not templates.is_dir():
        raise ValueError("Missing regular templates directory")
    selected.update({"templates/" + name: value for name, value in inventory(templates).items()})
    if not any(name.startswith("templates/repo/") for name in selected):
        raise ValueError("Missing repo templates")
    for name in ("README.md", "LICENSE", "PROVENANCE.md", "ARCHITECTURE.md", "install.sh"):
        path = source / name
        if os.path.lexists(str(path)):
            if path.is_symlink() or not path.is_file():
                raise ValueError(name + " must be a regular file")
            selected[name] = digest(path.read_bytes())
    docs = source / "docs"
    if os.path.lexists(str(docs)):
        if docs.is_symlink() or not docs.is_dir():
            raise ValueError("docs must be a regular directory")
        for name, value in inventory(docs).items():
            if "/" not in name and name.endswith(".md"):
                selected["docs/" + name] = value
    plugin = source / "plugins" / "osiris"
    if os.path.lexists(str(source / "plugins")):
        if (source / "plugins").is_symlink() or not (source / "plugins").is_dir():
            raise ValueError("plugins must be a regular directory")
    if os.path.lexists(str(plugin)):
        if plugin.is_symlink() or not plugin.is_dir():
            raise ValueError("Osiris bundle must be a regular directory")
        for name, value in inventory(plugin).items():
            if not plugin_file_allowed(name):
                raise ValueError("Unapproved Osiris bundle input: " + name)
            selected["plugins/osiris/" + name] = value
    return selected


def plugin_file_allowed(name):
    parts = Path(name).parts
    return ("node_modules" not in parts and ".." not in parts and not Path(name).is_absolute()
            and (name in ("package.json", "LICENSE", "THIRD_PARTY_NOTICES.txt")
                 or (parts[0] == "dist" and Path(name).suffix == ".json")
                 or Path(name).suffix in (".js", ".css", ".ts", ".tsx", ".md")))


def verify_source_manifest(source):
    path = source / "release-manifest.json"
    if not os.path.lexists(str(path)):
        return  # A development tree need not carry an archive manifest.
    if path.is_symlink() or not path.is_file():
        raise ValueError("Release archive manifest must be a regular file")
    manifest = json.loads(path.read_text())
    if not isinstance(manifest, dict) or manifest.get("version") != __version__:
        raise ValueError("Archive manifest version mismatch")
    expected = manifest.get("files")
    if not isinstance(expected, dict) or not {"install.py", "bff/__init__.py", "bff/cli.py"} <= set(expected):
        raise ValueError("Incomplete archive manifest")
    for name, checksum in expected.items():
        if (not isinstance(name, str) or not name or Path(name).is_absolute() or ".." in Path(name).parts
                or name == "release-manifest.json" or not isinstance(checksum, str)
                or not re.fullmatch(r"[a-f0-9]{64}", checksum)):
            raise ValueError("Invalid archive manifest entry")
    actual = inventory(source)
    actual.pop("release-manifest.json", None)
    if actual != expected:
        raise ValueError("Archive manifest integrity mismatch")


def release_id(manifest):
    identity = {key: manifest[key] for key in ("version", "python", "files")}
    return manifest["version"] + "-" + digest(json.dumps(identity, sort_keys=True).encode())[:12]


def owned_command(link, releases):
    if not link.is_symlink():
        return False
    target = Path(os.path.abspath(str(link.parent / os.readlink(str(link))))).resolve()
    relative = None
    try:
        relative = target.relative_to(releases.resolve())
    except ValueError:
        return False
    return (len(relative.parts) == 3 and RELEASE_NAME.fullmatch(relative.parts[0]) is not None
            and relative.parts[1:] == ("bin", "bff"))


def preflight(prefix):
    releases = prefix / "share" / "bff" / "releases"
    for relative in ("bin", "share", "share/bff", "share/bff/releases"):
        path = prefix / relative
        if path.is_symlink() or (path.exists() and not path.is_dir()):
            raise ValueError("Installation directory collision: " + str(path))
    command = prefix / "bin" / "bff"
    if os.path.lexists(str(command)) and not owned_command(command, releases):
        raise ValueError("Refusing unrelated bff command: " + str(command))
    return releases, command


def verify_release(release):
    if release.is_symlink() or not release.is_dir():
        raise ValueError("Missing regular release directory")
    manifest_path = release / "manifest.json"
    if manifest_path.is_symlink():
        raise ValueError("Symlink manifest refused")
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("schema_version") != 1 or release_id(manifest) != release.name:
        raise ValueError("Release identity mismatch")
    expected = manifest["files"]
    if not isinstance(expected, dict) or not {"bff/cli.py", "bin/bff"} <= set(expected):
        raise ValueError("Incomplete release manifest")
    for name, checksum in expected.items():
        valid = (name in ("bin/bff", "README.md", "LICENSE", "PROVENANCE.md", "ARCHITECTURE.md", "install.sh") or
                 (name.startswith("bff/") and "/" not in name[4:] and name.endswith(".py")) or
                 (name.startswith("docs/") and "/" not in name[5:] and name.endswith(".md")) or
                 (name.startswith("plugins/osiris/") and plugin_file_allowed(name[len("plugins/osiris/"):])) or
                 name.startswith("templates/"))
        if not valid or Path(name).is_absolute() or ".." in Path(name).parts:
            raise ValueError("Invalid release manifest path")
        if not isinstance(checksum, str) or not re.fullmatch(r"[a-f0-9]{64}", checksum):
            raise ValueError("Invalid release checksum")
    actual = inventory(release)
    actual.pop("manifest.json", None)
    if actual != expected:
        raise ValueError("Release integrity mismatch; refusing activation")
    if not os.access(str(release / "bin" / "bff"), os.X_OK):
        raise ValueError("Release launcher is not executable")
    return manifest


def activate(release, prefix):
    prefix = prefix.expanduser().resolve()
    release = release.parent.resolve() / release.name
    releases, command = preflight(prefix)
    if release.parent != releases or not RELEASE_NAME.fullmatch(release.name):
        raise ValueError("Release must belong to this BFF namespace")
    verify_release(release)
    command.parent.mkdir(parents=True, exist_ok=True)
    previous = os.readlink(str(command)) if command.is_symlink() else None
    temporary = command.with_name(".bff-link-" + uuid.uuid4().hex)
    try:
        temporary.symlink_to(release / "bin" / "bff")
        os.replace(str(temporary), str(command))
    finally:
        if temporary.is_symlink():
            temporary.unlink()
    available = command.parent in {Path(item).expanduser().resolve()
                                   for item in os.environ.get("PATH", "").split(os.pathsep) if item}
    return {"command": str(command), "release": release.name, "previous_target": previous,
            "path_available": available,
            "path_note": "bff is on PATH" if available else "Use the printed absolute command; bin directory is absent from PATH"}


def install(prefix, source=SOURCE, interpreter=None):
    if sys.version_info < (3, 9):
        raise ValueError("Python 3.9+ required")
    prefix = prefix.expanduser().resolve()
    verify_source_manifest(source)
    releases, command = preflight(prefix)
    interpreter = str(Path(interpreter or sys.executable).absolute())
    files = source_files(source)
    code = ("import sys; from pathlib import Path; "
            "sys.path.insert(0,str(Path(sys.argv.pop(1)).resolve().parents[1])); "
            "from bff.cli import main; raise SystemExit(main())")
    launcher = ("#!/bin/sh\nexec " + shlex.quote(interpreter) + " -c " + shlex.quote(code)
                + ' "$0" "$@"\n').encode()
    files["bin/bff"] = digest(launcher)
    manifest = {"schema_version": 1, "version": __version__, "python": interpreter, "files": files}
    release = releases / release_id(manifest)
    if os.path.lexists(str(release)):
        if verify_release(release) != manifest:
            raise ValueError("Existing release differs from source")
    else:
        releases.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=".bff-stage-", dir=str(releases)))
        try:
            for name, expected in files.items():
                destination = staging / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                data = launcher if name == "bin/bff" else (source / name).read_bytes()
                if digest(data) != expected:
                    raise ValueError("Release input changed during installation")
                destination.write_bytes(data)
            (staging / "bin" / "bff").chmod(0o755)
            (staging / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
            os.rename(str(staging), str(release))
        finally:
            if staging.exists():
                shutil.rmtree(str(staging))
    return activate(release, prefix)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", type=Path, default=Path.home() / ".local")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--activate", metavar="RELEASE", help="Activate a preserved, verified release")
    action.add_argument("--disable", action="store_true", help="Remove the owned command; preserve releases")
    args = parser.parse_args(argv)
    prefix = args.prefix.expanduser().resolve()
    try:
        if args.activate:
            if not RELEASE_NAME.fullmatch(args.activate):
                raise ValueError("Invalid release name")
            result = activate(prefix / "share" / "bff" / "releases" / args.activate, prefix)
        elif args.disable:
            releases, command = preflight(prefix)
            if not owned_command(command, releases):
                raise ValueError("No owned BFF command to disable")
            previous = os.readlink(str(command))
            command.unlink()
            result = {"disabled": str(command), "preserved_target": previous}
        else:
            result = install(prefix)
        print(json.dumps(result, indent=2))
        return 0
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
