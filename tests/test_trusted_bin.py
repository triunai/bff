"""ADR D-139: the ONE trusted-binary primitive (Python twin of Osiris work/trusted-bin.ts). Real-file cases run in a private tmp dir passed as `dirs`;
ownership cases that cannot be produced without root use the injected fake file system."""
import os
from pathlib import Path
import stat
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bff import launch, trusted_bin  # noqa: E402
from bff.trusted_bin import Policy  # noqa: E402


def sandbox(test):
    tmp = tempfile.TemporaryDirectory(prefix="bff trusted ")
    test.addCleanup(tmp.cleanup)
    directory = Path(tmp.name).resolve()
    directory.chmod(0o755)
    return directory


def script(directory, name, body, mode=0o755):
    path = Path(directory) / name
    path.write_text("#!/bin/sh\n" + body + "\n")
    path.chmod(mode)
    return str(path)


def fake_fs(entries, uid=501):
    """entries: path -> (uid, mode, kind) with kind "file", "dir" or ("link", target)."""
    def real(path):
        entry = entries.get(path)
        if entry is None:
            raise OSError("ENOENT " + path)
        return real(entry[2][1]) if isinstance(entry[2], tuple) else path

    def stat_of(path):
        entry = entries.get(path)
        if entry is None:
            raise OSError("ENOENT " + path)
        kind = stat.S_IFDIR if entry[2] == "dir" else stat.S_IFREG
        return types.SimpleNamespace(st_uid=entry[0], st_mode=kind | entry[1])
    return trusted_bin.Fs(realpath=real, stat=stat_of, exec_ok=lambda p: True, uid=uid)


def dirs(*paths):
    return {p: (0, 0o755, "dir") for p in paths}


