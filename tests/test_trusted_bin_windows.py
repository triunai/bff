"""td-h1w.11: Windows rules of bff/trusted_bin.py, exercised on any OS with a simulated platform ("win32"), ntpath and the injected Fs seam.
CI (windows-latest) additionally runs the whole suite on the real thing."""
import ntpath
import os
from pathlib import Path
import stat
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bff import trusted_bin  # noqa: E402
from bff.trusted_bin import Policy, TrustRefused  # noqa: E402

WIN = "win32"
ENV = {"SystemRoot": "C:\\Windows", "ProgramFiles": "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", "LOCALAPPDATA": "C:\\Users\\me\\AppData\\Local",
       "APPDATA": "C:\\Users\\me\\AppData\\Roaming", "USERPROFILE": "C:\\Users\\me", "TEMP": "C:\\Users\\me\\AppData\\Local\\Temp", "TMP": "C:\\Users\\me\\AppData\\Local\\Temp"}
GIT = "C:\\Program Files\\Git\\cmd"
SYS32 = "C:\\Windows\\System32"


def fake_fs(files, links=None):
    """files: set of real paths. links: candidate -> real. Compared with ntpath.normcase so case never matters."""
    files = {ntpath.normcase(f) for f in files}
    links = {ntpath.normcase(k): v for k, v in (links or {}).items()}

    def real(path):
        return links.get(ntpath.normcase(path), path)

    def stat_of(path):
        if ntpath.normcase(path) not in files:
            raise OSError("ENOENT " + path)
        return types.SimpleNamespace(st_uid=1, st_mode=stat.S_IFREG | 0o666)
    return trusted_bin.Fs(realpath=real, stat=stat_of, exec_ok=lambda p: True, uid=None)


def policy(files, links=None, **kw):
    return Policy(platform=WIN, fs=fake_fs(files, links), home="C:\\Users\\me", **kw)


class WindowsCase(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, ENV, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)


class Allowlist(WindowsCase):
    def test_the_fixed_list_covers_every_required_windows_location(self):
        dirs = [ntpath.normcase(d) for d in trusted_bin.default_dirs("C:\\Users\\me", WIN)]
        for want in (SYS32, "C:\\Windows", GIT, "C:\\Program Files\\Git\\bin", "C:\\Program Files (x86)\\Git\\cmd", "C:\\Program Files\\GitHub CLI", "C:\\Program Files\\nodejs",
                     "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links", "C:\\Users\\me\\scoop\\shims", "C:\\Users\\me\\AppData\\Roaming\\npm", "C:\\Users\\me\\.cargo\\bin"):
            self.assertIn(ntpath.normcase(want), dirs, want)

    def test_python_volta_fnm_and_nvm_dirs_come_from_globs_of_fixed_roots(self):
        seen = []

        def globber(pattern):
            seen.append(pattern)
            return [pattern.replace("*", "3.12")]
        dirs = trusted_bin.tool_dirs("C:\\Users\\me", WIN, ENV, globber)
        self.assertIn("C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python3*", seen)
        self.assertIn("C:\\Program Files\\Python3*", seen)
        self.assertTrue(any("fnm" in p for p in seen) and any("nvm" in p for p in seen))
        self.assertIn("C:\\Users\\me\\AppData\\Local\\Volta\\bin", dirs)
        self.assertNotIn("C:\\nvm4w\\nodejs", dirs)  # under C:\, writable by any signed-in user
        self.assertIn("C:\\Users\\me\\AppData\\Local\\Programs\\Herdr\\bin", dirs)
        self.assertIn("C:\\Users\\me\\AppData\\Local\\nvm\\v*", seen)

    def test_a_hostile_PATH_and_PATHEXT_change_nothing(self):
        before = trusted_bin.default_dirs("C:\\Users\\me", WIN)
        with mock.patch.dict(os.environ, {"PATH": "C:\\evil", "PATHEXT": ".EVIL;.VBS"}):
            self.assertEqual(trusted_bin.default_dirs("C:\\Users\\me", WIN), before)
            self.assertNotIn("C:\\evil", [d for d in trusted_bin.default_dirs("C:\\Users\\me", WIN)])
            env = trusted_bin.child_env(source=dict(os.environ), platform=WIN, home="C:\\Users\\me")
        self.assertNotIn("C:\\evil", env["PATH"])
        self.assertEqual(env["PATHEXT"], trusted_bin.WIN_PATHEXT)

    def test_a_relative_unc_or_driveless_env_root_is_ignored(self):
        with mock.patch.dict(os.environ, {"SystemRoot": "\\\\evil\\share", "ProgramFiles": "relative"}):
            dirs = trusted_bin.system_dirs("C:\\Users\\me", WIN)
        self.assertEqual(dirs[0], "C:\\Windows\\System32")
        self.assertFalse(any("evil" in d or d.startswith("relative") for d in dirs))


