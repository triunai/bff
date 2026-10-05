#!/usr/bin/env python3
"""Build a clean, bounded SDK-only archive; never export the development repo."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile

REPOSITORY = Path(__file__).resolve().parents[1]
SOURCE = REPOSITORY / "sdk" if (REPOSITORY / "sdk").is_dir() else REPOSITORY
ROOT_FILES = {"README.md", "LICENSE", "PROVENANCE.md", "ARCHITECTURE.md", "install.py", "install.sh", "release-files.json"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    version = "0.1.0"
    specification = json.loads((SOURCE / "release-files.json").read_text())
    declared = specification.get("files")
    if not isinstance(declared, list) or len(declared) != len(set(declared)):
        raise SystemExit("Release file specification must contain unique paths.")
    for name in declared:
        path = Path(name)
        if (path.is_absolute() or ".." in path.parts or path.as_posix() != name or
                re.search(r"(?:^|/)(?:\.env(?:\..*)?|.*\.(?:pem|pfx|p12|key)|credentials.*|client_secret_.*)(?:$|/)", name, re.I)):
            raise SystemExit("Unsafe or credential-shaped release path: " + name)
    approved = set(declared)
    files = {}
    for path in sorted(SOURCE.rglob("*")):
        rel = path.relative_to(SOURCE)
        if "__pycache__" in rel.parts or "node_modules" in rel.parts or path.suffix in {".pyc", ".map"}:
            continue
        allowed = rel.as_posix() in approved
        if path.is_symlink():
            raise SystemExit("Refusing a symlink in SDK source: " + str(rel))
        if path.is_file() and rel.parts[0] in {"bff", "templates", "plugins"} and not allowed:
            raise SystemExit("Unreviewed distributable file: " + str(rel))
        if path.is_file() and allowed:
            data = path.read_bytes()
            if re.search(rb"/(?:Users|home)/[^/\s]+/", data):
                raise SystemExit("Machine-specific content in release: " + str(rel))
            if len(data) > 10 * 1024 * 1024:
                raise SystemExit("Oversize release file: " + str(rel))
            files[rel.as_posix()] = data
    required = approved | ROOT_FILES | {"bff/__init__.py", "bff/cli.py", "templates/repo/.bff.json"}
    if required - files.keys():
        raise SystemExit("Missing release files: " + ", ".join(sorted(required - files.keys())))
    inventory = {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
    files["release-manifest.json"] = (json.dumps({"version": version, "files": inventory}, sort_keys=True, indent=2) + "\n").encode()
    args.output.mkdir(parents=True, exist_ok=True)
    archive = args.output / ("bff-" + version + ".tar.gz")
    with tarfile.open(archive, "w:gz", format=tarfile.PAX_FORMAT) as tf:
        for name, data in sorted(files.items()):
            member = tarfile.TarInfo("bff-" + version + "/" + name)
            member.size = len(data)
            member.mode = 0o755 if name == "install.sh" else 0o644
            member.mtime = 0
            tf.addfile(member, io.BytesIO(data))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (args.output / "SHA256SUMS").write_text(digest + "  " + archive.name + "\n")
    print(json.dumps({"archive": str(archive), "sha256": digest, "files": len(inventory)}))


if __name__ == "__main__":
    main()