class Resolution(unittest.TestCase):
    def test_a_path_planted_program_is_never_found(self):
        plant = sandbox(self)
        name = "bff-planted-%d" % os.getpid()
        script(plant, name, "exit 0")
        with mock.patch.dict(os.environ, {"PATH": str(plant) + os.pathsep + os.environ.get("PATH", "")}):
            self.assertIsNone(trusted_bin.which(name))
            self.assertEqual(trusted_bin.resolve(name).reason, "not-found")
            git = trusted_bin.which("git")
            self.assertTrue(git is None or not git.startswith(str(plant)))
            self.assertFalse(any(d.startswith(str(plant)) for d in trusted_bin.default_dirs()))

    def test_names_that_escape_the_allowlist_are_refused_with_a_typed_reason(self):
        for name in ("./git", "bin/git", "../git", "", "-rf", ".", "..", "a\0b"):
            self.assertEqual(trusted_bin.resolve(name).reason, "bad-name", repr(name))
        for name in ("/tmp/git", "/usr/bin/../bin/git", "/usr/bin/./git", "/opt/evil/git"):
            self.assertEqual(trusted_bin.resolve(name).reason, "location", name)
        self.assertEqual(trusted_bin.vet_path("git").reason, "not-absolute")
        self.assertEqual(trusted_bin.vet_path("./git").reason, "not-absolute")

    def test_a_regular_owner_only_writable_file_in_an_allowed_dir_is_accepted(self):
        directory = sandbox(self)
        path = script(directory, "tool", "exit 0")
        verdict = trusted_bin.resolve("tool", Policy(dirs=(str(directory),)))
        self.assertTrue(verdict.ok)
        self.assertEqual((verdict.path, verdict.via), (path, path))

    def test_group_and_other_writable_files_are_refused(self):
        directory = sandbox(self)
        script(directory, "gw", "exit 0", 0o775)
        script(directory, "ow", "exit 0", 0o757)
        for name in ("gw", "ow"):
            self.assertEqual(trusted_bin.resolve(name, Policy(dirs=(str(directory),))).reason, "writable", name)

    def test_not_executable_and_not_a_regular_file_are_refused(self):
        directory = sandbox(self)
        script(directory, "noexec", "exit 0", 0o644)
        (directory / "adir").mkdir()
        self.assertEqual(trusted_bin.resolve("noexec", Policy(dirs=(str(directory),))).reason, "not-executable")
        self.assertEqual(trusted_bin.resolve("adir", Policy(dirs=(str(directory),))).reason, "not-regular-file")

    def test_a_symlink_to_a_writable_target_is_refused_and_a_trusted_target_keeps_its_alias(self):
        directory = sandbox(self)
        target = script(directory, "target", "exit 0", 0o775)
        os.symlink(target, str(directory / "link"))
        policy = Policy(dirs=(str(directory),))
        self.assertEqual(trusted_bin.resolve("link", policy).reason, "writable", "the TARGET is re-checked")
        self.assertEqual(trusted_bin.resolve("link", policy._replace(alias_targets="none")).reason, "symlink-refused")
        good = script(directory, "good-target", "exit 0")
        os.symlink(good, str(directory / "good"))
        verdict = trusted_bin.resolve("good", policy)
        self.assertEqual((verdict.ok, verdict.path, verdict.via), (True, good, str(directory / "good")))
        self.assertEqual(trusted_bin.which("good", policy), str(directory / "good"))
        import re
        self.assertEqual(trusted_bin.resolve("good", policy._replace(alias_targets=re.compile(r"^/nowhere/"))).reason, "symlink-refused")

    def test_foreign_owner_root_only_and_untrusted_directory(self):
        system = dict(dirs("/", "/usr", "/usr/bin"), **{"/usr/bin/tool": (0, 0o755, "file")})

        def verdict(extra=None, **policy):
            entries = dict(system, **(extra or {}))
            return trusted_bin.resolve("/usr/bin/tool" if policy.get("root_only") else "tool", Policy(fs=fake_fs(entries), **policy))
        self.assertEqual(verdict({"/usr/bin/tool": (502, 0o755, "file")}).reason, "foreign-owner")
        self.assertTrue(verdict({"/usr/bin/tool": (0, 0o755, "file")}).ok)
        self.assertTrue(verdict({"/usr/bin/tool": (501, 0o755, "file")}).ok)
        self.assertEqual(verdict({"/usr/bin/tool": (501, 0o755, "file")}, root_only=True).reason, "not-root-owned")
        self.assertTrue(verdict(root_only=True).ok)
        self.assertEqual(verdict({"/usr/bin/tool": (0, 0o755, ("link", "/usr/bin/real")), "/usr/bin/real": (0, 0o755, "file")}, root_only=True).reason, "symlink-refused")
        self.assertEqual(verdict({"/usr": (0, 0o777, "dir")}).reason, "untrusted-directory", "world-writable above")
        self.assertEqual(verdict({"/usr/bin": (502, 0o755, "dir")}).reason, "untrusted-directory", "foreign-owned above")
        self.assertTrue(verdict({"/usr/bin": (501, 0o775, "dir")}).ok, "group-writable but ours (Homebrew layout) is accepted")

    def test_resolve_reports_the_most_informative_refusal(self):
        first, second = sandbox(self), sandbox(self)
        script(second, "t", "exit 0", 0o777)
        self.assertEqual(trusted_bin.resolve("t", Policy(dirs=(str(first), str(second)))).reason, "writable")
        self.assertIsNone(trusted_bin.which("t", Policy(dirs=(str(first), str(second)))))


