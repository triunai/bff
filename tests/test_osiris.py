import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SDK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SDK))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import winskip  # noqa: E402
from bff import cli, osiris, paths, state, trusted_bin

FAKE_BB = """#!%s
import json, os, sys
argv = sys.argv[1:]
with open(os.environ["FAKE_BB_LOG"], "a") as log:
    log.write(json.dumps({"argv": argv, "cwd": os.getcwd()}) + "\\n")
state_file = os.environ["FAKE_BB_STATE"]
if argv == ["--version"]:
    print(os.environ.get("FAKE_BB_VERSION", "0.45.0"))
elif argv[:3] == ["plugin", "list", "--json"]:
    code = int(os.environ.get("FAKE_BB_LIST_EXIT", "0"))
    if code:
        sys.exit(code)
    sys.stdout.write(open(state_file).read())
elif argv[:2] == ["plugin", "install"]:
    code = int(os.environ.get("FAKE_BB_INSTALL_EXIT", "0"))
    results = json.loads(os.environ.get("FAKE_BB_INSTALL_RESULT", "{}"))
    result = results.get(argv[2], results.get("default"))
    if code == 0 and result:
        entry = {"id": "tool-observer", "enabled": True, "status": "running", "sourceDisplay": result["source"]}
        entry.update(result)
        json.dump({"plugins": [entry]}, open(state_file, "w"))
    sys.exit(code)
elif argv[:2] == ["plugin", "build"]:
    sys.exit(int(os.environ.get("FAKE_BB_BUILD_EXIT", "0")))
else:
    sys.exit(64)
"""

HOME = "/Users/" + "example"
GIT_SOURCE = "git:https://github.com/example/bb-plugin-osiris@v0.3.1"


def entry(source, version="0.2.0", **extra):
    base = {"id": "tool-observer", "version": version, "source": source, "provenance": "direct", "enabled": True,
            "status": "running", "sourceDisplay": source}
    base.update(extra)
    return base


