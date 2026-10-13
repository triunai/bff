"""Simulated-Windows behaviour of the Osiris terminal launch, the setup/doctor rows and the Windows tool directories.

CI runs the real thing on windows-latest; these tests pin the pure logic with a simulated OS value so they run on any machine."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bff import cli, doctor, osiris, osiris_tui, trusted_bin

HOME = "C:\\Users\\Mei"


class WindowsToolDirs(unittest.TestCase):
    def test_dirs_are_a_fixed_list_that_covers_node_git_gh_and_the_version_managers(self):
        dirs = osiris_tui.windows_tool_dirs(HOME, expand=lambda pattern: [])
        for wanted in ("C:\\Program Files\\nodejs", "C:\\Program Files\\Git\\cmd", "C:\\Program Files\\GitHub CLI",
                       HOME + "\\AppData\\Local\\Volta\\bin", HOME + "\\AppData\\Local\\Microsoft\\WinGet\\Links",
                       HOME + "\\AppData\\Roaming\\npm", HOME + "\\scoop\\shims", "C:\\nvm4w\\nodejs"):
            self.assertIn(wanted, dirs)
        self.assertTrue(all(os.path.isabs(d) or d[1:3] == ":\\" for d in dirs))

    def test_version_manager_directories_are_globbed_newest_first(self):
        seen = []

        def expand(pattern):
            seen.append(pattern)
            if "fnm" in pattern and "Local" in pattern:
                return ["x\\v20.1.0\\installation", "x\\v22.9.0\\installation"]
            if "nvm" in pattern:
                return ["x\\nvm\\v22.1.0"]
            return []
        dirs = osiris_tui.windows_tool_dirs(HOME, expand=expand)
        self.assertEqual([d for d in dirs if d.startswith("x\\v")], ["x\\v22.9.0\\installation", "x\\v20.1.0\\installation"])
        self.assertIn("x\\nvm\\v22.1.0", dirs)
        self.assertTrue(any("nvm" in p for p in seen) and any("fnm" in p for p in seen))

    def test_trailing_separator_on_home_does_not_double_up(self):
        dirs = osiris_tui.windows_tool_dirs(HOME + "\\", expand=lambda pattern: [])
        self.assertIn(HOME + "\\AppData\\Local\\Volta\\bin", dirs)

    def test_policy_only_exists_on_windows_and_never_replaces_the_default_list(self):
        self.assertIsNone(osiris_tui.tool_policy("darwin"))
        self.assertIsNone(osiris_tui.tool_policy("linux"))
        policy = osiris_tui.tool_policy("win32", HOME)
        self.assertIsNone(policy.dirs)  # the default list still applies; the Windows dirs are ADDED
        self.assertIn("C:\\Program Files\\nodejs", policy.extra_dirs)

    def test_which_is_exactly_trusted_which_off_windows(self):
        with mock.patch("bff.osiris_tui.trusted_bin.which", return_value="/x/node") as which:
            self.assertEqual(osiris_tui.which("node", platform="linux"), "/x/node")
            which.assert_called_once_with("node")

    def test_which_passes_the_windows_policy_on_windows(self):
        with mock.patch("bff.osiris_tui.trusted_bin.which", return_value="C:\\Program Files\\nodejs\\node.exe") as which:
            self.assertEqual(osiris_tui.which("node", platform="win32", home=HOME), "C:\\Program Files\\nodejs\\node.exe")
            self.assertIn("C:\\Program Files\\nodejs", which.call_args[0][1].extra_dirs)

    def test_the_directory_list_is_closed_a_temp_or_path_directory_is_not_in_it(self):
        policy = osiris_tui.tool_policy("win32", HOME)
        searched = trusted_bin._effective_dirs(policy)
        for outsider in ("C:\\Temp\\evil", "C:\\Users\\Public", HOME + "\\Downloads", "."):
            self.assertNotIn(outsider, searched)
        self.assertFalse(trusted_bin.vet_path("relative\\node.exe", policy).ok)

    def test_windows_start_up_variables_are_inherited_but_loader_variables_never(self):
        names = osiris_tui.tool_inherit("win32")
        for wanted in ("SystemRoot", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "ComSpec"):
            self.assertIn(wanted, names)
        self.assertEqual(osiris_tui.tool_inherit("darwin"), trusted_bin.TOOL_INHERIT)
        for name in names:
            self.assertFalse(trusted_bin.LOADER_ENV.match(name), name)
        env = trusted_bin.child_env(inherit=names, source={"SystemRoot": "C:\\Windows", "NODE_OPTIONS": "--require evil"}, home=HOME)
        self.assertEqual(env["SystemRoot"], "C:\\Windows")
        self.assertNotIn("NODE_OPTIONS", env)

    def test_ctrl_c_status_maps_to_130_on_windows_only(self):
        self.assertEqual(osiris_tui.exit_code(3221225786, "win32"), 130)
        self.assertEqual(osiris_tui.exit_code(-1073741510, "win32"), 130)
        self.assertEqual(osiris_tui.exit_code(3221225786, "linux"), 3221225786)
        self.assertEqual(osiris_tui.exit_code(2, "win32"), 2)
        self.assertEqual(osiris_tui.exit_code(0, "win32"), 0)


class WindowsTuiLaunch(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="bff win tui ")
        self.addCleanup(self.temporary.cleanup)
        self.plugin = Path(self.temporary.name).resolve() / "plugin dir"
        (self.plugin / "bin").mkdir(parents=True)
        (self.plugin / "bin" / "osiris-tui.mjs").write_text("// stub\n", encoding="utf-8")

    def launch(self, node, returncode=0, argv=("osiris", "factory", "--repo", "C:\\My Repos\\wedding site")):
        with mock.patch.dict(os.environ, {"OSIRIS_PLUGIN_DIR": str(self.plugin)}), \
                mock.patch("bff.osiris_tui.sys.platform", "win32"), \
                mock.patch("bff.osiris_tui.trusted_bin.which", side_effect=lambda name, policy=None: node), \
                mock.patch("bff.osiris_tui.trusted_bin.run", return_value=subprocess.CompletedProcess([], returncode)) as run, \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as err:
            try:
                code = cli.main(list(argv))
            except ValueError as error:
                return None, run, str(error)
        return code, run, err.getvalue()

    def test_node_exe_runs_with_the_repo_as_one_argv_item_even_with_spaces(self):
        code, run, _ = self.launch("C:\\Program Files\\nodejs\\node.exe")
        self.assertEqual(code, 0)
        argv = run.call_args[0][0]
        self.assertEqual(argv[0], "C:\\Program Files\\nodejs\\node.exe")
        self.assertEqual(argv[2], "factory")
        self.assertEqual(argv[-1], str(Path("C:\\My Repos\\wedding site").resolve()))
        self.assertNotIn("shell", run.call_args[1])
        self.assertIn("SystemRoot", run.call_args[1]["inherit"])

    def test_the_apps_real_exit_code_is_returned(self):
        self.assertEqual(self.launch("C:\\n\\node.exe", returncode=7)[0], 7)

    def test_ctrl_c_in_the_app_is_a_clean_130(self):
        self.assertEqual(self.launch("C:\\n\\node.exe", returncode=3221225786)[0], 130)

    def test_a_node_cmd_wrapper_is_refused(self):
        code, run, message = self.launch("C:\\Users\\Mei\\AppData\\Roaming\\nvm\\node.cmd")
        run.assert_not_called()
        self.assertIn("node.cmd", message)

    def test_missing_node_says_how_to_install_it_on_windows(self):
        with mock.patch("bff.osiris_tui.sys.platform", "win32"), mock.patch("bff.osiris_tui.trusted_bin.which", return_value=None):
            with self.assertRaises(ValueError) as caught:
                osiris_tui.build_argv("factory", self.plugin, mock.Mock(repo=None, no_color=False, once=False, cols=None, interval=None, all=False))
        self.assertIn("winget install OpenJS.NodeJS.LTS", str(caught.exception))

    def test_the_tui_script_guards_its_windows_only_lines(self):
        script = (Path(__file__).resolve().parents[1] / "plugins" / "osiris" / "bin" / "osiris-tui.mjs").read_text(encoding="utf-8")
        self.assertIn('process.platform === "win32"', script)
        self.assertIn("setBlocking", script)
        self.assertNotIn("/dev/tty", script)


class WindowsPrerequisites(unittest.TestCase):
    def rows(self, found, system="Windows"):
        which = lambda name: ("C:\\bin\\" + name + ".exe") if name in found else None
        run = lambda argv, **kw: subprocess.CompletedProcess(argv, 0, "9.9.9", "")
        return osiris.prerequisites(system, which=which, run=run, compat={"bb_min": "0.45.0"}, bb=None if "bb" not in found else "C:\\bin\\bb.exe")

    def test_windows_rows_use_winget_hints_and_have_no_homebrew(self):
        rows = {r["name"]: r for r in self.rows(set())}
        self.assertNotIn("Homebrew", rows)
        self.assertIn("winget install OpenJS.NodeJS.LTS", rows["Node"]["how"])
        self.assertIn("winget install Git.Git", rows["git"]["how"])
        self.assertIn("winget install GitHub.cli", rows["gh"]["how"])
        self.assertIn("x64.exe", rows["BB"]["how"])
        self.assertIn("0.45.0", rows["BB"]["how"])

    def test_herdr_is_reported_as_not_applicable_not_as_a_failure(self):
        herdr = {r["name"]: r for r in self.rows(set())}["herdr"]
        self.assertTrue(herdr["ok"])
        self.assertFalse(herdr["required"])
        self.assertIn("no Windows build", herdr["how"])
        out = io.StringIO()
        osiris._print_plan(self.rows(set()), out)
        self.assertIn("no Windows build (not needed)", out.getvalue())

    def test_macos_rows_are_unchanged(self):
        names = [r["name"] for r in self.rows({"brew"}, system="Darwin")]
        self.assertEqual(names, ["Homebrew", "Node", "BB", "git", "herdr", "bd", "bdi"])

    def test_setup_on_windows_without_bb_prints_the_windows_instructions_and_exits_3(self):
        out = io.StringIO()
        code = osiris.setup(system="Windows", out=out, which=lambda name: None, run=lambda *a, **k: None, compat={"bb_min": "0.45.0", "osiris": {}})
        self.assertEqual(code, 3)
        text = out.getvalue()
        self.assertIn("winget install OpenJS.NodeJS.LTS", text)
        self.assertIn("get-bb/bb/releases", text)
        self.assertNotIn("brew", text)


class WindowsDoctor(unittest.TestCase):
    def test_backslash_paths_are_recognised_as_npm_owned(self):
        self.assertEqual(doctor.owner_of("C:\\Users\\Mei\\AppData\\Roaming\\npm\\node_modules\\@beads\\bd\\bin\\bd.exe"), "npm")

    def test_windows_doctor_explains_herdr_instead_of_offering_a_brew_install(self):
        def which(name, policy=None):
            return {"npm": "C:\\Program Files\\nodejs\\npm.cmd"}.get(name)
        fake = mock.Mock(which=which, SubprocessError=subprocess.SubprocessError, CompletedProcess=subprocess.CompletedProcess,
                         run=lambda argv, **kw: subprocess.CompletedProcess(argv, 1, "", ""), TOOL_INHERIT=trusted_bin.TOOL_INHERIT)
        with mock.patch("bff.doctor.trusted_bin", fake), mock.patch("bff.osiris_tui.sys.platform", "win32"):
            rows = {r["component"]: r for r in doctor.survey()}
        self.assertEqual(rows["Herdr"]["action"], "manual")
        self.assertIn("bff osiris factory", rows["Herdr"]["reason"])
        self.assertEqual(rows["BB"]["action"], "manual")
        self.assertEqual(rows["Beads"]["action"], "install")
        self.assertEqual(rows["Beads"]["argv"][0], "C:\\Program Files\\nodejs\\npm.cmd")

    def test_install_environment_carries_the_windows_start_up_variables(self):
        with mock.patch("bff.osiris_tui.sys.platform", "win32"):
            self.assertIn("SystemRoot", doctor.install_inherit())
        with mock.patch("bff.osiris_tui.sys.platform", "darwin"):
            self.assertEqual(doctor.install_inherit(), doctor.INSTALL_INHERIT)


if __name__ == "__main__":
    unittest.main()
