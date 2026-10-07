"""Native Windows install logic, simulated: pure functions plus real file operations under a temp prefix.

`system="Windows"` selects the Windows layout and shim on any host, so the stage / activate / disable /
ownership / update-id paths run for real here. What this cannot prove (cmd.exe running the shim, os.replace on a
file that is open, PATH edits) is listed in CHANGELOG.md.
"""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import install as installer  # noqa: E402
from bff import paths, update  # noqa: E402

HEX = "0123456789ab"
RELEASE = "0.1.1-" + HEX


class Launcher(unittest.TestCase):
    def test_release_launcher_finds_itself_and_has_no_marker(self):
        text = installer.windows_launcher("C:\\Py\\python.exe").decode()
        self.assertTrue(text.startswith("@echo off\r\n"))
        self.assertIn('"C:\\Py\\python.exe" -c "', text)
        self.assertIn('"%~dp0.." %* & exit /b\r\n', text)
        self.assertNotIn("bff-owned", text)
        self.assertNotIn("\n\n", text.replace("\r\n", "\n"))

    def test_shim_names_release_and_carries_marker(self):
        text = installer.windows_launcher("C:\\Py\\python.exe", "C:\\Users\\a b\\bff\\releases\\" + RELEASE, RELEASE).decode()
        self.assertEqual(installer.shim_release(text), RELEASE)
        self.assertEqual(paths.shim_release(text), RELEASE)
        self.assertIn('"C:\\Users\\a b\\bff\\releases\\' + RELEASE + '" %* & exit /b', text)

    def test_percent_is_escaped_and_quotes_are_refused(self):
        text = installer.windows_launcher("C:\\100%\\python.exe", "D:\\r", RELEASE).decode()
        self.assertIn('"C:\\100%%\\python.exe"', text)
        for bad in ('C:\\a"b', "C:\\a\nb"):
            with self.assertRaises(ValueError):
                installer.windows_launcher(bad, "D:\\r", RELEASE)

    def test_launcher_is_ascii_crlf(self):
        data = installer.windows_launcher("C:\\Py\\python.exe", "D:\\r", RELEASE)
        data.decode("ascii")
        self.assertEqual(data.count(b"\n"), data.count(b"\r\n"))

    def test_shim_release_rejects_foreign_files(self):
        for text in ("", "@echo off\r\nREM something else\r\n", "REM bff-owned release=latest\r\n",
                     "@echo off\r\nREM bff-owned release=" + RELEASE + " extra\r\n"):
            self.assertIsNone(installer.shim_release(text))
            self.assertIsNone(paths.shim_release(text))


class Layout(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def test_windows_prefix_is_the_data_dir_and_matches_paths_py(self):
        bin_dir, releases, command = installer.layout("D:/data", "Windows")
        self.assertEqual((bin_dir, releases, command), (Path("D:/data/bin"), Path("D:/data/releases"), Path("D:/data/bin/bff.cmd")))
        self.assertEqual(str(paths.releases_dir(prefix="D:/data", system="Windows")).replace("\\", "/"), "D:/data/releases")
        self.assertEqual(str(paths.command_path(prefix="D:/data", system="Windows")).replace("\\", "/"), "D:/data/bin/bff.cmd")

    def test_posix_layout_unchanged(self):
        self.assertEqual(installer.layout("/p", "Linux"), (Path("/p/bin"), Path("/p/share/bff/releases"), Path("/p/bin/bff")))

    def test_default_prefix(self):
        self.assertEqual(installer.default_prefix("Windows", env={"LOCALAPPDATA": "C:/L"}), Path("C:/L/bff"))
        self.assertEqual(installer.default_prefix("Windows", env={}, home="C:/h"), Path("C:/h/AppData/Local/bff"))
        self.assertEqual(installer.default_prefix("Darwin", env={}, home="/h"), Path("/h/.local"))

    def test_install_prefix_for_windows_release_layout(self):
        module = Path(self._tmp.name).resolve() / "data" / "releases" / RELEASE / "bff" / "__init__.py"
        self.assertEqual(paths.install_prefix(module, system="Windows"), module.parents[3])
        self.assertIsNone(paths.install_prefix(module, system="Linux"))


class SimulatedInstall(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.prefix = (Path(self._tmp.name) / "data").resolve()

    def install(self):
        return installer.install(self.prefix, system="Windows")

    def test_install_writes_owned_shim_pointing_at_the_release(self):
        result = self.install()
        command = self.prefix / "bin" / "bff.cmd"
        self.assertEqual(result["command"], str(command))
        self.assertFalse(command.is_symlink())
        release = result["release"]
        self.assertEqual(installer.shim_release(command.read_text()), release)
        # paths.command_path returns a PureWindowsPath, which a POSIX host cannot open: point it at the real file.
        with mock.patch.object(paths, "command_path", return_value=command):
            self.assertEqual(update._active_id(self.prefix, system="Windows"), release)
        self.assertIn(str(self.prefix / "releases" / release), command.read_text())
        self.assertTrue((self.prefix / "releases" / release / "bin" / "bff.cmd").is_file())
        manifest = json.loads((self.prefix / "releases" / release / "manifest.json").read_text())
        self.assertIn("bin/bff.cmd", manifest["files"])
        self.assertEqual([p.name for p in (self.prefix / "bin").iterdir()], ["bff.cmd"])

    def test_reinstall_is_idempotent_and_reports_previous(self):
        first = self.install()
        second = self.install()
        self.assertEqual(second["release"], first["release"])
        self.assertEqual(second["previous_target"], first["release"])

    def test_refuses_an_unrelated_bff_cmd(self):
        (self.prefix / "bin").mkdir(parents=True)
        (self.prefix / "bin" / "bff.cmd").write_bytes(b"@echo mine\r\n")
        with self.assertRaises(ValueError):
            self.install()
        self.assertEqual((self.prefix / "bin" / "bff.cmd").read_bytes(), b"@echo mine\r\n")

    def test_tampered_release_is_refused(self):
        release = self.prefix / "releases" / self.install()["release"]
        (release / "bin" / "bff.cmd").write_bytes(b"@echo pwned\r\n")
        with self.assertRaises(ValueError):
            installer.activate(release, self.prefix, system="Windows")

    def test_update_active_id_is_none_for_foreign_or_missing_shim(self):
        command = self.prefix / "bin" / "bff.cmd"
        with mock.patch.object(paths, "command_path", return_value=command):
            self.assertIsNone(update._active_id(self.prefix, system="Windows"))
            command.parent.mkdir(parents=True)
            command.write_bytes(b"@echo mine\r\n")
            self.assertIsNone(update._active_id(self.prefix, system="Windows"))

    def test_disable_owned_check_uses_the_marker(self):
        self.install()
        _, releases, command = installer.layout(self.prefix, "Windows")
        self.assertTrue(installer.owned_command(command, releases, "Windows"))
        command.write_bytes(b"@echo mine\r\n")
        self.assertFalse(installer.owned_command(command, releases, "Windows"))

    def test_posix_install_still_symlinks(self):
        result = installer.install(self.prefix, system="Linux")
        self.assertTrue((self.prefix / "bin" / "bff").is_symlink())
        self.assertEqual(update._active_id(self.prefix, system="Linux"), result["release"])


if __name__ == "__main__":
    unittest.main()
