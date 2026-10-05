"""Exercise the actual release builder with a valid corpus and broken inputs."""
import json
from pathlib import Path
import shutil
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
            shutil.copytree(SDK, root, ignore=shutil.ignore_patterns("node_modules", ".git", "__pycache__", "*.pyc"))
            (root / "scripts").mkdir(exist_ok=True)
            shutil.copy2(BUILDER, root / "scripts" / "build-bff-release.py")
            command = [sys.executable, str(root / "scripts" / "build-bff-release.py"), "--output", str(Path(temporary) / "artifacts")]
            original = (root / "README.md").read_text()
            control = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(control.returncode, 0, control.stderr)
            self.assertGreater(json.loads(control.stdout)["files"], 20)
            canaries = ["/Users/" + "canary/private/file", "-----BEGIN " + "PRIVATE KEY-----", "ghp_" + "X" * 36]
            for canary in canaries:
                (root / "README.md").write_text(original + "\n" + canary)
                broken = subprocess.run(command, capture_output=True, text=True)
                self.assertNotEqual(broken.returncode, 0)
                self.assertIn("README.md", broken.stderr)
                self.assertNotIn(canary, broken.stderr)
            (root / "README.md").write_text(original)
            restored = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(restored.returncode, 0, restored.stderr)
