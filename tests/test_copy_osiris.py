"""Osiris, rollback, init and help copy: honest, one next action, no internal ids. No network, no real home."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from bff import cli, osiris, state  # noqa: E402
from tests.test_osiris import Fake  # noqa: E402


class StdinNotATty(io.StringIO):
    def isatty(self):
        return False


class UnpublishedCopy(Fake):
    def test_setup_says_nothing_to_install_with_its_own_exit(self):
        code = self.call(osiris.setup, yes=True, compat=self.compat(published=False))
        self.assertEqual(code, 4)
        self.assertIn("Osiris is not publicly released yet; nothing to install", self.output())
        self.assertNotIn("D1", self.output())
        self.assertNotIn("owner decision", self.output())
        self.assertEqual(self.installs(), [])

    def test_update_version_says_the_same(self):
        code = self.call(osiris.update, version="9.9.9", compat=self.compat(published=False))
        self.assertEqual(code, 4)
        self.assertIn("not publicly released yet", self.output())

    def test_missing_prerequisites_stay_exit_3_with_their_own_text(self):
        code = self.call(osiris.setup, yes=True, compat=self.compat(published=False),
                         which=lambda name: None, bb=None, system="Linux")
        self.assertEqual(code, 3)
        self.assertNotIn("not publicly released", self.output())

    def test_plan_says_what_a_missing_optional_tool_is_for(self):
        self.call(osiris.setup, dry_run=True, compat=self.compat(published=False),
                  which=lambda name: None if name == "bd" else "/usr/bin/" + name if name != "bb" else self.bb)
        self.assertIn("needed for the Work tab", self.output())


class RollbackConsent(Fake):
    def record_previous(self):
        self.set_plugins({"id": "tool-observer", "version": "0.2.1", "source": "path:/now", "enabled": True,
                          "status": "running", "sourceDisplay": "path:/now"})
        self.state_file.write_text(json.dumps({"plugin": {"id": "tool-observer", "previous_source": "path:/old"}}))

    def test_non_tty_without_yes_applies_nothing(self):
        self.record_previous()
        for stdin in (StdinNotATty(""), None):
            with self.subTest(stdin=stdin):
                code = self.call(osiris.rollback_plugin, stdin=stdin)
                self.assertEqual(code, 0)
                self.assertEqual(self.installs(), [])
                self.assertIn("no changes made; re-run with --yes to apply", self.output())

    def test_yes_still_applies(self):
        self.record_previous()
        self.install_result(default={"source": "path:/old", "version": "0.2.0"})
        self.assertEqual(self.call(osiris.rollback_plugin, yes=True), 0)
        self.assertEqual(len(self.installs()), 1)


class CliCopy(Fake):
    def command(self, args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                code = cli.main(args)
            except SystemExit as exit_:
                code = exit_.code
        return code, stdout.getvalue(), stderr.getvalue()

    def test_bb_down_names_bb_and_the_url(self):
        self.set_plugins(__import__("tests.test_osiris", fromlist=["entry"]).entry("path:/x", version="0.2.1"))
        with mock.patch("bff.cli.http.client.HTTPConnection") as connection:
            connection.return_value.request.side_effect = ConnectionRefusedError(61, "Connection refused")
            code, _, stderr = self.command(["osiris", "--no-update-check"])
        self.assertEqual(code, 1)
        self.assertIn("BB is not running at " + cli.OSIRIS_URL, stderr)
        self.assertIn("Start BB", stderr)
        self.assertNotIn("Errno", stderr)

    def test_init_ends_with_the_next_steps(self):
        repo = Path(tempfile.mkdtemp(prefix="bff init "))
        self.addCleanup(lambda: __import__("shutil").rmtree(str(repo), ignore_errors=True))
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        code, stdout, stderr = self.command(["init", "--repo", str(repo)])
        self.assertEqual(code, 0, stderr)
        json.loads(stdout)  # stdout stays machine-readable
        self.assertIn("Next: edit hygiene.md, run bff check, then bd init", stderr)

    def test_enabling_auto_update_prints_one_warning(self):
        with mock.patch.object(cli, "active_state_path", return_value=self.state_file):
            code, stdout, stderr = self.command(["config", "set", "update.auto", "true"])
            self.assertEqual(code, 0)
            self.assertIn("update.auto = true", stdout)
            self.assertIn("without asking", stderr)
            self.assertIn("bff config set update.auto false", stderr)
            code, _, stderr = self.command(["config", "set", "update.auto", "false"])
            self.assertEqual((code, stderr), (0, ""))
            code, _, stderr = self.command(["config", "set", "update.check", "true"])
            self.assertEqual((code, stderr), (0, ""))

    def test_config_help_explains_update_auto(self):
        _, stdout, _ = self.command(["config", "--help"])
        self.assertIn("update.auto", stdout)
        self.assertIn("without asking", stdout)
        self.assertIn("gh", stdout)

    def test_herdr_options_all_have_help(self):
        _, stdout, _ = self.command(["herdr", "--help"])
        for option in ("--latest", "--output", "--once", "--session", "--interval"):
            line = next(l for l in stdout.splitlines() if l.strip().startswith(option))
            rest = stdout[stdout.index(line):].split("\n  --", 1)[0]
            self.assertGreater(len(rest.split()), 3, option)
        self.assertNotIn("membership is unknown", stdout)


if __name__ == "__main__":
    unittest.main()
