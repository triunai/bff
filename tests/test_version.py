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


class VersionSourceTests(unittest.TestCase):
    def test_source_is_a_plain_semver_and_matches_the_import(self):
        self.assertRegex(__version__, versioning.SEMVER.pattern)
        self.assertEqual(versioning.read_version(SDK), __version__)

    def test_every_pin_agrees_with_the_single_source(self):
        found = versioning.pins(SDK)
        self.assertGreaterEqual(len(found), 8, found)  # a pin regex that matches nothing must not pass silently
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
                                   ("README.md", "bff/v" + __version__ + "/install.sh", "bff/v9.9.9/install.sh")):
                original = (root / name).read_text()
                (root / name).write_text(original.replace(old, new))
                problems = versioning.check_pins(root)
                self.assertTrue(problems and all("9.9.9" in p for p in problems), (name, problems))
                (root / name).write_text(original)
            self.assertEqual(versioning.check_pins(root), [])

    def test_apply_version_rewrites_every_pin_and_nothing_else(self):
        with tempfile.TemporaryDirectory() as directory:
            root = scratch_copy(directory)
            lock_before = json.loads((root / "package-lock.json").read_text())
            changed = versioning.apply_version(root, "7.8.9")
            self.assertEqual(versioning.read_version(root), "7.8.9")
            self.assertEqual(versioning.check_pins(root), [])
            self.assertEqual(set(changed), {"bff/__init__.py", "install.py", "install.sh", "README.md",
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