class Fake(unittest.TestCase):
    """A fake bb on a private PATH; the real bb, home and staging directory are never reachable."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="bff osiris ")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.bb = str(self.bin / "bb")
        Path(self.bb).write_text(FAKE_BB % sys.executable, encoding="utf-8")
        os.chmod(self.bb, 0o755)
        self.log = self.root / "log.jsonl"
        self.state_file = self.root / "state.json"
        self.fake_state = self.root / "bb-state.json"
        self.staging = self.root / "staging"
        self.staging.mkdir()
        env = {"PATH": str(self.bin) + os.pathsep + "/usr/bin" + os.pathsep + "/bin", "FAKE_BB_LOG": str(self.log),
               "FAKE_BB_STATE": str(self.fake_state), "BFF_PREFIX": str(self.root / "prefix"),
               "OSIRIS_STAGING_DIR": str(self.staging), "HOME": str(self.root / "home")}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        # The primitive never reads PATH and passes a minimal env, so the fake bb is reached the way production reaches bb: through trusted_bin, with the fake's directory
        # as the only allowed location and its FAKE_BB_* variables named explicitly. Every other program still resolves (and is vetted) for real.
        real_which, real_run, fake_dir = trusted_bin.which, trusted_bin.run, str(self.bin)
        fake_names = ("FAKE_BB_LOG", "FAKE_BB_STATE", "FAKE_BB_VERSION", "FAKE_BB_LIST_EXIT", "FAKE_BB_INSTALL_EXIT", "FAKE_BB_INSTALL_RESULT", "FAKE_BB_BUILD_EXIT")

        def fake_which(name, policy=None):
            return self.bb if name == "bb" else real_which(name, policy)

        def fake_run(argv, **kwargs):
            if str(argv[0]) == self.bb:
                kwargs["policy"] = trusted_bin.Policy(dirs=(fake_dir,))
                kwargs["inherit"] = tuple(kwargs.get("inherit", ())) + fake_names
            return real_run(argv, **kwargs)
        for target, replacement in (("bff.trusted_bin.which", fake_which), ("bff.trusted_bin.run", fake_run)):
            started = mock.patch(target, side_effect=replacement)
            started.start()
            self.addCleanup(started.stop)
        self.set_plugins()

    def set_plugins(self, *plugins, raw=None):
        self.fake_state.write_text(raw if raw is not None else json.dumps({"plugins": list(plugins)}), encoding="utf-8")

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]

    def installs(self):
        return [c["argv"] for c in self.calls() if c["argv"][:2] == ["plugin", "install"]]

    def compat(self, published=False, commit=None, source=GIT_SOURCE):
        """The shipped pin with the generic git channel by default (the bundled channel has its own tests: BundledTests)."""
        data = osiris.load_compat()
        data["osiris"].update(published=published, commit=commit, source=source)
        return data

    def install_result(self, **results):
        os.environ["FAKE_BB_INSTALL_RESULT"] = json.dumps(results)

    def output(self):
        return self.out.getvalue()

    def call(self, function, **kwargs):
        self.out = io.StringIO()
        kwargs.setdefault("bb", self.bb)
        kwargs.setdefault("out", self.out)
        kwargs.setdefault("state_file", self.state_file)
        if function is not osiris.rollback_plugin:
            kwargs.setdefault("which", lambda name: self.bb if name == "bb" else "/usr/bin/" + name)
        return function(**kwargs)

    def plugin(self, name, version="0.2.1", xterm=True, symlink=False):
        directory = self.staging / name
        (directory / "node_modules" / "@xterm" / ("xterm" if xterm else "other")).mkdir(parents=True)
        (directory / "package.json").write_text(json.dumps({"version": version}), encoding="utf-8")
        if symlink:
            os.symlink(str(directory / "package.json"), str(directory / "link"))
        return directory


class TtyIn(io.StringIO):
    def isatty(self):
        return True


class CompatTests(Fake):
    def test_pin_is_honest_and_valid(self):
        data = osiris.load_compat()
        self.assertEqual(data["osiris"]["id"], "tool-observer")
        self.assertIs(data["osiris"]["published"], True)
        self.assertEqual((data["osiris"]["source"], data["osiris"]["version"]), (osiris.BUNDLED_SOURCE, "0.3.1"))
        self.assertRegex(data["osiris"]["commit"], r"^[0-9a-f]{40}$")
        shipped = json.loads((SDK / "plugins" / "osiris" / "package.json").read_text(encoding="utf-8"))["version"]
        self.assertEqual(shipped, data["osiris"]["version"])

    def test_bad_shape_is_refused(self):
        (self.root / "compat.json").write_text('{"schema_version": 1}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "shape"):
            osiris.load_compat(self.root)
        with self.assertRaisesRegex(ValueError, "unreadable"):
            osiris.load_compat(self.root / "absent")


@winskip.posix_only('the fake bb/herdr is a #! script; trusted_bin refuses scripts on Windows by design (BB and Osiris-in-BB are unsupported there; test_osiris_windows pins the Windows rules)')
class PluginStatusTests(Fake):
    def status(self):
        return osiris.plugin_status(self.bb)

    def test_kinds(self):
        self.set_plugins(entry("path:" + HOME + "/dev/plugin"))
        status = self.status()
        self.assertEqual((status["present"], status["kind"], status["version"], status["stale_bundled"]),
                         (True, "path", "0.2.0", False))
        self.set_plugins(entry("git:https://example.com/x@v1"))
        self.assertEqual(self.status()["kind"], "git")
        self.set_plugins(entry("builtin:tool-observer"))
        self.assertEqual(self.status()["kind"], "builtin")

    def test_missing_plugin(self):
        self.set_plugins({"id": "other", "source": "path:/x"})
        status = self.status()
        self.assertFalse(status["present"])
        self.assertIsNone(status["source"])

    def test_malformed_and_failing(self):
        self.set_plugins(raw="not json")
        with self.assertRaisesRegex(ValueError, "unreadable"):
            self.status()
        self.set_plugins(raw='{"nope": []}')
        with self.assertRaisesRegex(ValueError, "unreadable"):
            self.status()
        os.environ["FAKE_BB_LIST_EXIT"] = "7"
        with self.assertRaisesRegex(ValueError, "exit 7"):
            self.status()

    def test_stale_bundled_detection(self):
        release = self.root / "releases" / "0.1.1-abcdef012345" / "plugins" / "osiris"
        tree = self.root / "checkout"
        (tree / "bff").mkdir(parents=True)
        (tree / "bff" / "cli.py").write_text("", encoding="utf-8")
        (tree / "install.py").write_text("", encoding="utf-8")
        for directory, stale in ((release, True), (tree / "plugins" / "osiris", True), (self.root / "staged" / "install-0.2.9", False),
                                 (self.root / "elsewhere" / "plugins" / "osiris", False)):
            self.set_plugins(entry("path:" + str(directory)))
            self.assertEqual(self.status()["stale_bundled"], stale, directory)

    def test_stable_copy_is_managed_never_stale_and_a_dev_path_is_neither(self):
        data = Path(str(paths.data_dir(prefix=self.root / "prefix")))
        stable = data / "osiris" / "osiris-0.3.1-0123456789ab"
        self.set_plugins(entry("path:" + str(stable)))
        status = self.status()
        self.assertEqual((status["stale_bundled"], status["managed_bundle"]), (False, True))
        # The owner's kind of install: a worktree path outside bff's data directory, the dev channel.
        for dev in (self.root / "osiris-worktrees" / "install-0.2.16-abc1234", data / "elsewhere" / "osiris-0.3.1-0123456789ab",
                    data / "osiris" / "nested" / "osiris-0.3.1-0123456789ab"):
            self.set_plugins(entry("path:" + str(dev)))
            status = self.status()
            self.assertEqual((status["stale_bundled"], status["managed_bundle"]), (False, False), dev)


class PrerequisiteTests(Fake):
    def rows(self, found, system="Darwin"):
        return osiris.prerequisites(system, lambda n: "/x/" + n if n in found else None, self.fake_run, self.compat(), None)

    def fake_run(self, argv, **kw):
        return subprocess.CompletedProcess(argv, 0, stdout="9.9.9\n")

    def test_order_and_requirements(self):
        rows = self.rows({"node", "git"})
        self.assertEqual([r["name"] for r in rows], ["Homebrew", "Node", "BB", "git", "herdr", "bd", "bdi"])
        self.assertEqual([r["required"] for r in rows], [False, True, True, False, False, False, False])
        self.assertEqual([r["name"] for r in self.rows(set(), "Linux")][0], "Node")

    def test_node_not_required_when_bb_present(self):
        rows = self.rows({"bb"})
        self.assertFalse(next(r for r in rows if r["name"] == "Node")["required"])


@winskip.posix_only('the fake bb/herdr is a #! script; trusted_bin refuses scripts on Windows by design (BB and Osiris-in-BB are unsupported there; test_osiris_windows pins the Windows rules)')
class SetupTests(Fake):
    def test_path_dev_source_with_yes_never_replaced(self):
        self.set_plugins(entry("path:" + HOME + "/dev/plugin"))
        code = self.call(osiris.setup, yes=True, compat=self.compat(published=True))
        self.assertEqual(code, 0)
        self.assertEqual(self.installs(), [])
        self.assertIn("Osiris dev channel: path:" + HOME + "/dev/plugin (0.2.0), left as is. Use --switch-to-release to replace it.",
                      self.output())

    def test_switch_while_unpublished_installs_nothing(self):
        self.set_plugins(entry("path:" + HOME + "/dev/plugin"))
        code = self.call(osiris.setup, yes=True, switch_to_release=True, compat=self.compat(published=False))
        self.assertEqual(code, 4)
        self.assertEqual(self.installs(), [])
        self.assertIn("not publicly released yet", self.output())

    def test_unpublished_returns_3_and_never_installs_the_placeholder(self):
        self.assertEqual(self.call(osiris.setup, yes=True, compat=self.compat(published=False)), 4)
        self.assertEqual(self.installs(), [])

    def test_stale_bundle_is_named(self):
        stale = self.root / "r" / "0.1.1-abcdef012345" / "plugins" / "osiris"
        self.set_plugins(entry("path:" + str(stale)))
        self.call(osiris.setup, yes=True, switch_to_release=True, compat=self.compat(published=False))
        self.assertIn("your Osiris plugin comes from an old bff bundle (0.2.0)", self.output())

    def test_published_fresh_install_records_state(self):
        compat = self.compat(published=True)
        target = compat["osiris"]["source"]
        self.install_result(default={"source": target, "version": "0.3.1"})
        self.set_plugins()
        self.assertEqual(self.call(osiris.setup, yes=True, compat=compat), 0)
        self.assertEqual(self.installs(), [["plugin", "install", target, "--yes"]])
        self.assertEqual(state.load(self.state_file)["plugin"],
                         {"id": "tool-observer", "source": target, "version": "0.3.1", "previous_source": None})

    def test_commit_replaces_the_tag(self):
        compat = self.compat(published=True, commit="abc123")
        self.install_result(default={"source": "git:https://github.com/example/bb-plugin-osiris@abc123", "version": "0.3.1"})
        self.set_plugins()
        self.call(osiris.setup, yes=True, compat=compat)
        self.assertEqual(self.installs(), [["plugin", "install", "git:https://github.com/example/bb-plugin-osiris@abc123", "--yes"]])

    def test_failed_post_check_restores_previous(self):
        compat = self.compat(published=True)
        target = compat["osiris"]["source"]
        old = "git:https://example.com/old@v0.1.0"
        self.set_plugins(entry(old, "0.1.0"))
        self.install_result(**{target: {"source": target, "version": "9.9.9"}, old: {"source": old, "version": "0.1.0"}})
        self.assertEqual(self.call(osiris.setup, yes=True, compat=compat), 1)
        self.assertEqual([i[2] for i in self.installs()], [target, old])
        self.assertNotIn("plugin", state.load(self.state_file))
        self.assertEqual(osiris.plugin_status(self.bb)["source"], old)

    def test_already_on_target(self):
        compat = self.compat(published=True)
        self.set_plugins(entry(compat["osiris"]["source"], "0.3.1"))
        self.assertEqual(self.call(osiris.setup, yes=True, compat=compat), 0)
        self.assertIn("up to date", self.output())
        self.assertEqual(self.installs(), [])

    def test_dry_run_and_non_tty_install_nothing(self):
        compat = self.compat(published=True)
        self.set_plugins()
        self.assertEqual(self.call(osiris.setup, dry_run=True, yes=True, compat=compat), 0)
        self.assertEqual(self.call(osiris.setup, stdin=io.StringIO(), compat=compat), 0)
        self.assertEqual(self.installs(), [])
        self.assertIn("Re-run with --yes", self.output())

    def test_tty_confirmation(self):
        compat = self.compat(published=True)
        self.set_plugins()
        self.assertEqual(self.call(osiris.setup, stdin=TtyIn("n\n"), compat=compat), 0)
        self.assertEqual(self.installs(), [])

    def test_tty_eof_is_not_consent(self):
        compat = self.compat(published=True)
        self.set_plugins()
        self.assertEqual(self.call(osiris.setup, stdin=TtyIn(""), compat=compat), 0)
        self.assertEqual(self.installs(), [])

    def test_missing_bb_returns_3_with_rows_in_order(self):
        code = self.call(osiris.setup, bb=None, which=lambda name: None, system="Darwin", compat=self.compat())
        self.assertEqual(code, 3)
        text = self.output()
        self.assertEqual(self.calls(), [])
        self.assertTrue(text.index("Homebrew:") < text.index("Node:") < text.index("BB:"), text)
        self.assertIn("https://brew.sh", text)
        self.assertNotIn("curl", text)

    def test_old_bb_returns_3(self):
        os.environ["FAKE_BB_VERSION"] = "0.44.9"
        self.assertEqual(self.call(osiris.setup, yes=True, compat=self.compat(published=True)), 3)
        self.assertIn("TOO OLD", self.output())
        self.assertEqual(self.installs(), [])


@winskip.posix_only('the fake bb/herdr is a #! script; trusted_bin refuses scripts on Windows by design (BB and Osiris-in-BB are unsupported there; test_osiris_windows pins the Windows rules)')
class UpdateTests(Fake):
    def update(self, **kw):
        kw.setdefault("staging_root", str(self.staging))
        kw.setdefault("compat", self.compat())
        return self.call(osiris.update, **kw)

    def populate(self):
        self.plugin("install-0.2.9-dev-a", "0.2.9")
        self.picked = self.plugin("install-0.2.10-dev-b", "0.2.10")
        self.plugin("install-0.2.11-dev-c", "0.2.11", symlink=True)
        self.plugin("install-0.2.12-dev-d", "0.2.12", xterm=False)

    def test_latest_staged_picks_numerically_gates_on_a_copy(self):
        self.populate()
        previous = self.root / "old plugin"
        self.set_plugins(entry("path:" + str(previous), "0.2.0"))
        self.install_result(default={"source": "path:" + str(self.picked), "version": "0.2.10"})
        self.assertEqual(self.update(from_latest_staged=True), 0)
        text = self.output()
        self.assertIn("skipped install-0.2.12-dev-d: has no node_modules/@xterm/xterm", text)
        self.assertIn("skipped install-0.2.11-dev-c: contains a symlink", text)
        self.assertIn("picked install-0.2.10-dev-b", text)
        build = next(c for c in self.calls() if c["argv"][:2] == ["plugin", "build"])
        self.assertEqual(build["argv"], ["plugin", "build", "."])
        self.assertNotEqual(Path(build["cwd"]).resolve(), self.picked.resolve())
        self.assertTrue(Path(build["cwd"]).name == "plugin" and "bff-osiris-gate-" in build["cwd"])
        self.assertEqual(self.installs(), [["plugin", "install", str(self.picked), "--yes"]])
        self.assertIn("rollback: bb plugin install " + str(previous) + " --yes", text)
        recorded = state.load(self.state_file)["plugin"]
        self.assertEqual((recorded["version"], recorded["previous_source"]), ("0.2.10", "path:" + str(previous)))
        self.assertFalse(os.path.exists(build["cwd"]))

    def test_gate_failure_installs_nothing(self):
        self.populate()
        os.environ["FAKE_BB_BUILD_EXIT"] = "1"
        self.assertEqual(self.update(from_latest_staged=True), 1)
        self.assertIn("Gate FAILED: BB could not build " + str(self.picked) + "; not installing (copy left at ", self.output())
        self.assertEqual(self.installs(), [])
        self.assertNotIn("plugin", state.load(self.state_file))

    def test_already_current_does_nothing(self):
        self.populate()
        self.set_plugins(entry("path:" + str(self.picked), "0.2.10"))
        self.assertEqual(self.update(from_latest_staged=True), 0)
        self.assertIn("already up to date", self.output())
        self.assertEqual(self.installs(), [])
        self.assertEqual([c for c in self.calls() if c["argv"][:2] == ["plugin", "build"]], [])

    def test_nothing_usable(self):
        self.plugin("install-0.2.1", xterm=False)
        self.assertEqual(self.update(from_latest_staged=True), 1)
        self.assertEqual(self.installs(), [])

    def test_from_dir_refuses_unfit_directory(self):
        bad = self.plugin("install-0.3.1", symlink=True)
        self.assertEqual(self.update(from_dir=str(bad)), 1)
        self.assertEqual(self.installs(), [])

    def test_from_dir_installs_with_gate(self):
        good = self.plugin("install-0.3.1", "0.3.1")
        self.install_result(default={"source": "path:" + str(good), "version": "0.3.1"})
        self.assertEqual(self.update(from_dir=str(good)), 0)
        self.assertEqual(self.installs(), [["plugin", "install", str(good), "--yes"]])

    def test_flags_are_exclusive_and_bb_is_needed(self):
        with self.assertRaisesRegex(ValueError, "one of"):
            self.update(version="1.0.0", from_dir="/x")
        with self.assertRaisesRegex(ValueError, "BB not found"):
            self.update(bb=None, which=lambda name: None)

    def test_version_needs_publication_and_prints_off_pin(self):
        self.assertEqual(self.update(version="0.4.0"), 4)
        self.assertEqual(self.installs(), [])
        compat = self.compat(published=True)
        target = "git:https://github.com/example/bb-plugin-osiris@v0.4.0"
        self.install_result(default={"source": target, "version": "0.4.0"})
        self.set_plugins()
        self.assertEqual(self.update(version="0.4.0", yes=True, compat=compat), 0)
        self.assertIn("off pin: compat.json pins 0.3.1", self.output())
        self.assertEqual(self.installs(), [["plugin", "install", target, "--yes"]])

    def test_no_flags_respects_dev_channel(self):
        self.set_plugins(entry("path:" + HOME + "/dev"))
        self.assertEqual(self.update(yes=True, compat=self.compat(published=True)), 0)
        self.assertEqual(self.installs(), [])


@winskip.posix_only('the fake bb/herdr is a #! script; trusted_bin refuses scripts on Windows by design (BB and Osiris-in-BB are unsupported there; test_osiris_windows pins the Windows rules)')
class RollbackTests(Fake):
    def test_swaps_and_swaps_back(self):
        a, b = "path:" + str(self.root / "a"), "path:" + str(self.root / "b")
        state.save(self.state_file, {"plugin": {"id": "tool-observer", "source": b, "version": "2", "previous_source": a}})
        self.install_result(default={"source": a, "version": "1"})
        self.assertEqual(self.call(osiris.rollback_plugin, yes=True), 0)
        self.assertEqual(self.installs(), [["plugin", "install", str(self.root / "a"), "--yes"]])
        plugin = state.load(self.state_file)["plugin"]
        self.assertEqual((plugin["source"], plugin["previous_source"], plugin["version"]), (a, b, "1"))
        self.install_result(default={"source": b, "version": "2"})
        self.assertEqual(self.call(osiris.rollback_plugin, yes=True), 0)
        plugin = state.load(self.state_file)["plugin"]
        self.assertEqual((plugin["source"], plugin["previous_source"]), (b, a))

    def test_nothing_recorded(self):
        with self.assertRaisesRegex(ValueError, "nothing to roll back"):
            self.call(osiris.rollback_plugin, yes=True)

    def test_unverified_rollback_keeps_state(self):
        a, b = "path:" + str(self.root / "a"), "path:" + str(self.root / "b")
        original = {"plugin": {"id": "tool-observer", "source": b, "version": "2", "previous_source": a}}
        state.save(self.state_file, json.loads(json.dumps(original)))
        os.environ["FAKE_BB_INSTALL_EXIT"] = "1"
        self.set_plugins()
        self.assertEqual(self.call(osiris.rollback_plugin, yes=True), 1)
        self.assertEqual(state.load(self.state_file)["plugin"], original["plugin"])


@winskip.posix_only('the fake bb/herdr is a #! script; trusted_bin refuses scripts on Windows by design (BB and Osiris-in-BB are unsupported there; test_osiris_windows pins the Windows rules)')
class CliTests(Fake):
    def command(self, args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = cli.main(args)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_install_flag_is_renamed_and_runs_setup(self):
        self.set_plugins(entry("path:" + HOME + "/dev"))
        code, stdout, stderr = self.command(["osiris", "--install"])
        self.assertEqual(code, 0)
        self.assertIn("bff osiris --install is renamed: use bff osiris setup", stderr)
        self.assertIn("Osiris dev channel", stdout)
        self.assertEqual(self.installs(), [])

    def test_setup_dry_run(self):
        self.set_plugins()
        with mock.patch.object(osiris, "load_compat", return_value=self.compat(published=False)):
            code, stdout, _ = self.command(["osiris", "setup", "--dry-run"])
        self.assertEqual(code, 4)
        self.assertIn("Osiris setup plan", stdout)
        self.assertIn("not publicly released yet", stdout)
        self.assertEqual(self.installs(), [])

    def test_run_with_plugin_missing_hints_setup(self):
        self.set_plugins()
        with mock.patch("bff.cli.http.client.HTTPConnection") as connection:
            code, _, stderr = self.command(["osiris"])
        self.assertEqual(code, 2)
        self.assertIn("Osiris plugin not installed: run bff osiris setup", stderr)
        connection.assert_not_called()

    def test_run_with_disabled_plugin(self):
        self.set_plugins(entry("git:x@v1", enabled=False, status="disabled"))
        code, _, stderr = self.command(["osiris"])
        self.assertEqual(code, 2)
        self.assertIn("Osiris plugin is disabled: enable it in BB, or run bff osiris setup", stderr)

    def test_run_without_bb(self):
        with mock.patch("bff.trusted_bin.which", return_value=None):  # no bb in any trusted location (PATH is never consulted, so editing it would prove nothing)
            code, _, stderr = self.command(["osiris"])
        self.assertEqual(code, 2)
        self.assertIn("BB not found: run bff osiris setup", stderr)

    def test_run_prints_dev_channel_line(self):
        self.set_plugins(entry("path:" + HOME + "/dev"))
        with mock.patch("bff.cli.http.client.HTTPConnection") as connection, mock.patch("bff.cli.webbrowser.open", return_value=True):
            connection.return_value.getresponse.return_value.status = 200
            code, stdout, _ = self.command(["osiris"])
        self.assertEqual(code, 0)
        self.assertIn("Osiris dev channel: path:" + HOME + "/dev", stdout)

    def test_print_url_makes_no_bb_call(self):
        code, stdout, _ = self.command(["osiris", "--print-url"])
        self.assertEqual((code, stdout.strip()), (0, cli.OSIRIS_URL))
        self.assertEqual(self.calls(), [])


class ReleaseTests(Fake):
    def test_release_has_compat_and_the_bundled_plugin(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("bff_installer", SDK / "install.py")
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        source = self.root / "src"
        source.mkdir()
        for name in ("bff", "templates"):
            shutil.copytree(str(SDK / name), str(source / name), ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copy(str(SDK / "compat.json"), str(source / "compat.json"))
        shutil.copytree(str(SDK / "plugins"), str(source / "plugins"))
        (source / "README.md").write_text("scratch\n", encoding="utf-8")
        result = installer.install(self.root / "prefix2", source=source)
        release = Path(str(paths.releases_dir(prefix=self.root / "prefix2"))) / result["release"]
        self.assertTrue((release / "compat.json").is_file())
        self.assertTrue((release / "bff" / "osiris.py").is_file())
        self.assertTrue((release / "plugins" / "osiris" / "package.json").is_file())
        self.assertTrue((release / "plugins" / "osiris" / "node_modules" / "@xterm" / "xterm" / "package.json").is_file())
        self.assertEqual(osiris.bundled_files(release), {name[len(osiris.BUNDLE_PREFIX):]: digest for name, digest in
                         json.loads((release / "manifest.json").read_text(encoding="utf-8"))["files"].items()
                         if name.startswith(osiris.BUNDLE_PREFIX)})

    def test_old_manifest_with_plugin_still_verifies(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("bff_installer2", SDK / "install.py")
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        source = self.root / "src"
        source.mkdir()
        for name in ("bff", "templates"):
            shutil.copytree(str(SDK / name), str(source / name), ignore=shutil.ignore_patterns("__pycache__"))
        result = installer.install(self.root / "prefix3", source=source)
        release = Path(str(paths.releases_dir(prefix=self.root / "prefix3"))) / result["release"]
        installer.verify_release(release)
        # Forge an old 0.1.x release: add the bundled plugin, then re-seal the manifest under its new identity.
        (release / "plugins" / "osiris" / "dist").mkdir(parents=True)
        (release / "plugins" / "osiris" / "package.json").write_text("{}", encoding="utf-8")
        (release / "plugins" / "osiris" / "dist" / "app.js").write_text("// prebuilt", encoding="utf-8")
        manifest = json.loads((release / "manifest.json").read_text(encoding="utf-8"))
        manifest["files"] = installer.inventory(release)
        manifest["files"].pop("manifest.json")
        old = release.parent / installer.release_id(manifest)
        (release / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        release.rename(old)
        self.assertIn("plugins/osiris/package.json", installer.verify_release(old)["files"])
        (old / "plugins" / "osiris" / "dist" / "app.js.map").write_text("map", encoding="utf-8")
        with self.assertRaises(ValueError):
            installer.verify_release(old)

    def test_only_osiris_py_touches_the_bundled_plugin_and_never_installs_from_the_release_dir(self):
        for module in (SDK / "bff").glob("*.py"):
            text = module.read_text(encoding="utf-8")
            if module.name == "osiris.py":
                self.assertEqual(text.count('"plugins" / "osiris"'), 1)  # the single read, inside materialize_bundled
                self.assertIn('target = "path:" + str(stable_dir(', text)  # the install target is always the stable copy
            else:
                self.assertNotIn("plugins/osiris", text, module.name)
                self.assertNotIn('"plugins" / "osiris"', text, module.name)


@winskip.posix_only('the fake bb is a #! script; trusted_bin refuses scripts on Windows by design')
class BundledTests(Fake):
    """The bundled channel: a fake release root (manifest + plugin files), the fake bb, a private prefix. Nothing real is touched."""
    VERSION = "0.3.1"

    def setUp(self):
        super().setUp()
        self.release = self.root / "prefix" / "share" / "bff" / "releases" / "0.2.1-0123456789ab"
        self.bundle = {"package.json": '{"version": "0.3.1"}', "server.ts": "export default {};\n",
                       "node_modules/@xterm/xterm/package.json": '{"name": "@xterm/xterm"}', "bin/osiris-tui.mjs": "// tui\n"}
        for name, text in self.bundle.items():
            path = self.release / "plugins" / "osiris" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        import hashlib
        files = {"plugins/osiris/" + name: hashlib.sha256(text.encode("utf-8")).hexdigest() for name, text in self.bundle.items()}
        files["bff/cli.py"] = "0" * 64
        (self.release / "manifest.json").write_text(json.dumps({"schema_version": 1, "files": files}), encoding="utf-8")
        self.data = Path(str(paths.data_dir(prefix=self.root / "prefix")))

    def command(self, args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = cli.main(args)
        return code, stdout.getvalue(), stderr.getvalue()

    def pin(self, **kw):
        return self.compat(published=True, commit="a" * 40, source=osiris.BUNDLED_SOURCE, **kw)

    def stable(self):
        return osiris.stable_dir(self.VERSION, osiris.bundled_files(self.release))

    def ok_install(self):
        self.install_result(default={"source": "path:" + str(self.stable()), "version": self.VERSION})

    def setup(self, **kw):
        kw.setdefault("compat", self.pin())
        kw.setdefault("root", self.release)
        return self.call(osiris.setup, **kw)

    def test_stable_dir_is_outside_every_release_dir(self):
        stable = self.stable()
        self.assertEqual(stable.parent, self.data / "osiris")
        self.assertNotIn("releases", stable.parts)
        self.assertIsNone(paths.RELEASE_NAME.fullmatch(stable.name))
        self.assertTrue(stable.name.startswith("osiris-" + self.VERSION + "-"))

    def test_dry_run_plans_the_stable_copy_and_changes_nothing(self):
        self.assertEqual(self.setup(dry_run=True, yes=True), 0)
        self.assertIn("Plan: bb plugin install " + str(self.stable()) + " --yes", self.output())
        self.assertIn("dry run", self.output())
        self.assertEqual(self.installs(), [])
        self.assertFalse((self.data / "osiris").exists())

    def test_install_copies_verifies_then_installs_from_the_stable_copy(self):
        self.ok_install()
        self.assertEqual(self.setup(yes=True), 0)
        self.assertEqual(self.installs(), [["plugin", "install", str(self.stable()), "--yes"]])
        for name, text in self.bundle.items():
            self.assertEqual((self.stable() / name).read_text(encoding="utf-8"), text)
        self.assertEqual([p.name for p in (self.data / "osiris").iterdir()], [self.stable().name])  # no staging debris
        recorded = state.load(self.state_file)["plugin"]
        self.assertEqual((recorded["source"], recorded["version"]), ("path:" + str(self.stable()), self.VERSION))

    def test_the_copy_survives_the_release_being_pruned(self):
        self.ok_install()
        self.assertEqual(self.setup(yes=True), 0)
        stable = self.stable()
        shutil.rmtree(str(self.release))
        self.assertEqual(osiris._inventory(stable), {k: __import__("hashlib").sha256(v.encode()).hexdigest() for k, v in self.bundle.items()})

    def test_tampered_release_file_installs_nothing(self):
        (self.release / "plugins" / "osiris" / "server.ts").write_text("tampered", encoding="utf-8")
        self.ok_install()
        self.assertEqual(self.setup(yes=True), 1)
        self.assertEqual(self.installs(), [])
        self.assertIn("does not match its manifest", self.output())
        self.assertEqual(list((self.data / "osiris").iterdir()) if (self.data / "osiris").exists() else [], [])

    def test_extra_or_missing_release_file_installs_nothing(self):
        (self.release / "plugins" / "osiris" / "bin" / "osiris-tui.mjs").unlink()
        self.assertEqual(self.setup(yes=True), 1)
        self.assertEqual(self.installs(), [])

    def test_no_release_manifest_refuses_instead_of_guessing(self):
        (self.release / "manifest.json").unlink()
        with self.assertRaisesRegex(ValueError, "cannot be verified"):
            self.setup(yes=True)
        self.assertEqual(self.installs(), [])

    def test_a_damaged_stable_copy_is_rebuilt_not_trusted(self):
        self.ok_install()
        self.assertEqual(self.setup(yes=True), 0)
        (self.stable() / "server.ts").write_text("damaged", encoding="utf-8")
        (self.stable() / "stray.js").write_text("x", encoding="utf-8")
        self.set_plugins()
        self.assertEqual(self.setup(yes=True), 0)
        self.assertEqual((self.stable() / "server.ts").read_text(encoding="utf-8"), self.bundle["server.ts"])
        self.assertFalse((self.stable() / "stray.js").exists())

    def test_dev_channel_install_is_left_alone_without_the_switch(self):
        dev = self.root / "osiris-worktrees" / "install-0.2.16-abc1234"
        self.set_plugins(entry("path:" + str(dev), version="0.2.16-dev"))
        self.ok_install()
        self.assertEqual(self.setup(yes=True), 0)
        self.assertEqual(self.installs(), [])
        self.assertIn("dev channel", self.output())
        self.assertFalse((self.data / "osiris").exists())

    def test_switch_to_release_replaces_a_dev_install_and_can_restore_it(self):
        dev = self.root / "osiris-worktrees" / "install-0.2.16-abc1234"
        self.set_plugins(entry("path:" + str(dev), version="0.2.16-dev"))
        self.ok_install()
        self.assertEqual(self.setup(yes=True, switch_to_release=True), 0)
        self.assertEqual(self.installs(), [["plugin", "install", str(self.stable()), "--yes"]])
        self.assertEqual(state.load(self.state_file)["plugin"]["previous_source"], "path:" + str(dev))

    def test_an_older_managed_copy_is_upgraded_not_mistaken_for_a_dev_channel(self):
        old = self.data / "osiris" / "osiris-0.2.9-ffffffffffff"
        self.set_plugins(entry("path:" + str(old), version="0.2.9"))
        self.ok_install()
        self.assertEqual(self.setup(yes=True), 0)
        self.assertEqual(self.installs(), [["plugin", "install", str(self.stable()), "--yes"]])
        self.assertNotIn("dev channel", self.output())

    def test_old_release_dir_bundle_is_named_stale_and_replaced_by_the_stable_copy(self):
        stale = self.root / "r" / "0.1.1-abcdef012345" / "plugins" / "osiris"
        self.set_plugins(entry("path:" + str(stale), version="0.2.0"))
        self.ok_install()
        self.assertEqual(self.setup(yes=True), 0)
        self.assertIn("old bff bundle", self.output())
        self.assertEqual(self.installs(), [["plugin", "install", str(self.stable()), "--yes"]])

    def test_already_installed_is_a_no_op(self):
        self.ok_install()
        self.assertEqual(self.setup(yes=True), 0)
        before = len(self.calls())
        self.assertEqual(self.setup(yes=True), 0)
        self.assertEqual(len(self.installs()), 1)
        self.assertIn("up to date", self.output())
        self.assertGreater(len(self.calls()), before)  # only the read-only plugin list ran

    def test_unpublished_pin_still_exits_4_and_installs_nothing(self):
        compat = self.compat(published=False, source=osiris.BUNDLED_SOURCE)
        self.assertEqual(self.setup(yes=True, compat=compat), osiris.UNPUBLISHED_EXIT)
        self.assertEqual(self.installs(), [])
        self.assertFalse((self.data / "osiris").exists())

    def test_update_to_a_version_this_bff_does_not_bundle_is_refused(self):
        code = self.call(osiris.update, version="0.9.9", yes=True, compat=self.pin(), root=self.release)
        self.assertEqual(code, 1)
        self.assertEqual(self.installs(), [])
        self.assertIn("bundles Osiris 0.3.1 only", self.output())

    def test_cli_setup_dry_run_with_the_shipped_pin_points_at_the_stable_copy(self):
        self.set_plugins()
        with mock.patch.object(osiris, "_release_root", return_value=self.release):
            code, stdout, _ = self.command(["osiris", "setup", "--dry-run"])
        self.assertEqual(code, 0, stdout)
        self.assertIn("Plan: bb plugin install " + str(self.stable()) + " --yes", stdout)
        self.assertEqual(self.installs(), [])

    def test_update_without_flags_installs_the_bundle(self):
        self.ok_install()
        self.assertEqual(self.call(osiris.update, yes=True, compat=self.pin(), root=self.release), 0)
        self.assertEqual(self.installs(), [["plugin", "install", str(self.stable()), "--yes"]])


if __name__ == "__main__":
    unittest.main()
