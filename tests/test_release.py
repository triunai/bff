"""Exercise the actual release builder with a valid corpus and broken inputs."""
import json
from pathlib import Path
import shutil
import tarfile
import subprocess
import sys
import tempfile
import unittest

SDK = Path(__file__).resolve().parents[1]
BUILDER = (SDK / "scripts" / "build-bff-release.py")
if not BUILDER.is_file():
    BUILDER = SDK.parent / "scripts" / "build-bff-release.py"


class ReleaseBoundaryTests(unittest.TestCase):
    def test_actual_archive_then_home_path_and_credential_canaries_fail(self):
        with tempfile.TemporaryDirectory(prefix="bff release teeth ") as temporary:
            root = Path(temporary) / "source"
            # The bundled plugin's vendored node_modules is release content; everything else named node_modules is not.
            skip = shutil.ignore_patterns(".git", "__pycache__", "*.pyc")
            shutil.copytree(SDK, root, ignore=lambda directory, names: set(skip(directory, names)) | (
                {"node_modules"} & set(names) if Path(directory).name != "osiris" else set()))
            (root / "scripts").mkdir(exist_ok=True)
            shutil.copy2(BUILDER, root / "scripts" / "build-bff-release.py")
            command = [sys.executable, str(root / "scripts" / "build-bff-release.py"), "--output", str(Path(temporary) / "artifacts")]
            original = (root / "README.md").read_text(encoding="utf-8")
            control = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(control.returncode, 0, control.stderr)
            self.assertGreater(json.loads(control.stdout)["files"], 20)
            canaries = ["/Users/" + "canary/private/file", "-----BEGIN " + "PRIVATE KEY-----", "ghp_" + "X" * 36]
            for canary in canaries:
                (root / "README.md").write_text(original + "\n" + canary, encoding="utf-8")
                broken = subprocess.run(command, capture_output=True, text=True)
                self.assertNotEqual(broken.returncode, 0)
                self.assertIn("README.md", broken.stderr)
                self.assertNotIn(canary, broken.stderr)
            (root / "README.md").write_text(original, encoding="utf-8")
            restored = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(restored.returncode, 0, restored.stderr)


class BundledPluginTests(unittest.TestCase):
    def test_archive_holds_exactly_the_reviewed_plugin_files_and_nothing_else_under_plugins(self):
        sys.path.insert(0, str(SDK))
        import importlib.util
        spec = importlib.util.spec_from_file_location("bff_installer_for_archive", SDK / "install.py")
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        tree = SDK / "plugins" / "osiris"
        expected = set()
        for path in tree.rglob("*"):
            if path.is_file():
                name = path.relative_to(tree).as_posix()
                self.assertTrue(installer.plugin_file_allowed(name), "unreviewed file in the plugin tree: " + name)
                expected.add("plugins/osiris/" + name)
        with tempfile.TemporaryDirectory(prefix="bff plugin archive ") as temporary:
            built = subprocess.run([sys.executable, str(BUILDER), "--output", temporary], capture_output=True, text=True)
            self.assertEqual(built.returncode, 0, built.stderr)
            with tarfile.open(json.loads(built.stdout)["archive"]) as archive:
                prefix = archive.getnames()[0].split("/")[0] + "/"
                members = {name[len(prefix):] for name in archive.getnames() if name.startswith(prefix + "plugins/")}
                manifest = json.loads(archive.extractfile(prefix + "release-manifest.json").read().decode("utf-8"))
        self.assertEqual(members, expected)
        self.assertTrue({"plugins/osiris/package.json", "plugins/osiris/server.ts", "plugins/osiris/app.tsx"} <= members)
        self.assertEqual({name for name in manifest["files"] if name.startswith("plugins/")}, expected)  # same hash path as every file
        self.assertFalse([name for name in members if name.endswith(".map")])
        shipped = json.loads((tree / "package.json").read_text(encoding="utf-8"))["version"]
        promised = json.loads((SDK / "compat.json").read_text(encoding="utf-8"))["osiris"]["version"]
        self.assertEqual(shipped, promised)
