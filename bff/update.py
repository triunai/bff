"""Verified self-update and rollback for bff itself (the script install under `<prefix>/share/bff`).

`apply_update` runs, in order: download, checksum, attestation, safe extract, manifest check plus
staging (the new release's own `install.py --stage-only`), smoke test, then the flip (the new
release's `install.py --activate`), and only then writes state. Any failure before the flip leaves
the `bin/bff` symlink, the state file and the release set exactly as they were.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

from . import paths, state
from .prompt import answer_is_yes

DEFAULT_BASE = "https://github.com/triunai/bff/releases"
REPO = "triunai/bff"
WORKFLOW = "triunai/bff/.github/workflows/release.yml"
SEMVER = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
# O1 safe default: with gh, attestation is REQUIRED (a refusal is fatal); without gh the swap is checksum-only, and
# that is said loudly with the way out, never silently.
NO_ATTESTATION = ("WARNING: authenticity NOT checked (gh is not installed): the SHA256 checksum proves the file is "
                  "intact, not who built it. To verify provenance from now on, install gh: bff osiris doctor "
                  "offers it (or https://cli.github.com).")
MAX_MEMBERS = 5000
MAX_BYTES = 100 * 1024 * 1024
MAX_SUMS = 1024 * 1024
MAX_CHANGE_LINES = 15


class UpdateError(ValueError):
    """An update or rollback step failed; nothing was switched unless the message says so."""


def release_base(env=None):
    env = os.environ if env is None else env
    base = env.get("BFF_RELEASE_BASE")
    if not base:
        return DEFAULT_BASE
    if not base.startswith(("https://", "file://")):
        raise ValueError("BFF_RELEASE_BASE must start with https:// or file://")
    return base.rstrip("/")


def _emit(out, line):
    if out is None:
        print(line)
    elif hasattr(out, "write"):
        out.write(line + "\n")
    else:
        out(line)


def _read_url(url, limit, timeout, opener):
    with opener(url, timeout=timeout) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise UpdateError("download too large: " + url)
    return data


def _sums_lines(text, suffix):
    rows = [line.split() for line in text.splitlines() if line.strip()]
    return [row for row in rows if len(row) == 2 and row[1].endswith(suffix)]


def latest_version(base, *, timeout=3, opener=urllib.request.urlopen):
    """The X.Y.Z named by `<base>/latest/download/SHA256SUMS`, or None on any failure. Never raises."""
    try:
        text = _read_url(base + "/latest/download/SHA256SUMS", MAX_SUMS, timeout, opener).decode("utf-8")
        rows = _sums_lines(text, ".tar.gz")
        if len(rows) != 1 or not re.fullmatch(r"[0-9a-f]{64}", rows[0][0]):
            return None
        match = re.fullmatch(r"bff-(" + SEMVER.pattern + r")\.tar\.gz", rows[0][1])
        return match.group(1) if match else None
    except Exception:  # offline, 404, malformed: all mean "unknown"
        return None


def _download(url, dest, limit, timeout, opener):
    try:
        dest.write_bytes(_read_url(url, limit, timeout, opener))
    except UpdateError:
        raise
    except Exception as error:
        raise UpdateError("download failed: " + url + " (" + str(error) + ")")


def safe_extract(archive, dest, root):
    """Python port of install.sh's entry checks, then extract regular files and dirs under `dest/root`."""
    dest = Path(dest)
    try:
        with tarfile.open(str(archive), "r:gz") as tf:
            members = tf.getmembers()
            if len(members) > MAX_MEMBERS or sum(m.size for m in members) > MAX_BYTES:
                raise UpdateError("archive exceeds bounded release limits")
            seen = set()
            for m in members:
                posix = m.name
                pure = PurePosixPath(posix)
                if (pure.is_absolute() or ".." in pure.parts or not pure.parts or pure.parts[0] != root
                        or not (m.isfile() or m.isdir()) or posix != pure.as_posix() or posix in seen):
                    raise UpdateError("archive contains an unsafe entry: " + repr(m.name))
                seen.add(posix)
            base = dest.resolve()
            for m in members:
                target = dest / m.name
                if base not in target.resolve().parents and target.resolve() != base:
                    raise UpdateError("archive entry escapes the extraction directory")
                if m.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(tf.extractfile(m).read())
                    target.chmod(0o755 if m.name.endswith("/install.sh") else 0o644)
    except UpdateError:
        raise
    except (tarfile.TarError, EOFError, OSError, ValueError) as error:
        raise UpdateError("archive could not be read safely: " + str(error))
    extracted = dest / root
    if not extracted.is_dir():
        raise UpdateError("archive has no " + root + " directory")
    return extracted


