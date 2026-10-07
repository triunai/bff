"""D7 PATH step, install.sh download path, builder SUMS, release workflow check. No network, no real home."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import install as installer  # noqa: E402


class FakeStdin(io.StringIO):
    def __init__(self, text="", tty=True):
        super().__init__(text)
        self._tty = tty

    def isatty(self):
        return self._tty


class PathStepTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.home = Path(self._tmp.name) / "home"
        self.home.mkdir()
        self.bin = "/opt/example/bin"

    def offer(self, shell="/bin/zsh", answer="\n", tty=True, system="Linux", **flags):
        out = io.StringIO()
        result = installer.offer_path(self.bin, env={"SHELL": shell}, stdin=FakeStdin(answer, tty), out=out,
                                      home=self.home, system=system, **flags)
        return result, out.getvalue()

    def test_rc_file_per_shell(self):
        self.assertEqual(installer.rc_file("/bin/zsh", "Darwin", self.home), self.home / ".zprofile")
        self.assertEqual(installer.rc_file("/bin/bash", "Darwin", self.home), self.home / ".bash_profile")
        self.assertEqual(installer.rc_file("/bin/bash", "Linux", self.home), self.home / ".bashrc")
        self.assertEqual(installer.rc_file("/usr/bin/fish", "Linux", self.home), self.home / ".config" / "fish" / "conf.d" / "bff.fish")
        self.assertEqual(installer.rc_file("/bin/dash", "Linux", self.home), self.home / ".profile")
        self.assertEqual(installer.rc_file("", "Linux", self.home), self.home / ".profile")

    def test_path_line_per_shell_and_spaces(self):
        self.assertEqual(installer.path_line("/bin/zsh", "/opt/x/bin"), 'export PATH="/opt/x/bin:$PATH"')
        self.assertEqual(installer.path_line("/usr/bin/fish", "/opt/x/bin"), "fish_add_path /opt/x/bin")
        self.assertEqual(installer.path_line("/bin/bash", "/opt/my dir/bin"), 'export PATH="/opt/my dir/bin:$PATH"')
        self.assertEqual(installer.path_line("/usr/bin/fish", "/opt/my dir/bin"), "fish_add_path '/opt/my dir/bin'")
        self.assertEqual(installer.path_line("/bin/sh", '/opt/a$b"c/bin'), 'export PATH="/opt/a\\$b\\"c/bin:$PATH"')

    def test_tty_eof_is_not_consent(self):
        result, out = self.offer(answer="")
        self.assertFalse(result["path_modified"])
        self.assertFalse((self.home / ".zprofile").exists())
        self.assertIn(installer.path_line("/bin/zsh", self.bin), out)

    def test_tty_enter_edits_once_and_is_idempotent(self):
        result, out = self.offer()
        rc = self.home / ".zprofile"
        self.assertTrue(result["path_modified"])
        self.assertIn("[Y/n]", out)
        self.assertEqual(rc.read_text(), installer.PATH_MARKER + '\nexport PATH="/opt/example/bin:$PATH"\n')
        again, prompt = self.offer()
        self.assertFalse(again["path_modified"])
        self.assertNotIn("[Y/n]", prompt)
        self.assertEqual(rc.read_text().count(installer.PATH_MARKER), 1)

    def test_append_keeps_existing_content_and_adds_newline(self):
        rc = self.home / ".zprofile"
        rc.write_text("alias a=b")
        self.offer()
        self.assertTrue(rc.read_text().startswith("alias a=b\n" + installer.PATH_MARKER))

    def test_fish_creates_conf_d(self):
        result, _ = self.offer(shell="/usr/bin/fish")
        self.assertTrue(result["path_modified"])
        self.assertIn("fish_add_path /opt/example/bin", (self.home / ".config" / "fish" / "conf.d" / "bff.fish").read_text())

    def test_tty_no_does_not_edit(self):
        result, out = self.offer(answer="n\n")
        self.assertFalse(result["path_modified"])
        self.assertFalse((self.home / ".zprofile").exists())
        self.assertIn('export PATH="/opt/example/bin:$PATH"', out)

    def test_yes_no_modify_and_non_tty_never_edit(self):
        for kwargs in ({"yes": True}, {"no_modify": True}, {"tty": False}):
            result, out = self.offer(**kwargs)
            self.assertFalse(result["path_modified"], kwargs)
            self.assertNotIn("[Y/n]", out)
            self.assertIn(str(self.home / ".zprofile"), result["path_hint"])
            self.assertEqual(list(self.home.iterdir()), [], kwargs)


class WindowsInstallerTests(unittest.TestCase):
    """install.ps1 cannot run here (no PowerShell); pin what can be checked as text."""

    def setUp(self):
        self.ps1 = (ROOT / "install.ps1").read_text()
        self.sh = (ROOT / "install.sh").read_text()

    def test_version_pin_is_found_and_agrees(self):
        import versioning
        pins = [p for p in versioning.pins(ROOT) if p[1] == "install.ps1"]
        self.assertEqual([p[2] for p in pins], [installer.__version__])

    def test_extraction_program_is_identical_to_install_sh(self):
        sh = self.sh.split("<<'PY'\n", 1)[1].split("\nPY\n", 1)[0]
        ps = self.ps1.split("$extract = @'\n", 1)[1].split("\n'@", 1)[0]
        self.assertEqual(sh.strip(), ps.strip())

    def test_verifies_sums_and_refuses_store_stub(self):
        for needle in ("Get-FileHash -Algorithm SHA256", "SHA256SUMS", "checksum mismatch", "\\WindowsApps\\",
                       "winget install --id=astral-sh.uv -e", "winget install Python.Python.3.12",
                       "-NoModifyPath", "SetEnvironmentVariable('Path'"):
            self.assertIn(needle, self.ps1)

    def test_gh_source_and_fix_messages_are_present(self):
        for needle in ("gh release download", "gh auth status", "gh auth login", "winget install --id GitHub.cli", "BFF_RELEASE_BASE",
                       "[scriptblock]::Create"):
            self.assertIn(needle, self.ps1)
        self.assertLess(self.ps1.index("gh auth status"), self.ps1.index("New-Item -ItemType Directory"))
        self.assertTrue(self.ps1.isascii() and self.sh.isascii())  # PowerShell 5.1 reads BOM-less files as ANSI

    def test_blanket_wsl_gate_is_gone_and_untested_notice_is_honest(self):
        self.assertNotIn("PREVIEW: use WSL", self.ps1)
        self.assertNotIn("BFF_WINDOWS_PREVIEW", self.ps1)
        head = self.ps1.split("function Find-Python", 1)[0]
        self.assertIn("has not been run on a real Windows machine yet", head)

    @unittest.skipUnless(shutil.which("pwsh"), "pwsh not installed")
    def test_powershell_parses(self):
        run = subprocess.run(["pwsh", "-NoProfile", "-Command",
                              "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('%s',[ref]$null,[ref]$e); if($e){$e; exit 1}" % (ROOT / "install.ps1")],
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)

    @unittest.skipUnless(shutil.which("shellcheck"), "shellcheck not installed")
    def test_install_sh_passes_shellcheck(self):
        run = subprocess.run(["shellcheck", "-s", "sh", str(ROOT / "install.sh")], capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stdout)

    def test_no_pipe_to_shell_anywhere(self):
        import re
        pattern = re.compile(r"\|\s*(sh|bash|zsh|iex)\b|iex \(|Invoke-Expression")
        for path in [ROOT / "install.sh", ROOT / "install.ps1", ROOT / "install.py"] + sorted((ROOT / "bff").glob("*.py")):
            self.assertIsNone(pattern.search(path.read_text()), str(path))


class ReleaseBuilderTests(unittest.TestCase):
    def test_sums_cover_tarball_and_loose_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            built = build_release(out)
            rows = [line.split("  ") for line in (out / "SHA256SUMS").read_text().splitlines()]
            self.assertEqual([r[1] for r in rows], ["bff-" + installer.__version__ + ".tar.gz", "install.sh", "install.ps1", "compat.json"])
            self.assertEqual([r for r in rows if r[1].startswith("bff-") and r[1].endswith(".tar.gz")], rows[:1])
            self.assertEqual(rows[0][0], built["sha256"])
            for digest, name in rows:
                self.assertEqual(hashlib.sha256((out / name).read_bytes()).hexdigest(), digest, name)
            for name in ("install.sh", "install.ps1", "compat.json"):
                self.assertEqual((out / name).read_bytes(), (ROOT / name).read_bytes())


class WorkflowCheckTests(unittest.TestCase):
    def run_check(self, *paths):
        return subprocess.run([sys.executable, str(ROOT / "scripts" / "check_workflows.py"), *map(str, paths)],
                              capture_output=True, text=True)

    def setUp(self):
        try:
            import yaml  # noqa: F401
        except ImportError:
            self.skipTest("PyYAML is not installed")

    def test_real_workflows_pass(self):
        run = self.run_check(ROOT / ".github/workflows/tests.yml", ROOT / ".github/workflows/release.yml")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)

    def broken(self, old, new):
        text = (ROOT / ".github/workflows/release.yml").read_text()
        self.assertIn(old, text)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "release.yml"
        path.write_text(text.replace(old, new, 1))
        return self.run_check(path)

    def test_unpinned_uses_fails(self):
        run = self.broken("actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4", "actions/checkout@v4")
        self.assertEqual(run.returncode, 1)
        self.assertIn("not pinned", run.stdout)

    def test_id_token_outside_attest_fails(self):
        run = self.broken("  build:\n    needs: [test, privacy]\n    runs-on: ubuntu-latest\n",
                          "  build:\n    needs: [test, privacy]\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n")
        self.assertEqual(run.returncode, 1)
        self.assertIn("id-token", run.stdout)

    def test_draft_without_environment_fails(self):
        run = self.broken("    environment: release\n", "")
        self.assertEqual(run.returncode, 1)
        self.assertIn("environment: release", run.stdout)

    def test_pipe_to_shell_fails(self):
        bad = "ec" + "ho hi " + "| " + "sh"
        run = self.broken("run: python -m unittest discover -s tests -v", "run: " + bad)
        self.assertEqual(run.returncode, 1)
        self.assertIn("pipe-to-shell", run.stdout)


def build_release(output):
    run = subprocess.run([sys.executable, str(ROOT / "scripts" / "build-bff-release.py"), "--output", str(output)],
                         capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    return json.loads(run.stdout)


FAKE_BB = """#!%s
import json, sys
args = sys.argv[1:]
if args == ["--version"]:
    print("0.45.0")
