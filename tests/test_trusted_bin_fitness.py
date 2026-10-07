"""FITNESS (ADR D-139, td-h1w.36): bff/trusted_bin.py is the ONLY door to a child process or a program lookup. The allowlist is ZERO exceptions:
no other module in bff/, scripts/ or install.py may import subprocess/pty, call os.system/os.popen/os.exec*/os.spawn*/os.posix_spawn, call shutil.which (a PATH
walk), or pass shell=True. A new site calls trusted_bin.which/resolve and trusted_bin.run/popen. Uses the AST, so docstrings and comments cannot trip or hide it."""
import ast
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
DOOR = "bff/trusted_bin.py"
BANNED_MODULES = {"subprocess", "pty", "commands", "popen2"}
BANNED_OS = {"system", "popen", "execl", "execle", "execlp", "execlpe", "execv", "execve", "execvp", "execvpe", "spawnl", "spawnle", "spawnlp", "spawnlpe", "spawnv",
             "spawnve", "spawnvp", "spawnvpe", "posix_spawn", "posix_spawnp", "fork", "forkpty"}


def sources():
    files = sorted(ROOT.glob("bff/*.py")) + sorted(ROOT.glob("scripts/*.py")) + [ROOT / "install.py"]
    return [(str(p.relative_to(ROOT)), p) for p in files if p.is_file()]


def problems(text):
    found = []
    for node in ast.walk(ast.parse(text)):
        if isinstance(node, ast.Import):
            found += ["import " + a.name for a in node.names if a.name.split(".")[0] in BANNED_MODULES]
        elif isinstance(node, ast.ImportFrom):
            if (node.module or "").split(".")[0] in BANNED_MODULES:
                found.append("from " + node.module + " import ...")
            if node.module == "os":
                found += ["from os import " + a.name for a in node.names if a.name in BANNED_OS]
            if node.module == "shutil":
                found += ["from shutil import which" for a in node.names if a.name == "which"]
        elif isinstance(node, ast.Attribute):
            owner = node.value.id if isinstance(node.value, ast.Name) else None
            if owner == "os" and node.attr in BANNED_OS:
                found.append("os." + node.attr)
            if owner == "shutil" and node.attr == "which":
                found.append("shutil.which")
        elif isinstance(node, ast.keyword) and node.arg == "shell" and isinstance(node.value, ast.Constant) and node.value.value is True:
            found.append("shell=True")
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ("__import__", "exec", "eval"):
            if node.args and isinstance(node.args[0], ast.Constant) and node.args[0].value in BANNED_MODULES:
                found.append("__import__(" + repr(node.args[0].value) + ")")
    return sorted(set(found))


class Fitness(unittest.TestCase):
    def test_only_the_primitive_starts_a_process_or_walks_PATH(self):
        files = sources()
        self.assertGreater(len(files), 10, "scanned the real tree")
        self.assertIn(DOOR, [name for name, _ in files])
        offenders = {name: problems(path.read_text(encoding="utf-8")) for name, path in files if name != DOOR}
        self.assertEqual({k: v for k, v in offenders.items() if v}, {}, "route the program through bff/trusted_bin.py; do NOT add an exception here")

    def test_the_primitive_never_walks_PATH_itself_and_never_uses_a_shell(self):
        text = (ROOT / DOOR).read_text(encoding="utf-8")
        found = problems(text)
        self.assertNotIn("shutil.which", found)
        self.assertNotIn("shell=True", found)
        self.assertEqual([f for f in found if f.startswith("os.") and f != "os.execve"], [], "the only process-replacing call is exec_replace's execve")
        tree = ast.parse(text)
        spawns = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name) and n.func.value.id == "subprocess"
                  and n.func.attr in ("run", "Popen")]
        self.assertEqual(len(spawns), 2, "exactly two spawn calls: run and popen")
        for call in spawns:
            self.assertEqual(sorted(k.arg for k in call.keywords if k.arg is None), [None], "both take their keywords through the one vetted dict")
        self.assertEqual(text.count("items, verdict = _vet_argv(argv, policy)"), 2, "both vet the program at USE time")
        self.assertIn('"shell": False', text)

    def test_the_scan_is_not_vacuous(self):
        for bad in ("import subprocess", "import subprocess as sp", "from subprocess import run", "import pty", "os.system('ls')", "import os\nos.popen('ls')", "import os\nos.execve('/x', [], {})",
                    "from os import system", "import shutil\nshutil.which('git')", "from shutil import which", "f(shell=True)", "__import__('subprocess')"):
            self.assertNotEqual(problems(bad), [], bad)
        for fine in ("x = 'subprocess shutil.which os.system'", "# import subprocess", '"""import subprocess"""', "shutil.rmtree('x')", "import os\nos.environ.get('PATH')", "f(shell=False)", "trusted_bin.which('git')"):
            self.assertEqual(problems(fine), [], fine)


if __name__ == "__main__":
    unittest.main()
