import contextlib
import io
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bff import cli, launch, trusted_bin


class StartTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="bff launch ")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name).resolve()

    def command(self, argv):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = cli.main(argv)
        return result, stdout.getvalue(), stderr.getvalue()

    def test_print_plan_has_no_writes_browser_or_subprocess(self):
        with mock.patch("bff.launch.Path.home", return_value=self.home), \
                mock.patch("bff.launch.trusted_bin.which", return_value="/fake/herdr"), \
                mock.patch("bff.cli.launch_osiris") as observer, \
                mock.patch("bff.launch.trusted_bin.run") as run:
            result, stdout, stderr = self.command(["start", "--print-plan"])
            self.assertEqual(result, 0, stderr)
            self.assertIn(cli.OSIRIS_URL, stdout)
            self.assertIn('"argv": [\n      "/fake/herdr"\n    ]', stdout)
            self.assertIn('"session": "default"', stdout)
            self.assertEqual(list(self.home.iterdir()), [])
            observer.assert_not_called()
            run.assert_not_called()

    def test_mac_terminal_argv_owned_0700_launcher_and_quoted_executable(self):
        with mock.patch("bff.launch.Path.home", return_value=self.home), \
                mock.patch("bff.launch.sys.platform", "darwin"), \
                mock.patch("bff.launch.trusted_bin.which", return_value="/fake path/herdr"), \
                mock.patch("bff.cli.launch_osiris", return_value=0) as observer, \
                mock.patch("bff.launch.trusted_bin.run", return_value=subprocess.CompletedProcess([], 0)) as run:
            result, stdout, stderr = self.command(["start"])
            self.assertEqual(result, 0, stderr)
            path = self.home / ".local/share/bff/launchers/osiris-herdr.command"
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
            self.assertTrue(path.read_text().endswith("exec '/fake path/herdr'\n"))
            self.assertNotIn("--session", path.read_text())
            observer.assert_called_once_with(cli.OSIRIS_URL, False)
            run.assert_called_once_with(["/usr/bin/open", "-a", "Terminal", str(path)], timeout=10, inherit=trusted_bin.TOOL_INHERIT)
            self.assertIn("startup is unverified", stdout)
            self.assertIn("capture is separate", stdout)

    def test_unrelated_launcher_and_symlinks_refused(self):
        path = self.home / "launch.command"
        path.write_text("user-owned")
        with self.assertRaises(ValueError):
            launch.write_launcher(path, ["/fake/herdr"])
        self.assertEqual(path.read_text(), "user-owned")
        path.unlink()
        path.symlink_to(self.home / "missing")
        with self.assertRaises(ValueError):
            launch.write_launcher(path, ["/fake/herdr"])
        parent = self.home / "linked"
        parent.symlink_to(self.home, target_is_directory=True)
        with self.assertRaises(ValueError):
            launch.write_launcher(parent / "launch.command", ["/fake/herdr"])

    def test_bb_missing_report_and_missing_herdr(self):
        with mock.patch("bff.cli.launch_osiris", side_effect=ConnectionRefusedError("not running")), \
                mock.patch("bff.launch.trusted_bin.which", return_value=None):
            result, stdout, stderr = self.command(["start"])
            self.assertEqual(result, 1)
            self.assertIn("BB observer unavailable", stderr)
            self.assertIn("Herdr executable unavailable", stderr)

    def test_nonmac_detected_terminal_argv_and_unsupported_report(self):
        with mock.patch("bff.launch.sys.platform", "linux"), \
                mock.patch("bff.cli.launch_osiris", return_value=0), \
                mock.patch("bff.launch.trusted_bin.which", side_effect=["/fake/herdr", "/fake/terminal"]), \
                mock.patch("bff.launch.trusted_bin.popen") as popen:
            self.assertEqual(self.command(["start"])[0], 0)
            popen.assert_called_once_with(["/fake/terminal", "-e", "/fake/herdr"], start_new_session=True, inherit=trusted_bin.TOOL_INHERIT)
        with mock.patch("bff.launch.sys.platform", "win32"), \
                mock.patch("bff.cli.launch_osiris", return_value=0), \
                mock.patch("bff.launch.trusted_bin.which", side_effect=["/fake/herdr", None]):
            result, stdout, stderr = self.command(["start"])
            self.assertEqual(result, 1)
            self.assertIn("unsupported", stdout)
            self.assertIn("Run: /fake/herdr", stdout)
            self.assertNotIn("--session", stdout)


if __name__ == "__main__":
    unittest.main()


class DefaultSessionTests(unittest.TestCase):
    def test_default_and_named_session_argv_never_hardcode_osiris(self):
        self.assertEqual(launch.herdr_argv("/h"), ["/h"])
        self.assertEqual(launch.herdr_argv("/h", "work"), ["/h", "session", "attach", "work"])
        self.assertIsNone(launch.herdr_argv(None))
        with mock.patch("bff.launch.trusted_bin.which", return_value="/h"):
            self.assertEqual(launch.launch_plan("u")["herdr"]["argv"], ["/h"])
            self.assertEqual(launch.launch_plan("u", "work")["herdr"]["argv"], ["/h", "session", "attach", "work"])
