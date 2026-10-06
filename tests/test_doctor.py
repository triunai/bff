import io
import subprocess
import unittest
from unittest import mock

from bff import doctor

PATHS = {"herdr": "/opt/homebrew/Cellar/herdr/0.9.3/bin/herdr", "bd": "/opt/homebrew/Cellar/beads/1.3.1/bin/bd",
         "omc": "/x/node_modules/oh-my-claude-sisyphus/bin/omc", "omx": "/x/node_modules/oh-my-codex/bin/omx",
         "bb": "/h/bb", "aeh": "/h/aeh", "brew": "/b/brew", "npm": "/b/npm",
         "gh": "/opt/homebrew/Cellar/gh/2.80.0/bin/gh"}
LATEST = {"herdr": "0.9.3", "beads": "1.3.1", "oh-my-claude-sisyphus": "5.6.0", "oh-my-codex": "0.21.7", "gh": "2.80.0"}
VERSIONS = {"herdr": "herdr 0.9.3", "bd": "bd version 1.3.1", "omc": "5.6.0", "omx": "oh-my-codex v0.21.7",
            "bb": "0.45.0", "aeh": "aeh 0.1.0", "gh": "gh version 2.80.0 (2026-09-30)"}


class Tty(io.StringIO):
    def __init__(self, text="", tty=True):
        super().__init__(text)
        self._tty = tty

    def isatty(self):
        return self._tty


class Env:
    """Fake machine: which(), subprocess.run() and recorded mutating calls."""

    def __init__(self, missing=(), latest=None, versions=None, fail=(), no_tools=()):
        self.paths = {k: v for k, v in PATHS.items() if k not in missing and k not in no_tools}
        self.latest = dict(LATEST, **(latest or {}))
        self.versions = dict(VERSIONS, **(versions or {}))
        self.fail = set(fail)
        self.mutations = []

    def which(self, name):
        return self.paths.get(name)

    def _result(self, stdout="", code=0):
        return subprocess.CompletedProcess([], code, stdout, "")

    def run(self, argv, **kwargs):
        exe = argv[0].rsplit("/", 1)[-1]
        if argv[1:] == ["--version"]:
            return self._result(self.versions[exe])
        if exe == "npm" and argv[1] == "view":
            return self._result(self.latest[argv[2]] + "\n")
        if exe == "brew" and argv[1] == "info":
            return self._result('{"formulae":[{"versions":{"stable":"%s"}}]}' % self.latest[argv[-1]])
        self.mutations.append(argv)
        pkg = argv[-1].split("@latest")[0]
        if pkg in self.fail:
            return self._result(code=1)
        tool = {"herdr": "herdr", "beads": "bd", "@beads/bd": "bd", "oh-my-claude-sisyphus": "omc", "oh-my-codex": "omx"}[pkg]
        self.paths[tool] = PATHS.get(tool, "/new/" + tool)
        return self._result()

    def patch(self):
        return mock.patch.multiple("bff.doctor", shutil=mock.Mock(which=self.which),
                                   subprocess=mock.Mock(run=self.run, SubprocessError=subprocess.SubprocessError,
                                                        CompletedProcess=subprocess.CompletedProcess))


def run(env, **kwargs):
    out = io.StringIO()
    with env.patch():
        kwargs.setdefault("offline", True)  # companion-tool tests must never touch the network
        code = doctor.run_doctor(stdout=out, **kwargs)
    return code, out.getvalue()