class Resolution(WindowsCase):
    def test_name_resolves_with_exe_in_a_fixed_dir_only(self):
        p = policy({GIT + "\\git.exe"}, dirs=[GIT])
        verdict = trusted_bin.resolve("git", p)
        self.assertTrue(verdict.ok, verdict)
        self.assertEqual(verdict.path, GIT + "\\git.exe")

    def test_extension_order_is_fixed_exe_before_cmd(self):
        p = policy({GIT + "\\tool.cmd", GIT + "\\tool.exe"}, dirs=[GIT])
        self.assertEqual(trusted_bin.resolve("tool", p).path, GIT + "\\tool.exe")
        self.assertTrue(trusted_bin.resolve("tool", policy({GIT + "\\tool.cmd"}, dirs=[GIT])).ok)

    def test_a_directory_outside_the_list_is_refused_even_with_the_file_present(self):
        p = policy({"C:\\evil\\git.exe"}, dirs=[GIT])
        self.assertEqual(trusted_bin.vet_path("C:\\evil\\git.exe", p).reason, "location")
        self.assertEqual(trusted_bin.resolve("git", p).reason, "not-found")

    def test_case_slash_and_trailing_separator_do_not_matter(self):
        p = policy({GIT + "\\git.exe"}, dirs=[GIT])
        for spelling in ("c:\\program files\\git\\cmd\\GIT.EXE", "C:/Program Files/Git/cmd/git.exe"):
            self.assertTrue(trusted_bin.vet_path(spelling, p).ok, spelling)
        self.assertTrue(trusted_bin.vet_path(GIT + "\\git.exe", policy({GIT + "\\git.exe"}, dirs=[GIT + "\\"])).ok)

    def test_names_that_are_not_plain_file_names_are_refused(self):
        p = policy(set(), dirs=[GIT])
        for bad in ("..\\git", "a/b", "git:stream", "gi*t", "git.", "git ", "-x", ""):
            self.assertEqual(trusted_bin.resolve(bad, p).reason, "bad-name", repr(bad))

    def test_unc_and_driveless_absolute_paths_are_refused(self):
        p = policy(set(), dirs=[GIT])
        for bad in ("\\\\server\\share\\git.exe", "\\Windows\\System32\\cmd.exe", "git.exe"):
            self.assertEqual(trusted_bin.vet_path(bad, p).reason, "not-absolute", bad)

    def test_a_non_executable_extension_is_refused(self):
        p = policy({GIT + "\\readme.txt"}, dirs=[GIT])
        self.assertEqual(trusted_bin.vet_path(GIT + "\\readme.txt", p).reason, "not-executable")

    def test_a_symlink_out_of_the_fixed_dirs_follows_the_symlink_rules(self):
        p = policy({"C:\\elsewhere\\git.exe"}, {GIT + "\\git.exe": "C:\\elsewhere\\git.exe"}, dirs=[GIT], alias_targets="none")
        self.assertEqual(trusted_bin.vet_path(GIT + "\\git.exe", p).reason, "symlink-refused")


