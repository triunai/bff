"""The once-a-day update notice (D6): rules, prompt, opt-in auto, off switches. No network, no real home."""
import io
import re
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

SDK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SDK))
from bff import state, update_notice

NOW = datetime(2026, 10, 6, 12, 0, 0, tzinfo=timezone.utc)
STAMP = "%Y-%m-%dT%H:%M:%SZ"


class Stdin(io.StringIO):
    def __init__(self, text="", tty=False):
        super().__init__(text)
        self.tty = tty
        self.reads = 0

    def isatty(self):
        return self.tty

    def readline(self, *args):
        self.reads += 1
        return super().readline(*args)

    def read(self, *args):
        self.reads += 1
        return super().read(*args)


class Calls:
    def __init__(self, latest="2.0.0", apply_error=None, changes="changed: 1 file"):
        self.latest_version, self.apply_error, self.changes = latest, apply_error, changes
        self.latest_calls, self.apply_calls, self.relaunches = [], [], 0

    def latest(self, base):
        self.latest_calls.append(base)
        if isinstance(self.latest_version, Exception):
            raise self.latest_version
        return self.latest_version

    def apply(self, version, **kwargs):
        self.apply_calls.append((version, kwargs))
        if self.apply_error:
            raise self.apply_error
        return {"from": "1.0.0", "to": version, "version": version, "attested": True, "changes": self.changes}

    def relaunch(self):
        self.relaunches += 1


class NoticeCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="bff notice ")
        self.addCleanup(self.temporary.cleanup)
        self.state_file = Path(self.temporary.name) / "state.json"
        self.calls = Calls()

    def notice(self, stdin=None, calls=None, env=None, now=NOW, current="1.0.0", **kw):
        calls = calls or self.calls
        out = io.StringIO()
        kw.setdefault("prefix", Path(self.temporary.name) / "prefix")
        kw.setdefault("base", "https://example.invalid/releases")
        outcome = update_notice.daily_notice(
            current=current, state_file=self.state_file, stdin=stdin or Stdin(), out=out, now=now,
            env={} if env is None else env, latest=calls.latest, apply=calls.apply, relaunch=calls.relaunch, **kw)
        return outcome, out.getvalue()

    def configure(self, **values):
        def mutate(data):
            for key, value in values.items():
                state.set_config(data, key.replace("_", "."), value)
        state.update(self.state_file, mutate)

    def check(self):
        return state.load(self.state_file)["update_check"]


class OffSwitchTests(NoticeCase):
    def test_disabled_by_config(self):
        self.configure(update_check="false")
        self.assertEqual(self.notice(), ("disabled", ""))
        self.assertEqual(self.calls.latest_calls, [])

    def test_disabled_by_env(self):
        self.assertEqual(self.notice(env={"BFF_NO_UPDATE_CHECK": "1"}), ("disabled", ""))
        self.assertEqual(self.calls.latest_calls, [])

    def test_env_zero_does_not_disable(self):
        self.assertEqual(self.notice(env={"BFF_NO_UPDATE_CHECK": "0"})[0], "noticed")
        self.assertEqual(len(self.calls.latest_calls), 1)

    def test_relaunch_guard(self):
        self.assertEqual(self.notice(env={"BFF_RELAUNCHED": "1"}), ("not-due", ""))
        self.assertEqual(self.calls.latest_calls, [])
        self.assertFalse(self.state_file.exists())


