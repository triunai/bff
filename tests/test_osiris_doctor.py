"""`bff osiris doctor`: each check says WHY and gives one next action; nothing changes; exit 1 only on a failure."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SDK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SDK))
from bff import osiris, osiris_doctor  # noqa: E402

COMPAT = {"schema_version": 1, "bb_min": "0.45.0",
          "osiris": {"id": "tool-observer", "version": "0.3.0", "source": "git:x@v0.3.0", "commit": None,
                     "published": False,
                     "private": {"repo": "o/p", "ref": "a" * 40, "version": "0.2.16-dev", "label": "rc"}}}


class Machine:
    """Fake which() + run(); records every argv so a test can prove nothing mutating ran."""

    def __init__(self, tools=("bb", "herdr", "bd", "git", "gh", "bff"), plugin=None, herdr_running=True, terminals=1,
                 machines=None):
        self.tools = set(tools)
        self.plugin = plugin if plugin is not None else {"id": "tool-observer", "version": "0.2.16-dev", "enabled": True,
                                                         "status": "running", "source": "path:/somewhere/dev"}
        self.herdr_running = herdr_running
        self.terminals = terminals
        self.machines = machines if machines is not None else [{"id": "host_1", "status": "connected"}]
        self.argvs = []

    def which(self, name):
        return "/fake/bin/" + name if name in self.tools else None

    def run(self, argv, **kwargs):
        self.argvs.append(list(argv))
        assert kwargs.get("stdin") is subprocess.DEVNULL, argv
        name, rest = Path(argv[0]).name, list(argv[1:])
        out, code = "", 0
        if rest == ["--version"]:
            out = "0.45.0" if name == "bb" else "1.0.0"
        elif rest[:3] == ["plugin", "list", "--json"]:
            out = json.dumps({"plugins": [self.plugin] if self.plugin else []})
        elif rest[:2] == ["status", "server"]:
            out = json.dumps({"running": self.herdr_running, "version": "0.9.3"})
        elif rest[:2] == ["machine", "list"]:
            out = json.dumps(self.machines)
        elif rest[:2] == ["terminal", "list"]:
            out = json.dumps({"sessions": [{"id": "t", "status": "running"}] * self.terminals})
        elif rest[:1] == ["ls-remote"] or "ls-remote" in rest:
            code = 0
        else:
            code = 1
        return subprocess.CompletedProcess(argv, code, stdout=out, stderr="")


class DoctorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="bff doctor ")
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.feed = self.home / "feed.json"
        self.bb_up = mock.patch("bff.osiris_doctor.http.client.HTTPConnection")
        self.connection = self.bb_up.start()
        self.addCleanup(self.bb_up.stop)
        env = mock.patch.dict(os.environ, {"HOME": str(self.home), "BFF_PREFIX": str(self.home / "prefix")})
        env.start()
        self.addCleanup(env.stop)

    def checks(self, machine, **kw):
        kw.setdefault("system", "Darwin")
        kw.setdefault("offline", True)
        trusted = self.home / ".local" / "bin" / "herdr"
        trusted.parent.mkdir(parents=True, exist_ok=True)
        if "herdr" in machine.tools and not trusted.exists():
            trusted.write_text("#!/bin/sh\n")
            trusted.chmod(0o755)
        rows = osiris_doctor.run_checks(run=machine.run, which=machine.which, env={}, compat=COMPAT, home=self.home,
                                        feed=self.feed, now=1000.0, staging_root=str(self.home / "none"),
                                        builds_root=str(self.home / "builds"),
                                        herdr_paths=["/opt/homebrew/bin/herdr-absent", str(trusted)], **kw)
        return {r["check"]: r for r in rows}, rows

    def test_every_check_only_looks(self):
        machine = Machine()
        self.checks(machine)
        verbs = {tuple(a[1:3]) for a in machine.argvs}
        self.assertFalse({("plugin", "install"), ("plugin", "build"), ("plugin", "remove")} & verbs, machine.argvs)

    def test_no_bb_fails_with_the_install_line(self):
        rows, all_rows = self.checks(Machine(tools=("herdr",)))
        self.assertEqual(rows["BB"]["status"], "FAIL")
        self.assertIn("npx bb-app@latest", rows["BB"]["fix"])
        out = io.StringIO()
        osiris_doctor.render(all_rows, out)
        self.assertIn("Next: install BB: npx bb-app@latest", out.getvalue())

    def test_bb_not_answering_is_a_failure(self):
        self.connection.return_value.request.side_effect = ConnectionRefusedError("down")
        rows, _ = self.checks(Machine())
        self.assertEqual(rows["BB running"]["status"], "FAIL")

    def test_dev_plugin_is_ok_and_missing_plugin_says_install(self):
        rows, _ = self.checks(Machine())
        self.assertEqual(rows["Osiris plugin"]["status"], "ok")
        rows, _ = self.checks(Machine(plugin={}))
        self.assertEqual((rows["Osiris plugin"]["status"], rows["Osiris plugin"]["fix"]), ("FAIL", "bff osiris install"))

    def test_herdr_off_the_trusted_paths_explains_why_the_terminal_cannot_find_it(self):
        rows, _ = self.checks(Machine(tools=("bb",)))
        self.assertEqual(rows["Herdr"]["status"], "warn")  # not installed at all
        machine = Machine(tools=("bb", "herdr"))  # on PATH, but only at /fake/bin, which Osiris does not trust
        found = osiris_doctor.run_checks(run=machine.run, which=machine.which, env={}, compat=COMPAT, home=self.home,
                                         feed=self.feed, now=1000.0, system="Darwin", offline=True,
                                         staging_root=str(self.home / "none"), builds_root=str(self.home / "builds"),
                                         herdr_paths=[str(self.home / "absent" / "herdr")])
        row = next(r for r in found if r["check"] == "Herdr")
        self.assertEqual(row["status"], "FAIL")
        self.assertIn("Osiris only trusts", row["detail"])
        self.assertIn("ln -s /fake/bin/herdr " + str(self.home / ".local" / "bin" / "herdr"), row["fix"])

    def test_capture_freshness(self):
        self.feed.write_text(json.dumps({"capturedAt": 990 * 1000}))
        rows, _ = self.checks(Machine())
        self.assertEqual(rows["Herdr capture"]["status"], "ok")
        self.feed.write_text(json.dumps({"capturedAt": 0}))
        rows, _ = self.checks(Machine())
        self.assertEqual(rows["Herdr capture"]["status"], "warn")
        self.assertIn("bff herdr", rows["Herdr capture"]["fix"])

    def test_no_bb_terminal_is_why_the_osiris_terminal_is_empty(self):
        rows, _ = self.checks(Machine(terminals=0))
        row = rows["BB terminals"]
        self.assertEqual(row["status"], "warn")
        self.assertIn("Herdr is running outside BB, which Osiris cannot attach", row["detail"])
        self.assertIn("open a terminal in BB, run `herdr` in it", row["fix"])
        rows, _ = self.checks(Machine(terminals=2))
        self.assertEqual(rows["BB terminals"]["status"], "ok")
        rows, _ = self.checks(Machine(machines=[]))
        self.assertEqual(rows["BB terminals"]["status"], "FAIL")

    def test_windows_and_wsl(self):
        rows, _ = self.checks(Machine(), system="Windows")
        self.assertEqual(rows["platform"]["status"], "FAIL")
        self.assertIn("wsl --install -d Ubuntu", rows["platform"]["fix"])
        with mock.patch("bff.osiris_doctor.is_wsl", return_value=True):
            rows, _ = self.checks(Machine(), system="Linux")
        self.assertEqual(rows["platform"]["status"], "info")
        self.assertTrue(osiris_doctor.is_wsl("5.15.167.4-microsoft-standard-WSL2"))
        self.assertFalse(osiris_doctor.is_wsl("6.1.0-generic"))

    def test_private_access_is_checked_only_online(self):
        rows, _ = self.checks(Machine(), offline=True)
        self.assertEqual(rows["Osiris source"]["status"], "info")
        machine = Machine()
        with mock.patch.object(osiris_doctor.update, "latest_version", return_value=None):
            rows, _ = self.checks(machine, offline=False)
        self.assertEqual(rows["Osiris source"]["status"], "ok")
        self.assertTrue(any("ls-remote" in a for a in machine.argvs))

    def test_json_and_exit_codes(self):
        out = io.StringIO()
        with mock.patch.object(osiris_doctor, "run_checks", return_value=[
                {"check": "BB", "status": "FAIL", "detail": "x", "fix": "y"}]):
            self.assertEqual(osiris_doctor.run_doctor(json_out=True, out=out), 1)
        data = json.loads(out.getvalue())
        self.assertEqual((data["ok"], data["checks"][0]["check"]), (False, "BB"))
        with mock.patch.object(osiris_doctor, "run_checks", return_value=[
                {"check": "bd", "status": "warn", "detail": "x", "fix": "y"}]):
            self.assertEqual(osiris_doctor.run_doctor(json_out=True, out=io.StringIO()), 0)

    def test_companion_prompt_eof_is_no(self):
        out = io.StringIO()

        class Eof(io.StringIO):
            def isatty(self):
                return True
        with mock.patch.object(osiris_doctor, "run_checks", return_value=[]), \
                mock.patch("bff.doctor.survey", return_value=[{"component": "Herdr", "path": None, "installed": None,
                                                              "latest": "1", "action": "install", "reason": "",
                                                              "argv": ["/b/brew", "install", "herdr"],
                                                              "recipe": {"component": "Herdr"}}]), \
                mock.patch("bff.doctor.execute") as execute:
            osiris_doctor.run_doctor(out=out, stdin=Eof(""))
        execute.assert_not_called()
        self.assertIn("No changes made.", out.getvalue())

    def test_offline_also_skips_the_companion_registry_queries(self):
        from bff import doctor as tools
        with mock.patch.object(tools, "latest_stable") as latest, \
                mock.patch.object(tools, "available_route", return_value=("npm", "x", "/b/npm")):
            tools.survey(registry=False)
        latest.assert_not_called()
        with mock.patch.object(osiris_doctor, "run_checks", return_value=[]), \
                mock.patch.object(tools, "run_doctor", return_value=0) as companion:
            osiris_doctor.run_doctor(offline=True, out=io.StringIO())
        self.assertFalse(companion.call_args.kwargs["registry"])


class AttestationDefaultTests(unittest.TestCase):
    """O1 safe default: with gh present attestation is required; without it the swap is checksum-only, said LOUDLY,
    and the next step (doctor offers gh) is named."""

    def test_no_gh_warning_is_loud_and_names_the_way_out(self):
        from bff import update
        lines = []
        self.assertFalse(update._attest(Path("/x/bff-9.9.9.tar.gz"), "9.9.9", False, False, lines.append))
        text = " ".join(lines)
        self.assertTrue(text.startswith("WARNING: authenticity NOT checked"), text)
        self.assertIn("bff osiris doctor", text)

    def test_gh_present_and_refusing_is_fatal(self):
        from bff import update
        failing = subprocess.CompletedProcess([], 1, stdout="", stderr="no attestation")
        with mock.patch.object(update.subprocess, "run", return_value=failing), self.assertRaises(update.UpdateError):
            update._attest(Path("/x/bff-9.9.9.tar.gz"), "9.9.9", "/fake/gh", False, lambda line: None)

    def test_doctor_offers_gh_through_the_consented_companion_plan(self):
        from bff import doctor as tools
        gh = next(r for r in tools.RECIPES if r["component"] == "gh")
        self.assertEqual(gh["routes"], (("brew", "gh"),))


if __name__ == "__main__":
    unittest.main()