class DoctorTests(unittest.TestCase):
    def test_everything_present_plans_nothing(self):
        env = Env()
        code, text = run(env, stdin=Tty(tty=False))
        self.assertEqual(code, 0)
        self.assertIn("nothing to install or upgrade", text)
        self.assertNotIn("sudo", text)
        self.assertEqual(env.mutations, [])

    def test_missing_tool_is_planned_and_non_tty_changes_nothing(self):
        env = Env(missing=("herdr",))
        code, text = run(env, stdin=Tty(tty=False))
        self.assertEqual(code, 0)
        self.assertIn("install Herdr: /b/brew install herdr", text)
        self.assertIn("no changes made", text)
        self.assertEqual(env.mutations, [])

    def test_outdated_tool_is_planned_for_upgrade(self):
        env = Env(latest={"oh-my-claude-sisyphus": "5.6.1"})
        code, text = run(env, stdin=Tty(tty=False))
        self.assertIn("upgrade OMC: /b/npm install -g oh-my-claude-sisyphus@latest", text)
        self.assertEqual(env.mutations, [])

    def test_prerelease_latest_is_ignored(self):
        env = Env(latest={"oh-my-claude-sisyphus": "6.0.0-beta.1"})
        _, text = run(env, stdin=Tty(tty=False))
        self.assertIn("nothing to install or upgrade", text)

    def test_yes_runs_plan_without_prompt_and_verifies(self):
        env = Env(missing=("herdr",))
        code, text = run(env, assume_yes=True, stdin=Tty(tty=False))
        self.assertEqual(code, 0)
        self.assertEqual(env.mutations, [["/b/brew", "install", "herdr"]])
        self.assertIn("installed: Herdr", text)
        self.assertNotIn("[Y/n]", text)

    def test_prompt_no_changes_nothing_and_yes_answer_runs(self):
        env = Env(missing=("herdr",))
        code, text = run(env, stdin=Tty("n\n"))
        self.assertEqual((code, env.mutations), (0, []))
        self.assertIn("Install/update 1 items? [Y/n]", text)
        env = Env(missing=("herdr",))
        code, _ = run(env, stdin=Tty("\n"))
        self.assertEqual(len(env.mutations), 1)

    def test_prompt_eof_is_not_consent(self):
        env = Env(missing=("herdr",))
        code, text = run(env, stdin=Tty(""))
        self.assertEqual((code, env.mutations), (0, []))
        self.assertIn("No changes made.", text)

    def test_one_failure_continues_and_exits_nonzero(self):
        env = Env(missing=("herdr", "omc"), fail=("herdr",))
        code, text = run(env, assume_yes=True, stdin=Tty(tty=False))
        self.assertEqual(code, 1)
        self.assertEqual(len(env.mutations), 2)  # omc still attempted after herdr failed
        self.assertIn("failed: Herdr", text)
        self.assertIn("installed: OMC", text)

    def test_no_upgrade_installs_missing_only(self):
        env = Env(missing=("herdr",), latest={"oh-my-claude-sisyphus": "9.9.9"})
        code, _ = run(env, assume_yes=True, upgrade=False, stdin=Tty(tty=False))
        self.assertEqual(env.mutations, [["/b/brew", "install", "herdr"]])

    def test_no_package_manager_is_skipped_not_run(self):
        env = Env(missing=("herdr",), no_tools=("brew",))
        code, text = run(env, assume_yes=True, stdin=Tty(tty=False))
        self.assertEqual((code, env.mutations), (0, []))
        self.assertIn("skip Herdr: no supported package manager", text)

    def test_manual_tools_never_run(self):
        env = Env(missing=("bb", "aeh"))
        code, text = run(env, assume_yes=True, stdin=Tty(tty=False))
        self.assertEqual((code, env.mutations), (0, []))
        self.assertIn("https://github.com/get-bb/bb", text)

    def test_upgrade_skipped_when_not_owned_by_manager(self):
        env = Env(latest={"herdr": "1.0.0"})
        env.paths["herdr"] = "/usr/local/bin/herdr"
        _, text = run(env, assume_yes=True, stdin=Tty(tty=False))
        self.assertEqual(env.mutations, [])
        self.assertIn("installed outside a known package manager", text)

    def test_no_shell_true_anywhere(self):
        import pathlib
        self.assertNotIn("shell=True", pathlib.Path(doctor.__file__).read_text())
        self.assertNotIn("sudo", pathlib.Path(doctor.__file__).read_text())


class DoctorCliTests(unittest.TestCase):
    def test_json_is_backward_compatible_and_runs_nothing(self):
        from bff import cli
        out = io.StringIO()
        with mock.patch("bff.cli.shutil.which", return_value="/m/x"), mock.patch("subprocess.run") as r, \
                mock.patch("sys.stdout", out):
            self.assertEqual(cli.main(["doctor", "--json"]), 0)
        r.assert_not_called()
        import json
        data = json.loads(out.getvalue())
        self.assertEqual(set(data), {"components", "hooks", "ci", "note"})
        self.assertEqual(set(data["components"][0]), {"component", "executables", "availability", "integration"})


if __name__ == "__main__":
    unittest.main()
