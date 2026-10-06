"""One version source: every pin must agree with bff/__init__.py, and the rewriter must keep them so."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SDK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SDK / "scripts"))
sys.path.insert(0, str(SDK))

import versioning  # noqa: E402
from bff import __version__  # noqa: E402


def scratch_copy(directory):
    root = Path(directory) / "source"
    shutil.copytree(SDK, root, ignore=shutil.ignore_patterns("node_modules", ".git", "__pycache__", "*.pyc"))
    return root


def expected_pin_files():
    """Every file the versioning tables say carries a version pin."""
    return ({name for name, _, _ in versioning.TEXT_PINS} | {name for name, _ in versioning.JSON_PINS}
            | {versioning.LOCK})


def pinned_files(root):
    """Files where a pin regex actually matched a version (pins() records None for a regex that matched nothing)."""
    return {name for _, name, value in versioning.pins(root) if value is not None}


class VersionSourceTests(unittest.TestCase):
    def test_source_is_a_plain_semver_and_matches_the_import(self):
        self.assertRegex(__version__, versioning.SEMVER.pattern)
        self.assertEqual(versioning.read_version(SDK), __version__)

    def test_every_pin_agrees_with_the_single_source(self):
        # The floor exists to catch "a pin regex matched nothing". It counts DISTINCT pinned FILES,
        # not occurrences: an occurrence count broke when a harmless README edit (6249415, 690e573)
        # left one install URL where there had been two, although every pin still agreed.
        self.assertEqual(pinned_files(SDK), expected_pin_files())
        released = set(json.loads((SDK / "release-files.json").read_text())["files"]) | {"release-files.json"}
        self.assertLessEqual(expected_pin_files() & released, pinned_files(SDK))  # every shipped pin file carries one
        self.assertEqual(versioning.check_pins(SDK), [])
        self.assertIn("/v" + __version__ + "/install.sh", (SDK / "README.md").read_text())

    def test_cli_version_flag_reports_the_source_version(self):
        run = subprocess.run([sys.executable, "-m", "bff", "--version"], cwd=str(SDK), capture_output=True, text=True)
        self.assertEqual(run.stdout.strip(), "bff " + __version__)

    def test_drift_is_detected_in_each_pin(self):
        with tempfile.TemporaryDirectory() as directory:
            root = scratch_copy(directory)
            for name, old, new in (("install.sh", "BFF_VERSION=" + __version__, "BFF_VERSION=9.9.9"),
                                   ("install.py", '__version__ = "' + __version__ + '"', '__version__ = "9.9.9"'),
                                   ("install.ps1", "$BffVersion = '" + __version__ + "'", "$BffVersion = '9.9.9'"),
                                   ("README.md", "bff/v" + __version__ + "/install.sh", "bff/v9.9.9/install.sh")):
                original = (root / name).read_text()
                (root / name).write_text(original.replace(old, new))
                problems = versioning.check_pins(root)
                self.assertTrue(problems and all("9.9.9" in p for p in problems), (name, problems))
                (root / name).write_text(original)
            self.assertEqual(versioning.check_pins(root), [])

    def test_floor_goes_red_when_a_pin_file_loses_its_pin(self):
        # Teeth for the distinct-files floor: a pin regex that matches NOTHING in one file must fail it.
        with tempfile.TemporaryDirectory() as directory:
            root = scratch_copy(directory)
            for name, pin in (("README.md", "bff/v" + __version__ + "/install.sh"),
                              ("install.ps1", "$BffVersion = '" + __version__ + "'")):
                original = (root / name).read_text()
                self.assertIn(pin, original)
                (root / name).write_text(original.replace(pin, "no pin here"))
                self.assertNotIn(name, pinned_files(root))
                self.assertNotEqual(pinned_files(root), expected_pin_files())
                self.assertTrue(versioning.check_pins(root), name)
                (root / name).write_text(original)
            self.assertEqual(pinned_files(root), expected_pin_files())

    def test_apply_version_rewrites_every_pin_and_nothing_else(self):
        with tempfile.TemporaryDirectory() as directory:
            root = scratch_copy(directory)
            lock_before = json.loads((root / "package-lock.json").read_text())
            changed = versioning.apply_version(root, "7.8.9")
            self.assertEqual(versioning.read_version(root), "7.8.9")
            self.assertEqual(versioning.check_pins(root), [])
            self.assertEqual(set(changed), {"bff/__init__.py", "install.py", "install.sh", "install.ps1", "README.md",
                                            "release-files.json", "package.json", "package-lock.json"})
            lock = json.loads((root / "package-lock.json").read_text())
            lock["version"] = lock["packages"][""]["version"] = lock_before["version"]
            self.assertEqual(lock, lock_before)  # dependency versions untouched
            self.assertEqual(versioning.apply_version(root, "7.8.9"), [])  # idempotent
            with self.assertRaises(ValueError):
                versioning.apply_version(root, "1.2")

    def test_release_builder_stamps_the_source_version_and_refuses_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            root = scratch_copy(directory)
            command = [sys.executable, str(root / "scripts" / "build-bff-release.py"), "--output", str(Path(directory) / "out")]
            built = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(built.returncode, 0, built.stderr)
            self.assertTrue((Path(directory) / "out" / ("bff-" + __version__ + ".tar.gz")).is_file())
            (root / "install.sh").write_text((root / "install.sh").read_text().replace("BFF_VERSION=" + __version__, "BFF_VERSION=0.0.1"))
            broken = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(broken.returncode, 0)
            self.assertIn("disagree", broken.stderr)
