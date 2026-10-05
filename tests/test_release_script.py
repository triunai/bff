"""scripts/release.py: bump, pin rewrite, notes extraction, printed commands and publish guards."""
import contextlib
import io
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SDK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SDK / "scripts"))

import release  # noqa: E402
import versioning  # noqa: E402


def scratch(directory):
    root = Path(directory) / "source"
    shutil.copytree(SDK, root, ignore=shutil.ignore_patterns("node_modules", ".git", "__pycache__", "*.pyc"))
    return root


def add_section(root, version):
    path = root / "CHANGELOG.md"
    path.write_text(path.read_text().replace("## [Unreleased]\n", "## [Unreleased]\n\n## [%s] - 2030-01-01\n\n### Added\n- thing\n" % version, 1))


class PureHelperTests(unittest.TestCase):
    def test_bumped(self):
        self.assertEqual(release.bumped("0.1.9", "patch"), "0.1.10")
        self.assertEqual(release.bumped("0.1.9", "minor"), "0.2.0")
        self.assertEqual(release.bumped("0.1.9", "major"), "1.0.0")

    def test_changelog_section_is_exactly_that_versions_body(self):
        notes = release.changelog_section(SDK, "0.1.0")
        self.assertIn("Portable `bff` CLI", notes)
        self.assertNotIn("doctor now installs", notes)
        self.assertNotIn("github.com/triunai/bff/compare", notes)
        with self.assertRaises(ValueError):
            release.changelog_section(SDK, "9.9.9")

    def test_commands_never_override_and_target_the_tag(self):
        commands = release.release_commands("1.2.3", "/out", "/out/RELEASE_NOTES.md")
        flat = [part for command in commands for part in command]
        self.assertFalse([p for p in flat if p in ("--force", "-f", "--force-with-lease") or p.startswith("+")])
        self.assertEqual(commands[0], ["git", "push", "origin", "HEAD:main"])
        self.assertIn("v1.2.3", commands[2])
        gh = commands[3]
        self.assertEqual(gh[:4], ["gh", "release", "create", "v1.2.3"])
        self.assertIn("/out/bff-1.2.3.tar.gz", gh)
        self.assertIn("/out/SHA256SUMS", gh)
        self.assertIn("--verify-tag", gh)


class MainTests(unittest.TestCase):
    def run_main(self, root, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = release.main(list(args), root=root)
        return code, out.getvalue()

    def test_bump_rewrites_pins_builds_and_prints_but_runs_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = scratch(directory)
            target = release.bumped(versioning.read_version(root), "patch")
            add_section(root, target)
            output = Path(directory) / "out"
            with mock.patch("release.subprocess.run", wraps=subprocess.run) as spy:
                code, text = self.run_main(root, "--bump", "patch", "--skip-tests", "--output", str(output))
            self.assertEqual(code, 0)
            self.assertEqual(versioning.read_version(root), target)
            self.assertEqual(versioning.check_pins(root), [])
            self.assertIn("/v%s/install.sh" % target, (root / "README.md").read_text())
            self.assertTrue((output / ("bff-%s.tar.gz" % target)).is_file())
            self.assertIn("- thing", (output / "RELEASE_NOTES.md").read_text())
            self.assertIn("gh release create v" + target, text)
            executed = [call.args[0][0] for call in spy.call_args_list]
            self.assertNotIn("gh", executed)
            self.assertNotIn("git", executed)

    def test_missing_changelog_section_stops_before_building(self):
        with tempfile.TemporaryDirectory() as directory:
            root = scratch(directory)
            with self.assertRaises(SystemExit) as raised:
                self.run_main(root, "--version", "0.9.0", "--skip-tests", "--output", str(Path(directory) / "out"))
            self.assertIn("CHANGELOG.md", str(raised.exception))
            self.assertFalse((Path(directory) / "out").exists())

    def test_a_failing_check_stops_the_release_before_the_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = scratch(directory)
            with mock.patch("release.subprocess.run", return_value=subprocess.CompletedProcess([], 1)):
                with self.assertRaises(SystemExit) as raised:
                    self.run_main(root, "--output", str(Path(directory) / "out"))
            self.assertIn("Checks failed", str(raised.exception))
            self.assertFalse((Path(directory) / "out").exists())

    def test_publish_refuses_skip_tests(self):
        with tempfile.TemporaryDirectory() as directory:
            root = scratch(directory)
            with self.assertRaises(SystemExit) as raised:
                self.run_main(root, "--skip-tests", "--publish", "--output", str(Path(directory) / "out"))
            self.assertIn("--skip-tests", str(raised.exception))

    def test_publish_guards_report_each_problem(self):
        def fake(*argv, **kwargs):
            command = argv[0]
            if command[:2] == ["git", "status"]:
                return subprocess.CompletedProcess(command, 0, " M README.md\n", "")
            if command[:2] == ["gh", "auth"]:
                return subprocess.CompletedProcess(command, 1, "", "")
            if command[:2] == ["git", "rev-parse"]:
                return subprocess.CompletedProcess(command, 0, "abc\n", "")
            return subprocess.CompletedProcess(command, 0, "", "")
        with mock.patch("release.subprocess.run", side_effect=fake):
            problems = release.publish_guards(SDK, "0.1.1")
        text = " | ".join(problems)
        self.assertIn("not clean", text)
        self.assertIn("gh is not authenticated", text)
        self.assertIn("already exists locally", text)

    def test_publish_runs_commands_in_order_and_stops_at_first_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = scratch(directory)
            add_section(root, versioning.read_version(root))
            calls = []

            def fake(command, **kwargs):
                calls.append(command[:2])
                return subprocess.CompletedProcess(command, 1 if command[:2] == ["git", "tag"] else 0, "", "")
            with mock.patch("release.run_checks"), mock.patch("release.publish_guards", return_value=[]), \
                    mock.patch("release.subprocess.run", side_effect=fake):
                with self.assertRaises(SystemExit):
                    self.run_main(root, "--publish", "--output", str(Path(directory) / "out"))
            publish_calls = [c for c in calls if c[0] in ("git", "gh")]
            self.assertEqual(publish_calls, [["git", "push"], ["git", "tag"]])


if __name__ == "__main__":
    unittest.main()
