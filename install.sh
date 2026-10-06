#!/bin/sh
# Pinned BFF bootstrap. Downloads only when not invoked from a local source tree.
# Usage: sh install.sh [--setup] [--yes] [--no-modify-path] [--prefix DIR] [--activate R | --disable | --stage-only]
set -eu
BFF_VERSION=0.1.1
BFF_REPO=triunai/bff
BFF_SETUP=0
BFF_YES=0
for arg do
  shift
  case $arg in
    --setup) BFF_SETUP=1 ;;
    *) if [ "$arg" = --yes ]; then BFF_YES=1; fi; set -- "$@" "$arg" ;;
  esac
done
BFF_PYTHON_HELP='BFF needs Python 3.9 or newer. Install it from https://www.python.org/downloads/ (or with your package manager), then run this installer again.'
command -v python3 >/dev/null 2>&1 || { echo "$BFF_PYTHON_HELP" >&2; exit 1; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || { echo "$BFF_PYTHON_HELP" >&2; exit 1; }
BFF_SOURCE_DIR=
if [ -f "$0" ]; then
  BFF_SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
  # Only a bff tree (checkout or extracted release) runs locally: a bare install.py beside a downloaded
  # install.sh may belong to whatever project the current directory is.
  if [ -f "$BFF_SCRIPT_DIR/install.py" ] && [ -f "$BFF_SCRIPT_DIR/bff/cli.py" ] && [ -f "$BFF_SCRIPT_DIR/release-files.json" ]; then
    BFF_SOURCE_DIR=$BFF_SCRIPT_DIR
  fi
fi
if [ -n "$BFF_SOURCE_DIR" ]; then
  BFF_INSTALLER=$BFF_SOURCE_DIR/install.py
else
  command -v curl >/dev/null 2>&1 || { echo 'BFF download needs curl. Install curl with your package manager, then run this installer again.' >&2; exit 1; }
  BFF_RELEASES=${BFF_RELEASE_BASE:-https://github.com/$BFF_REPO/releases}
  case $BFF_RELEASES in
    https://*|file://*) ;;
    *) echo 'BFF_RELEASE_BASE must start with https:// or file://.' >&2; exit 1 ;;
  esac
  if [ -n "${BFF_RELEASE_BASE:-}" ]; then echo "release source: $BFF_RELEASES" >&2; fi
  BFF_STAGE=$(mktemp -d "${TMPDIR:-/tmp}/bff-download.XXXXXXXX")
  trap 'rm -rf "$BFF_STAGE"' EXIT HUP INT TERM
  BFF_BASE="$BFF_RELEASES/download/v$BFF_VERSION"
  BFF_DOWNLOAD_HELP='BFF download failed. Check your network and that github.com is reachable, then run this installer again.'
  curl --fail --silent --show-error --location "$BFF_BASE/bff-$BFF_VERSION.tar.gz" -o "$BFF_STAGE/release.tar.gz" || { echo "$BFF_DOWNLOAD_HELP" >&2; exit 1; }
  curl --fail --silent --show-error --location "$BFF_BASE/SHA256SUMS" -o "$BFF_STAGE/SHA256SUMS" || { echo "$BFF_DOWNLOAD_HELP" >&2; exit 1; }
  python3 - "$BFF_STAGE" "$BFF_VERSION" <<'PY'
import hashlib, pathlib, sys, tarfile
stage, version = pathlib.Path(sys.argv[1]), sys.argv[2]
archive = stage / 'release.tar.gz'
rows = [r.split() for r in (stage / 'SHA256SUMS').read_text().splitlines() if r.strip()]
expected = [r[0] for r in rows if len(r) == 2 and r[1] == 'bff-' + version + '.tar.gz']
if len(expected) != 1 or hashlib.sha256(archive.read_bytes()).hexdigest() != expected[0]:
    raise SystemExit('BFF archive checksum mismatch; installation stopped. Run the installer again; if it keeps failing, download it by hand from https://github.com/triunai/bff/releases.')
root = 'bff-' + version
with tarfile.open(archive, 'r:gz') as tf:
    members = tf.getmembers()
    if len(members) > 5000 or sum(m.size for m in members) > 100 * 1024 * 1024:
        raise SystemExit('BFF archive exceeds bounded release limits. This should not happen with an official release; download it by hand from https://github.com/triunai/bff/releases.')
    seen = set()
    for m in members:
        path = pathlib.PurePosixPath(m.name)
        if (path.is_absolute() or '..' in path.parts or not path.parts or
                path.parts[0] != root or not (m.isfile() or m.isdir()) or
                m.name != path.as_posix() or path.as_posix() in seen):
            raise SystemExit('BFF archive contains an unsafe entry. This should not happen with an official release; download it by hand from https://github.com/triunai/bff/releases.')
        seen.add(path.as_posix())
    for m in members:
        target = stage / m.name
        if m.isdir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(tf.extractfile(m).read())
            target.chmod(0o755 if m.name.endswith('/install.sh') else 0o644)
PY
  BFF_INSTALLER=$BFF_STAGE/bff-$BFF_VERSION/install.py
fi
if [ "$BFF_SETUP" = 0 ]; then
  python3 "$BFF_INSTALLER" "$@"
  exit $?
fi
BFF_RESULT=$(python3 "$BFF_INSTALLER" "$@") || exit $?
printf '%s\n' "$BFF_RESULT"
BFF_COMMAND=$(printf '%s' "$BFF_RESULT" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("command", ""))')
if [ -z "$BFF_COMMAND" ]; then echo '--setup could not find the bff command after installing. Run this installer again without --setup, then run: bff osiris install' >&2; exit 2; fi
# --setup = the installed bff runs `bff osiris install` (the one install-and-update verb, D-128) by its full path.
if [ "$BFF_YES" = 1 ]; then
  if "$BFF_COMMAND" osiris install --yes; then BFF_RC=0; else BFF_RC=$?; fi
else
  if "$BFF_COMMAND" osiris install; then BFF_RC=0; else BFF_RC=$?; fi
fi
if [ "$BFF_RC" = 3 ]; then echo 'bff is installed; Osiris is waiting on the prerequisites listed above. Install them, then run: bff osiris install' >&2; fi
exit "$BFF_RC"