elif args[:2] == ["plugin", "list"]:
    print(json.dumps({"plugins": []}))
else:
    sys.exit(1)
"""


class InstallShTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.base = Path(cls._tmp.name)
        cls.version = installer.__version__
        cls.srv = cls.base / "srv"
        cls.download = cls.srv / "download" / ("v" + cls.version)
        cls.download.mkdir(parents=True)
        build_release(cls.download)
        cls.script_dir = cls.base / "script"
        cls.script_dir.mkdir()
        shutil.copy(str(ROOT / "install.sh"), str(cls.script_dir / "install.sh"))

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def setUp(self):
        self._case = tempfile.TemporaryDirectory()
        self.addCleanup(self._case.cleanup)
        self.tmp = Path(self._case.name)
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.fakebin = self.tmp / "fakebin"
        self.fakebin.mkdir()
        (self.fakebin / "python3").symlink_to(sys.executable)
        self.prefix = self.tmp / "p"

    def add_fake_bb(self):
        # The installed bff never reads PATH, so the fake bb sits where production looks for a user-installed bb: the fixed ~/.local/bin of the test HOME.
        (self.home / ".local" / "bin").mkdir(parents=True)
        bb = self.home / ".local" / "bin" / "bb"
        bb.write_text(FAKE_BB % sys.executable)
        bb.chmod(0o755)

    def run_sh(self, *args, base=None, env_extra=None):
        env = {"HOME": str(self.home), "PATH": str(self.fakebin) + ":/usr/bin:/bin", "TMPDIR": str(self.tmp), "PYTHONDONTWRITEBYTECODE": "1"}
        if base is not False:  # base=False exercises the default gh source
            env["BFF_RELEASE_BASE"] = base or ("file://" + str(self.srv))
        env.update(env_extra or {})
        return subprocess.run(["sh", str(self.script_dir / "install.sh"), *args], env=env, capture_output=True,
                              text=True, stdin=subprocess.DEVNULL)

    def test_download_install_runs_new_bff(self):
        run = self.run_sh("--prefix", str(self.prefix), "--no-modify-path")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("release source: file://", run.stderr)
        result = json.loads(run.stdout)
        self.assertFalse(result["path_modified"])
        self.assertEqual(list(self.home.iterdir()), [])
        version = subprocess.run([str(self.prefix / "bin" / "bff"), "--version"], capture_output=True, text=True)
        self.assertEqual(version.stdout.strip(), "bff " + self.version)

    def test_tampered_tarball_installs_nothing(self):
        srv = self.tmp / "tampered"
        shutil.copytree(str(self.srv), str(srv))
        archive = srv / "download" / ("v" + self.version) / ("bff-" + self.version + ".tar.gz")
        archive.write_bytes(archive.read_bytes() + b"x")
        run = self.run_sh("--prefix", str(self.prefix), "--no-modify-path", base="file://" + str(srv))
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("checksum mismatch", run.stderr)
        self.assertFalse((self.prefix / "bin" / "bff").exists())
        self.assertEqual(list(self.home.iterdir()), [])

    def test_setup_while_osiris_is_unpublished_exits_4(self):
        self.add_fake_bb()
        run = self.run_sh("--setup", "--prefix", str(self.prefix), "--no-modify-path")
        self.assertEqual(run.returncode, 4, run.stdout + run.stderr)
        self.assertIn("not publicly released yet", run.stdout)  # the installed bff ran `osiris setup`
        self.assertIn("bff is installed. Osiris is not publicly released yet", run.stderr)
        self.assertNotIn("waiting on the prerequisites", run.stderr)
        self.assertTrue((self.prefix / "bin" / "bff").is_symlink())

    def test_setup_without_bb_is_still_exit_3(self):
        run = self.run_sh("--setup", "--yes", "--prefix", str(self.prefix))
        self.assertEqual(run.returncode, 3, run.stdout + run.stderr)
        self.assertEqual(list(self.home.iterdir()), [])  # --yes never edits a startup file

    def test_http_release_base_is_refused(self):
        run = self.run_sh("--prefix", str(self.prefix), base="http://example.com/releases")
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("https:// or file://", run.stderr)
        self.assertFalse(self.prefix.exists())

    def test_old_flags_still_pass_through(self):
        run = self.run_sh("--prefix", str(self.prefix), "--stage-only")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue(json.loads(run.stdout)["created"])
        self.assertFalse((self.prefix / "bin" / "bff").exists())


FAKE_GH = """#!%s
import os, shutil, sys
args = sys.argv[1:]
log = os.environ.get("FAKE_GH_LOG")
if log:
    open(log, "a").write(" ".join(args) + "\\n")
