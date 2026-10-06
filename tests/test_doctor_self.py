"""bff doctor reports BFF's own version against the latest GitHub release, failing soft."""
import io
import json
import socket
import unittest
import urllib.error
from unittest import mock

from bff import __version__, cli, doctor
from test_doctor import Env, Tty, run


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def opener_returning(payload):
    seen = {}

    def opener(request, timeout=None):
        seen["url"], seen["timeout"], seen["headers"] = request.full_url, timeout, dict(request.header_items())
        return FakeResponse(payload if isinstance(payload, bytes) else json.dumps(payload).encode())
    opener.seen = seen
    return opener


class FetchTests(unittest.TestCase):
    def test_reads_the_tag_with_one_short_unauthenticated_call(self):
        opener = opener_returning({"tag_name": "v0.1.1"})
        self.assertEqual(doctor.fetch_latest_release(opener=opener), "0.1.1")
        self.assertEqual(opener.seen["url"], "https://api.github.com/repos/triunai/bff/releases/latest")
        self.assertLessEqual(opener.seen["timeout"], 5)
        self.assertNotIn("Authorization", opener.seen["headers"])

    def test_every_failure_mode_is_unknown(self):
        for payload in ({"tag_name": "v0.2.0-rc1"}, {"tag_name": "latest"}, {"tag_name": "v0.1.1; rm -rf ~"},
                        {"tag_name": 7}, {}, b"<html>not json", b""):
            self.assertIsNone(doctor.fetch_latest_release(opener=opener_returning(payload)), payload)
        for error in (urllib.error.URLError("offline"), socket.timeout(), OSError("boom"),
                      urllib.error.HTTPError("u", 403, "rate limited", {}, None)):
            def failing(request, timeout=None, error=error):
                raise error
            self.assertIsNone(doctor.fetch_latest_release(opener=failing), error)


class CheckTests(unittest.TestCase):
    def test_outdated_prints_bff_update_never_a_pipe(self):
        info = doctor.check_self("0.1.0", fetch=lambda: "0.1.1")
        self.assertEqual(info["status"], "outdated")
        self.assertEqual(info["command"], "bff update")

    def test_current_ahead_and_unknown_have_no_command(self):
        for installed, latest, status in (("0.1.1", "0.1.1", "current"), ("0.2.0", "0.1.1", "ahead"), ("0.1.1", None, "unknown")):
            info = doctor.check_self(installed, fetch=lambda latest=latest: latest)
            self.assertEqual((info["status"], info["command"]), (status, None))

    def test_numeric_not_lexical_comparison(self):
        self.assertEqual(doctor.check_self("0.9.0", fetch=lambda: "0.10.0")["status"], "outdated")


class RunDoctorTests(unittest.TestCase):
    def test_outdated_bff_is_reported_and_nothing_is_executed(self):
        env = Env()
        code, text = run(env, stdin=Tty(tty=False), offline=False, fetch_latest=lambda: "99.0.0")
        self.assertEqual(code, 0)
        self.assertIn("BFF %s installed; latest release is 99.0.0 (outdated)" % __version__, text)
        self.assertIn("update: bff update\n", text)
        self.assertIn("BFF never runs it", text)
        self.assertEqual(env.mutations, [])  # printed only: no curl, no installer

    def test_unreachable_github_says_unknown_and_the_rest_still_works(self):
        env = Env(missing=("herdr",))
        code, text = run(env, stdin=Tty(tty=False), offline=False, fetch_latest=lambda: None)
        self.assertEqual(code, 0)
        self.assertIn("latest release unknown", text)
        self.assertIn("install Herdr", text)

    def test_offline_never_calls_the_fetcher_or_prints_a_self_line(self):
        fetch = mock.Mock(return_value="99.0.0")
        _, text = run(Env(), stdin=Tty(tty=False), offline=True, fetch_latest=fetch)
        fetch.assert_not_called()
        self.assertNotIn("BFF %s installed" % __version__, text)

    def test_a_current_version_does_not_prompt_or_plan_anything(self):
        env = Env()
        code, text = run(env, stdin=Tty(tty=False), offline=False, fetch_latest=lambda: __version__)
        self.assertIn("up to date", text)
        self.assertIn("nothing to install or upgrade", text)


class CliTests(unittest.TestCase):
    def test_offline_flag_reaches_run_doctor_and_json_stays_network_free(self):
        with mock.patch("bff.doctor.run_doctor", return_value=0) as called:
            self.assertEqual(cli.main(["doctor", "--offline"]), 0)
        self.assertTrue(called.call_args.kwargs["offline"])
        with mock.patch("bff.doctor.fetch_latest_release") as fetch, mock.patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(cli.main(["doctor", "--json"]), 0)
        fetch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
