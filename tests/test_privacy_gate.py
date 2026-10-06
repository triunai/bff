"""Exercise scripts/privacy_gate.py against temporary git repos with runtime-assembled plants."""
import io
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

SDK = Path(__file__).resolve().parents[1]
GATE = SDK / "scripts" / "privacy_gate.py"
GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@example.com"]

PLANTS = {
    "home-path-posix": "cd " + "/Users/" + "planted/work",
    "home-path-windows": "C:" + "\\Users\\" + "planted\\work",
    "email": "planted.person" + "@" + "corp.test",
    "private-key": "-----BEGIN " + "PRIVATE KEY-----",
    "github-token": "ghp_" + "Z" * 36,
    "anthropic-key": "sk-ant-" + "Y" * 40,
    "aws-key": "AKIA" + "Q" * 16,
}


def run_gate(*args, env=None):
    full = dict(os.environ)
    full.pop("BFF_PRIVACY_DENYLIST", None)
    full.update(env or {})
    return subprocess.run([sys.executable, str(GATE), *args], capture_output=True, text=True, env=full)


def hits(result):
    found = set()
    for line in result.stdout.splitlines():
        if line.startswith("privacy gate:"):
            continue
        path, number, name = line.rsplit(":", 2)
        found.add((path, int(number), name.strip()))
    return found


class GateFixture(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="bff privacy gate ")
        self.addCleanup(self._tmp.cleanup)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()
        subprocess.run(GIT + ["init", "-q"], cwd=self.repo, check=True)

    def add(self, name, content, track=True):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if isinstance(content, bytes) else content.encode())
        if track:
            subprocess.run(["git", "add", "--", name], cwd=self.repo, check=True)

    def allowlist(self, text):
        path = Path(self._tmp.name) / "allow.txt"
        path.write_text(text)
        return ["--allowlist", str(path)]


class PatternTests(GateFixture):
    def test_each_pattern_hits_with_its_name_and_never_prints_the_match(self):
        for name, plant in PLANTS.items():
            with self.subTest(pattern=name):
                self.add("f_" + name + ".txt", "ok\n" + plant + "\n")
        result = run_gate(str(self.repo))
        self.assertEqual(result.returncode, 1, result.stdout)
        expected = {("f_" + name + ".txt", 2, name) for name in PLANTS}
        self.assertEqual(hits(result), expected)
        for plant in PLANTS.values():
            self.assertNotIn(plant, result.stdout)
            self.assertNotIn(plant, result.stderr)
        self.assertNotIn("planted", result.stdout + result.stderr)
        self.assertIn("privacy gate: %d hit(s) in %d file(s)" % (len(PLANTS), len(PLANTS)), result.stdout)

    def test_windows_path_accepts_forward_slashes_and_lowercase_drive(self):
        self.add("w.txt", "c:" + "/Users/" + "planted/x\n")
        self.assertIn(("w.txt", 1, "home-path-windows"), hits(run_gate(str(self.repo))))

    def test_clean_repo_exits_zero(self):
        self.add("a.txt", "nothing personal here\nuser@example\n")
        result = run_gate(str(self.repo))
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "privacy gate: clean (1 files)"))

    def test_untracked_file_is_ignored(self):
        self.add("a.txt", "fine\n")
        self.add("loose.txt", PLANTS["email"], track=False)
        self.assertEqual(run_gate(str(self.repo)).returncode, 0)

    def test_binary_file_is_skipped(self):
        self.add("blob.bin", b"\0" + PLANTS["email"].encode())
        self.assertEqual(run_gate(str(self.repo)).returncode, 0)

    def test_not_a_git_repo_is_exit_two(self):
        result = run_gate(self._tmp.name)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(self._tmp.name, result.stderr)


class AllowlistAndDenylistTests(GateFixture):
    def test_allowlist_suppresses_only_its_path_and_pattern(self):
        self.add("docs/a.md", PLANTS["email"] + "\n")
        self.add("docs/b.md", PLANTS["email"] + "\n" + PLANTS["home-path-posix"] + "\n")
        self.add("src/c.md", PLANTS["email"] + "\n")
        args = self.allowlist("# comment\n\ndocs/*.md email planted fixture, not a real address\n")
        result = run_gate(str(self.repo), *args)
        self.assertEqual(hits(result), {("docs/b.md", 2, "home-path-posix"), ("src/c.md", 1, "email")})

    def test_malformed_allowlist_is_exit_two(self):
        self.add("a.txt", "x\n")
        self.assertEqual(run_gate(str(self.repo), *self.allowlist("docs/*.md email\n")).returncode, 2)

    def test_env_denylist_is_case_insensitive_and_never_printed(self):
        name = "Zed" + "Quincy"
        self.add("a.txt", "written by " + name.upper() + "\n")
        result = run_gate(str(self.repo), env={"BFF_PRIVACY_DENYLIST": "\n" + name.lower() + "\nother" + "thing\n"})
        self.assertEqual(hits(result), {("a.txt", 1, "denylist")})
        self.assertNotIn(name.lower(), (result.stdout + result.stderr).lower())

    def test_denylist_unset_means_no_denylist_hits(self):
        self.add("a.txt", "Zed" + "Quincy\n")
        self.assertEqual(run_gate(str(self.repo)).returncode, 0)


class ArchiveTests(GateFixture):
    def build_tar(self, members):
        path = Path(self._tmp.name) / "rel.tar.gz"
        with tarfile.open(path, "w:gz") as tf:
            for name, data in members.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
        return path

    def test_archive_members_are_scanned_and_labelled(self):
        self.add("a.txt", "clean\n")
        archive = self.build_tar({
            "bff-1/ok.txt": b"fine\n",
            "bff-1/bad.txt": b"x\n" + PLANTS["github-token"].encode() + b"\n",
            "bff-1/bin.dat": b"\0" + PLANTS["email"].encode(),
        })
        result = run_gate(str(self.repo), "--archive", str(archive))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(hits(result), {("archive:bff-1/bad.txt", 2, "github-token")})
        self.assertNotIn(PLANTS["github-token"], result.stdout + result.stderr)

    def test_clean_archive_counts_its_members(self):
        self.add("a.txt", "clean\n")
        archive = self.build_tar({"bff-1/ok.txt": b"fine\n"})
        result = run_gate(str(self.repo), "--archive", str(archive))
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "privacy gate: clean (2 files)"))

    def test_unreadable_archive_is_exit_two(self):
        self.add("a.txt", "clean\n")
        bogus = Path(self._tmp.name) / "bogus.tar.gz"
        bogus.write_bytes(b"not a tarball")
        self.assertEqual(run_gate(str(self.repo), "--archive", str(bogus)).returncode, 2)


class ThisRepositoryTests(unittest.TestCase):
    def test_only_the_known_recorded_command_is_flagged(self):
        result = run_gate(str(SDK))
        found = hits(result)
        known = {("evidence/doctor-fix-2026-10-05.md", 29, "home-path-posix")}
        if not found:
            self.fail("The privacy gate is now clean: the known debt (a recorded home path in the doctor-fix "
                      "evidence, decision D4) is gone. Change this expectation to assert a clean repository "
                      "(exit 0) and make the CI privacy job blocking.")
        self.assertEqual(found, known, "The gate found hits beyond the known recorded-debt line.")
        self.assertEqual(result.returncode, 1)
        self.assertIn("privacy gate: 1 hit(s) in 1 file(s)", result.stdout)


if __name__ == "__main__":
    unittest.main()
