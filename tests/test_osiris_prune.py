import ast
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
from bff import cli, osiris_prune

ROOT = Path(__file__).resolve().parents[1]
IDENTITY = ["-c", "user.name=t", "-c", "user.email=tester", "-c", "commit.gpgsign=false"]


def git(cwd, *argv):
    done = subprocess.run(["git"] + IDENTITY + list(argv), cwd=str(cwd), capture_output=True, text=True)
    assert done.returncode == 0, (argv, done.stderr)
    return done.stdout.strip()


class PruneApplyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="bff prune ")
        self.addCleanup(self.temporary.cleanup)
        base = Path(self.temporary.name).resolve()
        self.remote, self.repo, self.plugin = base / "remote.git", base / "repo", base / "plugin"
        (self.plugin / "bin").mkdir(parents=True)
        git(base, "init", "--bare", "-b", "main", str(self.remote))
        git(base, "init", "-b", "main", str(self.repo))
        (self.repo / "a.txt").write_text("a\n")
        git(self.repo, "add", "a.txt")
        git(self.repo, "commit", "-m", "init")
        git(self.repo, "remote", "add", "origin", str(self.remote))
        git(self.repo, "push", "origin", "main")
        git(self.repo, "fetch", "origin")
        self.trees = {}
        for name in ("safe", "dirty", "unpushed", "locked"):
            path = base / ("wt-" + name)
            git(self.repo, "worktree", "add", "-b", "b-" + name, str(path))
            self.trees[name] = path
        (self.trees["unpushed"] / "b.txt").write_text("b\n")
        git(self.trees["unpushed"], "add", "b.txt")
        git(self.trees["unpushed"], "commit", "-m", "local only")
        git(self.repo, "worktree", "lock", str(self.trees["locked"]))
        self.plan = {"opts": {}, "review": [], "keep": [],
                     "safe": [{"path": str(p), "name": n, "branch": "b-" + n, "bucket": "SAFE", "reason": "stub"} for n, p in self.trees.items()]}
        (self.trees["dirty"] / "scratch.txt").write_text("became dirty after the plan\n")

    def args(self, **kw):
        values = dict(repo=self.repo, yes=True, min_idle_days=None, json=False, apply=True)
        values.update(kw)
        return mock.Mock(**values)

    def apply(self, **kw):
        out = io.StringIO()
        code = osiris_prune.apply_prune(self.plugin, self.args(**kw), out=out, plan=self.plan)
        return code, out.getvalue()

    def test_removes_exactly_the_safe_one_and_never_a_branch(self):
        code, out = self.apply()
        self.assertEqual(code, 0, out)
        self.assertFalse(self.trees["safe"].exists())
        for name in ("dirty", "unpushed", "locked"):
            self.assertTrue(self.trees[name].exists(), name)
        self.assertEqual(len(git(self.repo, "branch", "--list", "b-*").splitlines()), 4)
        self.assertIn("skipped " + str(self.trees["dirty"]) + ": uncommitted", out)
        self.assertIn("commits not on any remote or main", out)
        self.assertIn("locked", out)
        self.assertIn("removed 1, skipped 3", out)

    def test_the_main_worktree_and_installed_plugin_are_never_removed(self):
        installed = self.trees["safe"]
        self.plan["opts"]["installed"] = str(installed)
        self.plan["safe"].append({"path": str(self.repo), "name": "repo", "branch": "main", "bucket": "SAFE", "reason": "stub"})
        _, out = self.apply()
        self.assertTrue(installed.exists())
        self.assertTrue(self.repo.exists())
        self.assertIn("installed plugin", out)
        self.assertIn("main worktree", out)

    def test_the_newest_three_install_dirs_are_protected(self):
        installs = self.plugin.parent / "installs"
        installs.mkdir()
        for index in range(4):
            directory = installs / ("install-" + str(index))
            directory.mkdir()
            os.utime(str(directory), (1000 + index, 1000 + index))
        keep = osiris_prune.protected_dirs({"opts": {"installed": str(installs / "install-3")}}, self.plugin)
        self.assertEqual({Path(k).name for k in keep if "install-" in k}, {"install-1", "install-2", "install-3"})

    def test_no_terminal_means_no_removal(self):
        stdin = mock.Mock()
        stdin.isatty.return_value = False
        with contextlib.redirect_stderr(io.StringIO()):
            code = osiris_prune.apply_prune(self.plugin, self.args(yes=False), out=io.StringIO(), stdin=stdin, plan=self.plan)
        self.assertEqual(code, 2)
        self.assertTrue(self.trees["safe"].exists())

    def test_answering_no_removes_nothing_and_yes_removes(self):
        stdin = mock.Mock()
        stdin.isatty.return_value = True
        stdin.readline.return_value = "n\n"
        osiris_prune.apply_prune(self.plugin, self.args(yes=False), out=io.StringIO(), stdin=stdin, plan=self.plan)
        self.assertTrue(self.trees["safe"].exists())
        stdin.readline.return_value = "y\n"
        osiris_prune.apply_prune(self.plugin, self.args(yes=False), out=io.StringIO(), stdin=stdin, plan=self.plan)
        self.assertFalse(self.trees["safe"].exists())

    def test_the_default_is_a_dry_run_that_never_reaches_apply(self):
        (self.plugin / "bin" / "osiris-tui.mjs").write_text("// stub\n")
        with mock.patch.dict(os.environ, {"OSIRIS_PLUGIN_DIR": str(self.plugin)}), mock.patch("bff.osiris_tui.trusted_bin.which", return_value="/fake/node"), \
                mock.patch("bff.osiris_tui.trusted_bin.run", return_value=subprocess.CompletedProcess([], 0)) as run, \
                mock.patch("bff.osiris_prune.apply_prune") as apply:
            self.assertEqual(cli.main(["osiris", "prune", "--repo", str(self.repo)]), 0)
        apply.assert_not_called()
        self.assertNotIn("--apply", run.call_args[0][0])

    def test_the_cli_refuses_a_force_flag(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            cli.main(["osiris", "prune", "--apply", "--force"])


class PruneFitness(unittest.TestCase):
    def test_source_never_forces_or_deletes_a_branch_or_moves_history(self):
        text = (ROOT / "bff" / "osiris_prune.py").read_text(encoding="utf-8")
        calls = [n for n in ast.walk(ast.parse(text)) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "_git"]
        verbs = {a.value for c in calls for a in c.args if isinstance(a, ast.Constant) and isinstance(a.value, str)}
        self.assertLessEqual(verbs, {"worktree", "list", "--porcelain", "status", "rev-parse", "HEAD", "--verify", "--quiet", "rev-list", "--count", "--not", "remove", "prune", "--remotes"})
        strings = [n.value for n in ast.walk(ast.parse(text)) if isinstance(n, ast.Constant) and isinstance(n.value, str)]
        banned = ("--force", "-f", "-D", "-d", "--delete", "update-ref", "push", "reset", "checkout", "clean", "gc")
        self.assertEqual([s for s in strings if s in banned], [])
        self.assertNotIn("branch", verbs)
        self.assertEqual([s for s in strings if s.startswith("--force")], [])


if __name__ == "__main__":
    unittest.main()