class TempRule(WindowsCase):
    def test_a_program_under_a_user_writable_temp_dir_is_refused_even_if_listed(self):
        tmp = "C:\\Users\\me\\AppData\\Local\\Temp\\x"
        p = policy({tmp + "\\git.exe"}, dirs=[tmp])
        self.assertEqual(trusted_bin.vet_path(tmp + "\\git.exe", p).reason, "untrusted-directory")

    def test_a_symlink_landing_in_temp_is_refused(self):
        tmp = "C:\\Windows\\Temp\\git.exe"
        p = policy({tmp}, {GIT + "\\git.exe": tmp}, dirs=[GIT])
        self.assertEqual(trusted_bin.vet_path(GIT + "\\git.exe", p).reason, "untrusted-directory")

    def test_mode_and_owner_are_not_evaluated(self):
        # fake_fs reports mode 0o666 and uid 1: on POSIX this is "writable"/"foreign-owner", on Windows it must pass.
        self.assertTrue(trusted_bin.vet_path(GIT + "\\git.exe", policy({GIT + "\\git.exe"}, dirs=[GIT])).ok)


class BatchFiles(WindowsCase):
    def files(self):
        return {"C:\\Program Files\\nodejs\\npm.cmd", SYS32 + "\\cmd.exe"}

    def test_cmd_runs_only_through_the_vetted_cmd_exe_wrapper(self):
        p = policy(self.files(), dirs=["C:\\Program Files\\nodejs"])
        items, verdict = trusted_bin._vet_argv(["C:\\Program Files\\nodejs\\npm.cmd", "install", "left pad"], p)
        self.assertEqual(verdict.path, SYS32 + "\\cmd.exe")
        self.assertIsInstance(items, str)
        self.assertEqual(items, '"C:\\Windows\\System32\\cmd.exe" /d /s /c ""C:\\Program Files\\nodejs\\npm.cmd" "install" "left pad""')

    def test_a_batch_file_runs_under_the_default_policy_none(self):
        # Found on real windows-latest: doctor/update pass policy=None, and _batch_via_cmd read policy.platform on it (AttributeError).
        npm = "C:\\Program Files\\nodejs\\npm.cmd"
        vets = {npm: trusted_bin.Vet(True, npm, npm, None, None), SYS32 + "\\cmd.exe": trusted_bin.Vet(True, SYS32 + "\\cmd.exe", SYS32 + "\\cmd.exe", None, None)}
        with mock.patch.object(trusted_bin, "vet_path", side_effect=lambda candidate, policy=None: vets[candidate]), \
                mock.patch.object(trusted_bin, "_is_win", return_value=True):
            items, verdict = trusted_bin._vet_argv([npm, "view"], None)
        self.assertEqual(verdict.path, SYS32 + "\\cmd.exe")
        self.assertTrue(items.startswith('"C:\\Windows\\System32\\cmd.exe" /d /s /c'))

    def test_metacharacters_in_any_argument_are_refused(self):
        p = policy(self.files(), dirs=["C:\\Program Files\\nodejs"])
        for ch in "&|<>^%!\"\n\r":
            with self.assertRaises(TrustRefused, msg=repr(ch)) as caught:
                trusted_bin._vet_argv(["C:\\Program Files\\nodejs\\npm.cmd", "a" + ch + "b"], p)
            self.assertEqual(caught.exception.reason, "bad-argv")

    def test_an_untrusted_cmd_exe_blocks_batch_files(self):
        p = policy({"C:\\Program Files\\nodejs\\npm.cmd"}, dirs=["C:\\Program Files\\nodejs"])
        with self.assertRaises(TrustRefused):
            trusted_bin._vet_argv(["C:\\Program Files\\nodejs\\npm.cmd", "x"], p)

    def test_exe_programs_are_not_wrapped(self):
        p = policy({GIT + "\\git.exe"}, dirs=[GIT])
        items, verdict = trusted_bin._vet_argv([GIT + "\\git.exe", "status"], p)
        self.assertEqual(items, [GIT + "\\git.exe", "status"])
        self.assertEqual(verdict.path, GIT + "\\git.exe")

    def test_run_passes_the_wrapper_line_and_a_windows_env(self):
        p = policy(self.files(), dirs=["C:\\Program Files\\nodejs"])
        with mock.patch.object(trusted_bin.subprocess, "run") as spawn:
            trusted_bin.run(["C:\\Program Files\\nodejs\\npm.cmd", "-v"], policy=p)
        args, kwargs = spawn.call_args
        self.assertTrue(args[0].startswith('"C:\\Windows\\System32\\cmd.exe" /d /s /c'))
        self.assertEqual(kwargs["executable"], SYS32 + "\\cmd.exe")
        self.assertFalse(kwargs["shell"])
        self.assertEqual(kwargs["env"]["ComSpec"], "C:\\Windows\\System32\\cmd.exe")
        self.assertTrue(kwargs["env"]["PATH"].startswith("C:\\Program Files\\nodejs;"))