def _active_id(prefix):
    link = Path(prefix) / "bin" / "bff"
    if not link.is_symlink():
        return None
    target = Path(os.path.abspath(str(link.parent / os.readlink(str(link)))))
    return target.parent.parent.name if paths.RELEASE_NAME.fullmatch(target.parent.parent.name) else None


def _verify_checksum(tarball, sums_path, name):
    rows = _sums_lines(sums_path.read_text(encoding="utf-8", errors="replace"), name)
    rows = [row for row in rows if row[1] == name]
    actual = hashlib.sha256(tarball.read_bytes()).hexdigest()
    if len(rows) != 1 or rows[0][0].lower() != actual:
        raise UpdateError("checksum mismatch for " + name + "; nothing was changed")


def _attest(tarball, version, gh, require, out):
    gh = shutil.which("gh") if gh is None else gh
    if not gh:
        if require:
            raise UpdateError("attestation required but gh is not installed; nothing was changed. Install gh "
                              "(https://cli.github.com) or run bff update without --require-attestation "
                              "(for auto-update: bff config set update.auto false)")
        _emit(out, NO_ATTESTATION)
        return False
    command = [str(gh), "attestation", "verify", str(tarball), "-R", REPO, "--signer-workflow", WORKFLOW,
               "--source-ref", "refs/tags/v" + version]
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                universal_newlines=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise UpdateError("attestation failed: " + str(error) + "; nothing was changed")
    if result.returncode:
        raise UpdateError("attestation failed (exit " + str(result.returncode) + "): "
                          + (result.stderr or result.stdout).strip()[-300:] + "; nothing was changed")
    return True


def _run_installer(python, installer, prefix, flag, value=None):
    command = [str(python), str(installer), "--prefix", str(prefix), flag] + ([value] if value else [])
    try:
        # stdin=DEVNULL: the installer must never wait on a question nobody can see (its D7 PATH
        # offer prompts when stdin is a TTY, and its stderr is captured here).
        result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                universal_newlines=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise UpdateError("installer could not run: " + str(error))
    if result.returncode:
        raise UpdateError("installer refused the release: " + (result.stderr or result.stdout).strip()[-300:])
    return result.stdout