if args[:2] == ["auth", "status"]:
    sys.exit(0 if os.environ.get("FAKE_GH_AUTH", "1") == "1" else 1)
if args[:2] == ["release", "download"]:
    tag, dest = args[2], args[args.index("--dir") + 1]
    patterns = [args[i + 1] for i, a in enumerate(args) if a == "--pattern"]
    if "--repo" not in args or "--clobber" not in args:
        sys.exit(2)
    for name in patterns:
        shutil.copy(os.path.join(os.environ["FAKE_GH_SRC"], "download", tag, name), os.path.join(dest, name))
    sys.exit(0)
sys.exit(3)
"""


class InstallShGhSourceTests(InstallShTests):
    """The private-repo one-liner path: no BFF_RELEASE_BASE, downloads through a fake gh on PATH."""

    # Re-running the inherited curl tests here would only repeat them.
    test_download_install_runs_new_bff = test_tampered_tarball_installs_nothing = None
    test_setup_while_osiris_is_unpublished_exits_4 = test_setup_without_bb_is_still_exit_3 = None
    test_http_release_base_is_refused = test_old_flags_still_pass_through = None

    def add_fake_gh(self):
        gh = self.fakebin / "gh"
        gh.write_text(FAKE_GH % sys.executable)
        gh.chmod(0o755)
        self.gh_log = self.tmp / "gh.log"

    def run_gh(self, *args, env_extra=None, src=None):
        extra = {"FAKE_GH_SRC": str(src or self.srv), "FAKE_GH_LOG": str(self.gh_log)}
        extra.update(env_extra or {})
        return self.run_sh(*args, base=False, env_extra=extra)

    def test_gh_missing_prints_install_and_login_fix(self):
        run = self.run_sh("--prefix", str(self.prefix), "--no-modify-path", base=False)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("https://cli.github.com", run.stderr)
        self.assertIn("gh auth login", run.stderr)
        self.assertFalse(self.prefix.exists())

    def test_gh_unauthenticated_prints_login_fix_and_downloads_nothing(self):
        self.add_fake_gh()
        run = self.run_gh("--prefix", str(self.prefix), "--no-modify-path", env_extra={"FAKE_GH_AUTH": "0"})
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("not signed in. Run: gh auth login", run.stderr)
        self.assertNotIn("release download", self.gh_log.read_text())
        self.assertFalse(self.prefix.exists())

    def test_gh_install_runs_new_bff_and_leaves_home_alone(self):
        self.add_fake_gh()
        run = self.run_gh("--prefix", str(self.prefix), "--no-modify-path")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertNotIn("release source", run.stderr)
        self.assertIn("release download v" + self.version + " --repo triunai/bff", self.gh_log.read_text())
        self.assertEqual(list(self.home.iterdir()), [])
        version = subprocess.run([str(self.prefix / "bin" / "bff"), "--version"], capture_output=True, text=True)
        self.assertEqual(version.stdout.strip(), "bff " + self.version)

    def test_gh_checksum_mismatch_aborts_before_install(self):
        self.add_fake_gh()
        srv = self.tmp / "tampered"
        shutil.copytree(str(self.srv), str(srv))
        archive = srv / "download" / ("v" + self.version) / ("bff-" + self.version + ".tar.gz")
        archive.write_bytes(archive.read_bytes() + b"x")
        run = self.run_gh("--prefix", str(self.prefix), "--no-modify-path", src=srv)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("checksum mismatch", run.stderr)
        self.assertFalse((self.prefix / "bin" / "bff").exists())

    def test_gh_download_failure_names_the_check(self):
        self.add_fake_gh()
        run = self.run_gh("--prefix", str(self.prefix), "--no-modify-path", src=self.tmp / "nowhere")
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("can read triunai/bff", run.stderr)

    def test_gh_rerun_is_idempotent_and_leaves_no_temp_dir(self):
        self.add_fake_gh()
        first = self.run_gh("--prefix", str(self.prefix), "--no-modify-path")
        second = self.run_gh("--prefix", str(self.prefix), "--no-modify-path")
        self.assertEqual((first.returncode, second.returncode), (0, 0), second.stderr)
        self.assertEqual(json.loads(first.stdout)["release"], json.loads(second.stdout)["release"])
        self.assertEqual([p.name for p in self.tmp.glob("bff-download.*")], [])

    def test_gh_setup_runs_osiris_setup_and_prints_next_step(self):
        self.add_fake_gh()
        self.add_fake_bb()
        run = self.run_gh("--setup", "--prefix", str(self.prefix), "--no-modify-path")
        self.assertEqual(run.returncode, 4, run.stdout + run.stderr)
        self.assertIn("bff --help", run.stderr)

    def test_oneliner_form_runs_script_text_via_sh_c(self):
        # The documented one-liner passes the script as a -c string, so stdin stays the terminal for the PATH prompt.
        self.add_fake_gh()
        text = (ROOT / "install.sh").read_text()
        env = {"HOME": str(self.home), "PATH": str(self.fakebin) + ":/usr/bin:/bin", "TMPDIR": str(self.tmp), "PYTHONDONTWRITEBYTECODE": "1",
               "FAKE_GH_SRC": str(self.srv), "FAKE_GH_LOG": str(self.gh_log)}
        run = subprocess.run(["sh", "-c", text, "bff-install", "--prefix", str(self.prefix), "--no-modify-path"], env=env,
                             capture_output=True, text=True, stdin=subprocess.DEVNULL, cwd=str(self.tmp))
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue((self.prefix / "bin" / "bff").is_symlink())


if __name__ == "__main__":
    unittest.main()