class DueTests(NoticeCase):
    def test_not_due_after_23_hours_and_due_after_25(self):
        self.notice(now=NOW - timedelta(hours=23))
        self.calls.latest_calls.clear()
        self.assertEqual(self.notice(), ("not-due", ""))
        self.assertEqual(self.calls.latest_calls, [])
        self.assertEqual(self.notice(now=NOW + timedelta(hours=2))[0], "noticed")
        self.assertEqual(len(self.calls.latest_calls), 1)

    def test_due_again_after_25_hours(self):
        self.notice(now=NOW - timedelta(hours=25))
        self.calls.latest_calls.clear()
        self.assertEqual(self.notice()[0], "noticed")
        self.assertEqual(len(self.calls.latest_calls), 1)

    def test_second_same_day_call_is_silent_after_every_outcome(self):
        for latest, tty in (("2.0.0", False), (None, False), ("1.0.0", False), ("2.0.0", True)):
            with self.subTest(latest=latest, tty=tty):
                self.state_file.unlink() if self.state_file.exists() else None
                calls = Calls(latest=latest)
                self.notice(stdin=Stdin("n\n", tty), calls=calls)
                self.assertEqual(self.notice(stdin=Stdin("", tty), calls=calls), ("not-due", ""))
                self.assertEqual(len(calls.latest_calls), 1)


class CheckOutcomeTests(NoticeCase):
    def test_offline_is_silent_and_recorded(self):
        calls = Calls(latest=None)
        self.assertEqual(self.notice(calls=calls), ("unknown", ""))
        record = self.check()
        self.assertEqual((record["checked_at"], record["available"], record["latest"], record["current"]),
                         (NOW.strftime(STAMP), False, None, "1.0.0"))

    def test_same_and_older_remote_are_silent(self):
        for latest in ("1.0.0", "0.9.0"):
            self.state_file.unlink() if self.state_file.exists() else None
            self.assertEqual(self.notice(calls=Calls(latest=latest)), ("no-update", ""))
            self.assertFalse(self.check()["available"])

    def test_numeric_not_lexical_compare(self):
        self.assertEqual(self.notice(calls=Calls(latest="0.10.0"), current="0.9.0")[0], "noticed")
        self.assertTrue(self.check()["available"])

    def test_record_shape_has_all_five_keys(self):
        self.notice()
        self.assertEqual(sorted(self.check()), ["available", "checked_at", "current", "latest", "prompted_on"])

    def test_exception_in_latest_is_unknown_and_one_line(self):
        outcome, text = self.notice(calls=Calls(latest=RuntimeError("boom")))
        self.assertEqual(outcome, "unknown")
        self.assertEqual(text, "update check failed: boom\n")

    def test_corrupt_state_does_not_raise(self):
        self.state_file.write_text("{not json")
        outcome, text = self.notice()
        self.assertEqual(outcome, "unknown")
        self.assertTrue(text.startswith("update check failed: "))


class PromptTests(NoticeCase):
    def test_enter_y_and_capital_y_update(self):
        for answer in ("\n", "y\n", "Y\n", "yes\n"):
            with self.subTest(answer=answer):
                self.state_file.unlink() if self.state_file.exists() else None
                calls = Calls()
                stdin = Stdin(answer, True)
                outcome, text = self.notice(stdin=stdin, calls=calls)
                self.assertEqual(outcome, "updated")
                self.assertEqual(len(calls.apply_calls), 1)
                version, kwargs = calls.apply_calls[0]
                self.assertEqual(version, "2.0.0")
                self.assertFalse(kwargs.get("require_attestation", False))
                self.assertEqual(calls.relaunches, 1)
                self.assertEqual(stdin.reads, 1)
                self.assertIn("bff 2.0.0 is available. Update now? [Y/n] ", text)
                self.assertIn("changed: 1 file", text)
                self.assertIn("undo: bff rollback", text)

    def test_prompted_on_is_recorded(self):
        self.notice(stdin=Stdin("n\n", True))
        self.assertEqual(self.check()["prompted_on"], "2026-10-06")

    def test_no_declines_with_the_off_switch_hint(self):
        outcome, text = self.notice(stdin=Stdin("n\n", True))
        self.assertEqual(outcome, "declined")
        self.assertEqual(self.calls.apply_calls, [])
        self.assertEqual(self.calls.relaunches, 0)
        self.assertIn("Skipped. Run bff update any time; turn this off with: bff config set update.check false\n", text)

    def test_apply_failure_is_noticed_and_does_not_relaunch(self):
        calls = Calls(apply_error=ValueError("checksum mismatch"))
        outcome, text = self.notice(stdin=Stdin("\n", True), calls=calls)
        self.assertEqual(outcome, "noticed")
        self.assertIn("update failed, nothing changed: checksum mismatch", text)
        self.assertEqual(calls.relaunches, 0)

    def test_non_tty_prints_one_line_and_never_reads_stdin(self):
        stdin = Stdin("y\n", False)
        outcome, text = self.notice(stdin=stdin)
        self.assertEqual(outcome, "noticed")
        self.assertEqual(text, "bff 2.0.0 is available (you have 1.0.0): run bff update\n")
        self.assertEqual(stdin.reads, 0)
        self.assertEqual(self.calls.apply_calls, [])


