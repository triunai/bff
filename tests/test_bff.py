import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SDK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SDK))
from bff import cli
from bff.project import PROFILE, init_repo, load_profile, repo_root

spec = importlib.util.spec_from_file_location("bff_installer", SDK / "install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def tree(root):
    return {str(path.relative_to(root)): path.read_bytes()
            for path in root.rglob("*") if path.is_file() and not path.is_symlink()}


class Scratch(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="bff tests ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "git repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        self.prefix = self.root / "prefix with spaces"
        self.source = self.root / "release source"
        self.source.mkdir()
        for name in ("bff", "templates"):
            shutil.copytree(str(SDK / name), str(self.source / name), ignore=shutil.ignore_patterns("__pycache__"))
        (self.source / "README.md").write_text("BFF scratch release\n")

    def command(self, args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = cli.main(args)
        return code, stdout.getvalue(), stderr.getvalue()

    def init(self):
        return init_repo(self.repo, self.source / "templates" / "repo")

    def write_profile(self, **changes):
        path = self.repo / ".bff.json"
        profile = json.loads(path.read_text())
        profile.update(changes)
        path.write_text(json.dumps(profile))


class InstallationTests(Scratch):
    def test_install_reinstall_disable_activate(self):
        first = installer.install(self.prefix, source=self.source)
        before = tree(self.prefix)
        second = installer.install(self.prefix, source=self.source)
        self.assertEqual(first["release"], second["release"])
        self.assertEqual(before, tree(self.prefix))
        command = self.prefix / "bin" / "bff"
        run = subprocess.run([str(command), "--version"], capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout.strip(), "bff 0.1.0")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(installer.main(["--prefix", str(self.prefix), "--disable"]), 0)
        self.assertFalse(command.exists())
        release = self.prefix / "share" / "bff" / "releases" / first["release"]
        installer.activate(release, self.prefix)
        self.assertTrue(command.is_symlink())
        self.assertEqual(before, tree(self.prefix))

    def test_collision_has_no_writes(self):
        (self.prefix / "bin").mkdir(parents=True)
        (self.prefix / "bin" / "bff").write_text("unrelated")
        before = tree(self.prefix)
        with self.assertRaisesRegex(ValueError, "unrelated"):
            installer.install(self.prefix, source=self.source)
        self.assertEqual(before, tree(self.prefix))
        self.assertFalse((self.prefix / "share").exists())

    def test_unrelated_symlink_and_directory_collision(self):
        (self.prefix / "bin").mkdir(parents=True)
        command = self.prefix / "bin" / "bff"
        command.symlink_to(self.root / "missing")
        with self.assertRaises(ValueError):
            installer.install(self.prefix, source=self.source)
        command.unlink()
        (self.prefix / "share").symlink_to(self.root)
        with self.assertRaisesRegex(ValueError, "directory collision"):
            installer.install(self.prefix, source=self.source)

    def test_tamper_reinstall_and_activation_refused(self):
        result = installer.install(self.prefix, source=self.source)
        release = self.prefix / "share" / "bff" / "releases" / result["release"]
        target = release / "bff" / "cli.py"
        target.write_text(target.read_text() + "\n# mutation\n")
        with self.assertRaisesRegex(ValueError, "integrity"):
            installer.install(self.prefix, source=self.source)
        with self.assertRaisesRegex(ValueError, "integrity"):
            installer.activate(release, self.prefix)

    def test_complete_inventory_rejects_extra_missing_and_links(self):
        result = installer.install(self.prefix, source=self.source)
        release = self.prefix / "share" / "bff" / "releases" / result["release"]
        extra = release / "unmanifested.txt"
        extra.write_text("unexpected")
        with self.assertRaises(ValueError):
            installer.activate(release, self.prefix)
        extra.unlink()
        target = release / "bff" / "cli.py"
        original = target.read_bytes()
        target.unlink()
        with self.assertRaises(ValueError):
            installer.activate(release, self.prefix)
        copy = self.root / "copied cli"
        copy.write_bytes(original)
        target.symlink_to(copy)
        with self.assertRaisesRegex(ValueError, "Non-regular"):
            installer.activate(release, self.prefix)

    def test_python_interpreter_with_spaces(self):
        interpreter = self.root / "python interpreter with spaces"
        import shlex
        interpreter.write_text("#!/bin/sh\nexec " + shlex.quote(sys.executable) + ' "$@"\n')
        interpreter.chmod(0o755)
        installer.install(self.prefix, source=self.source, interpreter=interpreter)
        result = subprocess.run([str(self.prefix / "bin" / "bff"), "--version"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "bff 0.1.0")

    def test_source_allowlist_and_no_symlink_vendoring(self):
        for name in ("LICENSE", "PROVENANCE.md", "install.sh"):
            (self.source / name).write_text(name)
        (self.source / "docs").mkdir()
        (self.source / "docs" / "portable.md").write_text("portable docs")
        (self.source / "private.txt").write_text("exclude")
        result = installer.install(self.prefix, source=self.source)
        release = self.prefix / "share" / "bff" / "releases" / result["release"]
        self.assertFalse((release / "private.txt").exists())
        self.assertTrue((release / "LICENSE").is_file())
        self.assertTrue((release / "docs" / "portable.md").is_file())
        (self.source / "templates" / "escaped").symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            installer.install(self.prefix, source=self.source)

    def test_new_release_preserves_old_and_rollback(self):
        first = installer.install(self.prefix, source=self.source)
        (self.source / "README.md").write_text("new README")
        second = installer.install(self.prefix, source=self.source)
        self.assertNotEqual(first["release"], second["release"])
        releases = self.prefix / "share" / "bff" / "releases"
        self.assertTrue((releases / first["release"]).exists())
        installer.activate(releases / first["release"], self.prefix)
        self.assertEqual((self.prefix / "bin" / "bff").resolve(), (releases / first["release"] / "bin" / "bff").resolve())

    def test_archive_manifest_tamper_extra_and_traversal_refusal(self):
        shutil.copy2(str(SDK / "install.py"), str(self.source / "install.py"))
        manifest = {"version": "0.1.0", "files": installer.inventory(self.source)}
        path = self.source / "release-manifest.json"
        path.write_text(json.dumps(manifest))
        installer.verify_source_manifest(self.source)
        (self.source / "README.md").write_text("tamper")
        with self.assertRaisesRegex(ValueError, "integrity"):
            installer.install(self.prefix, source=self.source)
        self.assertFalse(self.prefix.exists())
        (self.source / "README.md").write_text("BFF scratch release\n")
        (self.source / "unexpected.txt").write_text("extra")
        with self.assertRaisesRegex(ValueError, "integrity"):
            installer.verify_source_manifest(self.source)
        (self.source / "unexpected.txt").unlink()
        manifest["files"]["../escape"] = "0" * 64
        path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "Invalid"):
            installer.verify_source_manifest(self.source)

    def test_optional_plugin_inventory_refuses_maps_and_node_modules(self):
        plugin = self.source / "plugins" / "osiris"
        (plugin / "dist").mkdir(parents=True)
        (plugin / "package.json").write_text('{}')
        (plugin / "dist" / "app.js").write_text("// prebuilt")
        (plugin / "dist" / "app.meta.json").write_text('{}')
        (plugin / "dist" / "server.meta.json").write_text('{}')
        (plugin / "LICENSE").write_text("MIT")
        (plugin / "THIRD_PARTY_NOTICES.txt").write_text("notices")
        result = installer.install(self.prefix, source=self.source)
        release = self.prefix / "share" / "bff" / "releases" / result["release"]
        self.assertTrue((release / "plugins" / "osiris" / "dist" / "app.js").exists())
        self.assertTrue((release / "plugins" / "osiris" / "dist" / "app.meta.json").exists())
        self.assertTrue((release / "plugins" / "osiris" / "THIRD_PARTY_NOTICES.txt").exists())
        (plugin / "dist" / "app.js.map").write_text("source map")
        with self.assertRaisesRegex(ValueError, "Unapproved"):
            installer.install(self.prefix, source=self.source)
        (plugin / "dist" / "app.js.map").unlink()
        (plugin / "node_modules").mkdir()
        (plugin / "node_modules" / "dep.js").write_text("dependency")
        with self.assertRaisesRegex(ValueError, "Unapproved"):
            installer.install(self.prefix, source=self.source)


class ProjectTests(Scratch):
    def test_init_repeat_preserves_edited_router(self):
        self.assertEqual(self.init()["status"], "initialized")
        router = self.repo / "hygiene.md"
        router.write_text(router.read_text() + "\nProject addition\n")
        before = tree(self.repo)
        self.assertEqual(self.init()["status"], "already-initialized")
        self.assertEqual(before, tree(self.repo))
        self.assertEqual(json.loads((self.repo / ".bff.json").read_text()), PROFILE)

    def test_init_collision_preflight_no_writes(self):
        for name in ("hygiene.md", "docs/workstreams.md", ".bff.json", ".agents/skills/bff-hydrate/SKILL.md"):
            with self.subTest(name=name):
                target = self.repo / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("existing")
                before = tree(self.repo)
                with self.assertRaises((ValueError, json.JSONDecodeError)):
                    self.init()
                self.assertEqual(before, tree(self.repo))
                target.unlink()

    def test_partial_init_is_refused(self):
        self.init()
        (self.repo / "docs" / "decisions.md").unlink()
        before = tree(self.repo)
        with self.assertRaisesRegex(ValueError, "incomplete"):
            self.init()
        self.assertEqual(before, tree(self.repo))

    def test_init_rolls_back_midwrite_failure(self):
        before = tree(self.repo)
        original = os.link
        calls = []
        def fail(source, target):
            calls.append(target)
            if len(calls) == 3:
                raise OSError("injected")
            return original(source, target)
        with mock.patch("bff.project.os.link", side_effect=fail):
            with self.assertRaisesRegex(OSError, "injected"):
                self.init()
        self.assertEqual(before, tree(self.repo))
        self.assertFalse((self.repo / "docs").exists())
        self.assertFalse((self.repo / ".agents").exists())

    def test_check_fresh_spine_and_hydrate_are_read_only(self):
        self.init()
        before = tree(self.repo)
        code, stdout, stderr = self.command(["check", "--repo", str(self.repo)])
        self.assertEqual(code, 0, stderr + stdout)
        self.assertIn("Threads read: 1", stdout)
        self.assertIn('"execution": "not-requested"', stdout)
        code, stdout, stderr = self.command(["hydrate", "--repo", str(self.repo), "--ws", "WS-01"])
        self.assertEqual(code, 0, stderr)
        self.assertIn("selected WS-01", stdout)
        self.assertIn("hygiene.md", stdout)
        self.assertEqual(before, tree(self.repo))

    def test_checker_teeth_real_bad_mutations(self):
        self.init()
        board = self.repo / "docs" / "workstreams.md"
        original = board.read_text()
        mutations = (("empty", "# Empty\n", "no canonical"),
                     ("duplicate", original + original, "Duplicate workstream"),
                     ("malformed", original.replace("### WS-01", "### WS-1"), "Malformed"),
                     ("wrong-first-line", original.replace("WS: WS-01", "Owner: somebody\nWS: WS-01"), "First body"),
                     ("bad-reference", original + "\nDepends: WS-99\n", "Unresolved"),
                     ("malformed-reference", original + "\nDepends: WS-1\n", "Malformed"))
        for name, content, message in mutations:
            with self.subTest(name=name):
                board.write_text(content)
                code, stdout, stderr = self.command(["check", "--repo", str(self.repo)])
                self.assertEqual(code, 1, stderr)
                self.assertIn(message, stdout)
                self.assertIn("Threads read:", stdout)
        board.write_text(original)
        self.assertEqual(self.command(["check", "--repo", str(self.repo)])[0], 0)

    def test_duplicate_decision_backlog_journal_ids(self):
        self.init()
        for filename, heading in (("decisions.md", "D-001"), ("state-backlog.md", "#001"),
                                  ("project-log.md", "2026-10-05#1")):
            path = self.repo / "docs" / filename
            original = path.read_text()
            if filename == "project-log.md":
                path.write_text(original + original)
            else:
                path.write_text("### " + heading + " — one\nWS: WS-01\n\n### " + heading + " — two\nWS: WS-01\n")
            code, stdout, stderr = self.command(["check", "--repo", str(self.repo)])
            self.assertEqual(code, 1, stderr)
            self.assertIn("Duplicate", stdout)
            path.write_text(original)

    def test_first_bodyline_and_done_journal_claim(self):
        self.init()
        journal = self.repo / "docs" / "project-log.md"
        journal.write_text("### 2026-10-05#1 — bad\nOwner: somebody\nWS: WS-01\n")
        board = self.repo / "docs" / "workstreams.md"
        board.write_text(board.read_text().replace("Status: 🟢 ACTIVE", "Status: DONE"))
        code, stdout, _ = self.command(["check", "--repo", str(self.repo)])
        self.assertEqual(code, 1)
        self.assertIn("First body line", stdout)
        self.assertIn("lacks journal claim", stdout)
        journal.write_text("### 2026-10-05#1 — done\nWS: WS-01\nDone.\n")
        self.assertEqual(self.command(["check", "--repo", str(self.repo)])[0], 0)

    def test_paths_and_symlink_escape_are_refused_with_canary(self):
        self.init()
        self.write_profile(router="../outside.md")
        code, stdout, _ = self.command(["check", "--repo", str(self.repo)])
        self.assertEqual(code, 2)
        self.assertIn("Threads read:", stdout)
        self.write_profile(router="hygiene.md")
        router = self.repo / "hygiene.md"
        router.unlink()
        external = self.root / "outside.md"
        external.write_text("outside")
        router.symlink_to(external)
        self.assertEqual(self.command(["check", "--repo", str(self.repo)])[0], 2)
        self.assertEqual(self.command(["hydrate", "--repo", str(self.repo)])[0], 2)

    def test_named_argv_only_on_explicit_run_and_result_statuses(self):
        self.init()
        marker = self.repo / "argv result.txt"
        checks = {"argv": [sys.executable, "-c", "import pathlib,sys;pathlib.Path(sys.argv[1]).write_text(sys.argv[2])", str(marker), "literal $(touch injected)"],
                  "failure": [sys.executable, "-c", "raise SystemExit(7)"],
                  "missing": ["bff-test-missing-executable-4f887"]}
        self.write_profile(checks=checks)
        self.assertEqual(self.command(["check", "--repo", str(self.repo)])[0], 0)
        self.assertFalse(marker.exists())
        code, stdout, _ = self.command(["check", "--repo", str(self.repo), "--run"])
        self.assertEqual(code, 1)
        self.assertEqual(marker.read_text(), "literal $(touch injected)")
        self.assertFalse((self.repo / "injected").exists())
        self.assertIn('"status": "nonzero"', stdout)
        self.assertIn('"status": "missing-executable"', stdout)
        denied = self.repo / "not executable"
        denied.write_text("not executable")
        self.write_profile(checks={"denied": [str(denied)]})
        code, stdout, _ = self.command(["check", "--repo", str(self.repo), "--run"])
        self.assertEqual(code, 1)
        self.assertIn('"status": "tool-error"', stdout)

    def test_default_root_current_git_and_subdir(self):
        sub = self.repo / "nested"
        sub.mkdir()
        self.assertEqual(repo_root(sub), self.repo.resolve())
        with mock.patch("bff.project.Path.cwd", return_value=sub):
            self.assertEqual(repo_root(), self.repo.resolve())

    def test_doctor_does_not_execute_or_read_configs(self):
        with mock.patch("bff.cli.shutil.which", return_value="/mock/available"), mock.patch("subprocess.run") as run:
            code, stdout, _ = self.command(["doctor"])
            self.assertEqual(code, 0)
            self.assertIn('"integration": "unverified"', stdout)
            run.assert_not_called()

    def test_osiris_print_only_and_unreachable(self):
        with mock.patch("bff.cli.http.client.HTTPConnection") as connection, mock.patch("bff.cli.webbrowser.open") as browser:
            code, stdout, _ = self.command(["osiris", "--print-url"])
            self.assertEqual(code, 0)
            self.assertEqual(stdout.strip(), cli.OSIRIS_URL)
            connection.assert_not_called()
            browser.assert_not_called()
            connection.return_value.request.side_effect = ConnectionRefusedError("unreachable")
            self.assertEqual(self.command(["osiris"])[0], 2)
            browser.assert_not_called()

    def test_osiris_install_argv_and_missing_bundle(self):
        with mock.patch("bff.cli.shutil.which", return_value=None):
            self.assertEqual(self.command(["osiris", "--install"])[0], 2)
        with mock.patch("bff.cli.__file__", str(self.root / "absent release" / "bff" / "cli.py")), \
                mock.patch("bff.cli.shutil.which", return_value="/fake/bb"), \
                mock.patch("bff.cli.subprocess.run") as run:
            self.assertEqual(self.command(["osiris", "--install"])[0], 2)
            run.assert_not_called()
        # Point the module resource root at a scratch release; no workspace/global writes.
        package = self.root / "bundle release" / "bff"
        package.mkdir(parents=True)
        bundle = package.parent / "plugins" / "osiris"
        bundle.mkdir(parents=True)
        (bundle / "package.json").write_text('{}')
        with mock.patch("bff.cli.__file__", str(package / "cli.py")), \
                mock.patch("bff.cli.shutil.which", return_value="/fake/bb"), \
                mock.patch("bff.cli.subprocess.run", return_value=subprocess.CompletedProcess([], 0)) as run, \
                mock.patch("bff.cli.http.client.HTTPConnection") as connection, \
                mock.patch("bff.cli.webbrowser.open", return_value=True) as browser:
            connection.return_value.getresponse.return_value.status = 200
            code, stdout, stderr = self.command(["osiris", "--install"])
            self.assertEqual(code, 0, stderr)
            run.assert_called_once_with(["/fake/bb", "plugin", "install", str(bundle.resolve()), "--yes"], timeout=120)
            browser.assert_called_once_with(cli.OSIRIS_URL)


if __name__ == "__main__":
    unittest.main()
