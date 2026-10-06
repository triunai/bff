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
from bff import cli, osiris, paths, state

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
        Path(self.bb).write_text(FAKE_BB % sys.executable)
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
        self.set_plugins()

    def set_plugins(self, *plugins, raw=None):
        self.fake_state.write_text(raw if raw is not None else json.dumps({"plugins": list(plugins)}))

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def installs(self):
        return [c["argv"] for c in self.calls() if c["argv"][:2] == ["plugin", "install"]]

    def compat(self, published=False, commit=None):
        data = osiris.load_compat()
        data["osiris"].update(published=published, commit=commit)
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
        (directory / "package.json").write_text(json.dumps({"version": version}))
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
        self.assertIs(data["osiris"]["published"], False)

    def test_bad_shape_is_refused(self):
        (self.root / "compat.json").write_text('{"schema_version": 1}')
        with self.assertRaisesRegex(ValueError, "shape"):
            osiris.load_compat(self.root)
        with self.assertRaisesRegex(ValueError, "unreadable"):
            osiris.load_compat(self.root / "absent")


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
        (tree / "bff" / "cli.py").write_text("")
        (tree / "install.py").write_text("")
        for directory, stale in ((release, True), (tree / "plugins" / "osiris", True), (self.root / "staged" / "install-0.2.9", False),
                                 (self.root / "elsewhere" / "plugins" / "osiris", False)):
            self.set_plugins(entry("path:" + str(directory)))
            self.assertEqual(self.status()["stale_bundled"], stale, directory)


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
        self.install_result(default={"source": target, "version": "0.3.0"})
        self.set_plugins()
        self.assertEqual(self.call(osiris.setup, yes=True, compat=compat), 0)
        self.assertEqual(self.installs(), [["plugin", "install", target, "--yes"]])
        self.assertEqual(state.load(self.state_file)["plugin"],
                         {"id": "tool-observer", "source": target, "version": "0.3.0", "previous_source": None})

    def test_commit_replaces_the_tag(self):
        compat = self.compat(published=True, commit="abc123")
        self.install_result(default={"source": "git:https://github.com/triunai/bb-plugin-osiris@abc123", "version": "0.3.0"})
        self.set_plugins()
        self.call(osiris.setup, yes=True, compat=compat)
        self.assertEqual(self.installs(), [["plugin", "install", "git:https://github.com/triunai/bb-plugin-osiris@abc123", "--yes"]])

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

    def test_a_failed_install_of_a_same_version_build_is_not_a_success(self):
        # Every 0.2.16 rc reports "0.2.16-dev": when bb refuses the new dir, the OLD build still runs at the wanted
        # version, which used to read as "Installed Osiris 0.2.16-dev" and recorded the wrong source.
        old = self.plugin("install-0.2.16-rc3-2b12d6e", "0.2.16-dev")
        new = self.plugin("install-0.2.16-rc3.1-66347de", "0.2.16-dev")
        self.set_plugins(entry("path:" + str(old), "0.2.16-dev"))
        os.environ["FAKE_BB_INSTALL_EXIT"] = "1"
        self.assertEqual(self.call(osiris.update, from_dir=str(new), compat=self.compat()), 1)
        self.assertIn("did not verify", self.output())
        self.assertNotIn("Installed Osiris", self.output())
        self.assertNotIn("plugin", state.load(self.state_file))
        os.environ.pop("FAKE_BB_INSTALL_EXIT")
        self.install_result(default={"source": "path:" + str(old), "version": "0.2.16-dev"})  # exit 0, wrong dir
        self.assertEqual(self.call(osiris.update, from_dir=str(new), compat=self.compat()), 1)
        self.assertNotIn("Installed Osiris", self.output())

    def test_already_on_target(self):
        compat = self.compat(published=True)
        self.set_plugins(entry(compat["osiris"]["source"], "0.3.0"))
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
        bad = self.plugin("install-0.3.0", symlink=True)
        self.assertEqual(self.update(from_dir=str(bad)), 1)
        self.assertEqual(self.installs(), [])

    def test_from_dir_installs_with_gate(self):
        good = self.plugin("install-0.3.0", "0.3.0")
        self.install_result(default={"source": "path:" + str(good), "version": "0.3.0"})
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
        target = "git:https://github.com/triunai/bb-plugin-osiris@v0.4.0"
        self.install_result(default={"source": target, "version": "0.4.0"})
        self.set_plugins()
        self.assertEqual(self.update(version="0.4.0", yes=True, compat=compat), 0)
        self.assertIn("off pin: compat.json pins 0.3.0", self.output())
        self.assertEqual(self.installs(), [["plugin", "install", target, "--yes"]])

    def test_no_flags_respects_dev_channel(self):
        self.set_plugins(entry("path:" + HOME + "/dev"))
        self.assertEqual(self.update(yes=True, compat=self.compat(published=True)), 0)
        self.assertEqual(self.installs(), [])


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