class AutoTests(NoticeCase):
    def test_auto_is_off_by_default(self):
        self.assertEqual(self.notice()[0], "noticed")
        self.assertEqual(self.calls.apply_calls, [])
        self.assertIs(state.get_config(state.load(self.state_file), "update.auto"), False)

    def test_auto_applies_with_attestation_and_prints_undo(self):
        self.configure(update_auto="true")
        stdin = Stdin("", True)
        outcome, text = self.notice(stdin=stdin)
        self.assertEqual(outcome, "auto-updated")
        self.assertEqual(self.calls.apply_calls[0][1]["require_attestation"], True)
        self.assertEqual(self.calls.relaunches, 1)
        self.assertEqual(stdin.reads, 0)
        self.assertNotIn("Update now?", text)
        self.assertEqual(text, "bff updated 1.0.0 -> 2.0.0 automatically.\nchanged: 1 file\nundo: bff rollback\n")

    def test_auto_failure_falls_back_to_the_non_tty_notice(self):
        self.configure(update_auto="true")
        calls = Calls(apply_error=ValueError("no attestation (gh unavailable)"))
        outcome, text = self.notice(calls=calls)
        self.assertEqual(outcome, "auto-failed")
        self.assertEqual(len(calls.apply_calls), 1)
        self.assertEqual(calls.relaunches, 0)
        self.assertEqual(text.splitlines(), ["auto-update skipped: no attestation (gh unavailable)",
                                             "bff 2.0.0 is available (you have 1.0.0): run bff update"])

    def test_auto_failure_falls_back_to_the_tty_prompt(self):
        self.configure(update_auto="true")
        calls = Calls(apply_error=ValueError("no attestation"))
        stdin = Stdin("n\n", True)
        outcome, text = self.notice(stdin=stdin, calls=calls)
        self.assertEqual(outcome, "auto-failed")
        self.assertIn("auto-update skipped: no attestation", text)
        self.assertIn("Update now? [Y/n] ", text)
        self.assertEqual(stdin.reads, 1)


class CannotSelfUpdateTests(NoticeCase):
    def test_prefix_none_prints_the_hint_and_never_applies(self):
        self.configure(update_auto="true")
        outcome, text = self.notice(stdin=Stdin("y\n", True), prefix=None)
        self.assertEqual(outcome, "cannot-self-update")
        self.assertEqual(self.calls.apply_calls, [])
        self.assertIn("bff 2.0.0 is available (you have 1.0.0). This install cannot self-update: ", text)
        self.assertEqual(len(text.splitlines()), 1)


class NoPipeToShellTests(unittest.TestCase):
    def test_no_pipe_into_a_shell_anywhere_in_bff(self):
        pattern = re.compile(r"\|\s*(sh|bash|zsh)\b|\biex\b")
        hits = [str(path.relative_to(SDK)) + ":" + str(number)
                for path in (SDK / "bff").rglob("*.py")
                for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
                if pattern.search(line)]
        self.assertEqual(hits, [])


if __name__ == "__main__":
    unittest.main()