def _smoke_version(launcher):
    result = subprocess.run([str(launcher), "--version"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, universal_newlines=True, timeout=30)
    return result.stdout.strip() if result.returncode == 0 else None


def _smoke(staged, version):
    try:
        found = _smoke_version(staged / "bin" / "bff")
    except (OSError, subprocess.TimeoutExpired) as error:
        raise UpdateError("smoke test failed: " + str(error))
    if found != "bff " + version:
        raise UpdateError("smoke test failed: expected 'bff " + version + "', got " + repr(found))


def _changes(extracted, version):
    try:
        lines = (extracted / "CHANGELOG.md").read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        return ""
    heading = re.compile(r"##\s*\[" + re.escape(version) + r"\]")
    for index, line in enumerate(lines):
        if heading.match(line):
            section = []
            for follow in lines[index:]:
                if section and follow.startswith("## ["):
                    break
                section.append(follow)
            return "\n".join(section[:MAX_CHANGE_LINES]).rstrip()
    return ""


def _record(state_file, old, new, version):
    def mutate(data):
        node = data.get("bff") if isinstance(data.get("bff"), dict) else {}
        node["previous"] = old if old and old != new else node.get("previous")
        node["active"] = new
        data["bff"] = node
        data["method"] = "script"
        check = data.get("update_check") if isinstance(data.get("update_check"), dict) else {}
        check["current"] = version
        check["available"] = False
        data["update_check"] = check
    state.update(state_file, mutate)


def apply_update(version, *, prefix, base, require_attestation=False, gh=None, out=None, python=None):
    if not SEMVER.fullmatch(version or ""):
        raise UpdateError("not a plain X.Y.Z version: " + repr(version))
    prefix = Path(prefix)
    python = python or sys.executable
    name = "bff-" + version + ".tar.gz"
    url = base + "/download/v" + version + "/"
    state_file = Path(str(paths.state_path(prefix=prefix)))
    old = _active_id(prefix)
    work = Path(tempfile.mkdtemp(prefix="bff-update-"))
    staged, created, flipped = None, False, False
    try:
        tarball, sums = work / name, work / "SHA256SUMS"
        _download(url + name, tarball, MAX_BYTES + 1024 * 1024, 60, urllib.request.urlopen)
        _download(url + "SHA256SUMS", sums, MAX_SUMS, 15, urllib.request.urlopen)
        _verify_checksum(tarball, sums, name)
        _emit(out, "ok: checksum verified")
        attested = _attest(tarball, version, gh, require_attestation, out)
        if attested:
            _emit(out, "ok: attestation verified")
        extracted = safe_extract(tarball, work / "x", "bff-" + version)
        _emit(out, "ok: archive entries are safe")
        installer = extracted / "install.py"
        if not installer.is_file():
            raise UpdateError("release has no install.py; refusing to update")
        info = json.loads(_run_installer(python, installer, prefix, "--stage-only"))
        new = info.get("release") if isinstance(info, dict) else None
        if (not isinstance(new, str) or not paths.RELEASE_NAME.fullmatch(new)
                or not new.startswith(version + "-")):
            raise UpdateError("installer reported an unexpected release id: " + repr(new))
        created = info.get("created") is True
        staged = Path(str(paths.releases_dir(prefix=prefix))) / new
        _emit(out, "ok: manifest verified and release staged")
        _smoke(staged, version)
        _emit(out, "ok: smoke test passed")
        try:
            _run_installer(python, installer, prefix, "--activate", new)
        finally:
            # The installer may have swapped the link and then failed: trust the link, not the call.
            flipped = _active_id(prefix) == new
        _record(state_file, old, new, version)
        _emit(out, "ok: switched to " + new)
        return {"from": old, "to": new, "version": version, "attested": attested,
                "changes": _changes(extracted, version)}
    except BaseException as error:
        restored = False
        if flipped and old:
            try:
                _run_installer(python, work / "x" / ("bff-" + version) / "install.py", prefix, "--activate", old)
                restored = True
            except Exception:
                pass
        # Never delete the release the command link may still point at.
        if staged is not None and created and (not flipped or restored):
            shutil.rmtree(str(staged), ignore_errors=True)
        if isinstance(error, (json.JSONDecodeError, subprocess.SubprocessError)):
            raise UpdateError("update failed: " + str(error))
        raise
    finally:
        shutil.rmtree(str(work), ignore_errors=True)


def plugin_step(prefix, *, run=subprocess.run, which=None, out=None):
    """Update the Osiris plugin with the NEW bff. Never raises: bff itself is already updated."""
    if (which or shutil.which)("bb") is None:
        _emit(out, "Osiris plugin: skipped (BB not found)")
        return "skipped"
    # `osiris update` is the hidden alias of `osiris install` that every bff since 0.1.1 understands, so this
    # also works when --version moved to an older bff. SKIP_SELF: bff itself was just switched; only the plugin.
    argv = [str(Path(prefix) / "bin" / "bff"), "osiris", "update", "--yes"]
    env = dict(os.environ)
    env["BFF_SKIP_SELF_UPDATE"] = "1"
    _emit(out, "Updating the Osiris plugin with the new bff (a first build can take a few minutes)...")
    try:
        # Streamed, not captured: a long fetch/build shows its progress. stdin=DEVNULL: --yes asks nothing, and
        # nothing may wait on the terminal.
        done = run(argv, stdin=subprocess.DEVNULL, env=env, timeout=1800)
        code = done.returncode
    except Exception:
        code = None
    if code == 0:
        return "ok"
    if code == 3:
        return "waiting"
    if code == 4:
        return "unpublished"
    _emit(out, "Osiris plugin update failed (bff itself is updated). Retry: bff osiris install")
    return "failed"


def apply_with_plugin(version, **kwargs):
    """`apply_update`, then the plugin step; a bff failure raises before the plugin step is reached."""
    result = apply_update(version, **kwargs)
    result["plugin"] = plugin_step(kwargs["prefix"], out=kwargs.get("out"))
    return result


def _load_installer():
    path = Path(__file__).resolve().parents[1] / "install.py"
    if not path.is_file():
        return None
    spec = importlib.util.spec_from_file_location("bff_running_installer", str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _fallback_target(releases, current, installer):
    candidates = []
    for entry in releases.iterdir() if releases.is_dir() else []:
        if entry.name != current and paths.RELEASE_NAME.fullmatch(entry.name) and not entry.is_symlink():
            try:
                installer.verify_release(entry)
            except (ValueError, OSError, KeyError, TypeError):
                continue
            candidates.append((entry.stat().st_mtime, entry.name))
    return max(candidates)[1] if candidates else None


def rollback(*, prefix, state_file, yes=False, stdin=None, out=None):
    """Switch back to `bff.previous` (or the newest other verified release). Running it twice toggles."""
    prefix = Path(prefix)
    installer = _load_installer()
    current = _active_id(prefix)
    data = state.load(state_file)
    node = data.get("bff") if isinstance(data.get("bff"), dict) else {}
    releases = Path(str(paths.releases_dir(prefix=prefix)))
    target, source = node.get("previous"), "recorded previous release"
    if installer is None:
        guess = target if isinstance(target, str) and paths.RELEASE_NAME.fullmatch(target) else "<release id>"
        raise UpdateError("the running bff has no install.py to switch releases; run: python3 "
                          + str(releases / guess / "install.py") + " --prefix " + str(prefix)
                          + " --activate " + guess)
    try:
        if not isinstance(target, str) or target == current or not paths.RELEASE_NAME.fullmatch(target):
            raise ValueError(target)
        installer.verify_release(releases / target)
    except (ValueError, OSError, KeyError, TypeError):
        target = None
    if target is None:
        target, source = _fallback_target(releases, current, installer), "newest other release found on disk"
    if target is None:
        raise UpdateError("no other verified release to roll back to")
    _emit(out, "rollback: " + str(current) + " -> " + target + " (" + source + ")")
    stdin = sys.stdin if stdin is None else stdin
    if not yes:
        if not stdin.isatty():
            _emit(out, "no changes made; re-run with --yes to apply")
            return {"from": current, "to": target, "changed": False}
        _emit(out, "Roll back bff " + str(current) + " -> " + target + "? [Y/n] ")
        if not answer_is_yes(stdin.readline()):
            _emit(out, "cancelled")
            return {"from": current, "to": target, "changed": False}
    try:
        installer.activate(releases / target, prefix)
    except (ValueError, OSError) as error:
        raise UpdateError("rollback failed: " + str(error) + "; manual fallback: python3 "
                          + str(releases / target / "install.py") + " --prefix " + str(prefix) + " --activate " + target)

    def mutate(doc):
        entry = doc.get("bff") if isinstance(doc.get("bff"), dict) else {}
        entry["active"], entry["previous"] = target, current
        doc["bff"] = entry
        doc["method"] = "script"
    state.update(state_file, mutate)
    _emit(out, "ok: rolled back to " + target)
    return {"from": current, "to": target, "changed": True}
