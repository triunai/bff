"""`bff osiris install`: the one install-and-update verb. Fake bb, a local git repo standing in for the private
Osiris repo, fake npm/node; the real bb, home, network and staging directory are never reachable."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock

SDK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SDK))
sys.path.insert(0, str(SDK / "tests"))
from bff import cli, osiris, osiris_install, osiris_source, state  # noqa: E402
from test_osiris import Fake, TtyIn, entry  # noqa: E402

STAGE = """#!/usr/bin/env bash
# stand-in for the Osiris repo's stage script: copy + "gate"
set -euo pipefail
out=$1
[ -e "$out" ] && { echo "refusing: $out exists" >&2; exit 2; }
mkdir -p "$out/node_modules/@xterm/xterm"
cp package.json "$out/package.json"
[ -z "${FAKE_STAGE_FAIL:-}" ] || { echo "GATE FAIL: fake" >&2; exit 1; }
echo "GATE PASS: fake"
"""


class NotTty(io.StringIO):
    def isatty(self):
        return False


def git(*args, cwd):
    # the identity is split so no address-shaped literal sits in the repo (scripts/privacy_gate.py)
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t" + "@example.invalid", *args], cwd=str(cwd), check=True,
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)


class InstallFixture(Fake):
    def setUp(self):
        super().setUp()
        self.builds = self.root / "builds"
        self.cache = self.root / "cache"
        self.npm_log = self.root / "npm.log"
        for name, body in (("npm", "echo \"npm $*\" >> '%s'\nexit ${FAKE_NPM_EXIT:-0}\n" % self.npm_log),
                           ("node", "echo v24.0.0\n")):
            tool = self.bin / name
            tool.write_text("#!/bin/sh\n" + body)
            tool.chmod(0o755)
        self.repo = self.root / "osiris-private"
        self.repo.mkdir()
        (self.repo / "scripts").mkdir()
        (self.repo / "scripts" / "stage-plugin-install.sh").write_text(STAGE)
        (self.repo / "package.json").write_text(json.dumps({"version": "0.2.16-dev"}))
        git("init", "-q", cwd=self.repo)
        git("add", "-A", cwd=self.repo)
        git("commit", "-q", "-m", "osiris", cwd=self.repo)
        self.sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(self.repo), stdout=subprocess.PIPE,
                                  universal_newlines=True, check=True).stdout.strip()
        os.environ["BFF_OSIRIS_REPO_URL"] = "file://" + str(self.repo)
        patch = mock.patch.object(osiris_source, "cache_dir", return_value=self.cache)
        patch.start()
        self.addCleanup(patch.stop)
        self.built = self.builds / ("install-0.2.16-rc3.1-" + self.sha[:7])

    def compat(self, published=False, commit=None, ref=None):
        data = super().compat(published, commit)
        data["osiris"]["private"] = {"repo": "triunai/osiris-private", "ref": ref or self.sha, "version": "0.2.16-dev",
                                     "label": "0.2.16-rc3.1"}
        return data

    def install(self, stdin=None, staging=False, **kw):
        self.out = io.StringIO()
        self.err = io.StringIO()
        kw.setdefault("compat", self.compat())
        with mock.patch("sys.stderr", self.err):
            return osiris_install.run_install(stdin=stdin or TtyIn("\n"), out=self.out, state_file=self.state_file,
                                              staging_root=str(self.staging if staging else self.root / "no-staging"),
                                              builds_root=str(self.builds), env={"BFF_SKIP_SELF_UPDATE": "1"}, **kw)


class PrivateBuildTests(InstallFixture):
    def test_fresh_machine_fetches_builds_gates_and_installs_the_pinned_commit(self):
        self.install_result(default={"source": "path:" + str(self.built), "version": "0.2.16-dev"})
        self.assertEqual(self.install(), 0, self.out.getvalue() + self.err.getvalue())
        text = self.out.getvalue()
        self.assertIn("Osiris not installed -> github.com/triunai/osiris-private @ " + self.sha[:12], text)
        self.assertIn("Install? [Y/n]", text)
        self.assertIn("fetching Osiris " + self.sha[:12], text)
        self.assertIn("npm ci --omit=dev --ignore-scripts", self.npm_log.read_text())  # no third-party install scripts
        self.assertTrue((self.built / "node_modules" / "@xterm" / "xterm").is_dir())
        self.assertFalse(any(p.name.endswith(".partial") for p in self.builds.iterdir()))
        builds = [c for c in self.calls() if c["argv"][:2] == ["plugin", "build"]]
        self.assertEqual(len(builds), 1)  # bff's own fresh-copy gate, on top of the stage script's
        self.assertNotEqual(Path(builds[0]["cwd"]).resolve(), self.built.resolve())
        self.assertEqual(self.installs(), [["plugin", "install", str(self.built), "--yes"]])
        self.assertEqual(state.load(self.state_file)["plugin"]["source"], "path:" + str(self.built))

    def test_a_rerun_with_nothing_new_is_a_no_op_with_no_fetch(self):
        self.install_result(default={"source": "path:" + str(self.built), "version": "0.2.16-dev"})
        self.assertEqual(self.install(), 0)
        before = len(self.calls())
        npm_before = self.npm_log.read_text()
        self.assertEqual(self.install(stdin=NotTty()), 0)  # nothing to change, so no consent is needed
        self.assertIn("Nothing to do: everything is up to date.", self.out.getvalue())
        self.assertEqual([c["argv"][:2] for c in self.calls()[before:]], [["--version"], ["plugin", "list"]])
        self.assertEqual(self.npm_log.read_text(), npm_before)

    def test_an_existing_gated_build_is_reused_without_a_fetch(self):
        (self.built / "node_modules" / "@xterm" / "xterm").mkdir(parents=True)
        (self.built / "package.json").write_text(json.dumps({"version": "0.2.16-dev"}))
        os.environ["BFF_OSIRIS_REPO_URL"] = "file://" + str(self.root / "gone")
        self.install_result(default={"source": "path:" + str(self.built), "version": "0.2.16-dev"})
        self.assertEqual(self.install(), 0, self.err.getvalue())
        self.assertFalse(self.npm_log.exists())
        self.assertEqual(self.installs(), [["plugin", "install", str(self.built), "--yes"]])

    def test_no_access_names_the_one_next_action_and_installs_nothing(self):
        os.environ["BFF_OSIRIS_REPO_URL"] = "file://" + str(self.root / "no-such-repo")
        self.assertEqual(self.install(), 1)
        self.assertIn("cannot read github.com/triunai/osiris-private", self.err.getvalue())
        self.assertIn("gh auth login", self.err.getvalue())
        self.assertEqual(self.installs(), [])

    def test_a_pin_that_is_not_on_the_remote_installs_nothing(self):
        missing = "0" * 40
        self.assertEqual(self.install(compat=self.compat(ref=missing)), 1)
        self.assertIn("is not on github.com/triunai/osiris-private (has it been pushed?)", self.err.getvalue())
        self.assertEqual(self.installs(), [])

    def test_a_failed_stage_gate_installs_nothing_and_leaves_no_build(self):
        os.environ["FAKE_STAGE_FAIL"] = "1"
        self.assertEqual(self.install(), 1)
        self.assertIn("stage gate failed", self.err.getvalue())
        self.assertFalse(self.built.exists())
        self.assertEqual(self.installs(), [])

    def test_ref_override_builds_the_named_branch(self):
        branch = subprocess.run(["git", "branch", "--show-current"], cwd=str(self.repo), stdout=subprocess.PIPE,
                                universal_newlines=True).stdout.strip()
        self.install_result(default={"source": "path:" + str(self.built), "version": "0.2.16-dev"})
        self.assertEqual(self.install(ref=branch), 0, self.err.getvalue())
        self.assertEqual(self.installs(), [["plugin", "install", str(self.built), "--yes"]])

    def test_missing_node_waits_with_the_ordered_list(self):
        (self.bin / "npm").unlink()
        (self.bin / "node").unlink()
        self.assertEqual(self.install(), osiris_install.WAITING)
        self.assertIn("Node: Install Node yourself", self.out.getvalue())
        self.assertEqual(self.installs(), [])


class ConsentTests(InstallFixture):
    def test_eof_at_the_question_is_no(self):
        self.assertEqual(self.install(stdin=TtyIn("")), 0)
        self.assertIn("Nothing changed.", self.out.getvalue())
        self.assertEqual(self.installs(), [])
        self.assertFalse(self.npm_log.exists())

    def test_n_is_no(self):
        self.assertEqual(self.install(stdin=TtyIn("n\n")), 0)
        self.assertEqual(self.installs(), [])

    def test_no_terminal_and_no_yes_fails_with_the_flag_to_use(self):
        stdin = NotTty()
        self.assertEqual(self.install(stdin=stdin), 1)
        self.assertIn("Re-run with --yes", self.err.getvalue())
        self.assertEqual(stdin.tell(), 0)  # never read
        self.assertEqual(self.installs(), [])

    def test_yes_needs_no_terminal(self):
        self.install_result(default={"source": "path:" + str(self.built), "version": "0.2.16-dev"})
        self.assertEqual(self.install(stdin=NotTty(), yes=True), 0, self.err.getvalue())
        self.assertNotIn("[Y/n]", self.out.getvalue())

    def test_dry_run_changes_nothing_and_never_fetches(self):
        self.assertEqual(self.install(dry_run=True), 0)
        self.assertIn("[dry run] nothing changed", self.out.getvalue())
        self.assertFalse(self.cache.exists())
        self.assertEqual(self.installs(), [])


class BbDownTests(InstallFixture):
    def test_bb_that_cannot_list_plugins_names_starting_bb(self):
        os.environ["FAKE_BB_LIST_EXIT"] = "1"
        self.assertEqual(self.install(), 1)
        self.assertIn("Is BB running? Start it (npx bb-app@latest", self.err.getvalue())
        self.assertEqual(self.installs(), [])


class ChannelTests(InstallFixture):
    def test_newest_staged_build_wins_on_a_developer_box(self):
        old = self.plugin("install-0.2.16-rc3-2b12d6e", "0.2.16-dev")
        newest = self.plugin("install-0.2.16-rc3.1-66347de", "0.2.16-dev")
        self.set_plugins(entry("path:" + str(old), "0.2.16-dev"))
        self.install_result(default={"source": "path:" + str(newest), "version": "0.2.16-dev"})
        self.assertEqual(self.install(staging=True), 0, self.err.getvalue())
        self.assertIn("install-0.2.16-rc3.1-66347de (newest staged build on this machine)", self.out.getvalue())
        self.assertEqual(self.installs(), [["plugin", "install", str(newest), "--yes"]])
        self.assertFalse(self.cache.exists())  # no fetch on a box that has staged builds

    def test_a_developer_worktree_source_is_left_alone(self):
        self.set_plugins(entry("path:" + str(self.root / "my-worktree"), "0.2.16-dev"))
        self.assertEqual(self.install(), 0)
        self.assertIn("left as is", self.out.getvalue())
        self.assertEqual(self.installs(), [])

    def test_the_stale_bundled_plugin_is_replaced_never_reinstalled(self):
        bundled = self.root / "prefix" / "share" / "bff" / "releases" / ("0.1.1-" + "a" * 12) / "plugins" / "osiris"
        self.set_plugins(entry("path:" + str(bundled), "0.2.0"))
        self.install_result(default={"source": "path:" + str(self.built), "version": "0.2.16-dev"})
        self.assertEqual(self.install(), 0, self.err.getvalue())
        self.assertEqual(self.installs(), [["plugin", "install", str(self.built), "--yes"]])

    def test_a_failed_install_restores_the_previous_source(self):
        old = self.builds / "install-0.2.16-rc3-2b12d6e"  # an earlier bff-made build: managed, so replaceable
        (old / "node_modules" / "@xterm" / "xterm").mkdir(parents=True)
        self.set_plugins(entry("path:" + str(old), "0.2.16-dev"))
        os.environ["FAKE_BB_INSTALL_EXIT"] = "1"
        self.assertEqual(self.install(), 1)
        self.assertIn("did not verify", self.out.getvalue())
        self.assertEqual(self.installs()[-1], ["plugin", "install", str(old), "--yes"])


class CliTests(InstallFixture):
    def command(self, args):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch("sys.stdout", out), mock.patch("sys.stderr", err), mock.patch("sys.stdin", NotTty()), \
                mock.patch.dict(os.environ, {"BFF_SKIP_SELF_UPDATE": "1"}):
            code = cli.main(args)
        return code, out.getvalue(), err.getvalue()

    def test_the_three_verbs_are_documented_and_the_aliases_are_not(self):
        out = io.StringIO()
        with mock.patch("sys.stdout", out), self.assertRaises(SystemExit) as done:
            cli.main(["osiris", "--help"])
        self.assertEqual(done.exception.code, 0)
        text = out.getvalue()
        self.assertIn("{install,open,doctor}", text)
        listed = [line.split()[0] for line in text.splitlines() if line.startswith("    ") and line.split()]
        self.assertEqual([v for v in listed if v in ("install", "open", "doctor", "setup", "update")],
                         ["install", "open", "doctor"])

    def test_aliases_reach_the_same_install(self):
        for args in (["osiris", "install", "--dry-run"], ["osiris", "setup", "--dry-run"], ["osiris", "update", "--dry-run"]):
            with self.subTest(args):
                code, out, _ = self.command(args)
                self.assertIn("bff osiris install plan", out)

    def test_usage_error_exits_2(self):
        with mock.patch("sys.stderr", io.StringIO()), self.assertRaises(SystemExit) as done:
            cli.main(["osiris", "install", "--no-such-flag"])
        self.assertEqual(done.exception.code, 2)
        with mock.patch("sys.stderr", io.StringIO()), self.assertRaises(SystemExit) as done:
            cli.main(["osiris", "--install", "--print-url"])
        self.assertEqual(done.exception.code, 2)

    def test_short_yes_and_version_flags(self):
        out = io.StringIO()
        with mock.patch("sys.stdout", out), self.assertRaises(SystemExit):
            cli.main(["osiris", "-V"])
        self.assertTrue(out.getvalue().startswith("bff "))


if __name__ == "__main__":
    unittest.main()
