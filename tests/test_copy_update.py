"""Update, rollback and notice copy: plain words, current and latest versions, one next action."""
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from bff import update, update_notice  # noqa: E402

NOW = datetime(2026, 10, 6, 12, 0, 0, tzinfo=timezone.utc)


class Tty(io.StringIO):
    def isatty(self):
        return True


class DailyPromptCopy(unittest.TestCase):
    def notice(self, stdin, latest="2.0.0"):
        with tempfile.TemporaryDirectory() as tmp:
            out = io.StringIO()
            update_notice.daily_notice(
                current="1.0.0", state_file=Path(tmp) / "state.json", stdin=stdin, out=out, now=NOW, env={},
                latest=lambda base: latest, apply=lambda version, **kw: {"changes": "", "version": version},
                relaunch=lambda: None, prefix=Path(tmp) / "prefix", base="https://example.invalid/releases")
            return out.getvalue()

    def test_prompt_shows_both_versions_and_the_keys(self):
        text = self.notice(Tty("n\n"))
        self.assertIn("bff 2.0.0 is available (you have 1.0.0).", text)
        self.assertIn("Press Enter to update, n to skip", text)
        self.assertIn("[Y/n] ", text)

    def test_broken_check_gives_a_next_action(self):
        out = io.StringIO()
        outcome = update_notice.daily_notice(current="1.0.0", state_file=Path("/nonexistent-dir/x/state.json"),
                                             stdin=Tty(""), out=out, now=NOW, env={},
                                             latest=lambda base: (_ for _ in ()).throw(RuntimeError("boom")))
        self.assertEqual(outcome, "unknown")
        self.assertIn("bff config set update.check false", out.getvalue())


class PluginStepCopy(unittest.TestCase):
    def test_progress_line_comes_before_the_slow_call(self):
        lines = []

        def run(argv, **kwargs):
            lines.append("<ran>")
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
        update.plugin_step(Path("/p"), run=run, which=lambda name: "/fake/bb", out=lines.append)
        self.assertIn("Osiris plugin", lines[0])
        self.assertIn("a few minutes", lines[0])
        self.assertEqual(lines[1], "<ran>")

    def test_unpublished_exit_is_not_a_failure(self):
        lines = []
        outcome = update.plugin_step(Path("/p"), run=lambda argv, **k: subprocess.CompletedProcess(argv, 4, stdout="x\n", stderr=""),
                                     which=lambda name: "/fake/bb", out=lines.append)
        self.assertEqual(outcome, "unpublished")
        self.assertNotIn("failed", " ".join(lines))


class AttestationCopy(unittest.TestCase):
    def test_missing_gh_names_the_two_ways_out(self):
        with self.assertRaises(update.UpdateError) as raised:
            self._missing_gh()
        message = str(raised.exception)
        self.assertIn("https://cli.github.com", message)
        self.assertIn("bff update", message)

    def _missing_gh(self):
        from unittest import mock
        with mock.patch.object(update.shutil, "which", return_value=None):
            update._attest(Path("/x.tar.gz"), "1.0.0", None, True, None)


if __name__ == "__main__":
    unittest.main()