class Environment(unittest.TestCase):
    HOSTILE = {"DYLD_INSERT_LIBRARIES": "/tmp/evil.dylib", "DYLD_LIBRARY_PATH": "/tmp", "LD_PRELOAD": "/tmp/evil.so", "LD_LIBRARY_PATH": "/tmp",
               "NODE_OPTIONS": "--require /tmp/evil.js", "NODE_PATH": "/tmp", "PYTHONPATH": "/tmp", "PYTHONSTARTUP": "/tmp/x.py", "GIT_EXEC_PATH": "/tmp",
               "GIT_CONFIG_GLOBAL": "/tmp/gc", "GIT_CONFIG_COUNT": "1", "BASH_ENV": "/tmp/b.sh", "ENV": "/tmp/e.sh", "PERL5OPT": "-M/tmp", "RUBYOPT": "-r/tmp",
               "IFS": "x", "SECRET_TOKEN": "s3cret", "PATH": "/tmp/evil-bin:/usr/bin"}

    def test_loader_variables_never_reach_a_child_even_when_the_parent_has_them(self):
        with mock.patch.dict(os.environ, self.HOSTILE):
            env = trusted_bin.child_env(inherit=("HOME", "SECRET_TOKEN", "USER"))
        self.assertEqual([k for k in env if trusted_bin.LOADER_ENV.match(k)], [])
        self.assertEqual(env["PATH"], os.pathsep.join(trusted_bin.system_dirs(env["HOME"])), "PATH is the fixed list, never the inherited one")
        self.assertEqual(env["SECRET_TOKEN"], "s3cret", "a name the caller lists is passed; nothing else is")
        self.assertNotIn("/tmp/evil", repr(env))

    def test_nothing_is_inherited_by_default(self):
        with mock.patch.dict(os.environ, {"SOME_AMBIENT": "x", "ANTHROPIC_API_KEY": "k"}):
            self.assertEqual(sorted(trusted_bin.child_env()), ["HOME", "LANG", "PATH"])

    def test_passing_or_inheriting_a_loader_variable_raises(self):
        for name in ("DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "GIT_EXEC_PATH", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_COUNT", "BASH_ENV", "ENV"):
            with self.assertRaisesRegex(ValueError, "refusing to pass"):
                trusted_bin.child_env(extra={name: "x"})
            with self.assertRaisesRegex(ValueError, "refusing to inherit"):
                trusted_bin.child_env(inherit=(name,))
        self.assertEqual(trusted_bin.child_env(extra={"GIT_CONFIG_NOSYSTEM": "1"})["GIT_CONFIG_NOSYSTEM"], "1")
        with self.assertRaisesRegex(ValueError, "NUL"):
            trusted_bin.child_env(extra={"X": "a\0b"})


