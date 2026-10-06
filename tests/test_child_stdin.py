"""Every child whose output bff captures gets stdin=DEVNULL.

A captured child that inherits the terminal can wait on a question nobody can see (its output is
captured), or swallow an answer the user typed for bff. Found in a real pty: `bff doctor` sat silent
for its 10 s version timeout behind a tool that read stdin, and an update's plugin step sat 30 s
twice behind `bb plugin list`. Unit tests never have a TTY on stdin, so they pin the argument instead.
"""
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from bff import doctor, osiris, update


class Done:
    returncode = 0
    stdout = '{"plugins": []}'
    stderr = ""


class CapturedChildStdinTests(unittest.TestCase):
    def assert_devnull(self, calls):
        self.assertTrue(calls, "no child was started")
        for argv, kwargs in calls:
            self.assertIs(kwargs.get("stdin"), subprocess.DEVNULL, argv)

    def recorder(self, calls):
        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            return Done()
        return run

    def test_doctor_version_and_registry_queries(self):
        calls = []
        with mock.patch.object(doctor.subprocess, "run", self.recorder(calls)):
            doctor._run(["/fake/tool", "--version"], 1)
        self.assert_devnull(calls)

    def test_osiris_plugin_list_and_tool_versions(self):
        calls = []
        osiris.plugin_status("/fake/bb", run=self.recorder(calls))
        osiris._tool_version(["/fake/node", "--version"], self.recorder(calls))
        self.assert_devnull(calls)

    def test_update_attestation(self):
        calls = []
        with mock.patch.object(update.subprocess, "run", self.recorder(calls)):
            update._attest(Path("/fake/bff-9.9.9.tar.gz"), "9.9.9", "/fake/gh", False, lambda line: None)
        self.assert_devnull(calls)

    def test_update_plugin_step(self):
        calls = []
        update.plugin_step("/fake/prefix", run=self.recorder(calls), which=lambda name: "/fake/bb",
                           out=lambda line: None)
        self.assert_devnull(calls)


if __name__ == "__main__":
    unittest.main()