class Environment(WindowsCase):
    def test_the_windows_env_is_minimal_and_explicit(self):
        source = dict(ENV, PATH="C:\\evil", ComSpec="C:\\evil\\cmd.exe", NODE_OPTIONS="--require x", PYTHONPATH="C:\\evil", SECRET="s")
        env = trusted_bin.child_env(source=source, platform=WIN, home="C:\\Users\\me")
        self.assertEqual(env["ComSpec"], "C:\\Windows\\System32\\cmd.exe")
        for name in ("SystemRoot", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "PATHEXT", "PATH"):
            self.assertIn(name, env)
        for name in ("NODE_OPTIONS", "PYTHONPATH", "SECRET"):
            self.assertNotIn(name, env)
        self.assertEqual(env["PATH"].split(";")[0], "C:\\Windows\\System32")
        self.assertNotIn("C:\\evil", env["PATH"])

    def test_loader_variables_still_raise_on_windows(self):
        with self.assertRaises(ValueError):
            trusted_bin.child_env(extra={"NODE_OPTIONS": "x"}, source=dict(ENV), platform=WIN, home="C:\\Users\\me")
        with self.assertRaises(ValueError):
            trusted_bin.child_env(inherit=("PYTHONSTARTUP",), source=dict(ENV), platform=WIN, home="C:\\Users\\me")

    def test_posix_env_is_unchanged_by_the_platform_argument(self):
        env = trusted_bin.child_env(source={"HOME": "/h", "LANG": "C"}, platform="darwin", home="/h")
        self.assertEqual(sorted(env), ["HOME", "LANG", "PATH"])


class ExecReplace(WindowsCase):
    def test_exec_replace_runs_waits_and_exits_with_the_childs_code(self):
        p = policy({GIT + "\\git.exe"}, dirs=[GIT])
        done = types.SimpleNamespace(returncode=7)
        with mock.patch.object(trusted_bin, "run", return_value=done) as spawn, mock.patch.object(trusted_bin.os, "execve") as execve:
            with self.assertRaises(SystemExit) as caught:
                trusted_bin.exec_replace(GIT + "\\git.exe", ["git", "status"], {"A": "1", "NODE_OPTIONS": "x"}, p)
        self.assertEqual(caught.exception.code, 7)
        execve.assert_not_called()
        self.assertEqual(spawn.call_args[0][0], [GIT + "\\git.exe", "status"])
        self.assertEqual(spawn.call_args[1]["env"], {"A": "1"})

    def test_exec_replace_still_vets_the_target(self):
        p = policy(set(), dirs=[GIT])
        with self.assertRaises(TrustRefused):
            trusted_bin.exec_replace(GIT + "\\git.exe", ["git"], {}, p)


if __name__ == "__main__":
    unittest.main()
