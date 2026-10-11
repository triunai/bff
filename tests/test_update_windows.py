"""Simulated-Windows update and rollback: the bff.cmd shim, the Windows layout, the smoke launcher and the hostile-name archive checks.

`system="Windows"` selects the Windows layout on any host; paths.* returns PureWindowsPath, which a POSIX host cannot open, so those three functions are pointed
at the real files of the same layout (prefix/bin/bff.cmd, prefix/releases, prefix/state.json). CI runs the real thing on windows-latest."""
import contextlib
import importlib.util
import io
import io as _io
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

SDK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SDK))
from bff import paths, state, update

spec = importlib.util.spec_from_file_location("bff_installer_for_update_windows", SDK / "install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def copy_repo(destination, marker):
    shutil.copytree(str(SDK), str(destination), ignore=shutil.ignore_patterns(".git", "node_modules", "__pycache__", "*.pyc", "docs", "evidence", "tests"))
    (Path(destination) / "README.md").write_text((Path(destination) / "README.md").read_text(encoding="utf-8") + "\n" + marker + "\n", encoding="utf-8")


class WindowsLayout(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = tempfile.TemporaryDirectory(prefix="bff win update ")
        root = Path(cls.base.name)
        copy_repo(root / "a", "release a")
        copy_repo(root / "b", "release b")
        cls.a, cls.b = root / "a", root / "b"

    @classmethod
    def tearDownClass(cls):
        cls.base.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="bff win prefix ")
        self.addCleanup(self.temporary.cleanup)
        self.prefix = (Path(self.temporary.name) / "data dir").resolve()
        self.first = installer.install(self.prefix, source=self.a, system="Windows")["release"]
        self.second = installer.stage(self.prefix, source=self.b, system="Windows")[0].name
        self.command = self.prefix / "bin" / "bff.cmd"
        self.state_file = self.prefix / "state.json"
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(mock.patch("platform.system", return_value="Windows"))
        stack.enter_context(mock.patch.object(paths, "command_path", return_value=self.command))
        stack.enter_context(mock.patch.object(paths, "releases_dir", return_value=self.prefix / "releases"))
        stack.enter_context(mock.patch.object(paths, "state_path", return_value=self.state_file))

    def test_the_shim_names_the_active_release_and_survives_crlf_and_a_bom_free_read(self):
        self.assertEqual(update._active_id(self.prefix), self.first)
        text = self.command.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("@echo off") or "REM bff-owned release=" in text)
        self.command.write_bytes(text.replace("\n", "\r\n").replace("\r\r\n", "\r\n").encode())
        self.assertEqual(update._active_id(self.prefix), self.first)

    def test_rollback_flips_the_shim_both_ways_and_records_state(self):
        state.update(self.state_file, lambda d: d.update(bff={"active": self.first, "previous": self.second}))
        installer.activate(self.prefix / "releases" / self.first, self.prefix, system="Windows")
        out = []
        result = update.rollback(prefix=self.prefix, state_file=self.state_file, yes=True, out=out.append)
        self.assertTrue(result["changed"])
        self.assertEqual((result["from"], result["to"]), (self.first, self.second))
        self.assertEqual(update._active_id(self.prefix), self.second)
        self.assertEqual(state.load(self.state_file)["bff"], {"active": self.second, "previous": self.first})
        update.rollback(prefix=self.prefix, state_file=self.state_file, yes=True, out=out.append)
        self.assertEqual(update._active_id(self.prefix), self.first)
        self.assertEqual([p.name for p in (self.prefix / "bin").iterdir()], ["bff.cmd"])  # no temp link left behind

    def test_rollback_without_consent_changes_nothing(self):
        state.update(self.state_file, lambda d: d.update(bff={"active": self.first, "previous": self.second}))
        before = self.command.read_bytes()
        result = update.rollback(prefix=self.prefix, state_file=self.state_file, stdin=io.StringIO(""), out=lambda line: None)
        self.assertFalse(result["changed"])
        self.assertEqual(self.command.read_bytes(), before)

    def test_a_tampered_target_release_is_refused_and_the_shim_is_untouched(self):
        state.update(self.state_file, lambda d: d.update(bff={"active": self.first, "previous": self.second}))
        (self.prefix / "releases" / self.second / "bin" / "bff.cmd").write_bytes(b"@echo pwned\r\n")
        before = self.command.read_bytes()
        with self.assertRaises(update.UpdateError):
            update.rollback(prefix=self.prefix, state_file=self.state_file, yes=True, out=lambda line: None)
        self.assertEqual(self.command.read_bytes(), before)

    def test_manual_fallback_uses_python_not_python3_on_windows(self):
        with mock.patch.object(update, "_load_installer", return_value=None):
            with self.assertRaises(update.UpdateError) as caught:
                update.rollback(prefix=self.prefix, state_file=self.state_file, yes=True, out=lambda line: None)
        self.assertIn("run: python ", str(caught.exception))
        self.assertNotIn("python3", str(caught.exception))
        self.assertEqual(update.python_command("Linux"), "python3")

    def test_the_smoke_test_runs_the_staged_bff_cmd_on_windows_and_bff_elsewhere(self):
        staged = self.prefix / "releases" / self.second
        with mock.patch.object(update, "_smoke_version", return_value="bff 9.9.9") as smoke:
            update._smoke(staged, "9.9.9", system="Windows")
            self.assertEqual(smoke.call_args[0][0], staged / "bin" / "bff.cmd")
            update._smoke(staged, "9.9.9", system="Linux")
            self.assertEqual(smoke.call_args[0][0], staged / "bin" / "bff")
        with mock.patch.object(update, "_smoke_version", return_value="bff 1.0.0"):
            with self.assertRaises(update.UpdateError):
                update._smoke(staged, "9.9.9", system="Windows")

    def test_the_plugin_step_runs_the_new_bff_cmd_with_its_own_location_policy(self):
        calls = []
        result = update.plugin_step(self.prefix, run=lambda argv, **kw: calls.append(argv) or mock.Mock(returncode=0, stdout="", stderr=""),
                                    which=lambda name: "C:\\bin\\bb.exe", out=lambda line: None)
        self.assertEqual(result, "ok")
        self.assertEqual(calls[0], [str(self.command), "osiris", "update", "--yes"])


