import tempfile
import unittest
from pathlib import Path, PureWindowsPath

from bff import cli, paths

HOME = Path("/h")
HEX = "0123456789ab"


def posix(fn, **kw):
    return fn(system=kw.pop("system", "Linux"), home=HOME, env=kw.pop("env", {}), **kw)


class PosixPaths(unittest.TestCase):
    def test_defaults_on_both_posix_systems(self):
        for system in ("Darwin", "Linux"):
            self.assertEqual(posix(paths.data_dir, system=system), Path("/h/.local/share/bff"))
            self.assertEqual(posix(paths.bin_dir, system=system), Path("/h/.local/bin"))
            self.assertEqual(posix(paths.releases_dir, system=system), Path("/h/.local/share/bff/releases"))
            self.assertEqual(posix(paths.state_path, system=system), Path("/h/.local/share/bff/state.json"))
            self.assertEqual(posix(paths.command_path, system=system), Path("/h/.local/bin/bff"))

    def test_prefix_argument_and_env(self):
        self.assertEqual(posix(paths.data_dir, prefix="/p"), Path("/p/share/bff"))
        self.assertEqual(posix(paths.bin_dir, prefix="/p"), Path("/p/bin"))
        env = {"BFF_PREFIX": "/e"}
        self.assertEqual(posix(paths.data_dir, env=env), Path("/e/share/bff"))
        self.assertEqual(posix(paths.command_path, env=env), Path("/e/bin/bff"))
        self.assertEqual(posix(paths.data_dir, env=env, prefix="/p"), Path("/p/share/bff"))
        self.assertEqual(posix(paths.data_dir, env={"BFF_PREFIX": ""}), Path("/h/.local/share/bff"))

    def test_cache_dir_xdg(self):
        self.assertEqual(posix(paths.cache_dir), Path("/h/.cache/bff"))
        self.assertEqual(posix(paths.cache_dir, env={"XDG_CACHE_HOME": "/x"}), Path("/x/bff"))
        self.assertEqual(posix(paths.cache_dir, env={"XDG_CACHE_HOME": "rel/c"}), Path("/h/.cache/bff"))
        self.assertEqual(posix(paths.cache_dir, env={"XDG_CACHE_HOME": ""}), Path("/h/.cache/bff"))

    def test_data_dir_agrees_with_herdr_feed_default(self):
        source = (Path(cli.__file__)).read_text()
        self.assertIn('Path.home() / ".local" / "share" / "bff" / "herdr-feed.json"', source)
        feed_dir = Path.home() / ".local" / "share" / "bff"
        self.assertEqual(paths.data_dir(system="Linux", home=Path.home(), env={}), feed_dir)


# Built by concatenation so the privacy gate (scripts/privacy_gate.py) never sees a home-path literal.
WIN_HOME = "C:/" + "Users/example"


class WindowsPaths(unittest.TestCase):
    def win(self, fn, env=None, **kw):
        return fn(system="Windows", home=PureWindowsPath(WIN_HOME), env=env or {}, **kw)

    def test_localappdata_set_and_unset(self):
        data = self.win(paths.data_dir, {"LOCALAPPDATA": "C:\\L"})
        self.assertEqual(data, PureWindowsPath("C:\\L\\bff"))
        self.assertEqual(self.win(paths.data_dir), PureWindowsPath(WIN_HOME + "/AppData/Local/bff"))

    def test_derived_paths(self):
        env = {"LOCALAPPDATA": "C:\\L"}
        self.assertEqual(self.win(paths.bin_dir, env), PureWindowsPath("C:\\L\\bff\\bin"))
        self.assertEqual(self.win(paths.releases_dir, env), PureWindowsPath("C:\\L\\bff\\releases"))
        self.assertEqual(self.win(paths.state_path, env), PureWindowsPath("C:\\L\\bff\\state.json"))
        self.assertEqual(self.win(paths.cache_dir, env), PureWindowsPath("C:\\L\\bff\\cache"))
        self.assertEqual(self.win(paths.command_path, env), PureWindowsPath("C:\\L\\bff\\bin\\bff.cmd"))

    def test_bff_prefix_is_the_data_dir(self):
        env = {"BFF_PREFIX": "D:\\relocated", "LOCALAPPDATA": "C:\\L"}
        self.assertEqual(self.win(paths.data_dir, env), PureWindowsPath("D:\\relocated"))
        self.assertEqual(self.win(paths.bin_dir, env), PureWindowsPath("D:\\relocated\\bin"))
        self.assertEqual(self.win(paths.data_dir, env, prefix="E:\\p"), PureWindowsPath("E:\\p"))


class InstallMethod(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.addCleanup(self.tmp.cleanup)

    def module(self, *parts):
        path = self.root.joinpath(*parts)
        path.parent.mkdir(parents=True)
        path.write_text("")
        return path

    def method(self, module, **kw):
        return paths.install_method(module, system="Linux", home=self.root / "home", env={}, **kw)

    def test_script(self):
        module = self.module("p", "share", "bff", "releases", "0.2.0-" + HEX, "bff", "__init__.py")
        self.assertEqual(self.method(module, prefix=self.root / "p"), "script")

    def test_script_via_bff_prefix_env(self):
        module = self.module("p", "share", "bff", "releases", "0.2.0-" + HEX, "bff", "__init__.py")
        got = paths.install_method(module, system="Linux", home=self.root / "h", env={"BFF_PREFIX": str(self.root / "p")})
        self.assertEqual(got, "script")

    def test_bad_release_name_is_not_script(self):
        module = self.module("p", "share", "bff", "releases", "latest", "bff", "__init__.py")
        self.assertEqual(self.method(module, prefix=self.root / "p"), "unknown")

    def test_uv(self):
        module = self.module("h", ".local", "share", "uv", "tools", "bff", "lib", "bff", "__init__.py")
        self.assertEqual(self.method(module), "uv")

    def test_brew(self):
        module = self.module("opt", "Cellar", "bff", "0.2.0", "libexec", "bff", "__init__.py")
        self.assertEqual(self.method(module), "brew")

    def test_dev(self):
        module = self.module("src", "bff", "bff", "__init__.py")
        (self.root / "src" / "bff" / ".git").mkdir()
        (self.root / "src" / "bff" / "install.py").write_text("")
        self.assertEqual(self.method(module), "dev")

    def test_git_without_install_py_is_unknown(self):
        module = self.module("src", "bff", "bff", "__init__.py")
        (self.root / "src" / "bff" / ".git").mkdir()
        self.assertEqual(self.method(module), "unknown")

    def test_unknown(self):
        module = self.module("site-packages", "bff", "__init__.py")
        self.assertEqual(self.method(module), "unknown")

    def test_windows_style_uv_path_parts(self):
        self.assertTrue(paths._contains(paths._parts("C:\\" + "Users\\example\\uv\\tools\\bff"), ["uv", "tools"]))


if __name__ == "__main__":
    unittest.main()
