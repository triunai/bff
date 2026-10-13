"""Simulated-Windows `bff start`: terminal choice, the herdr-missing install hint and the detached launch."""
import contextlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bff import cli, launch, osiris_tui

WT = "C:\\Users\\Mei\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe"
CMD = "C:\\Windows\\System32\\cmd.exe"
HERDR = "C:\\Tools\\herdr.exe"


def which_of(table):
    return lambda name, policy=None: table.get(name)


class WindowsLaunch(unittest.TestCase):
    def command(self, argv):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = cli.main(argv)
        return result, stdout.getvalue(), stderr.getvalue()

    def start(self, table, argv=("start",)):
        with mock.patch("bff.launch.sys.platform", "win32"), mock.patch("bff.cli.launch_osiris", return_value=0), \
                mock.patch("bff.launch.trusted_bin.which", side_effect=which_of(table)), \
                mock.patch("bff.launch.trusted_bin.popen") as popen, mock.patch("bff.launch.trusted_bin.run") as run:
            result = self.command(list(argv))
        return result, popen, run

    def test_terminal_prefers_windows_terminal_then_cmd(self):
        with mock.patch("bff.launch.sys.platform", "win32"), mock.patch("bff.launch.trusted_bin.which", side_effect=which_of({"wt": WT, "cmd": CMD})):
            self.assertEqual(launch.windows_terminal(), WT)
        with mock.patch("bff.launch.sys.platform", "win32"), mock.patch("bff.launch.trusted_bin.which", side_effect=which_of({"cmd": CMD})):
            self.assertEqual(launch.windows_terminal(), CMD)

    def test_argv_shapes(self):
        self.assertEqual(launch.windows_terminal_argv(WT, [HERDR]), [WT, "new-tab", HERDR])
        self.assertEqual(launch.windows_terminal_argv(CMD, [HERDR, "session", "attach", "w"]), [CMD, "/c", "start", "", HERDR, "session", "attach", "w"])

    def test_herdr_missing_names_the_alternative_and_launches_nothing(self):
        (result, stdout, stderr), popen, run = self.start({"wt": WT, "cmd": CMD})
        self.assertEqual(result, 1)
        self.assertIn("https://herdr.dev/install.ps1", stderr)
        self.assertIn("bff osiris factory", stderr)
        popen.assert_not_called()
        run.assert_not_called()

    def test_wt_launch_is_detached_argv_only_with_the_windows_environment(self):
        (result, stdout, stderr), popen, _ = self.start({"herdr": HERDR, "wt": WT, "cmd": CMD})
        self.assertEqual(result, 0, stderr)
        self.assertEqual(popen.call_args[0][0], [WT, "new-tab", HERDR])
        self.assertEqual(popen.call_args[1]["creationflags"], launch.DETACHED)
        self.assertNotIn("start_new_session", popen.call_args[1])
        self.assertNotIn("shell", popen.call_args[1])
        self.assertIn("SystemRoot", popen.call_args[1]["inherit"])

    def test_cmd_start_is_the_fallback(self):
        (result, _, _), popen, _ = self.start({"herdr": HERDR, "cmd": CMD})
        self.assertEqual(result, 0)
        self.assertEqual(popen.call_args[0][0], [CMD, "/c", "start", "", HERDR])

    def test_print_plan_reports_herdr_available_when_found(self):
        (result, stdout, _), popen, _ = self.start({"herdr": HERDR, "wt": WT, "cmd": CMD}, ("start", "--print-plan"))
        self.assertEqual(result, 0)
        plan = json.loads(stdout)
        self.assertEqual(plan["herdr"]["availability"], "available")
        self.assertEqual(plan["herdr"]["argv"], [HERDR])
        self.assertEqual(plan["herdr"]["terminal"], WT)

    def test_no_terminal_at_all_prints_a_copyable_windows_command(self):
        (result, stdout, _), popen, _ = self.start({"herdr": "C:\\Program Files\\herdr.exe"})
        self.assertEqual(result, 1)
        self.assertIn('Run: "C:\\Program Files\\herdr.exe"', stdout)
        popen.assert_not_called()

    def test_print_plan_works_and_writes_no_launcher_on_windows(self):
        (result, stdout, _), popen, _ = self.start({"herdr": HERDR, "wt": WT}, ("start", "--print-plan"))
        self.assertEqual(result, 0)
        self.assertIn('"launcher": null', stdout)
        self.assertIn("wt.exe", stdout)
        popen.assert_not_called()

    def test_posix_quoting_is_unchanged_off_windows(self):
        with mock.patch("bff.launch.sys.platform", "linux"):
            self.assertEqual(launch.display_command(["/a b/herdr"]), "'/a b/herdr'")
        with mock.patch("bff.launch.sys.platform", "win32"):
            self.assertEqual(launch.display_command([HERDR, "session"]), HERDR + " session")


if __name__ == "__main__":
    unittest.main()