class HostileArchiveNames(unittest.TestCase):
    def archive(self, names):
        directory = Path(tempfile.mkdtemp(prefix="bff win tar "))
        self.addCleanup(shutil.rmtree, str(directory), True)
        path = directory / "bff-1.0.0.tar.gz"
        with tarfile.open(str(path), "w:gz") as tf:
            for name in names:
                info = tarfile.TarInfo(name)
                info.size = 1
                tf.addfile(info, _io.BytesIO(b"x"))
        return path, directory / "x"

    def test_names_that_mean_something_to_ntfs_are_refused_on_every_os(self):
        for bad in ("bff-1.0.0/a:b", "bff-1.0.0/C:\\evil", "bff-1.0.0/sub\\..\\..\\evil", "bff-1.0.0/NUL", "bff-1.0.0/aux.txt", "bff-1.0.0/trailing.", "bff-1.0.0/space "):
            archive, dest = self.archive([bad])
            with self.assertRaisesRegex(update.UpdateError, "unsafe entry", msg=bad):
                update.safe_extract(archive, dest, "bff-1.0.0")

    def test_ordinary_release_names_still_extract(self):
        archive, dest = self.archive(["bff-1.0.0/bin/bff.cmd", "bff-1.0.0/plugins/osiris/bin/osiris-tui.mjs", "bff-1.0.0/README.md"])
        self.assertTrue((update.safe_extract(archive, dest, "bff-1.0.0") / "bin" / "bff.cmd").is_file())


if __name__ == "__main__":
    unittest.main()
