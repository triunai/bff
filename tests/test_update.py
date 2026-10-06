import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

SDK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SDK))
sys.path.insert(0, str(SDK / "scripts"))
from bff import __version__, cli, paths, state, update
import versioning

spec = importlib.util.spec_from_file_location("bff_installer_for_update", SDK / "install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

OLD = __version__
NEW = ".".join(OLD.split(".")[:2] + [str(int(OLD.split(".")[2]) + 1)])
GH_OK = "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{rec}'\nexit 0\n"
GH_BAD = "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{rec}'\necho 'no attestation' >&2\nexit 1\n"


def copy_repo(destination):
    shutil.copytree(str(SDK), str(destination), ignore=shutil.ignore_patterns(
        ".git", "node_modules", "__pycache__", "*.pyc"))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Fixture(unittest.TestCase):
    """A real current release installed per test, and a real newer release served from a file:// dir."""

    @classmethod
    def setUpClass(cls):
        cls.base_dir = tempfile.TemporaryDirectory(prefix="bff update fixtures ")
        root = Path(cls.base_dir.name)
        cls.current_src = root / "current"
        copy_repo(cls.current_src)
        newer = root / "newer"
        copy_repo(newer)
        versioning.apply_version(newer, NEW)
        changelog = newer / "CHANGELOG.md"
        changelog.write_text(changelog.read_text().replace(
            "## [Unreleased]", "## [Unreleased]\n\n## [" + NEW + "] - 2026-10-06\n\n### Added\n- Synthetic change line.\n", 1))
        built = root / "built"
        subprocess.run([sys.executable, str(newer / "scripts" / "build-bff-release.py"), "--output", str(built)],
                       check=True, stdout=subprocess.PIPE)
        cls.template_srv = root / "srv"
        (cls.template_srv / "latest" / "download").mkdir(parents=True)
        (cls.template_srv / "download" / ("v" + NEW)).mkdir(parents=True)
        shutil.copy(str(built / "SHA256SUMS"), str(cls.template_srv / "latest" / "download" / "SHA256SUMS"))
        for name in ("bff-" + NEW + ".tar.gz", "SHA256SUMS"):
            shutil.copy(str(built / name), str(cls.template_srv / "download" / ("v" + NEW) / name))

    @classmethod
    def tearDownClass(cls):
        cls.base_dir.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="bff update test ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.prefix = self.root / "prefix"
        installer.install(self.prefix, source=self.current_src)
        self.srv = self.root / "srv"
        shutil.copytree(str(self.template_srv), str(self.srv))
        self.base = "file://" + str(self.srv)
        self.bin = self.root / "fakebin"
        self.bin.mkdir()
        self.state_file = Path(str(paths.state_path(prefix=self.prefix)))

    def fake_gh(self, ok):
        record = self.root / ("gh-ok.argv" if ok else "gh-bad.argv")
        script = self.bin / ("gh-ok" if ok else "gh-bad")
        script.write_text((GH_OK if ok else GH_BAD).format(rec=str(record)))
        script.chmod(0o755)
        return script, record

    def snapshot(self):
        link = self.prefix / "bin" / "bff"
        releases = Path(str(paths.releases_dir(prefix=self.prefix)))
        stored = self.state_file.read_bytes() if self.state_file.exists() else None
        return os.readlink(str(link)), stored, sorted(entry.name for entry in releases.iterdir())

    def version(self):
        return subprocess.run([str(self.prefix / "bin" / "bff"), "--version"], stdout=subprocess.PIPE,
                              universal_newlines=True, check=True).stdout.strip()

    def update(self, **kwargs):
        kwargs.setdefault("gh", False)
        kwargs.setdefault("out", lambda line: None)
        return update.apply_update(NEW, prefix=self.prefix, base=self.base, **kwargs)

    def assertUnchanged(self, before):
        self.assertEqual(self.version(), "bff " + OLD)
        self.assertEqual(self.snapshot(), before)

    def tarball(self):
        return self.srv / "download" / ("v" + NEW) / ("bff-" + NEW + ".tar.gz")

    def rewrite_sums(self):
        sums = self.srv / "download" / ("v" + NEW) / "SHA256SUMS"
        sums.write_text(sha(self.tarball()) + "  " + self.tarball().name + "\n")


class UpdateFlow(Fixture):
    def test_happy_path_without_gh(self):
        lines = []
        result = self.update(out=lines.append)
        self.assertEqual(self.version(), "bff " + NEW)
        self.assertIn(update.NO_ATTESTATION, lines)
        self.assertFalse(result["attested"])
        self.assertEqual(result["version"], NEW)
        self.assertTrue(result["to"].startswith(NEW + "-"))
        self.assertTrue(result["from"].startswith(OLD + "-"))
        self.assertIn("Synthetic change line.", result["changes"])
        self.assertLessEqual(len(result["changes"].splitlines()), 15)
        data = state.load(self.state_file)
        self.assertEqual(data["bff"], {"active": result["to"], "previous": result["from"]})
        self.assertEqual(data["method"], "script")
        self.assertEqual(data["update_check"]["current"], NEW)
        self.assertFalse(data["update_check"]["available"])
        self.assertTrue((Path(str(paths.releases_dir(prefix=self.prefix))) / result["to"] / "install.py").is_file())

    def test_happy_path_with_attestation_records_exact_argv(self):
        gh, record = self.fake_gh(True)
        result = self.update(gh=str(gh))
        self.assertTrue(result["attested"])
        argv = record.read_text().split("\n")[:-1]
        self.assertTrue(argv[2].endswith("bff-" + NEW + ".tar.gz"))
        self.assertEqual(argv[:2] + argv[3:], [
            "attestation", "verify", "-R", "triunai/bff",
            "--signer-workflow", "triunai/bff/.github/workflows/release.yml",
            "--source-ref", "refs/tags/v" + NEW])
        self.assertEqual(self.version(), "bff " + NEW)

    def test_state_other_fields_survive(self):
        state.update(self.state_file, lambda d: d.update({"config": {"update": {"check": False}}, "future": [1]}))
        self.update()
        data = state.load(self.state_file)
        self.assertEqual(data["config"], {"update": {"check": False}})
        self.assertEqual(data["future"], [1])

    def test_tampered_tarball_changes_nothing(self):
        before = self.snapshot()
        data = bytearray(self.tarball().read_bytes())
        data[len(data) // 2] ^= 0xFF
        self.tarball().write_bytes(bytes(data))
        with self.assertRaisesRegex(update.UpdateError, "checksum"):
            self.update()
        self.assertUnchanged(before)

    def test_failed_attestation_changes_nothing(self):
        gh, record = self.fake_gh(False)
        before = self.snapshot()
        with self.assertRaisesRegex(update.UpdateError, "attestation failed"):
            self.update(gh=str(gh))
        self.assertTrue(record.exists())
        self.assertUnchanged(before)

    def test_require_attestation_without_gh_changes_nothing(self):
        before = self.snapshot()
        with self.assertRaisesRegex(update.UpdateError, "attestation required"):
            self.update(require_attestation=True)
        self.assertUnchanged(before)

    def test_failed_state_write_and_failed_restore_keep_the_linked_release(self):
        # After the flip, if the state write fails AND switching back fails, the link still points
        # at the new release: deleting it would leave bin/bff dangling.
        real = update._run_installer
        def installer_run(python, script, prefix, flag, value=None):
            if flag == "--activate" and value is not None and not value.startswith(NEW + "-"):
                raise OSError("simulated restore failure")
            return real(python, script, prefix, flag, value)
        with mock.patch.object(update, "_record", side_effect=OSError("simulated state failure")), \
                mock.patch.object(update, "_run_installer", side_effect=installer_run):
            with self.assertRaises(OSError):
                self.update()
        self.assertEqual(self.version(), "bff " + NEW)

    def test_installer_and_smoke_never_inherit_the_terminal(self):
        # Found by a real-pty run: the new installer's D7 PATH offer prompted on the inherited TTY
        # while its stderr was captured, so `bff update` hung on a question nobody could see.
        real, calls = subprocess.run, []
        def recording_run(*args, **kwargs):
            calls.append((args[0], kwargs.get("stdin")))
            return real(*args, **kwargs)
        with mock.patch.object(update.subprocess, "run", side_effect=recording_run):
            self.update()
        children = [stdin for argv, stdin in calls if "--stage-only" in argv or "--activate" in argv
                    or "--version" in argv]
        self.assertEqual(len(children), 3, calls)
        self.assertTrue(all(stdin is subprocess.DEVNULL for stdin in children), calls)

    def _activate_then_fail(self, restore_fails):
        real = update._run_installer
        def installer_run(python, script, prefix, flag, value=None):
            if flag == "--activate" and value is not None and value.startswith(NEW + "-"):
                real(python, script, prefix, flag, value)
                raise update.UpdateError("simulated failure after the link was swapped")
            if flag == "--activate" and restore_fails:
                raise OSError("simulated restore failure")
            return real(python, script, prefix, flag, value)
        with mock.patch.object(update, "_run_installer", side_effect=installer_run):
            with self.assertRaises(update.UpdateError):
                self.update()

    def test_activate_that_swaps_then_fails_is_rolled_back(self):
        # The live failure: the installer swapped the link, then exited non-zero; the updater thought
        # nothing had flipped, deleted the new release and left bin/bff dangling.
        before = self.snapshot()
        self._activate_then_fail(restore_fails=False)
        self.assertUnchanged(before)

    def test_activate_that_swaps_then_fails_without_restore_keeps_a_working_bff(self):
        self._activate_then_fail(restore_fails=True)
        self.assertEqual(self.version(), "bff " + NEW)

    def test_existing_state_bytes_are_untouched_on_failure(self):
        state.update(self.state_file, lambda d: d.update({"bff": {"active": "x", "previous": None}}))
        before = self.snapshot()
        gh, _ = self.fake_gh(False)
        with self.assertRaises(update.UpdateError):
            self.update(gh=str(gh))
        self.assertUnchanged(before)
        self.assertIsNotNone(before[1])

    def build_archive(self, members):
        with tarfile.open(str(self.tarball()), "w:gz") as tf:
            for name, kind, payload in members:
                info = tarfile.TarInfo(name)
                if kind == "symlink":
                    info.type, info.linkname = tarfile.SYMTYPE, payload
                    tf.addfile(info)
                else:
                    info.size = len(payload)
                    tf.addfile(info, io.BytesIO(payload))
        self.rewrite_sums()

    def test_unsafe_archives_change_nothing(self):
        root = "bff-" + NEW
        cases = {
            "parent traversal": [(root + "/../x", "file", b"x")],
            "symlink member": [(root + "/install.py", "symlink", "/etc/passwd")],
            "absolute path": [("/" + root + "/x", "file", b"x")],
            "wrong root": [("other/x", "file", b"x")],
            "duplicate": [(root + "/x", "file", b"1"), (root + "/x", "file", b"2")],
        }
        for label, members in cases.items():
            with self.subTest(label):
                before = self.snapshot()
                self.build_archive(members)
                with self.assertRaisesRegex(update.UpdateError, "unsafe|escapes"):
                    self.update()
                self.assertUnchanged(before)

    def test_manifest_tampering_is_caught_by_the_installer(self):
        before = self.snapshot()
        extracted = self.root / "tamper"
        update.safe_extract(self.tarball(), extracted, "bff-" + NEW)
        (extracted / ("bff-" + NEW) / "bff" / "cli.py").write_text("# changed\n")
        with tarfile.open(str(self.tarball()), "w:gz") as tf:
            tf.add(str(extracted / ("bff-" + NEW)), arcname="bff-" + NEW)
        self.rewrite_sums()
        with self.assertRaisesRegex(update.UpdateError, "refused"):
            self.update()
        self.assertUnchanged(before)

    def test_smoke_failure_removes_the_staged_release(self):
        before = self.snapshot()
        with mock.patch.object(update, "_smoke_version", return_value="bff 9.9.9"):
            with self.assertRaisesRegex(update.UpdateError, "smoke test failed"):
                self.update()
        self.assertUnchanged(before)

    def test_smoke_failure_keeps_a_release_that_already_existed(self):
        self.update()
        releases = Path(str(paths.releases_dir(prefix=self.prefix)))
        existing = sorted(entry.name for entry in releases.iterdir())
        with mock.patch.object(update, "_smoke_version", return_value=None):
            with self.assertRaises(update.UpdateError):
                self.update()
        self.assertEqual(sorted(entry.name for entry in releases.iterdir()), existing)

    def test_bad_version_string_is_refused(self):
        with self.assertRaises(update.UpdateError):
            update.apply_update("1.2.3/../x", prefix=self.prefix, base=self.base, gh=False)

    def test_missing_download_changes_nothing(self):
        before = self.snapshot()
        shutil.rmtree(str(self.srv / "download"))
        with self.assertRaisesRegex(update.UpdateError, "download failed"):
            self.update()
        self.assertUnchanged(before)


class PluginStep(Fixture):
    def test_without_bb_it_skips_and_runs_nothing(self):
        lines, calls = [], []
        outcome = update.plugin_step(self.prefix, run=lambda *a, **k: calls.append(a), which=lambda name: None,
                                     out=lines.append)
        self.assertEqual((outcome, calls), ("skipped", []))
        self.assertEqual(lines, ["Osiris plugin: skipped (BB not found)"])

    def test_exit_codes_map_to_outcomes_and_argv_is_the_new_bff(self):
        for code, expected in ((0, "ok"), (3, "waiting"), (1, "failed"), (7, "failed")):
            with self.subTest(code):
                calls, lines = [], []

                def run(argv, **kwargs):
                    calls.append((argv, kwargs))
                    return subprocess.CompletedProcess(argv, code, stdout="from osiris\n", stderr="")
                outcome = update.plugin_step(self.prefix, run=run, which=lambda name: "/fake/bb", out=lines.append)
                self.assertEqual(outcome, expected)
                self.assertEqual(calls[0][0], [str(self.prefix / "bin" / "bff"), "osiris", "update", "--yes"])
                self.assertEqual(calls[0][1]["timeout"], 900)
                self.assertIn("from osiris", lines)
                self.assertEqual("bff itself is updated" in "".join(lines), expected == "failed")

    def test_it_never_raises(self):
        for error in (OSError("gone"), subprocess.TimeoutExpired("bff", 900), RuntimeError("boom")):
            with self.subTest(type(error).__name__):
                def run(argv, **kwargs):
                    raise error
                lines = []
                outcome = update.plugin_step(self.prefix, run=run, which=lambda name: "/fake/bb", out=lines.append)
                self.assertEqual(outcome, "failed")
                self.assertIn("Retry: bff osiris update", " ".join(lines))

    def test_default_which_is_resolved_at_call_time(self):
        with mock.patch.object(update.shutil, "which", return_value=None):
            self.assertEqual(update.plugin_step(self.prefix, out=lambda line: None), "skipped")


class ApplyWithPlugin(Fixture):
    def test_plugin_step_runs_after_the_flip_with_the_new_binary_path(self):
        order = []

        def step(prefix, out=None):
            order.append(("plugin", self.version(), Path(prefix) / "bin" / "bff"))
            return "waiting"
        with mock.patch.object(update, "plugin_step", side_effect=step) as patched:
            result = update.apply_with_plugin(NEW, prefix=self.prefix, base=self.base, gh=False,
                                              out=lambda line: None)
        self.assertEqual(order, [("plugin", "bff " + NEW, self.prefix / "bin" / "bff")])
        self.assertEqual(patched.call_count, 1)
        self.assertEqual(result["plugin"], "waiting")
        self.assertEqual(result["version"], NEW)

    def test_the_real_step_runs_the_flipped_launcher(self):
        seen = []

        def run(argv, **kwargs):
            seen.append((argv, subprocess.run([argv[0], "--version"], stdout=subprocess.PIPE,
                                              universal_newlines=True).stdout.strip()))
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
        real = update.plugin_step
        with mock.patch.object(update, "plugin_step",
                               side_effect=lambda prefix, out=None: real(prefix, run=run, which=lambda n: "/fake/bb", out=out)):
            result = update.apply_with_plugin(NEW, prefix=self.prefix, base=self.base, gh=False, out=lambda line: None)
        self.assertEqual(result["plugin"], "ok")
        self.assertEqual(seen[0][0], [str(self.prefix / "bin" / "bff"), "osiris", "update", "--yes"])
        self.assertEqual(seen[0][1], "bff " + NEW)

    def test_a_failed_bff_update_never_runs_the_plugin_step(self):
        before = self.snapshot()
        data = bytearray(self.tarball().read_bytes())
        data[len(data) // 2] ^= 0xFF
        self.tarball().write_bytes(bytes(data))
        with mock.patch.object(update, "plugin_step") as patched:
            with self.assertRaisesRegex(update.UpdateError, "checksum"):
                update.apply_with_plugin(NEW, prefix=self.prefix, base=self.base, gh=False, out=lambda line: None)
        patched.assert_not_called()
        self.assertUnchanged(before)


class Rollback(Fixture):
    def test_rollback_toggles(self):
        result = self.update()
        out = []
        back = update.rollback(prefix=self.prefix, state_file=self.state_file, yes=True, out=out.append)
        self.assertTrue(back["changed"])
        self.assertEqual(self.version(), "bff " + OLD)
        self.assertEqual(state.load(self.state_file)["bff"], {"active": result["from"], "previous": result["to"]})
        update.rollback(prefix=self.prefix, state_file=self.state_file, yes=True, out=out.append)
        self.assertEqual(self.version(), "bff " + NEW)
        self.assertEqual(state.load(self.state_file)["bff"], {"active": result["to"], "previous": result["from"]})

    def test_no_state_falls_back_to_newest_other_release_and_needs_consent(self):
        self.update()
        self.state_file.unlink()
        before = self.snapshot()
        out = []
        result = update.rollback(prefix=self.prefix, state_file=self.state_file, stdin=io.StringIO(""), out=out.append)
        self.assertFalse(result["changed"])
        self.assertEqual(self.snapshot(), before)
        self.assertTrue(any("newest other release" in line for line in out))
        update.rollback(prefix=self.prefix, state_file=self.state_file, yes=True, out=out.append)
        self.assertEqual(self.version(), "bff " + OLD)

    def test_rollback_without_another_release_is_an_error(self):
        with self.assertRaisesRegex(update.UpdateError, "no other verified release"):
            update.rollback(prefix=self.prefix, state_file=self.state_file, yes=True, out=lambda line: None)

    def test_interactive_decline_changes_nothing(self):
        self.update()
        before = self.snapshot()

        class Tty(io.StringIO):
            def isatty(self):
                return True
        result = update.rollback(prefix=self.prefix, state_file=self.state_file, stdin=Tty("n\n"), out=lambda line: None)
        self.assertFalse(result["changed"])
        self.assertEqual(self.snapshot(), before)

    def test_eof_is_not_consent(self):
        self.update()
        before = self.snapshot()

        class Tty(io.StringIO):
            def isatty(self):
                return True
        result = update.rollback(prefix=self.prefix, state_file=self.state_file, stdin=Tty(""), out=lambda line: None)
        self.assertFalse(result["changed"])
        self.assertEqual(self.snapshot(), before)

    def test_missing_running_installer_gives_the_manual_fallback(self):
        self.update()
        with mock.patch.object(update, "_load_installer", return_value=None):
            with self.assertRaisesRegex(update.UpdateError, "--activate"):
                update.rollback(prefix=self.prefix, state_file=self.state_file, yes=True, out=lambda line: None)


class Engine(unittest.TestCase):
    def serve(self, text):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name) / "latest" / "download"
        directory.mkdir(parents=True)
        if text is not None:
            (directory / "SHA256SUMS").write_text(text)
        return "file://" + temporary.name

    def test_latest_version(self):
        line = "a" * 64 + "  bff-1.2.3.tar.gz\n"
        self.assertEqual(update.latest_version(self.serve(line)), "1.2.3")
        self.assertIsNone(update.latest_version(self.serve(None)))
        self.assertIsNone(update.latest_version(self.serve("garbage\n")))
        self.assertIsNone(update.latest_version(self.serve(line + "b" * 64 + "  bff-1.2.4.tar.gz\n")))
        self.assertIsNone(update.latest_version(self.serve("a" * 64 + "  bff-x.y.z.tar.gz\n")))
        self.assertIsNone(update.latest_version(self.serve("")))
        self.assertIsNone(update.latest_version("file:///nonexistent-dir-for-bff-tests"))

    def test_latest_version_survives_an_opener_that_explodes(self):
        def boom(url, timeout=None):
            raise RuntimeError("offline")
        self.assertIsNone(update.latest_version("https://example.invalid", opener=boom))

    def test_release_base(self):
        self.assertEqual(update.release_base({}), update.DEFAULT_BASE)
        self.assertEqual(update.release_base({"BFF_RELEASE_BASE": "file:///tmp/x/"}), "file:///tmp/x")
        self.assertEqual(update.release_base({"BFF_RELEASE_BASE": "https://example.com/r"}), "https://example.com/r")
        for bad in ("http://example.com", "ftp://example.com", "/tmp/x"):
            with self.assertRaises(ValueError):
                update.release_base({"BFF_RELEASE_BASE": bad})

    def test_install_prefix(self):
        prefix = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, str(prefix))
        package = prefix / "share" / "bff" / "releases" / "1.2.3-0123456789ab" / "bff"
        package.mkdir(parents=True)
        self.assertEqual(paths.install_prefix(str(package / "__init__.py")), prefix)
        self.assertIsNone(paths.install_prefix(str(prefix / "share" / "bff" / "releases" / "not-a-release" / "bff" / "x.py")))
        self.assertIsNone(paths.install_prefix(str(SDK / "bff" / "__init__.py")))

    def test_active_state_path_follows_the_running_install(self):
        # update, the daily notice, bff config and bff osiris must all share ONE state file.
        prefix = Path(tempfile.mkdtemp()).resolve() / "custom prefix"
        self.addCleanup(shutil.rmtree, str(prefix.parent))
        package = prefix / "share" / "bff" / "releases" / ("0.2.0-" + "a" * 12) / "bff"
        package.mkdir(parents=True)
        self.assertEqual(paths.active_state_path(str(package / "__init__.py")),
                         paths.state_path(prefix=prefix))
        dev = paths.active_state_path(str(SDK / "bff" / "__init__.py"), env={"BFF_PREFIX": str(prefix)})
        self.assertEqual(dev, paths.state_path(prefix=prefix))


class StageOnly(Fixture):
    def run_installer(self, *args):
        return subprocess.run([sys.executable, str(self.current_src / "install.py"), "--prefix", str(self.prefix)]
                              + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)

    def test_stage_only_does_not_activate_and_reports_created(self):
        other = self.root / "other"
        first = subprocess.run([sys.executable, str(self.current_src / "install.py"), "--prefix", str(other),
                                "--stage-only"], stdout=subprocess.PIPE, universal_newlines=True, check=True)
        info = json.loads(first.stdout)
        self.assertTrue(info["created"])
        self.assertFalse((other / "bin" / "bff").exists())
        self.assertTrue((Path(info["path"]) / "install.py").is_file())
        again = json.loads(subprocess.run([sys.executable, str(self.current_src / "install.py"), "--prefix", str(other),
                                           "--stage-only"], stdout=subprocess.PIPE, universal_newlines=True,
                                          check=True).stdout)
        self.assertFalse(again["created"])
        self.assertEqual(again["release"], info["release"])

    def test_stage_only_is_exclusive(self):
        for flag in (["--activate", "1.2.3-0123456789ab"], ["--disable"]):
            self.assertEqual(self.run_installer("--stage-only", *flag).returncode, 2)

    def test_release_without_install_py_still_verifies(self):
        source = self.root / "legacy"
        copy_repo(source)
        (source / "install.py").unlink()
        legacy = self.root / "legacy-prefix"
        installer.install(legacy, source=source)
        release = next(Path(str(paths.releases_dir(prefix=legacy))).iterdir())
        self.assertFalse((release / "install.py").exists())
        installer.verify_release(release)


class Commands(Fixture):
    def run_cli(self, args, env=None, prefix=True, method="script", which=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        patches = [mock.patch.dict(os.environ, env or {}),
                   mock.patch.object(paths, "install_prefix", return_value=self.prefix if prefix else None),
                   mock.patch.object(paths, "install_method", return_value=method),
                   mock.patch.object(update.shutil, "which", return_value=which)]
        with contextlib.ExitStack() as stack:
            for item in patches:
                stack.enter_context(item)
            stack.enter_context(contextlib.redirect_stdout(stdout))
            stack.enter_context(contextlib.redirect_stderr(stderr))
            code = cli.main(args)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_check_reports_and_records(self):
        code, out, _ = self.run_cli(["update", "--check"], {"BFF_RELEASE_BASE": self.base})
        self.assertEqual(code, 0)
        self.assertIn("bff " + OLD + " -> " + NEW, out)
        self.assertIn("release source: " + self.base, out)
        check = state.load(self.state_file)["update_check"]
        self.assertEqual((check["current"], check["latest"], check["available"]), (OLD, NEW, True))
        self.assertRegex(check["checked_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d")

    def test_update_prompt_eof_is_not_consent(self):
        class Tty(io.StringIO):
            def isatty(self):
                return True
        before = os.readlink(str(self.prefix / "bin" / "bff"))
        with mock.patch.object(sys, "stdin", Tty("")), \
                mock.patch.object(update, "apply_with_plugin", side_effect=AssertionError("applied on EOF")) as applied:
            code, out, _ = self.run_cli(["update"], {"BFF_RELEASE_BASE": self.base})
        applied.assert_not_called()
        self.assertEqual(code, 0)
        self.assertIn("cancelled", out)
        self.assertEqual(os.readlink(str(self.prefix / "bin" / "bff")), before)

    def test_check_up_to_date_and_unknown(self):
        (self.srv / "latest" / "download" / "SHA256SUMS").write_text("a" * 64 + "  bff-" + OLD + ".tar.gz\n")
        code, out, _ = self.run_cli(["update", "--check"], {"BFF_RELEASE_BASE": self.base})
        self.assertIn("bff " + OLD + " is up to date", out)
        shutil.rmtree(str(self.srv / "latest"))
        code, out, _ = self.run_cli(["update", "--check"], {"BFF_RELEASE_BASE": self.base})
        self.assertEqual(code, 0)
        self.assertIn("latest release unknown (offline?)", out)

    def test_update_yes_switches_and_prints_undo(self):
        code, out, err = self.run_cli(["update", "--yes"], {"BFF_RELEASE_BASE": self.base})
        self.assertEqual((code, err), (0, ""))
        self.assertIn(OLD + " -> " + NEW, out)
        self.assertIn("undo: bff rollback", out)
        self.assertIn("Synthetic change line.", out)
        self.assertEqual(self.version(), "bff " + NEW)

    def test_update_without_tty_or_yes_only_prints_the_plan(self):
        before = self.snapshot()
        code, out, _ = self.run_cli(["update"], {"BFF_RELEASE_BASE": self.base})
        self.assertEqual(code, 0)
        self.assertIn(OLD + " -> " + NEW, out)
        self.assertEqual(self.snapshot(), before)

    def test_update_failure_exits_2_and_changes_nothing(self):
        before = self.snapshot()
        data = bytearray(self.tarball().read_bytes())
        data[100] ^= 0xFF
        self.tarball().write_bytes(bytes(data))
        code, _, err = self.run_cli(["update", "--yes"], {"BFF_RELEASE_BASE": self.base})
        self.assertEqual(code, 2)
        self.assertIn("checksum", err)
        self.assertUnchanged(before)

    def test_bad_release_base_exits_2(self):
        code, _, err = self.run_cli(["update", "--check"], {"BFF_RELEASE_BASE": "http://example.com"})
        self.assertEqual(code, 2)
        self.assertIn("https://", err)

    def test_method_gates(self):
        expected = {"dev": "this is a source checkout; update it with git pull", "uv": "uv tool upgrade bff",
                    "brew": "brew upgrade bff",
                    "unknown": "curl -fsSLO https://github.com/triunai/bff/releases/latest/download/install.sh && sh install.sh"}
        for method, line in expected.items():
            with self.subTest(method):
                code, out, _ = self.run_cli(["update"], prefix=False, method=method)
                self.assertEqual(code, 1)
                self.assertIn(line, out)
                self.assertNotIn("| sh", out)
        code, out, _ = self.run_cli(["rollback", "--self", "--yes"], prefix=False, method="dev")
        self.assertEqual(code, 1)
        self.assertIn("only applies to installs made by install.sh", out)

    def test_dev_checkout_without_patches_is_gated(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = cli.main(["update"])
        self.assertEqual(code, 1)

    def test_rollback_command(self):
        self.run_cli(["update", "--yes"], {"BFF_RELEASE_BASE": self.base})
        code, out, err = self.run_cli(["rollback", "--yes"])
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(self.version(), "bff " + OLD)

    def run_with(self, args, patches=(), prefix=True, env=None, which=None):
        with contextlib.ExitStack() as stack:
            for item in patches:
                stack.enter_context(item)
            return self.run_cli(args, env=env, prefix=prefix, which=which)

    def rollback_run(self, args, plugin_rc=0, previous=True, bb="/fake/bb", prefix=True, self_error=None):
        order = []
        data = {"plugin": {"previous_source": "path:/x"}} if previous else {}
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        self.state_file.write_text(json.dumps(data))

        def self_side(**kwargs):
            order.append("self")
            if self_error:
                raise self_error
        patches = [mock.patch.object(paths, "active_state_path", return_value=self.state_file),
                   mock.patch.object(cli.osiris, "rollback_plugin",
                                     side_effect=lambda *a, **k: order.append("plugin") or plugin_rc),
                   mock.patch.object(update, "rollback", side_effect=self_side)]
        code, out, err = self.run_with(args, patches, prefix=prefix, which=bb)
        return code, out, err, order

    def test_rollback_defaults_to_both_plugin_first(self):
        code, _, _, order = self.rollback_run(["rollback", "--yes"])
        self.assertEqual((code, order), (0, ["plugin", "self"]))

    def test_rollback_self_and_plugin_choose_one(self):
        self.assertEqual(self.rollback_run(["rollback", "--self", "--yes"])[::3], (0, ["self"]))
        self.assertEqual(self.rollback_run(["rollback", "--plugin", "--yes"])[::3], (0, ["plugin"]))

    def test_rollback_self_and_plugin_together_is_a_usage_error(self):
        with self.assertRaises(SystemExit) as raised:
            self.rollback_run(["rollback", "--self", "--plugin"])
        self.assertEqual(raised.exception.code, 2)

    def test_rollback_without_a_previous_plugin_source_is_success(self):
        code, out, _, order = self.rollback_run(["rollback", "--plugin", "--yes"], previous=False)
        self.assertEqual((code, order), (0, []))
        self.assertIn("Osiris plugin: no previous source recorded", out)
        code, _, _, order = self.rollback_run(["rollback", "--yes"], previous=False)
        self.assertEqual((code, order), (0, ["self"]))

    def test_rollback_exit_is_1_if_any_requested_part_failed(self):
        code, _, _, order = self.rollback_run(["rollback", "--yes"], plugin_rc=1)
        self.assertEqual((code, order), (1, ["plugin", "self"]))

    def test_rollback_plugin_only_without_bb_is_1(self):
        code, out, _, order = self.rollback_run(["rollback", "--plugin", "--yes"], bb=None)
        self.assertEqual((code, order), (1, []))
        self.assertIn("BB not found", out)

    def test_rollback_both_without_bb_skips_the_plugin_and_rolls_back_bff(self):
        code, out, _, order = self.rollback_run(["rollback", "--yes"], bb=None)
        self.assertEqual((code, order), (0, ["self"]))
        self.assertIn("Osiris plugin: skipped (BB not found)", out)

    def test_rollback_both_on_a_non_script_install_skips_self(self):
        code, out, _, order = self.rollback_run(["rollback", "--yes"], prefix=False)
        self.assertEqual((code, order), (0, ["plugin"]))
        self.assertIn("bff itself: skipped", out)
        code, _, _, order = self.rollback_run(["rollback", "--self", "--yes"], prefix=False)
        self.assertEqual((code, order), (1, []))

    def test_update_exit_1_when_the_plugin_failed_but_bff_is_updated(self):
        real = update.plugin_step
        step = mock.patch.object(update, "plugin_step", side_effect=lambda prefix, out=None: real(
            prefix, run=lambda argv, **k: subprocess.CompletedProcess(argv, 1, stdout="", stderr=""),
            which=lambda n: "/fake/bb", out=out))
        code, out, _ = self.run_with(["update", "--yes"], [step], env={"BFF_RELEASE_BASE": self.base})
        self.assertEqual(code, 1)
        self.assertIn("bff itself is updated", out)
        self.assertEqual(self.version(), "bff " + NEW)

    def test_update_exit_0_when_the_plugin_is_waiting(self):
        step = mock.patch.object(update, "plugin_step", return_value="waiting")
        code, _, _ = self.run_with(["update", "--yes"], [step], env={"BFF_RELEASE_BASE": self.base})
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