class CliTests(Fake):
    def command(self, args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = cli.main(args)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_install_flag_is_renamed_and_runs_install(self):
        self.set_plugins(entry("path:" + HOME + "/dev"))
        code, stdout, stderr = self.command(["osiris", "--install"])
        self.assertEqual(code, 0)
        self.assertIn("bff osiris --install is renamed: use bff osiris install", stderr)
        self.assertIn("Osiris dev install path:" + HOME + "/dev (0.2.0) left as is", stdout)
        self.assertEqual(self.installs(), [])

    def test_setup_alias_dry_run_is_the_install_plan(self):
        self.set_plugins()
        code, stdout, _ = self.command(["osiris", "setup", "--dry-run"])
        self.assertEqual(code, 3)  # node/npm are not on this PATH: the private build waits on them
        self.assertIn("bff osiris install plan", stdout)
        self.assertIn("private; built and gated here", stdout)
        self.assertIn("Node: Install Node yourself", stdout)
        self.assertEqual(self.installs(), [])

    def test_run_with_plugin_missing_hints_setup(self):
        self.set_plugins()
        with mock.patch("bff.cli.http.client.HTTPConnection") as connection:
            code, _, stderr = self.command(["osiris"])
        self.assertEqual(code, 1)
        self.assertIn("Osiris plugin not installed: run bff osiris install", stderr)
        connection.assert_not_called()

    def test_run_with_disabled_plugin(self):
        self.set_plugins(entry("git:x@v1", enabled=False, status="disabled"))
        code, _, stderr = self.command(["osiris"])
        self.assertEqual(code, 1)
        self.assertIn("Osiris plugin is disabled: enable it in BB, or run bff osiris install", stderr)

    def test_run_without_bb(self):
        os.environ["PATH"] = "/usr/bin:/bin"
        code, _, stderr = self.command(["osiris"])
        self.assertEqual(code, 1)
        self.assertIn("BB not found: run bff osiris install", stderr)

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
    def test_release_has_compat_and_no_plugin(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("bff_installer", SDK / "install.py")
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        source = self.root / "src"
        source.mkdir()
        for name in ("bff", "templates"):
            shutil.copytree(str(SDK / name), str(source / name), ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copy(str(SDK / "compat.json"), str(source / "compat.json"))
        shutil.copytree(str(SDK / "plugins"), str(source / "plugins"), ignore=shutil.ignore_patterns("node_modules"))
        (source / "README.md").write_text("scratch\n")
        result = installer.install(self.root / "prefix2", source=source)
        release = self.root / "prefix2" / "share" / "bff" / "releases" / result["release"]
        self.assertTrue((release / "compat.json").is_file())
        self.assertTrue((release / "bff" / "osiris.py").is_file())
        self.assertFalse((release / "plugins").exists())

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
        release = self.root / "prefix3" / "share" / "bff" / "releases" / result["release"]
        installer.verify_release(release)
        # Forge an old 0.1.x release: add the bundled plugin, then re-seal the manifest under its new identity.
        (release / "plugins" / "osiris" / "dist").mkdir(parents=True)
        (release / "plugins" / "osiris" / "package.json").write_text("{}")
        (release / "plugins" / "osiris" / "dist" / "app.js").write_text("// prebuilt")
        manifest = json.loads((release / "manifest.json").read_text())
        manifest["files"] = installer.inventory(release)
        manifest["files"].pop("manifest.json")
        old = release.parent / installer.release_id(manifest)
        (release / "manifest.json").write_text(json.dumps(manifest))
        release.rename(old)
        self.assertIn("plugins/osiris/package.json", installer.verify_release(old)["files"])
        (old / "plugins" / "osiris" / "dist" / "app.js.map").write_text("map")
        with self.assertRaises(ValueError):
            installer.verify_release(old)

    def test_no_code_path_installs_the_bundled_plugin(self):
        for module in (SDK / "bff").glob("*.py"):
            text = module.read_text()
            self.assertNotIn("plugins/osiris", text, module.name)
            self.assertNotIn('"plugins" / "osiris"', text, module.name)


if __name__ == "__main__":
    unittest.main()
