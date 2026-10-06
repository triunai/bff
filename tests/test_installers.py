"""D7 PATH step, install.sh download path, builder SUMS, release workflow check. No network, no real home."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import install as installer  # noqa: E402


class FakeStdin(io.StringIO):
    def __init__(self, text="", tty=True):
        super().__init__(text)
        self._tty = tty

    def isatty(self):
        return self._tty


class PathStepTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.home = Path(self._tmp.name) / "home"
        self.home.mkdir()
        self.bin = "/opt/example/bin"

    def offer(self, shell="/bin/zsh", answer="\n", tty=True, system="Linux", **flags):
        out = io.StringIO()
        result = installer.offer_path(self.bin, env={"SHELL": shell}, stdin=FakeStdin(answer, tty), out=out,
                                      home=self.home, system=system, **flags)
        return result, out.getvalue()

    def test_rc_file_per_shell(self):
        self.assertEqual(installer.rc_file("/bin/zsh", "Darwin", self.home), self.home / ".zprofile")
        self.assertEqual(installer.rc_file("/bin/bash", "Darwin", self.home), self.home / ".bash_profile")
        self.assertEqual(installer.rc_file("/bin/bash", "Linux", self.home), self.home / ".bashrc")
        self.assertEqual(installer.rc_file("/usr/bin/fish", "Linux", self.home), self.home / ".config" / "fish" / "conf.d" / "bff.fish")
        self.assertEqual(installer.rc_file("/bin/dash", "Linux", self.home), self.home / ".profile")
        self.assertEqual(installer.rc_file("", "Linux", self.home), self.home / ".profile")

    def test_path_line_per_shell_and_spaces(self):
        self.assertEqual(installer.path_line("/bin/zsh", "/opt/x/bin"), 'export PATH="/opt/x/bin:$PATH"')
        self.assertEqual(installer.path_line("/usr/bin/fish", "/opt/x/bin"), "fish_add_path /opt/x/bin")
        self.assertEqual(installer.path_line("/bin/bash", "/opt/my dir/bin"), 'export PATH="/opt/my dir/bin:$PATH"')
        self.assertEqual(installer.path_line("/usr/bin/fish", "/opt/my dir/bin"), "fish_add_path '/opt/my dir/bin'")
        self.assertEqual(installer.path_line("/bin/sh", '/opt/a$b"c/bin'), 'export PATH="/opt/a\\$b\\"c/bin:$PATH"')

    def test_tty_enter_edits_once_and_is_idempotent(self):
        result, out = self.offer()
        rc = self.home / ".zprofile"
        self.assertTrue(result["path_modified"])
        self.assertIn("[Y/n]", out)
        self.assertEqual(rc.read_text(), installer.PATH_MARKER + '\nexport PATH="/opt/example/bin:$PATH"\n')
        again, prompt = self.offer()
        self.assertFalse(again["path_modified"])
        self.assertNotIn("[Y/n]", prompt)
        self.assertEqual(rc.read_text().count(installer.PATH_MARKER), 1)

    def test_append_keeps_existing_content_and_adds_newline(self):
        rc = self.home / ".zprofile"
        rc.write_text("alias a=b")
        self.offer()
        self.assertTrue(rc.read_text().startswith("alias a=b\n" + installer.PATH_MARKER))

    def test_fish_creates_conf_d(self):
        result, _ = self.offer(shell="/usr/bin/fish")
        self.assertTrue(result["path_modified"])
        self.assertIn("fish_add_path /opt/example/bin", (self.home / ".config" / "fish" / "conf.d" / "bff.fish").read_text())

    def test_tty_no_does_not_edit(self):
        result, out = self.offer(answer="n\n")
        self.assertFalse(result["path_modified"])
        self.assertFalse((self.home / ".zprofile").exists())
        self.assertIn('export PATH="/opt/example/bin:$PATH"', out)

    def test_yes_no_modify_and_non_tty_never_edit(self):
        for kwargs in ({"yes": True}, {"no_modify": True}, {"tty": False}):
            result, out = self.offer(**kwargs)
            self.assertFalse(result["path_modified"], kwargs)
            self.assertNotIn("[Y/n]", out)
            self.assertIn(str(self.home / ".zprofile"), result["path_hint"])
            self.assertEqual(list(self.home.iterdir()), [], kwargs)


if __name__ == "__main__":
    unittest.main()
