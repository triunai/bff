import contextlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bff import cli, herdr
from bff.herdr_observer import FIELDS, record


class HerdrCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="bff capture ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.output = self.root / "nested" / "feed.json"
        self.call = record("claude-transcript", "claude-code", "session-1", "call-1", "Read", 1000)
        self.coverage = {"filesScanned": 2, "discoveryTruncated": False}

    def command(self, arguments):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = cli.main(arguments)
        return result, stdout.getvalue(), stderr.getvalue()

    def test_canonical_secret_stripping_sources_and_timestamps(self):
        call = dict(self.call, prompt="PRIVATE PROMPT", output="PRIVATE OUTPUT", raw="PRIVATE RAW",
                    startedAt=float("inf"), endedAt=True, durationMs=-20)
        data, count = herdr.feed([call], self.coverage, captured_at=100000)
        parsed = json.loads(data)
        self.assertEqual(count, 1)
        self.assertEqual(set(parsed["calls"][0]), set(FIELDS))
        self.assertEqual(len(FIELDS), 15)
        self.assertEqual(parsed["calls"][0]["source"], "claude-transcript")
        self.assertIsNone(parsed["calls"][0]["startedAt"])
        self.assertIsNone(parsed["calls"][0]["endedAt"])
        self.assertIsNone(parsed["calls"][0]["durationMs"])
        self.assertNotIn(b"PRIVATE", data)
        self.assertEqual(parsed["capturedAt"], 100000)
        codex = dict(self.call, source="codex-transcript", provider="codex")
        self.assertEqual(herdr.canonical_call(codex)["source"], "codex-transcript")
        with self.assertRaises(ValueError):
            herdr.feed([dict(self.call, source="herdr-guessed-pane")], self.coverage)
        for timestamp in (-1, float("nan"), herdr.MAX_TIMESTAMP + 1, True):
            with self.assertRaises(ValueError):
                herdr.feed([], self.coverage, captured_at=timestamp)

    def test_opaque_ids_preserved_without_prefix_collisions(self):
        prefix = "x" * 1200
        calls = [dict(self.call, sessionId=prefix + "s", callId=prefix + suffix,
                      parentCallId=prefix + "p", turnId=prefix + "t") for suffix in ("a", "b")]
        data, count = herdr.feed(calls, self.coverage, captured_at=100000)
        captured = json.loads(data)["calls"]
        self.assertEqual(count, 2)
        self.assertEqual({call["callId"] for call in captured}, {prefix + "a", prefix + "b"})
        for call in captured:
            self.assertEqual(call["sessionId"], prefix + "s")
            self.assertEqual(call["parentCallId"], prefix + "p")
            self.assertEqual(call["turnId"], prefix + "t")

    def test_atomic_0600_write_and_failure_preserves_old_feed(self):
        data, _ = herdr.feed([self.call], self.coverage)
        herdr.write_atomic(self.output, data)
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o600)
        self.assertEqual(self.output.read_bytes(), data)
        with mock.patch("bff.herdr.os.replace", side_effect=OSError("injected")):
            with self.assertRaises(OSError):
                herdr.write_atomic(self.output, b'{}\n')
        self.assertEqual(self.output.read_bytes(), data)
        self.assertEqual(list(self.output.parent.glob(".bff-herdr-*")), [])

    def test_bounded_feed_truncates_and_oversize_write_refuses_before_mkdir(self):
        with mock.patch("bff.herdr.MAX_FEED_BYTES", 2048):
            data, count = herdr.feed([dict(self.call, callId=str(number)) for number in range(100)], self.coverage)
            self.assertLessEqual(len(data), 2048)
            self.assertLess(count, 100)
            self.assertTrue(json.loads(data)["coverage"]["discoveryTruncated"])
            with self.assertRaises(ValueError):
                herdr.write_atomic(self.output, b"x" * 2049)
            self.assertFalse(self.output.parent.exists())

    def test_output_and_parent_symlinks_and_traversal_refused(self):
        target = self.root / "target"
        target.write_text("preserve")
        link = self.root / "link.json"
        link.symlink_to(target)
        with self.assertRaises(ValueError):
            herdr.write_atomic(link, b'{}')
        linked_parent = self.root / "linked-parent"
        linked_parent.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            herdr.write_atomic(linked_parent / "feed.json", b'{}')
        with self.assertRaises(ValueError):
            herdr.output_path(self.root / "missing" / ".." / "feed.json")
        self.assertEqual(target.read_text(), "preserve")

    def test_cli_once_exact_session_and_short_output(self):
        with mock.patch("bff.herdr.NativeCollector") as collector:
            collector.return_value.collect.return_value = ([self.call, dict(self.call, sessionId="session-10")], self.coverage)
            result, stdout, stderr = self.command(["herdr", "--once", "--latest", "32", "--session", "session-1", "--output", str(self.output)])
            self.assertEqual(result, 0, stderr)
            collector.assert_called_once_with(latest=32, session="session-1")
            collector.return_value.collect.assert_called_once_with()
            self.assertIn("Captured 1 local provider calls", stdout)
            self.assertIn("not a heartbeat", stdout)
            self.assertLess(len(stdout), 200)
            parsed = json.loads(self.output.read_text())
            self.assertEqual(parsed["kind"], "herdr-provider-capture")
            self.assertEqual(len(parsed["calls"]), 1)
            self.assertGreater(parsed["capturedAt"], 100000)
            self.assertEqual(parsed["coverage"], self.coverage)

    def test_interval_validation_and_clean_ctrl_c(self):
        for arguments in (("--latest", "0"), ("--latest", "33"), ("--interval", "4"), ("--interval", "nan")):
            result, _, _ = self.command(["herdr", "--once", "--output", str(self.output)] + list(arguments))
            self.assertEqual(result, 2)
            self.assertFalse(self.output.exists())
        with mock.patch("bff.herdr.NativeCollector") as collector, mock.patch("bff.herdr.time.sleep", side_effect=KeyboardInterrupt):
            collector.return_value.collect.return_value = ([self.call], self.coverage)
            self.assertEqual(self.command(["herdr", "--output", str(self.output)])[0], 0)
            self.assertTrue(self.output.exists())


if __name__ == "__main__":
    unittest.main()