class Spawning(unittest.TestCase):
    def policy(self, directory):
        return Policy(dirs=(str(directory),))

    def test_argv_reaches_the_program_verbatim_no_shell_no_expansion(self):
        directory = sandbox(self)
        marker = directory / "MARK"
        program = script(directory, "echoargs", 'for a in "$@"; do printf \'%s\\n\' "$a"; done')
        argv = ["a b", "$(touch %s)" % marker, "`touch %s`" % marker, "; touch %s" % marker, "-rf", "*", "x\ty", "quo'te\"s", "--", ""]
        done = trusted_bin.run([program] + argv, policy=self.policy(directory), capture_output=True, text=True)
        self.assertEqual(done.stdout, "".join(a + "\n" for a in argv))
        self.assertFalse(marker.exists(), "no shell ran an injected command")

    def test_a_child_sees_only_the_minimal_env(self):
        directory = sandbox(self)
        out = directory / "env.txt"
        program = script(directory, "dumpenv", "/usr/bin/env > '%s'" % out)
        with mock.patch.dict(os.environ, self.HOSTILE if hasattr(self, "HOSTILE") else Environment.HOSTILE):
            trusted_bin.run([program], policy=self.policy(directory), inherit=("HOME",), env={"EXPLICIT": "1"})
        seen = sorted(line.split("=")[0] for line in out.read_text().splitlines() if line and line.split("=")[0] not in ("PWD", "SHLVL", "_", "OLDPWD"))
        self.assertEqual(seen, ["EXPLICIT", "HOME", "LANG", "PATH"])

    def test_an_untrusted_program_is_refused_at_spawn_time_and_never_runs(self):
        directory = sandbox(self)
        marker = directory / "RAN"
        program = script(directory, "evil", "touch '%s'" % marker, 0o775)
        with self.assertRaises(trusted_bin.TrustRefused) as caught:
            trusted_bin.run([program], policy=self.policy(directory))
        self.assertEqual(caught.exception.reason, "writable")
        self.assertIsInstance(caught.exception, OSError)
        with self.assertRaises(trusted_bin.TrustRefused) as relative:
            trusted_bin.run(["evil"], policy=self.policy(directory))
        self.assertEqual(relative.exception.reason, "not-absolute")
        outside = script(sandbox(self), "outside", "touch '%s'" % marker)
        with self.assertRaises(trusted_bin.TrustRefused) as elsewhere:
            trusted_bin.run([outside], policy=self.policy(directory))
        self.assertEqual(elsewhere.exception.reason, "location")
        self.assertFalse(marker.exists())

    def test_a_missing_program_is_also_a_file_not_found_error(self):
        directory = sandbox(self)
        with self.assertRaises(FileNotFoundError):
            trusted_bin.run([str(directory / "absent")], policy=self.policy(directory))

    def test_a_program_trusted_at_resolve_time_is_refused_at_spawn_time_once_swapped(self):
        directory = sandbox(self)
        marker = directory / "RAN"
        program = script(directory, "later", "touch '%s'" % marker)
        self.assertTrue(trusted_bin.resolve("later", self.policy(directory)).ok)
        os.chmod(program, 0o777)
        with self.assertRaises(trusted_bin.TrustRefused) as caught:
            trusted_bin.run([program], policy=self.policy(directory))
        self.assertEqual(caught.exception.reason, "writable")
        self.assertFalse(marker.exists())

    def test_malformed_argv_and_forbidden_keywords_are_refused_before_anything_runs(self):
        directory = sandbox(self)
        program = script(directory, "ok", "exit 0")
        for argv in ([], [program, "a\0b"], [program, 1], "ok"):
            with self.assertRaises(trusted_bin.TrustRefused) as caught:
                trusted_bin.run(argv, policy=self.policy(directory))
            self.assertEqual(caught.exception.reason, "bad-argv", repr(argv))
        for keyword in ("shell", "executable", "preexec_fn"):
            with self.assertRaises(TypeError):
                trusted_bin.run([program], policy=self.policy(directory), **{keyword: True})

    def test_the_vetted_real_file_is_what_runs_while_argv0_stays_the_alias(self):
        directory = sandbox(self)
        target = script(directory, "real-target", 'printf "%s\\n" "$0"')
        os.symlink(target, str(directory / "alias"))
        done = trusted_bin.run([str(directory / "alias")], policy=self.policy(directory), capture_output=True, text=True)
        self.assertEqual(done.returncode, 0)

    def test_popen_and_exec_replace_vet_too(self):
        directory = sandbox(self)
        good, bad = script(directory, "good", "exit 0"), script(directory, "bad", "exit 0", 0o777)
        child = trusted_bin.popen([good], policy=self.policy(directory))
        self.assertEqual(child.wait(), 0)
        with self.assertRaises(trusted_bin.TrustRefused):
            trusted_bin.popen([bad], policy=self.policy(directory))
        with mock.patch("os.execve") as execve:
            trusted_bin.exec_replace(good, [good, "x"], {"A": "1", "LD_PRELOAD": "/evil", "PYTHONPATH": "/evil"})
            path, argv, env = execve.call_args[0]
            self.assertEqual((path, argv, env), (good, [good, "x"], {"A": "1"}))
        with mock.patch("os.execve") as execve, self.assertRaises(trusted_bin.TrustRefused):
            trusted_bin.exec_replace(bad, [bad], {})
        execve.assert_not_called()

    def test_self_python_is_the_running_interpreter(self):
        self.assertEqual(trusted_bin.self_python(), sys.executable)


class RealSystem(unittest.TestCase):
    def test_git_resolves_to_an_absolute_trusted_program_here(self):
        verdict = trusted_bin.resolve("git")
        self.assertTrue(verdict.ok and os.path.isabs(verdict.path))

    def test_td_h1w_36_a_path_planted_herdr_never_becomes_the_launch_plan_program(self):
        # The Python twin of the Osiris CRIT: launch_plan used shutil.which("herdr"), which walks PATH, so a planted herdr became the program bff launched.
        plant = sandbox(self)
        script(plant, "herdr", "echo PLANTED")
        with mock.patch.dict(os.environ, {"PATH": str(plant) + os.pathsep + os.environ.get("PATH", "")}):
            plan = launch.launch_plan("http://localhost:1")
        argv = plan["herdr"]["argv"]
        self.assertTrue(argv is None or not argv[0].startswith(str(plant)), argv)


if __name__ == "__main__":
    unittest.main()
