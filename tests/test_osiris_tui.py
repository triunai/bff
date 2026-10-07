import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bff import cli, osiris_tui


class OsirisTuiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="bff tui ")
        self.addCleanup(self.temporary.cleanup)
        self.plugin = Path(self.temporary.name).resolve() / "plugin dir"
        (self.plugin / "bin").mkdir(parents=True)
        (self.plugin / "bin" / "osiris-tui.mjs").write_text("// stub\n")

    def run_cli(self, argv, env=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {"OSIRIS_PLUGIN_DIR": str(self.plugin), **(env or {})}), \
                mock.patch("bff.osiris_tui.shutil.which", side_effect=lambda name: "/fake/" + name), \
                mock.patch("bff.osiris_tui.subprocess.run", return_value=subprocess.CompletedProcess([], 0)) as run, \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = cli.main(argv)
        return code, run, stdout.getvalue(), stderr.getvalue()

    def test_factory_runs_node_on_the_plugin_script_with_argv_only(self):
        repo = Path(self.temporary.name).resolve()
        code, run, _, _ = self.run_cli(["osiris", "factory", "--repo", str(repo), "--no-color"])
        self.assertEqual(code, 0)
        run.assert_called_once_with(["/fake/node", str(self.plugin / "bin" / "osiris-tui.mjs"), "factory", "--repo", str(repo), "--no-color"])

    def test_worktrees_passes_its_flags_through_and_nothing_else(self):
        repo = Path(self.temporary.name).resolve()
        _, run, _, _ = self.run_cli(["osiris", "worktrees", "--repo", str(repo), "--all", "--once", "--cols", "80", "--interval", "7.0"])
        self.assertEqual(run.call_args[0][0], ["/fake/node", str(self.plugin / "bin" / "osiris-tui.mjs"), "worktrees", "--repo", str(repo), "--all", "--once", "--cols", "80", "--interval", "7.0"])
        self.assertNotIn("shell", run.call_args[1])

    def test_repo_defaults_to_the_current_directory(self):
        _, run, _, _ = self.run_cli(["osiris", "factory"])
        self.assertEqual(run.call_args[0][0][4], str(Path.cwd().resolve()))

    def test_exit_code_of_the_app_is_returned(self):
        with mock.patch.dict(os.environ, {"OSIRIS_PLUGIN_DIR": str(self.plugin)}), \
                mock.patch("bff.osiris_tui.shutil.which", return_value="/fake/node"), \
                mock.patch("bff.osiris_tui.subprocess.run", return_value=subprocess.CompletedProcess([], 3)):
            self.assertEqual(cli.main(["osiris", "factory"]), 3)

    def test_unknown_app_is_refused_by_the_parser(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            cli.main(["osiris", "rm"])

    def test_the_url_flow_is_unchanged_without_an_app_name(self):
        stdout = io.StringIO()
        with mock.patch("bff.cli.launch_osiris", return_value=0) as observer, contextlib.redirect_stdout(stdout):
            self.assertEqual(cli.main(["osiris", "--print-url"]), 0)
        observer.assert_called_once_with(cli.OSIRIS_URL, True, False)

    def test_locate_prefers_the_env_dir_then_the_installed_plugin_and_reads_bb_plugin_list(self):
        listing = "bb-ai@0.1.0  running\n  source: builtin:bb-ai\ntool-observer@0.2.15  running\n  source: path:" + str(self.plugin) + "\n  handlers: 3 calls\n"
        with mock.patch.dict(os.environ, {}, clear=False), mock.patch("bff.osiris_tui.shutil.which", return_value="/fake/bb"), \
                mock.patch("bff.osiris_tui.subprocess.run", return_value=subprocess.CompletedProcess([], 0, stdout=listing)) as run:
            os.environ.pop("OSIRIS_PLUGIN_DIR", None)
            self.assertEqual(osiris_tui.locate_plugin(), self.plugin)
        self.assertEqual(run.call_args[0][0], ["/fake/bb", "plugin", "list"])

    def test_a_plugin_without_the_script_is_not_used(self):
        empty = Path(self.temporary.name) / "old"
        empty.mkdir()
        with mock.patch.dict(os.environ, {"OSIRIS_PLUGIN_DIR": str(empty)}), mock.patch("bff.osiris_tui.installed_plugin_dir", return_value=None), \
                mock.patch("bff.osiris_tui.Path.resolve", side_effect=lambda self=None: Path("/nonexistent/bff/osiris_tui.py")):
            with self.assertRaises(ValueError):
                osiris_tui.locate_plugin()

    def test_missing_node_is_a_clear_error(self):
        with mock.patch("bff.osiris_tui.shutil.which", return_value=None):
            with self.assertRaises(ValueError):
                osiris_tui.build_argv("factory", self.plugin, mock.Mock(repo=None, all=False, no_color=False, once=False, cols=None, interval=None))


if __name__ == "__main__":
    unittest.main()
