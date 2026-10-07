"""Installer messages say what happened and the one next action. No network, no real home."""
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import install as installer  # noqa: E402


class InstallShCopyTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.script = self.tmp / "install.sh"  # alone: no install.py beside it, so it takes the download path
        shutil.copy(str(ROOT / "install.sh"), str(self.script))

    def run_sh(self, env_extra=None, path=None):
        env = dict(os.environ, HOME=str(self.tmp), **(env_extra or {}))
        if path:
            env["PATH"] = path
        return subprocess.run(["sh", str(self.script)], capture_output=True, text=True, env=env)

    def test_old_python_prints_what_to_install(self):
        fake = self.tmp / "bin"
        fake.mkdir()
        python = fake / "python3"
        python.write_text("#!/bin/sh\nexit 1\n")
        python.chmod(python.stat().st_mode | stat.S_IEXEC)
        run = self.run_sh(path=str(fake) + os.pathsep + os.environ["PATH"])
        self.assertEqual(run.returncode, 1)
        self.assertIn("Python 3.9 or newer", run.stderr)
        self.assertIn("run this installer again", run.stderr)

    def test_failed_download_names_the_action(self):
        run = self.run_sh({"BFF_RELEASE_BASE": "file://" + str(self.tmp / "nothing-here")})
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("Check your network", run.stderr)
        self.assertIn("run this installer again", run.stderr)

    def test_missing_curl_names_the_action(self):
        self.assertIn("Install curl", (ROOT / "install.sh").read_text())

    def test_setup_exit_messages_are_distinct(self):
        text = (ROOT / "install.sh").read_text()
        self.assertIn('"$BFF_RC" = 3', text)
        self.assertIn('"$BFF_RC" = 4', text)
        self.assertIn("not publicly released yet", text)
        self.assertIn("then run: bff osiris setup", text)
        self.assertNotIn("D1", text)
        self.assertNotIn("activates bff", text)

    def test_extraction_errors_end_with_an_action_in_both_installers(self):
        sh = (ROOT / "install.sh").read_text()
        ps = (ROOT / "install.ps1").read_text()
        for text in (sh, ps):
            self.assertIn("github.com/triunai/bff/releases", text.split("checksum mismatch", 1)[1].split("\n", 1)[0])
            self.assertIn("This should not happen with an official release", text)

    def test_install_py_error_carries_a_next_action(self):
        prefix = self.tmp / "prefix"
        result = subprocess.run([sys.executable, str(ROOT / "install.py"), "--prefix", str(prefix), "--activate", "../bad"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        payload = json.loads(result.stderr)
        self.assertIn("error", payload)
        self.assertIn("run the installer again", payload["next"])


class WindowsPreviewTests(unittest.TestCase):
    def setUp(self):
        self.ps1 = (ROOT / "install.ps1").read_text()

    def test_python_version_failure_has_the_windows_guidance(self):
        self.assertIn("winget install Python.Python.3.12",
                      self.ps1.split("sys.exit(0 if sys.version_info", 1)[1].split("$releases", 1)[0])

    def test_generic_failures_name_the_next_step(self):
        self.assertNotIn("throw 'BFF install failed.'", self.ps1)
        self.assertIn("run this installer again", self.ps1.split("BFF install failed", 1)[1].split("\n", 1)[0])


if __name__ == "__main__":
    unittest.main()
